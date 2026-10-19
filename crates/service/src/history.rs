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

/// Höchstzahl gemerkter Einträge insgesamt (älteste fallen heraus).
pub const MAX_ENTRIES: usize = 4000;
/// Höchstzahl Einträge je Konto bzw. Profil – ein Konto kann die Berichte anderer nicht
/// verdrängen.
pub const MAX_PER_OWNER: usize = 500;
/// Höchstzahl Pfade je Eintrag.
pub const MAX_PATHS: usize = 20;
/// Höchstlänge eines Pfads im Verlauf (Zeichen).
pub const MAX_PATH_CHARS: usize = 1024;
/// Höchstlänge von Titel bzw. Einzelheiten (Zeichen).
const MAX_TITLE: usize = 400;
const MAX_DETAIL: usize = 4000;
/// Zielgröße der Datei; darüber fallen die ältesten Einträge heraus.
const MAX_BYTES: usize = 16 * 1024 * 1024;
/// Höchstzahl Einträge je Abfrage.
pub const MAX_QUERY: usize = 500;
/// Kürzt Text auf `max` Zeichen (mit „…“).
fn clip(text: String, max: usize) -> String {
    if text.chars().count() <= max {
        text
    } else {
        let mut t: String = text.chars().take(max).collect();
        t.push('…');
        t
    }
}

fn clip_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if text.chars().count() <= MAX_PATH_CHARS {
        path
    } else {
        PathBuf::from(clip(text.into_owned(), MAX_PATH_CHARS))
    }
}

fn same_key(e: &HistoryEntry, owner: Option<&String>, scope: Option<&PathBuf>) -> bool {
    e.owner.as_ref() == owner && e.scope.as_ref() == scope
}

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
    /// Labor-Lauf (Verhaltensbericht).
    Lab,
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
    crate::paths::same_path(a, b)
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
}

/// Ein vorbereitetes Speichern (Daten serialisiert; Schreiben außerhalb jeder Sperre).
#[derive(Debug)]
pub struct PendingSave {
    path: PathBuf,
    json: Vec<u8>,
}

impl PendingSave {
    /// Schreibt die Datei.
    ///
    /// # Errors
    /// Schreiben fehlgeschlagen.
    pub fn write(&self) -> io::Result<()> {
        crate::store::save_bytes(&self.path, &self.json)
    }
}

impl History {
    /// Öffnet den Verlauf (fehlt die Datei: leer).
    ///
    /// # Errors
    /// Datei beschädigt oder nicht lesbar.
    pub fn open(path: &Path) -> io::Result<Self> {
        let (data, set_aside) = crate::store::load_or_set_aside(path, "Verlauf")?;
        let mut history = Self {
            path: Some(path.to_owned()),
            data: data.unwrap_or_default(),
            save_failed: false,
            dirty: false,
        };
        if set_aside {
            history.add(
                OffsetDateTime::now_utc(),
                NewEntry {
                    kind: HistoryKind::Update,
                    risk: None,
                    title: "Verlauf war beschädigt und wurde beiseitegelegt (history.json.corrupt)"
                        .into(),
                    detail: String::new(),
                    paths: Vec::new(),
                    owner: None,
                    scope: None,
                },
            );
        }
        Ok(history)
    }

    /// Nur im Speicher (Tests).
    #[must_use]
    pub fn in_memory() -> Self {
        Self {
            path: None,
            data: Stored::default(),
            save_failed: false,
            dirty: false,
        }
    }

    /// Fügt einen Eintrag hinzu (nur im Speicher; gesichert wird über
    /// [`History::prepare_save`]). Texte und Pfade werden gekürzt; je Konto/Profil gilt eine
    /// eigene Obergrenze. Der Verlauf ist ein Bericht, kein Prüfprotokoll (das ist `AuditLog`).
    pub fn add(&mut self, at: OffsetDateTime, entry: NewEntry) {
        self.data.next_seq += 1;
        let mut paths = entry.paths;
        paths.truncate(MAX_PATHS);
        let paths = paths.into_iter().map(clip_path).collect();
        let scope = entry.scope.map(clip_path);
        let owner = entry.owner;
        let count = self
            .data
            .entries
            .iter()
            .filter(|e| same_key(e, owner.as_ref(), scope.as_ref()))
            .count();
        if count >= MAX_PER_OWNER
            && let Some(i) = self
                .data
                .entries
                .iter()
                .position(|e| same_key(e, owner.as_ref(), scope.as_ref()))
        {
            self.data.entries.remove(i);
        }
        self.data.entries.push_back(HistoryEntry {
            seq: self.data.next_seq,
            at,
            kind: entry.kind,
            risk: entry.risk,
            title: clip(entry.title, MAX_TITLE),
            detail: clip(entry.detail, MAX_DETAIL),
            paths,
            owner,
            scope,
        });
        while self.data.entries.len() > MAX_ENTRIES {
            self.data.entries.pop_front();
        }
        self.dirty = true;
    }

    /// Bereitet das Speichern vor (unter der Sperre: nur serialisieren); geschrieben wird mit
    /// [`PendingSave::write`] außerhalb. Wird die Datei zu groß, fallen die ältesten Einträge
    /// heraus.
    pub fn prepare_save(&mut self) -> Option<PendingSave> {
        if !self.dirty {
            return None;
        }
        let path = self.path.clone()?;
        loop {
            let json = serde_json::to_vec(&self.data).ok()?;
            if json.len() <= MAX_BYTES || self.data.entries.is_empty() {
                self.dirty = false;
                return Some(PendingSave { path, json });
            }
            let drop = (self.data.entries.len() / 10).max(1);
            self.data.entries.drain(..drop);
        }
    }

    /// Ergebnis des Schreibens festhalten.
    pub fn saved(&mut self, ok: bool) {
        self.save_failed = !ok;
        if !ok {
            self.dirty = true;
        }
    }

    /// Sichert sofort (Tests, Beenden).
    pub fn flush(&mut self) {
        if let Some(save) = self.prepare_save() {
            let ok = save.write().is_ok();
            self.saved(ok);
        }
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
        // Die Flut eines Schlüssels verdrängt die Einträge anderer Konten nicht.
        assert!(h.data.entries.iter().any(|e| e.seq == 1));
        assert_eq!(
            h.data
                .entries
                .iter()
                .filter(|e| e.owner.is_none() && e.scope.is_none())
                .count(),
            MAX_PER_OWNER
        );
    }

    #[test]
    fn lange_texte_und_pfade_werden_gekuerzt() {
        let mut h = History::in_memory();
        let long = "x".repeat(100_000);
        h.add(
            OffsetDateTime::UNIX_EPOCH,
            NewEntry {
                kind: HistoryKind::Scan,
                risk: None,
                title: long.clone(),
                detail: long.clone(),
                paths: vec![PathBuf::from(&long); 50],
                owner: None,
                scope: Some(PathBuf::from(&long)),
            },
        );
        let e = &h.data.entries[0];
        assert!(e.title.chars().count() <= MAX_TITLE + 1);
        assert!(e.detail.chars().count() <= MAX_DETAIL + 1);
        assert_eq!(e.paths.len(), MAX_PATHS);
        assert!(e.paths[0].to_string_lossy().chars().count() <= MAX_PATH_CHARS + 1);
    }

    #[test]
    fn beschaedigter_verlauf_wird_gemeldet() {
        let dir = tempfile::tempdir().unwrap();
        let file =
            aegis_core::testing::write_fixture(dir.path(), "history.json", b"[kaputt").unwrap();
        // Beschädigt: beiseitegelegt, Dienst startet mit leerem Verlauf (+ Hinweis).
        let h = History::open(&file).unwrap();
        let all = h.list(Reader {
            owner: None,
            profile: None,
        });
        assert_eq!(all.len(), 1);
        assert!(all[0].title.contains("beiseitegelegt"));
        assert!(dir.path().join("history.json.corrupt").exists());
        assert!(!file.exists());
    }
}
