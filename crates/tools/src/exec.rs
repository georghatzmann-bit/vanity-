//! Ausführen einer freigegebenen Vorschau und Rückgängigmachen. Jeder Schritt prüft vorher, ob
//! die Lage noch der Vorschau entspricht (Größe, Änderungszeit, Ziel frei); sonst wird er
//! übersprungen. Nichts wird überschrieben, nichts endgültig gelöscht (Papierkorb).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::autostart::EntryRef;
use crate::guard::allowed;
use crate::plan::{Approved, Op, Tool};
use crate::platform::{Platform, Recycled};
use crate::walk::file_state;

/// Wie ein Schritt zurückgenommen wird.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "undo", rename_all = "snake_case")]
pub enum Undo {
    /// Zurückverschieben.
    MoveBack {
        /// Wo die Datei jetzt liegt.
        now: PathBuf,
        /// Wohin sie zurückgeht.
        back: PathBuf,
        /// Größe.
        size: u64,
        /// Änderungszeit.
        modified: i64,
    },
    /// Aus dem Papierkorb zurückholen.
    Restore {
        /// Eintrag im Papierkorb.
        item: Recycled,
        /// Ursprünglicher Ort.
        original: PathBuf,
    },
    /// Ordner wieder anlegen.
    CreateDir {
        /// Ordner.
        path: PathBuf,
    },
    /// Voriges Hintergrundbild.
    Wallpaper {
        /// Bild.
        previous: PathBuf,
    },
    /// Autostart-Eintrag wieder auf den vorigen Stand.
    Autostart {
        /// Eintrag.
        entry: EntryRef,
        /// Vorher an?
        enabled: bool,
    },
    /// Voriger Registrierungswert.
    Registry {
        /// Schlüssel unter `HKCU`.
        key: String,
        /// Wertname.
        name: String,
        /// Wert vorher.
        previous: crate::tweaks::Value,
    },
    /// Voriges Desktop-Layout.
    DesktopLayout {
        /// Layout vor dem Setzen.
        previous: crate::desktop::Layout,
    },
}

/// Ergebnis eines Schritts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Ausgeführt.
    Done,
    /// Übersprungen (abgewählt oder Lage verändert).
    Skipped,
    /// Fehlgeschlagen.
    Failed,
    /// Zurückgenommen.
    Undone,
}

/// Ein Schritt im Protokoll.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Item {
    /// Beschreibung.
    pub label: String,
    /// Ergebnis.
    pub status: Status,
    /// Grund bei Übersprungen/Fehler.
    pub reason: Option<String>,
    /// Rücknahme (nur bei `Done`).
    pub undo: Option<Undo>,
}

/// Ein Lauf im Protokoll.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Run {
    /// Kennung.
    pub id: String,
    /// Vorschau.
    pub plan: String,
    /// Werkzeug.
    pub tool: Tool,
    /// Regel (Hintergrund-Überwachung).
    pub rule: Option<String>,
    /// Zeitpunkt (Unix-Sekunden).
    pub at: i64,
    /// Schritte.
    pub items: Vec<Item>,
    /// Zurückgenommen am.
    pub undone: Option<i64>,
}

impl Run {
    /// Zahl ausgeführter Schritte.
    #[must_use]
    pub fn done(&self) -> usize {
        self.items
            .iter()
            .filter(|i| i.status == Status::Done)
            .count()
    }
}

fn skipped(label: String, reason: &str) -> Item {
    Item {
        label,
        status: Status::Skipped,
        reason: Some(reason.to_owned()),
        undo: None,
    }
}

fn failed(label: String, error: &std::io::Error) -> Item {
    Item {
        label,
        status: Status::Failed,
        reason: Some(error.to_string()),
        undo: None,
    }
}

fn done(label: String, undo: Undo) -> Item {
    Item {
        label,
        status: Status::Done,
        reason: None,
        undo: Some(undo),
    }
}

/// Freier Zielname: `name.ext`, sonst `name (2).ext`, `name (3).ext` …
#[must_use]
pub fn free_name(target: &Path) -> Option<PathBuf> {
    if std::fs::symlink_metadata(target).is_err() {
        return Some(target.to_path_buf());
    }
    let stem = target.file_stem()?.to_string_lossy().into_owned();
    let ext = target
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    (2..1000)
        .map(|n| target.with_file_name(format!("{stem} ({n}){ext}")))
        .find(|p| std::fs::symlink_metadata(p).is_err())
}

fn ensure_dir(dir: &Path) -> std::io::Result<()> {
    // Legt nur Zielordner unter einem vom Nutzer gewählten Ort an (Vorschau zeigte das Ziel).
    // aegis-mutation: tools-create-dir
    #[allow(clippy::disallowed_methods)]
    std::fs::create_dir_all(dir)
}

fn rename(from: &Path, to: &Path) -> std::io::Result<()> {
    // Windows: verschiebt ohne zu überschreiben (scheitert, falls das Ziel inzwischen existiert).
    #[cfg(windows)]
    {
        aegis_winffi::shell::move_no_replace(from, to)
    }
    #[cfg(not(windows))]
    {
        if std::fs::symlink_metadata(to).is_ok() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "Ziel belegt",
            ));
        }
        // Verschiebt genau die freigegebene Datei (Ziel eben frei geprüft; nur Entwicklung).
        // aegis-mutation: tools-move
        #[allow(clippy::disallowed_methods)]
        std::fs::rename(from, to)
    }
}

fn move_file(
    from: &Path,
    to: &Path,
    size: u64,
    modified: i64,
) -> Result<Undo, Result<&'static str, std::io::Error>> {
    if !allowed(from) || !allowed(to) {
        return Err(Ok("geschützter Ort"));
    }
    if file_state(from) != Some((size, modified)) {
        return Err(Ok("seit der Vorschau verändert"));
    }
    // Nur Groß-/Kleinschreibung ändert sich (Umbenenner): dieselbe Datei, kein „(2)“.
    let same_file = from.parent() == to.parent()
        && from.file_name().zip(to.file_name()).is_some_and(|(a, b)| {
            a != b && a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
        });
    let target = if same_file {
        to.to_path_buf()
    } else {
        free_name(to).ok_or(Ok("kein freier Zielname"))?
    };
    if let Some(parent) = target.parent() {
        ensure_dir(parent).map_err(Err)?;
    }
    rename(from, &target).map_err(Err)?;
    Ok(Undo::MoveBack {
        now: target,
        back: from.to_path_buf(),
        size,
        modified,
    })
}

/// Überschreibt eine Datei einmal mit Zufallsdaten, benennt sie zufällig um und löscht sie.
fn shred(path: &Path, size: u64) -> std::io::Result<()> {
    use std::io::{Seek, Write};
    {
        // Öffnet die freigegebene Datei zum Überschreiben (Link vorher ausgeschlossen).
        // aegis-mutation: tools-shred-open
        #[allow(clippy::disallowed_methods)]
        let mut file = std::fs::OpenOptions::new().write(true).open(path)?;
        file.seek(std::io::SeekFrom::Start(0))?;
        let mut remaining = size;
        let mut chunk = vec![0u8; 1024 * 1024];
        while remaining > 0 {
            let n = usize::try_from(remaining.min(chunk.len() as u64)).unwrap_or(chunk.len());
            let part = chunk
                .get_mut(..n)
                .ok_or_else(|| std::io::Error::other("Puffer"))?;
            fill_random(part)?;
            file.write_all(part)?;
            remaining -= n as u64;
        }
        file.sync_all()?;
    }
    let hidden = path.with_file_name(uuid::Uuid::new_v4().simple().to_string());
    rename(path, &hidden)?;
    // Endgültiges Löschen der eben überschriebenen Datei – nur nach zweiter Bestätigung.
    // aegis-mutation: tools-shred-remove
    #[allow(clippy::disallowed_methods)]
    std::fs::remove_file(&hidden)
}

fn fill_random(buffer: &mut [u8]) -> std::io::Result<()> {
    // Zufall des Betriebssystems (kein Muster, das sich wiedererkennen ließe).
    getrandom::fill(buffer).map_err(|e| std::io::Error::other(e.to_string()))
}

fn step(op: &Op, platform: &dyn Platform, final_ok: bool) -> Item {
    let label = op.label();
    let result: Result<Undo, Result<&'static str, std::io::Error>> =
        match op {
            Op::Move {
                from,
                to,
                size,
                modified,
            } => move_file(from, to, *size, *modified),
            Op::Recycle {
                path,
                size,
                modified,
            } => {
                if !allowed(path) {
                    Err(Ok("geschützter Ort"))
                } else if file_state(path) != Some((*size, *modified)) {
                    Err(Ok("seit der Vorschau verändert"))
                } else {
                    platform
                        .recycle(path)
                        .map(|item| Undo::Restore {
                            item,
                            original: path.clone(),
                        })
                        .map_err(Err)
                }
            }
            Op::RemoveEmptyDir { path } => {
                let empty = std::fs::read_dir(path).is_ok_and(|mut d| d.next().is_none());
                let plain_dir = std::fs::symlink_metadata(path)
                    .is_ok_and(|m| m.is_dir() && !crate::walk::skip(&m));
                if !allowed(path) || !plain_dir {
                    Err(Ok("geschützter Ort oder kein Ordner"))
                } else if !empty {
                    Err(Ok("nicht mehr leer"))
                } else {
                    // Entfernt nur einen leeren Ordner (remove_dir scheitert bei Inhalt).
                    // aegis-mutation: tools-remove-empty-dir
                    #[allow(clippy::disallowed_methods)]
                    let removed = std::fs::remove_dir(path);
                    removed
                        .map(|()| Undo::CreateDir { path: path.clone() })
                        .map_err(Err)
                }
            }
            Op::SetWallpaper { path } => platform.wallpaper().map_err(Err).and_then(|previous| {
                platform
                    .set_wallpaper(path)
                    .map(|()| Undo::Wallpaper { previous })
                    .map_err(Err)
            }),
            Op::Autostart { entry, enable } => platform
                .autostart_enabled(entry)
                .map_err(Err)
                .and_then(|enabled| {
                    if enabled == *enable {
                        Err(Ok("schon so"))
                    } else {
                        platform
                            .set_autostart(entry, *enable)
                            .map(|()| Undo::Autostart {
                                entry: entry.clone(),
                                enabled,
                            })
                            .map_err(Err)
                    }
                }),
            Op::Registry { key, name, value } => {
                if !crate::tweaks::known(key, name) {
                    Err(Ok("unbekannter Schalter"))
                } else {
                    platform
                        .registry_get(key, name)
                        .map_err(Err)
                        .and_then(|previous| {
                            if &previous == value {
                                Err(Ok("schon so"))
                            } else {
                                platform
                                    .registry_set(key, name, value)
                                    .map(|()| Undo::Registry {
                                        key: key.clone(),
                                        name: name.clone(),
                                        previous,
                                    })
                                    .map_err(Err)
                            }
                        })
                }
            }
            Op::Shred {
                path,
                size,
                modified,
            } => {
                if !final_ok {
                    Err(Ok("zweite Bestätigung fehlt"))
                } else if !allowed(path) {
                    Err(Ok("geschützter Ort"))
                } else if file_state(path) != Some((*size, *modified)) {
                    Err(Ok("seit der Vorschau verändert"))
                } else {
                    // Endgültig: kein Rückgängig (das hat der Nutzer zweimal bestätigt).
                    return match shred(path, *size) {
                        Ok(()) => Item {
                            label,
                            status: Status::Done,
                            reason: None,
                            undo: None,
                        },
                        Err(e) => failed(label, &e),
                    };
                }
            }
            Op::DesktopLayout { layout } => platform
                .apply_desktop_layout(layout)
                .map(|previous| Undo::DesktopLayout { previous })
                .map_err(Err),
        };
    match result {
        Ok(undo) => done(label, undo),
        Err(Ok(reason)) => skipped(label, reason),
        Err(Err(e)) => failed(label, &e),
    }
}

/// Führt eine freigegebene Vorschau aus.
#[must_use]
pub fn execute(approved: Approved<'_>, platform: &dyn Platform, now: i64) -> Run {
    let plan = approved.plan;
    let items = plan
        .ops
        .iter()
        .enumerate()
        .map(|(i, op)| {
            if approved.skip.contains(&i) {
                skipped(op.label(), "abgewählt")
            } else {
                step(op, platform, approved.final_ok)
            }
        })
        .collect();
    Run {
        id: uuid::Uuid::new_v4().hyphenated().to_string(),
        plan: plan.id.clone(),
        tool: plan.tool,
        rule: plan.rule.clone(),
        at: now,
        items,
        undone: None,
    }
}

fn reverse(undo: &Undo, platform: &dyn Platform) -> Result<(), String> {
    match undo {
        Undo::MoveBack {
            now,
            back,
            size,
            modified,
        } => {
            if !allowed(now) || !allowed(back) {
                return Err("geschützter Ort".into());
            }
            if file_state(now) != Some((*size, *modified)) {
                return Err("Datei wurde inzwischen verändert oder verschoben".into());
            }
            if std::fs::symlink_metadata(back).is_ok() {
                return Err("am alten Ort liegt inzwischen etwas anderes".into());
            }
            if let Some(parent) = back.parent() {
                ensure_dir(parent).map_err(|e| e.to_string())?;
            }
            rename(now, back).map_err(|e| e.to_string())
        }
        Undo::Restore { item, original } => {
            if !allowed(original) {
                return Err("geschützter Ort".into());
            }
            if let Some(parent) = original.parent() {
                ensure_dir(parent).map_err(|e| e.to_string())?;
            }
            platform.restore(item, original).map_err(|e| e.to_string())
        }
        Undo::CreateDir { path } => {
            if !allowed(path) {
                return Err("geschützter Ort".into());
            }
            ensure_dir(path).map_err(|e| e.to_string())
        }
        Undo::Wallpaper { previous } => platform.set_wallpaper(previous).map_err(|e| e.to_string()),
        Undo::Autostart { entry, enabled } => platform
            .set_autostart(entry, *enabled)
            .map_err(|e| e.to_string()),
        Undo::Registry {
            key,
            name,
            previous,
        } => {
            if !crate::tweaks::known(key, name) {
                return Err("unbekannter Schalter".into());
            }
            platform
                .registry_set(key, name, previous)
                .map_err(|e| e.to_string())
        }
        Undo::DesktopLayout { previous } => platform
            .apply_desktop_layout(previous)
            .map(|_| ())
            .map_err(|e| e.to_string()),
    }
}

/// Nimmt einen Lauf zurück (Schritte in umgekehrter Reihenfolge). Liefert Fehlermeldungen der
/// Schritte, die nicht zurückgingen (z. B. Datei inzwischen verändert).
pub fn undo(run: &mut Run, platform: &dyn Platform, now: i64) -> Vec<String> {
    let mut errors = Vec::new();
    for item in run.items.iter_mut().rev() {
        if item.status != Status::Done {
            continue;
        }
        let Some(u) = &item.undo else {
            continue;
        };
        match reverse(u, platform) {
            Ok(()) => item.status = Status::Undone,
            Err(e) => errors.push(format!("{}: {e}", item.label)),
        }
    }
    run.undone = Some(now);
    errors
}
