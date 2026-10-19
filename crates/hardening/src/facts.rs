//! Gelesene Fakten über das System. `None` heißt immer „nicht lesbar/unbekannt“.

use serde::{Deserialize, Serialize};

/// Zustand des TPM.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TpmState {
    /// Vorhanden?
    pub present: bool,
    /// Eingeschaltet und bereit?
    pub ready: bool,
    /// Hauptversion (1 oder 2).
    pub version: Option<u8>,
}

/// BitLocker auf dem Systemlaufwerk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BitLockerState {
    /// Verschlüsselt und geschützt.
    Protected,
    /// Verschlüsselt, Schutz aber angehalten.
    Suspended,
    /// Nicht verschlüsselt.
    Off,
    /// Diese Windows-Edition bietet kein BitLocker (Home) – ggf. „Geräteverschlüsselung“.
    Unavailable,
}

/// Stufe der Benutzerkontensteuerung.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UacLevel {
    /// Immer benachrichtigen.
    AlwaysNotify,
    /// Standard (nur bei Änderungen durch Programme, sicherer Desktop).
    Default,
    /// Ohne abgedunkelten (sicheren) Desktop.
    NoSecureDesktop,
    /// Nie benachrichtigen.
    Never,
    /// Benutzerkontensteuerung ganz aus (`EnableLUA = 0`).
    Disabled,
}

/// Remotedesktop.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RdpState {
    /// Eingehende Verbindungen erlaubt?
    pub enabled: bool,
    /// Anmeldung auf Netzwerkebene (NLA) verlangt?
    pub nla: bool,
}

/// Windows-Firewall je Netzwerkprofil (`None` = unbekannt).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FirewallState {
    /// Domäne.
    pub domain: Option<bool>,
    /// Privat.
    pub private: Option<bool>,
    /// Öffentlich.
    pub public: Option<bool>,
}

/// Virenschutz.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AntivirusState {
    /// Microsoft Defender Echtzeitschutz an?
    pub defender_realtime: Option<bool>,
    /// Alter der Defender-Signaturen (Tage).
    pub defender_signature_age_days: Option<u32>,
    /// Andere registrierte Virenschutzprogramme (Windows-Sicherheitscenter), aktiv.
    pub other_active: Vec<String>,
}

/// Proxy der eigenen Sitzung.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProxyState {
    /// Manueller Proxy an?
    pub enabled: bool,
    /// Proxy-Server (falls gesetzt).
    pub server: Option<String>,
    /// Automatisches Konfigurationsskript (PAC).
    pub auto_config: Option<String>,
}

/// Eintrag der Hosts-Datei.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostsEntry {
    /// Ziel-Adresse.
    pub address: String,
    /// Name.
    pub host: String,
}

/// Lauschender Port.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListeningPort {
    /// Portnummer.
    pub port: u16,
    /// `tcp` oder `udp`.
    pub protocol: String,
    /// Auf allen Schnittstellen (nicht nur lokal)?
    pub all_interfaces: bool,
    /// Programm (falls lesbar).
    pub program: Option<String>,
}

/// Alles, was die Prüfungen brauchen.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SystemFacts {
    /// Windows-Version (z. B. „10.0.22631.4317“).
    pub os_version: Option<String>,
    /// Tage seit dem neuesten installierten Update.
    pub days_since_update: Option<u32>,
    /// Secure Boot an?
    pub secure_boot: Option<bool>,
    /// TPM.
    pub tpm: Option<TpmState>,
    /// BitLocker auf dem Systemlaufwerk.
    pub bitlocker: Option<BitLockerState>,
    /// Benutzerkontensteuerung.
    pub uac: Option<UacLevel>,
    /// SMBv1-Server an?
    pub smb1: Option<bool>,
    /// Remotedesktop.
    pub rdp: Option<RdpState>,
    /// Gastkonto aktiviert?
    pub guest_enabled: Option<bool>,
    /// Firewall.
    pub firewall: FirewallState,
    /// Aktive Firewalls anderer Hersteller (Windows-Sicherheitscenter).
    #[serde(default)]
    pub firewall_others: Vec<String>,
    /// Virenschutz.
    pub antivirus: AntivirusState,
    /// Proxy der Sitzung des anfragenden Kontos.
    pub proxy: Option<ProxyState>,
    /// Konfigurierte DNS-Server.
    pub dns_servers: Vec<String>,
    /// Einträge der Hosts-Datei (ohne Kommentare).
    pub hosts: Option<Vec<HostsEntry>>,
    /// Lauschende Ports.
    pub listening: Option<Vec<ListeningPort>>,
}

/// Liest die Hosts-Datei (Text): Einträge ohne Kommentare, höchstens 10 000.
#[must_use]
pub fn parse_hosts(text: &str) -> Vec<HostsEntry> {
    text.lines()
        .filter_map(|line| {
            let line = line.split('#').next().unwrap_or("").trim();
            let mut parts = line.split_whitespace();
            let address = parts.next().filter(|a| a.len() <= 255)?;
            let hosts: Vec<&str> = parts.filter(|h| h.len() <= 255).take(64).collect();
            (!hosts.is_empty()).then(|| {
                hosts
                    .into_iter()
                    .map(|h| HostsEntry {
                        address: address.to_owned(),
                        host: h.to_ascii_lowercase(),
                    })
                    .collect::<Vec<_>>()
            })
        })
        .flatten()
        .take(10_000)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_ohne_kommentare() {
        let text = "# Kommentar\n127.0.0.1 localhost\n\n::1 localhost # ipv6\n10.0.0.5 bank.example  www.bank.example\n";
        let e = parse_hosts(text);
        assert_eq!(e.len(), 4);
        assert_eq!(e[2].address, "10.0.0.5");
        assert_eq!(e[3].host, "www.bank.example");
    }
}
