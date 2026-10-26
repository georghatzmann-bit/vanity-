//! Connection to the game server through the control pipe `\\.\pipe\niobium-server`.
//! JSON, one object per line. We send commands, the server sends events back.
//!
//! The real pipe only exists on Windows. On other systems nothing here does anything.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::sync::mpsc::Sender;

pub const PIPE_NAME: &str = r"\\.\pipe\niobium-server";

#[derive(Debug, Clone, Serialize)]
pub struct Command {
    pub id: u64,
    pub cmd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
}

/// Event from the server – kept open, so new fields don't get in the way.
#[derive(Debug, Clone, Deserialize)]
pub struct ServerEvent {
    pub event: String,
    #[serde(flatten)]
    pub rest: serde_json::Map<String, serde_json::Value>,
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// Open connection to the server. For sending commands and receiving events.
    pub struct ServerLink {
        writer: Arc<Mutex<std::fs::File>>,
        next_id: AtomicU64,
    }

    impl ServerLink {
        /// Tries to connect to the pipe. `on_event` gets every server event.
        /// Returns None if the server isn't there (yet).
        pub fn connect(on_event: Sender<ServerEvent>) -> Option<ServerLink> {
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(PIPE_NAME)
                .ok()?;
            let reader_file = file.try_clone().ok()?;
            std::thread::spawn(move || {
                let reader = BufReader::new(reader_file);
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    if let Ok(ev) = serde_json::from_str::<ServerEvent>(line) {
                        if on_event.send(ev).is_err() {
                            break;
                        }
                    }
                }
            });
            Some(ServerLink { writer: Arc::new(Mutex::new(file)), next_id: AtomicU64::new(1) })
        }

        /// Connects, waiting up to `timeout` for the server.
        pub fn connect_wait(on_event: Sender<ServerEvent>, timeout: Duration) -> Option<ServerLink> {
            let start = std::time::Instant::now();
            loop {
                if let Some(link) = Self::connect(on_event.clone()) {
                    return Some(link);
                }
                if start.elapsed() >= timeout {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(300));
            }
        }

        fn send(&self, mut cmd: Command) -> Result<u64, String> {
            let id = self.next_id.fetch_add(1, Ordering::Relaxed);
            cmd.id = id;
            let mut line = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
            line.push('\n');
            let mut w = self.writer.lock().map_err(|_| "Connection busy")?;
            w.write_all(line.as_bytes()).map_err(|e| format!("Can't reach the server: {e}"))?;
            w.flush().map_err(|e| e.to_string())?;
            Ok(id)
        }

        pub fn exec(&self, text: &str) -> Result<u64, String> {
            self.send(Command { id: 0, cmd: "exec".into(), text: Some(text.into()), key: None, value: None })
        }

        pub fn set_config(&self, key: &str, value: serde_json::Value) -> Result<u64, String> {
            self.send(Command { id: 0, cmd: "config".into(), text: None, key: Some(key.into()), value: Some(value) })
        }

        pub fn start_match(&self) -> Result<u64, String> {
            self.send(Command { id: 0, cmd: "startmatch".into(), text: None, key: None, value: None })
        }

        pub fn status(&self) -> Result<u64, String> {
            self.send(Command { id: 0, cmd: "status".into(), text: None, key: None, value: None })
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    use std::time::Duration;

    pub struct ServerLink;

    impl ServerLink {
        pub fn connect(_: Sender<ServerEvent>) -> Option<ServerLink> {
            None
        }
        pub fn connect_wait(_: Sender<ServerEvent>, _: Duration) -> Option<ServerLink> {
            None
        }
        pub fn exec(&self, _: &str) -> Result<u64, String> {
            Err("Only on Windows".into())
        }
        pub fn set_config(&self, _: &str, _: serde_json::Value) -> Result<u64, String> {
            Err("Only on Windows".into())
        }
        pub fn start_match(&self) -> Result<u64, String> {
            Err("Only on Windows".into())
        }
        pub fn status(&self) -> Result<u64, String> {
            Err("Only on Windows".into())
        }
    }
}

pub use imp::ServerLink;
