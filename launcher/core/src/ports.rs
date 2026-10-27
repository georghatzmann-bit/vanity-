//! Who holds a port the backend needs – and is it one of our own old backends?
//!
//! Before the backend starts, the launcher looks at the backend port (3551) and the matchmaker port
//! (Settings → Network, default 80). A `node.exe` from one of our own install folders (Rift, or the
//! old names Niobium and Vanity) is a leftover backend: it is closed and the start goes on. Anything
//! else is left alone and named in a plain message. The Windows calls are in
//! `src-tauri/src/netports.rs`; the decisions and texts are here, so they can be tested anywhere.

use std::path::{Path, PathBuf};

/// One listening TCP socket: its local port and the process that owns it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Listener {
    pub port: u16,
    pub pid: u32,
}

/// The process behind a port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Owner {
    pub pid: u32,
    /// File name, e.g. "node.exe" (or "System")
    pub name: String,
    /// Full path of the program, if Windows tells us
    pub path: Option<String>,
}

/// Which of the backend's ports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortRole {
    /// HTTP, fixed at 3551 – without it nothing works
    Backend,
    /// Matchmaker + XMPP – the backend falls back to a free port by itself
    Matchmaker,
}

/// The names our launcher had, newest first. Their install folders can hold our backend's node.exe.
pub const OUR_NAMES: [&str; 3] = ["Rift", "Niobium", "Vanity"];

/// Parses `netstat -ano -p TCP` / `netstat -ano` output into listening sockets.
/// Works in every Windows language: the state column is translated (e.g. "ABHÖREN"), so a socket
/// counts as listening when its remote address is `0.0.0.0:0` or `[::]:0`.
pub fn parse_netstat_listeners(text: &str) -> Vec<Listener> {
    let mut out = Vec::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        // Proto  Local  Remote  State  PID
        if cols.len() != 5 || !cols[0].eq_ignore_ascii_case("TCP") {
            continue;
        }
        if cols[2] != "0.0.0.0:0" && cols[2] != "[::]:0" {
            continue;
        }
        let Some(port) = cols[1].rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) else { continue };
        let Ok(pid) = cols[4].parse::<u32>() else { continue };
        let entry = Listener { port, pid };
        if !out.contains(&entry) {
            out.push(entry);
        }
    }
    out
}

/// The PIDs listening on `port` (each once, in order).
pub fn pids_on_port(listeners: &[Listener], port: u16) -> Vec<u32> {
    let mut pids = Vec::new();
    for l in listeners.iter().filter(|l| l.port == port) {
        if !pids.contains(&l.pid) {
            pids.push(l.pid);
        }
    }
    pids
}

/// Our install folders as (name, folder): `<local>\Rift`, `<local>\Niobium`, `<local>\Vanity`
/// (`local` = %LOCALAPPDATA%, the default of our "current user" installer).
pub fn default_install_dirs(local: &Path) -> Vec<(&'static str, PathBuf)> {
    OUR_NAMES.iter().map(|name| (*name, local.join(name))).collect()
}

fn norm(path: &str) -> String {
    let p = path.trim().replace('/', "\\");
    let p = p.strip_prefix(r"\\?\").unwrap_or(&p);
    p.trim_end_matches('\\').to_lowercase()
}

/// If `exe` is a `node.exe` inside one of our install folders: the name of that install
/// (e.g. "Niobium"). Compares like Windows does (no case, `/` = `\`).
pub fn our_backend_install<'a>(exe: &str, installs: &[(&'a str, PathBuf)]) -> Option<&'a str> {
    let exe_n = norm(exe);
    if !exe_n.ends_with("\\node.exe") {
        return None;
    }
    installs.iter().find_map(|(name, dir)| {
        let dir_n = norm(&dir.to_string_lossy());
        (!dir_n.is_empty() && exe_n.starts_with(&format!("{dir_n}\\"))).then_some(*name)
    })
}

/// "Closed an old backend that was still running (Niobium)."
pub fn closed_old_backend_message(install: &str) -> String {
    format!("Closed an old backend that was still running ({install}).")
}

/// "node.exe (C:\…\node.exe)" – or a plain word when Windows didn't name the program.
pub fn owner_label(owner: Option<&Owner>) -> String {
    match owner {
        // PID 4: Windows' own web service (http.sys), used by IIS and similar
        Some(o) if o.pid == 4 => "Windows (System – usually a web service such as IIS)".to_string(),
        Some(o) => match &o.path {
            Some(path) if !path.is_empty() => format!("{} ({path})", o.name),
            _ => format!("{} (process {})", o.name, o.pid),
        },
        None => "another program".to_string(),
    }
}

/// The plain message when a port is taken by someone else.
pub fn busy_message(port: u16, role: PortRole, owner: Option<&Owner>) -> String {
    let who = owner_label(owner);
    match role {
        PortRole::Backend => format!(
            "Port {port} is used by {who}. Close it – for example Reboot Launcher or another Fortnite backend – and press Host & Play again."
        ),
        PortRole::Matchmaker => format!(
            "Port {port} is used by {who}. Change the matchmaker port in Settings → Network. Until then the backend picks a free port by itself."
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NETSTAT_DE: &str = "
Aktive Verbindungen

  Proto  Lokale Adresse         Remoteadresse          Status           PID
  TCP    0.0.0.0:80             0.0.0.0:0              ABHÖREN          4
  TCP    127.0.0.1:3551         0.0.0.0:0              ABHÖREN          9120
  TCP    127.0.0.1:3551         127.0.0.1:50211        HERGESTELLT      9120
  TCP    127.0.0.1:50211        127.0.0.1:3551         HERGESTELLT      7000
  TCP    [::]:3551              [::]:0                 ABHÖREN          5555
  TCP    [::]:3551              [::]:0                 ABHÖREN          5555
  UDP    0.0.0.0:7777           *:*                                     6000
";

    #[test]
    fn netstat_listeners_any_language() {
        let l = parse_netstat_listeners(NETSTAT_DE);
        assert_eq!(
            l,
            vec![
                Listener { port: 80, pid: 4 },
                Listener { port: 3551, pid: 9120 },
                Listener { port: 3551, pid: 5555 },
            ]
        );
        assert_eq!(pids_on_port(&l, 3551), vec![9120, 5555]);
        assert!(pids_on_port(&l, 7777).is_empty());
    }

    #[test]
    fn netstat_english_and_garbage() {
        let text = "  TCP    0.0.0.0:8080   0.0.0.0:0   LISTENING   42\r\nnonsense\n  TCP  x  0.0.0.0:0  LISTENING  abc\n";
        assert_eq!(parse_netstat_listeners(text), vec![Listener { port: 8080, pid: 42 }]);
        assert!(parse_netstat_listeners("").is_empty());
    }

    fn installs() -> Vec<(&'static str, PathBuf)> {
        default_install_dirs(Path::new(r"C:\Users\Jörg\AppData\Local"))
    }

    #[test]
    fn our_old_backends_are_recognised() {
        let i = installs();
        assert_eq!(our_backend_install(r"C:\Users\Jörg\AppData\Local\Niobium\node\node.exe", &i), Some("Niobium"));
        assert_eq!(our_backend_install(r"c:\users\jörg\appdata\local\VANITY\node\NODE.EXE", &i), Some("Vanity"));
        assert_eq!(our_backend_install(r"\\?\C:\Users\Jörg\AppData\Local\Rift\node\node.exe", &i), Some("Rift"));
        assert_eq!(our_backend_install("C:/Users/Jörg/AppData/Local/Rift/node/node.exe", &i), Some("Rift"));
        // a custom install folder (from the old installer's registry entry)
        let custom = vec![("Niobium", PathBuf::from(r"D:\Games\Niobium\"))];
        assert_eq!(our_backend_install(r"D:\Games\Niobium\node\node.exe", &custom), Some("Niobium"));
    }

    #[test]
    fn other_programs_are_not_ours() {
        let i = installs();
        // Reboot Launcher's / a system-wide node, other programs in our folder, look-alike folders
        assert_eq!(our_backend_install(r"C:\Program Files\nodejs\node.exe", &i), None);
        assert_eq!(our_backend_install(r"C:\Users\Jörg\AppData\Local\Rift\Rift.exe", &i), None);
        assert_eq!(our_backend_install(r"C:\Users\Jörg\AppData\Local\RiftOther\node\node.exe", &i), None);
        assert_eq!(our_backend_install(r"C:\Users\Jörg\AppData\Local\Niobium\node\node.exe.bak", &i), None);
        assert_eq!(our_backend_install(r"C:\Users\Jörg\AppData\Roaming\reboot_launcher\backend\node.exe", &i), None);
        assert_eq!(our_backend_install("", &i), None);
        assert_eq!(our_backend_install(r"C:\node.exe", &[("Rift", PathBuf::new())]), None);
    }

    #[test]
    fn messages_name_the_owner() {
        let owner = Owner { pid: 77, name: "reboot.exe".into(), path: Some(r"C:\Reboot\reboot.exe".into()) };
        assert_eq!(
            busy_message(3551, PortRole::Backend, Some(&owner)),
            r"Port 3551 is used by reboot.exe (C:\Reboot\reboot.exe). Close it – for example Reboot Launcher or another Fortnite backend – and press Host & Play again."
        );
        let system = Owner { pid: 4, name: "System".into(), path: None };
        assert!(busy_message(80, PortRole::Matchmaker, Some(&system))
            .starts_with("Port 80 is used by Windows (System – usually a web service such as IIS). Change the matchmaker port in Settings → Network."));
        let no_path = Owner { pid: 9, name: "svc.exe".into(), path: None };
        assert_eq!(owner_label(Some(&no_path)), "svc.exe (process 9)");
        assert!(busy_message(3551, PortRole::Backend, None).starts_with("Port 3551 is used by another program."));
        assert_eq!(closed_old_backend_message("Niobium"), "Closed an old backend that was still running (Niobium).");
    }
}
