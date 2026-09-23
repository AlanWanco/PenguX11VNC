//! Guided connection state. All remote writes are behind explicit serve consent.
use super::*;
use std::fs::OpenOptions;

pub(super) const PROBE: &str = include_str!("../../tools/remote-session.py");

pub(super) struct Onboarding {
    pub configured: bool,
    pub startup_error: Option<String>,
    pending: Option<(Profile, Value)>,
    live: Option<LiveMain>,
    generation: u64,
}

struct LiveMain {
    remote: Option<Child>,
    tunnel: Option<Child>,
    target: Value,
    port: u16,
}

impl Drop for LiveMain {
    fn drop(&mut self) {
        if let Some(mut tunnel) = self.tunnel.take() {
            let _ = tunnel.kill();
            let _ = tunnel.wait();
        }
        if let Some(mut remote) = self.remote.take() {
            // EOF on SSH stdin tells our supervisor to terminate ONLY its child.
            remote.stdin.take();
            let deadline = Instant::now() + Duration::from_secs(4);
            while Instant::now() < deadline {
                if remote.try_wait().ok().flatten().is_some() {
                    return;
                }
                thread::sleep(Duration::from_millis(50));
            }
            let _ = remote.kill();
            let _ = remote.wait();
        }
    }
}

impl Onboarding {
    pub fn new(configured: bool, startup_error: Option<String>) -> Self {
        Self {
            configured,
            startup_error,
            pending: None,
            live: None,
            generation: 0,
        }
    }
    pub fn stop(&mut self) {
        self.live.take();
    }

    pub(super) fn activate_main(&mut self) -> io::Result<bool> {
        let Some(live) = self.live.as_mut() else {
            return Ok(false);
        };
        let Some(remote) = live.remote.as_mut() else {
            return Err(io::Error::other("远端 QQ 管理通道不可用"));
        };
        let Some(stdin) = remote.stdin.as_mut() else {
            return Err(io::Error::other("远端 QQ 管理通道已关闭"));
        };
        stdin.write_all(b"{\"action\":\"activate\"}\n")?;
        stdin.flush()?;
        Ok(true)
    }
}

fn config_path() -> PathBuf {
    std::env::var("PENGUX11VNC_CONFIG")
        .or_else(|_| std::env::var("QQ_VIEWER_CONFIG"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| home_path(DEFAULT_CONFIG))
}

fn uses_default_config_path() -> bool {
    std::env::var_os("PENGUX11VNC_CONFIG").is_none()
        && std::env::var_os("QQ_VIEWER_CONFIG").is_none()
}

pub(super) fn empty_profile() -> Profile {
    Profile {
        id: "linux-qq".into(),
        raw: json!({"name": "新连接", "children": {"enabled": false}}),
    }
}

fn write_config(profile: &Profile) -> io::Result<()> {
    let path = config_path();
    if uses_default_config_path() && !path.exists() {
        let legacy = home_path(LEGACY_CONFIG);
        if legacy.exists() {
            let parent = path
                .parent()
                .ok_or_else(|| io::Error::other("配置目录无效"))?;
            fs::create_dir_all(parent)?;
            fs::copy(&legacy, &path)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
            }
        }
    }
    write_config_to(profile, &path)
}

fn write_config_to(profile: &Profile, path: &std::path::Path) -> io::Result<()> {
    let mut document: Value = if path.exists() {
        serde_json::from_slice(&fs::read(path)?)?
    } else {
        json!({"version": 1, "connections": {}})
    };
    if !document["connections"].is_object() {
        return Err(io::Error::other(
            "配置格式无效；请先修复原配置，向导不会覆盖它",
        ));
    }
    document["connections"][&profile.id] = profile.raw.clone();
    document["defaultConnection"] = json!(profile.id);
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("配置目录无效"))?;
    fs::create_dir_all(parent)?;
    let suffix = random_token();
    let _backup = if path.exists() {
        let backup = path.with_extension(format!("json.backup-{}", &suffix[..12]));
        fs::copy(path, &backup)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&backup, fs::Permissions::from_mode(0o600))?;
        }
        Some(backup)
    } else {
        None
    };
    let temp = path.with_extension(format!("tmp-{}", &suffix[..12]));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp)?;
    file.write_all(&serde_json::to_vec_pretty(&document)?)?;
    file.sync_all()?;
    // Unix rename replaces an existing file; Windows requires removing the
    // destination first. The backup above gives us a recovery copy if the
    // replacement fails.
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path)?;
    }
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        #[cfg(windows)]
        if !path.exists() {
            if let Some(backup) = _backup.as_ref() {
                let _ = fs::copy(backup, path);
            }
        }
        return Err(error);
    }
    Ok(())
}

pub(super) fn probe_command(action: &str, options: &Value) -> String {
    // Keep the SSH/Windows command line short. Embedding PROBE (currently >31 KB)
    // with `python3 -c` can exceed CreateProcessW's command-line limit (error 206).
    let bootstrap = r#"import sys; f=sys.stdin.buffer; n=int(f.readline()); exec(compile(f.read(n), "<pengux11vnc-remote-session>", "exec"))"#;
    format!(
        "{}python3 -c {} {} {}",
        if super::debug_enabled() {
            "PENGUX11VNC_DEBUG_WINDOWS=1 "
        } else {
            ""
        },
        shell_quote(bootstrap),
        shell_quote(action),
        shell_quote(&options.to_string())
    )
}

pub(super) fn probe_stdin() -> Vec<u8> {
    let mut input = format!("{}\n", PROBE.len()).into_bytes();
    input.extend_from_slice(PROBE.as_bytes());
    input
}

pub(super) fn activate_remote(profile: &Profile, target: &Value) -> io::Result<Value> {
    let output = run_ssh_with_stdin(
        profile,
        &probe_command("activate", &json!({"target": target})),
        &probe_stdin(),
        Duration::from_secs(7),
    )?;
    serde_json::from_str(&output).map_err(|_| io::Error::other("远端窗口激活响应无效"))
}

fn probe(profile: &Profile) -> io::Result<Value> {
    let output = run_ssh_with_stdin(
        profile,
        &probe_command(
            "probe",
            &json!({
                "passwordFile": profile.get("vnc", "remotePasswordFile").and_then(Value::as_str).unwrap_or("")
            }),
        ),
        &probe_stdin(),
        Duration::from_secs(15),
    )?;
    let report: Value = serde_json::from_str(&output)
        .map_err(|_| io::Error::other("预检响应无效；需要远端 Python 3 和 libX11"))?;
    if !report["windows"].is_array() || report["error"].is_string() {
        return Err(io::Error::other(
            "远端预检失败；确认 Python 3、libX11 和当前用户图形会话可用",
        ));
    }
    Ok(report)
}

fn main_candidates(report: &Value) -> Vec<Value> {
    if report["windowScanComplete"] == false {
        return Vec::new();
    }
    report["windows"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|w| w["mapped"] != false && w["normal"] == true && w["transient"] == false)
        .cloned()
        .collect()
}

fn public_report(report: &Value) -> Value {
    let windows: Vec<Value> = main_candidates(report)
        .iter()
        .enumerate()
        .map(|(index, item)| {
            json!({
                "key": index.to_string(), "id": item["id"], "display": item["display"],
                "width": item["width"], "height": item["height"]
            })
        })
        .collect();
    json!({"running": report["running"], "displayAccessible": report["displayAccessible"],
        "x11vnc": report["x11vnc"], "passwordReady": report["passwordReady"],
        "passwordFile": report["passwordFile"], "imeReady": report["imeReady"], "windows": windows})
}

fn same_identity(a: &Value, b: &Value) -> bool {
    ["id", "pid", "start", "exe", "display", "xauthority"]
        .iter()
        .all(|key| a[key] == b[key])
}

// Do not use dimensions or a guessed "largest window" to select capture targets.
fn choose_target(
    report: &Value,
    previous: Option<&Value>,
    preferred: Option<&str>,
) -> Option<Value> {
    let windows = main_candidates(report);
    if let Some(old) = previous {
        if let Some(same) = windows.iter().find(|w| same_identity(old, w)) {
            return Some(same.clone());
        }
        // A hidden main window is NOT a restarted QQ. Never switch to another
        // chat window while the original process is still alive.
        if report["processes"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|p| p["pid"] == old["pid"] && p["start"] == old["start"])
        {
            return None;
        }
        // Automatic recovery is restricted to the same executable + class/instance.
        let matching: Vec<_> = windows
            .iter()
            .filter(|w| {
                ["exe", "className", "instance"]
                    .iter()
                    .all(|key| w[key] == old[key])
            })
            .collect();
        return if matching.len() == 1 {
            Some(matching[0].clone())
        } else {
            None
        };
    }
    if let Some(id) = preferred {
        if let Some(window) = windows.iter().find(|w| w["id"].as_str() == Some(id)) {
            return Some(window.clone());
        }
    }
    if windows.len() == 1 {
        Some(windows[0].clone())
    } else {
        None
    }
}

fn update_target(profile: &mut Profile, target: &Value, report: &Value) {
    profile.raw["window"] = json!({"id": target["id"], "display": target["display"],
        "xauthority": target["xauthority"], "className": "QQ"});
    profile.raw["helpers"] = report["helpers"].clone();
    profile.raw["vnc"]["remotePasswordFile"] = report["passwordFile"].clone();
}

fn spawn_main(profile: &Profile, target: &Value, report: &Value) -> io::Result<LiveMain> {
    let mut args = ssh_args(profile, None, false)?;
    args.push(probe_command(
        "serve",
        &json!({"target": target, "passwordFile": report["passwordFile"]}),
    ));
    let local_port = allocate_port()?;
    let mut remote = hidden_command("ssh")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    if let Some(stdin) = remote.stdin.as_mut() {
        if let Err(error) = stdin.write_all(&probe_stdin()).and_then(|()| stdin.flush()) {
            let _ = remote.kill();
            let _ = remote.wait();
            return Err(error);
        }
    } else {
        let _ = remote.kill();
        let _ = remote.wait();
        return Err(io::Error::other("远端预检脚本输入通道不可用"));
    }
    let stdout = remote
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("远端启动通道不可用"))?;
    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let mut line = String::new();
        let _ = BufReader::new(stdout).take(4096).read_line(&mut line);
        let _ = tx.send(line);
    });
    let mut live = LiveMain {
        remote: Some(remote),
        tunnel: None,
        target: target.clone(),
        port: local_port,
    };
    let line = rx
        .recv_timeout(Duration::from_secs(15))
        .map_err(|_| io::Error::other("远端 VNC 启动超时"))?;
    let response: Value =
        serde_json::from_str(&line).map_err(|_| io::Error::other("远端 VNC 启动失败"))?;
    let remote_port = response["port"]
        .as_u64()
        .and_then(|n| u16::try_from(n).ok())
        .filter(|n| *n >= 1024)
        .ok_or_else(|| io::Error::other("远端未确认单窗口 VNC 就绪"))?;
    live.tunnel = Some(
        hidden_command("ssh")
            .args(ssh_args(profile, Some((live.port, remote_port)), true)?)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?,
    );
    wait_for_rfb(live.port, Duration::from_secs(10))?;
    Ok(live)
}

impl ManagerState {
    pub(super) fn setup_status(&self) -> Value {
        json!({"available": true, "configured": self.onboarding.configured,
            "startupError": self.onboarding.startup_error, "profile": self.profile.normalized_json()})
    }

    pub(super) fn preflight(&mut self, body: Value) -> io::Result<Value> {
        self.onboarding.pending = None;
        let mut raw = self.profile.raw.clone();
        raw["ssh"] = body["ssh"].clone();
        raw["name"] = json!(body["name"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("Linux QQ"));
        raw["vnc"] = json!({"passwordFile": "", "remotePasswordFile": body["remotePasswordFile"].as_str().unwrap_or("")});
        for key in ["user", "host"] {
            if raw["ssh"][key]
                .as_str()
                .map_or(true, |s| s.is_empty() || s.starts_with('-'))
            {
                return Err(io::Error::other("请填写有效的 SSH 主机与用户名"));
            }
        }
        let port = raw["ssh"]["port"].as_u64().unwrap_or(0);
        if port == 0 || port > 65535 {
            return Err(io::Error::other("SSH 端口必须为 1～65535"));
        }
        validate_profile(&raw)?;
        let draft = Profile {
            id: self.profile.id.clone(),
            raw,
        };
        let report = probe(&draft)?;
        let public = public_report(&report);
        self.onboarding.pending = Some((draft, report));
        Ok(public)
    }

    pub(super) fn save_setup(&mut self, body: Value) -> io::Result<Value> {
        if body["consent"] != true {
            return Err(io::Error::other("请确认仅启动所选 QQ 的本机 VNC 服务"));
        }
        let (mut draft, report) = self
            .onboarding
            .pending
            .clone()
            .ok_or_else(|| io::Error::other("请先完成预检"))?;
        let index = body["windowKey"]
            .as_str()
            .and_then(|n| n.parse::<usize>().ok())
            .ok_or_else(|| io::Error::other("请选择 QQ 主窗口"))?;
        let target = main_candidates(&report)
            .get(index)
            .cloned()
            .ok_or_else(|| io::Error::other("窗口选择无效"))?;
        if report["passwordReady"] != true || report["x11vnc"] != true {
            return Err(io::Error::other(
                "请先按引导安装 x11vnc、创建私有 VNC 密码文件，然后重新预检",
            ));
        }
        // Re-probe so stale selections cannot authorize a reused XID.
        let fresh = probe(&draft)?;
        if !main_candidates(&fresh)
            .iter()
            .any(|w| same_identity(&target, w))
        {
            return Err(io::Error::other("窗口已经变化；请重新预检并选择"));
        }
        update_target(&mut draft, &target, &fresh);
        draft.raw["tunnel"]["remoteHost"] = json!("127.0.0.1");
        draft.raw["managed"] = json!({"enabled": true, "autoRecover": body["autoRecover"] == true,
                                      "target": target});
        // IME is optional. Window discovery also has a Python fallback.
        draft.raw["children"] = json!({"enabled": true, "minWidth": 80, "minHeight": 60});
        validate_profile(&draft.raw)?;
        write_config(&draft)?;
        self.cleanup_all();
        self.profile = draft;
        self.onboarding.configured = true;
        self.onboarding.startup_error = None;
        self.onboarding.pending = None;
        Ok(self.setup_status())
    }

    pub(super) fn prepare_main(&mut self, reconnect: bool) -> io::Result<Value> {
        if !self.onboarding.configured {
            return Err(io::Error::other("请先使用首次连接向导配置 SSH"));
        }
        if self.profile.raw["managed"]["enabled"] != true {
            if self.onboarding.live.is_none() {
                self.onboarding.live = Some(LiveMain {
                    remote: None,
                    tunnel: start_main_tunnel(&self.profile)?,
                    target: Value::Null,
                    port: self.profile.local_port(),
                });
            }
            return Ok(
                json!({"state": "ready", "generation": 0, "targetPort": self.profile.local_port(),
                "profile": self.profile.normalized_json(), "autoRecover": false}),
            );
        }
        let recover = self.profile.raw["managed"]["autoRecover"] == true;
        let report = probe(&self.profile)?;
        let previous = self
            .onboarding
            .live
            .as_ref()
            .map(|l| &l.target)
            .or_else(|| {
                self.profile
                    .raw
                    .get("managed")
                    .and_then(|v| v.get("target"))
            });
        let target = choose_target(&report, previous, Some(&self.profile.window_id()));
        let Some(target) = target else {
            self.cleanup_all();
            return Ok(
                json!({"state": if !main_candidates(&report).is_empty() { "choose-window" }
                else if report["running"] == true { "waiting-window" } else { "waiting-qq" }, "autoRecover": recover, "managed": true}),
            );
        };
        if let Some(live) = &mut self.onboarding.live {
            let alive = same_identity(&live.target, &target)
                && live
                    .remote
                    .as_mut()
                    .is_some_and(|c| c.try_wait().ok().flatten().is_none())
                && check_rfb(live.port);
            if alive {
                return Ok(
                    json!({"state": "ready", "generation": self.onboarding.generation,
                    "targetPort": live.port, "profile": self.profile.normalized_json(), "autoRecover": recover, "managed": true}),
                );
            }
        }
        self.cleanup_all();
        if reconnect && !recover {
            return Ok(json!({"state": "disconnected", "autoRecover": false, "managed": true}));
        }
        update_target(&mut self.profile, &target, &report);
        self.profile.raw["managed"]["target"] = target.clone();
        let live = spawn_main(&self.profile, &target, &report)?;
        self.onboarding.generation += 1;
        let result = json!({"state": "ready", "generation": self.onboarding.generation,
            "targetPort": live.port, "profile": self.profile.normalized_json(), "autoRecover": recover, "managed": true});
        self.onboarding.live = Some(live);
        Ok(result)
    }
}

pub(super) fn fallback_windows(profile: &Profile) -> io::Result<Vec<WindowInfo>> {
    let report = probe(profile)?;
    report["windows"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|w| {
            w["display"].as_str() == Some(&profile.display())
                && w["id"].as_str() != Some(&profile.window_id())
        })
        .map(|w| {
            Ok(WindowInfo {
                id: w["id"].as_str().unwrap_or_default().to_owned(),
                mapped: w["mapped"] != false,
                depth: 1,
                x: 0,
                y: 0,
                width: w["width"].as_u64().unwrap_or(0) as u32,
                height: w["height"].as_u64().unwrap_or(0) as u32,
                pid: w["pid"].as_u64(),
                start: w["start"].as_str().map(ToOwned::to_owned),
                exe: w["exe"].as_str().map(ToOwned::to_owned),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn window(id: &str, pid: u64) -> Value {
        json!({"id": id, "pid": pid, "start": pid.to_string(), "exe": "/opt/QQ/qq",
               "className": "QQ", "instance": "qq", "display": ":0", "xauthority": "/tmp/test-auth",
               "normal": true, "transient": false})
    }
    #[test]
    fn remote_probe_script_is_not_embedded_in_the_windows_command_line() {
        let command = probe_command(
            "probe",
            &json!({"passwordFile": "/run/user/1000/x11vnc.pass"}),
        );
        assert!(command.len() < 1024);
        assert!(!command.contains(PROBE));
        let input = probe_stdin();
        let header = format!("{}\n", PROBE.len());
        assert!(input.starts_with(header.as_bytes()));
        assert_eq!(&input[header.len()..], PROBE.as_bytes());
    }

    #[test]
    fn recovery_never_guesses_largest_window() {
        let old = window("0x10", 10);
        let new = window("0x20", 20);
        assert_eq!(
            choose_target(&json!({"windows": [new.clone()]}), Some(&old), None),
            Some(new.clone())
        );
        assert!(choose_target(
            &json!({"windows": [new.clone(), window("0x30", 20)]}),
            Some(&old),
            None
        )
        .is_none());
        assert!(choose_target(&json!({"windows": []}), Some(&old), None).is_none());
        let mut dialog = new.clone();
        dialog["transient"] = json!(true);
        assert!(choose_target(&json!({"windows": [dialog]}), Some(&old), None).is_none());
        assert!(!same_identity(&old, &window("0x10", 20)));
    }
    #[test]
    fn hidden_main_is_not_replaced_by_another_chat() {
        let old = window("0x10", 10);
        let report =
            json!({"windows": [window("0x20", 10)], "processes": [{"pid": 10, "start": "10"}]});
        assert!(choose_target(&report, Some(&old), None).is_none());
    }

    #[test]
    fn config_save_backs_up_and_preserves_other_profiles() {
        let dir = std::env::temp_dir().join(format!("pengux-config-test-{}", random_token()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("connections.json");
        let original = br#"{"version":1,"connections":{"other":{"name":"keep"}},"extra":true}"#;
        fs::write(&path, original).unwrap();
        let profile = Profile {
            id: "new".into(),
            raw: json!({"name": "test"}),
        };
        write_config_to(&profile, &path).unwrap();
        let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["connections"]["other"]["name"], "keep");
        assert_eq!(saved["extra"], true);
        let backups: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("backup"))
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read(backups[0].path()).unwrap(), original);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(backups[0].path())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        fs::write(&path, "broken").unwrap();
        assert!(write_config_to(&profile, &path).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "broken");
        fs::remove_dir_all(dir).unwrap();
    }
}
