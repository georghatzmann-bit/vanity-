//! Getaktete Verbindung (`INetworkCostManager::GetCost`, COM, ohne Adminrechte). Vertrag:
//! `docs/API.md`, „Hauptverbindung, Netz und Verbindungsart“.
//!
//! Gerüst (Phase 0a): liefert noch `None` („unbekannt“; Umsetzung: „Warum laggt es?“, F6). Das
//! Cargo-Feature `Win32_Networking_NetworkListManager` ist bereits eingetragen.

/// `true` = getaktet (fest/variabel, Roaming oder Limit), `false` = unbegrenzt, `None` = unbekannt
/// bzw. außerhalb von Windows.
pub async fn metered() -> Option<bool> {
    None
}

/// Feste Kostenwerte aus `NLM_CONNECTION_COST` (prüft beim Bauen, dass das Feature vorhanden ist).
#[cfg(windows)]
#[allow(dead_code)]
pub const COST_UNRESTRICTED: i32 = windows::Win32::Networking::NetworkListManager::NLM_CONNECTION_COST_UNRESTRICTED.0;
