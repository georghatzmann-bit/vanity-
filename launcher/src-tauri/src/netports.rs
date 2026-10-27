//! Which process listens on a TCP port (Windows: `GetExtendedTcpTable`, `netstat -ano` as a
//! fallback), its program path, and where our own launchers are installed. The decisions
//! ("ours or not", the texts) are in `niobium_core::ports`.

use std::net::TcpListener;
use std::path::{Path, PathBuf};

use niobium_core::ports::{self, Listener, Owner};

/// True if we could listen on `bind:port` right now (the test socket is closed at once).
pub fn can_listen(bind: &str, port: u16) -> bool {
    TcpListener::bind((bind, port)).is_ok()
}

/// Our install folders: `%LOCALAPPDATA%\Rift|Niobium|Vanity`, the folder this Rift runs from, and
/// the folders the old installers wrote to the registry (`HKCU\Software\Georg Hatzmann\<name>`).
pub fn install_dirs(local: &Path, this_install: Option<PathBuf>) -> Vec<(&'static str, PathBuf)> {
    let mut dirs = ports::default_install_dirs(local);
    if let Some(dir) = this_install {
        dirs.push(("Rift", dir));
    }
    for name in ports::OUR_NAMES {
        if let Some(dir) = imp::registry_install_dir(name) {
            dirs.push((name, dir));
        }
    }
    dirs
}

pub use imp::{listeners, owner};

#[cfg(windows)]
mod imp {
    use super::*;
    use std::os::windows::process::CommandExt;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    const AF_INET: u32 = 2;
    const AF_INET6: u32 = 23;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The raw listener table of one address family (None if Windows refuses).
    fn table(family: u32) -> Option<Vec<u8>> {
        let mut size = 0u32;
        let mut buf: Vec<u8> = Vec::new();
        for _ in 0..4 {
            let ptr = if buf.is_empty() { None } else { Some(buf.as_mut_ptr() as *mut _) };
            let r = unsafe { GetExtendedTcpTable(ptr, &mut size, false, family, TCP_TABLE_OWNER_PID_LISTENER, 0) };
            if r == NO_ERROR.0 && !buf.is_empty() {
                return Some(buf);
            }
            if r != ERROR_INSUFFICIENT_BUFFER.0 && !(r == NO_ERROR.0 && buf.is_empty()) {
                return None;
            }
            buf = vec![0u8; size as usize + 256];
        }
        None
    }

    /// Rows of a `MIB_TCP(6)TABLE_OWNER_PID` buffer: a u32 count, then the rows (8-byte aligned is
    /// not needed: both row types only hold u32/u8 fields).
    fn rows<T: Copy>(buf: &[u8]) -> Vec<T> {
        if buf.len() < 4 {
            return Vec::new();
        }
        let count = u32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        let row = std::mem::size_of::<T>();
        (0..count)
            .map_while(|i| {
                let start = 4 + i * row;
                (start + row <= buf.len()).then(|| unsafe { std::ptr::read_unaligned(buf[start..].as_ptr() as *const T) })
            })
            .collect()
    }

    fn port_of(raw: u32) -> u16 {
        u16::from_be((raw & 0xFFFF) as u16)
    }

    /// Every listening TCP socket (IPv4 and IPv6) with its owner PID.
    pub fn listeners() -> Vec<Listener> {
        let v4 = table(AF_INET);
        let v6 = table(AF_INET6);
        if v4.is_none() && v6.is_none() {
            return netstat();
        }
        let mut out = Vec::new();
        if let Some(buf) = v4 {
            for r in rows::<MIB_TCPROW_OWNER_PID>(&buf) {
                out.push(Listener { port: port_of(r.dwLocalPort), pid: r.dwOwningPid });
            }
        }
        if let Some(buf) = v6 {
            for r in rows::<MIB_TCP6ROW_OWNER_PID>(&buf) {
                out.push(Listener { port: port_of(r.dwLocalPort), pid: r.dwOwningPid });
            }
        }
        out
    }

    /// Fallback: `netstat -ano -p TCP` and `-p TCPv6`.
    fn netstat() -> Vec<Listener> {
        let mut out = Vec::new();
        for proto in ["TCP", "TCPv6"] {
            let Ok(o) = std::process::Command::new("netstat")
                .args(["-ano", "-p", proto])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
            else {
                continue;
            };
            out.extend(ports::parse_netstat_listeners(&String::from_utf8_lossy(&o.stdout)));
        }
        out
    }

    fn image_path(pid: u32) -> Option<String> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = vec![0u16; 1024];
            let mut len = buf.len() as u32;
            let r = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
            let _ = CloseHandle(h);
            r.ok()?;
            Some(String::from_utf16_lossy(&buf[..len as usize]))
        }
    }

    fn snapshot_name(pid: u32) -> Option<String> {
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
            let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut found = None;
            if Process32FirstW(snap, &mut entry).is_ok() {
                loop {
                    if entry.th32ProcessID == pid {
                        let end = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(0);
                        found = Some(String::from_utf16_lossy(&entry.szExeFile[..end]));
                        break;
                    }
                    if Process32NextW(snap, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
            found
        }
    }

    /// Name and path of a process (as far as Windows tells us).
    pub fn owner(pid: u32) -> Owner {
        let path = image_path(pid);
        let name = path
            .as_deref()
            .and_then(|p| Path::new(p).file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .or_else(|| snapshot_name(pid))
            .unwrap_or_else(|| if pid == 4 { "System".into() } else { "a program".into() });
        Owner { pid, name, path }
    }

    /// Install folder an old installer stored in `HKCU\Software\Georg Hatzmann\<name>` (default value).
    pub fn registry_install_dir(name: &str) -> Option<PathBuf> {
        let key = wide(&format!("Software\\Georg Hatzmann\\{name}"));
        let mut buf = vec![0u16; 1024];
        let mut bytes = (buf.len() * 2) as u32;
        let r = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                PCWSTR(key.as_ptr()),
                PCWSTR::null(),
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr() as *mut _),
                Some(&mut bytes),
            )
        };
        if r != NO_ERROR {
            return None;
        }
        let len = (bytes as usize / 2).min(buf.len());
        let text = String::from_utf16_lossy(&buf[..len]);
        let text = text.trim_end_matches('\0').trim();
        (!text.is_empty()).then(|| PathBuf::from(text))
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn listeners() -> Vec<Listener> {
        Vec::new()
    }
    pub fn owner(pid: u32) -> Owner {
        Owner { pid, name: "a program".into(), path: None }
    }
    pub fn registry_install_dir(_: &str) -> Option<PathBuf> {
        None
    }
}
