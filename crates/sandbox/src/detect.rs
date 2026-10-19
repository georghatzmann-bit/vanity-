//! Ist die Windows Sandbox (Stufe 1) verfügbar? Nur Pro/Enterprise/Education haben sie; auf
//! Home greift Stufe 2 (Mini-Sandbox) – mit klarer Meldung.

use std::path::PathBuf;

use serde::Serialize;

/// Name des optionalen Windows-Features.
pub const FEATURE: &str = "Containers-DisposableClientVM";

/// Zustand der Windows Sandbox.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SandboxStatus {
    /// `WindowsSandbox.exe` vorhanden (Feature eingeschaltet).
    pub enabled: bool,
    /// Edition unterstützt sie (nicht Home).
    pub supported: bool,
    /// Edition (z. B. „Professional“, „Core“ = Home).
    pub edition: String,
    /// `wsb`-Befehl vorhanden (ab Windows 11 24H2).
    pub wsb_cli: bool,
}

impl SandboxStatus {
    /// Ehrliche Meldung für die Oberfläche (deutsch).
    #[must_use]
    pub fn message_de(&self) -> &'static str {
        match (self.supported, self.enabled) {
            (true, true) => "Windows Sandbox ist bereit (Stufe 1, eigene VM).",
            (true, false) => {
                "Windows Sandbox ist nicht eingeschaltet. AEGIS kann sie nach deiner Bestätigung einschalten (Neustart nötig); bis dahin nutzt das Labor die Mini-Sandbox (Stufe 2)."
            }
            (false, _) => {
                "Diese Windows-Edition hat keine Windows Sandbox (z. B. Home). Das Labor nutzt die Mini-Sandbox (Stufe 2) – schwächer als eine VM."
            }
        }
    }
}

/// Programm der Windows Sandbox.
#[must_use]
pub fn sandbox_exe() -> Option<PathBuf> {
    let root = std::env::var_os("SystemRoot").map(PathBuf::from)?;
    Some(root.join(r"System32\WindowsSandbox.exe"))
}

/// Prüft den Zustand (nur lesend).
#[must_use]
pub fn status() -> SandboxStatus {
    #[cfg(windows)]
    {
        use aegis_winffi::inspect::{Hive, read_values};
        let edition = read_values(
            &Hive::LocalMachine,
            r"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
        )
        .into_iter()
        .find(|v| v.name.eq_ignore_ascii_case("EditionID"))
        .map(|v| v.data)
        .unwrap_or_default();
        let system32 = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .map(|r| r.join("System32"));
        SandboxStatus {
            enabled: sandbox_exe().is_some_and(|p| p.is_file()),
            supported: edition_supports_sandbox(&edition),
            wsb_cli: system32.is_some_and(|d| d.join("wsb.exe").is_file()),
            edition,
        }
    }
    #[cfg(not(windows))]
    {
        SandboxStatus {
            enabled: false,
            supported: false,
            edition: "kein Windows".into(),
            wsb_cli: false,
        }
    }
}

/// Home-Editionen („Core…“) haben keine Windows Sandbox.
#[must_use]
pub fn edition_supports_sandbox(edition: &str) -> bool {
    let e = edition.to_ascii_lowercase();
    !e.is_empty() && !e.starts_with("core")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editionen() {
        assert!(edition_supports_sandbox("Professional"));
        assert!(edition_supports_sandbox("Enterprise"));
        assert!(!edition_supports_sandbox("Core"));
        assert!(!edition_supports_sandbox("CoreSingleLanguage"));
        assert!(!edition_supports_sandbox(""));
        let home = SandboxStatus {
            enabled: false,
            supported: false,
            edition: "Core".into(),
            wsb_cli: false,
        };
        assert!(home.message_de().contains("Mini-Sandbox"));
    }
}
