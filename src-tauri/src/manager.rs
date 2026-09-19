use rand::random;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
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
        if value.is_empty() {
            return Ok(None);
        }
        let expanded = expand_home(value);
        if !expanded.starts_with('/') || expanded.contains('\0') {
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
        if value.is_empty() {
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
}

impl ManagerState {
    fn new(profile: Profile) -> Self {
        Self {
            profile,
            children: HashMap::new(),
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
        let mut tunnel = Command::new("ssh")
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
            let _ = child.tunnel.kill();
            let _ = child.tunnel.wait();
            let _ = run_ssh(
                &self.profile,
                &format!("kill {}", child.remote_pid),
                Duration::from_secs(5),
            );
        }
    }

    fn cleanup_all(&mut self) {
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
    pub fn start(profile: Profile) -> io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let address = listener.local_addr()?;
        let token = random_token();
        let state = Arc::new(Mutex::new(ManagerState::new(profile)));
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
        if selected.is_some() || config_path != home_path(DEFAULT_CONFIG) {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("找不到配置文件：{}", config_path.display()),
            ));
        }
        return Ok(Profile {
            id: "linux-qq".to_string(),
            raw: legacy_profile(),
        });
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
    let mut child = Command::new("ssh")
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
    let mut child = Command::new("ssh")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()?;
    let deadline = Instant::now() + timeout;
    loop {
        if child.try_wait()?.is_some() {
            let output = child.wait_with_output()?;
            if output.status.success() {
                return Ok(String::from_utf8_lossy(&output.stdout).to_string());
            }
            return Err(io::Error::other(format!(
                "SSH 远端命令失败：{}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(io::ErrorKind::TimedOut, "SSH 远端命令超时"));
        }
        thread::sleep(Duration::from_millis(30));
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
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(value)
}

fn validate_profile(raw: &Value) -> io::Result<()> {
    let profile = Profile {
        id: "validation".to_string(),
        raw: raw.clone(),
    };
    let user = profile.ssh_user();
    if user.is_empty()
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
        if value.is_empty()
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
        profile.remote_password_file(),
    ] {
        if !value.starts_with('/')
            || !value
                .chars()
                .all(|char| char.is_ascii_alphanumeric() || "/_.:-".contains(char))
        {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "远端路径无效"));
        }
    }
    if !valid_window_id(&profile.window_id()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "X11 窗口 ID 无效",
        ));
    }
    if !profile.display().starts_with(':')
        || !profile.display()[1..]
            .chars()
            .all(|char| char.is_ascii_digit())
    {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "DISPLAY 无效"));
    }
    let _ = profile.key_file()?;
    Ok(())
}

fn legacy_profile() -> Value {
    json!({
        "name": "Remote QQ",
        "ssh": {"user": "remote-user", "host": "remote.example", "port": 22, "privateKeyFile": ""},
        "tunnel": {"localPort": 15900, "remoteHost": "127.0.0.1", "remotePort": 5900},
        "vnc": {"passwordFile": "", "remotePasswordFile": "/run/user/1000/x11vnc.pass"},
        "window": {"display": ":0", "xauthority": "/run/user/1000/xauth", "id": "0x1", "className": "QQ"},
        "helpers": {"windowList": "/home/remote-user/.local/lib/qq-window-viewer/list-qq-windows", "imeCapture": "/home/remote-user/.local/lib/qq-window-viewer/capture-ime"},
        "children": {"enabled": true, "autoOpen": true, "minWidth": 80, "minHeight": 60},
        "clipboard": {"sync": false}
    })
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
    let child = Command::new("ssh")
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
    let Ok((method, path, supplied_token)) = read_request(&mut stream) else {
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
        ("GET", "/status") => Ok(json!({"ok": true})),
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

fn read_request(stream: &mut TcpStream) -> io::Result<(String, String, Option<String>)> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut data = Vec::new();
    let mut chunk = [0_u8; 1024];
    loop {
        let count = stream.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        data.extend_from_slice(&chunk[..count]);
        if data.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if data.len() > 16 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request too large",
            ));
        }
    }
    let text = String::from_utf8_lossy(&data);
    let mut lines = text.split("\r\n");
    let request = lines
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing request"))?;
    let mut parts = request.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let token = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("x-pengux11vnc-token"))
        .map(|(_, value)| value.trim().to_string());
    Ok((method, path, token))
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
