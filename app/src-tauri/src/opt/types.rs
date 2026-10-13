//! Datentypen des Optimierungs-Bereichs (Vertrag mit `app/src/lib/types.ts`, alles camelCase).

use serde::{Deserialize, Serialize};

/// Eine Optimierung mit aktuellem Zustand.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tweak {
    pub id: String,
    /// "power" | "windows" | "network" | "gpu"
    pub category: String,
    /// "high" | "medium" | "low" – ehrliche Einschätzung der Wirkung
    pub impact: String,
    /// Braucht Adminrechte (Windows fragt einmal nach)
    pub admin: bool,
    /// Wirkt erst nach einem Neustart
    pub reboot: bool,
    /// "on" | "off" | "unknown" | "unsupported"
    pub state: String,
    /// Optionaler Hinweis, z. B. aktueller Wert
    pub detail: Option<String>,
    /// Pulsar hat den Originalwert gesichert und kann zurückstellen
    pub can_revert: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TweakError {
    pub id: String,
    pub error: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    pub applied: Vec<String>,
    pub failed: Vec<TweakError>,
    pub needs_reboot: bool,
    /// Die Admin-Abfrage wurde abgelehnt
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerPlan {
    pub guid: String,
    pub name: String,
    pub active: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimReport {
    pub freed_mb: f64,
    pub processes: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcInfo {
    pub pid: u32,
    pub name: String,
    pub exe: Option<String>,
    pub mem_mb: f64,
    pub cpu: f32,
    /// "app" (hat ein Fenster) | "background" | "system"
    pub kind: String,
    /// Darf Pulsar das Programm schließen (keine Systemprozesse)?
    pub closable: bool,
}

/// Was beim Boost passieren soll.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BoostProfile {
    /// Energieplan „Höchstleistung“ aktivieren (danach zurück)
    pub power_plan: bool,
    /// "normal" | "above" | "high"
    pub game_priority: String,
    /// Programme (Exe-Namen, z. B. "chrome.exe"), die während des Spiels geschlossen werden
    pub close_apps: Vec<String>,
    /// Geschlossene Programme nach dem Spiel wieder öffnen
    pub reopen_apps: bool,
    pub trim_memory: bool,
    pub flush_dns: bool,
}

impl Default for BoostProfile {
    fn default() -> Self {
        Self {
            power_plan: true,
            game_priority: "high".into(),
            close_apps: Vec::new(),
            reopen_apps: true,
            trim_memory: false,
            flush_dns: true,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoostAction {
    /// "powerPlan" | "priority" | "closeApps" | "trimMemory" | "flushDns"
    pub id: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedApp {
    pub name: String,
    pub exe: Option<String>,
}

/// Zustand des Boosts (auch als Event `boost://state`).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoostState {
    pub active: bool,
    pub since: Option<i64>,
    pub game_id: Option<String>,
    pub actions: Vec<BoostAction>,
    pub closed: Vec<ClosedApp>,
}
