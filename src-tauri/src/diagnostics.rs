//! Bounded lifecycle diagnostics. Never record commands or raw child stderr.
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, ExitStatus, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const LOG_LIMIT: u64 = 2 * 1024 * 1024;
const RECORD_LIMIT: usize = 8192;
const STDERR_LINE_LIMIT: usize = 2048;
const STDERR_RECORD_LIMIT: usize = 64;
static LOG_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn enabled() -> bool {
    std::env::var("PENGUX11VNC_DEBUG").as_deref() == Ok("1")
}

pub(crate) fn stderr_stream() -> Stdio {
    if enabled() {
        Stdio::piped()
    } else {
        Stdio::null()
    }
}

pub(crate) fn log(event: &str, details: Value) {
    if !enabled() {
        return;
    }
    let description = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
    );
    let at = time::OffsetDateTime::now_utc()
        .format(description)
        .unwrap_or_default();
    let mut payload = details.to_string();
    if payload.len() > RECORD_LIMIT {
        payload = json!({"truncated": true, "originalBytes": payload.len()}).to_string();
    }
    let line = format!("[PenguX11VNC debug] {at} {event} {payload}\n");
    let Ok(_guard) = LOG_LOCK.lock() else { return };
    let _ = io::stderr().write_all(line.as_bytes());
    if let Some(path) = std::env::var_os("PENGUX11VNC_DEBUG_LOG") {
        let _ = append_bounded(Path::new(&path), line.as_bytes(), LOG_LIMIT);
    }
}

fn append_bounded(path: &Path, line: &[u8], limit: u64) -> io::Result<()> {
    if fs::metadata(path).is_ok_and(|metadata| metadata.len() + line.len() as u64 > limit) {
        let mut backup = path.as_os_str().to_os_string();
        backup.push(".1");
        let backup = Path::new(&backup);
        if backup.exists() {
            fs::remove_file(backup)?;
        }
        fs::rename(path, backup)?;
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(line)
}

const REMOTE_EVENTS: &[&str] = &[
    "vnc-spawn",
    "vnc-ready",
    "vnc-stderr",
    "vnc-stop",
    "vnc-exit",
];
const REASONS: &[&str] = &[
    "owner-eof",
    "vnc-stdout-eof",
    "vnc-exited",
    "startup-timeout",
    "invalid-port",
    "signal-term",
    "signal-hup",
    "signal-int",
    "supervisor-error",
];
const CATEGORIES: &[&str] = &[
    "x11-error",
    "xio-fatal",
    "signal",
    "connection-reset",
    "broken-pipe",
    "connection-refused",
    "connection-timeout",
    "connection-closed",
    "channel-open-failed",
    "forward-listen-failed",
    "host-key-failed",
    "permission-denied",
    "hostname-resolution",
    "display-unavailable",
    "bind-failed",
    "fatal-error",
];
const X_ERRORS: &[&str] = &[
    "BadAccess",
    "BadAlloc",
    "BadAtom",
    "BadCursor",
    "BadDrawable",
    "BadFont",
    "BadGC",
    "BadIDChoice",
    "BadImplementation",
    "BadLength",
    "BadMatch",
    "BadName",
    "BadPixmap",
    "BadRequest",
    "BadValue",
    "BadWindow",
];

fn normalized_stderr(line: &[u8]) -> Option<Value> {
    let text = String::from_utf8_lossy(line);
    if let Some(payload) = text.strip_prefix("[PenguX11VNC lifecycle] ") {
        let remote: Value = serde_json::from_str(payload).ok()?;
        let event = remote["event"]
            .as_str()
            .filter(|value| REMOTE_EVENTS.contains(value))?;
        let mut safe = json!({"event": event});
        if let Some(at) = remote["at"].as_str().filter(|value| {
            value.len() == 24
                && value.ends_with('Z')
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || b"-:.TZ".contains(&byte))
        }) {
            safe["at"] = json!(at);
        }
        for field in [
            "pid",
            "port",
            "returncode",
            "signal",
            "errno",
            "majorOpcode",
            "minorOpcode",
            "resourceId",
            "stderrBytes",
            "stderrErrors",
        ] {
            if let Some(value) = remote[field].as_i64() {
                safe[field] = json!(value);
            }
        }
        for field in ["ready", "terminateSent", "forced"] {
            if let Some(value) = remote[field].as_bool() {
                safe[field] = json!(value);
            }
        }
        for (field, allowed) in [
            ("reason", REASONS),
            ("category", CATEGORIES),
            ("xError", X_ERRORS),
        ] {
            if let Some(value) = remote[field]
                .as_str()
                .filter(|value| allowed.contains(value))
            {
                safe[field] = json!(value);
            }
        }
        let last_error = &remote["lastError"];
        if let Some(category) = last_error["category"]
            .as_str()
            .filter(|value| CATEGORIES.contains(value))
        {
            let mut error = json!({"category": category});
            for field in [
                "errno",
                "signal",
                "majorOpcode",
                "minorOpcode",
                "resourceId",
            ] {
                if let Some(value) = last_error[field].as_i64() {
                    error[field] = json!(value);
                }
            }
            if let Some(name) = last_error["xError"]
                .as_str()
                .filter(|value| X_ERRORS.contains(value))
            {
                error["xError"] = json!(name);
            }
            safe["lastError"] = error;
        }
        return Some(json!({"remote": safe}));
    }
    let lower = text.to_ascii_lowercase();
    if let Some(x_error) = X_ERRORS.iter().find(|name| text.contains(**name)) {
        return Some(json!({"category": "x11-error", "xError": x_error}));
    }
    if lower.contains("xio:") {
        return Some(json!({"category": "xio-fatal"}));
    }
    let category = [
        ("connection reset", "connection-reset"),
        ("econnreset", "connection-reset"),
        ("broken pipe", "broken-pipe"),
        ("connection refused", "connection-refused"),
        ("connection timed out", "connection-timeout"),
        ("connection closed", "connection-closed"),
        ("open failed", "channel-open-failed"),
        ("address already in use", "forward-listen-failed"),
        ("host key verification failed", "host-key-failed"),
        ("remote host identification has changed", "host-key-failed"),
        ("permission denied", "permission-denied"),
        ("could not resolve hostname", "hostname-resolution"),
    ]
    .into_iter()
    .find_map(|(pattern, category)| lower.contains(pattern).then_some(category))?;
    Some(json!({"category": category}))
}

fn read_stderr(mut reader: impl Read, mut emit: impl FnMut(Value)) -> io::Result<()> {
    let mut buffer = [0_u8; 4096];
    let mut line = Vec::with_capacity(STDERR_LINE_LIMIT);
    let mut bytes = 0_u64;
    let mut emitted = 0;
    let mut unknown = 0_u64;
    let mut critical_events = Vec::new();
    let mut process_line = |line: &[u8]| {
        if let Some(record) = normalized_stderr(line) {
            let event = record["remote"]["event"].as_str().unwrap_or("");
            let critical = ["vnc-spawn", "vnc-ready", "vnc-stop", "vnc-exit"].contains(&event);
            if critical {
                if critical_events.contains(&event.to_string()) {
                    return;
                }
                critical_events.push(event.to_string());
            } else if emitted >= STDERR_RECORD_LIMIT {
                unknown += 1;
                return;
            } else {
                emitted += 1;
            }
            emit(record);
        } else {
            unknown += 1;
        }
    };
    loop {
        let length = match reader.read(&mut buffer) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            other => other?,
        };
        if length == 0 {
            break;
        }
        bytes = bytes.saturating_add(length as u64);
        for &byte in &buffer[..length] {
            if byte == b'\n' {
                process_line(&line);
                line.clear();
            } else if line.len() < STDERR_LINE_LIMIT {
                line.push(byte);
            }
        }
    }
    if !line.is_empty() {
        process_line(&line);
    }
    if bytes > 0 {
        emit(json!({"stderrBytes": bytes, "unrecordedLines": unknown}));
    }
    Ok(())
}

#[derive(Clone)]
struct Identity {
    pid: u32,
    role: &'static str,
    requested: Arc<AtomicBool>,
    exit_reported: Arc<AtomicBool>,
}

fn report_exit(identity: &Identity, status: ExitStatus) {
    if identity.exit_reported.swap(true, Ordering::AcqRel) {
        return;
    }
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.signal()
    };
    #[cfg(not(unix))]
    let signal: Option<i32> = None;
    log(
        "ssh-exit",
        json!({
            "role": identity.role, "pid": identity.pid, "exitCode": status.code(), "signal": signal,
            "cleanupRequested": identity.requested.load(Ordering::Acquire),
        }),
    );
}

pub(crate) struct DiagnosticChild {
    child: Arc<Mutex<Child>>,
    pub(crate) stdin: Option<ChildStdin>,
    pub(crate) stdout: Option<ChildStdout>,
    identity: Identity,
    monitor_stop: Arc<AtomicBool>,
    monitor: Option<JoinHandle<()>>,
}

impl DiagnosticChild {
    pub(crate) fn new(child: Child, role: &'static str) -> Self {
        Self::with_monitor(child, role, enabled())
    }

    fn with_monitor(mut child: Child, role: &'static str, monitor_enabled: bool) -> Self {
        let identity = Identity {
            pid: child.id(),
            role,
            requested: Arc::new(AtomicBool::new(false)),
            exit_reported: Arc::new(AtomicBool::new(false)),
        };
        log("ssh-spawn", json!({"role": role, "pid": identity.pid}));
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        if let Some(stderr) = child.stderr.take() {
            let info = identity.clone();
            // Keep draining after the log budget is exhausted. Never join this
            // blocking pipe reader on the UI/cleanup path.
            thread::spawn(move || {
                let result = read_stderr(stderr, |record| {
                    log(
                        "ssh-stderr",
                        json!({"role": info.role, "pid": info.pid, "diagnostic": record}),
                    );
                });
                log(
                    "ssh-stderr-eof",
                    json!({"role": info.role, "pid": info.pid, "readOk": result.is_ok()}),
                );
            });
        }
        let child = Arc::new(Mutex::new(child));
        let monitor_stop = Arc::new(AtomicBool::new(false));
        let monitor = monitor_enabled.then(|| {
            let child = Arc::clone(&child);
            let stop = Arc::clone(&monitor_stop);
            let info = identity.clone();
            thread::spawn(move || {
                while !stop.load(Ordering::Acquire) {
                    let result = child
                        .lock()
                        .map_err(|_| io::Error::other("process locked"))
                        .and_then(|mut child| child.try_wait());
                    match result {
                        Ok(Some(status)) => {
                            report_exit(&info, status);
                            break;
                        }
                        Ok(None) => thread::sleep(Duration::from_millis(100)),
                        Err(error) => {
                            log(
                                "ssh-observer-error",
                                json!({"role": info.role, "pid": info.pid, "kind": format!("{:?}", error.kind())}),
                            );
                            break;
                        }
                    }
                }
            })
        });
        Self {
            child,
            stdin,
            stdout,
            identity,
            monitor_stop,
            monitor,
        }
    }

    pub(crate) fn id(&self) -> u32 {
        self.identity.pid
    }

    pub(crate) fn request_stop(&self, reason: &'static str) {
        self.identity.requested.store(true, Ordering::Release);
        log(
            "ssh-stop-request",
            json!({"role": self.identity.role, "pid": self.id(), "reason": reason}),
        );
    }

    pub(crate) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let status = self
            .child
            .lock()
            .map_err(|_| io::Error::other("process locked"))?
            .try_wait()?;
        if let Some(status) = status {
            report_exit(&self.identity, status);
        }
        Ok(status)
    }

    pub(crate) fn kill(&mut self) -> io::Result<()> {
        if !self.identity.requested.load(Ordering::Acquire) {
            self.request_stop("forced-kill");
        }
        let result = self
            .child
            .lock()
            .map_err(|_| io::Error::other("process locked"))?
            .kill();
        log(
            "ssh-kill",
            json!({"role": self.identity.role, "pid": self.id(), "sent": result.is_ok()}),
        );
        result
    }

    pub(crate) fn wait(&mut self) -> io::Result<ExitStatus> {
        // Do not hold the process mutex across a blocking wait: the debug
        // observer and callers must still be able to inspect/stop the child.
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(status);
            }
            thread::sleep(Duration::from_millis(25));
        }
    }
}

impl Drop for DiagnosticChild {
    fn drop(&mut self) {
        self.monitor_stop.store(true, Ordering::Release);
        if self.try_wait().ok().flatten().is_none() {
            if !self.identity.requested.load(Ordering::Acquire) {
                self.request_stop("drop-fallback");
            }
            drop(self.stdin.take());
            let _ = self.kill();
            let _ = self.wait();
        }
        if let Some(monitor) = self.monitor.take() {
            let _ = monitor.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn child_stderr_preserves_error_classes_but_never_raw_credentials() {
        let line = b"Connection reset by peer token=secret clipboard=private payload /secret/key";
        assert_eq!(
            normalized_stderr(line),
            Some(json!({"category": "connection-reset"}))
        );
        assert_eq!(
            normalized_stderr(b"password=secret clipboard=private payload"),
            None
        );
        let remote = br#"[PenguX11VNC lifecycle] {"event":"vnc-stderr","category":"x11-error","xError":"BadWindow","password":"secret","message":"clipboard contents","at":"2026-09-30T13:53:54.464Z","majorOpcode":3}"#;
        let safe = normalized_stderr(remote).unwrap();
        assert_eq!(safe["remote"]["xError"], "BadWindow");
        assert_eq!(safe["remote"]["majorOpcode"], 3);
        assert!(!safe.to_string().contains("secret"));
        assert!(!safe.to_string().contains("clipboard"));
    }

    #[test]
    fn noisy_stderr_stays_bounded_and_keeps_the_final_remote_exit() {
        let mut input = b"Connection reset by peer\n".repeat(1000);
        input.extend_from_slice(&vec![b'x'; 100_000]);
        input.extend_from_slice(b"\n[PenguX11VNC lifecycle] {\"event\":\"vnc-exit\",\"returncode\":7,\"reason\":\"vnc-exited\",\"lastError\":{\"category\":\"x11-error\",\"xError\":\"BadWindow\",\"password\":\"secret\"}}\n");
        let mut output = Vec::new();
        read_stderr(Cursor::new(input), |value| output.push(value)).unwrap();
        assert_eq!(output.len(), STDERR_RECORD_LIMIT + 2);
        assert_eq!(output[STDERR_RECORD_LIMIT]["remote"]["returncode"], 7);
        assert_eq!(
            output[STDERR_RECORD_LIMIT]["remote"]["lastError"]["xError"],
            "BadWindow"
        );
        assert!(!output[STDERR_RECORD_LIMIT].to_string().contains("secret"));
        assert!(output.last().unwrap()["unrecordedLines"].as_u64().unwrap() > 0);
    }

    #[test]
    fn bounded_log_keeps_only_one_rotated_file() {
        let root = std::env::temp_dir().join(format!(
            "pengux-diag-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        fs::create_dir(&root).unwrap();
        let path = root.join("manager.log");
        for _ in 0..5 {
            append_bounded(&path, b"123456789\n", 20).unwrap();
        }
        assert!(fs::metadata(&path).unwrap().len() <= 20);
        assert!(fs::metadata(root.join("manager.log.1")).unwrap().len() <= 20);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn observer_detects_natural_exit_without_a_recovery_poll() {
        let child = std::process::Command::new("sh")
            .args(["-c", "exit 7"])
            .spawn()
            .unwrap();
        let mut child = DiagnosticChild::with_monitor(child, "fixture", true);
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !child.identity.exit_reported.load(Ordering::Acquire)
            && std::time::Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(child.identity.exit_reported.load(Ordering::Acquire));
        assert!(!child.identity.requested.load(Ordering::Acquire));
        assert_eq!(child.wait().unwrap().code(), Some(7));
    }
}
