mod manager;

use manager::{hidden_command, startup_profile, ManagerRuntime, Profile};
use serde_json::json;
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
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use url::Url;

struct RuntimeState {
    manager: Mutex<Option<ManagerRuntime>>,
    node: Mutex<Option<Child>>,
    stopped: AtomicBool,
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
                .min_inner_size(640.0, 480.0)
                .resizable(true)
                .visible(true)
                .build()
            {
                if let Some(state) = app.try_state::<RuntimeState>() {
                    state.stop();
                }
                return Err(error.into());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let closing = matches!(
                event,
                WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
            );
            if !closing {
                return;
            }
            if window.label() == "main" {
                if let Some(state) = window.app_handle().try_state::<RuntimeState>() {
                    state.stop();
                }
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
        .run(tauri::generate_context!())
        .expect("error while running PenguX11VNC");
}
