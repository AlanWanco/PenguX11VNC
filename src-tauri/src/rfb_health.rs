//! Local RFB greeting probes and a session-scoped, monotonic failure grace.
use serde_json::{json, Value};
use std::io::{self, Read};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

const CONNECT_TIMEOUT: Duration = Duration::from_millis(250);
const GREETING_TIMEOUT: Duration = Duration::from_millis(500);
pub(super) const FAILURE_THRESHOLD: u32 = 3;
pub(super) const FAILURE_GRACE: Duration = Duration::from_secs(10);

#[derive(Debug)]
pub(super) struct ProbeReport {
    stage: &'static str,
    category: Option<&'static str>,
    error_kind: Option<io::ErrorKind>,
    connect_ms: u64,
    greeting_ms: u64,
    elapsed_ms: u64,
}

impl ProbeReport {
    pub(super) fn ready(&self) -> bool {
        self.category.is_none()
    }

    pub(super) fn diagnostic(&self) -> Value {
        // Never retain the greeting bytes or io::Error's raw message/address.
        json!({
            "ready": self.ready(), "stage": self.stage, "category": self.category,
            "errorKind": self.error_kind.map(|kind| format!("{kind:?}")),
            "connectMs": self.connect_ms, "greetingMs": self.greeting_ms,
            "elapsedMs": self.elapsed_ms,
        })
    }
}

fn report(
    started: Instant,
    connected: Option<Instant>,
    stage: &'static str,
    category: Option<&'static str>,
    error_kind: Option<io::ErrorKind>,
) -> ProbeReport {
    let now = Instant::now();
    ProbeReport {
        stage,
        category,
        error_kind,
        connect_ms: connected.unwrap_or(now).duration_since(started).as_millis() as u64,
        greeting_ms: connected
            .map(|at| now.duration_since(at).as_millis() as u64)
            .unwrap_or(0),
        elapsed_ms: now.duration_since(started).as_millis() as u64,
    }
}

fn failure(
    started: Instant,
    connected: Option<Instant>,
    stage: &'static str,
    error: io::Error,
) -> ProbeReport {
    let category = match error.kind() {
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => "timeout",
        io::ErrorKind::ConnectionRefused => "connection-refused",
        io::ErrorKind::ConnectionReset => "connection-reset",
        io::ErrorKind::ConnectionAborted => "connection-aborted",
        io::ErrorKind::UnexpectedEof => "unexpected-eof",
        _ => "io-error",
    };
    report(
        started,
        connected,
        stage,
        Some(category),
        Some(error.kind()),
    )
}

pub(super) fn probe_rfb(port: u16) -> ProbeReport {
    probe_with_timeouts(port, CONNECT_TIMEOUT, GREETING_TIMEOUT)
}

fn probe_with_timeouts(
    port: u16,
    connect_timeout: Duration,
    greeting_timeout: Duration,
) -> ProbeReport {
    let started = Instant::now();
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let mut stream = match TcpStream::connect_timeout(&address, connect_timeout) {
        Ok(stream) => stream,
        Err(error) => return failure(started, None, "connect", error),
    };
    let connected = Instant::now();
    let deadline = connected + greeting_timeout;
    let mut greeting = [0_u8; 4];
    let mut received = 0;
    while received < greeting.len() {
        // A fragmented greeting must not restart the 500ms budget per read.
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return failure(
                started,
                Some(connected),
                "greeting",
                io::ErrorKind::TimedOut.into(),
            );
        }
        if let Err(error) = stream.set_read_timeout(Some(remaining)) {
            return failure(started, Some(connected), "greeting", error);
        }
        match stream.read(&mut greeting[received..]) {
            Ok(0) => {
                return failure(
                    started,
                    Some(connected),
                    "greeting",
                    io::ErrorKind::UnexpectedEof.into(),
                )
            }
            Ok(length) => received += length,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return failure(started, Some(connected), "greeting", error),
        }
    }
    if &greeting != b"RFB " {
        return report(
            started,
            Some(connected),
            "validate-greeting",
            Some("invalid-greeting"),
            None,
        );
    }
    report(started, Some(connected), "ready", None, None)
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum HealthDecision {
    Ready,
    Suspect,
    Recover(&'static str),
}

#[derive(Default)]
pub(super) struct RfbHealth {
    failures: u32,
    first_failure: Option<Instant>,
}

impl RfbHealth {
    pub(super) fn failures(&self) -> u32 {
        self.failures
    }

    pub(super) fn failure_for(&self, now: Instant) -> Duration {
        self.first_failure
            .map(|at| now.saturating_duration_since(at))
            .unwrap_or_default()
    }

    pub(super) fn evaluate(
        &mut self,
        identity_matches: bool,
        supervisor_alive: bool,
        tunnel_alive: bool,
        rfb_ready: bool,
        now: Instant,
    ) -> HealthDecision {
        // The grace never permits capturing a different identity or retaining
        // an unavailable SSH process. These hard failures bypass the counter.
        if !identity_matches {
            return HealthDecision::Recover("target-changed");
        }
        if !supervisor_alive {
            return HealthDecision::Recover("supervisor-unavailable");
        }
        if !tunnel_alive {
            return HealthDecision::Recover("tunnel-unavailable");
        }
        if rfb_ready {
            *self = Self::default();
            return HealthDecision::Ready;
        }
        self.first_failure.get_or_insert(now);
        self.failures = self.failures.saturating_add(1);
        if self.failures >= FAILURE_THRESHOLD && self.failure_for(now) >= FAILURE_GRACE {
            HealthDecision::Recover("rfb-probe-failed")
        } else {
            HealthDecision::Suspect
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    fn soft_failure(health: &mut RfbHealth, now: Instant) -> HealthDecision {
        health.evaluate(true, true, true, false, now)
    }

    #[test]
    fn one_failure_never_recovers_and_both_thresholds_are_required() {
        let start = Instant::now();
        let mut health = RfbHealth::default();
        assert_eq!(soft_failure(&mut health, start), HealthDecision::Suspect);
        // Time passing alone is not sufficient: this is only failure number 2.
        assert_eq!(
            soft_failure(&mut health, start + Duration::from_secs(30)),
            HealthDecision::Suspect
        );
        assert_eq!(health.failures(), 2);
        assert_eq!(
            soft_failure(&mut health, start + Duration::from_secs(31)),
            HealthDecision::Recover("rfb-probe-failed")
        );
    }

    #[test]
    fn fast_failures_wait_for_grace_and_recover_at_the_boundary() {
        let start = Instant::now();
        let mut health = RfbHealth::default();
        for seconds in [0, 1, 2, 9] {
            assert_eq!(
                soft_failure(&mut health, start + Duration::from_secs(seconds)),
                HealthDecision::Suspect
            );
        }
        assert_eq!(
            soft_failure(&mut health, start + FAILURE_GRACE),
            HealthDecision::Recover("rfb-probe-failed")
        );
    }

    #[test]
    fn normal_poll_cadence_recovers_on_third_failure_after_ten_seconds() {
        let start = Instant::now();
        let mut health = RfbHealth::default();
        assert_eq!(soft_failure(&mut health, start), HealthDecision::Suspect);
        assert_eq!(
            soft_failure(&mut health, start + Duration::from_secs(5)),
            HealthDecision::Suspect
        );
        assert_eq!(
            soft_failure(&mut health, start + Duration::from_secs(10)),
            HealthDecision::Recover("rfb-probe-failed")
        );
    }

    #[test]
    fn success_resets_count_and_first_failure_time() {
        let start = Instant::now();
        let mut health = RfbHealth::default();
        soft_failure(&mut health, start);
        soft_failure(&mut health, start + Duration::from_secs(5));
        assert_eq!(
            health.evaluate(true, true, true, true, start + Duration::from_secs(9)),
            HealthDecision::Ready
        );
        assert_eq!(health.failures(), 0);
        assert_eq!(
            health.failure_for(start + Duration::from_secs(30)),
            Duration::ZERO
        );
        let restart = start + Duration::from_secs(30);
        assert_eq!(soft_failure(&mut health, restart), HealthDecision::Suspect);
        assert_eq!(health.failures(), 1);
        assert_eq!(health.failure_for(restart), Duration::ZERO);
        assert_eq!(
            soft_failure(&mut health, restart + Duration::from_secs(5)),
            HealthDecision::Suspect
        );
    }

    #[test]
    fn identity_change_and_unavailable_ssh_bypass_pending_grace() {
        let start = Instant::now();
        for (identity, supervisor, tunnel, reason) in [
            (false, true, true, "target-changed"),
            (true, false, true, "supervisor-unavailable"),
            (true, true, false, "tunnel-unavailable"),
        ] {
            for pending in [false, true] {
                let mut health = RfbHealth::default();
                if pending {
                    soft_failure(&mut health, start);
                }
                assert_eq!(
                    health.evaluate(identity, supervisor, tunnel, true, start),
                    HealthDecision::Recover(reason)
                );
            }
        }
    }

    #[test]
    fn failure_count_saturates_instead_of_wrapping() {
        let start = Instant::now();
        let mut health = RfbHealth {
            failures: u32::MAX,
            first_failure: Some(start),
        };
        assert_eq!(
            soft_failure(&mut health, start + FAILURE_GRACE),
            HealthDecision::Recover("rfb-probe-failed")
        );
        assert_eq!(health.failures(), u32::MAX);
    }

    fn greeting_probe(bytes: &'static [u8]) -> ProbeReport {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let worker = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.write_all(bytes).unwrap();
        });
        let result = probe_rfb(port);
        worker.join().unwrap();
        result
    }

    #[test]
    fn valid_greeting_and_timing_fields_are_recorded_without_payload() {
        let result = greeting_probe(b"RFB 003.008\n");
        assert!(result.ready());
        assert_eq!(result.stage, "ready");
        let diagnostic = result.diagnostic();
        assert_eq!(diagnostic["ready"], true);
        for field in ["connectMs", "greetingMs", "elapsedMs"] {
            assert!(diagnostic[field].is_u64());
        }
        assert!(!diagnostic.to_string().contains("003.008"));
    }

    #[test]
    fn invalid_and_partial_greetings_are_distinguished_and_redacted() {
        let invalid = greeting_probe(b"password=secret clipboard=private");
        assert!(!invalid.ready());
        assert_eq!(invalid.stage, "validate-greeting");
        assert_eq!(invalid.category, Some("invalid-greeting"));
        assert!(!invalid.diagnostic().to_string().contains("secret"));
        let partial = greeting_probe(b"RF");
        assert!(!partial.ready());
        assert_eq!(partial.stage, "greeting");
        assert_eq!(partial.category, Some("unexpected-eof"));
    }

    #[test]
    fn missing_greeting_has_a_bounded_read_timeout() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (release, wait) = mpsc::channel();
        let worker = thread::spawn(move || {
            let (_socket, _) = listener.accept().unwrap();
            let _ = wait.recv_timeout(Duration::from_secs(3));
        });
        let result = probe_with_timeouts(port, CONNECT_TIMEOUT, Duration::from_millis(40));
        release.send(()).unwrap();
        worker.join().unwrap();
        assert!(!result.ready());
        assert_eq!(result.stage, "greeting");
        assert_eq!(result.category, Some("timeout"));
    }

    #[test]
    fn fragmented_valid_greeting_is_accepted() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let worker = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            for byte in b"RFB " {
                socket.write_all(&[*byte]).unwrap();
                thread::sleep(Duration::from_millis(10));
            }
        });
        let result = probe_rfb(port);
        worker.join().unwrap();
        assert!(result.ready());
    }

    #[test]
    fn known_connection_error_categories_do_not_expose_raw_messages() {
        for (kind, expected) in [
            (io::ErrorKind::TimedOut, "timeout"),
            (io::ErrorKind::WouldBlock, "timeout"),
            (io::ErrorKind::ConnectionRefused, "connection-refused"),
            (io::ErrorKind::ConnectionReset, "connection-reset"),
            (io::ErrorKind::Other, "io-error"),
        ] {
            let result = failure(
                Instant::now(),
                None,
                "connect",
                io::Error::new(kind, "host=private password=secret"),
            );
            assert_eq!(result.category, Some(expected));
            let diagnostic = result.diagnostic().to_string();
            assert!(!diagnostic.contains("private"));
            assert!(!diagnostic.contains("secret"));
        }
    }
}
