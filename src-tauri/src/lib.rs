mod manager;
mod tray;

use manager::{
    hidden_command, startup_profile, ClipboardUploadResult, ManagerRuntime, Profile,
    CLIPBOARD_FILE_LIMIT,
};
use serde_json::json;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
#[cfg(target_os = "windows")]
use std::sync::{
    atomic::{AtomicI32, AtomicU64},
    OnceLock,
};
use std::thread;
use std::time::Duration;
use tauri::{
    AppHandle, Manager, PhysicalSize, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use url::Url;

struct RuntimeState {
    manager: Mutex<Option<ManagerRuntime>>,
    node: Mutex<Option<Child>>,
    stopped: AtomicBool,
    window_geometry_path: PathBuf,
}

#[derive(Default)]
struct MainWindowAspect {
    ratio: Mutex<Option<f64>>,
    last_size: Mutex<Option<PhysicalSize<u32>>>,
    correcting: AtomicBool,
}

#[derive(serde::Serialize)]
struct ClipboardFilePreview {
    path: String,
    name: String,
    size: u64,
}

#[tauri::command]
fn set_main_window_aspect(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let state = app.state::<MainWindowAspect>();
    let mut ratio = state
        .ratio
        .lock()
        .map_err(|_| "窗口比例状态不可用".to_string())?;
    if width <= 0.0 || height <= 0.0 || !width.is_finite() || !height.is_finite() {
        *ratio = None;
        if let Ok(mut last_size) = state.last_size.lock() {
            *last_size = None;
        }
        if let Some(window) = app.get_webview_window("main") {
            apply_native_main_window_aspect(&window, None)?;
        }
        return Ok(());
    }
    let value = width / height;
    if !(0.05..=20.0).contains(&value) || !value.is_finite() {
        return Err("窗口比例无效".to_string());
    }
    *ratio = Some(value);
    if let Some(window) = app.get_webview_window("main") {
        apply_native_main_window_aspect(&window, Some(value))?;
        if let Ok(size) = window.inner_size() {
            if let Ok(mut last_size) = state.last_size.lock() {
                *last_size = Some(size);
            }
        }
    }
    Ok(())
}

fn read_local_clipboard_paths() -> Result<Vec<std::path::PathBuf>, String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("无法读取本机剪贴板：{error}"))?;
    clipboard
        .get()
        .file_list()
        .map_err(|error| format!("本机剪贴板中没有可用文件：{error}"))
}

fn clipboard_file_signature(
    files: &[manager::LocalClipboardFile],
) -> Result<HashMap<std::path::PathBuf, (String, u64)>, String> {
    let signature = files
        .iter()
        .map(|file| (file.path.clone(), (file.name.clone(), file.size)))
        .collect::<HashMap<_, _>>();
    if signature.len() != files.len() {
        return Err("剪贴板中包含重复文件，已阻止重复上传".to_string());
    }
    Ok(signature)
}

#[tauri::command]
fn read_clipboard_files() -> Result<Vec<ClipboardFilePreview>, String> {
    let paths = read_local_clipboard_paths()?;
    let files = manager::validate_clipboard_files(&paths)
        .map_err(|error| format!("剪贴板文件不可用：{error}"))?;
    let total: u64 = files.iter().map(|file| file.size).sum();
    if total > CLIPBOARD_FILE_LIMIT {
        return Err(format!(
            "剪贴板文件合计超过 50 MiB（当前 {} MiB）",
            (total as f64 / 1024.0 / 1024.0).ceil() as u64
        ));
    }
    Ok(files
        .into_iter()
        .map(|file| ClipboardFilePreview {
            path: file.path.to_string_lossy().into_owned(),
            name: file.name,
            size: file.size,
        })
        .collect())
}

#[tauri::command]
async fn upload_clipboard_files(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<ClipboardUploadResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = paths
            .into_iter()
            .map(std::path::PathBuf::from)
            .collect::<Vec<_>>();
        let requested = manager::validate_clipboard_files(&paths)
            .map_err(|error| format!("剪贴板文件不可用：{error}"))?;
        let current = manager::validate_clipboard_files(&read_local_clipboard_paths()?)
            .map_err(|error| format!("剪贴板文件已变化：{error}"))?;
        if clipboard_file_signature(&requested)? != clipboard_file_signature(&current)? {
            return Err("本机文件剪贴板已变化，请重新点击上传".to_string());
        }
        let state = app
            .try_state::<RuntimeState>()
            .ok_or_else(|| "本地连接管理器尚未启动".to_string())?;
        let manager = state
            .manager
            .lock()
            .map_err(|_| "连接管理器不可用".to_string())?;
        let manager = manager
            .as_ref()
            .ok_or_else(|| "连接管理器已停止".to_string())?;
        manager
            .upload_clipboard_files(paths)
            .map_err(|error| format!("文件上传失败：{error}"))
    })
    .await
    .map_err(|error| format!("文件上传任务失败：{error}"))?
}

fn corrected_main_window_size(
    size: PhysicalSize<u32>,
    previous: PhysicalSize<u32>,
    ratio: f64,
) -> PhysicalSize<u32> {
    let width_delta = size.width.abs_diff(previous.width);
    let height_delta = size.height.abs_diff(previous.height);
    if width_delta >= height_delta {
        let minimum_width = (200.0 * ratio).ceil() as u32;
        let width = size.width.max(320).max(minimum_width);
        PhysicalSize::new(width, (f64::from(width) / ratio).round().max(200.0) as u32)
    } else {
        let minimum_height = (320.0 / ratio).ceil() as u32;
        let height = size.height.max(200).max(minimum_height);
        PhysicalSize::new(
            (f64::from(height) * ratio).round().max(320.0) as u32,
            height,
        )
    }
}

#[cfg(target_os = "windows")]
struct WindowsAspectHook {
    original_proc: isize,
    ratio_bits: AtomicU64,
    frame_width: AtomicI32,
    frame_height: AtomicI32,
    last_width: AtomicI32,
    last_height: AtomicI32,
}

#[cfg(target_os = "windows")]
static WINDOWS_ASPECT_HOOKS: OnceLock<Mutex<HashMap<isize, Box<WindowsAspectHook>>>> =
    OnceLock::new();

#[cfg(target_os = "windows")]
fn windows_aspect_hooks() -> &'static Mutex<HashMap<isize, Box<WindowsAspectHook>>> {
    WINDOWS_ASPECT_HOOKS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(target_os = "windows")]
fn windows_sizing_uses_width(edge: u32, width_delta: i32, height_delta: i32) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        WMSZ_BOTTOM, WMSZ_BOTTOMLEFT, WMSZ_BOTTOMRIGHT, WMSZ_LEFT, WMSZ_RIGHT, WMSZ_TOP,
        WMSZ_TOPLEFT, WMSZ_TOPRIGHT,
    };

    match edge {
        WMSZ_LEFT | WMSZ_RIGHT => true,
        WMSZ_TOP | WMSZ_BOTTOM => false,
        WMSZ_TOPLEFT | WMSZ_TOPRIGHT | WMSZ_BOTTOMLEFT | WMSZ_BOTTOMRIGHT => {
            width_delta >= height_delta
        }
        _ => width_delta >= height_delta,
    }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn windows_aspect_proc(
    hwnd: windows_sys::Win32::Foundation::HWND,
    message: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, DefWindowProcW, WM_NCDESTROY, WM_SIZING,
    };

    let key = hwnd as isize;
    let mut remove = false;
    let original_proc = {
        let hooks = windows_aspect_hooks();
        let mut guard = hooks.lock().expect("Windows aspect hook mutex poisoned");
        let Some(hook) = guard.get_mut(&key) else {
            return DefWindowProcW(hwnd, message, wparam, lparam);
        };
        if message == WM_SIZING && lparam != 0 {
            let rect = &mut *(lparam as *mut RECT);
            let frame_width = hook.frame_width.load(Ordering::Acquire).max(0);
            let frame_height = hook.frame_height.load(Ordering::Acquire).max(0);
            let ratio = f64::from_bits(hook.ratio_bits.load(Ordering::Acquire));
            if ratio.is_finite() && ratio > 0.0 {
                let proposed_width = (rect.right - rect.left).max(frame_width + 320);
                let proposed_height = (rect.bottom - rect.top).max(frame_height + 200);
                let last_width = hook.last_width.load(Ordering::Acquire);
                let last_height = hook.last_height.load(Ordering::Acquire);
                let width_delta = (proposed_width - last_width).abs();
                let height_delta = (proposed_height - last_height).abs();
                let edge = wparam as u32;
                let use_width = windows_sizing_uses_width(edge, width_delta, height_delta);
                let (target_width, target_height) = if use_width {
                    let inner_width = (proposed_width - frame_width).max(320);
                    let inner_height = (f64::from(inner_width) / ratio).round().max(200.0) as i32;
                    (inner_width + frame_width, inner_height + frame_height)
                } else {
                    let inner_height = (proposed_height - frame_height).max(200);
                    let inner_width = (f64::from(inner_height) * ratio).round().max(320.0) as i32;
                    (inner_width + frame_width, inner_height + frame_height)
                };
                let anchor_right = matches!(
                    edge,
                    windows_sys::Win32::UI::WindowsAndMessaging::WMSZ_LEFT
                        | windows_sys::Win32::UI::WindowsAndMessaging::WMSZ_TOPLEFT
                        | windows_sys::Win32::UI::WindowsAndMessaging::WMSZ_BOTTOMLEFT
                );
                let anchor_bottom = matches!(
                    edge,
                    windows_sys::Win32::UI::WindowsAndMessaging::WMSZ_TOP
                        | windows_sys::Win32::UI::WindowsAndMessaging::WMSZ_TOPLEFT
                        | windows_sys::Win32::UI::WindowsAndMessaging::WMSZ_TOPRIGHT
                );
                if anchor_right {
                    rect.left = rect.right - target_width;
                } else {
                    rect.right = rect.left + target_width;
                }
                if anchor_bottom {
                    rect.top = rect.bottom - target_height;
                } else {
                    rect.bottom = rect.top + target_height;
                }
                hook.last_width.store(target_width, Ordering::Release);
                hook.last_height.store(target_height, Ordering::Release);
            }
        }
        if message == WM_NCDESTROY {
            remove = true;
        }
        hook.original_proc
    };
    if remove {
        let _ = windows_aspect_hooks()
            .lock()
            .map(|mut hooks| hooks.remove(&key));
    }
    let original: windows_sys::Win32::UI::WindowsAndMessaging::WNDPROC =
        std::mem::transmute(original_proc);
    if original.is_some() {
        CallWindowProcW(original, hwnd, message, wparam, lparam)
    } else {
        DefWindowProcW(hwnd, message, wparam, lparam)
    }
}

#[cfg(target_os = "windows")]
fn apply_native_main_window_aspect(
    window: &tauri::WebviewWindow,
    ratio: Option<f64>,
) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWLP_WNDPROC,
    };

    let hwnd = window
        .hwnd()
        .map_err(|error| format!("无法取得 Windows 主窗口：{error}"))?
        .0 as windows_sys::Win32::Foundation::HWND;
    let key = hwnd as isize;
    let inner = window
        .inner_size()
        .map_err(|error| format!("无法取得 Windows 内容尺寸：{error}"))?;
    let outer = window
        .outer_size()
        .map_err(|error| format!("无法取得 Windows 外框尺寸：{error}"))?;
    let frame_width = outer.width.saturating_sub(inner.width).min(i32::MAX as u32) as i32;
    let frame_height = outer
        .height
        .saturating_sub(inner.height)
        .min(i32::MAX as u32) as i32;
    let ratio_bits = ratio.map_or(0, f64::to_bits);
    let hooks = windows_aspect_hooks();
    let mut hooks = hooks
        .lock()
        .map_err(|_| "Windows 比例锁定状态不可用".to_string())?;
    if let Some(hook) = hooks.get_mut(&key) {
        hook.ratio_bits.store(ratio_bits, Ordering::Release);
        hook.frame_width.store(frame_width, Ordering::Release);
        hook.frame_height.store(frame_height, Ordering::Release);
        hook.last_width.store(outer.width as i32, Ordering::Release);
        hook.last_height
            .store(outer.height as i32, Ordering::Release);
        return Ok(());
    }
    let original_proc = unsafe { GetWindowLongPtrW(hwnd, GWLP_WNDPROC) };
    if original_proc == 0 {
        return Err("无法安装 Windows 窗口比例处理器".to_string());
    }
    let hook = Box::new(WindowsAspectHook {
        original_proc,
        ratio_bits: AtomicU64::new(ratio_bits),
        frame_width: AtomicI32::new(frame_width),
        frame_height: AtomicI32::new(frame_height),
        last_width: AtomicI32::new(outer.width as i32),
        last_height: AtomicI32::new(outer.height as i32),
    });
    let replacement = windows_aspect_proc as *const () as isize;
    let previous = unsafe { SetWindowLongPtrW(hwnd, GWLP_WNDPROC, replacement) };
    if previous == 0 {
        return Err("无法安装 Windows 窗口比例处理器".to_string());
    }
    hooks.insert(key, hook);
    Ok(())
}

#[cfg(target_os = "linux")]
fn apply_native_main_window_aspect(
    window: &tauri::WebviewWindow,
    ratio: Option<f64>,
) -> Result<(), String> {
    use gtk::{gdk, prelude::*};

    let native = window
        .gtk_window()
        .map_err(|error| format!("无法取得 GTK 主窗口：{error}"))?;
    match ratio {
        Some(ratio) => {
            let geometry = gdk::Geometry::new(
                320,
                200,
                0,
                0,
                0,
                0,
                0,
                0,
                ratio,
                ratio,
                gdk::Gravity::Center,
            );
            native.set_geometry_hints(
                None::<&gtk::Window>,
                Some(&geometry),
                gdk::WindowHints::MIN_SIZE | gdk::WindowHints::ASPECT,
            );
        }
        None => native.set_geometry_hints(None::<&gtk::Window>, None, gdk::WindowHints::ASPECT),
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn apply_native_main_window_aspect(
    window: &tauri::WebviewWindow,
    ratio: Option<f64>,
) -> Result<(), String> {
    use objc2_app_kit::NSWindow;
    use objc2_foundation::NSSize;

    let native = window
        .ns_window()
        .map_err(|error| format!("无法取得 macOS 主窗口：{error}"))?;
    // NSWindow applies this constraint to the content area, so the native
    // title bar is excluded without manually guessing its height.
    unsafe {
        let native = &*native.cast::<NSWindow>();
        native.setContentAspectRatio(
            ratio.map_or(NSSize::new(0.0, 0.0), |ratio| NSSize::new(ratio, 1.0)),
        );
    }
    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn apply_native_main_window_aspect(
    _window: &tauri::WebviewWindow,
    _ratio: Option<f64>,
) -> Result<(), String> {
    Ok(())
}

fn enforce_main_window_aspect(window: &tauri::Window, size: PhysicalSize<u32>) {
    // macOS, Linux GTK and Windows each receive a native live aspect constraint
    // from `apply_native_main_window_aspect`. Do not call `set_size` again from
    // their resize event: that races the user's drag and snaps the window back.
    if cfg!(any(
        target_os = "macos",
        target_os = "linux",
        target_os = "windows"
    )) {
        let state = window.app_handle().state::<MainWindowAspect>();
        if let Ok(mut last_size) = state.last_size.lock() {
            *last_size = Some(size);
        }
        return;
    }
    let state = window.app_handle().state::<MainWindowAspect>();
    let ratio = state.ratio.lock().ok().and_then(|value| *value);
    let Some(ratio) = ratio else {
        if let Ok(mut last_size) = state.last_size.lock() {
            *last_size = Some(size);
        }
        return;
    };
    if state.correcting.swap(true, Ordering::AcqRel) {
        if let Ok(mut last_size) = state.last_size.lock() {
            *last_size = Some(size);
        }
        return;
    }
    let previous = state.last_size.lock().ok().and_then(|value| *value);
    let Some(previous) = previous else {
        if let Ok(mut last_size) = state.last_size.lock() {
            *last_size = Some(size);
        }
        state.correcting.store(false, Ordering::Release);
        return;
    };
    let target = corrected_main_window_size(size, previous, ratio);
    if target != size {
        let _ = window.set_size(target);
        if let Ok(mut last_size) = state.last_size.lock() {
            *last_size = Some(target);
        }
    } else if let Ok(mut last_size) = state.last_size.lock() {
        *last_size = Some(size);
    }
    state.correcting.store(false, Ordering::Release);
}

impl RuntimeState {
    fn stop(&self) {
        if self.stopped.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Ok(mut node) = self.node.lock() {
            kill_child(node.take());
        }
        if let Ok(mut manager) = self.manager.lock() {
            if let Some(mut manager) = manager.take() {
                manager.stop();
            }
        }
    }
}

impl Drop for RuntimeState {
    fn drop(&mut self) {
        self.stop();
    }
}

fn kill_child(mut child: Option<Child>) {
    if let Some(ref mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn bridge_root(app: &AppHandle) -> io::Result<PathBuf> {
    if let Ok(path) = std::env::var("PENGUX11VNC_ROOT") {
        let path = PathBuf::from(path);
        if is_bridge_root(&path) {
            return Ok(path);
        }
    }

    let mut candidates = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")];
    if let Ok(resource_dir) = app.path().resource_dir() {
        // Tauri places ../relative resources under _up_ in bundled apps.
        candidates.push(resource_dir.join("_up_"));
        candidates.push(resource_dir.join("bridge"));
        candidates.push(resource_dir);
    }
    candidates
        .into_iter()
        .find(|path| is_bridge_root(path))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "找不到 PenguX11VNC bridge 资源（server.js/public）",
            )
        })
}

fn is_bridge_root(path: &Path) -> bool {
    path.join("server.js").is_file() && path.join("public").is_dir()
}

fn write_session(runtime: &Path, url: &Url, pid: u32, profile: &Profile) -> io::Result<()> {
    fs::create_dir_all(runtime)?;
    let path = runtime.join("session.json");
    fs::write(
        &path,
        serde_json::to_vec_pretty(&json!({
            "url": url.as_str(),
            "pid": pid,
            "profile": profile.id,
            "created": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
        }))?,
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn prepare_debug_log(runtime: &Path) -> io::Result<()> {
    if std::env::var("PENGUX11VNC_DEBUG").as_deref() != Ok("1") {
        return Ok(());
    }
    fs::create_dir_all(runtime)?;
    let path = runtime.join("tauri-manager.log");
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)?;
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    }
    std::env::set_var("PENGUX11VNC_DEBUG_LOG", path);
    Ok(())
}

fn valid_window_dimension(value: f64, minimum: f64, maximum: f64) -> bool {
    value.is_finite() && (minimum..=maximum).contains(&value)
}

fn load_main_window_size(path: &Path) -> Option<(f64, f64)> {
    let data = fs::read(path).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&data).ok()?;
    let width = value.get("width")?.as_f64()?;
    let height = value.get("height")?.as_f64()?;
    if valid_window_dimension(width, 320.0, 10000.0)
        && valid_window_dimension(height, 200.0, 10000.0)
    {
        Some((width, height))
    } else {
        None
    }
}

fn save_main_window_size(path: &Path, size: PhysicalSize<u32>, scale_factor: f64) {
    if !scale_factor.is_finite() || scale_factor <= 0.0 {
        return;
    }
    let width = f64::from(size.width) / scale_factor;
    let height = f64::from(size.height) / scale_factor;
    if !valid_window_dimension(width, 320.0, 10000.0)
        || !valid_window_dimension(height, 200.0, 10000.0)
    {
        return;
    }
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let document = json!({ "version": 1, "width": width, "height": height });
    if fs::write(&temporary, document.to_string()).is_err() {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600));
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        eprintln!("无法保存主窗口尺寸：{error}");
    }
}

fn bundled_node(root: &Path) -> PathBuf {
    if let Ok(path) = std::env::var("PENGUX11VNC_NODE") {
        return PathBuf::from(path);
    }
    let names = if cfg!(windows) {
        ["pengu-node.exe", "node.exe"]
    } else {
        ["pengu-node", "node"]
    };
    let candidates = names.iter().flat_map(|name| {
        [
            root.join("node").join(name),
            root.join("runtime/node").join(name),
            root.join(name),
        ]
    });
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" }))
}

fn start_node(
    root: &Path,
    runtime: &Path,
    profile: &Profile,
    manager: &ManagerRuntime,
) -> io::Result<(Child, Url)> {
    fs::create_dir_all(runtime)?;
    let log_path = runtime.join("tauri-server.log");
    let log = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&log_path, fs::Permissions::from_mode(0o600))?;
    }

    let mut command = hidden_command(bundled_node(root));
    command
        .arg(root.join("server.js"))
        .current_dir(root)
        .env("PENGUX11VNC_PORT", "0")
        .env("PENGUX11VNC_VNC_PORT", profile.local_port().to_string())
        .env("PENGUX11VNC_IME_ENABLED", "1")
        .env(
            "PENGUX11VNC_CONNECTION_JSON",
            profile.normalized_json().to_string(),
        )
        .env("PENGUX11VNC_RUST_MANAGER_URL", &manager.url)
        .env("PENGUX11VNC_RUST_MANAGER_TOKEN", &manager.token)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log));
    if let Some(password_file) = profile.local_password_file() {
        if Path::new(&password_file).is_file() {
            command.env("PENGUX11VNC_VNC_PASSWORD_FILE", password_file);
        }
    }

    let mut child = command.spawn()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(status) = child.try_wait()? {
            return Err(io::Error::other(format!("Node bridge 启动失败：{status}")));
        }
        if let Ok(text) = fs::read_to_string(&log_path) {
            if let Some(raw_url) = text.lines().find(|line| line.starts_with("http://")) {
                let url = Url::parse(raw_url.trim()).map_err(io::Error::other)?;
                if url.host_str() == Some("127.0.0.1") {
                    return Ok((child, url));
                }
            }
        }
        if std::time::Instant::now() >= deadline {
            kill_child(Some(child));
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Node bridge 启动超时",
            ));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(MainWindowAspect::default())
        .invoke_handler(tauri::generate_handler![
            set_main_window_aspect,
            read_clipboard_files,
            upload_clipboard_files
        ])
        .setup(|app| {
            let root = bridge_root(app.handle())?;
            let runtime = app
                .path()
                .app_data_dir()
                .map_err(|error| io::Error::other(error.to_string()))?;
            prepare_debug_log(&runtime)?;
            let (profile, configured, startup_error) = startup_profile();
            let manager = ManagerRuntime::start(profile.clone(), configured, startup_error)?;
            let (node, url) = match start_node(&root, &runtime, &profile, &manager) {
                Ok(result) => result,
                Err(error) => {
                    let mut manager = manager;
                    manager.stop();
                    return Err(error.into());
                }
            };

            if let Err(error) = write_session(&runtime, &url, node.id(), &profile) {
                kill_child(Some(node));
                let mut manager = manager;
                manager.stop();
                return Err(error.into());
            }
            let window_geometry_path = runtime.join("window.json");
            let (window_width, window_height) =
                load_main_window_size(&window_geometry_path).unwrap_or((1280.0, 900.0));
            app.manage(RuntimeState {
                manager: Mutex::new(Some(manager)),
                node: Mutex::new(Some(node)),
                stopped: AtomicBool::new(false),
                window_geometry_path,
            });
            if let Err(error) = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("PenguX11VNC")
                .inner_size(window_width, window_height)
                .min_inner_size(320.0, 200.0)
                .resizable(true)
                .visible(true)
                .build()
            {
                if let Some(state) = app.try_state::<RuntimeState>() {
                    state.stop();
                }
                return Err(error.into());
            }
            if tray::install(app.handle()).is_err() {
                // A tray failure must not leave an invisible, unrecoverable app.
                // Keep the main window and its normal close/exit behavior.
                eprintln!("系统托盘不可用：主窗口将使用正常关闭行为");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { .. } = event {
                    if let Some(state) = window.app_handle().try_state::<RuntimeState>() {
                        if let Ok(size) = window.inner_size() {
                            let scale_factor = window.scale_factor().unwrap_or(1.0);
                            save_main_window_size(&state.window_geometry_path, size, scale_factor);
                        }
                    }
                }
                match event {
                    WindowEvent::CloseRequested { api, .. }
                        if tray::close_action(window.app_handle(), "main")
                            == tray::CloseAction::HideMain =>
                    {
                        api.prevent_close();
                        if tray::hide_main(window.app_handle()).is_err() {
                            eprintln!("无法隐藏主窗口，已保留窗口以便重试");
                        }
                    }
                    WindowEvent::Resized(size) => {
                        if let Some(state) = window.app_handle().try_state::<RuntimeState>() {
                            let scale_factor = window.scale_factor().unwrap_or(1.0);
                            save_main_window_size(&state.window_geometry_path, *size, scale_factor);
                        }
                        enforce_main_window_aspect(window, *size);
                    }
                    WindowEvent::ThemeChanged(_) => tray::refresh_theme(window.app_handle()),
                    WindowEvent::Destroyed => {
                        tray::shutdown(window.app_handle());
                        window.app_handle().exit(0);
                    }
                    _ => {}
                }
                return;
            }
            let closing = matches!(
                event,
                WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
            );
            if !closing {
                return;
            }
            let Some(window_id) = window.label().strip_prefix("qq-child-") else {
                return;
            };
            let session_id = format!("window-{window_id}");
            if let Some(state) = window.app_handle().try_state::<RuntimeState>() {
                if let Ok(manager) = state.manager.lock() {
                    if let Some(manager) = manager.as_ref() {
                        manager.cleanup_session(&session_id);
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building PenguX11VNC")
        .run(|app, event| match event {
            // Explicit tray Quit, macOS Cmd+Q, and OS exit all use the same cleanup.
            // Hiding the main window never reaches this branch. If no tray is
            // available, ordinary main-window close still exits and cleans up.
            RunEvent::Exit => {
                tray::shutdown(app);
                if let Some(state) = app.try_state::<RuntimeState>() {
                    state.stop();
                }
            }
            RunEvent::ExitRequested { .. } => tray::shutdown(app),
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => {
                let _ = tray::restore_main(app);
            }
            _ => {}
        });
}

#[cfg(test)]
mod aspect_tests {
    use super::*;

    #[test]
    fn aspect_correction_follows_the_larger_resize_axis() {
        let width_resize = corrected_main_window_size(
            PhysicalSize::new(1400, 800),
            PhysicalSize::new(1200, 800),
            1.5,
        );
        assert_eq!(width_resize, PhysicalSize::new(1400, 933));

        let height_resize = corrected_main_window_size(
            PhysicalSize::new(1000, 900),
            PhysicalSize::new(1000, 700),
            1.5,
        );
        assert_eq!(height_resize, PhysicalSize::new(1350, 900));
    }
}
