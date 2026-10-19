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

#[cfg(windows)]
pub use self::windows::collect;

#[cfg(windows)]
mod windows {
    use std::collections::HashMap;
    use std::io::Read;
    use std::path::PathBuf;

    use aegis_winffi::inspect::{Hive, read_subkeys, read_values};
    use wmi::{AuthLevel, Variant, WMIConnection, WMIError};

    use super::{
        av_product_active, bitlocker_state, days_since_latest, expand_system_root, is_defender,
        parse_installed_on, parse_name_servers, tpm_state, uac_level,
    };
    use crate::facts::{
        AntivirusState, BitLockerState, FirewallState, ListeningPort, ProxyState, RdpState,
        SystemFacts, TpmState, parse_hosts,
    };

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
        FirewallState {
            domain: read("DomainProfile", "DomainProfile"),
            private: read("StandardProfile", "PrivateProfile"),
            public: read("PublicProfile", "PublicProfile"),
        }
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
        let rows = query(
            r"ROOT\CIMV2",
            "SELECT SID, Disabled FROM Win32_UserAccount WHERE LocalAccount = TRUE",
            false,
        )
        .ok()?;
        rows.iter()
            .find(|r| v_string(r, "SID").is_some_and(|s| s.ends_with("-501")))
            .and_then(|r| v_bool(r, "Disabled"))
            .map(|disabled| !disabled)
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
            antivirus: antivirus(),
            proxy: user_sid.and_then(proxy),
            dns_servers: dns_servers(),
            hosts: hosts(),
            listening: listening(),
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
}
