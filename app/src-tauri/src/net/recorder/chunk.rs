//! Block-Format der Sitzungs-Messwerte (`session_samples.data`) für die Match-Zeitleiste.
//! Vertrag: `docs/API.md`, „Datenbank v2“ („Block-Format“).
//!
//! Gerüst (Phase 0a): Typen und Signaturen stehen fest; `ChunkWriter` sammelt noch nichts
//! (Umsetzung: Match-Zeitleiste, F2).
#![allow(dead_code)]

use crate::net::ifstats::LoadSample;
use crate::net::types::PingMethod;

/// Byte 0 jedes Blocks.
pub const FORMAT_VERSION: u8 = 1;
/// Bytes je Messwert (`off` u16, `rtt` u16, `cpu` u8, `rx` u16, `tx` u16).
pub const POINT_BYTES: usize = 9;
/// Ein Block umfasst höchstens so viele ms.
pub const CHUNK_SPAN_MS: i64 = 60_000;

/// Ein Messwert im Block (dekodiert).
#[derive(Debug, Clone, PartialEq)]
pub struct ChunkPoint {
    pub t: i64,
    /// `None` = verloren
    pub rtt: Option<f64>,
    /// CPU-Last 0–100 %, `None` = unbekannt
    pub cpu: Option<u8>,
    pub rx_mbps: Option<f64>,
    pub tx_mbps: Option<f64>,
}

/// Wozu ein Block gehört (Wechsel → neuer Block).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkKey {
    pub session_id: i64,
    pub target_key: String,
    pub target_label: String,
    /// Tatsächlich benutzte Messart (`ping::effective_method`)
    pub method: PingMethod,
}

/// Ein fertiger Block zum Schreiben.
#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    pub key: ChunkKey,
    /// Zeit des ersten Messwerts (ms UTC)
    pub chunk_start: i64,
    /// Anzahl Messwerte
    pub n: u32,
    pub data: Vec<u8>,
}

/// Messwerte → Block (`chunk_start` = Zeit des ersten Werts).
pub fn encode_chunk(chunk_start: i64, points: &[ChunkPoint]) -> Vec<u8> {
    let _ = (chunk_start, points);
    vec![FORMAT_VERSION]
}

/// Block → Messwerte; falsche Version oder Länge ≠ 1 + 9·n → `None` (nie ein Absturz).
pub fn decode_chunk(chunk_start: i64, data: &[u8]) -> Option<Vec<ChunkPoint>> {
    let _ = (chunk_start, data);
    None
}

/// Sammelt die Messwerte des Hauptziels während einer Sitzung (bei Takt unter 1 s ein Punkt je
/// Sekunde) und schließt Blöcke nach den Vertragsregeln.
#[derive(Debug, Default)]
pub struct ChunkWriter {}

impl ChunkWriter {
    /// Messwert anhängen (vorher: Uhr zurück, > 60 s oder anderer Schlüssel → neuer Block).
    pub fn push(&mut self, key: &ChunkKey, t: i64, rtt: Option<f64>, load: &LoadSample, interval_ms: u64) {
        let _ = (key, t, rtt, load, interval_ms);
    }

    /// Offenen Block schließen (Lücke, Stopp).
    pub fn close(&mut self) {}

    /// Alle fertigen Blöcke herausnehmen; ein offener Block wird dabei geschlossen.
    pub fn take(&mut self) -> Vec<Chunk> {
        Vec::new()
    }

    /// Nach einem fehlgeschlagenen Schreiben vorne wieder einreihen.
    pub fn requeue(&mut self, chunks: Vec<Chunk>) {
        let _ = chunks;
    }

    /// Blöcke einer (gelöschten Kurz-)Sitzung verwerfen.
    pub fn discard_session(&mut self, session_id: i64) {
        let _ = session_id;
    }

    /// Alles verwerfen (Wiederherstellung, `history.record = false`, Verlauf löschen).
    pub fn clear(&mut self) {}
}
