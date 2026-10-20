//! Hosts-Datei-Ansicht (Werkzeug 18) – nur lesend. Markiert Einträge, die bekannte Dienste auf
//! eine fremde Adresse umleiten (ein typischer Trick von Schadsoftware), und solche, die
//! Adressen sperren (0.0.0.0/127.0.0.1).

use serde::Serialize;

/// Einordnung eines Eintrags.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// Standard (localhost).
    Default,
    /// Sperrt eine Adresse (zeigt auf 0.0.0.0/127.0.0.1/::1).
    Block,
    /// Leitet einen bekannten Dienst (Windows Update, Microsoft, Banken-Suchmaschinen …) um.
    Suspicious,
    /// Andere Umleitung.
    Redirect,
}

/// Ein Eintrag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HostEntry {
    /// Zeile (ab 1).
    pub line: usize,
    /// Adresse.
    pub address: String,
    /// Hostname.
    pub host: String,
    /// Einordnung.
    pub kind: Kind,
}

/// Bekannte Dienste, deren Umleitung verdächtig ist.
const WATCHED: &[&str] = &[
    "microsoft.com",
    "windowsupdate.com",
    "update.microsoft.com",
    "live.com",
    "office.com",
    "bing.com",
    "google.com",
    "apple.com",
    "paypal.com",
    "amazon.com",
    "github.com",
    "virustotal.com",
    "malwarebytes.com",
    "kaspersky.com",
    "avast.com",
    "eset.com",
    "bitdefender.com",
];

fn watched(host: &str) -> bool {
    WATCHED
        .iter()
        .any(|w| host == *w || host.ends_with(&format!(".{w}")))
}

fn loopback(address: &str) -> bool {
    matches!(
        address,
        "0.0.0.0" | "127.0.0.1" | "::1" | "::" | "0:0:0:0:0:0:0:1"
    ) || address.starts_with("127.")
}

/// Liest den Inhalt der Hosts-Datei.
#[must_use]
pub fn parse(text: &str) -> Vec<HostEntry> {
    let mut out = Vec::new();
    for (index, raw) in text.lines().enumerate().take(100_000) {
        let line = raw.split('#').next().unwrap_or_default().trim();
        let mut parts = line.split_whitespace();
        let Some(address) = parts.next() else {
            continue;
        };
        for host in parts.take(64) {
            let host = host.to_ascii_lowercase();
            let kind = if host == "localhost" || host == "localhost.localdomain" {
                Kind::Default
            } else if loopback(address) {
                Kind::Block
            } else if watched(&host) {
                Kind::Suspicious
            } else {
                Kind::Redirect
            };
            out.push(HostEntry {
                line: index + 1,
                address: address.chars().take(64).collect(),
                host: host.chars().take(253).collect(),
                kind,
            });
            if out.len() >= 20_000 {
                return out;
            }
        }
    }
    out
}

/// Pfad der Hosts-Datei.
#[must_use]
pub fn path() -> std::path::PathBuf {
    std::env::var_os("SystemRoot")
        .map_or_else(
            || std::path::PathBuf::from(r"C:\Windows"),
            std::path::PathBuf::from,
        )
        .join(r"System32\drivers\etc\hosts")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn einordnung() {
        let e = parse(
            "# Kommentar\n127.0.0.1 localhost\n0.0.0.0 werbung.example # Sperre\n203.0.113.5 www.paypal.com login.paypal.com\n10.0.0.2 nas.local\n",
        );
        let kinds: Vec<Kind> = e.iter().map(|x| x.kind).collect();
        assert_eq!(
            kinds,
            [
                Kind::Default,
                Kind::Block,
                Kind::Suspicious,
                Kind::Suspicious,
                Kind::Redirect
            ]
        );
        assert_eq!(e[2].line, 4);
    }
}
