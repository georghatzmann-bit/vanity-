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
    use std::io::{Read, Write};
    use std::os::windows::io::AsRawHandle;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc::{self, Receiver, TryRecvError};
    use std::sync::Mutex;
    use std::time::Duration;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Pipes::PeekNamedPipe;

    /// Open connection to the server. For sending commands and receiving events.
    ///
    /// One thread does all pipe I/O. A pipe handle opened without overlapped I/O serializes its
    /// reads and writes: a ReadFile that waits for data would block every WriteFile on the same
    /// handle (also through `try_clone`). So nobody ever waits in ReadFile: the thread only reads
    /// what `PeekNamedPipe` says is there, and writes the queued lines in between.
    pub struct ServerLink {
        outbox: Mutex<mpsc::Sender<String>>,
        next_id: AtomicU64,
    }

    fn available(file: &std::fs::File) -> Result<u32, ()> {
        let mut avail = 0u32;
        // SAFETY: the handle stays valid while `file` lives; only the count is written.
        unsafe { PeekNamedPipe(HANDLE(file.as_raw_handle()), None, 0, None, Some(&mut avail), None) }
            .map(|_| avail)
            .map_err(|_| ())
    }

    fn io_loop(mut file: std::fs::File, outbox: Receiver<String>, on_event: Sender<ServerEvent>) {
        let mut pending = Vec::<u8>::new();
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            let mut busy = false;
            // Send everything that is queued
            loop {
                match outbox.try_recv() {
                    Ok(line) => {
                        busy = true;
                        if file.write_all(line.as_bytes()).is_err() {
                            return;
                        }
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => return, // the link was dropped
                }
            }
            // Read only what is already there
            let Ok(n) = available(&file) else { return };
            if n > 0 {
                busy = true;
                let want = (n as usize).min(buf.len());
                let Ok(got) = file.read(&mut buf[..want]) else { return };
                if got == 0 {
                    return;
                }
                pending.extend_from_slice(&buf[..got]);
                while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = pending.drain(..=pos).collect();
                    let text = String::from_utf8_lossy(&line);
                    let text = text.trim();
                    if text.is_empty() {
                        continue;
                    }
                    if let Ok(ev) = serde_json::from_str::<ServerEvent>(text) {
                        if on_event.send(ev).is_err() {
                            return;
                        }
                    }
                }
                if pending.len() > 1024 * 1024 {
                    pending.clear(); // guard against endless lines
                }
            }
            if !busy {
                std::thread::sleep(Duration::from_millis(15));
            }
        }
    }

    impl ServerLink {
        /// Tries to connect to the pipe. `on_event` gets every server event.
        /// Returns None if the server isn't there (yet).
        pub fn connect(on_event: Sender<ServerEvent>) -> Option<ServerLink> {
            let file = std::fs::OpenOptions::new().read(true).write(true).open(PIPE_NAME).ok()?;
            let (tx, rx) = mpsc::channel::<String>();
            std::thread::spawn(move || io_loop(file, rx, on_event));
            Some(ServerLink { outbox: Mutex::new(tx), next_id: AtomicU64::new(1) })
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
            let tx = self.outbox.lock().map_err(|_| "Connection busy")?;
            tx.send(line).map_err(|_| "Can't reach the server: the connection was closed".to_string())?;
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
