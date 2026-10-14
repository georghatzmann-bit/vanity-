//! Block-Format der Sitzungs-Messwerte (`session_samples.data`) für die Match-Zeitleiste.
//! Vertrag: `docs/API.md`, „Datenbank v2“ („Block-Format“) und „Match-Zeitleiste“.
//!
//! Byte 0 = Formatversion `1`, danach je Messwert 9 Byte Little Endian:
//! `off` u16 (ms seit `chunk_start`), `rtt` u16 (× 10, `0xFFFF` = verloren), `cpu` u8 (`0xFF` =
//! unbekannt), `rx`/`tx` u16 (Mbit/s × 10, `0xFFFF` = unbekannt).
//!
//! `ChunkWriter` ist rein (keine Ein-/Ausgabe): Er sammelt die Messwerte des Hauptziels während
//! einer Sitzung und schließt Blöcke nach den Vertragsregeln. Bei einem Takt unter 1 s wird je
//! volle Sekunde **ein** Punkt gespeichert (Zeit = erster Wert der Sekunde, Ping = Mittel der
//! Antworten, verloren, wenn mehr als die Hälfte verloren ging; CPU/rx/tx = letzter Wert).

use crate::net::ifstats::LoadSample;
use crate::net::types::PingMethod;

/// Byte 0 jedes Blocks.
pub const FORMAT_VERSION: u8 = 1;
/// Bytes je Messwert (`off` u16, `rtt` u16, `cpu` u8, `rx` u16, `tx` u16).
pub const POINT_BYTES: usize = 9;
/// Ein Block umfasst höchstens so viele ms.
pub const CHUNK_SPAN_MS: i64 = 60_000;
/// Kennwert „verloren“ bzw. „unbekannt“ der u16-Felder.
const NONE_U16: u16 = 0xFFFF;
/// Kennwert „unbekannt“ der CPU-Last.
const NONE_U8: u8 = 0xFF;
/// Größter speicherbarer u16-Wert (6553,4 ms bzw. 6553,4 Mbit/s).
const MAX_U16: u16 = 65_534;

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

/// Wert × 10, gerundet, auf 0–65534 begrenzt; nicht endlich oder negativ → `None`.
fn tenths(v: Option<f64>) -> Option<u16> {
    let v = v.filter(|x| x.is_finite() && *x >= 0.0)?;
    let scaled = (v * 10.0).round().min(f64::from(MAX_U16));
    // `scaled` liegt sicher in 0..=65534 (oben geprüft); trotzdem über `try_from`
    u16::try_from(scaled as i64).ok()
}

/// CPU-Last 0–100 % als u8; unbekannt bzw. nicht endlich → `None`.
fn cpu_byte(v: Option<f32>) -> Option<u8> {
    let v = v.filter(|x| x.is_finite())?;
    let r = f64::from(v).round().clamp(0.0, 100.0);
    u8::try_from(r as i64).ok()
}

/// Messwerte → Block (`chunk_start` = Zeit des ersten Werts). Ein Wert, dessen Abstand zu
/// `chunk_start` nicht in 0–60000 ms passt, wird ausgelassen (der Writer erzeugt so etwas nie).
pub fn encode_chunk(chunk_start: i64, points: &[ChunkPoint]) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + POINT_BYTES * points.len());
    out.push(FORMAT_VERSION);
    for p in points {
        let Some(off) = p.t.checked_sub(chunk_start).filter(|d| *d <= CHUNK_SPAN_MS).and_then(|d| u16::try_from(d).ok()) else {
            continue;
        };
        let rtt = tenths(p.rtt).unwrap_or(NONE_U16);
        let cpu = p.cpu.filter(|c| *c <= 100).unwrap_or(NONE_U8);
        let rx = tenths(p.rx_mbps).unwrap_or(NONE_U16);
        let tx = tenths(p.tx_mbps).unwrap_or(NONE_U16);
        out.extend_from_slice(&off.to_le_bytes());
        out.extend_from_slice(&rtt.to_le_bytes());
        out.push(cpu);
        out.extend_from_slice(&rx.to_le_bytes());
        out.extend_from_slice(&tx.to_le_bytes());
    }
    out
}

/// Anzahl Messwerte eines Blocks aus seiner Länge (`None` bei falscher Version oder Länge).
pub fn point_count(data: &[u8]) -> Option<usize> {
    let (&version, rest) = data.split_first()?;
    (version == FORMAT_VERSION && rest.len() % POINT_BYTES == 0).then_some(rest.len() / POINT_BYTES)
}

/// Block → Messwerte; falsche Version oder Länge ≠ 1 + 9·n → `None` (nie ein Absturz).
pub fn decode_chunk(chunk_start: i64, data: &[u8]) -> Option<Vec<ChunkPoint>> {
    point_count(data)?;
    let rest = data.get(1..)?;
    let u16_at = |b: &[u8], i: usize| -> Option<u16> { Some(u16::from_le_bytes([*b.get(i)?, *b.get(i + 1)?])) };
    let from_tenths = |v: u16| (v != NONE_U16).then(|| f64::from(v) / 10.0);
    rest.chunks_exact(POINT_BYTES)
        .map(|b| {
            let off = u16_at(b, 0)?;
            let rtt = u16_at(b, 2)?;
            let cpu = *b.get(4)?;
            let rx = u16_at(b, 5)?;
            let tx = u16_at(b, 7)?;
            Some(ChunkPoint {
                t: chunk_start.checked_add(i64::from(off))?,
                rtt: from_tenths(rtt),
                cpu: (cpu <= 100).then_some(cpu),
                rx_mbps: from_tenths(rx),
                tx_mbps: from_tenths(tx),
            })
        })
        .collect()
}

/// Ein offener Block.
#[derive(Debug, Clone)]
struct OpenChunk {
    key: ChunkKey,
    chunk_start: i64,
    last_t: i64,
    points: Vec<ChunkPoint>,
}

impl OpenChunk {
    fn finish(self) -> Option<Chunk> {
        if self.points.is_empty() {
            return None;
        }
        let data = encode_chunk(self.chunk_start, &self.points);
        let n = u32::try_from(point_count(&data)?).ok()?;
        (n > 0).then_some(Chunk { key: self.key, chunk_start: self.chunk_start, n, data })
    }
}

/// Verdichtung bei Takt unter 1 s: Werte einer vollen Sekunde.
#[derive(Debug, Clone)]
struct SecondAcc {
    key: ChunkKey,
    /// Volle Sekunde (`t.div_euclid(1000)`)
    sec: i64,
    /// Zeit des ersten Werts der Sekunde
    t_first: i64,
    /// Zeit des letzten Werts (Uhr zurückgestellt → neue Sekunde)
    t_last: i64,
    sum: f64,
    answers: u32,
    lost: u32,
    cpu: Option<u8>,
    rx: Option<f64>,
    tx: Option<f64>,
}

impl SecondAcc {
    fn point(&self) -> ChunkPoint {
        let total = self.answers + self.lost;
        // verloren, wenn mehr als die Hälfte verloren ging
        let rtt = (self.answers > 0 && self.lost * 2 <= total).then(|| self.sum / f64::from(self.answers));
        ChunkPoint { t: self.t_first, rtt, cpu: self.cpu, rx_mbps: self.rx, tx_mbps: self.tx }
    }
}

/// Sammelt die Messwerte des Hauptziels während einer Sitzung (bei Takt unter 1 s ein Punkt je
/// Sekunde) und schließt Blöcke nach den Vertragsregeln.
#[derive(Debug, Default)]
pub struct ChunkWriter {
    open: Option<OpenChunk>,
    /// Laufende Sekunde (nur bei Takt unter 1 s)
    second: Option<SecondAcc>,
    /// Fertige Blöcke, älteste zuerst
    done: Vec<Chunk>,
}

impl ChunkWriter {
    /// Messwert anhängen (vorher: Uhr zurück, > 60 s oder anderer Schlüssel → neuer Block).
    pub fn push(&mut self, key: &ChunkKey, t: i64, rtt: Option<f64>, load: &LoadSample, interval_ms: u64) {
        let rtt = rtt.filter(|v| v.is_finite() && *v >= 0.0);
        let cpu = cpu_byte(load.cpu);
        let rx = load.rx_mbps.filter(|v| v.is_finite() && *v >= 0.0);
        let tx = load.tx_mbps.filter(|v| v.is_finite() && *v >= 0.0);
        let sub_second = interval_ms < 1000;
        let sec = t.div_euclid(1000);

        // Laufende Sekunde abschließen: neue Sekunde, anderer Schlüssel, Uhr zurück oder Takt ≥ 1 s
        if let Some(acc) = self.second.as_ref() {
            if !sub_second || acc.key != *key || acc.sec != sec || t < acc.t_last {
                self.flush_second();
            }
        }

        if !sub_second {
            self.append(key, ChunkPoint { t, rtt, cpu, rx_mbps: rx, tx_mbps: tx });
            return;
        }
        match self.second.as_mut() {
            Some(acc) => {
                acc.t_last = t;
                match rtt {
                    Some(v) => {
                        acc.sum += v;
                        acc.answers += 1;
                    }
                    None => acc.lost += 1,
                }
                acc.cpu = cpu;
                acc.rx = rx;
                acc.tx = tx;
            }
            None => {
                self.second = Some(SecondAcc {
                    key: key.clone(),
                    sec,
                    t_first: t,
                    t_last: t,
                    sum: rtt.unwrap_or(0.0),
                    answers: u32::from(rtt.is_some()),
                    lost: u32::from(rtt.is_none()),
                    cpu,
                    rx,
                    tx,
                });
            }
        }
    }

    /// Laufende Sekunde als Punkt anhängen.
    fn flush_second(&mut self) {
        if let Some(acc) = self.second.take() {
            let point = acc.point();
            self.append(&acc.key, point);
        }
    }

    /// Punkt an den offenen Block hängen; Uhr zurück, mehr als 60 s seit Blockbeginn oder anderer
    /// Schlüssel → Block schließen, neuer Block ab diesem Punkt.
    fn append(&mut self, key: &ChunkKey, point: ChunkPoint) {
        let must_close = self
            .open
            .as_ref()
            .is_some_and(|o| o.key != *key || point.t < o.last_t || point.t - o.chunk_start > CHUNK_SPAN_MS);
        if must_close {
            self.close_block();
        }
        match self.open.as_mut() {
            Some(o) => {
                o.last_t = point.t;
                o.points.push(point);
            }
            None => {
                self.open = Some(OpenChunk { key: key.clone(), chunk_start: point.t, last_t: point.t, points: vec![point] });
            }
        }
    }

    fn close_block(&mut self) {
        if let Some(chunk) = self.open.take().and_then(OpenChunk::finish) {
            self.done.push(chunk);
        }
    }

    /// Offenen Block schließen (Lücke, Stopp) – eine laufende Sekunde zählt noch mit.
    pub fn close(&mut self) {
        self.flush_second();
        self.close_block();
    }

    /// Alle fertigen Blöcke herausnehmen; ein offener Block wird dabei geschlossen. Eine noch
    /// laufende Sekunde (Takt unter 1 s) bleibt für den nächsten Block stehen.
    pub fn take(&mut self) -> Vec<Chunk> {
        self.close_block();
        std::mem::take(&mut self.done)
    }

    /// Nach einem fehlgeschlagenen Schreiben vorne wieder einreihen. (Der Recorder-Kern hält nicht
    /// geschriebene Stapel selbst – siehe Phase 0b; die Methode bleibt für andere Aufrufer.)
    #[allow(dead_code)]
    pub fn requeue(&mut self, chunks: Vec<Chunk>) {
        let mut chunks = chunks;
        chunks.append(&mut self.done);
        self.done = chunks;
    }

    /// Blöcke einer (gelöschten Kurz-)Sitzung verwerfen.
    pub fn discard_session(&mut self, session_id: i64) {
        self.done.retain(|c| c.key.session_id != session_id);
        if self.open.as_ref().is_some_and(|o| o.key.session_id == session_id) {
            self.open = None;
        }
        if self.second.as_ref().is_some_and(|s| s.key.session_id == session_id) {
            self.second = None;
        }
    }

    /// Alles verwerfen (Wiederherstellung, `history.record = false`, Verlauf löschen).
    pub fn clear(&mut self) {
        self.open = None;
        self.second = None;
        self.done.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(session_id: i64, target: &str) -> ChunkKey {
        ChunkKey { session_id, target_key: target.into(), target_label: format!("{target} (Label)"), method: PingMethod::Icmp }
    }

    fn load(cpu: Option<f32>, rx: Option<f64>, tx: Option<f64>) -> LoadSample {
        LoadSample { at: 0, cpu, rx_mbps: rx, tx_mbps: tx, status: None }
    }

    fn pt(t: i64, rtt: Option<f64>) -> ChunkPoint {
        ChunkPoint { t, rtt, cpu: Some(30), rx_mbps: Some(1.5), tx_mbps: Some(0.2) }
    }

    #[test]
    fn chunk_roundtrip() {
        let start = 1_700_000_000_000;
        let points = vec![
            ChunkPoint { t: start, rtt: Some(23.44), cpu: Some(42), rx_mbps: Some(12.34), tx_mbps: Some(0.06) },
            // verloren, CPU/rx/tx unbekannt
            ChunkPoint { t: start + 1000, rtt: None, cpu: None, rx_mbps: None, tx_mbps: None },
            // Kappung bei 6553,4 ms und 6553,4 Mbit/s
            ChunkPoint { t: start + 2000, rtt: Some(99_999.0), cpu: Some(100), rx_mbps: Some(1e9), tx_mbps: Some(6553.4) },
            ChunkPoint { t: start + 60_000, rtt: Some(0.0), cpu: Some(0), rx_mbps: Some(0.0), tx_mbps: Some(0.0) },
        ];
        let data = encode_chunk(start, &points);
        assert_eq!(data.len(), 1 + 9 * points.len());
        assert_eq!(data[0], FORMAT_VERSION);
        let back = decode_chunk(start, &data).expect("gültiger Block");
        assert_eq!(back.len(), 4);
        assert_eq!(back[0], ChunkPoint { t: start, rtt: Some(23.4), cpu: Some(42), rx_mbps: Some(12.3), tx_mbps: Some(0.1) });
        assert_eq!(back[1], ChunkPoint { t: start + 1000, rtt: None, cpu: None, rx_mbps: None, tx_mbps: None });
        assert_eq!(back[2].rtt, Some(6553.4));
        assert_eq!(back[2].rx_mbps, Some(6553.4));
        assert_eq!(back[2].tx_mbps, Some(6553.4));
        assert_eq!(back[2].cpu, Some(100));
        assert_eq!(back[3].t, start + 60_000);
        assert_eq!(back[3].rtt, Some(0.0));
        // Byte-Layout des ersten Werts: off 0, rtt 234, cpu 42, rx 123, tx 1
        assert_eq!(&data[1..10], &[0, 0, 234, 0, 42, 123, 0, 1, 0]);
    }

    #[test]
    fn encode_skips_points_outside_span_and_bad_values() {
        let start = 10_000;
        let points = vec![
            pt(start - 1, Some(1.0)),
            pt(start + 60_001, Some(1.0)),
            ChunkPoint { t: start, rtt: Some(f64::NAN), cpu: Some(200), rx_mbps: Some(-1.0), tx_mbps: Some(f64::INFINITY) },
        ];
        let data = encode_chunk(start, &points);
        let back = decode_chunk(start, &data).expect("gültig");
        assert_eq!(back, vec![ChunkPoint { t: start, rtt: None, cpu: None, rx_mbps: None, tx_mbps: None }]);
    }

    #[test]
    fn bad_chunk_is_skipped() {
        let good = encode_chunk(0, &[pt(0, Some(10.0))]);
        assert!(decode_chunk(0, &good).is_some());
        // falsche Version
        let mut wrong = good.clone();
        wrong[0] = 2;
        assert_eq!(decode_chunk(0, &wrong), None);
        // Länge ≠ 1 + 9·n
        assert_eq!(decode_chunk(0, &good[..good.len() - 1]), None);
        let mut long = good.clone();
        long.push(0);
        assert_eq!(decode_chunk(0, &long), None);
        // leer
        assert_eq!(decode_chunk(0, &[]), None);
        // nur die Version = 0 Punkte (gültig, aber leer)
        assert_eq!(decode_chunk(0, &[FORMAT_VERSION]), Some(vec![]));
        // Überlauf der Zeit führt nicht zum Absturz
        assert_eq!(decode_chunk(i64::MAX, &encode_chunk(0, &[pt(5, Some(1.0))])), None);
    }

    #[test]
    fn chunk_closes_after_60s_or_target_change() {
        let mut w = ChunkWriter::default();
        let a = key(1, "aws-eu-central-1");
        let l = load(Some(20.0), Some(1.0), Some(0.5));
        // 0 … 60 s (61 Werte) passen in einen Block, 61 s beginnt einen neuen
        for i in 0..=61 {
            w.push(&a, 1_000_000 + i * 1000, Some(20.0), &l, 1000);
        }
        // Zielwechsel → neuer Block
        let b = key(1, "valve-cs2-fra");
        w.push(&b, 1_062_000, Some(30.0), &l, 1000);
        // Sitzungswechsel → neuer Block
        let c = key(2, "valve-cs2-fra");
        w.push(&c, 1_063_000, Some(30.0), &l, 1000);
        let chunks = w.take();
        assert_eq!(chunks.len(), 4);
        assert_eq!((chunks[0].chunk_start, chunks[0].n), (1_000_000, 61));
        assert_eq!((chunks[1].chunk_start, chunks[1].n), (1_061_000, 1));
        assert_eq!(chunks[2].key.target_key, "valve-cs2-fra");
        assert_eq!(chunks[2].key.target_label, "valve-cs2-fra (Label)");
        assert_eq!(chunks[3].key.session_id, 2);
        for c in &chunks {
            assert_eq!(c.data.len(), 1 + 9 * c.n as usize);
            let pts = decode_chunk(c.chunk_start, &c.data).expect("gültig");
            assert!(pts.iter().all(|p| p.t - c.chunk_start <= CHUNK_SPAN_MS));
        }
        // nichts mehr offen
        assert!(w.take().is_empty());
    }

    #[test]
    fn take_closes_open_chunk_and_next_starts_fresh() {
        let mut w = ChunkWriter::default();
        let a = key(1, "x");
        let l = LoadSample::default();
        w.push(&a, 0, Some(1.0), &l, 1000);
        w.push(&a, 1000, Some(1.0), &l, 1000);
        let first = w.take();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].n, 2);
        w.push(&a, 2000, Some(1.0), &l, 1000);
        let second = w.take();
        assert_eq!(second[0].chunk_start, 2000);
        assert_eq!(second[0].n, 1);
    }

    #[test]
    fn sub_second_interval_stores_1s_points() {
        let mut w = ChunkWriter::default();
        let a = key(1, "x");
        // Sekunde 0: 20, 30, verloren, 40 → Mittel der Antworten 30 (1 von 4 verloren)
        let base = 5_000_000;
        let vals = [Some(20.0), Some(30.0), None, Some(40.0)];
        for (i, v) in vals.iter().enumerate() {
            let cpu = 10.0 + i as f32;
            w.push(&a, base + 250 * i as i64, *v, &load(Some(cpu), Some(i as f64), Some(0.1)), 250);
        }
        // Sekunde 1: 3 von 4 verloren → verloren
        let vals = [None, None, Some(50.0), None];
        for (i, v) in vals.iter().enumerate() {
            w.push(&a, base + 1000 + 250 * i as i64, *v, &load(Some(50.0), None, None), 250);
        }
        // Sekunde 2: genau die Hälfte verloren → nicht verloren
        let vals = [Some(60.0), None];
        for (i, v) in vals.iter().enumerate() {
            w.push(&a, base + 2000 + 500 * i as i64, *v, &load(None, Some(2.0), Some(1.0)), 500);
        }
        w.close();
        let chunks = w.take();
        assert_eq!(chunks.len(), 1);
        let pts = decode_chunk(chunks[0].chunk_start, &chunks[0].data).expect("gültig");
        assert_eq!(pts.len(), 3, "ein Punkt je Sekunde");
        assert_eq!(pts[0], ChunkPoint { t: base, rtt: Some(30.0), cpu: Some(13), rx_mbps: Some(3.0), tx_mbps: Some(0.1) });
        assert_eq!(pts[1].t, base + 1000);
        assert_eq!(pts[1].rtt, None);
        assert_eq!(pts[1].cpu, Some(50));
        assert_eq!(pts[2], ChunkPoint { t: base + 2000, rtt: Some(60.0), cpu: None, rx_mbps: Some(2.0), tx_mbps: Some(1.0) });
        // 2 h bei 250 ms → genau 7200 Punkte (ein Punkt je Sekunde)
        let mut w = ChunkWriter::default();
        for i in 0..(2 * 3600 * 4) {
            w.push(&a, i * 250, Some(10.0), &LoadSample::default(), 250);
        }
        w.close();
        let n: u32 = w.take().iter().map(|c| c.n).sum();
        assert_eq!(n, 7200);
    }

    #[test]
    fn take_keeps_running_second() {
        let mut w = ChunkWriter::default();
        let a = key(1, "x");
        let l = LoadSample::default();
        w.push(&a, 0, Some(10.0), &l, 250);
        w.push(&a, 250, Some(20.0), &l, 250);
        // Schreiben mitten in der Sekunde: die Sekunde läuft weiter
        assert!(w.take().is_empty());
        w.push(&a, 500, Some(30.0), &l, 250);
        w.push(&a, 1000, Some(40.0), &l, 250);
        let chunks = w.take();
        assert_eq!(chunks.len(), 1);
        let pts = decode_chunk(chunks[0].chunk_start, &chunks[0].data).expect("gültig");
        assert_eq!(pts, vec![ChunkPoint { t: 0, rtt: Some(20.0), cpu: None, rx_mbps: None, tx_mbps: None }]);
        w.close();
        let rest = w.take();
        assert_eq!(rest[0].chunk_start, 1000);
    }

    #[test]
    fn clock_backwards_starts_new_chunk() {
        let mut w = ChunkWriter::default();
        let a = key(1, "x");
        let l = LoadSample::default();
        w.push(&a, 100_000, Some(10.0), &l, 1000);
        w.push(&a, 101_000, Some(10.0), &l, 1000);
        // Uhr zurückgestellt
        w.push(&a, 50_000, Some(11.0), &l, 1000);
        w.push(&a, 51_000, Some(11.0), &l, 1000);
        // auch bei Takt unter 1 s
        w.push(&a, 52_000, Some(11.0), &l, 250);
        w.push(&a, 51_900, Some(12.0), &l, 250);
        w.close();
        let chunks = w.take();
        let starts: Vec<i64> = chunks.iter().map(|c| c.chunk_start).collect();
        assert_eq!(starts, vec![100_000, 50_000, 51_900]);
        for c in &chunks {
            assert!(decode_chunk(c.chunk_start, &c.data).is_some());
        }
    }

    #[test]
    fn discard_and_clear() {
        let mut w = ChunkWriter::default();
        let l = LoadSample::default();
        w.push(&key(1, "x"), 0, Some(1.0), &l, 1000);
        w.push(&key(2, "x"), 1000, Some(1.0), &l, 1000);
        w.push(&key(2, "x"), 2000, Some(1.0), &l, 250);
        w.discard_session(2);
        let chunks = w.take();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].key.session_id, 1);
        w.push(&key(3, "x"), 0, Some(1.0), &l, 1000);
        w.clear();
        assert!(w.take().is_empty());
        // requeue reiht vorne ein
        w.push(&key(4, "x"), 5000, Some(1.0), &l, 1000);
        w.close();
        w.requeue(chunks);
        let all = w.take();
        assert_eq!(all.iter().map(|c| c.key.session_id).collect::<Vec<_>>(), vec![1, 4]);
    }
}
