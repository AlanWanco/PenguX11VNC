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
        return Ok(());
    }
    let value = width / height;
    if !(0.05..=20.0).contains(&value) || !value.is_finite() {
        return Err("窗口比例无效".to_string());
    }
    *ratio = Some(value);
    if let Some(window) = app.get_webview_window("main") {
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

fn enforce_main_window_aspect(window: &tauri::Window, size: PhysicalSize<u32>) {
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
        .env("QQ_VIEWER_PORT", "0")
        .env("QQ_VNC_PORT", profile.local_port().to_string())
        .env("QQ_IME_ENABLED", "1")
        .env("QQ_CONNECTION_JSON", profile.normalized_json().to_string())
        .env("QQ_RUST_MANAGER_URL", &manager.url)
        .env("QQ_RUST_MANAGER_TOKEN", &manager.token)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log));
    if let Some(password_file) = profile.local_password_file() {
        if Path::new(&password_file).is_file() {
            command.env("QQ_VNC_PASSWORD_FILE", password_file);
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
            let (profile, configured, startup_error) = startup_profile();
            let manager = ManagerRuntime::start(profile.clone(), configured, startup_error)?;
            let runtime = app
                .path()
                .app_data_dir()
                .map_err(|error| io::Error::other(error.to_string()))?;
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
            app.manage(RuntimeState {
                manager: Mutex::new(Some(manager)),
                node: Mutex::new(Some(node)),
                stopped: AtomicBool::new(false),
            });
            if let Err(error) = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("PenguX11VNC")
                .inner_size(1280.0, 900.0)
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
                    WindowEvent::Resized(size) => enforce_main_window_aspect(window, *size),
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
