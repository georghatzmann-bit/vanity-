//! Admin-Helfer: die wenigen Änderungen, die Adminrechte brauchen (DNS der Hauptverbindung,
//! `nagle`, `netThrottle`), laufen über einen kurzen zweiten Start von Pulsar mit Adminrechten.
//!
//! Ablauf (Vertrag in `docs/API.md`, Abschnitt „Admin-Helfer“):
//! - Der Auftrag ([`ElevatedTask`]) wird als JSON → Hex-Text übergeben:
//!   `Pulsar.exe --elevated <hex>` (höchstens 16 KiB, keine Skripte, keine temporären Dateien).
//! - Windows fragt einmal nach (UAC). Lehnt man ab, ändert sich nichts.
//! - Der Helfer prüft den Auftrag selbst noch einmal vollständig ([`validate`]) und führt nur fest
//!   erlaubte Änderungen aus: DNS-Server (Adapter-GUID, Adressen der passenden Familie) und drei
//!   DWORD-Werte unter HKLM. Danach beendet er sich sofort (Exit-Code 0/10/20/30).
//! - Läuft Pulsar schon mit Adminrechten, wird der Auftrag direkt im eigenen Prozess ausgeführt.
//!
//! Der Aufrufer prüft danach selbst (ohne Adminrechte) durch erneutes Lesen, ob alles angekommen ist.
#![cfg_attr(not(windows), allow(dead_code))]

use std::ffi::OsString;
use std::net::IpAddr;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::LockExt;

/// Höchstens so viele DNS-Änderungen je Auftrag.
pub const MAX_DNS_OPS: usize = 4;
/// Höchstens so viele Registrierungs-Änderungen je Auftrag.
pub const MAX_REG_OPS: usize = 8;
/// Höchstens so viele Adressen je Adressfamilie.
pub const MAX_ADDRS: usize = 3;
/// Höchstlänge des Hex-Arguments (16 KiB).
pub const MAX_HEX_LEN: usize = 16 * 1024;
/// So lange wartet Pulsar höchstens auf das Ende des Helfers.
pub const HELPER_TIMEOUT_MS: u32 = 60_000;

/// Exit-Codes des Helfers.
pub const EXIT_OK: i32 = 0;
pub const EXIT_FAILED: i32 = 10;
pub const EXIT_INVALID: i32 = 20;
pub const EXIT_UNSUPPORTED: i32 = 30;

/// Netzwerkadapter-Einstellungen für IPv4 (je Adapter ein Unterschlüssel `{GUID}`).
pub const KEY_INTERFACES: &str = r"SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces";
/// Netzwerkadapter-Einstellungen für IPv6 (nur für Tests; DNS wird über die API gesetzt).
#[cfg_attr(not(test), allow(dead_code))]
pub const KEY_INTERFACES6: &str = r"SYSTEM\CurrentControlSet\Services\Tcpip6\Parameters\Interfaces";
/// Multimedia-Einstellungen (Netzwerk-Drosselung).
pub const KEY_SYSTEM_PROFILE: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile";
pub const VAL_TCP_ACK: &str = "TcpAckFrequency";
pub const VAL_NO_DELAY: &str = "TCPNoDelay";
pub const VAL_THROTTLE: &str = "NetworkThrottlingIndex";

/// Meldung, wenn die Windows-Abfrage abgelehnt wurde.
pub const MSG_DECLINED: &str = "Du hast die Windows-Abfrage abgelehnt – es wurde nichts geändert.";
/// Meldung, wenn `SetInterfaceDnsSettings` fehlt.
pub const MSG_NEEDS_2004: &str = "Dafür braucht es Windows 10 Version 2004 oder neuer.";
/// Meldung bei Exit-Code 10.
pub const MSG_PARTLY: &str = "Windows hat nicht alle Änderungen übernommen.";
/// Einheitliche Meldung außerhalb von Windows.
#[cfg_attr(windows, allow(dead_code))]
pub const NOT_WINDOWS: &str = "Nur unter Windows verfügbar.";

// =============================================================================================
// Auftrag
// =============================================================================================

/// Ein Auftrag an den Admin-Helfer.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ElevatedTask {
    #[serde(default)]
    pub dns: Vec<DnsOp>,
    #[serde(default)]
    pub reg: Vec<RegOp>,
}

impl ElevatedTask {
    pub fn is_empty(&self) -> bool {
        self.dns.is_empty() && self.reg.is_empty()
    }
}

/// DNS-Server eines Adapters setzen. `None` = unverändert, leere Liste = automatisch (DHCP).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DnsOp {
    /// Adapter-GUID mit Klammern: `{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}`
    pub adapter: String,
    #[serde(default)]
    pub v4: Option<Vec<String>>,
    #[serde(default)]
    pub v6: Option<Vec<String>>,
}

/// Einen DWORD-Wert unter HKLM setzen (`Some`) oder löschen (`None`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegOp {
    pub key: String,
    pub name: String,
    #[serde(default)]
    pub value: Option<u32>,
}

/// Ist `s` eine Adapter-GUID mit Klammern (`{8-4-4-4-12}`, Hexziffern)?
pub fn is_braced_guid(s: &str) -> bool {
    s.len() == 38
        && s.starts_with('{')
        && s.ends_with('}')
        && s.get(1..37).is_some_and(crate::opt::power::is_guid)
}

/// Adapter-GUID `{…}` als Zahl (Reihenfolge wie im Text, passend zu `GUID::from_u128`).
pub fn parse_guid(s: &str) -> Option<u128> {
    if !is_braced_guid(s) {
        return None;
    }
    let hex: String = s[1..37].chars().filter(|c| *c != '-').collect();
    u128::from_str_radix(&hex, 16).ok()
}

/// Was ein erlaubter Registrierungs-Auftrag ändert.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegTarget {
    /// `TcpAckFrequency`/`TCPNoDelay` am Adapter mit dieser GUID
    Interface(String),
    /// `NetworkThrottlingIndex`
    SystemProfile,
}

/// Prüft Schlüssel und Namen gegen die feste Erlaubnisliste (ohne Groß-/Kleinschreibung).
/// Beim Adapter-Schlüssel muss der letzte Teil genau eine GUID sein – damit sind `..`,
/// zusätzliche Pfadteile, Leerzeichen und Backslashes am Rand ausgeschlossen.
pub fn reg_target(key: &str, name: &str) -> Option<RegTarget> {
    if key.eq_ignore_ascii_case(KEY_SYSTEM_PROFILE) && name.eq_ignore_ascii_case(VAL_THROTTLE) {
        return Some(RegTarget::SystemProfile);
    }
    let prefix_len = KEY_INTERFACES.len();
    let head = key.get(..prefix_len)?;
    if !head.eq_ignore_ascii_case(KEY_INTERFACES) {
        return None;
    }
    let rest = key.get(prefix_len..)?.strip_prefix('\\')?;
    if !is_braced_guid(rest) {
        return None;
    }
    if name.eq_ignore_ascii_case(VAL_TCP_ACK) || name.eq_ignore_ascii_case(VAL_NO_DELAY) {
        Some(RegTarget::Interface(rest.to_string()))
    } else {
        None
    }
}

fn check_addrs(list: &Option<Vec<String>>, ipv6: bool) -> Result<(), String> {
    let Some(list) = list else { return Ok(()) };
    let family = if ipv6 { "IPv6" } else { "IPv4" };
    if list.len() > MAX_ADDRS {
        return Err(format!("Zu viele {family}-Adressen (höchstens {MAX_ADDRS})."));
    }
    let mut seen: Vec<IpAddr> = Vec::with_capacity(list.len());
    for a in list {
        let ip: IpAddr = a.parse().map_err(|_| format!("Ungültige {family}-Adresse: {a:?}"))?;
        if ip.is_ipv6() != ipv6 {
            return Err(format!("Falsche Adressfamilie: {a:?} ist keine {family}-Adresse."));
        }
        // Nur die übliche Schreibweise (keine Leerzeichen, Anführungszeichen, Nullen davor …)
        if ip.to_string() != *a {
            return Err(format!("Ungewöhnliche Schreibweise der Adresse: {a:?}"));
        }
        if seen.contains(&ip) {
            return Err(format!("Doppelte Adresse: {a}"));
        }
        seen.push(ip);
    }
    Ok(())
}

/// Prüft einen Auftrag vollständig (Grenzen, GUID-Muster, Adressfamilien, Erlaubnisliste).
pub fn validate(task: &ElevatedTask) -> Result<(), String> {
    if task.dns.len() > MAX_DNS_OPS {
        return Err(format!("Zu viele DNS-Änderungen (höchstens {MAX_DNS_OPS})."));
    }
    if task.reg.len() > MAX_REG_OPS {
        return Err(format!("Zu viele Registrierungs-Änderungen (höchstens {MAX_REG_OPS})."));
    }
    let mut adapters: Vec<String> = Vec::new();
    for op in &task.dns {
        if !is_braced_guid(&op.adapter) {
            return Err(format!("Ungültige Adapter-GUID: {:?}", op.adapter));
        }
        let id = op.adapter.to_ascii_lowercase();
        if adapters.contains(&id) {
            return Err(format!("Adapter doppelt im Auftrag: {}", op.adapter));
        }
        adapters.push(id);
        check_addrs(&op.v4, false)?;
        check_addrs(&op.v6, true)?;
    }
    let mut seen: Vec<(String, String)> = Vec::new();
    for op in &task.reg {
        if reg_target(&op.key, &op.name).is_none() {
            return Err(format!("Nicht erlaubter Registrierungswert: {:?} {:?}", op.key, op.name));
        }
        let id = (op.key.to_ascii_lowercase(), op.name.to_ascii_lowercase());
        if seen.contains(&id) {
            return Err(format!("Registrierungswert doppelt im Auftrag: {}\\{}", op.key, op.name));
        }
        seen.push(id);
    }
    Ok(())
}

/// Auftrag → JSON → Hex-Text (für die Befehlszeile).
pub fn encode(task: &ElevatedTask) -> Result<String, String> {
    let json = serde_json::to_vec(task).map_err(|e| format!("Der Auftrag konnte nicht verpackt werden: {e}"))?;
    let hex = hex::encode(json);
    if hex.len() > MAX_HEX_LEN {
        return Err("Der Auftrag ist zu groß.".into());
    }
    Ok(hex)
}

/// Hex-Text → JSON → Auftrag. Höchstens 16 KiB, unbekannte Felder sind ein Fehler.
pub fn decode(hex_text: &str) -> Result<ElevatedTask, String> {
    if hex_text.len() > MAX_HEX_LEN {
        return Err("Der Auftrag ist zu groß.".into());
    }
    let bytes = hex::decode(hex_text).map_err(|_| "Der Auftrag ist kein gültiger Hex-Text.".to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| format!("Der Auftrag ist ungültig: {e}"))
}

// =============================================================================================
// Fehler und Exit-Codes
// =============================================================================================

/// Warum der Admin-Helfer nicht (vollständig) geklappt hat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ElevateError {
    /// Windows-Abfrage abgelehnt – nichts geändert
    Declined,
    /// Mindestens eine Änderung ist fehlgeschlagen (Text für die Oberfläche)
    Failed(String),
    /// Auf diesem System nicht möglich (Text für die Oberfläche)
    Unsupported(String),
}

impl std::fmt::Display for ElevateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ElevateError::Declined => f.write_str(MSG_DECLINED),
            ElevateError::Failed(m) | ElevateError::Unsupported(m) => f.write_str(m),
        }
    }
}

/// Exit-Code des Helfers → Ergebnis.
pub fn from_exit_code(code: u32) -> Result<(), ElevateError> {
    match code {
        0 => Ok(()),
        10 => Err(ElevateError::Failed(MSG_PARTLY.into())),
        20 => Err(ElevateError::Failed("Der Admin-Helfer hat den Auftrag als ungültig abgelehnt.".into())),
        30 => Err(ElevateError::Unsupported(MSG_NEEDS_2004.into())),
        other => Err(ElevateError::Failed(format!("Der Admin-Helfer wurde unerwartet beendet (Code {other})."))),
    }
}

/// Ergebnis der Ausführung → Exit-Code des Helfers.
pub fn exit_code(result: &Result<(), ElevateError>) -> i32 {
    match result {
        Ok(()) => EXIT_OK,
        Err(ElevateError::Unsupported(_)) => EXIT_UNSUPPORTED,
        Err(_) => EXIT_FAILED,
    }
}

// =============================================================================================
// Ausführen
// =============================================================================================

/// Schnittstelle zum Admin-Helfer – für Tests austauschbar.
pub trait Elevator {
    fn run(&self, task: &ElevatedTask) -> Result<(), ElevateError>;
}

/// Der echte Admin-Helfer (Windows-Abfrage bzw. direkt, wenn Pulsar schon Adminrechte hat).
pub struct RealElevator;

impl Elevator for RealElevator {
    fn run(&self, task: &ElevatedTask) -> Result<(), ElevateError> {
        run(task)
    }
}

/// Es läuft immer nur ein Helfer gleichzeitig.
static RUN_LOCK: Mutex<()> = Mutex::new(());

/// Auftrag ausführen (blockierend). Ein leerer Auftrag ändert nichts und fragt nicht nach.
pub fn run(task: &ElevatedTask) -> Result<(), ElevateError> {
    validate(task).map_err(|e| ElevateError::Failed(format!("Interner Fehler – ungültiger Auftrag: {e}")))?;
    if task.is_empty() {
        return Ok(());
    }
    let _guard = RUN_LOCK.lock_safe();
    #[cfg(windows)]
    {
        if crate::appinfo::is_elevated() {
            win::execute(task)
        } else {
            win::spawn_elevated(task)
        }
    }
    #[cfg(not(windows))]
    {
        Err(ElevateError::Unsupported(NOT_WINDOWS.into()))
    }
}

/// Kann Pulsar hier den DNS ändern (`SetInterfaceDnsSettings` vorhanden)?
pub fn dns_api_available() -> bool {
    #[cfg(windows)]
    {
        win::dns_api().is_some()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

// =============================================================================================
// Befehlszeile
// =============================================================================================

/// Erkannte Sonder-Aufrufe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cli<'a> {
    /// `--elevated <hex>`; `None` = Argument fehlt oder ist unbrauchbar
    Elevated(Option<&'a str>),
    /// `--revert-all`
    RevertAll,
}

/// Befehlszeile ohne den Programmnamen auswerten. Nur das erste Argument zählt.
pub fn parse_cli(args: &[OsString]) -> Option<Cli<'_>> {
    match args.first().and_then(|a| a.to_str()) {
        Some("--elevated") => {
            let hex = if args.len() == 2 { args.get(1).and_then(|a| a.to_str()) } else { None };
            Some(Cli::Elevated(hex))
        }
        Some("--revert-all") => Some(Cli::RevertAll),
        _ => None,
    }
}

/// Ganz am Anfang von `run()` aufrufen: `Some(code)` = Sonder-Aufruf erledigt, Prozess beenden.
pub fn cli_main() -> Option<i32> {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    match parse_cli(&args)? {
        Cli::Elevated(hex) => Some(helper_main(hex)),
        Cli::RevertAll => Some(crate::uninstall::main()),
    }
}

/// Der Helfer selbst: Auftrag lesen, vollständig prüfen, ausführen.
fn helper_main(hex_text: Option<&str>) -> i32 {
    let Some(hex_text) = hex_text else {
        eprintln!("Admin-Helfer: Auftrag fehlt.");
        return EXIT_INVALID;
    };
    let task = match decode(hex_text).and_then(|t| validate(&t).map(|_| t)) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("Admin-Helfer: {e}");
            return EXIT_INVALID;
        }
    };
    #[cfg(windows)]
    {
        let result = win::execute(&task);
        if let Err(e) = &result {
            eprintln!("Admin-Helfer: {e}");
        }
        exit_code(&result)
    }
    #[cfg(not(windows))]
    {
        let _ = task;
        eprintln!("Admin-Helfer: {NOT_WINDOWS}");
        EXIT_UNSUPPORTED
    }
}

// =============================================================================================
// Windows
// =============================================================================================

#[cfg(windows)]
mod win {
    use std::os::windows::ffi::OsStrExt;
    use std::sync::OnceLock;

    use windows::core::{s, w, GUID, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows::Win32::NetworkManagement::IpHelper::{
        DNS_INTERFACE_SETTINGS, DNS_INTERFACE_SETTINGS_VERSION1, DNS_SETTING_IPV6, DNS_SETTING_NAMESERVER,
    };
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32};
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    use super::*;

    /// `SetInterfaceDnsSettings` (iphlpapi, ab Windows 10 2004).
    type SetDnsFn = unsafe extern "system" fn(GUID, *const DNS_INTERFACE_SETTINGS) -> u32;

    /// Zur Laufzeit laden, damit Pulsar auch auf älteren Systemen startet.
    pub fn dns_api() -> Option<SetDnsFn> {
        static API: OnceLock<Option<SetDnsFn>> = OnceLock::new();
        *API.get_or_init(|| {
            // SAFETY: iphlpapi.dll wird nur aus System32 geladen und nie wieder freigegeben; die
            // Signatur entspricht der Windows-Dokumentation von SetInterfaceDnsSettings.
            unsafe {
                let module = LoadLibraryExW(w!("iphlpapi.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32).ok()?;
                let proc = GetProcAddress(module, s!("SetInterfaceDnsSettings"))?;
                Some(std::mem::transmute::<unsafe extern "system" fn() -> isize, SetDnsFn>(proc))
            }
        })
    }

    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// Auftrag mit Adminrechten in einem zweiten Pulsar-Prozess ausführen (Windows-Abfrage).
    pub fn spawn_elevated(task: &ElevatedTask) -> Result<(), ElevateError> {
        let hex_text = encode(task).map_err(ElevateError::Failed)?;
        let exe = std::env::current_exe()
            .map_err(|e| ElevateError::Failed(format!("Pulsar konnte sich selbst nicht finden: {e}")))?;
        let file = wide(exe.as_os_str());
        let dir = exe.parent().map(|d| wide(d.as_os_str()));
        let params = wide(std::ffi::OsStr::new(&format!("--elevated {hex_text}")));

        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
            lpVerb: w!("runas"),
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(params.as_ptr()),
            lpDirectory: dir.as_ref().map(|d| PCWSTR(d.as_ptr())).unwrap_or(PCWSTR::null()),
            nShow: SW_HIDE.0,
            ..Default::default()
        };
        // SAFETY: Alle Texte sind nullterminiert und leben bis nach dem Aufruf.
        if let Err(e) = unsafe { ShellExecuteExW(&mut info) } {
            // ERROR_CANCELLED (1223): Windows-Abfrage abgelehnt
            if (e.code().0 as u32) & 0xFFFF == 1223 {
                return Err(ElevateError::Declined);
            }
            return Err(ElevateError::Failed(format!("Der Admin-Helfer konnte nicht gestartet werden: {}", e.message())));
        }
        let process = info.hProcess;
        if process.is_invalid() {
            return Err(ElevateError::Failed("Der Admin-Helfer konnte nicht gestartet werden.".into()));
        }
        // SAFETY: `process` ist ein gültiges Prozess-Handle und wird in jedem Fall geschlossen.
        let (waited, code) = unsafe {
            let waited = WaitForSingleObject(process, HELPER_TIMEOUT_MS);
            let mut code = 0u32;
            let got = GetExitCodeProcess(process, &mut code).is_ok();
            let _ = CloseHandle(process);
            (waited == WAIT_OBJECT_0 && got, code)
        };
        if !waited {
            return Err(ElevateError::Failed("Der Admin-Helfer hat nicht rechtzeitig geantwortet.".into()));
        }
        from_exit_code(code)
    }

    /// Auftrag im eigenen Prozess ausführen (Pulsar hat hier Adminrechte). Jede Änderung einzeln,
    /// Fehler werden gesammelt.
    pub fn execute(task: &ElevatedTask) -> Result<(), ElevateError> {
        let api = if task.dns.is_empty() {
            None
        } else {
            // Fehlt die Funktion, wird gar nichts geändert
            Some(dns_api().ok_or_else(|| ElevateError::Unsupported(MSG_NEEDS_2004.into()))?)
        };
        let mut errors: Vec<String> = Vec::new();
        if let Some(api) = api {
            for op in &task.dns {
                let Some(guid) = parse_guid(&op.adapter) else {
                    errors.push(format!("Ungültige Adapter-GUID: {}", op.adapter));
                    continue;
                };
                let guid = GUID::from_u128(guid);
                for (list, ipv6) in [(&op.v4, false), (&op.v6, true)] {
                    if let Some(list) = list {
                        if let Err(e) = set_dns(api, guid, list, ipv6) {
                            errors.push(e);
                        }
                    }
                }
            }
        }
        for op in &task.reg {
            if let Err(e) = write_reg(op) {
                errors.push(e);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(ElevateError::Failed(errors.join(" ")))
        }
    }

    /// DNS-Server einer Adressfamilie setzen (leere Liste = automatisch).
    fn set_dns(api: SetDnsFn, guid: GUID, addrs: &[String], ipv6: bool) -> Result<(), String> {
        let mut text: Vec<u16> = addrs.join(",").encode_utf16().chain(std::iter::once(0)).collect();
        let flags = DNS_SETTING_NAMESERVER | if ipv6 { DNS_SETTING_IPV6 } else { 0 };
        let settings = DNS_INTERFACE_SETTINGS {
            Version: DNS_INTERFACE_SETTINGS_VERSION1,
            Flags: u64::from(flags),
            NameServer: PWSTR(text.as_mut_ptr()),
            ..Default::default()
        };
        // SAFETY: `settings` und der Text-Puffer leben bis nach dem Aufruf.
        let rc = unsafe { api(guid, &settings) };
        drop(text);
        if rc == 0 {
            Ok(())
        } else {
            let family = if ipv6 { "IPv6" } else { "IPv4" };
            Err(format!("Die {family}-DNS-Server konnten nicht eingestellt werden (Fehler {rc})."))
        }
    }

    /// DWORD unter HKLM setzen oder löschen. Der Schlüssel wird nur geöffnet, nie angelegt.
    fn write_reg(op: &RegOp) -> Result<(), String> {
        use std::io::ErrorKind;
        use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_SET_VALUE, KEY_WOW64_64KEY};
        use winreg::RegKey;

        let path = format!("HKLM\\{}\\{}", op.key, op.name);
        let key = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(&op.key, KEY_SET_VALUE | KEY_WOW64_64KEY)
            .map_err(|e| match e.kind() {
                ErrorKind::NotFound => format!("Der Registrierungsschlüssel für {path} fehlt."),
                _ => format!("{path} konnte nicht geöffnet werden: {e}"),
            })?;
        match op.value {
            Some(v) => key.set_value(&op.name, &v).map_err(|e| format!("{path} konnte nicht gesetzt werden: {e}")),
            None => match key.delete_value(&op.name) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("{path} konnte nicht gelöscht werden: {e}")),
            },
        }
    }
}

// =============================================================================================
// Tests: Admin-Helfer im Speicher
// =============================================================================================

/// Test-Helfer: wendet Aufträge auf eine Registrierung im Speicher an (DNS als `NameServer` wie
/// unter Windows) und zählt die Aufrufe.
#[cfg(test)]
pub struct MemElevator<'a> {
    pub reg: &'a crate::opt::registry::MemRegistry,
    pub calls: std::cell::Cell<u32>,
    pub tasks: std::cell::RefCell<Vec<ElevatedTask>>,
    /// Windows-Abfrage ablehnen
    pub decline: std::cell::Cell<bool>,
    /// Fehler melden, nichts ändern
    pub fail: std::cell::Cell<bool>,
    /// Erfolg melden, aber nichts ändern (Windows übernimmt es nicht)
    pub ignore: std::cell::Cell<bool>,
}

#[cfg(test)]
impl<'a> MemElevator<'a> {
    pub fn new(reg: &'a crate::opt::registry::MemRegistry) -> Self {
        Self {
            reg,
            calls: Default::default(),
            tasks: Default::default(),
            decline: Default::default(),
            fail: Default::default(),
            ignore: Default::default(),
        }
    }
}

#[cfg(test)]
impl Elevator for MemElevator<'_> {
    fn run(&self, task: &ElevatedTask) -> Result<(), ElevateError> {
        use crate::opt::registry::{RegVal, Registry, RegistryRead};
        self.calls.set(self.calls.get() + 1);
        self.tasks.borrow_mut().push(task.clone());
        validate(task).map_err(ElevateError::Failed)?;
        if self.decline.get() {
            return Err(ElevateError::Declined);
        }
        if self.fail.get() {
            return Err(ElevateError::Failed(MSG_PARTLY.into()));
        }
        if self.ignore.get() {
            return Ok(());
        }
        let mut errors = Vec::new();
        for op in &task.dns {
            for (list, base) in [(&op.v4, KEY_INTERFACES), (&op.v6, KEY_INTERFACES6)] {
                let Some(list) = list else { continue };
                let key = format!("{base}\\{}", op.adapter);
                if !self.reg.key_exists(&key) {
                    errors.push(format!("Adapter fehlt: {key}"));
                    continue;
                }
                let _ = self.reg.set(&key, "NameServer", &RegVal::Str(list.join(",")));
            }
        }
        for op in &task.reg {
            if !self.reg.key_exists(&op.key) {
                errors.push(format!("Schlüssel fehlt: {}", op.key));
                continue;
            }
            let _ = match op.value {
                Some(v) => self.reg.set(&op.key, &op.name, &RegVal::Dword(v)),
                None => self.reg.delete(&op.key, &op.name),
            };
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(ElevateError::Failed(errors.join(" ")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GUID: &str = "{4D36E972-E325-11CE-BFC1-08002BE10318}";

    fn iface(guid: &str) -> String {
        format!("{KEY_INTERFACES}\\{guid}")
    }

    fn dns(adapter: &str, v4: Option<&[&str]>, v6: Option<&[&str]>) -> DnsOp {
        let conv = |l: Option<&[&str]>| l.map(|l| l.iter().map(|s| s.to_string()).collect());
        DnsOp { adapter: adapter.into(), v4: conv(v4), v6: conv(v6) }
    }

    fn reg(key: &str, name: &str, value: Option<u32>) -> RegOp {
        RegOp { key: key.into(), name: name.into(), value }
    }

    fn task_dns(op: DnsOp) -> ElevatedTask {
        ElevatedTask { dns: vec![op], reg: vec![] }
    }

    fn task_reg(ops: Vec<RegOp>) -> ElevatedTask {
        ElevatedTask { dns: vec![], reg: ops }
    }

    #[test]
    fn guid_pattern_is_exact() {
        assert!(is_braced_guid(GUID));
        assert!(is_braced_guid("{4d36e972-e325-11ce-bfc1-08002be10318}"));
        for bad in [
            "4D36E972-E325-11CE-BFC1-08002BE10318",
            "{4D36E972-E325-11CE-BFC1-08002BE10318",
            "{4D36E972-E325-11CE-BFC1-08002BE1031G}",
            "{4D36E972E325-11CE-BFC1-08002BE103188}",
            "{4D36E972-E325-11CE-BFC1-08002BE10318} ",
            " {4D36E972-E325-11CE-BFC1-08002BE10318}",
            "{4D36E972-E325-11CE-BFC1-08002BE103180}",
            "{}",
            "",
            "{4D36E972-E325-11CE-BFC1-08002BE1031ä}",
        ] {
            assert!(!is_braced_guid(bad), "{bad:?}");
        }
        assert_eq!(parse_guid(GUID), Some(0x4D36E972_E325_11CE_BFC1_08002BE10318));
        assert_eq!(parse_guid("{00000000-0000-0000-0000-000000000001}"), Some(1));
        assert_eq!(parse_guid("kaputt"), None);
    }

    #[test]
    fn validate_accepts_good_tasks() {
        assert!(validate(&ElevatedTask::default()).is_ok());
        let t = ElevatedTask {
            dns: vec![dns(GUID, Some(&["1.1.1.1", "1.0.0.1"]), Some(&["2606:4700:4700::1111", "2606:4700:4700::1001"]))],
            reg: vec![
                reg(&iface(GUID), VAL_TCP_ACK, Some(1)),
                reg(&iface(GUID), VAL_NO_DELAY, None),
                reg(KEY_SYSTEM_PROFILE, VAL_THROTTLE, Some(u32::MAX)),
            ],
        };
        assert_eq!(validate(&t), Ok(()));
        // leere Liste = automatisch, None = unverändert
        assert!(validate(&task_dns(dns(GUID, Some(&[]), None))).is_ok());
        // Groß-/Kleinschreibung egal
        let lower = reg(&iface(GUID).to_lowercase(), "tcpackfrequency", Some(1));
        assert!(validate(&task_reg(vec![lower])).is_ok());
        let upper = reg(&KEY_SYSTEM_PROFILE.to_uppercase(), "NETWORKTHROTTLINGINDEX", Some(10));
        assert!(validate(&task_reg(vec![upper])).is_ok());
    }

    #[test]
    fn validate_rejects_bad_dns_ops() {
        let cases = [
            dns("4D36E972-E325-11CE-BFC1-08002BE10318", Some(&["1.1.1.1"]), None),
            dns(GUID, Some(&["2606:4700:4700::1111"]), None),
            dns(GUID, None, Some(&["1.1.1.1"])),
            dns(GUID, Some(&["1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4"]), None),
            dns(GUID, Some(&["1.1.1.1", "1.1.1.1"]), None),
            dns(GUID, None, Some(&["2606:4700:4700::1111", "2606:4700:4700:0:0:0:0:1111"])),
            dns(GUID, Some(&[" 1.1.1.1"]), None),
            dns(GUID, Some(&["1.1.1.1,8.8.8.8"]), None),
            dns(GUID, Some(&["\"1.1.1.1\""]), None),
            dns(GUID, Some(&["001.1.1.1"]), None),
            dns(GUID, Some(&["dns.google"]), None),
            dns(GUID, None, Some(&["2606:4700:4700:0:0:0:0:1111"])),
            dns(GUID, Some(&[""]), None),
        ];
        for op in cases {
            assert!(validate(&task_dns(op.clone())).is_err(), "{op:?}");
        }
        let five = ElevatedTask {
            dns: (1..=5).map(|i| dns(&format!("{{00000000-0000-0000-0000-00000000000{i}}}"), None, None)).collect(),
            reg: vec![],
        };
        assert!(validate(&five).is_err(), "höchstens 4 DNS-Änderungen");
        let twice = ElevatedTask { dns: vec![dns(GUID, None, None), dns(&GUID.to_lowercase(), None, None)], reg: vec![] };
        assert!(validate(&twice).is_err(), "Adapter doppelt");
    }

    #[test]
    fn validate_rejects_registry_tricks() {
        let base = iface(GUID);
        let cases = [
            reg(&format!("{base}\\..\\x"), VAL_TCP_ACK, Some(1)),
            reg(&format!("{KEY_INTERFACES}\\{GUID}\\..\\..\\..\\Run"), VAL_TCP_ACK, Some(1)),
            reg(&format!("{base}\\"), VAL_TCP_ACK, Some(1)),
            reg(&format!("\\{base}"), VAL_TCP_ACK, Some(1)),
            reg(&format!("{base}\\Sub"), VAL_TCP_ACK, Some(1)),
            reg(&format!("{KEY_INTERFACES}\\{{4D36E972-E325-11CE-BFC1-08002BE1031}}"), VAL_TCP_ACK, Some(1)),
            reg(&format!("{KEY_INTERFACES}\\..\\{GUID}"), VAL_TCP_ACK, Some(1)),
            reg(&format!("{KEY_INTERFACES}\\ {GUID}"), VAL_TCP_ACK, Some(1)),
            reg(&format!("{KEY_INTERFACES}\\\"{GUID}\""), VAL_TCP_ACK, Some(1)),
            reg(&format!("{KEY_INTERFACES}{GUID}"), VAL_TCP_ACK, Some(1)),
            reg(KEY_INTERFACES, VAL_TCP_ACK, Some(1)),
            reg(&base, VAL_THROTTLE, Some(1)),
            reg(&base, "NameServer", Some(1)),
            reg(&base, "TcpAckFrequency ", Some(1)),
            reg(KEY_SYSTEM_PROFILE, VAL_TCP_ACK, Some(1)),
            reg(&format!("{KEY_SYSTEM_PROFILE}\\Tasks"), VAL_THROTTLE, Some(1)),
            reg(&format!("{KEY_SYSTEM_PROFILE}\\"), VAL_THROTTLE, Some(1)),
            reg(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run", "x", Some(1)),
            reg(&format!("{KEY_INTERFACES6}\\{GUID}"), VAL_TCP_ACK, Some(1)),
            reg("", "", None),
        ];
        for op in cases {
            assert!(validate(&task_reg(vec![op.clone()])).is_err(), "{op:?}");
            assert!(reg_target(&op.key, &op.name).is_none(), "{op:?}");
        }
        let nine = task_reg((0..9).map(|i| reg(KEY_SYSTEM_PROFILE, VAL_THROTTLE, Some(i))).collect());
        assert!(validate(&nine).is_err(), "höchstens 8");
        let dup = task_reg(vec![reg(KEY_SYSTEM_PROFILE, VAL_THROTTLE, Some(1)), reg(KEY_SYSTEM_PROFILE, "networkthrottlingindex", Some(2))]);
        assert!(validate(&dup).is_err(), "doppelter Wert");
        assert_eq!(reg_target(&base, VAL_NO_DELAY), Some(RegTarget::Interface(GUID.into())));
        assert_eq!(reg_target(KEY_SYSTEM_PROFILE, VAL_THROTTLE), Some(RegTarget::SystemProfile));
        // Nicht-ASCII an der Grenze des Präfixes darf nicht abstürzen
        assert!(reg_target("SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaceä\\x", VAL_TCP_ACK).is_none());
    }

    #[test]
    fn encode_decode_roundtrip_and_limits() {
        let t = ElevatedTask {
            dns: vec![dns(GUID, Some(&["9.9.9.9"]), None)],
            reg: vec![reg(KEY_SYSTEM_PROFILE, VAL_THROTTLE, None)],
        };
        let hex_text = encode(&t).unwrap();
        assert!(hex_text.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(decode(&hex_text).unwrap(), t);
        // JSON-Form (camelCase, null für „unverändert“ bzw. „löschen“)
        let json: serde_json::Value = serde_json::from_slice(&hex::decode(&hex_text).unwrap()).unwrap();
        assert_eq!(json["dns"][0]["v6"], serde_json::Value::Null);
        assert_eq!(json["reg"][0]["value"], serde_json::Value::Null);

        assert!(decode("zz").is_err(), "kein Hex");
        assert!(decode("abc").is_err(), "ungerade Länge");
        assert!(decode(&hex::encode("kein json")).is_err());
        assert!(decode(&hex::encode(r#"{"dns":[],"reg":[],"cmd":"x"}"#)).is_err(), "unbekanntes Feld");
        assert!(decode(&hex::encode(r#"{"dns":[{"adapter":"{x}","v4":null,"v6":null,"extra":1}]}"#)).is_err());
        assert!(decode(&hex::encode(r#"{"reg":[{"key":"a","name":"b","value":-1}]}"#)).is_err(), "kein DWORD");
        assert_eq!(decode(&hex::encode("{}")).unwrap(), ElevatedTask::default());
        assert!(decode(&"0".repeat(MAX_HEX_LEN + 2)).is_err(), "zu groß");

        let big = ElevatedTask { dns: vec![], reg: (0..400).map(|_| reg(&iface(GUID), VAL_TCP_ACK, Some(1))).collect() };
        assert!(encode(&big).is_err(), "Argument über 16 KiB");
    }

    #[test]
    fn exit_codes_and_messages() {
        assert_eq!(from_exit_code(0), Ok(()));
        assert_eq!(from_exit_code(10), Err(ElevateError::Failed(MSG_PARTLY.into())));
        assert!(matches!(from_exit_code(20), Err(ElevateError::Failed(_))));
        assert_eq!(from_exit_code(30), Err(ElevateError::Unsupported(MSG_NEEDS_2004.into())));
        assert!(from_exit_code(1).unwrap_err().to_string().contains("Code 1"));
        assert_eq!(ElevateError::Declined.to_string(), MSG_DECLINED);
        assert_eq!(exit_code(&Ok(())), 0);
        assert_eq!(exit_code(&Err(ElevateError::Failed("x".into()))), 10);
        assert_eq!(exit_code(&Err(ElevateError::Unsupported("x".into()))), 30);
    }

    #[test]
    fn cli_parsing_and_helper_exit_codes() {
        let args = |v: &[&str]| v.iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(parse_cli(&args(&[])), None);
        assert_eq!(parse_cli(&args(&["--minimized"])), None);
        assert_eq!(parse_cli(&args(&["--selftest", "--elevated", "00"])), None, "nur das erste Argument zählt");
        assert_eq!(parse_cli(&args(&["--revert-all"])), Some(Cli::RevertAll));
        assert_eq!(parse_cli(&args(&["--elevated", "7b7d"])), Some(Cli::Elevated(Some("7b7d"))));
        assert_eq!(parse_cli(&args(&["--elevated"])), Some(Cli::Elevated(None)));
        assert_eq!(parse_cli(&args(&["--elevated", "7b7d", "x"])), Some(Cli::Elevated(None)));

        assert_eq!(helper_main(None), EXIT_INVALID);
        assert_eq!(helper_main(Some("zz")), EXIT_INVALID);
        let bad = encode(&task_reg(vec![reg(r"SOFTWARE\x", "y", Some(1))])).unwrap();
        assert_eq!(helper_main(Some(&bad)), EXIT_INVALID, "Erlaubnisliste gilt auch im Helfer");
        #[cfg(not(windows))]
        assert_eq!(helper_main(Some(&encode(&ElevatedTask::default()).unwrap())), EXIT_UNSUPPORTED);
    }

    #[test]
    fn run_without_windows_is_unsupported_and_empty_task_is_noop() {
        assert_eq!(run(&ElevatedTask::default()), Ok(()));
        let bad = task_reg(vec![reg("x", "y", None)]);
        assert!(matches!(run(&bad), Err(ElevateError::Failed(_))));
        #[cfg(not(windows))]
        {
            let t = task_reg(vec![reg(KEY_SYSTEM_PROFILE, VAL_THROTTLE, Some(10))]);
            assert_eq!(run(&t), Err(ElevateError::Unsupported(NOT_WINDOWS.into())));
            assert!(!dns_api_available());
        }
    }

    #[test]
    fn mem_elevator_applies_and_counts() {
        use crate::opt::registry::{MemRegistry, RegVal, RegistryRead};
        let mem = MemRegistry::default();
        mem.add_key(&iface(GUID));
        mem.add_key(&format!("{KEY_INTERFACES6}\\{GUID}"));
        let el = MemElevator::new(&mem);
        let t = ElevatedTask {
            dns: vec![dns(GUID, Some(&["1.1.1.1", "1.0.0.1"]), Some(&[]))],
            reg: vec![reg(&iface(GUID), VAL_TCP_ACK, Some(1))],
        };
        assert_eq!(el.run(&t), Ok(()));
        assert_eq!(el.calls.get(), 1);
        assert_eq!(mem.read(&iface(GUID), "NameServer").unwrap(), Some(RegVal::Str("1.1.1.1,1.0.0.1".into())));
        assert_eq!(mem.dword(&iface(GUID), VAL_TCP_ACK), Some(1));
        // Schlüssel wird nie angelegt
        let missing = task_reg(vec![reg(KEY_SYSTEM_PROFILE, VAL_THROTTLE, Some(1))]);
        assert!(matches!(el.run(&missing), Err(ElevateError::Failed(_))));
        assert!(!mem.key_exists(KEY_SYSTEM_PROFILE));
        el.decline.set(true);
        assert_eq!(el.run(&t), Err(ElevateError::Declined));
        assert_eq!(el.calls.get(), 3);
    }
}
