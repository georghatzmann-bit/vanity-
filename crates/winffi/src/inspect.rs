//! Nur lesende Beobachtung für den Verhaltensbericht des Labors: Autostart-Einträge der
//! Registrierung, Prozessliste, TCP-Verbindungen je Prozess und Bildschirmfotos (ganzer
//! Bildschirm in der Windows Sandbox, sonst nur Fenster der Labor-Prozesse).

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::AsRawHandle;
use std::ptr;

use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC,
    DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetDIBits, HBITMAP, HDC, ReleaseDC, SRCCOPY,
    SelectObject,
};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, GetExtendedUdpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID,
    MIB_UDP6ROW_OWNER_PID, MIB_UDPROW_OWNER_PID, TCP_TABLE_OWNER_PID_ALL, UDP_TABLE_OWNER_PID,
};
use windows_sys::Win32::Storage::Xps::PrintWindow;
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, HKEY_USERS, KEY_READ, KEY_WOW64_64KEY, REG_DWORD,
    REG_EXPAND_SZ, REG_MULTI_SZ, REG_QWORD, REG_SZ, RegCloseKey, RegEnumKeyExW, RegEnumValueW,
    RegOpenKeyExW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetSystemMetrics, GetWindowRect, GetWindowThreadProcessId, IsHungAppWindow,
    IsWindowVisible, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

use crate::util::{own, wide};

// ---------------------------------------------------------------------------------------
// Registrierung (nur lesen)
// ---------------------------------------------------------------------------------------

/// Wurzel eines Registrierungsschlüssels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Hive {
    /// `HKLM`.
    LocalMachine,
    /// `HKCU` (des aktuellen Threads/Prozesses).
    CurrentUser,
    /// `HKU\<SID>` (Nutzer-Hive aus dem Dienst heraus).
    User(String),
}

impl Hive {
    pub(crate) fn root_and_prefix(&self, subkey: &str) -> (HKEY, String, String) {
        match self {
            Self::LocalMachine => (
                HKEY_LOCAL_MACHINE,
                subkey.to_owned(),
                format!(r"HKLM\{subkey}"),
            ),
            Self::CurrentUser => (
                HKEY_CURRENT_USER,
                subkey.to_owned(),
                format!(r"HKCU\{subkey}"),
            ),
            Self::User(sid) => (
                HKEY_USERS,
                format!(r"{sid}\{subkey}"),
                format!(r"HKU\{sid}\{subkey}"),
            ),
        }
    }
}

/// Ein Registrierungswert (Daten als Text, gekürzt).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct RegValue {
    /// Voller Schlüssel (`HKLM\…`).
    pub key: String,
    /// Wertname (leer = Standardwert).
    pub name: String,
    /// Daten als Text.
    pub data: String,
}

/// Höchstlänge der Daten im Bericht.
const MAX_DATA: usize = 512;

struct Key(HKEY);

impl Drop for Key {
    fn drop(&mut self) {
        // SAFETY: eigener, geöffneter Schlüssel; genau einmal schließen.
        // aegis-unsafe: winffi-reg-close
        #[allow(unsafe_code)]
        let _ = unsafe { RegCloseKey(self.0) };
    }
}

fn open_key(root: HKEY, subkey: &str) -> Option<Key> {
    let name = wide(subkey);
    let mut key: HKEY = ptr::null_mut();
    // SAFETY: `name` nullterminiert; nur Leserechte; Ausgabezeiger gültig.
    // aegis-unsafe: winffi-reg-open
    #[allow(unsafe_code)]
    let status =
        unsafe { RegOpenKeyExW(root, name.as_ptr(), 0, KEY_READ | KEY_WOW64_64KEY, &mut key) };
    (status == 0).then_some(Key(key))
}

fn utf16_text(data: &[u8]) -> String {
    let units: Vec<u16> = data
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let text = String::from_utf16_lossy(&units);
    text.trim_end_matches('\0').replace('\0', " | ")
}

/// Alle Werte eines Schlüssels (nur lesen). Fehlt der Schlüssel: leer.
#[must_use]
pub fn read_values(hive: &Hive, subkey: &str) -> Vec<RegValue> {
    read_values_limited(hive, subkey, 1024, MAX_DATA)
}

/// `ERROR_MORE_DATA`.
const ERROR_MORE_DATA_CODE: u32 = 234;
/// Größter gelesener Einzelwert (Bytes).
const MAX_VALUE_BYTES: usize = 1024 * 1024;

/// Wie [`read_values`], mit eigenen Grenzen (Anzahl Werte, Zeichen je Wert) – z. B. für die
/// vielen, langen Firewall-Regeln.
#[must_use]
pub fn read_values_limited(
    hive: &Hive,
    subkey: &str,
    max_values: u32,
    max_chars: usize,
) -> Vec<RegValue> {
    let (root, path, label) = hive.root_and_prefix(subkey);
    let Some(key) = open_key(root, &path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for index in 0..max_values {
        let mut name = vec![0u16; 16_384];
        let mut name_len;
        let mut data = vec![0u8; 16_384];
        let mut data_len;
        let mut kind = 0u32;
        let mut status;
        loop {
            name_len = u32::try_from(name.len()).unwrap_or(0);
            data_len = u32::try_from(data.len()).unwrap_or(0);
            // SAFETY: Puffer und Längen passen; Schlüssel offen.
            // aegis-unsafe: winffi-reg-enum-value
            #[allow(unsafe_code)]
            let result = unsafe {
                RegEnumValueW(
                    key.0,
                    index,
                    name.as_mut_ptr(),
                    &mut name_len,
                    ptr::null(),
                    &mut kind,
                    data.as_mut_ptr(),
                    &mut data_len,
                )
            };
            status = result;
            // Wert länger als der Puffer (ERROR_MORE_DATA): einmal größer versuchen (bis
            // 1 MiB), sonst nur diesen Wert überspringen – nie die folgenden.
            if status == ERROR_MORE_DATA_CODE
                && data.len() < MAX_VALUE_BYTES
                && usize::try_from(data_len).unwrap_or(usize::MAX) <= MAX_VALUE_BYTES
            {
                data = vec![0u8; MAX_VALUE_BYTES];
                continue;
            }
            break;
        }
        if status == ERROR_MORE_DATA_CODE {
            continue;
        }
        if status != 0 {
            break;
        }
        name.truncate(usize::try_from(name_len).unwrap_or(0));
        data.truncate(usize::try_from(data_len).unwrap_or(0));
        let text = match kind {
            REG_SZ | REG_EXPAND_SZ | REG_MULTI_SZ => utf16_text(&data),
            REG_DWORD if data.len() >= 4 => {
                u32::from_le_bytes([data[0], data[1], data[2], data[3]]).to_string()
            }
            REG_QWORD if data.len() >= 8 => {
                let mut b = [0u8; 8];
                b.copy_from_slice(&data[..8]);
                u64::from_le_bytes(b).to_string()
            }
            _ => format!("({} Byte)", data.len()),
        };
        out.push(RegValue {
            key: label.clone(),
            name: String::from_utf16_lossy(&name),
            data: text.chars().take(max_chars).collect(),
        });
    }
    out
}

/// Namen der Unterschlüssel (nur lesen, höchstens 4096).
#[must_use]
pub fn read_subkeys(hive: &Hive, subkey: &str) -> Vec<String> {
    let (root, path, _) = hive.root_and_prefix(subkey);
    let Some(key) = open_key(root, &path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for index in 0..4096u32 {
        let mut name = vec![0u16; 512];
        let mut len = u32::try_from(name.len()).unwrap_or(0);
        // SAFETY: Puffer/Länge passen; Klasse und Zeit nicht abgefragt (null).
        // aegis-unsafe: winffi-reg-enum-key
        #[allow(unsafe_code)]
        let status = unsafe {
            RegEnumKeyExW(
                key.0,
                index,
                name.as_mut_ptr(),
                &mut len,
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        if status != 0 {
            break;
        }
        name.truncate(usize::try_from(len).unwrap_or(0));
        out.push(String::from_utf16_lossy(&name));
    }
    out
}

/// Bekannte Autostart-Orte eines Nutzer-Hives bzw. von HKLM.
pub const AUTOSTART_KEYS: [&str; 7] = [
    r"Software\Microsoft\Windows\CurrentVersion\Run",
    r"Software\Microsoft\Windows\CurrentVersion\RunOnce",
    r"Software\Microsoft\Windows\CurrentVersion\Policies\Explorer\Run",
    r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run",
    r"Software\Microsoft\Windows NT\CurrentVersion\Winlogon",
    r"Software\Microsoft\Windows NT\CurrentVersion\Windows",
    r"Software\Microsoft\Active Setup\Installed Components",
];

/// Momentaufnahme der Autostart-Einträge (Run-Schlüssel, Winlogon, Dienste mit Programmpfad).
#[must_use]
pub fn autostart_snapshot(user: &Hive) -> BTreeSet<RegValue> {
    let mut out = BTreeSet::new();
    for hive in [&Hive::LocalMachine, user] {
        for key in AUTOSTART_KEYS {
            out.extend(read_values(hive, key));
        }
    }
    let services = r"SYSTEM\CurrentControlSet\Services";
    for name in read_subkeys(&Hive::LocalMachine, services) {
        out.extend(
            read_values(&Hive::LocalMachine, &format!(r"{services}\{name}"))
                .into_iter()
                .filter(|v| v.name.eq_ignore_ascii_case("ImagePath")),
        );
    }
    out
}

// ---------------------------------------------------------------------------------------
// Prozesse und Verbindungen (nur lesen)
// ---------------------------------------------------------------------------------------

/// Ein laufender Prozess.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessInfo {
    /// Prozess-ID.
    pub pid: u32,
    /// Elternprozess.
    pub parent: u32,
    /// Programmname.
    pub name: String,
}

/// Alle laufenden Prozesse.
///
/// # Errors
/// Momentaufnahme nicht möglich.
pub fn processes() -> io::Result<Vec<ProcessInfo>> {
    // SAFETY: nur Prozessliste; Handle wird sofort übernommen.
    // aegis-unsafe: winffi-toolhelp-snapshot
    #[allow(unsafe_code)]
    let snapshot = own(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) })?;
    let mut entry = PROCESSENTRY32W {
        dwSize: u32::try_from(size_of::<PROCESSENTRY32W>()).unwrap_or(0),
        ..Default::default()
    };
    let mut out = Vec::new();
    // SAFETY: gültige Momentaufnahme; `entry.dwSize` gesetzt.
    // aegis-unsafe: winffi-toolhelp-first
    #[allow(unsafe_code)]
    let mut ok = unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) };
    while ok != 0 {
        let end = entry
            .szExeFile
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(entry.szExeFile.len());
        out.push(ProcessInfo {
            pid: entry.th32ProcessID,
            parent: entry.th32ParentProcessID,
            name: OsString::from_wide(&entry.szExeFile[..end])
                .to_string_lossy()
                .into_owned(),
        });
        // SAFETY: wie oben.
        // aegis-unsafe: winffi-toolhelp-next
        #[allow(unsafe_code)]
        let next = unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) };
        ok = next;
    }
    Ok(out)
}

/// TCP-Verbindung eines Prozesses.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct TcpConnection {
    /// Prozess.
    pub pid: u32,
    /// Gegenstelle.
    pub remote: IpAddr,
    /// Port der Gegenstelle.
    pub port: u16,
    /// Zustand (MIB_TCP_STATE).
    pub state: u32,
}

fn tcp_table(family: u32) -> io::Result<Vec<u8>> {
    let mut size = 0u32;
    // SAFETY: Größenabfrage mit null-Puffer.
    // aegis-unsafe: winffi-tcp-size
    #[allow(unsafe_code)]
    let _ = unsafe {
        GetExtendedTcpTable(
            ptr::null_mut(),
            &mut size,
            0,
            family,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    };
    for _ in 0..4 {
        let mut buffer = vec![0u8; usize::try_from(size).unwrap_or(0) + 4096];
        let mut len = u32::try_from(buffer.len()).unwrap_or(u32::MAX);
        // SAFETY: Puffer der angegebenen Länge.
        // aegis-unsafe: winffi-tcp-table
        #[allow(unsafe_code)]
        let status = unsafe {
            GetExtendedTcpTable(
                buffer.as_mut_ptr().cast(),
                &mut len,
                0,
                family,
                TCP_TABLE_OWNER_PID_ALL,
                0,
            )
        };
        if status == 0 {
            buffer.truncate(usize::try_from(len).unwrap_or(0));
            return Ok(buffer);
        }
        size = len;
    }
    Err(io::Error::other("TCP-Tabelle nicht lesbar"))
}

fn port(raw: u32) -> u16 {
    // Port steht in Netzwerk-Byte-Reihenfolge in den unteren 16 Bit.
    u16::from_be(u16::try_from(raw & 0xffff).unwrap_or(0))
}

/// TCP-Verbindungen (IPv4 + IPv6) mit Gegenstelle, je Prozess.
///
/// # Errors
/// Tabelle nicht lesbar.
pub fn tcp_connections() -> io::Result<Vec<TcpConnection>> {
    const AF_INET: u32 = 2;
    const AF_INET6: u32 = 23;
    let mut out = Vec::new();
    let v4 = tcp_table(AF_INET)?;
    let rows = |buffer: &[u8], row: usize| -> usize {
        let count = buffer
            .get(..4)
            .map_or(0, |b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
        usize::try_from(count)
            .unwrap_or(0)
            .min(buffer.len().saturating_sub(4) / row)
    };
    let row4 = size_of::<MIB_TCPROW_OWNER_PID>();
    for i in 0..rows(&v4, row4) {
        let start = 4 + i * row4;
        let field = |k: usize| {
            let b = &v4[start + 4 * k..start + 4 * k + 4];
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        };
        // dwState, dwLocalAddr, dwLocalPort, dwRemoteAddr, dwRemotePort, dwOwningPid
        let remote = Ipv4Addr::from(field(3).to_le_bytes());
        if remote.is_unspecified() {
            continue;
        }
        out.push(TcpConnection {
            pid: field(5),
            remote: IpAddr::V4(remote),
            port: port(field(4)),
            state: field(0),
        });
    }
    if let Ok(v6) = tcp_table(AF_INET6) {
        let row6 = size_of::<MIB_TCP6ROW_OWNER_PID>();
        for i in 0..rows(&v6, row6) {
            let start = 4 + i * row6;
            let row = &v6[start..start + row6];
            let u32_at =
                |o: usize| u32::from_le_bytes([row[o], row[o + 1], row[o + 2], row[o + 3]]);
            // ucLocalAddr[16], LocalScope, LocalPort, ucRemoteAddr[16], RemoteScope, RemotePort, State, Pid
            let mut addr = [0u8; 16];
            addr.copy_from_slice(&row[24..40]);
            let remote = Ipv6Addr::from(addr);
            if remote.is_unspecified() {
                continue;
            }
            out.push(TcpConnection {
                pid: u32_at(52),
                remote: IpAddr::V6(remote),
                port: port(u32_at(44)),
                state: u32_at(48),
            });
        }
    }
    Ok(out)
}

fn udp_table(family: u32) -> io::Result<Vec<u8>> {
    let mut size = 0u32;
    // SAFETY: Größenabfrage mit null-Puffer.
    // aegis-unsafe: winffi-udp-size
    #[allow(unsafe_code)]
    let _ = unsafe {
        GetExtendedUdpTable(
            ptr::null_mut(),
            &mut size,
            0,
            family,
            UDP_TABLE_OWNER_PID,
            0,
        )
    };
    for _ in 0..4 {
        let mut buffer = vec![0u8; usize::try_from(size).unwrap_or(0) + 4096];
        let mut len = u32::try_from(buffer.len()).unwrap_or(u32::MAX);
        // SAFETY: Puffer der angegebenen Länge.
        // aegis-unsafe: winffi-udp-table
        #[allow(unsafe_code)]
        let status = unsafe {
            GetExtendedUdpTable(
                buffer.as_mut_ptr().cast(),
                &mut len,
                0,
                family,
                UDP_TABLE_OWNER_PID,
                0,
            )
        };
        if status == 0 {
            buffer.truncate(usize::try_from(len).unwrap_or(0));
            return Ok(buffer);
        }
        size = len;
    }
    Err(io::Error::other("UDP-Tabelle nicht lesbar"))
}

/// Dateipfade der geladenen Kernel-Treiber in Kernel-Schreibweise (z. B. `\SystemRoot\…`),
/// nur lesend. Braucht Administrator- bzw. Dienstrechte.
///
/// # Errors
/// Liste nicht lesbar.
pub fn loaded_drivers() -> io::Result<Vec<String>> {
    use windows_sys::Win32::System::ProcessStatus::{EnumDeviceDrivers, GetDeviceDriverFileNameW};
    let word = size_of::<*mut core::ffi::c_void>();
    let mut bases: Vec<*mut core::ffi::c_void> = vec![ptr::null_mut(); 1024];
    for _ in 0..4 {
        let bytes = u32::try_from(bases.len() * word).unwrap_or(u32::MAX);
        let mut needed = 0u32;
        // SAFETY: Puffer mit `bytes` Bytes; `needed` ist ein gültiger Zeiger.
        // aegis-unsafe: winffi-drivers-enum
        #[allow(unsafe_code)]
        let ok = unsafe { EnumDeviceDrivers(bases.as_mut_ptr(), bytes, &mut needed) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let count = usize::try_from(needed).unwrap_or(0) / word;
        if count <= bases.len() {
            bases.truncate(count);
            let mut out = BTreeSet::new();
            for base in bases.into_iter().filter(|b| !b.is_null()) {
                let mut name = [0u16; 1024];
                // SAFETY: Puffer von 1024 Zeichen; `base` stammt aus `EnumDeviceDrivers`.
                // aegis-unsafe: winffi-drivers-name
                #[allow(unsafe_code)]
                let len = unsafe { GetDeviceDriverFileNameW(base, name.as_mut_ptr(), 1024) };
                let len = usize::try_from(len).unwrap_or(0).min(name.len());
                if len > 0 {
                    out.insert(String::from_utf16_lossy(&name[..len]));
                }
            }
            return Ok(out.into_iter().collect());
        }
        bases = vec![ptr::null_mut(); count + 64];
    }
    Err(io::Error::other("Treiberliste nicht lesbar"))
}

/// Ein lauschender Port.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Listener {
    /// Port.
    pub port: u16,
    /// `tcp` oder `udp`.
    pub protocol: &'static str,
    /// Auf allen Schnittstellen (0.0.0.0 bzw. ::) – also von außen erreichbar?
    pub all_interfaces: bool,
    /// Prozess.
    pub pid: u32,
}

fn table_rows(buffer: &[u8], row: usize) -> impl Iterator<Item = &[u8]> {
    let count = buffer
        .get(..4)
        .map_or(0, |b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    let count = usize::try_from(count)
        .unwrap_or(0)
        .min(buffer.len().saturating_sub(4) / row.max(1));
    (0..count).map(move |i| &buffer[4 + i * row..4 + (i + 1) * row])
}

fn u32_at(row: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([row[o], row[o + 1], row[o + 2], row[o + 3]])
}

/// Lauschende TCP-Ports und gebundene UDP-Ports (IPv4 + IPv6), nur lesend.
///
/// # Errors
/// Keine der Tabellen lesbar.
pub fn listening_ports() -> io::Result<Vec<Listener>> {
    const AF_INET: u32 = 2;
    const AF_INET6: u32 = 23;
    const LISTEN: u32 = 2;
    let mut out = BTreeSet::new();
    let mut any = false;
    if let Ok(v4) = tcp_table(AF_INET) {
        any = true;
        // dwState, dwLocalAddr, dwLocalPort, dwRemoteAddr, dwRemotePort, dwOwningPid
        for row in table_rows(&v4, size_of::<MIB_TCPROW_OWNER_PID>()) {
            if u32_at(row, 0) == LISTEN {
                out.insert(Listener {
                    port: port(u32_at(row, 8)),
                    protocol: "tcp",
                    all_interfaces: u32_at(row, 4) == 0,
                    pid: u32_at(row, 20),
                });
            }
        }
    }
    if let Ok(v6) = tcp_table(AF_INET6) {
        any = true;
        for row in table_rows(&v6, size_of::<MIB_TCP6ROW_OWNER_PID>()) {
            if u32_at(row, 48) == LISTEN {
                out.insert(Listener {
                    port: port(u32_at(row, 20)),
                    protocol: "tcp",
                    all_interfaces: row[..16].iter().all(|b| *b == 0),
                    pid: u32_at(row, 52),
                });
            }
        }
    }
    if let Ok(v4) = udp_table(AF_INET) {
        any = true;
        // dwLocalAddr, dwLocalPort, dwOwningPid
        for row in table_rows(&v4, size_of::<MIB_UDPROW_OWNER_PID>()) {
            out.insert(Listener {
                port: port(u32_at(row, 4)),
                protocol: "udp",
                all_interfaces: u32_at(row, 0) == 0,
                pid: u32_at(row, 8),
            });
        }
    }
    if let Ok(v6) = udp_table(AF_INET6) {
        any = true;
        // ucLocalAddr[16], dwLocalScopeId, dwLocalPort, dwOwningPid
        for row in table_rows(&v6, size_of::<MIB_UDP6ROW_OWNER_PID>()) {
            out.insert(Listener {
                port: port(u32_at(row, 20)),
                protocol: "udp",
                all_interfaces: row[..16].iter().all(|b| *b == 0),
                pid: u32_at(row, 24),
            });
        }
    }
    if !any {
        return Err(io::Error::other("Port-Tabellen nicht lesbar"));
    }
    Ok(out.into_iter().collect())
}

// ---------------------------------------------------------------------------------------
// Bildschirmfotos (nur lesen)
// ---------------------------------------------------------------------------------------

/// Ein Bild (BGRA, Zeilen von oben nach unten).
#[derive(Debug, Clone)]
pub struct Capture {
    /// Breite.
    pub width: u32,
    /// Höhe.
    pub height: u32,
    /// Pixel (B, G, R, A).
    pub bgra: Vec<u8>,
}

/// Größte Kantenlänge eines Bildes.
const MAX_EDGE: i32 = 4096;

struct ScreenDc(HDC);
impl Drop for ScreenDc {
    fn drop(&mut self) {
        // SAFETY: von GetDC(null) geliefert; genau einmal freigeben.
        // aegis-unsafe: winffi-capture-release-dc
        #[allow(unsafe_code)]
        let _ = unsafe { ReleaseDC(ptr::null_mut(), self.0) };
    }
}

struct MemDc(HDC, HBITMAP);
impl Drop for MemDc {
    fn drop(&mut self) {
        // SAFETY: eigene, gültige Objekte; je einmal löschen.
        // aegis-unsafe: winffi-capture-delete
        #[allow(unsafe_code)]
        unsafe {
            let _ = DeleteObject(self.1);
            let _ = DeleteDC(self.0);
        }
    }
}

fn read_bitmap(dc: HDC, bitmap: HBITMAP, width: i32, height: i32) -> io::Result<Capture> {
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: u32::try_from(size_of::<BITMAPINFOHEADER>()).unwrap_or(40),
            biWidth: width,
            biHeight: -height, // von oben nach unten
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..Default::default()
        },
        ..Default::default()
    };
    let w = u32::try_from(width).unwrap_or(0);
    let h = u32::try_from(height).unwrap_or(0);
    let mut bgra = vec![0u8; usize::try_from(w * h * 4).unwrap_or(0)];
    // SAFETY: Puffer hat Breite×Höhe×4 Byte (32 bpp); `info` beschreibt genau das.
    // aegis-unsafe: winffi-capture-dibits
    #[allow(unsafe_code)]
    let lines = unsafe {
        GetDIBits(
            dc,
            bitmap,
            0,
            h,
            bgra.as_mut_ptr().cast(),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    if lines == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Capture {
        width: w,
        height: h,
        bgra,
    })
}

fn mem_dc(screen: HDC, width: i32, height: i32) -> io::Result<MemDc> {
    // SAFETY: `screen` gültig; neue, eigene Objekte.
    // aegis-unsafe: winffi-capture-mem-dc
    #[allow(unsafe_code)]
    let (dc, bitmap) = unsafe {
        let dc = CreateCompatibleDC(screen);
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        if !dc.is_null() && !bitmap.is_null() {
            let _ = SelectObject(dc, bitmap);
        }
        (dc, bitmap)
    };
    if dc.is_null() || bitmap.is_null() {
        return Err(io::Error::other("Bildspeicher nicht anlegbar"));
    }
    Ok(MemDc(dc, bitmap))
}

/// Bildschirmfoto des ganzen (virtuellen) Bildschirms – für die Sonde in der Windows Sandbox.
///
/// # Errors
/// Kein Bildschirm verfügbar.
pub fn capture_screen() -> io::Result<Capture> {
    // SAFETY: einfache Abfragen ohne Zeiger.
    // aegis-unsafe: winffi-capture-metrics
    #[allow(unsafe_code)]
    let (x, y, w, h) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN).min(MAX_EDGE),
            GetSystemMetrics(SM_CYVIRTUALSCREEN).min(MAX_EDGE),
        )
    };
    if w <= 0 || h <= 0 {
        return Err(io::Error::other("kein Bildschirm"));
    }
    // SAFETY: DC des Bildschirms; wird von `ScreenDc` freigegeben.
    // aegis-unsafe: winffi-capture-get-dc
    #[allow(unsafe_code)]
    let screen = ScreenDc(unsafe { GetDC(ptr::null_mut()) });
    if screen.0.is_null() {
        return Err(io::Error::other("kein Bildschirm"));
    }
    let mem = mem_dc(screen.0, w, h)?;
    // SAFETY: beide DCs gültig; Kopie innerhalb der Größe.
    // aegis-unsafe: winffi-capture-bitblt
    #[allow(unsafe_code)]
    let ok = unsafe { BitBlt(mem.0, 0, 0, w, h, screen.0, x, y, SRCCOPY) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    read_bitmap(mem.0, mem.1, w, h)
}

// SAFETY: Rückruf für EnumWindows; Windows ruft ihn nur während des Aufrufs mit dem
// übergebenen `lparam` auf.
// aegis-unsafe: winffi-enum-windows-callback
#[allow(unsafe_code)]
unsafe extern "system" fn collect_window(hwnd: HWND, lparam: LPARAM) -> windows_sys::core::BOOL {
    // SAFETY: `lparam` ist der Zeiger auf das `Vec<HWND>` aus `windows_of`, das während
    // EnumWindows lebt und nur hier verändert wird.
    // aegis-unsafe: winffi-enum-windows-collect
    #[allow(unsafe_code)]
    let list = unsafe { &mut *(lparam as *mut Vec<HWND>) };
    if list.len() < 4096 {
        list.push(hwnd);
    }
    1
}

/// Sichtbare Fenster der angegebenen Prozesse.
fn windows_of(pids: &[u32]) -> Vec<HWND> {
    let mut all: Vec<HWND> = Vec::new();
    // SAFETY: Rückruf sammelt nur Handles in `all`, das bis nach dem Aufruf lebt.
    // aegis-unsafe: winffi-enum-windows
    #[allow(unsafe_code)]
    let _ = unsafe { EnumWindows(Some(collect_window), (&raw mut all) as LPARAM) };
    all.into_iter()
        .filter(|&hwnd| {
            let mut pid = 0u32;
            // SAFETY: Fenster-Handle aus EnumWindows; Ausgabezeiger gültig.
            // aegis-unsafe: winffi-window-pid
            #[allow(unsafe_code)]
            let visible = unsafe {
                GetWindowThreadProcessId(hwnd, &mut pid);
                IsWindowVisible(hwnd) != 0
            };
            visible && pids.contains(&pid)
        })
        .collect()
}

/// AppContainer-SID eines Prozesses (`None`: kein AppContainer oder nicht abfragbar).
#[must_use]
pub fn process_appcontainer_sid(pid: u32) -> Option<String> {
    use windows_sys::Win32::Security::{
        GetTokenInformation, TOKEN_APPCONTAINER_INFORMATION, TOKEN_QUERY, TokenAppContainerSid,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: Nur Abfrage-Recht; das Handle wird sofort übernommen.
    // aegis-unsafe: winffi-open-process-appcontainer
    #[allow(unsafe_code)]
    let process = own(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) }).ok()?;
    let mut token = ptr::null_mut();
    // SAFETY: gültiges Prozess-Handle; nur TOKEN_QUERY; Ausgabezeiger gültig.
    // aegis-unsafe: winffi-process-token-appcontainer
    #[allow(unsafe_code)]
    let ok = unsafe { OpenProcessToken(process.as_raw_handle(), TOKEN_QUERY, &mut token) };
    if ok == 0 {
        return None;
    }
    let token = own(token).ok()?;
    // TOKEN_APPCONTAINER_INFORMATION + SID passen in 256 Byte; u64-Ausrichtung.
    let mut buffer = [0u64; 32];
    let mut needed = 0u32;
    // SAFETY: gültiges Token mit TOKEN_QUERY; Puffer groß genug und ausgerichtet.
    // aegis-unsafe: winffi-token-appcontainer-sid
    #[allow(unsafe_code)]
    let ok = unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenAppContainerSid,
            buffer.as_mut_ptr().cast(),
            u32::try_from(size_of_val(&buffer)).unwrap_or(256),
            &mut needed,
        )
    };
    if ok == 0 {
        return None;
    }
    // SAFETY: GetTokenInformation hat die Struktur an den Pufferanfang geschrieben; die SID
    // liegt im selben Puffer, der bis zum Ende lebt.
    // aegis-unsafe: winffi-token-appcontainer-read
    #[allow(unsafe_code)]
    let info = unsafe { &*buffer.as_ptr().cast::<TOKEN_APPCONTAINER_INFORMATION>() };
    if info.TokenAppContainer.is_null() {
        return None;
    }
    crate::pipe::sid_to_string(info.TokenAppContainer).ok()
}

/// Bildschirmfotos der sichtbaren Fenster der Labor-Prozesse (höchstens `max`).
#[must_use]
pub fn capture_windows(pids: &[u32], max: usize) -> Vec<Capture> {
    const PW_RENDERFULLCONTENT: u32 = 2;
    let mut out = Vec::new();
    // SAFETY: DC des Bildschirms; wird von `ScreenDc` freigegeben.
    // aegis-unsafe: winffi-capture-window-dc
    #[allow(unsafe_code)]
    let screen = ScreenDc(unsafe { GetDC(ptr::null_mut()) });
    if screen.0.is_null() {
        return out;
    }
    for hwnd in windows_of(pids).into_iter().take(max) {
        // Hängende Fenster nicht anfragen (PrintWindow würde blockieren).
        // SAFETY: Fenster-Handle aus EnumWindows; nur Abfrage.
        // aegis-unsafe: winffi-window-hung
        #[allow(unsafe_code)]
        if unsafe { IsHungAppWindow(hwnd) } != 0 {
            continue;
        }
        let mut rect = RECT::default();
        // SAFETY: gültiges Fenster-Handle; Ausgabezeiger gültig.
        // aegis-unsafe: winffi-window-rect
        #[allow(unsafe_code)]
        let ok = unsafe { GetWindowRect(hwnd, &mut rect) };
        let (w, h) = (
            (rect.right - rect.left).min(MAX_EDGE),
            (rect.bottom - rect.top).min(MAX_EDGE),
        );
        if ok == 0 || w <= 0 || h <= 0 {
            continue;
        }
        let Ok(mem) = mem_dc(screen.0, w, h) else {
            continue;
        };
        // SAFETY: Fenster und Speicher-DC gültig; das Fenster zeichnet nur in unseren DC.
        // aegis-unsafe: winffi-print-window
        #[allow(unsafe_code)]
        let printed = unsafe { PrintWindow(hwnd, mem.0, PW_RENDERFULLCONTENT) };
        if printed != 0
            && let Ok(capture) = read_bitmap(mem.0, mem.1, w, h)
        {
            out.push(capture);
        }
    }
    out
}
