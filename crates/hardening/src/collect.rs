//! Sammelt die [`SystemFacts`] – **nur lesend** (Registrierung, WMI, Hosts-Datei, Port-Tabellen).
//!
//! Die Auswertung der Rohwerte steht hier plattformunabhängig (testbar); das Lesen selbst gibt
//! es nur unter Windows ([`collect`]). Was nicht lesbar ist, bleibt `None` und zählt als
//! „unbekannt“ – es wird nichts geraten.

use crate::facts::{BitLockerState, TpmState, UacLevel};

/// Stufe der Benutzerkontensteuerung aus `EnableLUA`, `ConsentPromptBehaviorAdmin` und
/// `PromptOnSecureDesktop` (fehlende Werte = Windows-Standard 1/5/1).
#[must_use]
pub fn uac_level(
    enable_lua: Option<u32>,
    consent_admin: Option<u32>,
    secure_desktop: Option<u32>,
) -> UacLevel {
    if enable_lua == Some(0) {
        return UacLevel::Disabled;
    }
    match (consent_admin.unwrap_or(5), secure_desktop.unwrap_or(1)) {
        (0, _) => UacLevel::Never,
        (_, 0) => UacLevel::NoSecureDesktop,
        // 1/2: Anmeldedaten bzw. Zustimmung immer auf dem sicheren Desktop.
        (1 | 2, _) => UacLevel::AlwaysNotify,
        _ => UacLevel::Default,
    }
}

/// BitLocker aus `ProtectionStatus` (0 aus, 1 an) und `ConversionStatus` (0 = vollständig
/// entschlüsselt) von `Win32_EncryptableVolume`.
#[must_use]
pub fn bitlocker_state(protection: u32, conversion: u32) -> BitLockerState {
    match (protection, conversion) {
        (1, _) => BitLockerState::Protected,
        (_, 0) => BitLockerState::Off,
        // Verschlüsselt (oder in Arbeit), Schutz aber angehalten.
        _ => BitLockerState::Suspended,
    }
}

/// TPM aus `Win32_Tpm` (`SpecVersion` z. B. „2.0, 0, 1.38“).
#[must_use]
pub fn tpm_state(enabled: bool, activated: bool, spec_version: Option<&str>) -> TpmState {
    let version = spec_version
        .and_then(|v| v.split(['.', ',']).next())
        .and_then(|v| v.trim().parse::<u8>().ok());
    TpmState {
        present: true,
        ready: enabled && activated,
        version,
    }
}

/// Ist ein Virenschutz aus dem Windows-Sicherheitscenter aktiv? (`productState`, Bits 12–15 = 1)
#[must_use]
pub fn av_product_active(product_state: u32) -> bool {
    (product_state >> 12) & 0xf == 1
}

/// Microsoft Defender selbst (wird gesondert gelesen)?
#[must_use]
pub fn is_defender(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.contains("windows defender") || n.contains("microsoft defender")
}

/// DNS-Server aus einem `NameServer`-Wert (Komma oder Leerzeichen getrennt).
#[must_use]
pub fn parse_name_servers(text: &str) -> Vec<String> {
    text.split([',', ' ', '|'])
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.parse::<std::net::IpAddr>().is_ok())
        .map(str::to_owned)
        .collect()
}

/// Tage seit 1970-01-01 (proleptischer gregorianischer Kalender).
#[must_use]
pub fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = i64::from(month);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Datum aus `Win32_QuickFixEngineering.InstalledOn` (`M/D/YYYY` oder `YYYYMMDD`) als Tage
/// seit 1970.
#[must_use]
pub fn parse_installed_on(text: &str) -> Option<i64> {
    let text = text.trim();
    let (y, m, d) = if let [m, d, y] = text.split('/').collect::<Vec<_>>()[..] {
        (y.parse().ok()?, m.parse().ok()?, d.parse().ok()?)
    } else if text.len() == 8 && text.bytes().all(|b| b.is_ascii_digit()) {
        (
            text[..4].parse().ok()?,
            text[4..6].parse().ok()?,
            text[6..].parse().ok()?,
        )
    } else {
        return None;
    };
    ((1990..=2200).contains(&y) && (1..=12).contains(&m) && (1..=31).contains(&d))
        .then(|| days_from_civil(y, m, d))
}

/// Tage seit dem neuesten Datum (`today` in Tagen seit 1970). Zukunftsdaten zählen als heute.
#[must_use]
pub fn days_since_latest(dates: &[i64], today: i64) -> Option<u32> {
    dates
        .iter()
        .max()
        .map(|d| u32::try_from((today - d).max(0)).unwrap_or(u32::MAX))
}

/// Ersetzt `%SystemRoot%` (ohne Groß/Klein) – für `DataBasePath` der Hosts-Datei.
#[must_use]
pub fn expand_system_root(text: &str, system_root: &str) -> String {
    let lower = text.to_ascii_lowercase();
    match lower.find("%systemroot%") {
        Some(i) => format!("{}{}{}", &text[..i], system_root, &text[i + 12..]),
        None => text.to_owned(),
    }
}

/// Was ein Plan zum Beheben vorher wissen muss (nur gelesen).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FixState {
    /// Firewall-Profile, die aus sind (`netsh`-Namen: `domainprofile`, `privateprofile`,
    /// `publicprofile`).
    pub firewall_off: Vec<String>,
    /// Schaltet eine Gruppenrichtlinie die Firewall ab? (AEGIS ändert keine Richtlinien.)
    pub firewall_policy: bool,
    /// Gastkonto: (Name, aktiviert?).
    pub guest: Option<(String, bool)>,
    /// Remotedesktop bzw. NLA per Gruppenrichtlinie festgelegt?
    pub rdp_policy: bool,
    /// NLA per Gruppenrichtlinie festgelegt?
    pub nla_policy: bool,
    /// Proxy-Skript (`AutoConfigURL`) des Kontos gesetzt?
    pub auto_config: bool,
    /// Manueller Proxy des Kontos an?
    pub proxy_enabled: bool,
    /// `DefaultConnectionSettings` des Kontos ohne Proxy-Merker (falls dort einer gesetzt ist).
    pub connections_without_proxy: Option<Vec<u8>>,
    /// Stufe der Benutzerkontensteuerung.
    pub uac: Option<UacLevel>,
    /// SMBv1-Server an?
    pub smb1: Option<bool>,
    /// Remotedesktop.
    pub rdp: Option<crate::facts::RdpState>,
    /// Ist der Firewall-Dienst (MpsSvc) deaktiviert? Dann hilft Einschalten per `netsh` nicht.
    pub firewall_service_disabled: bool,
    /// Wirkt die Microsoft-Sperrliste für verwundbare Treiber?
    pub driver_blocklist: Option<bool>,
    /// Legt eine Gruppenrichtlinie (Device Guard) die Treiber-Regeln fest?
    pub driver_policy: bool,
}

/// `DefaultConnectionSettings` (WinINet): Version, Zähler, Merker (0x02 Proxy, 0x04 Skript) …
/// Liefert den Wert ohne Proxy-Merker (Zähler +1) oder `None`, wenn keiner gesetzt ist.
#[must_use]
pub fn connections_without_proxy(blob: &[u8]) -> Option<Vec<u8>> {
    if blob.len() < 12 || blob.len() > 4096 {
        return None;
    }
    let flags = u32::from_le_bytes([blob[8], blob[9], blob[10], blob[11]]);
    let cleared = flags & !(0x02 | 0x04);
    if cleared == flags {
        return None;
    }
    let mut out = blob.to_vec();
    let counter = u32::from_le_bytes([blob[4], blob[5], blob[6], blob[7]]).wrapping_add(1);
    out[4..8].copy_from_slice(&counter.to_le_bytes());
    out[8..12].copy_from_slice(&cleared.to_le_bytes());
    Some(out)
}

#[cfg(windows)]
pub use self::windows::{
    capability_uses, collect, defender_status, devices, fix_state, machine_autorun_named,
    machine_autoruns, machine_autoruns_of, profile_sids, proxy_of, user_registry_autoruns,
};

#[cfg(windows)]
mod windows {
    use std::collections::HashMap;
    use std::io::Read;
    use std::path::PathBuf;

    use aegis_winffi::inspect::{Hive, read_subkeys, read_values};
    use wmi::{AuthLevel, Variant, WMIConnection, WMIError};

    use super::{
        FixState, av_product_active, bitlocker_state, days_since_latest, expand_system_root,
        is_defender, parse_installed_on, parse_name_servers, tpm_state, uac_level,
    };
    use crate::facts::{
        AntivirusState, BitLockerState, DriverProtection, FirewallState, ListeningPort, ProxyState,
        RdpState, SystemFacts, TpmState, blocklist_effective, parse_hosts,
    };
    use crate::persistence::{Autorun, AutorunKind};

    /// `WBEM_E_INVALID_NAMESPACE`: Diese Windows-Edition hat den Namensraum nicht.
    const INVALID_NAMESPACE: i32 = 0x8004_100E_u32 as i32;
    const MAX_HOSTS: u64 = 1024 * 1024;

    type Row = HashMap<String, Variant>;

    fn value(hive: &Hive, key: &str, name: &str) -> Option<String> {
        read_values(hive, key)
            .into_iter()
            .find(|v| v.name.eq_ignore_ascii_case(name))
            .map(|v| v.data)
    }

    fn dword(hive: &Hive, key: &str, name: &str) -> Option<u32> {
        value(hive, key, name).and_then(|d| d.trim().parse().ok())
    }

    fn query(namespace: &str, wql: &str, private: bool) -> Result<Vec<Row>, WMIError> {
        let conn = WMIConnection::with_namespace_path(namespace)?;
        if private {
            // Die Namensräume von TPM und BitLocker verlangen verschlüsselte Aufrufe.
            conn.set_proxy_blanket(AuthLevel::PktPrivacy)?;
        }
        conn.raw_query(wql)
    }

    fn v_bool(row: &Row, name: &str) -> Option<bool> {
        match row.get(name)? {
            Variant::Bool(b) => Some(*b),
            _ => None,
        }
    }

    fn v_u32(row: &Row, name: &str) -> Option<u32> {
        match row.get(name)? {
            Variant::UI1(v) => Some(u32::from(*v)),
            Variant::UI2(v) => Some(u32::from(*v)),
            Variant::UI4(v) => Some(*v),
            Variant::I1(v) => u32::try_from(*v).ok(),
            Variant::I2(v) => u32::try_from(*v).ok(),
            Variant::I4(v) => u32::try_from(*v).ok(),
            Variant::UI8(v) => u32::try_from(*v).ok(),
            Variant::I8(v) => u32::try_from(*v).ok(),
            _ => None,
        }
    }

    fn v_string(row: &Row, name: &str) -> Option<String> {
        match row.get(name)? {
            Variant::String(s) => Some(s.clone()),
            _ => None,
        }
    }

    fn os_version() -> Option<String> {
        let key = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
        let hklm = Hive::LocalMachine;
        let major = dword(&hklm, key, "CurrentMajorVersionNumber")?;
        let minor = dword(&hklm, key, "CurrentMinorVersionNumber").unwrap_or(0);
        let build = value(&hklm, key, "CurrentBuild")?;
        let ubr = dword(&hklm, key, "UBR").unwrap_or(0);
        Some(format!("{major}.{minor}.{}.{ubr}", build.trim()))
    }

    fn build_number() -> Option<u32> {
        value(
            &Hive::LocalMachine,
            r"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
            "CurrentBuild",
        )
        .and_then(|b| b.trim().parse().ok())
    }

    /// Wirkt die Sperrliste (Wert `VulnerableDriverBlocklistEnable`, sonst Standard je Build)?
    fn driver_blocklist() -> Option<bool> {
        let value = dword(
            &Hive::LocalMachine,
            r"SYSTEM\CurrentControlSet\Control\CI\Config",
            "VulnerableDriverBlocklistEnable",
        );
        blocklist_effective(value, build_number())
    }

    /// Speicher-Integrität: laufend laut Device Guard (WMI), sonst laut Registrierung.
    fn hvci() -> Option<bool> {
        let running = query(
            r"root\Microsoft\Windows\DeviceGuard",
            "SELECT SecurityServicesRunning FROM Win32_DeviceGuard",
            false,
        )
        .ok()
        .and_then(|rows| {
            let row = rows.into_iter().next()?;
            match row.get("SecurityServicesRunning")? {
                Variant::Array(items) => Some(items.iter().any(|v| {
                    matches!(
                        v,
                        Variant::UI4(2) | Variant::I4(2) | Variant::UI1(2) | Variant::UI2(2)
                    )
                })),
                Variant::Null | Variant::Empty => Some(false),
                _ => None,
            }
        });
        running.or_else(|| {
            dword(
                &Hive::LocalMachine,
                r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity",
                "Enabled",
            )
            .map(|v| v == 1)
        })
    }

    fn driver_protection() -> Option<DriverProtection> {
        let p = DriverProtection {
            hvci: hvci(),
            blocklist: driver_blocklist(),
        };
        (p.hvci.is_some() || p.blocklist.is_some()).then_some(p)
    }

    fn secure_boot() -> Option<bool> {
        dword(
            &Hive::LocalMachine,
            r"SYSTEM\CurrentControlSet\Control\SecureBoot\State",
            "UEFISecureBootEnabled",
        )
        .map(|v| v == 1)
    }

    fn uac() -> Option<super::UacLevel> {
        let key = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";
        let values = read_values(&Hive::LocalMachine, key);
        if values.is_empty() {
            return None;
        }
        let get = |name: &str| {
            values
                .iter()
                .find(|v| v.name.eq_ignore_ascii_case(name))
                .and_then(|v| v.data.trim().parse().ok())
        };
        Some(uac_level(
            get("EnableLUA"),
            get("ConsentPromptBehaviorAdmin"),
            get("PromptOnSecureDesktop"),
        ))
    }

    fn smb1() -> Option<bool> {
        let hklm = Hive::LocalMachine;
        // srv.sys (SMBv1-Server) fehlt, wenn die Windows-Funktion entfernt ist.
        let srv = read_values(&hklm, r"SYSTEM\CurrentControlSet\Services\srv");
        if srv.is_empty() {
            return Some(false);
        }
        let start = srv
            .iter()
            .find(|v| v.name.eq_ignore_ascii_case("Start"))
            .and_then(|v| v.data.trim().parse::<u32>().ok());
        let param = dword(
            &hklm,
            r"SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters",
            "SMB1",
        );
        Some(start != Some(4) && param != Some(0))
    }

    fn rdp() -> Option<RdpState> {
        let hklm = Hive::LocalMachine;
        let policy = r"SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services";
        let deny = dword(&hklm, policy, "fDenyTSConnections").or_else(|| {
            dword(
                &hklm,
                r"SYSTEM\CurrentControlSet\Control\Terminal Server",
                "fDenyTSConnections",
            )
        })?;
        let nla = dword(&hklm, policy, "UserAuthentication")
            .or_else(|| {
                dword(
                    &hklm,
                    r"SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp",
                    "UserAuthentication",
                )
            })
            // Fehlt der Wert, gilt der Windows-Standard seit Vista/Server 2008: NLA verlangt.
            .unwrap_or(1);
        Some(RdpState {
            enabled: deny == 0,
            nla: nla == 1,
        })
    }

    fn firewall() -> FirewallState {
        let hklm = Hive::LocalMachine;
        let read = |local: &str, policy: &str| {
            dword(
                &hklm,
                &format!(r"SOFTWARE\Policies\Microsoft\WindowsFirewall\{policy}"),
                "EnableFirewall",
            )
            .or_else(|| {
                dword(
                    &hklm,
                    &format!(
                        r"SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\{local}"
                    ),
                    "EnableFirewall",
                )
            })
            .map(|v| v == 1)
        };
        if firewall_service_disabled() {
            // Ohne Dienst filtert die Windows-Firewall nichts – egal, was eingestellt ist.
            return FirewallState {
                domain: Some(false),
                private: Some(false),
                public: Some(false),
            };
        }
        FirewallState {
            domain: read("DomainProfile", "DomainProfile"),
            private: read("StandardProfile", "PrivateProfile"),
            public: read("PublicProfile", "PublicProfile"),
        }
    }

    fn firewall_service_disabled() -> bool {
        dword(
            &Hive::LocalMachine,
            r"SYSTEM\CurrentControlSet\Services\MpsSvc",
            "Start",
        ) == Some(4)
    }

    /// Aktive Firewalls anderer Hersteller (Windows-Sicherheitscenter).
    fn firewall_products() -> Vec<String> {
        query(
            r"ROOT\SecurityCenter2",
            "SELECT displayName, productState FROM FirewallProduct",
            false,
        )
        .map(|rows| {
            rows.iter()
                .filter(|r| v_u32(r, "productState").is_some_and(av_product_active))
                .filter_map(|r| v_string(r, "displayName"))
                .filter(|n| !n.to_ascii_lowercase().contains("windows"))
                .map(|n| n.chars().take(80).collect())
                .take(5)
                .collect()
        })
        .unwrap_or_default()
    }

    /// Proxy eines Kontos (nur lesend; `HKU\<SID>`).
    #[must_use]
    pub fn proxy_of(sid: &str) -> Option<ProxyState> {
        proxy(sid)
    }

    fn proxy(sid: &str) -> Option<ProxyState> {
        let values = read_values(
            &Hive::User(sid.to_owned()),
            r"Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        );
        if values.is_empty() {
            return None;
        }
        let get = |name: &str| {
            values
                .iter()
                .find(|v| v.name.eq_ignore_ascii_case(name))
                .map(|v| v.data.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        Some(ProxyState {
            enabled: get("ProxyEnable").is_some_and(|v| v == "1"),
            server: get("ProxyServer"),
            auto_config: get("AutoConfigURL"),
        })
    }

    fn dns_servers() -> Vec<String> {
        let hklm = Hive::LocalMachine;
        let mut out: Vec<String> = Vec::new();
        for base in [
            r"SYSTEM\CurrentControlSet\Services\Tcpip\Parameters",
            r"SYSTEM\CurrentControlSet\Services\Tcpip6\Parameters",
        ] {
            // Fest eingetragene Server (das ändert Schadsoftware wie DNSChanger); per DHCP
            // vergebene wechseln mit jedem Netz und werden hier nicht bewertet.
            let mut keys = vec![base.to_owned()];
            keys.extend(
                read_subkeys(&hklm, &format!(r"{base}\Interfaces"))
                    .into_iter()
                    .take(256)
                    .map(|k| format!(r"{base}\Interfaces\{k}")),
            );
            for key in keys {
                if let Some(text) = value(&hklm, &key, "NameServer") {
                    for server in parse_name_servers(&text) {
                        if !out.contains(&server) {
                            out.push(server);
                        }
                    }
                }
            }
        }
        out.truncate(64);
        out
    }

    fn hosts() -> Option<Vec<crate::facts::HostsEntry>> {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        // Auch der Ort der Hosts-Datei lässt sich umbiegen – gelesen wird der tatsächliche.
        let dir = value(
            &Hive::LocalMachine,
            r"SYSTEM\CurrentControlSet\Services\Tcpip\Parameters",
            "DataBasePath",
        )
        .map_or_else(
            || format!(r"{root}\System32\drivers\etc"),
            |p| expand_system_root(&p, &root),
        );
        let file = std::fs::File::open(PathBuf::from(dir).join("hosts")).ok()?;
        let mut bytes = Vec::new();
        file.take(MAX_HOSTS).read_to_end(&mut bytes).ok()?;
        Some(parse_hosts(&String::from_utf8_lossy(&bytes)))
    }

    fn listening() -> Option<Vec<ListeningPort>> {
        let ports = aegis_winffi::inspect::listening_ports().ok()?;
        let names: HashMap<u32, String> = aegis_winffi::inspect::processes()
            .map(|list| list.into_iter().map(|p| (p.pid, p.name)).collect())
            .unwrap_or_default();
        Some(
            ports
                .into_iter()
                .take(2000)
                .map(|p| ListeningPort {
                    port: p.port,
                    protocol: p.protocol.to_owned(),
                    all_interfaces: p.all_interfaces,
                    program: names.get(&p.pid).cloned(),
                })
                .collect(),
        )
    }

    fn tpm() -> Option<TpmState> {
        let rows = query(
            r"ROOT\CIMV2\Security\MicrosoftTpm",
            "SELECT IsEnabled_InitialValue, IsActivated_InitialValue, SpecVersion FROM Win32_Tpm",
            true,
        );
        match rows {
            Ok(rows) => Some(rows.first().map_or(
                TpmState {
                    present: false,
                    ready: false,
                    version: None,
                },
                |r| {
                    tpm_state(
                        v_bool(r, "IsEnabled_InitialValue").unwrap_or(false),
                        v_bool(r, "IsActivated_InitialValue").unwrap_or(false),
                        v_string(r, "SpecVersion").as_deref(),
                    )
                },
            )),
            Err(WMIError::HResultError { hres }) if hres == INVALID_NAMESPACE => Some(TpmState {
                present: false,
                ready: false,
                version: None,
            }),
            Err(_) => None,
        }
    }

    fn bitlocker() -> Option<BitLockerState> {
        let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        let rows = query(
            r"ROOT\CIMV2\Security\MicrosoftVolumeEncryption",
            "SELECT DriveLetter, ProtectionStatus, ConversionStatus FROM Win32_EncryptableVolume",
            true,
        );
        match rows {
            Ok(rows) => rows
                .iter()
                .find(|r| {
                    v_string(r, "DriveLetter").is_some_and(|d| d.eq_ignore_ascii_case(&drive))
                })
                .map(|r| {
                    bitlocker_state(
                        v_u32(r, "ProtectionStatus").unwrap_or(0),
                        v_u32(r, "ConversionStatus").unwrap_or(0),
                    )
                }),
            Err(WMIError::HResultError { hres }) if hres == INVALID_NAMESPACE => {
                Some(BitLockerState::Unavailable)
            }
            Err(_) => None,
        }
    }

    /// Zustand von Microsoft Defender für den Defender-Schalter (P8) – nur lesend (WMI und
    /// Gruppenrichtlinie in der Registrierung).
    pub fn defender_status() -> aegis_defender_switch::DefenderStatus {
        use aegis_defender_switch::{DefenderStatus, ThreatActions};
        let mut status = DefenderStatus::default();
        let namespace = r"ROOT\Microsoft\Windows\Defender";
        if let Ok(rows) = query(
            namespace,
            "SELECT AMServiceEnabled, AntivirusEnabled, RealTimeProtectionEnabled, IsTamperProtected, AMRunningMode, AntivirusSignatureAge FROM MSFT_MpComputerStatus",
            false,
        ) && let Some(r) = rows.first()
        {
            status.available = true;
            status.service = v_bool(r, "AMServiceEnabled");
            status.antivirus = v_bool(r, "AntivirusEnabled");
            status.realtime = v_bool(r, "RealTimeProtectionEnabled");
            status.tamper = v_bool(r, "IsTamperProtected");
            status.running_mode =
                v_string(r, "AMRunningMode").map(|m| m.chars().take(40).collect());
            status.signature_age_days = v_u32(r, "AntivirusSignatureAge");
        }
        if let Ok(rows) = query(
            namespace,
            "SELECT MAPSReporting, LowThreatDefaultAction, ModerateThreatDefaultAction, HighThreatDefaultAction, SevereThreatDefaultAction FROM MSFT_MpPreference",
            false,
        ) && let Some(r) = rows.first()
        {
            status.cloud = v_u32(r, "MAPSReporting").map(|v| v != 0);
            let action = |name: &str| v_u32(r, name).and_then(|v| u8::try_from(v).ok());
            status.actions = ThreatActions {
                low: action("LowThreatDefaultAction"),
                moderate: action("ModerateThreatDefaultAction"),
                high: action("HighThreatDefaultAction"),
                severe: action("SevereThreatDefaultAction"),
            };
        }
        status.policy_realtime_off = dword(
            &Hive::LocalMachine,
            r"SOFTWARE\Policies\Microsoft\Windows Defender\Real-Time Protection",
            "DisableRealtimeMonitoring",
        ) == Some(1);
        status
    }

    fn antivirus() -> AntivirusState {
        let mut state = AntivirusState::default();
        if let Ok(rows) = query(
            r"ROOT\Microsoft\Windows\Defender",
            "SELECT RealTimeProtectionEnabled, AntivirusSignatureAge FROM MSFT_MpComputerStatus",
            false,
        ) && let Some(r) = rows.first()
        {
            state.defender_realtime = v_bool(r, "RealTimeProtectionEnabled");
            state.defender_signature_age_days = v_u32(r, "AntivirusSignatureAge");
        }
        if let Ok(rows) = query(
            r"ROOT\SecurityCenter2",
            "SELECT displayName, productState FROM AntiVirusProduct",
            false,
        ) {
            state.other_active = rows
                .iter()
                .filter(|r| v_u32(r, "productState").is_some_and(av_product_active))
                .filter_map(|r| v_string(r, "displayName"))
                .filter(|n| !is_defender(n))
                .map(|n| n.chars().take(80).collect())
                .take(10)
                .collect();
        }
        state
    }

    fn days_since_update() -> Option<u32> {
        let rows = query(
            r"ROOT\CIMV2",
            "SELECT InstalledOn FROM Win32_QuickFixEngineering",
            false,
        )
        .ok()?;
        let dates: Vec<i64> = rows
            .iter()
            .filter_map(|r| v_string(r, "InstalledOn"))
            .filter_map(|d| parse_installed_on(&d))
            .collect();
        let today = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .and_then(|d| i64::try_from(d.as_secs() / 86_400).ok())?;
        days_since_latest(&dates, today)
    }

    fn guest_enabled() -> Option<bool> {
        guest_account().map(|(_, enabled)| enabled)
    }

    fn guest_account() -> Option<(String, bool)> {
        aegis_winffi::accounts::guest_account().ok().flatten()
    }

    /// Liest, was ein Plan zum Beheben von `fix` wissen muss – nur das (nur lesend, ohne WMI).
    /// `user_sid`: Konto für den Proxy.
    #[must_use]
    pub fn fix_state(fix: crate::FixKind, user_sid: Option<&str>) -> FixState {
        use crate::FixKind;
        let hklm = Hive::LocalMachine;
        let mut state = FixState::default();
        match fix {
            FixKind::EnableUac => state.uac = uac(),
            FixKind::DisableSmb1 => state.smb1 = smb1(),
            FixKind::DisableRdp | FixKind::EnableRdpNla => {
                let policy = r"SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services";
                state.rdp = rdp();
                state.rdp_policy = dword(&hklm, policy, "fDenyTSConnections").is_some();
                state.nla_policy = dword(&hklm, policy, "UserAuthentication").is_some();
            }
            FixKind::DisableGuest => state.guest = guest_account(),
            FixKind::EnableFirewall => {
                let fw = firewall();
                state.firewall_off = [
                    (fw.domain, "domainprofile"),
                    (fw.private, "privateprofile"),
                    (fw.public, "publicprofile"),
                ]
                .into_iter()
                .filter(|(on, _)| *on == Some(false))
                .map(|(_, name)| name.to_owned())
                .collect();
                state.firewall_policy = ["DomainProfile", "PrivateProfile", "PublicProfile"]
                    .iter()
                    .any(|p| {
                        dword(
                            &hklm,
                            &format!(r"SOFTWARE\Policies\Microsoft\WindowsFirewall\{p}"),
                            "EnableFirewall",
                        ) == Some(0)
                    });
                state.firewall_service_disabled = firewall_service_disabled();
            }
            FixKind::DisableProxy => {
                if let Some(sid) = user_sid {
                    let p = proxy(sid);
                    state.proxy_enabled = p.as_ref().is_some_and(|p| p.enabled);
                    state.auto_config = p.as_ref().is_some_and(|p| p.auto_config.is_some());
                    state.connections_without_proxy = aegis_winffi::registry::read_raw(
                        &Hive::User(sid.to_owned()),
                        r"Software\Microsoft\Windows\CurrentVersion\Internet Settings\Connections",
                        "DefaultConnectionSettings",
                    )
                    .ok()
                    .flatten()
                    .filter(|v| v.kind == 3)
                    .and_then(|v| super::connections_without_proxy(&v.bytes));
                }
            }
            FixKind::EnableDriverBlocklist => {
                state.driver_blocklist = driver_blocklist();
                state.driver_policy =
                    read_values(&hklm, r"SOFTWARE\Policies\Microsoft\Windows\DeviceGuard")
                        .iter()
                        .any(|v| {
                            v.name.eq_ignore_ascii_case("ConfigCIPolicyFilePath")
                                || v.name.eq_ignore_ascii_case("DeployConfigCIPolicy")
                        });
            }
            FixKind::OpenSettings => {}
        }
        state
    }

    // -----------------------------------------------------------------------------------
    // Persistenz (P6.3, nur lesend)
    // -----------------------------------------------------------------------------------

    const MAX_AUTORUNS: usize = 3000;

    fn approved(hive: &Hive, folder: &str, name: &str) -> bool {
        let key =
            format!(r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\{folder}");
        aegis_winffi::registry::read_raw(hive, &key, name)
            .ok()
            .flatten()
            .is_none_or(|v| crate::persistence::startup_approved_enabled(&v.bytes))
    }

    fn run_keys(hive: &Hive, machine: bool, label: &str, out: &mut Vec<Autorun>) {
        let mut keys = vec![
            (
                r"Software\Microsoft\Windows\CurrentVersion\Run",
                AutorunKind::Run,
                "Run",
            ),
            (
                r"Software\Microsoft\Windows\CurrentVersion\RunOnce",
                AutorunKind::RunOnce,
                "",
            ),
            (
                r"Software\Microsoft\Windows\CurrentVersion\Policies\Explorer\Run",
                AutorunKind::PolicyRun,
                "",
            ),
        ];
        if machine {
            keys.push((
                r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run",
                AutorunKind::Run,
                "Run32",
            ));
            keys.push((
                r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\RunOnce",
                AutorunKind::RunOnce,
                "",
            ));
        }
        for (key, kind, approved_folder) in keys {
            for v in read_values(hive, key).into_iter().take(500) {
                let enabled =
                    approved_folder.is_empty() || approved(hive, approved_folder, &v.name);
                out.push(Autorun::new(
                    kind,
                    machine,
                    format!(r"{label}\{key}"),
                    v.name,
                    v.data,
                    enabled,
                ));
            }
        }
    }

    fn startup_folder(dir: &std::path::Path, machine: bool, out: &mut Vec<Autorun>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten().take(500) {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.eq_ignore_ascii_case("desktop.ini") {
                continue;
            }
            if e.file_type().is_ok_and(|t| t.is_file()) {
                out.push(Autorun::new(
                    AutorunKind::StartupFolder,
                    machine,
                    dir.display().to_string(),
                    name,
                    e.path().display().to_string(),
                    true,
                ));
            }
        }
    }

    fn tasks(root: &std::path::Path, out: &mut Vec<Autorun>) {
        let mut stack = vec![(root.to_path_buf(), 0usize)];
        let mut seen = 0usize;
        while let Some((dir, depth)) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for e in entries.flatten() {
                let Ok(kind) = e.file_type() else { continue };
                if kind.is_symlink() {
                    continue;
                }
                if kind.is_dir() {
                    if depth < 8 {
                        stack.push((e.path(), depth + 1));
                    }
                    continue;
                }
                seen += 1;
                if seen > 4000 || out.len() >= MAX_AUTORUNS {
                    return;
                }
                task_entries(root, &e.path(), out);
            }
        }
    }

    /// Befehle einer Aufgabendatei (`path` liegt unter `root`).
    fn task_entries(root: &std::path::Path, path: &std::path::Path, out: &mut Vec<Autorun>) {
        let Ok(file) = std::fs::File::open(path) else {
            return;
        };
        let mut bytes = Vec::new();
        if file.take(512 * 1024).read_to_end(&mut bytes).is_err() {
            return;
        }
        let text = decode_xml(&bytes);
        let Some((commands, enabled)) = crate::persistence::parse_task_xml(&text) else {
            return;
        };
        let task = path.strip_prefix(root).map_or_else(
            |_| path.display().to_string(),
            |p| format!("\\{}", p.display()),
        );
        for command in commands.into_iter().take(4) {
            out.push(Autorun::new(
                AutorunKind::ScheduledTask,
                true,
                "Aufgabenplanung",
                task.clone(),
                command,
                enabled,
            ));
        }
    }

    fn tasks_root() -> PathBuf {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        PathBuf::from(root).join(r"System32\Tasks")
    }

    /// Nur den einen Eintrag erneut lesen (vor dem Ausführen eines Plans – schnell, damit die
    /// Dienst-Sperre kurz bleibt). Dienste, Treiber und Aufgaben gezielt, sonst die ganze Art.
    #[must_use]
    pub fn machine_autorun_named(kind: AutorunKind, name: &str) -> Vec<Autorun> {
        match kind {
            AutorunKind::Service => service_entry(name).into_iter().collect(),
            AutorunKind::Driver => {
                let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
                driver_entry(name, &root).into_iter().collect()
            }
            AutorunKind::ScheduledTask => {
                let root = tasks_root();
                let mut out = Vec::new();
                if let Some(file) = crate::persistence::task_file(&root, name) {
                    task_entries(&root, &file, &mut out);
                }
                out
            }
            _ => machine_autoruns_of(kind),
        }
    }

    /// Aufgaben-XML ist meist UTF-16 (mit BOM), manchmal UTF-8.
    fn decode_xml(bytes: &[u8]) -> String {
        if let Some(rest) = bytes.strip_prefix(&[0xff, 0xfe]) {
            let units: Vec<u16> = rest
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            String::from_utf16_lossy(&units)
        } else {
            String::from_utf8_lossy(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes))
                .into_owned()
        }
    }

    const SERVICES: &str = r"SYSTEM\CurrentControlSet\Services";

    /// Ein automatisch startender Win32-Dienst (sonst `None`).
    fn service_entry(name: &str) -> Option<Autorun> {
        let hklm = Hive::LocalMachine;
        let key = format!(r"{SERVICES}\{name}");
        let values = read_values(&hklm, &key);
        let get = |n: &str| {
            values
                .iter()
                .find(|v| v.name.eq_ignore_ascii_case(n))
                .map(|v| v.data.clone())
        };
        let start = get("Start").and_then(|s| s.trim().parse::<u32>().ok());
        let kind = get("Type")
            .and_then(|s| s.trim().parse::<u32>().ok())
            .unwrap_or(0);
        // Nur Programme (Typ 0x10/0x20/0x50/0x60), die automatisch starten (0–2).
        if kind & 0x30 == 0 || !matches!(start, Some(0..=2)) {
            return None;
        }
        let image = get("ImagePath")?;
        let dll = read_values(&hklm, &format!(r"{key}\Parameters"))
            .into_iter()
            .find(|v| v.name.eq_ignore_ascii_case("ServiceDll"))
            .map(|v| v.data);
        let command = match dll {
            Some(dll) => format!("{image} | {dll}"),
            None => image,
        };
        Some(
            Autorun::new(
                AutorunKind::Service,
                true,
                format!(r"HKLM\{SERVICES}"),
                name,
                command,
                true,
            )
            .with_start(start),
        )
    }

    fn services(out: &mut Vec<Autorun>) {
        for name in read_subkeys(&Hive::LocalMachine, SERVICES)
            .into_iter()
            .take(2000)
        {
            out.extend(service_entry(&name));
        }
    }

    /// Ein Kernel- bzw. Dateisystem-Treiber aus seinem Dienst-Eintrag (sonst `None`).
    fn driver_entry(name: &str, root: &str) -> Option<Autorun> {
        let values = read_values(&Hive::LocalMachine, &format!(r"{SERVICES}\{name}"));
        let get = |n: &str| {
            values
                .iter()
                .find(|v| v.name.eq_ignore_ascii_case(n))
                .map(|v| v.data.clone())
        };
        let kind = get("Type")
            .and_then(|s| s.trim().parse::<u32>().ok())
            .unwrap_or(0);
        // 0x1 Kernel-Treiber, 0x2 Dateisystem-Treiber.
        if kind & 0x3 == 0 || kind & 0x30 != 0 {
            return None;
        }
        let start = get("Start").and_then(|s| s.trim().parse::<u32>().ok());
        let image = get("ImagePath");
        let command = crate::drivers::driver_path(image.as_deref(), name, root)
            .or(image)
            .unwrap_or_default();
        Some(
            Autorun::new(
                AutorunKind::Driver,
                true,
                format!(r"HKLM\{SERVICES}"),
                name,
                command,
                start != Some(4),
            )
            .with_start(start),
        )
    }

    /// Kernel- und Dateisystem-Treiber aus den Dienst-Einträgen plus geladene Treiber ohne
    /// Eintrag (nur lesend).
    fn drivers(out: &mut Vec<Autorun>) {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let mut known: Vec<String> = Vec::new();
        for name in read_subkeys(&Hive::LocalMachine, SERVICES)
            .into_iter()
            .take(3000)
        {
            if let Some(entry) = driver_entry(&name, &root) {
                known.push(entry.command.to_ascii_lowercase());
                out.push(entry);
            }
        }
        if let Ok(loaded) = aegis_winffi::inspect::loaded_drivers() {
            for kernel in loaded.into_iter().take(2000) {
                let Some(path) = crate::drivers::kernel_path(&kernel, &root) else {
                    continue;
                };
                if known.contains(&path.to_ascii_lowercase()) {
                    continue;
                }
                let file = path.rsplit('\\').next().unwrap_or(&path).to_owned();
                out.push(Autorun::new(
                    AutorunKind::Driver,
                    true,
                    "Geladen (ohne Dienst-Eintrag)",
                    file,
                    path,
                    true,
                ));
            }
        }
    }

    fn winlogon(hive: &Hive, machine: bool, label: &str, out: &mut Vec<Autorun>) {
        let key = r"Software\Microsoft\Windows NT\CurrentVersion\Winlogon";
        for v in read_values(hive, key) {
            let shell = v.name.eq_ignore_ascii_case("Shell");
            if shell || (machine && v.name.eq_ignore_ascii_case("Userinit")) {
                out.push(Autorun::new(
                    AutorunKind::Winlogon,
                    machine,
                    format!(r"{label}\{key}"),
                    v.name,
                    v.data,
                    true,
                ));
            }
        }
    }

    fn ifeo_and_appinit(out: &mut Vec<Autorun>) {
        let hklm = Hive::LocalMachine;
        let ifeo = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options";
        for name in read_subkeys(&hklm, ifeo).into_iter().take(1000) {
            if let Some(debugger) = value(&hklm, &format!(r"{ifeo}\{name}"), "Debugger")
                .filter(|d| !d.trim().is_empty())
            {
                out.push(Autorun::new(
                    AutorunKind::Ifeo,
                    true,
                    format!(r"HKLM\{ifeo}"),
                    name,
                    debugger,
                    true,
                ));
            }
        }
        for key in [
            r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Windows",
            r"SOFTWARE\WOW6432Node\Microsoft\Windows NT\CurrentVersion\Windows",
        ] {
            let dlls = value(&hklm, key, "AppInit_DLLs").filter(|d| !d.trim().is_empty());
            if let Some(dlls) = dlls {
                let load = dword(&hklm, key, "LoadAppInit_DLLs") == Some(1);
                out.push(Autorun::new(
                    AutorunKind::AppInit,
                    true,
                    format!(r"HKLM\{key}"),
                    "AppInit_DLLs",
                    dlls,
                    load,
                ));
            }
        }
    }

    fn wmi_consumers(out: &mut Vec<Autorun>) {
        if let Ok(rows) = query(
            r"ROOT\subscription",
            "SELECT Name, CommandLineTemplate FROM CommandLineEventConsumer",
            false,
        ) {
            for r in rows.iter().take(200) {
                out.push(Autorun::new(
                    AutorunKind::WmiConsumer,
                    true,
                    r"WMI ROOT\subscription",
                    v_string(r, "Name").unwrap_or_default(),
                    v_string(r, "CommandLineTemplate").unwrap_or_default(),
                    true,
                ));
            }
        }
        if let Ok(rows) = query(
            r"ROOT\subscription",
            "SELECT Name, ScriptFileName, ScriptText FROM ActiveScriptEventConsumer",
            false,
        ) {
            for r in rows.iter().take(200) {
                let script = v_string(r, "ScriptFileName")
                    .filter(|f| !f.is_empty())
                    .or_else(|| v_string(r, "ScriptText"))
                    .unwrap_or_default();
                out.push(Autorun::new(
                    AutorunKind::WmiConsumer,
                    true,
                    r"WMI ROOT\subscription",
                    v_string(r, "Name").unwrap_or_default(),
                    script,
                    true,
                ));
            }
        }
    }

    /// Autostarts für alle Konten (nur lesend; Systemorte, keine Nutzerdateien).
    #[must_use]
    pub fn machine_autoruns() -> Vec<Autorun> {
        let mut out = Vec::new();
        for kind in [
            AutorunKind::Run,
            AutorunKind::Winlogon,
            AutorunKind::Ifeo,
            AutorunKind::StartupFolder,
            AutorunKind::ScheduledTask,
            AutorunKind::Service,
            AutorunKind::WmiConsumer,
            AutorunKind::Driver,
        ] {
            out.extend(machine_autoruns_of(kind));
        }
        out.truncate(MAX_AUTORUNS);
        out
    }

    /// Nur eine Art (zum erneuten Prüfen vor dem Ausführen eines Plans). `Run` liefert auch
    /// `RunOnce`/`PolicyRun`, `Ifeo` auch `AppInit`.
    #[must_use]
    pub fn machine_autoruns_of(kind: AutorunKind) -> Vec<Autorun> {
        let mut out = Vec::new();
        let hklm = Hive::LocalMachine;
        match kind {
            AutorunKind::Run | AutorunKind::RunOnce | AutorunKind::PolicyRun => {
                run_keys(&hklm, true, "HKLM", &mut out);
            }
            AutorunKind::Winlogon => winlogon(&hklm, true, "HKLM", &mut out),
            AutorunKind::Ifeo | AutorunKind::AppInit => ifeo_and_appinit(&mut out),
            AutorunKind::StartupFolder => {
                if let Some(data) = std::env::var_os("ProgramData") {
                    startup_folder(
                        &PathBuf::from(data).join(r"Microsoft\Windows\Start Menu\Programs\StartUp"),
                        true,
                        &mut out,
                    );
                }
            }
            AutorunKind::ScheduledTask => tasks(&tasks_root(), &mut out),
            AutorunKind::Service => services(&mut out),
            AutorunKind::WmiConsumer => wmi_consumers(&mut out),
            AutorunKind::Driver => drivers(&mut out),
            AutorunKind::ComObject | AutorunKind::BrowserExtension => {}
        }
        out.truncate(MAX_AUTORUNS);
        out
    }

    /// Autostarts in der Registrierung eines Kontos (`HKU\<SID>`; nur lesend). Den
    /// Autostart-Ordner im Profil liest der Dienst selbst mit den Rechten des Kontos.
    #[must_use]
    pub fn user_registry_autoruns(sid: &str) -> Vec<Autorun> {
        let mut out = Vec::new();
        let hive = Hive::User(sid.to_owned());
        let label = format!(r"HKU\{sid}");
        run_keys(&hive, false, &label, &mut out);
        winlogon(&hive, false, &label, &mut out);
        let clsid = r"Software\Classes\CLSID";
        for id in read_subkeys(&hive, clsid).into_iter().take(500) {
            if let Some(server) = value(&hive, &format!(r"{clsid}\{id}\InprocServer32"), "")
                .filter(|s| !s.trim().is_empty())
            {
                out.push(Autorun::new(
                    AutorunKind::ComObject,
                    false,
                    format!(r"{label}\{clsid}"),
                    id,
                    server,
                    true,
                ));
            }
        }
        out.truncate(MAX_AUTORUNS);
        out
    }

    // -----------------------------------------------------------------------------------
    // Geräte & Privatsphäre (P6.6, nur lesend)
    // -----------------------------------------------------------------------------------

    /// Kamera-/Mikrofon-Nutzung eines Kontos laut Windows (`ConsentStore`, nur lesend).
    #[must_use]
    pub fn capability_uses(sid: &str) -> Vec<crate::devices::CapabilityUse> {
        use crate::devices::{Capability, CapabilityUse, nonpackaged_path};
        let hive = Hive::User(sid.to_owned());
        let base =
            r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore";
        let times = |key: &str| {
            let values = read_values(&hive, key);
            let get = |n: &str| {
                values
                    .iter()
                    .find(|v| v.name.eq_ignore_ascii_case(n))
                    .and_then(|v| v.data.trim().parse::<u64>().ok())
            };
            (get("LastUsedTimeStart"), get("LastUsedTimeStop"))
        };
        let mut out = Vec::new();
        for capability in [Capability::Webcam, Capability::Microphone] {
            let store = format!(r"{base}\{}", capability.store_key());
            for app in read_subkeys(&hive, &store).into_iter().take(500) {
                if app.eq_ignore_ascii_case("NonPackaged") {
                    let np = format!(r"{store}\NonPackaged");
                    for program in read_subkeys(&hive, &np).into_iter().take(500) {
                        let (start, stop) = times(&format!(r"{np}\{program}"));
                        if start.is_some() {
                            out.push(CapabilityUse::new(
                                capability,
                                nonpackaged_path(&program),
                                false,
                                start,
                                stop,
                            ));
                        }
                    }
                } else {
                    let (start, stop) = times(&format!(r"{store}\{app}"));
                    if start.is_some() {
                        out.push(CapabilityUse::new(capability, app, true, start, stop));
                    }
                }
            }
        }
        out
    }

    /// SIDs der Benutzerprofile (`ProfileList`, nur echte Konten `S-1-5-21-…`).
    #[must_use]
    pub fn profile_sids() -> Vec<String> {
        read_subkeys(
            &Hive::LocalMachine,
            r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList",
        )
        .into_iter()
        .filter(|s| s.starts_with("S-1-5-21-"))
        .take(200)
        .collect()
    }

    /// Angeschlossene Tastaturen und USB-Laufwerke (WMI, nur lesend).
    ///
    /// # Errors
    /// Tastaturen nicht abfragbar (z. B. WMI beim Hochfahren noch nicht bereit) – dann darf
    /// der Wächter weder eine Grundlinie setzen noch „neue“ Tastaturen melden.
    pub fn devices() -> Result<Vec<crate::devices::Device>, String> {
        use crate::devices::{Device, DeviceKind};
        let mut out = Vec::new();
        let rows = query(
            r"ROOT\CIMV2",
            "SELECT Name, PNPDeviceID FROM Win32_PnPEntity WHERE PNPClass = 'Keyboard' AND Present = TRUE",
            false,
        )
        .map_err(|e| format!("Tastaturen nicht abfragbar: {e}"))?;
        {
            for row in rows.iter().take(100) {
                if let Some(id) = v_string(row, "PNPDeviceID") {
                    let name = v_string(row, "Name").unwrap_or_default();
                    out.push(Device::new(DeviceKind::Keyboard, &name, &id));
                }
            }
        }
        if let Ok(rows) = query(
            r"ROOT\CIMV2",
            "SELECT Model, PNPDeviceID FROM Win32_DiskDrive WHERE InterfaceType = 'USB'",
            false,
        ) {
            for row in rows.iter().take(100) {
                if let Some(id) = v_string(row, "PNPDeviceID") {
                    let name = v_string(row, "Model").unwrap_or_default();
                    out.push(Device::new(DeviceKind::Storage, &name, &id));
                }
            }
        }
        Ok(out)
    }

    /// Liest alle Fakten (nur lesend; dauert je nach System einige Sekunden – nicht unter
    /// einer Sperre aufrufen). `user_sid`: Konto, dessen Proxy-Einstellung gelesen wird.
    #[must_use]
    pub fn collect(user_sid: Option<&str>) -> SystemFacts {
        SystemFacts {
            os_version: os_version(),
            days_since_update: days_since_update(),
            secure_boot: secure_boot(),
            tpm: tpm(),
            bitlocker: bitlocker(),
            uac: uac(),
            smb1: smb1(),
            rdp: rdp(),
            guest_enabled: guest_enabled(),
            firewall: firewall(),
            firewall_others: firewall_products(),
            antivirus: antivirus(),
            proxy: user_sid.and_then(proxy),
            dns_servers: dns_servers(),
            hosts: hosts(),
            listening: listening(),
            driver_protection: driver_protection(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uac_stufen() {
        assert_eq!(uac_level(Some(0), Some(5), Some(1)), UacLevel::Disabled);
        assert_eq!(uac_level(None, None, None), UacLevel::Default);
        assert_eq!(uac_level(Some(1), Some(2), Some(1)), UacLevel::AlwaysNotify);
        assert_eq!(
            uac_level(Some(1), Some(5), Some(0)),
            UacLevel::NoSecureDesktop
        );
        assert_eq!(uac_level(Some(1), Some(0), Some(0)), UacLevel::Never);
    }

    #[test]
    fn bitlocker_und_tpm() {
        assert_eq!(bitlocker_state(1, 1), BitLockerState::Protected);
        assert_eq!(bitlocker_state(0, 0), BitLockerState::Off);
        assert_eq!(bitlocker_state(0, 1), BitLockerState::Suspended);
        let t = tpm_state(true, true, Some("2.0, 0, 1.38"));
        assert!(t.present && t.ready);
        assert_eq!(t.version, Some(2));
        assert_eq!(tpm_state(true, false, Some("1.2")).version, Some(1));
        assert!(!tpm_state(true, false, None).ready);
    }

    #[test]
    fn sicherheitscenter_und_dns() {
        assert!(av_product_active(0x0006_1100));
        assert!(!av_product_active(0x0006_0100));
        assert!(is_defender("Windows Defender"));
        assert!(!is_defender("Avira"));
        assert_eq!(
            parse_name_servers("1.1.1.1,8.8.8.8 fe80::1 kaputt"),
            vec!["1.1.1.1", "8.8.8.8", "fe80::1"]
        );
    }

    #[test]
    fn datum_und_tage() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
        let a = parse_installed_on("10/8/2026").unwrap();
        let b = parse_installed_on("20261018").unwrap();
        assert_eq!(b - a, 10);
        assert_eq!(parse_installed_on("13/40/2026"), None);
        assert_eq!(parse_installed_on("01d9f2c3"), None);
        assert_eq!(days_since_latest(&[a, b], b + 3), Some(3));
        assert_eq!(days_since_latest(&[b + 5], b), Some(0));
        assert_eq!(days_since_latest(&[], b), None);
    }

    #[test]
    fn hosts_ort() {
        assert_eq!(
            expand_system_root(r"%SystemRoot%\System32\drivers\etc", r"C:\Windows"),
            r"C:\Windows\System32\drivers\etc"
        );
        assert_eq!(expand_system_root(r"D:\x", r"C:\Windows"), r"D:\x");
    }

    #[test]
    fn verbindungseinstellungen_ohne_proxy() {
        let mut blob = vec![0x46, 0, 0, 0, 7, 0, 0, 0, 0x03, 0, 0, 0, 0, 0];
        let cleared = connections_without_proxy(&blob).unwrap();
        assert_eq!(&cleared[4..8], &8u32.to_le_bytes());
        assert_eq!(&cleared[8..12], &1u32.to_le_bytes());
        blob[8] = 0x09;
        assert!(connections_without_proxy(&blob).is_none());
        assert!(connections_without_proxy(&[1, 2]).is_none());
    }
}
