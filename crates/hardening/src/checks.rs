//! Prüfungen und Sicherheits-Score.

use serde::{Deserialize, Serialize};

use crate::facts::{BitLockerState, SystemFacts, UacLevel};

/// Kennung einer Prüfung (stabil, Teil der Oberfläche und des Verlaufs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckId {
    /// Windows-Updates.
    Updates,
    /// Secure Boot.
    SecureBoot,
    /// TPM.
    Tpm,
    /// BitLocker.
    BitLocker,
    /// Benutzerkontensteuerung.
    Uac,
    /// SMBv1.
    Smb1,
    /// Remotedesktop.
    Rdp,
    /// Gastkonto.
    Guest,
    /// Firewall.
    Firewall,
    /// Virenschutz.
    Antivirus,
    /// Proxy, DNS, Hosts-Datei.
    Network,
    /// Offene Ports.
    Ports,
}

impl CheckId {
    /// Alle Prüfungen mit Gewicht (Summe 100).
    pub const ALL: [(Self, u8); 12] = [
        (Self::Updates, 15),
        (Self::SecureBoot, 8),
        (Self::Tpm, 5),
        (Self::BitLocker, 10),
        (Self::Uac, 10),
        (Self::Smb1, 7),
        (Self::Rdp, 7),
        (Self::Guest, 5),
        (Self::Firewall, 12),
        (Self::Antivirus, 12),
        (Self::Network, 5),
        (Self::Ports, 4),
    ];

    /// Gewicht im Score.
    #[must_use]
    pub fn weight(self) -> u8 {
        Self::ALL
            .iter()
            .find(|(id, _)| *id == self)
            .map_or(0, |(_, w)| *w)
    }
}

/// Ergebnis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    /// In Ordnung (volle Punkte).
    Pass,
    /// Verbesserbar (halbe Punkte).
    Warn,
    /// Risiko (keine Punkte).
    Fail,
    /// Nicht lesbar – zählt nicht.
    Unknown,
}

/// Was „Beheben“ tun würde – immer als eigener Plan mit Vorschau, Rückgängig und „Ja“.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FixKind {
    /// Benutzerkontensteuerung auf „Standard“ (Registrierung, Neustart nötig bei „aus“).
    EnableUac,
    /// SMBv1-Server abschalten (Registrierung, Neustart).
    DisableSmb1,
    /// Remotedesktop abschalten.
    DisableRdp,
    /// Anmeldung auf Netzwerkebene für Remotedesktop verlangen.
    EnableRdpNla,
    /// Gastkonto deaktivieren.
    DisableGuest,
    /// Firewall für alle Profile einschalten.
    EnableFirewall,
    /// Proxy der eigenen Sitzung abschalten.
    DisableProxy,
    /// Windows-Einstellung öffnen (AEGIS ändert dort nichts selbst).
    OpenSettings,
}

/// Ergebnis einer Prüfung.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckResult {
    /// Kennung.
    pub id: CheckId,
    /// Ergebnis.
    pub status: CheckStatus,
    /// Gewicht.
    pub weight: u8,
    /// Kurzbeschreibung (Deutsch).
    pub summary_de: String,
    /// Kurzbeschreibung (Englisch).
    pub summary_en: String,
    /// Möglicher Schritt zum Beheben.
    pub fix: Option<FixKind>,
}

/// Sicherheits-Score.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Score {
    /// 0–100 oder `None`, wenn weniger als die Hälfte bewertbar war.
    pub value: Option<u8>,
    /// Summe der Gewichte bewerteter Prüfungen.
    pub known_weight: u8,
}

fn result(
    id: CheckId,
    status: CheckStatus,
    de: impl Into<String>,
    en: impl Into<String>,
) -> CheckResult {
    CheckResult {
        id,
        status,
        weight: id.weight(),
        summary_de: de.into(),
        summary_en: en.into(),
        fix: None,
    }
}

fn unknown(id: CheckId) -> CheckResult {
    result(
        id,
        CheckStatus::Unknown,
        "Nicht lesbar – zählt nicht in den Score.",
        "Not readable – not counted in the score.",
    )
}

fn with_fix(mut r: CheckResult, fix: FixKind) -> CheckResult {
    r.fix = Some(fix);
    r
}

/// Bekannte, öffentliche DNS-Anbieter (Cloudflare, Google, Quad9, OpenDNS, AdGuard).
const KNOWN_DNS: [&str; 16] = [
    "1.1.1.1",
    "1.0.0.1",
    "8.8.8.8",
    "8.8.4.4",
    "9.9.9.9",
    "149.112.112.112",
    "208.67.222.222",
    "208.67.220.220",
    "94.140.14.14",
    "94.140.15.15",
    "2606:4700:4700::1111",
    "2606:4700:4700::1001",
    "2001:4860:4860::8888",
    "2001:4860:4860::8844",
    "2620:fe::fe",
    "2620:fe::9",
];

/// Lokale/private Adresse (Router im Heimnetz, eigener Rechner)?
#[must_use]
pub fn is_local_address(addr: &str) -> bool {
    match addr.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(v4)) => {
            v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_unspecified()
        }
        Ok(std::net::IpAddr::V6(v6)) => {
            let first = v6.segments()[0];
            v6.is_loopback()
                || v6.is_unspecified()
                || (first & 0xffc0) == 0xfe80
                || (first & 0xffc0) == 0xfec0
                || (first & 0xfe00) == 0xfc00
        }
        Err(_) => false,
    }
}

/// Namen, deren Sperre per Hosts-Datei typisch für Schadsoftware ist (Updates/Virenschutz
/// blockieren).
const SECURITY_HOSTS: [&str; 14] = [
    "windowsupdate",
    "update.microsoft",
    "download.microsoft",
    "wdcp.microsoft",
    "definitionupdates",
    "virustotal",
    "malwarebytes",
    "kaspersky",
    "eset",
    "avast",
    "avg.com",
    "bitdefender",
    "norton",
    "sophos",
];

fn network(f: &SystemFacts) -> CheckResult {
    let id = CheckId::Network;
    if f.proxy.is_none() && f.hosts.is_none() && f.dns_servers.is_empty() {
        return unknown(id);
    }
    let mut fail_de = Vec::new();
    let mut warn_de = Vec::new();
    let mut warn_en = Vec::new();
    let mut fail_en = Vec::new();
    if let Some(hosts) = &f.hosts {
        let blocked: Vec<&str> = hosts
            .iter()
            .filter(|e| is_local_address(&e.address))
            .filter(|e| SECURITY_HOSTS.iter().any(|s| e.host.contains(s)))
            .map(|e| e.host.as_str())
            .take(10)
            .collect();
        if !blocked.is_empty() {
            fail_de.push(format!(
                "Die Hosts-Datei sperrt Sicherheits-/Update-Adressen: {}",
                blocked.join(", ")
            ));
            fail_en.push(format!(
                "The hosts file blocks security/update addresses: {}",
                blocked.join(", ")
            ));
        }
        let redirected: Vec<String> = hosts
            .iter()
            .filter(|e| !is_local_address(&e.address))
            .map(|e| format!("{} → {}", e.host, e.address))
            .take(10)
            .collect();
        if !redirected.is_empty() {
            warn_de.push(format!(
                "Die Hosts-Datei leitet Namen um: {}",
                redirected.join(", ")
            ));
            warn_en.push(format!(
                "The hosts file redirects names: {}",
                redirected.join(", ")
            ));
        }
    }
    let unusual: Vec<&str> = f
        .dns_servers
        .iter()
        .map(String::as_str)
        .filter(|d| !is_local_address(d) && !KNOWN_DNS.contains(d))
        .collect();
    if !unusual.is_empty() {
        warn_de.push(format!(
            "Ungewöhnliche DNS-Server: {} (bitte prüfen, ob du sie selbst eingetragen hast)",
            unusual.join(", ")
        ));
        warn_en.push(format!(
            "Unusual DNS servers: {} (please check whether you set them yourself)",
            unusual.join(", ")
        ));
    }
    let mut fix = None;
    if let Some(proxy) = &f.proxy {
        let remote_proxy = proxy.enabled
            && proxy.server.as_deref().is_some_and(|s| {
                let host = s.split(':').next().unwrap_or(s);
                !is_local_address(host) && host != "localhost"
            });
        if remote_proxy || proxy.auto_config.is_some() {
            warn_de.push(format!(
                "Ein Proxy ist eingerichtet ({}) – Schadsoftware nutzt das, um Datenverkehr mitzulesen.",
                proxy
                    .server
                    .clone()
                    .or_else(|| proxy.auto_config.clone())
                    .unwrap_or_default()
            ));
            warn_en.push("A proxy is configured – malware uses this to intercept traffic.".into());
            fix = Some(FixKind::DisableProxy);
        }
    }
    let r = if !fail_de.is_empty() {
        fail_de.extend(warn_de);
        fail_en.extend(warn_en);
        result(id, CheckStatus::Fail, fail_de.join(" "), fail_en.join(" "))
    } else if !warn_de.is_empty() {
        result(id, CheckStatus::Warn, warn_de.join(" "), warn_en.join(" "))
    } else {
        result(
            id,
            CheckStatus::Pass,
            "Kein Proxy, keine auffälligen DNS-Server oder Hosts-Einträge.",
            "No proxy, no unusual DNS servers or hosts entries.",
        )
    };
    match fix {
        Some(fix) => with_fix(r, fix),
        None => r,
    }
}

/// Ports, die offen auf allen Schnittstellen meist ein unnötiges Risiko sind.
const RISKY_PORTS: [(u16, &str); 7] = [
    (21, "FTP"),
    (23, "Telnet"),
    (5900, "VNC"),
    (5901, "VNC"),
    (5985, "WinRM"),
    (5986, "WinRM"),
    (1080, "SOCKS-Proxy"),
];

fn ports(f: &SystemFacts) -> CheckResult {
    let id = CheckId::Ports;
    let Some(list) = &f.listening else {
        return unknown(id);
    };
    let risky: Vec<String> = list
        .iter()
        .filter(|p| p.all_interfaces)
        .filter_map(|p| {
            RISKY_PORTS
                .iter()
                .find(|(n, _)| *n == p.port)
                .map(|(n, name)| match &p.program {
                    Some(prog) => format!("{n} ({name}, {prog})"),
                    None => format!("{n} ({name})"),
                })
        })
        .collect();
    if risky.is_empty() {
        result(
            id,
            CheckStatus::Pass,
            format!(
                "{} lauschende Ports, keiner der bekannten Risiko-Dienste offen.",
                list.len()
            ),
            format!(
                "{} listening ports, none of the known risky services open.",
                list.len()
            ),
        )
    } else {
        result(
            id,
            CheckStatus::Warn,
            format!(
                "Von außen erreichbar: {} – wenn du das nicht brauchst, den Dienst beenden bzw. in der Firewall sperren.",
                risky.join(", ")
            ),
            format!(
                "Reachable from outside: {} – if you do not need it, stop the service or block it in the firewall.",
                risky.join(", ")
            ),
        )
    }
}

/// Bewertet alle Prüfungen.
#[must_use]
#[allow(clippy::too_many_lines)]
pub fn evaluate(f: &SystemFacts) -> Vec<CheckResult> {
    use CheckStatus::{Fail, Pass, Warn};
    let mut out = Vec::new();

    out.push(match f.days_since_update {
        None => unknown(CheckId::Updates),
        Some(d) if d <= 35 => result(
            CheckId::Updates,
            Pass,
            format!("Letztes Update vor {d} Tagen."),
            format!("Last update {d} days ago."),
        ),
        Some(d) => with_fix(
            result(
                CheckId::Updates,
                if d <= 90 { Warn } else { Fail },
                format!(
                    "Letztes Update vor {d} Tagen – Windows Update öffnen und Updates installieren."
                ),
                format!("Last update {d} days ago – open Windows Update and install updates."),
            ),
            FixKind::OpenSettings,
        ),
    });

    out.push(match f.secure_boot {
        None => unknown(CheckId::SecureBoot),
        Some(true) => result(CheckId::SecureBoot, Pass, "Secure Boot ist an.", "Secure Boot is on."),
        Some(false) => result(
            CheckId::SecureBoot,
            Warn,
            "Secure Boot ist aus – schützt vor Schadsoftware, die vor Windows startet. Einschalten geht nur im UEFI/BIOS des Rechners.",
            "Secure Boot is off – it protects against malware that starts before Windows. It can only be enabled in the PC's UEFI/BIOS.",
        ),
    });

    out.push(match f.tpm {
        None => unknown(CheckId::Tpm),
        Some(t) if t.present && t.ready && t.version != Some(1) => result(
            CheckId::Tpm,
            Pass,
            "TPM ist vorhanden und bereit.",
            "TPM is present and ready.",
        ),
        Some(t) if t.present => result(
            CheckId::Tpm,
            Warn,
            "TPM ist vorhanden, aber nicht bereit (bzw. Version 1.2) – im UEFI/BIOS prüfen.",
            "TPM is present but not ready (or version 1.2) – check the UEFI/BIOS.",
        ),
        Some(_) => result(
            CheckId::Tpm,
            Warn,
            "Kein TPM gefunden – BitLocker und Windows Hello sind dann schwächer.",
            "No TPM found – BitLocker and Windows Hello are weaker without it.",
        ),
    });

    out.push(match f.bitlocker {
        None => unknown(CheckId::BitLocker),
        Some(BitLockerState::Protected) => result(
            CheckId::BitLocker,
            Pass,
            "Das Systemlaufwerk ist verschlüsselt (BitLocker).",
            "The system drive is encrypted (BitLocker).",
        ),
        Some(BitLockerState::Suspended) => with_fix(
            result(
                CheckId::BitLocker,
                Warn,
                "BitLocker ist angehalten – der Schlüssel liegt ungeschützt. In den Windows-Einstellungen fortsetzen.",
                "BitLocker is suspended – the key is unprotected. Resume it in Windows settings.",
            ),
            FixKind::OpenSettings,
        ),
        Some(BitLockerState::Off) => with_fix(
            result(
                CheckId::BitLocker,
                Warn,
                "Das Systemlaufwerk ist nicht verschlüsselt – bei Diebstahl sind alle Daten lesbar.",
                "The system drive is not encrypted – if stolen, all data is readable.",
            ),
            FixKind::OpenSettings,
        ),
        Some(BitLockerState::Unavailable) => result(
            CheckId::BitLocker,
            Warn,
            "BitLocker gibt es in dieser Windows-Edition nicht – ggf. „Geräteverschlüsselung“ in den Einstellungen nutzen.",
            "BitLocker is not available in this Windows edition – use “Device encryption” in settings if offered.",
        ),
    });

    out.push(match f.uac {
        None => unknown(CheckId::Uac),
        Some(UacLevel::AlwaysNotify | UacLevel::Default) => result(
            CheckId::Uac,
            Pass,
            "Benutzerkontensteuerung ist aktiv.",
            "User Account Control is active.",
        ),
        Some(UacLevel::NoSecureDesktop) => with_fix(
            result(
                CheckId::Uac,
                Warn,
                "Benutzerkontensteuerung ohne sicheren Desktop – Programme könnten die Rückfrage nachahmen.",
                "User Account Control without secure desktop – programs could imitate the prompt.",
            ),
            FixKind::EnableUac,
        ),
        Some(UacLevel::Never | UacLevel::Disabled) => with_fix(
            result(
                CheckId::Uac,
                Fail,
                "Benutzerkontensteuerung ist aus – Programme erhalten Administratorrechte ohne Rückfrage.",
                "User Account Control is off – programs get administrator rights without asking.",
            ),
            FixKind::EnableUac,
        ),
    });

    out.push(match f.smb1 {
        None => unknown(CheckId::Smb1),
        Some(false) => result(CheckId::Smb1, Pass, "SMBv1 ist aus.", "SMBv1 is off."),
        Some(true) => with_fix(
            result(
                CheckId::Smb1,
                Fail,
                "SMBv1 ist an – veraltetes Freigabe-Protokoll, über das sich z. B. WannaCry verbreitet hat.",
                "SMBv1 is on – an outdated sharing protocol used e.g. by WannaCry to spread.",
            ),
            FixKind::DisableSmb1,
        ),
    });

    out.push(match f.rdp {
        None => unknown(CheckId::Rdp),
        Some(r) if !r.enabled => result(CheckId::Rdp, Pass, "Remotedesktop ist aus.", "Remote Desktop is off."),
        Some(r) if r.nla => with_fix(
            result(
                CheckId::Rdp,
                Warn,
                "Remotedesktop ist an (mit Anmeldung auf Netzwerkebene) – nur eingeschaltet lassen, wenn du ihn nutzt.",
                "Remote Desktop is on (with network level authentication) – keep it on only if you use it.",
            ),
            FixKind::DisableRdp,
        ),
        Some(_) => with_fix(
            result(
                CheckId::Rdp,
                Fail,
                "Remotedesktop ist an – ohne Anmeldung auf Netzwerkebene. Angreifer erreichen so den Anmeldebildschirm.",
                "Remote Desktop is on – without network level authentication. Attackers can reach the sign-in screen.",
            ),
            FixKind::EnableRdpNla,
        ),
    });

    out.push(match f.guest_enabled {
        None => unknown(CheckId::Guest),
        Some(false) => result(
            CheckId::Guest,
            Pass,
            "Gastkonto ist deaktiviert.",
            "Guest account is disabled.",
        ),
        Some(true) => with_fix(
            result(
                CheckId::Guest,
                Fail,
                "Das Gastkonto ist aktiv – jeder kann sich ohne Passwort anmelden.",
                "The guest account is active – anyone can sign in without a password.",
            ),
            FixKind::DisableGuest,
        ),
    });

    let fw = [f.firewall.domain, f.firewall.private, f.firewall.public];
    out.push(
        if fw.iter().all(Option::is_none) && f.firewall_others.is_empty() {
            unknown(CheckId::Firewall)
        } else if !f.firewall_others.is_empty() && fw.contains(&Some(false)) {
            result(
                CheckId::Firewall,
                Pass,
                format!(
                    "Aktive Firewall: {} (die Windows-Firewall ist dafür teilweise aus).",
                    f.firewall_others.join(", ")
                ),
                format!(
                    "Active firewall: {} (the Windows Firewall is partly off for it).",
                    f.firewall_others.join(", ")
                ),
            )
        } else if fw.contains(&Some(false)) {
            let off: Vec<&str> = [("Domäne", fw[0]), ("Privat", fw[1]), ("Öffentlich", fw[2])]
                .iter()
                .filter(|(_, on)| *on == Some(false))
                .map(|(n, _)| *n)
                .collect();
            with_fix(
                result(
                    CheckId::Firewall,
                    Fail,
                    format!("Die Windows-Firewall ist aus für: {}.", off.join(", ")),
                    format!("The Windows Firewall is off for: {}.", off.join(", ")),
                ),
                FixKind::EnableFirewall,
            )
        } else {
            result(
                CheckId::Firewall,
                Pass,
                "Die Windows-Firewall ist für alle Profile an.",
                "The Windows Firewall is on for all profiles.",
            )
        },
    );

    let av = &f.antivirus;
    out.push(if av.defender_realtime.is_none() && av.other_active.is_empty() {
        unknown(CheckId::Antivirus)
    } else if !av.other_active.is_empty() {
        result(
            CheckId::Antivirus,
            Pass,
            format!("Aktiver Virenschutz: {}.", av.other_active.join(", ")),
            format!("Active antivirus: {}.", av.other_active.join(", ")),
        )
    } else if av.defender_realtime == Some(true) {
        match av.defender_signature_age_days {
            Some(d) if d > 7 => with_fix(
                result(
                    CheckId::Antivirus,
                    Warn,
                    format!("Microsoft Defender ist an, die Signaturen sind aber {d} Tage alt."),
                    format!("Microsoft Defender is on, but its signatures are {d} days old."),
                ),
                FixKind::OpenSettings,
            ),
            _ => result(
                CheckId::Antivirus,
                Pass,
                "Microsoft Defender Echtzeitschutz ist an.",
                "Microsoft Defender real-time protection is on.",
            ),
        }
    } else {
        // Manipulationsschutz wird nie umgangen: AEGIS öffnet nur die Windows-Sicherheit.
        with_fix(
            result(
                CheckId::Antivirus,
                Fail,
                "Kein aktiver Echtzeit-Virenschutz – AEGIS erkennt zwar, blockiert aber nicht vor dem Start. In der Windows-Sicherheit einschalten.",
                "No active real-time antivirus – AEGIS detects but does not block before start. Turn it on in Windows Security.",
            ),
            FixKind::OpenSettings,
        )
    });

    out.push(network(f));
    out.push(ports(f));
    out
}

/// Score aus den Ergebnissen: Pass = volle, Warn = halbe Punkte; „unbekannt“ zählt nicht.
#[must_use]
pub fn score(results: &[CheckResult]) -> Score {
    let mut known = 0u32;
    let mut earned = 0u32;
    for r in results {
        let w = u32::from(r.weight);
        match r.status {
            CheckStatus::Pass => {
                known += w;
                earned += w * 2;
            }
            CheckStatus::Warn => {
                known += w;
                earned += w;
            }
            CheckStatus::Fail => known += w,
            CheckStatus::Unknown => {}
        }
    }
    let value = (known >= 50).then(|| {
        // earned ist in halben Punkten.
        u8::try_from((earned * 100 + known) / (2 * known)).unwrap_or(100)
    });
    Score {
        value,
        known_weight: u8::try_from(known).unwrap_or(100),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::facts::{
        AntivirusState, FirewallState, HostsEntry, ListeningPort, ProxyState, RdpState, TpmState,
    };

    fn good() -> SystemFacts {
        SystemFacts {
            os_version: Some("10.0.22631".into()),
            days_since_update: Some(5),
            secure_boot: Some(true),
            tpm: Some(TpmState {
                present: true,
                ready: true,
                version: Some(2),
            }),
            bitlocker: Some(BitLockerState::Protected),
            uac: Some(UacLevel::Default),
            smb1: Some(false),
            rdp: Some(RdpState {
                enabled: false,
                nla: true,
            }),
            guest_enabled: Some(false),
            firewall: FirewallState {
                domain: Some(true),
                private: Some(true),
                public: Some(true),
            },
            firewall_others: Vec::new(),
            antivirus: AntivirusState {
                defender_realtime: Some(true),
                defender_signature_age_days: Some(1),
                other_active: Vec::new(),
            },
            proxy: Some(ProxyState::default()),
            dns_servers: vec!["192.168.178.1".into()],
            hosts: Some(vec![HostsEntry {
                address: "127.0.0.1".into(),
                host: "localhost".into(),
            }]),
            listening: Some(vec![ListeningPort {
                port: 135,
                protocol: "tcp".into(),
                all_interfaces: true,
                program: None,
            }]),
        }
    }

    #[test]
    fn gewichte_ergeben_hundert() {
        let sum: u32 = CheckId::ALL.iter().map(|(_, w)| u32::from(*w)).sum();
        assert_eq!(sum, 100);
    }

    #[test]
    fn gutes_system_hundert_punkte() {
        let r = evaluate(&good());
        assert!(r.iter().all(|c| c.status == CheckStatus::Pass), "{r:#?}");
        assert_eq!(score(&r).value, Some(100));
    }

    #[test]
    fn unbekanntes_zaehlt_nicht_und_zu_wenig_ergibt_keinen_score() {
        let r = evaluate(&SystemFacts::default());
        assert!(r.iter().all(|c| c.status == CheckStatus::Unknown));
        assert_eq!(score(&r).value, None);
        let f = SystemFacts {
            days_since_update: Some(1),
            firewall: FirewallState {
                public: Some(true),
                ..FirewallState::default()
            },
            antivirus: AntivirusState {
                defender_realtime: Some(true),
                ..AntivirusState::default()
            },
            uac: Some(UacLevel::Default),
            bitlocker: Some(BitLockerState::Protected),
            ..SystemFacts::default()
        };
        assert_eq!(
            score(&evaluate(&f)).value,
            Some(100),
            "nur bewertete zählen"
        );
    }

    #[test]
    fn risiken_mit_vorschlag_zum_beheben() {
        let mut f = good();
        f.uac = Some(UacLevel::Disabled);
        f.smb1 = Some(true);
        f.rdp = Some(RdpState {
            enabled: true,
            nla: false,
        });
        f.guest_enabled = Some(true);
        f.firewall.public = Some(false);
        let r = evaluate(&f);
        let get = |id| r.iter().find(|c| c.id == id).unwrap();
        assert_eq!(get(CheckId::Uac).fix, Some(FixKind::EnableUac));
        assert_eq!(get(CheckId::Smb1).status, CheckStatus::Fail);
        assert_eq!(get(CheckId::Rdp).fix, Some(FixKind::EnableRdpNla));
        assert_eq!(get(CheckId::Guest).fix, Some(FixKind::DisableGuest));
        assert!(get(CheckId::Firewall).summary_de.contains("Öffentlich"));
        let s = score(&r).value.unwrap();
        assert!(s < 60, "{s}");
    }

    #[test]
    fn netz_hosts_dns_proxy_und_ports() {
        let mut f = good();
        f.hosts = Some(vec![HostsEntry {
            address: "0.0.0.0".into(),
            host: "www.virustotal.com".into(),
        }]);
        assert_eq!(
            evaluate(&f)
                .iter()
                .find(|c| c.id == CheckId::Network)
                .unwrap()
                .status,
            CheckStatus::Fail
        );
        let mut f = good();
        f.dns_servers = vec!["185.12.34.56".into(), "1.1.1.1".into()];
        f.proxy = Some(ProxyState {
            enabled: true,
            server: Some("203.0.113.9:8080".into()),
            auto_config: None,
        });
        let r = evaluate(&f);
        let net = r.iter().find(|c| c.id == CheckId::Network).unwrap();
        assert_eq!(net.status, CheckStatus::Warn);
        assert!(net.summary_de.contains("185.12.34.56"));
        assert!(!net.summary_de.contains("1.1.1.1"));
        assert_eq!(net.fix, Some(FixKind::DisableProxy));
        f.listening = Some(vec![ListeningPort {
            port: 5900,
            protocol: "tcp".into(),
            all_interfaces: true,
            program: Some("vnc.exe".into()),
        }]);
        let ports = evaluate(&f)
            .into_iter()
            .find(|c| c.id == CheckId::Ports)
            .unwrap();
        assert_eq!(ports.status, CheckStatus::Warn);
        assert!(ports.summary_de.contains("VNC"));
    }

    #[test]
    fn lokale_adressen() {
        for a in [
            "127.0.0.1",
            "192.168.1.1",
            "10.1.2.3",
            "fe80::1",
            "fd00::1",
            "::1",
        ] {
            assert!(is_local_address(a), "{a}");
        }
        for a in ["8.8.8.8", "2001:4860:4860::8888", "kein-ip"] {
            assert!(!is_local_address(a), "{a}");
        }
    }
}
