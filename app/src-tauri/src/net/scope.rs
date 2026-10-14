//! Umfang eines Aussetzers (`OutageScope`): PC, Heimnetz, Internet oder nur das Messziel. Vertrag:
//! `docs/API.md`, „Anbieter-Protokoll“ („Umfang eines Aussetzers“).
//!
//! Gerüst (Phase 0a): Typen und Signaturen stehen fest; Ergebnis ist noch immer `unknown`
//! (Umsetzung: Anbieter-Protokoll, F7).
#![allow(dead_code)]

use super::hist_types::OutageScope;
use super::ifstats::OperStatus;
use super::link::PrimaryLinkLite;
use crate::state::Shared;

/// Unabhängige Internet-Hosts der Umfangsprüfung.
pub const EXTERNAL_HOSTS: [[u8; 4]; 2] = [[1, 1, 1, 1], [9, 9, 9, 9]];
/// Gesamtzeit der Umfangsprüfung (ms).
pub const SCOPE_TIMEOUT_MS: u64 = 2000;

/// Anforderung des Recorders beim dritten Verlust in Folge (höchstens eine je Aussetzer).
#[derive(Debug, Clone, PartialEq)]
pub struct ScopeRequest {
    /// Beginn des Aussetzers (ms) – damit das Ergebnis dem richtigen Ereignis zugeordnet wird
    pub outage_t: i64,
    /// Hauptverbindung zu Beginn des Aussetzers
    pub link_start: Option<PrimaryLinkLite>,
    /// Router-Grundwert vorhanden (Router antwortet sonst)
    pub gateway_base: Option<f64>,
}

/// Messwerte der Umfangsprüfung (Eingabe der reinen Entscheidung).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScopeInput {
    /// `GetIfEntry2` der Hauptverbindung (`None` = nicht lesbar)
    pub status: Option<OperStatus>,
    /// Hauptverbindung zu Beginn und jetzt (frisch ermittelt)
    pub link_start: Option<PrimaryLinkLite>,
    pub link_now: Option<PrimaryLinkLite>,
    /// Router antwortet (`None` = nicht geprüft/kein Gateway)
    pub gateway_ok: Option<bool>,
    pub gateway_base: Option<f64>,
    /// Je externem Host: hat geantwortet
    pub external_ok: Vec<bool>,
    /// Prüfung lief ins Zeitlimit bzw. ist hier nicht möglich
    pub incomplete: bool,
}

/// Reine Entscheidung nach der Vertragsliste.
pub fn classify(input: &ScopeInput) -> OutageScope {
    let _ = input;
    OutageScope::Unknown
}

/// Umfangsprüfung ausführen (≤ 2 s, vom Hook per `spawn` gestartet). Nie ein Fehler.
pub async fn check(core: Shared, req: ScopeRequest) -> OutageScope {
    let _ = (core, req);
    OutageScope::Unknown
}
