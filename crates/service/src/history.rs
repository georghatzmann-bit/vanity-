//! Verlauf für Berichte und Zeitleiste: Scans, ausgeführte Aktionen (nach „Ja“), Antworten
//! ohne Ausführung, Meldungen des Wächters, geplante Scans und Signatur-Updates. Je Eintrag
//! nur Zusammenfassung und betroffene Pfade (keine Dateiinhalte). Sichtbar ist ein Eintrag
//! nur für das Konto, dem er gehört (bzw. dessen Profil er betrifft); gemeinsame Einträge
//! (USB, Programme, Updates) sehen alle. Gespeichert als JSON im Datenordner.

use std::collections::VecDeque;
use std::io;
use std::path::{Path, PathBuf};

use aegis_core::risk::RiskLevel;
use aegis_core::time::OffsetDateTime;
use serde::{Deserialize, Serialize};

/// Höchstzahl gemerkter Einträge (älteste fallen heraus).
pub const MAX_ENTRIES: usize = 2000;
/// Höchstzahl Pfade je Eintrag.
pub const MAX_PATHS: usize = 20;
/// Höchstzahl Einträge je Abfrage.
pub const MAX_QUERY: usize = 500;
/// Höchstens so oft wird die Datei geschrieben; dazwischen sammelt der Verlauf (der Dienst
/// sichert spätestens jede Minute mit [`History::flush`]).
const SAVE_EVERY: std::time::Duration = std::time::Duration::from_secs(5);

/// Art eines Eintrags.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryKind {
    /// Manueller Scan.
    Scan,
    /// Ausgeführte Aktion (nach „Ja, ausführen“).
    Action,
    /// Antwort ohne Ausführung („Nein“, „Ignorieren“, „Vertrauen“).
    Decision,
    /// Meldung des Echtzeit-Wächters.
    Watch,
    /// Geplanter Scan.
    Schedule,
    /// Signatur-Update.
    Update,
}

/// Ein Eintrag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryEntry {
    /// Laufende Nummer.
    pub seq: u64,
    /// Zeitpunkt.
    #[serde(with = "aegis_core::time::serde::rfc3339")]
    pub at: OffsetDateTime,
    /// Art.
    pub kind: HistoryKind,
    /// Höchste Risikostufe (falls zutreffend).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk: Option<RiskLevel>,
    /// Kurzfassung (deutsch).
    pub title: String,
    /// Einzelheiten (deutsch, mehrzeilig möglich).
    #[serde(default)]
    pub detail: String,
    /// Betroffene Pfade (höchstens [`MAX_PATHS`]).
    #[serde(default)]
    pub paths: Vec<PathBuf>,
    /// Konto (SID), dem der Eintrag gehört.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// Profilordner, den der Eintrag betrifft (Wächter, geplante Scans).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<PathBuf>,
}

/// Neuer Eintrag (ohne Nummer und Zeit).
#[derive(Debug, Clone)]
pub struct NewEntry {
    /// Art.
    pub kind: HistoryKind,
    /// Höchste Risikostufe.
    pub risk: Option<RiskLevel>,
    /// Kurzfassung.
    pub title: String,
    /// Einzelheiten.
    pub detail: String,
    /// Betroffene Pfade.
    pub paths: Vec<PathBuf>,
    /// Konto.
    pub owner: Option<String>,
    /// Profilordner.
    pub scope: Option<PathBuf>,
}

/// Wer den Verlauf liest.
#[derive(Debug, Clone, Copy)]
pub struct Reader<'a> {
    /// Konto (`None` = ohne Kontotrennung: alles).
    pub owner: Option<&'a str>,
    /// Profilordner des Kontos.
    pub profile: Option<&'a Path>,
}

impl HistoryEntry {
    /// Darf `reader` diesen Eintrag sehen?
    #[must_use]
    pub fn visible_to(&self, reader: Reader<'_>) -> bool {
        let Some(me) = reader.owner else {
            return true;
        };
        match (&self.owner, &self.scope) {
            (Some(owner), _) => owner == me,
            (None, None) => true,
            (None, Some(scope)) => reader.profile.is_some_and(|p| same_dir(p, scope)),
        }
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    next_seq: u64,
    entries: VecDeque<HistoryEntry>,
}

/// Der Verlauf.
#[derive(Debug)]
pub struct History {
    path: Option<PathBuf>,
    data: Stored,
    /// Speichern ist fehlgeschlagen (wird im Bericht angezeigt).
    save_failed: bool,
    /// Ungespeicherte Einträge vorhanden?
    dirty: bool,
    last_save: Option<std::time::Instant>,
}

impl History {
    /// Öffnet den Verlauf (fehlt die Datei: leer).
    ///
    /// # Errors
    /// Datei beschädigt oder nicht lesbar.
    pub fn open(path: &Path) -> io::Result<Self> {
        let data = crate::store::load(path, "Verlauf")?.unwrap_or_default();
        Ok(Self {
            path: Some(path.to_owned()),
            data,
            save_failed: false,
            dirty: false,
            last_save: None,
        })
    }

    /// Nur im Speicher (Tests).
    #[must_use]
    pub fn in_memory() -> Self {
        Self {
            path: None,
            data: Stored::default(),
            save_failed: false,
            dirty: false,
            last_save: None,
        }
    }

    /// Fügt einen Eintrag hinzu und speichert. Ein Speicherfehler verhindert nichts – der
    /// Verlauf ist ein Bericht, kein Prüfprotokoll (das ist `AuditLog`).
    pub fn add(&mut self, at: OffsetDateTime, entry: NewEntry) {
        self.data.next_seq += 1;
        let mut paths = entry.paths;
        paths.truncate(MAX_PATHS);
        self.data.entries.push_back(HistoryEntry {
            seq: self.data.next_seq,
            at,
            kind: entry.kind,
            risk: entry.risk,
            title: entry.title,
            detail: entry.detail,
            paths,
            owner: entry.owner,
            scope: entry.scope,
        });
        while self.data.entries.len() > MAX_ENTRIES {
            self.data.entries.pop_front();
        }
        self.dirty = true;
        if self.last_save.is_none_or(|t| t.elapsed() >= SAVE_EVERY) {
            self.flush();
        }
    }

    /// Schreibt ungespeicherte Einträge in die Datei.
    pub fn flush(&mut self) {
        if !self.dirty {
            return;
        }
        if let Some(path) = &self.path {
            self.save_failed = crate::store::save(path, &self.data).is_err();
            self.last_save = Some(std::time::Instant::now());
        }
        self.dirty = false;
    }

    /// Sichtbare Einträge, neueste zuerst (höchstens [`MAX_QUERY`]).
    #[must_use]
    pub fn list(&self, reader: Reader<'_>) -> Vec<HistoryEntry> {
        self.data
            .entries
            .iter()
            .rev()
            .filter(|e| e.visible_to(reader))
            .take(MAX_QUERY)
            .cloned()
            .collect()
    }

    /// Ist das letzte Speichern fehlgeschlagen?
    #[must_use]
    pub fn save_failed(&self) -> bool {
        self.save_failed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(owner: Option<&str>, scope: Option<&str>) -> NewEntry {
        NewEntry {
            kind: HistoryKind::Scan,
            risk: Some(RiskLevel::Dangerous),
            title: "Scan".into(),
            detail: String::new(),
            paths: (0..30).map(|i| PathBuf::from(format!("/x/{i}"))).collect(),
            owner: owner.map(str::to_owned),
            scope: scope.map(PathBuf::from),
        }
    }

    #[test]
    fn sichtbarkeit_reihenfolge_grenzen_und_dauerhaft() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("history.json");
        let mut h = History::open(&file).unwrap();
        let t = OffsetDateTime::UNIX_EPOCH;
        h.add(t, entry(Some("S-A"), None));
        h.add(t, entry(Some("S-B"), None));
        h.add(t, entry(None, Some("/u/a")));
        h.add(t, entry(None, None));
        let a = Reader {
            owner: Some("S-A"),
            profile: Some(Path::new("/u/a")),
        };
        let seqs: Vec<u64> = h.list(a).iter().map(|e| e.seq).collect();
        assert_eq!(
            seqs,
            [4, 3, 1],
            "neueste zuerst; eigenes Konto, eigenes Profil, gemeinsam"
        );
        let b = Reader {
            owner: Some("S-B"),
            profile: None,
        };
        let seqs: Vec<u64> = h.list(b).iter().map(|e| e.seq).collect();
        assert_eq!(seqs, [4, 2]);
        assert_eq!(h.list(a)[0].paths.len(), MAX_PATHS);
        h.flush();
        let reopened = History::open(&file).unwrap();
        assert_eq!(
            reopened
                .list(Reader {
                    owner: None,
                    profile: None
                })
                .len(),
            4
        );
        assert!(!h.save_failed());
        for _ in 0..MAX_ENTRIES {
            h.add(t, entry(None, None));
        }
        let all = h.list(Reader {
            owner: None,
            profile: None,
        });
        assert_eq!(all.len(), MAX_QUERY);
        assert_eq!(all[0].seq, 4 + MAX_ENTRIES as u64);
    }

    #[test]
    fn beschaedigter_verlauf_wird_gemeldet() {
        let dir = tempfile::tempdir().unwrap();
        let file =
            aegis_core::testing::write_fixture(dir.path(), "history.json", b"[kaputt").unwrap();
        assert!(History::open(&file).is_err());
    }
}
