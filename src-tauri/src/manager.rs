#[path = "onboarding.rs"]
mod onboarding;
use onboarding::Onboarding;

use rand::random;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const DEFAULT_CONFIG: &str = ".config/qq-window-viewer/connections.json";
const VNC_CREDENTIAL_SERVICE: &str = "com.alanwanco.PenguX11VNC";
const CLOSE_X11_WINDOW_PYTHON: &str = r#"
import ctypes as C, ctypes.util as U, sys, time

D = C.c_void_p
W = C.c_ulong

class ClassHint(C.Structure):
    _fields_ = [("name", C.c_void_p), ("klass", C.c_void_p)]

class Attributes(C.Structure):
    _fields_ = [
        ("x", C.c_int), ("y", C.c_int), ("width", C.c_int),
        ("height", C.c_int), ("border_width", C.c_int), ("depth", C.c_int),
        ("visual", C.c_void_p), ("root", C.c_ulong), ("klass", C.c_int),
        ("bit_gravity", C.c_int), ("win_gravity", C.c_int),
        ("backing_store", C.c_int), ("backing_planes", C.c_ulong),
        ("backing_pixel", C.c_ulong), ("save_under", C.c_int),
        ("colormap", C.c_ulong), ("map_installed", C.c_int),
        ("map_state", C.c_int), ("all_event_masks", C.c_long),
        ("your_event_mask", C.c_long), ("do_not_propagate_mask", C.c_long),
        ("override_redirect", C.c_int), ("screen", C.c_void_p),
    ]

class ClientMessage(C.Structure):
    _fields_ = [
        ("type", C.c_int), ("serial", C.c_ulong), ("send_event", C.c_int),
        ("display", D), ("window", W), ("message_type", W),
        ("format", C.c_int), ("data", C.c_long * 5),
    ]

ERROR_HANDLER = C.CFUNCTYPE(C.c_int, D, C.c_void_p)

x11 = C.CDLL(U.find_library("X11") or "libX11.so.6")
x11.XOpenDisplay.argtypes = [C.c_char_p]
x11.XOpenDisplay.restype = D
x11.XCloseDisplay.argtypes = [D]
x11.XSetErrorHandler.argtypes = [ERROR_HANDLER]
x11.XSetErrorHandler.restype = ERROR_HANDLER
x11.XInternAtom.argtypes = [D, C.c_char_p, C.c_int]
x11.XInternAtom.restype = W
x11.XGetClassHint.argtypes = [D, W, C.POINTER(ClassHint)]
x11.XGetClassHint.restype = C.c_int
x11.XGetWindowAttributes.argtypes = [D, W, C.POINTER(Attributes)]
x11.XGetWindowAttributes.restype = C.c_int
x11.XGetWMProtocols.argtypes = [D, W, C.POINTER(C.POINTER(W)), C.POINTER(C.c_int)]
x11.XGetWMProtocols.restype = C.c_int
x11.XSendEvent.argtypes = [D, W, C.c_int, C.c_long, C.c_void_p]
x11.XSendEvent.restype = C.c_int
x11.XDestroyWindow.argtypes = [D, W]
x11.XDestroyWindow.restype = C.c_int
x11.XFlush.argtypes = [D]
x11.XSync.argtypes = [D, C.c_int]
x11.XFree.argtypes = [C.c_void_p]

ignore_error = ERROR_HANDLER(lambda *_: 0)


def stop(code):
    raise SystemExit(code)


display = x11.XOpenDisplay(None)
if not display:
    stop(3)
x11.XSetErrorHandler(ignore_error)
window = W(int(sys.argv[1], 0))
expected_class = sys.argv[2].casefold()
hint = ClassHint()
if not x11.XGetClassHint(display, window, C.byref(hint)):
    x11.XCloseDisplay(display)
    stop(4)
try:
    actual_class = C.string_at(hint.klass).decode(errors="replace") if hint.klass else ""
finally:
    if hint.name:
        x11.XFree(hint.name)
    if hint.klass:
        x11.XFree(hint.klass)
if actual_class.casefold() != expected_class:
    x11.XCloseDisplay(display)
    stop(5)
attrs = Attributes()
if not x11.XGetWindowAttributes(display, window, C.byref(attrs)) or attrs.map_state != 2:
    x11.XCloseDisplay(display)
    stop(6)
wm_protocols = x11.XInternAtom(display, b"WM_PROTOCOLS", 0)
wm_delete = x11.XInternAtom(display, b"WM_DELETE_WINDOW", 0)
protocols = C.POINTER(W)()
count = C.c_int()
def destroy_window():
    x11.XDestroyWindow(display, window)
    x11.XFlush(display)
    x11.XSync(display, 0)


if not x11.XGetWMProtocols(display, window, C.byref(protocols), C.byref(count)):
    destroy_window()
    x11.XCloseDisplay(display)
    stop(0)
try:
    supported = any(protocols[index] == wm_delete for index in range(count.value))
finally:
    x11.XFree(protocols)
if not supported:
    destroy_window()
    x11.XCloseDisplay(display)
    stop(0)
event = ClientMessage()
event.type = 33
event.send_event = 1
event.display = display
event.window = window
event.message_type = wm_protocols
event.format = 32
event.data[0] = wm_delete
event.data[1] = 0
event_mask = 0xC0000
if not x11.XSendEvent(display, window, 0, event_mask, C.byref(event)):
    destroy_window()
    x11.XCloseDisplay(display)
    stop(0)
x11.XFlush(display)
x11.XSync(display, 0)
time.sleep(0.15)
attrs = Attributes()
if x11.XGetWindowAttributes(display, window, C.byref(attrs)) and attrs.map_state == 2:
    destroy_window()
x11.XCloseDisplay(display)
"#;

pub(crate) fn hidden_command<S: AsRef<OsStr>>(program: S) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut command = Command::new(program);
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }
    #[cfg(not(windows))]
    {
        Command::new(program)
    }
}

#[derive(Clone)]
pub struct Profile {
    pub id: String,
    pub raw: Value,
}

impl Profile {
    fn get(&self, section: &str, key: &str) -> Option<&Value> {
        self.raw.get(section)?.get(key)
    }

    fn text(&self, section: &str, key: &str, fallback: &str) -> String {
        self.get(section, key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(fallback)
            .to_string()
    }

    fn number(&self, section: &str, key: &str, fallback: u16) -> u16 {
        self.get(section, key)
            .and_then(Value::as_u64)
            .and_then(|value| u16::try_from(value).ok())
            .filter(|value| *value > 0)
            .unwrap_or(fallback)
    }

    fn ssh_user(&self) -> String {
        self.text("ssh", "user", "remote-user")
    }

    fn ssh_host(&self) -> String {
        self.text("ssh", "host", "remote.example")
    }

    fn ssh_port(&self) -> u16 {
        self.number("ssh", "port", 22)
    }

    fn key_file(&self) -> io::Result<Option<String>> {
        let value = self
            .get("ssh", "privateKeyFile")
            .and_then(Value::as_str)
            .unwrap_or("");
        if value.starts_with('-') || value.is_empty() {
            return Ok(None);
        }
        let expanded = expand_home(value);
        if !PathBuf::from(&expanded).is_absolute() || expanded.contains('\0') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "SSH 私钥路径必须是本机绝对路径",
            ));
        }
        let metadata = fs::metadata(&expanded)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!("SSH 私钥权限过宽，请执行 chmod 600 {expanded}"),
                ));
            }
        }
        if !metadata.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "SSH 私钥路径不是文件",
            ));
        }
        Ok(Some(expanded))
    }

    pub(crate) fn local_port(&self) -> u16 {
        self.number("tunnel", "localPort", 15900)
    }

    fn remote_port(&self) -> u16 {
        self.number("tunnel", "remotePort", 5900)
    }

    fn remote_host(&self) -> String {
        self.text("tunnel", "remoteHost", "127.0.0.1")
    }

    fn display(&self) -> String {
        self.text("window", "display", ":0")
    }

    fn xauthority(&self) -> String {
        self.text("window", "xauthority", "/run/user/1000/xauth")
    }

    fn window_id(&self) -> String {
        self.text("window", "id", "0x1")
    }

    fn class_name(&self) -> String {
        self.text("window", "className", "QQ")
    }

    fn window_list_helper(&self) -> String {
        self.text(
            "helpers",
            "windowList",
            "/home/remote-user/.local/lib/qq-window-viewer/list-qq-windows",
        )
    }

    fn ime_helper(&self) -> String {
        self.text(
            "helpers",
            "imeCapture",
            "/home/remote-user/.local/lib/qq-window-viewer/capture-ime",
        )
    }

    fn remote_password_file(&self) -> String {
        self.text("vnc", "remotePasswordFile", "/run/user/1000/x11vnc.pass")
    }

    pub(crate) fn local_password_file(&self) -> Option<String> {
        let value = self
            .get("vnc", "passwordFile")
            .and_then(Value::as_str)
            .unwrap_or("");
        if value.starts_with('-') || value.is_empty() {
            None
        } else {
            Some(expand_home(value))
        }
    }

    fn min_width(&self) -> u32 {
        self.get("children", "minWidth")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .map(|value| value.clamp(40, 4096))
            .unwrap_or(80)
    }

    fn min_height(&self) -> u32 {
        self.get("children", "minHeight")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .map(|value| value.clamp(40, 4096))
            .unwrap_or(60)
    }

    pub(crate) fn normalized_json(&self) -> Value {
        let mut object = self.raw.as_object().cloned().unwrap_or_default();
        object.insert("id".to_string(), Value::String(self.id.clone()));
        Value::Object(object)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WindowInfo {
    pub id: String,
    pub mapped: bool,
    pub depth: i32,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct ChildSessionInfo {
    pub id: String,
    pub title: String,
    #[serde(rename = "windowId")]
    pub window_id: String,
    pub child: bool,
    pub geometry: WindowInfo,
    #[serde(rename = "targetPort")]
    pub target_port: u16,
    #[serde(rename = "localPort")]
    pub local_port: u16,
    #[serde(rename = "remotePort")]
    pub remote_port: u16,
}

struct ChildSession {
    info: ChildSessionInfo,
    remote_pid: u32,
    tunnel: Child,
}

struct ManagerState {
    profile: Profile,
    children: HashMap<String, ChildSession>,
    onboarding: Onboarding,
}

impl ManagerState {
    fn new(profile: Profile, configured: bool, startup_error: Option<String>) -> Self {
        Self {
            profile,
            children: HashMap::new(),
            onboarding: Onboarding::new(configured, startup_error),
        }
    }

    fn credential_entry(&self) -> Result<keyring::Entry, keyring::Error> {
        keyring::Entry::new(VNC_CREDENTIAL_SERVICE, &format!("vnc:{}", self.profile.id))
    }

    fn stored_vnc_password(&self) -> Option<String> {
        self.credential_entry().ok()?.get_password().ok()
    }

    fn store_vnc_password(&self, password: &str) -> bool {
        self.credential_entry()
            .and_then(|entry| entry.set_password(password))
            .is_ok()
    }

    fn clear_vnc_password(&self) {
        if let Ok(entry) = self.credential_entry() {
            let _ = entry.delete_credential();
        }
    }

    fn list_windows(&mut self) -> io::Result<Vec<WindowInfo>> {
        let windows = discover_windows(&self.profile)?;
        let visible: std::collections::HashSet<String> = windows
            .iter()
            .map(|window| window.id.to_lowercase())
            .collect();
        let stale: Vec<String> = self
            .children
            .iter()
            .filter(|(_, child)| !visible.contains(&child.info.window_id.to_lowercase()))
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale {
            self.cleanup(&id);
        }
        Ok(windows)
    }

    fn open_child(&mut self, requested_id: &str) -> io::Result<ChildSessionInfo> {
        let windows = discover_windows(&self.profile)?;
        let window = windows
            .into_iter()
            .find(|window| window.id.eq_ignore_ascii_case(requested_id))
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "QQ 子窗口不可见"))?;
        let session_id = format!(
            "window-{}",
            window.id.trim_start_matches("0x").to_lowercase()
        );
        if let Some(child) = self.children.get(&session_id) {
            return Ok(child.info.clone());
        }

        let remote_port = self.find_remote_port()?;
        let local_port = allocate_port()?;
        let remote_pid = start_remote_vnc(&self.profile, &window, remote_port)?;
        let mut tunnel = hidden_command("ssh")
            .args(ssh_args(
                &self.profile,
                Some((local_port, remote_port)),
                true,
            )?)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        if let Err(error) = wait_for_rfb(local_port, Duration::from_secs(8)) {
            let _ = tunnel.kill();
            let _ = tunnel.wait();
            let _ = run_ssh(
                &self.profile,
                &format!("kill {remote_pid}"),
                Duration::from_secs(5),
            );
            return Err(error);
        }

        let info = ChildSessionInfo {
            id: session_id.clone(),
            title: format!("QQ 子窗口 · {}", window.id),
            window_id: window.id.clone(),
            child: true,
            geometry: window,
            target_port: local_port,
            local_port,
            remote_port,
        };
        self.children.insert(
            session_id,
            ChildSession {
                info: info.clone(),
                remote_pid,
                tunnel,
            },
        );
        Ok(info)
    }

    fn find_remote_port(&self) -> io::Result<u16> {
        let used: std::collections::HashSet<u16> = self
            .children
            .values()
            .map(|child| child.info.remote_port)
            .collect();
        let candidates: Vec<String> = (5901..5999)
            .filter(|port| !used.contains(port))
            .map(|port| port.to_string())
            .collect();
        let command = format!(
            "for p in {}; do if ! ss -H -ltn | grep -q \"[.:]$p \"; then printf \"%s\" \"$p\"; exit 0; fi; done; exit 1",
            candidates.join(" ")
        );
        let output = run_ssh(&self.profile, &command, Duration::from_secs(8))?;
        output
            .trim()
            .parse()
            .map_err(|_| io::Error::other("没有可用的远端 VNC 端口"))
    }

    fn cleanup(&mut self, id: &str) {
        if let Some(mut child) = self.children.remove(id) {
            let cleanup_command = format!(
                concat!(
                    "env DISPLAY={display} XAUTHORITY={auth} python3 -c {script} {window} {class_name} >/dev/null 2>&1 || true; ",
                    "if [ -r /proc/{pid}/comm ] && [ \"$(tr -d '\\0' </proc/{pid}/comm 2>/dev/null)\" = x11vnc ]; then ",
                    "kill -TERM {pid} 2>/dev/null || true; ",
                    "for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 {pid} 2>/dev/null || exit 0; sleep 0.1; done; ",
                    "kill -KILL {pid} 2>/dev/null || true; fi"
                ),
                display = shell_quote(&self.profile.display()),
                auth = shell_quote(&self.profile.xauthority()),
                script = shell_quote(CLOSE_X11_WINDOW_PYTHON),
                window = shell_quote(&child.info.window_id),
                class_name = shell_quote(&self.profile.class_name()),
                pid = child.remote_pid,
            );
            let _ = child.tunnel.kill();
            let _ = child.tunnel.wait();
            let _ = run_ssh(&self.profile, &cleanup_command, Duration::from_secs(5));
        }
    }

    fn cleanup_all(&mut self) {
        self.onboarding.stop();
        let ids: Vec<String> = self.children.keys().cloned().collect();
        for id in ids {
            self.cleanup(&id);
        }
    }
}

pub struct ManagerRuntime {
    pub url: String,
    pub token: String,
    state: Arc<Mutex<ManagerState>>,
    shutdown: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl ManagerRuntime {
    pub fn start(
        profile: Profile,
        configured: bool,
        startup_error: Option<String>,
    ) -> io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let address = listener.local_addr()?;
        let token = random_token();
        let state = Arc::new(Mutex::new(ManagerState::new(
            profile,
            configured,
            startup_error,
        )));
        let shutdown = Arc::new(AtomicBool::new(false));
        let thread_state = Arc::clone(&state);
        let thread_shutdown = Arc::clone(&shutdown);
        let thread_token = token.clone();
        let join = thread::spawn(move || {
            while !thread_shutdown.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let state = Arc::clone(&thread_state);
                        let token = thread_token.clone();
                        thread::spawn(move || handle_request(stream, state, &token));
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(40));
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            url: format!("http://{address}"),
            token,
            state,
            shutdown,
            join: Some(join),
        })
    }

    pub fn cleanup_session(&self, id: &str) {
        let state = Arc::clone(&self.state);
        let id = id.to_string();
        thread::spawn(move || {
            if let Ok(mut state) = state.lock() {
                state.cleanup(&id);
            }
        });
    }

    pub fn stop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
        if let Ok(mut state) = self.state.lock() {
            state.cleanup_all();
        }
    }
}

impl Drop for ManagerRuntime {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn load_profile() -> io::Result<Profile> {
    let config_path = std::env::var("QQ_VIEWER_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home_path(DEFAULT_CONFIG));
    let selected = std::env::var("QQ_VIEWER_PROFILE").ok();
    if !config_path.exists() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "尚未创建连接配置，请使用向导",
        ));
    }
    let document: Value = serde_json::from_str(&fs::read_to_string(&config_path)?)?;
    let connections = document
        .get("connections")
        .and_then(Value::as_object)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "配置缺少 connections"))?;
    let id = selected
        .or_else(|| {
            document
                .get("defaultConnection")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .or_else(|| connections.keys().next().cloned())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "没有连接配置"))?;
    let raw = connections
        .get(&id)
        .cloned()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "找不到连接配置"))?;
    validate_profile(&raw)?;
    Ok(Profile { id, raw })
}

pub fn start_main_tunnel(profile: &Profile) -> io::Result<Option<Child>> {
    if check_rfb(profile.local_port()) {
        return Ok(None);
    }
    let mut child = hidden_command("ssh")
        .args(ssh_args(
            profile,
            Some((profile.local_port(), profile.remote_port())),
            true,
        )?)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    if let Err(error) = wait_for_rfb(profile.local_port(), Duration::from_secs(10)) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok(Some(child))
}

fn discover_windows(profile: &Profile) -> io::Result<Vec<WindowInfo>> {
    if profile.raw["managed"]["enabled"] == true {
        return onboarding::fallback_windows(profile);
    }
    let command = format!(
        "env DISPLAY={} XAUTHORITY={} {} {} {}",
        shell_quote(&profile.display()),
        shell_quote(&profile.xauthority()),
        shell_quote(&profile.window_list_helper()),
        shell_quote(&profile.window_id()),
        shell_quote(&profile.class_name())
    );
    let output = run_ssh(profile, &command, Duration::from_secs(7))?;
    let mut windows = Vec::new();
    for line in output.lines().filter(|line| !line.trim().is_empty()) {
        let window: WindowInfo = serde_json::from_str(line)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        if !valid_window_id(&window.id)
            || window.id.eq_ignore_ascii_case(&profile.window_id())
            || !window.mapped
            || window.width < profile.min_width()
            || window.height < profile.min_height()
        {
            continue;
        }
        windows.push(window);
    }
    Ok(windows)
}

fn start_remote_vnc(profile: &Profile, window: &WindowInfo, remote_port: u16) -> io::Result<u32> {
    let log_path = format!(
        "/tmp/pengux11vnc-{}.log",
        window.id.trim_start_matches("0x").to_lowercase()
    );
    let args = [
        "nohup".to_string(),
        "x11vnc".to_string(),
        "-display".to_string(),
        profile.display(),
        "-auth".to_string(),
        profile.xauthority(),
        "-id".to_string(),
        window.id.clone(),
        "-localhost".to_string(),
        "-rfbport".to_string(),
        remote_port.to_string(),
        "-forever".to_string(),
        "-shared".to_string(),
        "-noxdamage".to_string(),
        "-noshm".to_string(),
        "-rfbauth".to_string(),
        profile.remote_password_file(),
        "-rfbversion".to_string(),
        "3.3".to_string(),
        "-xwarppointer".to_string(),
        "-o".to_string(),
        log_path,
    ];
    let command = format!(
        "env DISPLAY={} XAUTHORITY={} {} >/dev/null 2>&1 </dev/null & echo $!",
        shell_quote(&profile.display()),
        shell_quote(&profile.xauthority()),
        args.iter()
            .map(|arg| shell_quote(arg))
            .collect::<Vec<_>>()
            .join(" ")
    );
    let output = run_ssh(profile, &command, Duration::from_secs(7))?;
    output
        .trim()
        .parse()
        .map_err(|_| io::Error::other("远端子窗口 VNC 没有返回 PID"))
}

fn ssh_args(
    profile: &Profile,
    forward: Option<(u16, u16)>,
    no_command: bool,
) -> io::Result<Vec<String>> {
    let mut args = vec![
        "-T".to_string(),
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=yes".to_string(),
        "-o".to_string(),
        "ConnectTimeout=8".to_string(),
        "-o".to_string(),
        "ServerAliveInterval=15".to_string(),
        "-o".to_string(),
        "ServerAliveCountMax=2".to_string(),
    ];
    if let Some(key) = profile.key_file()? {
        args.extend([
            "-i".to_string(),
            key,
            "-o".to_string(),
            "IdentitiesOnly=yes".to_string(),
        ]);
    }
    args.extend(["-p".to_string(), profile.ssh_port().to_string()]);
    if let Some((local, remote)) = forward {
        args.extend([
            "-o".to_string(),
            "ExitOnForwardFailure=yes".to_string(),
            "-L".to_string(),
            format!("127.0.0.1:{local}:{}:{remote}", profile.remote_host()),
        ]);
    }
    if no_command {
        args.push("-N".to_string());
    }
    args.push(format!("{}@{}", profile.ssh_user(), profile.ssh_host()));
    Ok(args)
}

fn run_ssh(profile: &Profile, command: &str, timeout: Duration) -> io::Result<String> {
    let mut args = ssh_args(profile, None, false)?;
    args.push(command.to_string());
    let mut child = hidden_command("ssh")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("SSH stdout unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("SSH stderr unavailable"))?;
    let out = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.take(256 * 1024).read_to_end(&mut bytes);
        bytes
    });
    let err = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.take(64 * 1024).read_to_end(&mut bytes);
        bytes
    });
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            let output = out.join().unwrap_or_default();
            let diagnostic = err.join().unwrap_or_default();
            if status.success() {
                return Ok(String::from_utf8_lossy(&output).to_string());
            }
            return Err(io::Error::other(ssh_failure_hint(&diagnostic)));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(io::ErrorKind::TimedOut, "SSH 远端命令超时"));
        }
        thread::sleep(Duration::from_millis(30));
    }
}

fn ssh_failure_hint(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let hint = if text.contains("Host key verification failed")
        || text.contains("REMOTE HOST IDENTIFICATION HAS CHANGED")
    {
        "SSH 主机指纹尚未信任或发生变化：请在终端连接并与远端核对指纹，不要跳过主机密钥检查。"
    } else if text.contains("Permission denied")
        || text.contains("sign_and_send_pubkey")
        || text.contains("authentication agent")
    {
        "SSH 认证失败：Windows 请填写私钥路径或确认 ssh-agent 已运行并已加载密钥；加密密钥先执行 ssh-add。"
    } else if text.contains("Could not resolve") {
        "SSH 主机名无法解析：请检查主机地址、DNS 或网络。"
    } else if text.contains("Connection refused")
        || text.contains("timed out")
        || text.contains("No route to host")
    {
        "SSH 网络连接失败：请检查主机、端口、远端 SSH 服务和防火墙。"
    } else if text.contains("python3") && text.contains("not found") {
        "远端缺少 Python 3：按引导定向安装后重试。"
    } else {
        "SSH 或远端预检失败：请核对 SSH 认证、Python 3、libX11 和当前用户的图形会话。"
    };
    let detail = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| {
            line.chars()
                .filter(|character| !character.is_control())
                .take(240)
                .collect::<String>()
        });
    match detail {
        Some(detail) => format!("{hint} SSH 返回：{detail}"),
        None => hint.to_string(),
    }
}

fn allocate_port() -> io::Result<u16> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    Ok(listener.local_addr()?.port())
}

fn check_rfb(port: u16) -> bool {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(250)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let mut greeting = [0_u8; 4];
    stream.read_exact(&mut greeting).is_ok() && &greeting == b"RFB "
}

fn wait_for_rfb(port: u16, timeout: Duration) -> io::Result<()> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if check_rfb(port) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(120));
    }
    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        format!("本地 VNC 转发端口 {port} 未就绪"),
    ))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn valid_window_id(value: &str) -> bool {
    value.len() > 2
        && value.starts_with("0x")
        && value[2..].chars().all(|char| char.is_ascii_hexdigit())
}

fn expand_home(value: &str) -> String {
    if value == "~" {
        return home_path("").to_string_lossy().into_owned();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return home_path(rest).to_string_lossy().into_owned();
    }
    value.to_string()
}

fn home_path(value: &str) -> PathBuf {
    let home = if cfg!(windows) {
        std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
    } else {
        std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
    }
    .unwrap_or_default();
    PathBuf::from(home).join(value)
}

fn validate_profile(raw: &Value) -> io::Result<()> {
    let profile = Profile {
        id: "validation".to_string(),
        raw: raw.clone(),
    };
    let user = profile.ssh_user();
    if user.starts_with('-')
        || user.is_empty()
        || !user
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || "._-".contains(char))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "SSH 用户名无效",
        ));
    }
    for value in [profile.ssh_host(), profile.remote_host()] {
        if value.starts_with('-')
            || value.is_empty()
            || !value
                .chars()
                .all(|char| char.is_ascii_alphanumeric() || ".:_-".contains(char))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "SSH 主机名无效",
            ));
        }
    }
    for value in [
        profile.xauthority(),
        profile.window_list_helper(),
        profile.ime_helper(),
    ] {
        if !value.starts_with('/')
            || !value
                .chars()
                .all(|char| char.is_ascii_alphanumeric() || "/_.:-".contains(char))
        {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "远端路径无效"));
        }
    }
    let password_file = profile.remote_password_file();
    if !(password_file.starts_with('/') || password_file.starts_with("~/"))
        || !password_file
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || "/_.:-~".contains(char))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "远端 VNC 密码文件路径无效",
        ));
    }
    if !valid_window_id(&profile.window_id()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "X11 窗口 ID 无效",
        ));
    }
    let display = profile.display();
    let parts: Vec<_> = display
        .strip_prefix(':')
        .unwrap_or_default()
        .split('.')
        .collect();
    if !display.starts_with(':')
        || parts.len() > 2
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "DISPLAY 无效"));
    }
    let _ = profile.key_file()?;
    Ok(())
}

pub fn startup_profile() -> (Profile, bool, Option<String>) {
    match load_profile() {
        Ok(profile) => (profile, true, None),
        Err(_) => (
            onboarding::empty_profile(),
            false,
            Some("尚未配置，或配置文件无效；请使用向导检查。损坏的配置不会被覆盖。".into()),
        ),
    }
}

fn random_token() -> String {
    random::<[u8; 32]>()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn stream_ime(mut stream: TcpStream, state: Arc<Mutex<ManagerState>>) {
    let profile = match state.lock() {
        Ok(manager) => manager.profile.clone(),
        Err(_) => return,
    };
    let command = format!(
        "env DISPLAY={} XAUTHORITY={} {} {}",
        shell_quote(&profile.display()),
        shell_quote(&profile.xauthority()),
        shell_quote(&profile.ime_helper()),
        shell_quote(&profile.window_id())
    );
    let mut args = match ssh_args(&profile, None, false) {
        Ok(args) => args,
        Err(_) => return,
    };
    args.push(command);
    let child = hidden_command("ssh")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else {
        return;
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return;
    };

    let header = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nTransfer-Encoding: chunked\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n";
    if stream.write_all(header).is_err() {
        let _ = child.kill();
        let _ = child.wait();
        return;
    }
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) => break,
            Ok(_) => {
                let chunk_header = format!("{:X}\r\n", line.len());
                if stream.write_all(chunk_header.as_bytes()).is_err()
                    || stream.write_all(&line).is_err()
                    || stream.write_all(b"\r\n").is_err()
                    || stream.flush().is_err()
                {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let _ = stream.write_all(b"0\r\n\r\n");
    let _ = child.kill();
    let _ = child.wait();
}

fn handle_request(mut stream: TcpStream, state: Arc<Mutex<ManagerState>>, token: &str) {
    let Ok((method, path, supplied_token, body)) = read_request(&mut stream) else {
        return;
    };
    if supplied_token.as_deref() != Some(token) {
        send_json(&mut stream, 403, json!({"error": "forbidden"}));
        return;
    }
    if method == "GET" && path == "/ime" {
        stream_ime(stream, state);
        return;
    }

    let result = match (method.as_str(), path.as_str()) {
        ("GET", "/setup") => state
            .lock()
            .map(|s| s.setup_status())
            .map_err(|_| io::Error::other("manager locked")),
        ("POST", "/setup/preflight")
        | ("POST", "/setup/save")
        | ("POST", "/main/prepare")
        | ("POST", "/main/poll") => state
            .lock()
            .map_err(|_| io::Error::other("manager locked"))
            .and_then(|mut manager| match path.as_str() {
                "/setup/preflight" => manager.preflight(body),
                "/setup/save" => manager.save_setup(body),
                _ => manager.prepare_main(path == "/main/poll"),
            }),
        ("POST", "/main/stop") => state
            .lock()
            .map_err(|_| io::Error::other("manager locked"))
            .map(|mut manager| {
                manager.cleanup_all();
                json!({"ok": true})
            }),
        ("GET", "/status") => Ok(json!({"ok": true})),
        ("GET", "/credentials") => state
            .lock()
            .map_err(|_| io::Error::other("manager locked"))
            .map(|manager| {
                manager
                    .stored_vnc_password()
                    .map_or_else(|| json!({}), |password| json!({"password": password}))
            }),
        ("POST", "/credentials") => state
            .lock()
            .map_err(|_| io::Error::other("manager locked"))
            .map(|manager| {
                if body["persist"] == false {
                    manager.clear_vnc_password();
                    return json!({"ok": true, "persisted": false});
                }
                let password = body["password"].as_str().unwrap_or_default();
                json!({"ok": true, "persisted": manager.store_vnc_password(password)})
            }),
        ("DELETE", "/credentials") => state
            .lock()
            .map_err(|_| io::Error::other("manager locked"))
            .map(|manager| {
                manager.clear_vnc_password();
                json!({"ok": true})
            }),
        ("GET", "/windows") => state
            .lock()
            .map_err(|_| io::Error::other("manager locked"))
            .and_then(|mut manager| {
                manager
                    .list_windows()
                    .map(|windows| json!({"windows": windows}))
            }),
        _ if method == "POST" && path.starts_with("/windows/") && path.ends_with("/open") => {
            let id = path
                .strip_prefix("/windows/")
                .and_then(|value| value.strip_suffix("/open"))
                .unwrap_or_default();
            state
                .lock()
                .map_err(|_| io::Error::other("manager locked"))
                .and_then(|mut manager| {
                    manager
                        .open_child(id)
                        .map(|session| json!({"session": session}))
                })
        }
        _ if method == "DELETE" && path.starts_with("/sessions/") => {
            let id = path.strip_prefix("/sessions/").unwrap_or_default();
            match state.lock() {
                Ok(mut manager) => {
                    manager.cleanup(id);
                    Ok(json!({"ok": true}))
                }
                Err(_) => Err(io::Error::other("manager locked")),
            }
        }
        _ => Err(io::Error::new(io::ErrorKind::NotFound, "not found")),
    };

    match result {
        Ok(body) => send_json(&mut stream, 200, body),
        Err(error) => send_json(&mut stream, 500, json!({"error": error.to_string()})),
    }
}

type Request = (String, String, Option<String>, Value);
fn read_request(stream: &mut TcpStream) -> io::Result<Request> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(stream);
    let mut head = String::new();
    let mut length = 0;
    loop {
        let mut line = String::new();
        if reader.by_ref().take(16 * 1024 + 1).read_line(&mut line)? == 0 {
            return Err(io::Error::other("incomplete request"));
        }
        head.push_str(&line);
        if head.len() > 16 * 1024 {
            return Err(io::Error::other("headers too large"));
        }
        if line == "\r\n" {
            break;
        }
    }
    let mut lines = head.split("\r\n");
    let mut request = lines.next().unwrap_or_default().split_whitespace();
    let method = request.next().unwrap_or_default().to_owned();
    let path = request.next().unwrap_or_default().to_owned();
    let mut token = None;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("x-pengux11vnc-token") {
                token = Some(value.trim().to_owned());
            }
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse::<usize>().map_err(io::Error::other)?;
            }
            if name.eq_ignore_ascii_case("transfer-encoding") {
                return Err(io::Error::other("chunked unsupported"));
            }
        }
    }
    if length > 32 * 1024 {
        return Err(io::Error::other("body too large"));
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes)?;
    let body = if bytes.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&bytes)?
    };
    Ok((method, path, token, body))
}

fn send_json(stream: &mut TcpStream, status: u16, body: Value) {
    let bytes = body.to_string().into_bytes();
    let reason = match status {
        200 => "OK",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Internal Server Error",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        bytes.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(&bytes);
}

#[cfg(test)]
mod onboarding_http_tests {
    use super::*;
    fn request(
        manager: &ManagerRuntime,
        token: &str,
        method: &str,
        path: &str,
        body: &str,
    ) -> String {
        let mut stream = TcpStream::connect(manager.url.trim_start_matches("http://")).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        write!(stream, "{method} {path} HTTP/1.1\r\nHost: localhost\r\nX-PenguX11VNC-Token: {token}\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }
    #[test]
    fn fresh_manager_opens_without_ssh_and_requires_auth_and_consent() {
        let mut manager = ManagerRuntime::start(onboarding::empty_profile(), false, None).unwrap();
        let forbidden = request(&manager, "wrong", "GET", "/setup", "");
        assert!(forbidden.starts_with("HTTP/1.1 403"));
        let setup = request(&manager, &manager.token, "GET", "/setup", "");
        assert!(setup.contains("\"configured\":false"));
        let prepare = request(&manager, &manager.token, "POST", "/main/prepare", "{}");
        assert!(prepare.contains("请先使用首次连接向导"));
        let save = request(
            &manager,
            &manager.token,
            "POST",
            "/setup/save",
            "{\"consent\":false}",
        );
        assert!(save.contains("请确认仅启动所选"));
        manager.stop();
    }
}
