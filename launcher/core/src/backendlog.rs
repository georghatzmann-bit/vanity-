//! The backend's own output: the file `%LOCALAPPDATA%\Rift\logs\backend.log` and the line that says
//! why it stopped.
//!
//! The launcher starts `node.exe main.js` with stdout and stderr piped, shows every line in the live
//! log and appends it to `backend.log`. If the backend ends during the start, the toast shows the exit
//! code and the most telling line (the backend's own "[Rift] …" error, or the message of a Node error,
//! never a stack-trace line).

use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// `backend.log` is moved to `backend.old.log` once it is bigger than this.
pub const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

/// How many of the last lines are kept for the "why did it stop" message.
pub const TAIL_LINES: usize = 40;

/// Removes terminal colour codes (`\x1b[31m` …), which LawinServer prints.
pub fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            // parameters until the final letter
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// True for lines that never explain anything: stack-trace lines, Node's version footer, the `^`
/// marker under a code line, empty lines.
fn is_noise(line: &str) -> bool {
    let t = line.trim();
    t.is_empty()
        || t.starts_with("at ")
        || t.starts_with("Node.js v")
        || t.chars().all(|c| c == '^' || c == '~' || c == ' ')
        || t == "}"
        || t == "{"
}

/// Level, category and text of one backend line for the live log:
/// `[HTTP] GET /x → 200` → ("info", "HTTP", "GET /x → 200"), `[Rift] …` → category "Backend";
/// stderr lines are errors, a failed port a warning.
pub fn split_line(stderr: bool, line: &str) -> (&'static str, &'static str, String) {
    let (category, message) = match line.strip_prefix("[HTTP] ") {
        Some(rest) => ("HTTP", rest),
        None => ("Backend", line.strip_prefix("[Rift] ").unwrap_or(line)),
    };
    let level = if stderr {
        "error"
    } else if message.contains("FAILED") || message.contains("already in use") {
        "warning"
    } else {
        "info"
    };
    (level, category, message.to_string())
}

/// The last lines of the backend's output (`true` = stderr).
#[derive(Debug, Default)]
pub struct Tail {
    lines: VecDeque<(bool, String)>,
}

impl Tail {
    pub fn push(&mut self, stderr: bool, line: &str) {
        if self.lines.len() == TAIL_LINES {
            self.lines.pop_front();
        }
        self.lines.push_back((stderr, line.to_string()));
    }

    /// The line that best says why the backend stopped (without a "[Rift] " in front).
    pub fn reason(&self) -> Option<String> {
        let tidy = |l: &str| l.trim().trim_start_matches("[Rift] ").trim().to_string();
        let useful = |(_, l): &&(bool, String)| !is_noise(l);
        // 1) a line of ours on stderr (e.g. "[Rift] HTTP port … is already in use")
        if let Some((_, l)) = self.lines.iter().rev().find(|(err, l)| *err && l.trim_start().starts_with("[Rift]")) {
            return Some(tidy(l));
        }
        // 2) the message of a Node error ("Error: …", "SyntaxError: …")
        if let Some((_, l)) = self.lines.iter().rev().filter(useful).find(|(err, l)| *err && is_error_message(l)) {
            return Some(tidy(l));
        }
        // 3) the last useful stderr line, then the last useful line at all
        self.lines
            .iter()
            .rev()
            .filter(useful)
            .find(|(err, _)| *err)
            .or_else(|| self.lines.iter().rev().find(useful))
            .map(|(_, l)| tidy(l))
    }
}

fn is_error_message(line: &str) -> bool {
    let t = line.trim();
    let head = t.split(':').next().unwrap_or("");
    t.contains(':') && head.ends_with("Error") && !head.contains(' ')
}

/// "The backend stopped (exit code 1): HTTP port 127.0.0.1:3551 is already in use"
pub fn stopped_message(code: Option<i32>, reason: Option<&str>) -> String {
    let code = match code {
        // Windows crash codes (0xC0000005 …) come as negative numbers
        Some(c) if c < 0 => format!("exit code 0x{:08X}", c as u32),
        Some(c) => format!("exit code {c}"),
        None => "no exit code".to_string(),
    };
    match reason {
        Some(r) if !r.is_empty() => format!("The backend stopped ({code}): {r}"),
        _ => format!("The backend stopped ({code}) without saying why – see logs\\backend.log in %LOCALAPPDATA%\\Rift."),
    }
}

/// Date and time (UTC) of a Unix time stamp: "2026-10-27 14:03:05 UTC".
pub fn utc_stamp(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // civil date from days since 1970-01-01 (H. Hinnant's algorithm)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02} UTC", rem / 3600, (rem / 60) % 60, rem % 60)
}

/// `backend.log`, appended to, moved to `backend.old.log` (replacing the older one) when it gets
/// bigger than `max_bytes`. Write errors are ignored by the caller – the live log still has the lines.
pub struct RotatingLog {
    path: PathBuf,
    max_bytes: u64,
    file: Option<File>,
    size: u64,
}

impl RotatingLog {
    pub fn open(path: &Path, max_bytes: u64) -> io::Result<RotatingLog> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let mut log = RotatingLog { path: path.to_path_buf(), max_bytes, file: None, size: 0 };
        let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        if size > max_bytes {
            log.rotate()?;
        } else {
            log.file = Some(OpenOptions::new().create(true).append(true).open(path)?);
            log.size = size;
        }
        Ok(log)
    }

    /// `backend.old.log` next to `backend.log`
    pub fn old_path(&self) -> PathBuf {
        self.path.with_extension("old.log")
    }

    fn rotate(&mut self) -> io::Result<()> {
        self.file = None;
        let old = self.old_path();
        let _ = fs::remove_file(&old);
        let _ = fs::rename(&self.path, &old);
        self.file = Some(OpenOptions::new().create(true).write(true).truncate(true).open(&self.path)?);
        self.size = 0;
        Ok(())
    }

    pub fn write_line(&mut self, line: &str) -> io::Result<()> {
        let bytes = line.len() as u64 + 2;
        if self.size + bytes > self.max_bytes && self.size > 0 {
            self.rotate()?;
        }
        let file = self.file.as_mut().ok_or_else(|| io::Error::other("backend.log isn't open"))?;
        file.write_all(line.as_bytes())?;
        file.write_all(b"\r\n")?;
        self.size += bytes;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tail(lines: &[(bool, &str)]) -> Tail {
        let mut t = Tail::default();
        for (err, l) in lines {
            t.push(*err, l);
        }
        t
    }

    #[test]
    fn port_in_use_line_wins() {
        let t = tail(&[
            (false, "[Rift] Data folder: C:\\x\\backend-data"),
            (true, "[Rift] HTTP port 127.0.0.1:3551 is already in use"),
        ]);
        assert_eq!(t.reason().as_deref(), Some("HTTP port 127.0.0.1:3551 is already in use"));
        assert_eq!(
            stopped_message(Some(1), t.reason().as_deref()),
            "The backend stopped (exit code 1): HTTP port 127.0.0.1:3551 is already in use"
        );
    }

    #[test]
    fn node_crash_shows_the_error_not_the_stack() {
        let t = tail(&[
            (true, "C:\\Users\\x\\AppData\\Local\\Rift\\backend\\main.js:4521"),
            (true, "    jsonCache.set(abs, JSON.parse(text));"),
            (true, "                            ^"),
            (true, ""),
            (true, "SyntaxError: Unexpected end of JSON input"),
            (true, "    at JSON.parse (<anonymous>)"),
            (true, "    at Object.json (main.js:4521:29)"),
            (true, ""),
            (true, "Node.js v22.12.0"),
        ]);
        assert_eq!(t.reason().as_deref(), Some("SyntaxError: Unexpected end of JSON input"));
    }

    #[test]
    fn falls_back_to_stdout_and_handles_nothing() {
        let t = tail(&[(false, "[Rift] Data folder: D:\\data"), (false, "")]);
        assert_eq!(t.reason().as_deref(), Some("Data folder: D:\\data"));
        assert_eq!(Tail::default().reason(), None);
        assert!(stopped_message(Some(-1_073_741_819), None).contains("(exit code 0xC0000005) without saying why"));
        assert!(stopped_message(None, Some("x")).starts_with("The backend stopped (no exit code): x"));
    }

    #[test]
    fn tail_keeps_only_the_last_lines() {
        let mut t = Tail::default();
        for i in 0..(TAIL_LINES + 5) {
            t.push(false, &format!("line {i}"));
        }
        assert_eq!(t.lines.len(), TAIL_LINES);
        assert_eq!(t.reason().as_deref(), Some(format!("line {}", TAIL_LINES + 4).as_str()));
    }

    #[test]
    fn live_log_lines() {
        assert_eq!(split_line(false, "[HTTP] GET /niobium/health → 200"), ("info", "HTTP", "GET /niobium/health → 200".into()));
        assert_eq!(split_line(true, "[Rift] HTTP port 127.0.0.1:3551 is already in use"), ("error", "Backend", "HTTP port 127.0.0.1:3551 is already in use".into()));
        assert_eq!(split_line(false, "XMPP and Matchmaker FAILED to start hosting."), ("warning", "Backend", "XMPP and Matchmaker FAILED to start hosting.".into()));
        assert_eq!(split_line(false, "[Rift] Data folder: x").0, "info");
    }

    #[test]
    fn ansi_codes_are_removed() {
        assert_eq!(
            strip_ansi("XMPP and Matchmaker \x1b[31mFAILED\x1b[0m to start hosting."),
            "XMPP and Matchmaker FAILED to start hosting."
        );
        assert_eq!(strip_ansi("plain → ok"), "plain → ok");
    }

    #[test]
    fn utc_stamps() {
        assert_eq!(utc_stamp(0), "1970-01-01 00:00:00 UTC");
        assert_eq!(utc_stamp(951_782_400), "2000-02-29 00:00:00 UTC");
        assert_eq!(utc_stamp(1_793_101_385), "2026-10-27 11:43:05 UTC");
    }

    #[test]
    fn log_file_rotates() {
        let dir = std::env::temp_dir().join(format!("rift-backendlog-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("logs").join("backend.log");
        let mut log = RotatingLog::open(&path, 100).unwrap();
        for i in 0..10 {
            log.write_line(&format!("line number {i:02}")).unwrap(); // 16 bytes + CRLF
        }
        let now = fs::read_to_string(&path).unwrap();
        let old = fs::read_to_string(log.old_path()).unwrap();
        assert!(now.len() <= 100 && old.len() <= 100);
        assert!(now.ends_with("line number 09\r\n"));
        assert!(old.contains("line number 0"));
        drop(log);
        // a big file from before is moved away on open
        fs::write(&path, vec![b'x'; 500]).unwrap();
        let mut log = RotatingLog::open(&path, 100).unwrap();
        log.write_line("fresh").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "fresh\r\n");
        assert_eq!(fs::metadata(log.old_path()).unwrap().len(), 500);
        let _ = fs::remove_dir_all(&dir);
    }
}
