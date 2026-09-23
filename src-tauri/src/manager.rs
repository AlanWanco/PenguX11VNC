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
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver, RecvTimeoutError},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const DEFAULT_CONFIG: &str = ".config/pengux11vnc/connections.json";
const LEGACY_CONFIG: &str = ".config/qq-window-viewer/connections.json";
const VNC_CREDENTIAL_SERVICE: &str = "com.alanwanco.PenguX11VNC";

fn debug_enabled() -> bool {
    std::env::var("PENGUX11VNC_DEBUG").as_deref() == Ok("1")
}

fn debug_log(event: &str, details: impl std::fmt::Display) {
    if !debug_enabled() {
        return;
    }
    let details = details
        .to_string()
        .replace('\n', "\\n")
        .replace('\r', "\\r");
    let line = format!("[PenguX11VNC debug] {event} {details}");
    eprintln!("{line}");
    if let Ok(path) = std::env::var("PENGUX11VNC_DEBUG_LOG") {
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{line}");
        }
    }
}

const FILE_CLIPBOARD_X11_PYTHON: &str = r#"
import ctypes as C, ctypes.util as U, sys

D = C.c_void_p
W = C.c_ulong

class SelectionRequest(C.Structure):
    _fields_ = [
        ("type", C.c_int), ("serial", C.c_ulong), ("send_event", C.c_int),
        ("display", D), ("owner", W), ("requestor", W), ("selection", W),
        ("target", W), ("property", W), ("time", C.c_ulong),
    ]

class SelectionClear(C.Structure):
    _fields_ = [
        ("type", C.c_int), ("serial", C.c_ulong), ("send_event", C.c_int),
        ("display", D), ("window", W), ("selection", W), ("time", C.c_ulong),
    ]

class SelectionNotify(C.Structure):
    # XSelectionEvent does not contain SelectionRequestEvent.owner. Reusing
    # SelectionRequest here shifts every field after display on 64-bit X11.
    _fields_ = [
        ("type", C.c_int), ("serial", C.c_ulong), ("send_event", C.c_int),
        ("display", D), ("requestor", W), ("selection", W),
        ("target", W), ("property", W), ("time", C.c_ulong),
    ]

class Event(C.Union):
    # XNextEvent writes the complete 192-byte XEvent, not only the selected
    # event view. Keep the union large enough to avoid corrupting ctypes state.
    _fields_ = [
        ("type", C.c_int),
        ("request", SelectionRequest),
        ("clear", SelectionClear),
        ("notify", SelectionNotify),
        ("padding", C.c_ubyte * 192),
    ]

x11 = C.CDLL(U.find_library("X11") or "libX11.so.6")
x11.XOpenDisplay.argtypes = [C.c_char_p]
x11.XOpenDisplay.restype = D
x11.XDefaultScreen.argtypes = [D]
x11.XDefaultScreen.restype = C.c_int
x11.XRootWindow.argtypes = [D, C.c_int]
x11.XRootWindow.restype = W
x11.XCreateSimpleWindow.argtypes = [D, W, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_uint, W, W]
x11.XCreateSimpleWindow.restype = W
x11.XDestroyWindow.argtypes = [D, W]
x11.XDestroyWindow.restype = C.c_int
x11.XCloseDisplay.argtypes = [D]
x11.XInternAtom.argtypes = [D, C.c_char_p, C.c_int]
x11.XInternAtom.restype = W
x11.XSetSelectionOwner.argtypes = [D, W, W, C.c_ulong]
x11.XGetSelectionOwner.argtypes = [D, W]
x11.XGetSelectionOwner.restype = W
x11.XChangeProperty.argtypes = [D, W, W, W, C.c_int, C.c_int, C.c_void_p, C.c_int]
x11.XSendEvent.argtypes = [D, W, C.c_int, C.c_long, C.POINTER(Event)]
x11.XNextEvent.argtypes = [D, C.POINTER(Event)]
x11.XFlush.argtypes = [D]

CurrentTime = 0
PropModeReplace = 0
EVENT_SELECTION_REQUEST = 30
EVENT_SELECTION_NOTIFY = 31
EVENT_SELECTION_CLEAR = 29

payload = sys.argv[1].encode()
gnome_payload = b"copy\n" + payload.replace(b"\r\n", b"\n")
kde_cut_payload = b"0"
display = x11.XOpenDisplay(None)
if not display:
    raise SystemExit(2)
screen = x11.XDefaultScreen(display)
root = x11.XRootWindow(display, screen)
window = x11.XCreateSimpleWindow(display, root, 0, 0, 1, 1, 0, 0, 0)
clipboard = x11.XInternAtom(display, b"CLIPBOARD", 0)
targets = x11.XInternAtom(display, b"TARGETS", 0)
uri = x11.XInternAtom(display, b"text/uri-list", 0)
gnome = x11.XInternAtom(display, b"x-special/gnome-copied-files", 0)
kde4 = x11.XInternAtom(display, b"application/x-kde4-urilist", 0)
kde5 = x11.XInternAtom(display, b"application/x-kde5-urilist", 0)
kde_cut = x11.XInternAtom(display, b"application/x-kde-cutselection", 0)
atom = 4
x11.XSetSelectionOwner(display, clipboard, window, CurrentTime)
x11.XFlush(display)
if x11.XGetSelectionOwner(display, clipboard) != window:
    x11.XDestroyWindow(display, window)
    x11.XCloseDisplay(display)
    raise SystemExit(3)
try:
    while True:
        event = Event()
        x11.XNextEvent(display, C.byref(event))
        if event.type == EVENT_SELECTION_CLEAR:
            break
        if event.type != EVENT_SELECTION_REQUEST:
            continue
        request = event.request
        property_atom = request.property or request.target
        # Advertise only file-list formats; never expose file URIs as ordinary text.
        if request.target == targets:
            target_values = (targets, uri, gnome, kde4, kde5, kde_cut)
            values = (C.c_ulong * len(target_values))(*target_values)
            x11.XChangeProperty(display, request.requestor, property_atom, atom, 32, PropModeReplace, values, len(target_values))
        elif request.target in (uri, kde4, kde5):
            data = C.create_string_buffer(payload)
            x11.XChangeProperty(display, request.requestor, property_atom, request.target, 8, PropModeReplace, data, len(payload))
        elif request.target == gnome:
            data = C.create_string_buffer(gnome_payload)
            x11.XChangeProperty(display, request.requestor, property_atom, request.target, 8, PropModeReplace, data, len(gnome_payload))
        elif request.target == kde_cut:
            data = C.create_string_buffer(kde_cut_payload)
            x11.XChangeProperty(display, request.requestor, property_atom, request.target, 8, PropModeReplace, data, len(kde_cut_payload))
        else:
            property_atom = 0
        response = Event()
        response.notify.type = EVENT_SELECTION_NOTIFY
        response.notify.send_event = 1
        response.notify.display = display
        response.notify.requestor = request.requestor
        response.notify.selection = request.selection
        response.notify.target = request.target
        response.notify.property = property_atom
        response.notify.time = request.time
        x11.XSendEvent(display, request.requestor, 0, 0, C.byref(response))
        x11.XFlush(display)
finally:
    x11.XDestroyWindow(display, window)
    x11.XCloseDisplay(display)
"#;

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
if not x11.XGetWindowAttributes(display, window, C.byref(attrs)):
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
if x11.XGetWindowAttributes(display, window, C.byref(attrs)):
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
        let metadata = fs::metadata(&expanded).map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("无法访问 SSH 私钥文件“{expanded}”：{error}"),
            )
        })?;
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
            "/home/remote-user/.local/lib/pengux11vnc/list-qq-windows",
        )
    }

    fn ime_helper(&self) -> String {
        self.text(
            "helpers",
            "imeCapture",
            "/home/remote-user/.local/lib/pengux11vnc/capture-ime",
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
    #[serde(default, skip_serializing)]
    pub pid: Option<u64>,
    #[serde(default, skip_serializing)]
    pub start: Option<String>,
    #[serde(default, skip_serializing)]
    pub exe: Option<String>,
}

pub const CLIPBOARD_FILE_LIMIT: u64 = 50 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct LocalClipboardFile {
    pub path: PathBuf,
    pub name: String,
    pub size: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct ClipboardFileInfo {
    pub name: String,
    pub size: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct ClipboardUploadResult {
    pub files: Vec<ClipboardFileInfo>,
    pub directory: String,
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

struct VideoSession {
    child: Child,
    stdin: ChildStdin,
    messages: Receiver<String>,
}

impl Drop for VideoSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn validate_clipboard_files(paths: &[PathBuf]) -> io::Result<Vec<LocalClipboardFile>> {
    if paths.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "剪贴板中没有文件",
        ));
    }
    if paths.len() > 64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "一次最多传送 64 个文件",
        ));
    }
    let mut total = 0_u64;
    let mut files = Vec::with_capacity(paths.len());
    for path in paths {
        if !path.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "剪贴板文件路径必须是绝对路径",
            ));
        }
        let path = fs::canonicalize(path)?;
        let metadata = fs::metadata(&path)?;
        if !metadata.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "剪贴板中包含非普通文件，暂不传送文件夹",
            ));
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| {
                !value.is_empty()
                    && value.len() <= 240
                    && *value == value.trim()
                    && !value.chars().any(|character| character.is_control())
            })
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "剪贴板文件名包含不可传送的字符",
                )
            })?
            .to_string();
        let size = metadata.len();
        total = total
            .checked_add(size)
            .ok_or_else(|| io::Error::other("剪贴板文件大小溢出"))?;
        if total > CLIPBOARD_FILE_LIMIT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "剪贴板文件合计超过 50 MiB",
            ));
        }
        files.push(LocalClipboardFile { path, name, size });
    }
    Ok(files)
}

fn percent_encode_file_uri(path: &str) -> String {
    let mut uri = String::from("file://");
    for byte in path.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'.' | b'_' | b'~' | b'/') {
            uri.push(*byte as char);
        } else {
            uri.push('%');
            uri.push_str(&format!("{byte:02X}"));
        }
    }
    uri
}

struct ManagerState {
    profile: Profile,
    children: HashMap<String, ChildSession>,
    videos: HashMap<String, VideoSession>,
    onboarding: Onboarding,
}

impl ManagerState {
    fn new(profile: Profile, configured: bool, startup_error: Option<String>) -> Self {
        Self {
            profile,
            children: HashMap::new(),
            videos: HashMap::new(),
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

    fn activate(&mut self, session_id: &str) -> io::Result<Value> {
        if session_id == "main" && self.onboarding.activate_main()? {
            return Ok(json!({"ok": true, "managed": true}));
        }
        let target = if session_id == "main" {
            json!({
                "id": self.profile.window_id(),
                "display": self.profile.display(),
                "xauthority": self.profile.xauthority(),
                "className": self.profile.class_name(),
            })
        } else {
            let child = self
                .children
                .get(session_id)
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "QQ 子窗口会话不存在"))?;
            let mut target = json!({
                "id": child.info.window_id.clone(),
                "display": self.profile.display(),
                "xauthority": self.profile.xauthority(),
                "className": self.profile.class_name(),
            });
            if let Some(pid) = child.info.geometry.pid {
                target["pid"] = json!(pid);
            }
            if let Some(start) = &child.info.geometry.start {
                target["start"] = json!(start);
            }
            if let Some(exe) = &child.info.geometry.exe {
                target["exe"] = json!(exe);
            }
            target
        };
        onboarding::activate_remote(&self.profile, &target)
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
            .find(|window| window.mapped && window.id.eq_ignore_ascii_case(requested_id))
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "QQ 子窗口不可见"))?;
        debug_log(
            "child-open",
            format!(
                "id={} mapped={} geometry={}x{}",
                window.id, window.mapped, window.width, window.height
            ),
        );
        let session_id = format!(
            "window-{}",
            window.id.trim_start_matches("0x").to_lowercase()
        );
        if let Some(child) = self.children.get(&session_id) {
            if check_rfb(child.info.local_port) {
                return Ok(child.info.clone());
            }
        }
        if let Some(mut stale) = self.children.remove(&session_id) {
            debug_log(
                "child-vnc-restart",
                format!(
                    "session={} window={} old-pid={} local-port={}",
                    session_id, stale.info.window_id, stale.remote_pid, stale.info.local_port
                ),
            );
            stop_remote_vnc(&self.profile, stale.remote_pid, &mut stale.tunnel);
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
            kill_remote_vnc_process(&self.profile, remote_pid);
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

    fn video_target(&self, session_id: &str) -> io::Result<Value> {
        if session_id == "main" {
            return Ok(json!({
                "id": self.profile.window_id(),
                "display": self.profile.display(),
                "xauthority": self.profile.xauthority(),
                "className": self.profile.class_name(),
            }));
        }
        let child = self
            .children
            .get(session_id)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "QQ 视频会话不存在"))?;
        let mut target = json!({
            "id": child.info.window_id,
            "display": self.profile.display(),
            "xauthority": self.profile.xauthority(),
            "className": self.profile.class_name(),
        });
        if let Some(pid) = child.info.geometry.pid {
            target["pid"] = json!(pid);
        }
        if let Some(start) = &child.info.geometry.start {
            target["start"] = json!(start);
        }
        if let Some(exe) = &child.info.geometry.exe {
            target["exe"] = json!(exe);
        }
        Ok(target)
    }

    fn video_options(&self) -> Value {
        let section = self.profile.raw.get("video");
        let fps = section
            .and_then(|value| value.get("fps"))
            .and_then(Value::as_u64)
            .unwrap_or(60)
            .clamp(1, 60);
        let bitrate = section
            .and_then(|value| value.get("bitrateKbps"))
            .and_then(Value::as_u64)
            .unwrap_or(4000)
            .clamp(250, 20_000)
            * 1000;
        let port_min = section
            .and_then(|value| value.get("udpPortStart"))
            .and_then(Value::as_u64)
            .unwrap_or(40_000)
            .clamp(1024, 65_535);
        let port_max = section
            .and_then(|value| value.get("udpPortEnd"))
            .and_then(Value::as_u64)
            .unwrap_or(40_100)
            .clamp(port_min, 65_535);
        json!({
            "fps": fps,
            "bitrate": bitrate,
            "portMin": port_min,
            "portMax": port_max,
        })
    }

    fn video_offer(&mut self, session_id: &str, body: Value) -> io::Result<Value> {
        let offer_type = body.get("type").and_then(Value::as_str);
        let sdp = body.get("sdp").and_then(Value::as_str).unwrap_or_default();
        if offer_type != Some("offer") || sdp.is_empty() || sdp.len() > 256 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "WebRTC offer 无效",
            ));
        }
        let target = self.video_target(session_id)?;
        let mut options = self.video_options();
        options["target"] = target;
        if let Some(previous) = self.videos.remove(session_id) {
            stop_video_session(previous);
        }
        let mut session = spawn_video_session(&self.profile, &options)?;
        if let Err(error) = write_video_command(
            &mut session.stdin,
            &json!({ "action": "offer", "type": "offer", "sdp": sdp }),
        ) {
            stop_video_session(session);
            return Err(error);
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                stop_video_session(session);
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "远端 WebRTC 回应超时",
                ));
            }
            match session.messages.recv_timeout(remaining) {
                Ok(line) => {
                    let message: Value = match serde_json::from_str(&line) {
                        Ok(message) => message,
                        Err(_) => {
                            stop_video_session(session);
                            return Err(io::Error::other("远端 WebRTC 响应无效"));
                        }
                    };
                    match message.get("type").and_then(Value::as_str) {
                        Some("ready") => {}
                        Some("answer") => {
                            let Some(answer) = message
                                .get("sdp")
                                .and_then(Value::as_str)
                                .filter(|value| !value.is_empty())
                            else {
                                stop_video_session(session);
                                return Err(io::Error::other("远端 WebRTC answer 缺少 SDP"));
                            };
                            self.videos.insert(session_id.to_string(), session);
                            return Ok(json!({
                                "answer": {"type": "answer", "sdp": answer},
                                "codec": message.get("codec").cloned().unwrap_or(json!("vp8")),
                                "portMin": options["portMin"],
                                "portMax": options["portMax"],
                            }));
                        }
                        Some("error") => {
                            let error = message
                                .get("error")
                                .and_then(Value::as_str)
                                .unwrap_or("remote-video-failed");
                            stop_video_session(session);
                            return Err(io::Error::other(error.to_string()));
                        }
                        _ => {}
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    stop_video_session(session);
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "远端 WebRTC 回应超时",
                    ));
                }
                Err(RecvTimeoutError::Disconnected) => {
                    stop_video_session(session);
                    return Err(io::Error::other("远端视频进程已退出"));
                }
            }
        }
    }

    fn cleanup_video(&mut self, id: &str) {
        if let Some(session) = self.videos.remove(id) {
            stop_video_session(session);
        }
    }

    fn cleanup(&mut self, id: &str) {
        self.cleanup_video(id);
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
            debug_log(
                "child-cleanup",
                format!(
                    "session={} window={} pid={} remote-port={}",
                    id, child.info.window_id, child.remote_pid, child.info.remote_port
                ),
            );
            let _ = run_ssh(&self.profile, &cleanup_command, Duration::from_secs(5));
            stop_remote_vnc(&self.profile, child.remote_pid, &mut child.tunnel);
        }
    }

    fn cleanup_all(&mut self) {
        self.onboarding.stop();
        let video_ids: Vec<String> = self.videos.keys().cloned().collect();
        for id in video_ids {
            self.cleanup_video(&id);
        }
        let ids: Vec<String> = self.children.keys().cloned().collect();
        for id in ids {
            self.cleanup(&id);
        }
    }
}

fn upload_clipboard_files(
    profile: &Profile,
    paths: Vec<PathBuf>,
) -> io::Result<ClipboardUploadResult> {
    let files = validate_clipboard_files(&paths)?;
    let transfer_id: String = random::<[u8; 12]>()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let mut remote_paths = Vec::with_capacity(files.len());
    for (index, file) in files.iter().enumerate() {
        let temporary = format!("/tmp/pengux11vnc-clipboard-{transfer_id}-{index}");
        if let Err(error) = scp_clipboard_file(profile, &file.path, &temporary) {
            cleanup_remote_file(profile, &temporary);
            cleanup_remote_files(profile, &remote_paths);
            return Err(error);
        }
        match move_clipboard_file(profile, &temporary, &file.name, &transfer_id) {
            Ok(path) => remote_paths.push(path),
            Err(error) => {
                cleanup_remote_file(profile, &temporary);
                cleanup_remote_files(profile, &remote_paths);
                return Err(error);
            }
        }
    }
    if let Err(error) = set_remote_file_clipboard(profile, &remote_paths) {
        cleanup_remote_files(profile, &remote_paths);
        return Err(error);
    }
    Ok(ClipboardUploadResult {
        files: remote_paths
            .iter()
            .zip(files.iter())
            .map(|(path, file)| ClipboardFileInfo {
                name: path
                    .rsplit('/')
                    .next()
                    .filter(|name| !name.is_empty())
                    .unwrap_or(&file.name)
                    .to_string(),
                size: file.size,
            })
            .collect(),
        directory: "Downloads".to_string(),
    })
}

#[cfg(windows)]
fn scp_local_path(local: &Path) -> PathBuf {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    // CF_HDROP may return an extended-length path such as
    // `\\\\?\\I:\\directory\\file`. OpenSSH scp interprets the colon in that
    // form as a remote-host separator (`\\\\?\\I`), so remove only the
    // Windows extended-length prefix before passing the local path to scp.
    let wide: Vec<u16> = local.as_os_str().encode_wide().collect();
    const EXTENDED_PREFIX: [u16; 4] = [b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
    if !wide.starts_with(&EXTENDED_PREFIX) {
        return local.to_path_buf();
    }

    let rest = &wide[EXTENDED_PREFIX.len()..];
    let is_drive_path = rest.len() >= 2
        && rest[1] == b':' as u16
        && ((b'A' as u16..=b'Z' as u16).contains(&rest[0])
            || (b'a' as u16..=b'z' as u16).contains(&rest[0]));
    if is_drive_path {
        return PathBuf::from(OsString::from_wide(rest));
    }

    const UNC_PREFIX: [u16; 4] = [b'U' as u16, b'N' as u16, b'C' as u16, b'\\' as u16];
    if rest.starts_with(&UNC_PREFIX) {
        let mut normalized = vec![b'\\' as u16, b'\\' as u16];
        normalized.extend_from_slice(&rest[UNC_PREFIX.len()..]);
        return PathBuf::from(OsString::from_wide(&normalized));
    }

    local.to_path_buf()
}

#[cfg(not(windows))]
fn scp_local_path(local: &Path) -> PathBuf {
    local.to_path_buf()
}

fn scp_args(profile: &Profile) -> io::Result<Vec<String>> {
    // Keep scp's diagnostics available to the caller. `-q` also suppresses
    // useful authentication/SFTP errors, which made Windows failures appear
    // as the unhelpful generic "SCP 传输失败" message.
    let mut args = vec![
        "-o".to_string(),
        "LogLevel=ERROR".to_string(),
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=yes".to_string(),
        "-o".to_string(),
        "ConnectTimeout=6".to_string(),
    ];
    if let Some(key) = profile.key_file()? {
        args.extend([
            "-i".to_string(),
            key,
            "-o".to_string(),
            "IdentitiesOnly=yes".to_string(),
        ]);
    }
    args.extend(["-P".to_string(), profile.ssh_port().to_string()]);
    Ok(args)
}

fn wait_for_process(mut child: Child, timeout: Duration) -> io::Result<()> {
    let mut stderr = child.stderr.take().map(|stderr| {
        thread::spawn(move || {
            let mut bytes = Vec::new();
            // Keep the diagnostic bounded, while still reading in a separate
            // thread so a full Windows pipe cannot deadlock scp.
            let _ = stderr.take(64 * 1024).read_to_end(&mut bytes);
            bytes
        })
    });
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            let diagnostic = stderr
                .take()
                .and_then(|reader| reader.join().ok())
                .unwrap_or_default();
            return if status.success() {
                Ok(())
            } else {
                Err(io::Error::other(scp_failure_hint(
                    status.code(),
                    &diagnostic,
                )))
            };
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            if let Some(reader) = stderr.take() {
                let _ = reader.join();
            }
            return Err(io::Error::new(io::ErrorKind::TimedOut, "SCP 传输超时"));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn scp_failure_hint(code: Option<i32>, stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let lower = text.to_ascii_lowercase();
    let hint = if lower.contains("host key verification failed")
        || lower.contains("remote host identification has changed")
    {
        "SCP 主机指纹尚未信任或发生变化：请先在终端用同一 Windows 用户连接 SSH，并核对指纹。"
    } else if lower.contains("permission denied")
        || lower.contains("sign_and_send_pubkey")
        || lower.contains("authentication agent")
    {
        "SCP 认证失败：请检查私钥路径、ssh-agent 和远端用户权限。"
    } else if lower.contains("could not resolve") {
        "SCP 主机名无法解析：请检查主机地址和 DNS。"
    } else if lower.contains("connection refused")
        || lower.contains("timed out")
        || lower.contains("no route to host")
    {
        "SCP 网络连接失败：请检查主机、端口、远端 SSH 服务和防火墙。"
    } else if lower.contains("subsystem request failed")
        || lower.contains("sftp") && lower.contains("failed")
    {
        "远端 SFTP 子系统不可用：请检查远端 sshd 的 SFTP 配置。"
    } else if lower.contains("no such file or directory") || lower.contains("stat local") {
        "Windows 本地文件路径无效或已不存在，请重新复制文件后重试。"
    } else {
        "SCP 传输失败，请检查 Windows 的 OpenSSH Client 和远端 SSH 配置。"
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
    let exit = code.map(|value| format!("退出码 {value}"));
    match (detail, exit) {
        (Some(detail), Some(exit)) => format!("{hint} {detail}（{exit}）"),
        (Some(detail), None) => format!("{hint} {detail}"),
        (None, Some(exit)) => format!("{hint}（{exit}）"),
        (None, None) => hint.to_string(),
    }
}

fn scp_clipboard_file(profile: &Profile, local: &Path, remote: &str) -> io::Result<()> {
    let target = format!("{}@{}:{remote}", profile.ssh_user(), profile.ssh_host());
    let child = hidden_command("scp")
        .args(scp_args(profile)?)
        .arg(scp_local_path(local))
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    "Windows 未找到 scp.exe，请安装或启用 OpenSSH Client",
                )
            } else {
                error
            }
        })?;
    wait_for_process(child, Duration::from_secs(120))
}

fn cleanup_remote_file(profile: &Profile, remote: &str) {
    let _ = run_ssh(
        profile,
        &format!("rm -f -- {}", shell_quote(remote)),
        Duration::from_secs(5),
    );
}

fn cleanup_remote_files(profile: &Profile, paths: &[String]) {
    for path in paths {
        cleanup_remote_file(profile, path);
    }
}

fn move_clipboard_file(
    profile: &Profile,
    temporary: &str,
    name: &str,
    transfer_id: &str,
) -> io::Result<String> {
    let fallback = format!("{name} (PenguX11VNC-{transfer_id})");
    let command = format!(
        "set -eu; download_dir=$(xdg-user-dir DOWNLOAD 2>/dev/null || true); if [ -z \"$download_dir\" ]; then download_dir=\"$HOME/Downloads\"; fi; case \"$download_dir\" in /*) ;; *) exit 1 ;; esac; mkdir -p -- \"$download_dir\"; target=\"$download_dir\"/{name}; suffix=0; while :; do if [ \"$suffix\" -gt 0 ]; then target=\"$download_dir\"/{fallback}-$suffix; fi; if mv -n -- {temporary} \"$target\"; then if [ ! -e {temporary} ]; then break; fi; else exit 1; fi; suffix=$((suffix + 1)); done; printf '%s' \"$target\"",
        name = shell_quote(name),
        fallback = shell_quote(&fallback),
        temporary = shell_quote(temporary),
    );
    let path = run_ssh(profile, &command, Duration::from_secs(15))?;
    if path.is_empty() || !path.starts_with('/') {
        return Err(io::Error::other("远端 Downloads 路径无效"));
    }
    Ok(path)
}

fn set_remote_file_clipboard(profile: &Profile, paths: &[String]) -> io::Result<()> {
    let mut payload = paths
        .iter()
        .map(|path| percent_encode_file_uri(path))
        .collect::<Vec<_>>()
        .join("\r\n");
    payload.push_str("\r\n");
    let command = format!(
        "set -eu; export DISPLAY={display}; export XAUTHORITY={auth}; export XDG_RUNTIME_DIR=\"${{XDG_RUNTIME_DIR:-$(dirname -- \"$XAUTHORITY\")}}\"; export WAYLAND_DISPLAY=\"${{WAYLAND_DISPLAY:-wayland-0}}\"; payload={payload}; if command -v xclip >/dev/null 2>&1 && printf '%s' \"$payload\" | xclip -selection clipboard -t text/uri-list -i; then if command -v python3 >/dev/null 2>&1; then nohup python3 -c {helper} \"$payload\" >/dev/null 2>&1 </dev/null & helper_pid=$!; sleep 0.2; if kill -0 \"$helper_pid\" 2>/dev/null; then exit 0; fi; fi; exit 0; fi; if command -v wl-copy >/dev/null 2>&1 && printf '%s' \"$payload\" | wl-copy --type text/uri-list; then if command -v python3 >/dev/null 2>&1; then nohup python3 -c {helper} \"$payload\" >/dev/null 2>&1 </dev/null & helper_pid=$!; sleep 0.2; if kill -0 \"$helper_pid\" 2>/dev/null; then exit 0; fi; fi; exit 0; fi; if command -v python3 >/dev/null 2>&1; then nohup python3 -c {helper} \"$payload\" >/dev/null 2>&1 </dev/null & helper_pid=$!; sleep 0.2; if kill -0 \"$helper_pid\" 2>/dev/null; then exit 0; fi; fi; exit 127",
        display = shell_quote(&profile.display()),
        auth = shell_quote(&profile.xauthority()),
        payload = shell_quote(&payload),
        helper = shell_quote(FILE_CLIPBOARD_X11_PYTHON),
    );
    run_ssh(profile, &command, Duration::from_secs(20)).map(|_| ())
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

    pub fn upload_clipboard_files(&self, paths: Vec<PathBuf>) -> io::Result<ClipboardUploadResult> {
        let profile = self
            .state
            .lock()
            .map_err(|_| io::Error::other("manager locked"))?
            .profile
            .clone();
        upload_clipboard_files(&profile, paths)
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

fn config_path_for_read() -> PathBuf {
    if let Ok(path) = std::env::var("PENGUX11VNC_CONFIG") {
        return PathBuf::from(path);
    }
    if let Ok(path) = std::env::var("QQ_VIEWER_CONFIG") {
        return PathBuf::from(path);
    }
    let current = home_path(DEFAULT_CONFIG);
    if current.exists() {
        current
    } else {
        home_path(LEGACY_CONFIG)
    }
}

pub fn load_profile() -> io::Result<Profile> {
    let config_path = config_path_for_read();
    let selected = std::env::var("PENGUX11VNC_PROFILE")
        .or_else(|_| std::env::var("QQ_VIEWER_PROFILE"))
        .ok();
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
        "{}env DISPLAY={} XAUTHORITY={} {} {} {}",
        if debug_enabled() {
            "PENGUX11VNC_DEBUG_WINDOWS=1 "
        } else {
            ""
        },
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
            || window.width < profile.min_width()
            || window.height < profile.min_height()
        {
            continue;
        }
        windows.push(window);
    }
    Ok(windows)
}

fn spawn_video_session(profile: &Profile, options: &Value) -> io::Result<VideoSession> {
    let mut args = ssh_args(profile, None, false)?;
    args.push(onboarding::probe_command("video", options));
    let mut child = hidden_command("ssh")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(io::Error::other("远端视频输入通道不可用"));
    };
    if let Err(error) = stdin.write_all(&onboarding::probe_stdin()) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(io::Error::other("远端视频输出通道不可用"));
    };
    let (sender, messages) = mpsc::channel();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    Ok(VideoSession {
        child,
        stdin,
        messages,
    })
}

fn write_video_command(stdin: &mut ChildStdin, command: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *stdin, command).map_err(io::Error::other)?;
    stdin.write_all(b"\n")?;
    stdin.flush()
}

fn stop_video_session(mut session: VideoSession) {
    let _ = write_video_command(&mut session.stdin, &json!({"action": "stop"}));
    let _ = session.child.kill();
    let _ = session.child.wait();
}

fn kill_remote_vnc_process(profile: &Profile, remote_pid: u32) {
    let command = format!(
        "if [ -r /proc/{remote_pid}/comm ] && [ \"$(tr -d '\\0' </proc/{remote_pid}/comm 2>/dev/null)\" = x11vnc ]; then kill -TERM {remote_pid} 2>/dev/null || true; sleep 0.2; kill -KILL {remote_pid} 2>/dev/null || true; fi"
    );
    let _ = run_ssh(profile, &command, Duration::from_secs(5));
}

fn stop_remote_vnc(profile: &Profile, remote_pid: u32, tunnel: &mut Child) {
    let _ = tunnel.kill();
    let _ = tunnel.wait();
    kill_remote_vnc_process(profile, remote_pid);
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
    run_ssh_inner(profile, command, None, timeout)
}

pub(super) fn run_ssh_with_stdin(
    profile: &Profile,
    command: &str,
    input: &[u8],
    timeout: Duration,
) -> io::Result<String> {
    run_ssh_inner(profile, command, Some(input), timeout)
}

fn run_ssh_inner(
    profile: &Profile,
    command: &str,
    input: Option<&[u8]>,
    timeout: Duration,
) -> io::Result<String> {
    let mut args = ssh_args(profile, None, false)?;
    args.push(command.to_string());
    let mut child = hidden_command("ssh")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .spawn()
        .map_err(|error| {
            if input.is_some() {
                io::Error::new(
                    error.kind(),
                    format!(
                        "启动 SSH 预检进程失败（远程命令 {} 字符）：{error}",
                        command.len()
                    ),
                )
            } else {
                error
            }
        })?;
    if let Some(input) = input {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("SSH stdin unavailable"))?;
        stdin.write_all(input)?;
    }
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
            if !diagnostic.is_empty() {
                debug_log(
                    "ssh-stderr",
                    String::from_utf8_lossy(&diagnostic).trim().to_string(),
                );
            }
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
        _ if method == "POST" && path.starts_with("/sessions/") && path.ends_with("/activate") => {
            let id = path
                .strip_prefix("/sessions/")
                .and_then(|value| value.strip_suffix("/activate"))
                .unwrap_or_default();
            state
                .lock()
                .map_err(|_| io::Error::other("manager locked"))
                .and_then(|mut manager| manager.activate(id))
        }
        _ if method == "POST" && path.starts_with("/video/") && path.ends_with("/offer") => {
            let id = path
                .strip_prefix("/video/")
                .and_then(|value| value.strip_suffix("/offer"))
                .unwrap_or_default();
            state
                .lock()
                .map_err(|_| io::Error::other("manager locked"))
                .and_then(|mut manager| manager.video_offer(id, body))
        }
        _ if method == "DELETE" && path.starts_with("/video/") => {
            let id = path.strip_prefix("/video/").unwrap_or_default();
            state
                .lock()
                .map_err(|_| io::Error::other("manager locked"))
                .map(|mut manager| {
                    manager.cleanup_video(id);
                    json!({"ok": true})
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

#[cfg(test)]
mod clipboard_tests {
    use super::*;

    #[test]
    fn file_uri_encodes_non_uri_path_bytes() {
        assert_eq!(
            percent_encode_file_uri("/home/user/报告 1#.txt"),
            "file:///home/user/%E6%8A%A5%E5%91%8A%201%23.txt"
        );
    }

    #[test]
    fn x11_helper_advertises_common_file_clipboard_targets() {
        for target in [
            "text/uri-list",
            "x-special/gnome-copied-files",
            "application/x-kde4-urilist",
            "application/x-kde5-urilist",
            "application/x-kde-cutselection",
        ] {
            assert!(
                FILE_CLIPBOARD_X11_PYTHON.contains(target),
                "missing X11 clipboard target: {target}"
            );
        }
        assert!(FILE_CLIPBOARD_X11_PYTHON.contains("gnome_payload = b\"copy\\n\""));
        assert!(FILE_CLIPBOARD_X11_PYTHON.contains("kde_cut_payload = b\"0\""));
        assert!(FILE_CLIPBOARD_X11_PYTHON.contains("class SelectionNotify(C.Structure)"));
        assert!(FILE_CLIPBOARD_X11_PYTHON.contains("response.notify.property = property_atom"));
        for text_target in ["text/plain", "UTF8_STRING", "TEXT", "STRING"] {
            assert!(
                !FILE_CLIPBOARD_X11_PYTHON.contains(text_target),
                "file clipboard must not advertise text target: {text_target}"
            );
        }
    }

    #[test]
    fn scp_failure_hint_exposes_actionable_diagnostics() {
        let message = scp_failure_hint(Some(255), b"Permission denied (publickey).\\r\\n");
        assert!(message.contains("SCP 认证失败"));
        assert!(message.contains("Permission denied (publickey)."));
        assert!(message.contains("退出码 255"));
    }

    #[cfg(windows)]
    #[test]
    fn scp_local_path_normalizes_extended_windows_prefixes() {
        assert_eq!(
            scp_local_path(Path::new(r"\\?\I:\directory\file.txt")),
            PathBuf::from(r"I:\directory\file.txt")
        );
        assert_eq!(
            scp_local_path(Path::new(r"\\?\UNC\server\share\file.txt")),
            PathBuf::from(r"\\server\share\file.txt")
        );
    }

    #[test]
    fn clipboard_validation_accepts_files_and_rejects_directories() {
        let root =
            std::env::temp_dir().join(format!("pengux11vnc-clipboard-test-{}", std::process::id()));
        let file = root.join("sample.txt");
        fs::create_dir_all(&root).unwrap();
        fs::write(&file, b"sample").unwrap();
        let files = validate_clipboard_files(std::slice::from_ref(&file)).unwrap();
        assert_eq!(files[0].name, "sample.txt");
        assert_eq!(files[0].size, 6);
        let directory_error = validate_clipboard_files(std::slice::from_ref(&root)).unwrap_err();
        assert_eq!(directory_error.kind(), io::ErrorKind::InvalidInput);
        let oversized = root.join("oversized.bin");
        let oversized_file = fs::File::create(&oversized).unwrap();
        oversized_file.set_len(CLIPBOARD_FILE_LIMIT + 1).unwrap();
        let size_error = validate_clipboard_files(std::slice::from_ref(&oversized)).unwrap_err();
        assert_eq!(size_error.kind(), io::ErrorKind::InvalidInput);
        fs::remove_dir_all(root).unwrap();
    }
}
