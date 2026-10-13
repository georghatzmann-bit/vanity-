//! Datentypen des Optimierungs-Bereichs (Vertrag mit `app/src/lib/types.ts`, alles camelCase).

use serde::{Deserialize, Serialize};

/// Eine Optimierung mit aktuellem Zustand. Alle Optimierungen kommen ohne Adminrechte aus.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tweak {
    /// "powerPlan" | "gameMode" | "gameDvr" | "mouseAccel"
    pub id: String,
    /// "power" | "windows" | "input"
    pub category: String,
    /// "high" | "medium" | "low" – ehrliche Einschätzung der Wirkung
    pub impact: String,
    /// "on" | "off" | "unknown" | "unsupported"
    pub state: String,
    /// Optionaler Hinweis, z. B. Name des aktiven Energieplans
    pub detail: Option<String>,
    /// Pulsar hat den Originalwert gesichert und kann exakt zurückstellen
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerPlan {
    pub guid: String,
    pub name: String,
    pub active: bool,
}

/// Was beim Boost passieren soll.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BoostProfile {
    /// Energieplan „Höchstleistung“ aktivieren (danach zurück)
    pub power_plan: bool,
    /// "normal" | "above" | "high"
    pub game_priority: String,
    /// DNS-Zwischenspeicher vor dem Spiel leeren
    pub flush_dns: bool,
}

impl Default for BoostProfile {
    fn default() -> Self {
        Self {
            power_plan: true,
            game_priority: "high".into(),
            flush_dns: true,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoostAction {
    /// "powerPlan" | "priority" | "flushDns"
    pub id: String,
    pub ok: bool,
    pub detail: String,
}

/// Zustand des Boosts (auch als Event `boost://state`).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoostState {
    pub active: bool,
    pub since: Option<i64>,
    pub game_id: Option<String>,
    pub actions: Vec<BoostAction>,
}
