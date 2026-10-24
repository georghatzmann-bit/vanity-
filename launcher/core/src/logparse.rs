//! Erkennt wichtige Stellen in den Zeilen, die Fortnite schreibt.
//! Die Muster stammen aus der Recherche (Reboot Launcher, Unreal-Logs) – selbst formuliert.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Detection {
    /// Anmeldung beim (eigenen) Backend fertig
    LoggedIn,
    /// Server lauscht auf seinem Port
    ServerListening,
    /// Spieldateien kaputt oder unvollständig
    BuildCorrupted,
    /// Backend nicht erreichbar / Anmeldung abgelehnt
    CannotConnect,
    /// Match vorbei (nur noch ein Team übrig)
    MatchEnded,
    /// Spiel fährt herunter
    Shutdown,
}

impl Detection {
    pub fn label(self) -> &'static str {
        match self {
            Detection::LoggedIn => "Anmeldung erkannt",
            Detection::ServerListening => "Server bereit",
            Detection::BuildCorrupted => "Build beschädigt",
            Detection::CannotConnect => "Keine Verbindung zum Backend",
            Detection::MatchEnded => "Match vorbei",
            Detection::Shutdown => "Spiel wird beendet",
        }
    }
}

const CORRUPTED: &[&str] = &[
    "Critical error",
    "when 0 bytes remain",
    "Pak chunk signature verification failed!",
    "LogWindows:Error: Fatal error!",
];

const CANNOT_CONNECT: &[&str] = &[
    "port 3551 failed: Connection refused",
    "Unable to login to Fortnite servers",
    "Network failure when attempting to check platform restrictions",
    "UOnlineAccountCommon::ForceLogout",
];

pub fn detect(line: &str) -> Option<Detection> {
    if line.contains("[UOnlineAccountCommon::ContinueLoggingIn]") && line.contains("(Completed)") {
        return Some(Detection::LoggedIn);
    }
    if line.contains("FOnlineSubsystemGoogleCommon::Shutdown()") {
        return Some(Detection::Shutdown);
    }
    if CORRUPTED.iter().any(|p| line.contains(p)) {
        return Some(Detection::BuildCorrupted);
    }
    if CANNOT_CONNECT.iter().any(|p| line.contains(p)) {
        return Some(Detection::CannotConnect);
    }
    if line.contains("TeamsLeft: 1") {
        return Some(Detection::MatchEnded);
    }
    if line.contains("IpNetDriver") && line.to_ascii_lowercase().contains("listening on port") {
        return Some(Detection::ServerListening);
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    Info,
    Warning,
    Error,
}

/// Zerlegt eine Unreal-Logzeile „[Zeit][Frame]LogKategorie: Warning: Text“.
pub fn split_line(line: &str) -> (Level, String, String) {
    let mut rest = line.trim_end();
    // Zeitstempel-Klammern vorne entfernen
    while rest.starts_with('[') {
        match rest.find(']') {
            Some(end) => rest = &rest[end + 1..],
            None => break,
        }
    }
    let (category, message) = match rest.find(": ") {
        Some(pos) if pos < 48 && !rest[..pos].contains(' ') => (rest[..pos].to_string(), &rest[pos + 2..]),
        _ => (String::new(), rest),
    };
    let (level, message) = if let Some(m) = message.strip_prefix("Error: ") {
        (Level::Error, m)
    } else if let Some(m) = message.strip_prefix("Warning: ") {
        (Level::Warning, m)
    } else if let Some(m) = message.strip_prefix("Fatal: ") {
        (Level::Error, m)
    } else if line.contains("Error:") || line.contains("Fatal error") {
        (Level::Error, message)
    } else {
        (Level::Info, message)
    };
    (level, category, message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login() {
        let l = "[2026.10.23-18.02.11:204][ 12]LogOnlineAccount: Display: [UOnlineAccountCommon::ContinueLoggingIn] Login completed (Completed)";
        assert_eq!(detect(l), Some(Detection::LoggedIn));
    }

    #[test]
    fn listening_and_end() {
        assert_eq!(
            detect("LogNet: GameNetDriver IpNetDriver_2147482533 IpNetDriver listening on port 7777"),
            Some(Detection::ServerListening)
        );
        assert_eq!(detect("LogFort: TeamsLeft: 1"), Some(Detection::MatchEnded));
    }

    #[test]
    fn errors() {
        assert_eq!(detect("LogPakFile: Error: Pak chunk signature verification failed!"), Some(Detection::BuildCorrupted));
        assert_eq!(detect("LogHttp: Warning: ... port 3551 failed: Connection refused"), Some(Detection::CannotConnect));
        assert_eq!(detect("LogInit: Build: ++Fortnite+Release-19.10"), None);
    }

    #[test]
    fn splits() {
        let (lv, cat, msg) = split_line("[2026.10.23-18.02.11:204][  0]LogHttp: Warning: Retry 1");
        assert_eq!(lv, Level::Warning);
        assert_eq!(cat, "LogHttp");
        assert_eq!(msg, "Retry 1");
        let (lv, cat, msg) = split_line("plain text without category");
        assert_eq!(lv, Level::Info);
        assert_eq!(cat, "");
        assert_eq!(msg, "plain text without category");
    }
}
