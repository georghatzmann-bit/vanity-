//! Verschlüsselte Quarantäne der AEGIS Suite.
//!
//! **Goldene Regel:** Jede Operation, die etwas verändert, verlangt eine
//! [`ExecutionPermit`] als Wert – die gibt es nur nach dem „Ja“ des Nutzers für genau diesen
//! Plan. Ziele und Parameter kommen ausschließlich aus `permit.plan()`.
//!
//! - **Isolieren** (`Quarantine`): Datei wird verschlüsselt (AES-256-GCM, [`crypto`]) in den
//!   Tresor kopiert, die Kopie geprüft, erst dann das Original entfernt. Schlägt das Entfernen
//!   fehl, wird die Kopie verworfen und das Original bleibt unverändert.
//! - **Wiederherstellen** (`Restore`): nur an den ursprünglichen Ort, nie überschreiben,
//!   Inhalt per SHA-256 geprüft.
//! - **Endgültig löschen** (`DeletePermanently`): nur mit zweiter Bestätigung.
//! - Es wird **nie automatisch** gelöscht – auch nicht nach Fristen.
//!
//! Ehrliche Grenze: Der Schlüssel liegt in diesem Schritt als Datei im Tresor-Ordner, dessen
//! Zugriff der Dienst (ab P2.3) auf SYSTEM/Administratoren beschränkt; unter Windows wird er
//! zusätzlich per DPAPI geschützt (siehe `docs/SECURITY.md`).
#![forbid(unsafe_code)]

pub mod crypto;

use std::fs::{File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use aegis_core::audit::{AuditEvent, ExecutionResult};
use aegis_core::consent::{ConsentError, ExecutionPermit};
use aegis_core::plan::{ActionKind, Target, param};
use aegis_core::time::OffsetDateTime;
use aegis_core::undo::{UndoRecord, UndoStep};
use aegis_core::uuid::Uuid;
use serde::{Deserialize, Serialize};

use crate::crypto::{CryptoError, Key};

const KEY_FILE: &str = "vault.key";
const CONTAINER_EXT: &str = "aqf";
const META_EXT: &str = "json";

/// Fehler der Quarantäne.
#[derive(Debug, thiserror::Error)]
pub enum QuarantineError {
    /// Ein-/Ausgabefehler.
    #[error("Ein-/Ausgabefehler: {0}")]
    Io(#[from] io::Error),
    /// Verschlüsselung/Prüfung.
    #[error(transparent)]
    Crypto(#[from] CryptoError),
    /// Erlaubnis passt nicht (falsche Art, fehlende zweite Bestätigung …).
    #[error(transparent)]
    Consent(#[from] ConsentError),
    /// Plan ist für diese Operation unvollständig.
    #[error("Plan ungültig für die Quarantäne: {0}")]
    InvalidPlan(String),
    /// Schlüsseldatei beschädigt.
    #[error("Schlüssel des Tresors ist beschädigt")]
    BadKey,
    /// Metadaten beschädigt.
    #[error("Eintrag {0} ist beschädigt")]
    BadEntry(String),
}

/// Ein Eintrag im Tresor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    /// Kennung (UUID).
    pub id: String,
    /// Ursprünglicher Ort.
    pub original_path: PathBuf,
    /// SHA-256 des Originals (Hex).
    pub sha256: String,
    /// Größe in Byte.
    pub size: u64,
    /// Zeitpunkt des Isolierens.
    #[serde(with = "aegis_core::time::serde::rfc3339")]
    pub quarantined_at: OffsetDateTime,
    /// Plan, mit dem isoliert wurde.
    pub plan_id: String,
    /// „Was genau?“ aus dem Plan (Grund).
    pub reason: String,
}

/// Ergebnis einer Operation – für Prüfprotokoll, Rückgängig und Anzeige.
#[derive(Debug)]
pub struct Outcome {
    /// Audit-Ereignis (`ActionExecuted`).
    pub event: AuditEvent,
    /// Wie sich die Operation umkehren lässt (nur bei Isolieren).
    pub undo: Option<UndoRecord>,
    /// Betroffene Einträge.
    pub entries: Vec<Entry>,
    /// Ziele, die nicht bearbeitet werden konnten, mit Grund (Original jeweils unverändert).
    pub failures: Vec<(PathBuf, String)>,
}

/// Der Tresor.
pub struct Vault {
    dir: PathBuf,
    key: Key,
}

impl std::fmt::Debug for Vault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Vault")
            .field("dir", &self.dir)
            .finish_non_exhaustive()
    }
}

impl Vault {
    /// Öffnet (oder legt an) den Tresor im angegebenen AEGIS-eigenen Ordner.
    ///
    /// # Errors
    /// Ordner/Schlüssel nicht anlegbar oder Schlüssel beschädigt.
    pub fn open(dir: &Path) -> Result<Self, QuarantineError> {
        create_vault_dir(dir)?;
        let key_path = dir.join(KEY_FILE);
        let key = match std::fs::read(&key_path) {
            Ok(bytes) => {
                let arr: [u8; 32] = bytes
                    .as_slice()
                    .try_into()
                    .map_err(|_| QuarantineError::BadKey)?;
                zeroize::Zeroizing::new(arr)
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                let key = crypto::new_key()?;
                write_new_file(&key_path, key.as_ref())?;
                key
            }
            Err(e) => return Err(e.into()),
        };
        Ok(Self {
            dir: dir.to_owned(),
            key,
        })
    }

    /// Ordner des Tresors.
    #[must_use]
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Alle Einträge, älteste zuerst. Beschädigte Einträge werden als Fehler gemeldet,
    /// nie stillschweigend entfernt.
    ///
    /// # Errors
    /// Ordner nicht lesbar oder ein Eintrag beschädigt.
    pub fn list(&self) -> Result<Vec<Entry>, QuarantineError> {
        let mut out = Vec::new();
        for item in std::fs::read_dir(&self.dir)? {
            let path = item?.path();
            if path.extension().and_then(|e| e.to_str()) == Some(META_EXT) {
                out.push(read_entry(&path)?);
            }
        }
        out.sort_by(|a, b| {
            a.quarantined_at
                .cmp(&b.quarantined_at)
                .then(a.id.cmp(&b.id))
        });
        Ok(out)
    }

    /// Ein Eintrag nach Kennung.
    ///
    /// # Errors
    /// Unbekannte oder ungültige Kennung.
    pub fn entry(&self, id: &str) -> Result<Entry, QuarantineError> {
        let id = canonical_id(id)?;
        read_entry(&self.meta_path(&id))
    }

    fn container_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.{CONTAINER_EXT}"))
    }

    fn meta_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.{META_EXT}"))
    }

    /// Isoliert alle Datei-Ziele des Plans (Art `Quarantine`).
    ///
    /// # Errors
    /// Falsche Planart. Fehler einzelner Ziele stehen in [`Outcome::failures`].
    pub fn quarantine(&self, permit: ExecutionPermit) -> Result<Outcome, QuarantineError> {
        let plan = permit.ensure_kind(ActionKind::Quarantine)?;
        let now = permit.redeemed_at();
        let plan_id = plan.id().to_string();
        let reason = plan.what().to_owned();
        let mut entries = Vec::new();
        let mut failures = Vec::new();
        let mut steps = Vec::new();
        for target in plan.targets() {
            let Target::File { path } = target else {
                continue;
            };
            match self.isolate_one(path, now, &plan_id, &reason) {
                Ok(entry) => {
                    steps.push(UndoStep::RestoreFile {
                        from: self.container_path(&entry.id),
                        to: path.clone(),
                    });
                    entries.push(entry);
                }
                Err(e) => failures.push((path.clone(), e.to_string())),
            }
        }
        let undo = (!steps.is_empty()).then(|| UndoRecord {
            plan_id: permit.plan_id(),
            created_at: now,
            steps,
        });
        Ok(finish(permit, entries, failures, undo))
    }

    fn isolate_one(
        &self,
        path: &Path,
        now: OffsetDateTime,
        plan_id: &str,
        reason: &str,
    ) -> Result<Entry, QuarantineError> {
        let meta = std::fs::symlink_metadata(path)?;
        if !meta.is_file() {
            return Err(QuarantineError::InvalidPlan(format!(
                "{} ist keine reguläre Datei (Links und Ordner werden nicht isoliert)",
                path.display()
            )));
        }
        let id = Uuid::new_v4().hyphenated().to_string();
        let container = self.container_path(&id);
        let part = self.dir.join(format!("{id}.{CONTAINER_EXT}.part"));

        // 1. Verschlüsselt in eine neue Teil-Datei schreiben.
        let (sha, size) = {
            let source = BufReader::new(File::open(path)?);
            let mut out = BufWriter::new(create_new_file(&part)?);
            let result = crypto::encrypt(&self.key, source, &mut out, crypto::DEFAULT_CHUNK);
            let flushed = out
                .into_inner()
                .map_err(io::IntoInnerError::into_error)
                .and_then(|f| f.sync_all());
            match (result, flushed) {
                (Ok(r), Ok(())) => r,
                (Err(e), _) => {
                    remove_own_file(&part)?;
                    return Err(e.into());
                }
                (_, Err(e)) => {
                    remove_own_file(&part)?;
                    return Err(e.into());
                }
            }
        };
        // 2. Kopie prüfen, dann übernehmen.
        let check = crypto::decrypt(&self.key, BufReader::new(File::open(&part)?), io::sink());
        if !matches!(check, Ok((h, n)) if h == sha && n == size) {
            remove_own_file(&part)?;
            return Err(QuarantineError::Crypto(CryptoError::Tampered));
        }
        commit_own_file(&part, &container)?;
        let entry = Entry {
            id: id.clone(),
            original_path: path.to_owned(),
            sha256: hex(&sha),
            size,
            quarantined_at: now,
            plan_id: plan_id.to_owned(),
            reason: reason.to_owned(),
        };
        let json = serde_json::to_vec_pretty(&entry)
            .map_err(|e| QuarantineError::BadEntry(e.to_string()))?;
        if let Err(e) = write_new_file(&self.meta_path(&id), &json) {
            remove_own_file(&container)?;
            return Err(e.into());
        }
        // 3. Erst jetzt das Original entfernen – geschützt durch die Erlaubnis des Nutzers.
        if let Err(e) = remove_user_file(path) {
            remove_own_file(&self.meta_path(&id))?;
            remove_own_file(&container)?;
            return Err(QuarantineError::Io(io::Error::new(
                e.kind(),
                format!("Original konnte nicht entfernt werden ({e}) – nichts verändert"),
            )));
        }
        Ok(entry)
    }

    /// Stellt Einträge an ihren ursprünglichen Ort zurück (Art `Restore`, Parameter
    /// `quarantine_id`, Datei-Ziel = ursprünglicher Ort).
    ///
    /// # Errors
    /// Falsche Planart, fehlender/ungültiger Parameter, Ziel passt nicht zum Eintrag.
    pub fn restore(&self, permit: ExecutionPermit) -> Result<Outcome, QuarantineError> {
        let plan = permit.ensure_kind(ActionKind::Restore)?;
        let (entry, target) =
            self.planned_entry(plan.parameter(param::QUARANTINE_ID), plan.targets())?;
        let result = self.restore_one(&entry, &target);
        let (entries, failures) = match result {
            Ok(()) => (vec![entry], vec![]),
            Err(e) => (vec![], vec![(target, e.to_string())]),
        };
        Ok(finish(permit, entries, failures, None))
    }

    fn planned_entry(
        &self,
        id: Option<&str>,
        targets: &[Target],
    ) -> Result<(Entry, PathBuf), QuarantineError> {
        let id =
            id.ok_or_else(|| QuarantineError::InvalidPlan("Parameter quarantine_id fehlt".into()))?;
        let entry = self.entry(id)?;
        let [Target::File { path }] = targets else {
            return Err(QuarantineError::InvalidPlan(
                "genau ein Datei-Ziel erwartet".into(),
            ));
        };
        if *path != entry.original_path {
            return Err(QuarantineError::InvalidPlan(
                "Ziel im Plan entspricht nicht dem ursprünglichen Ort des Eintrags".into(),
            ));
        }
        Ok((entry, path.clone()))
    }

    fn restore_one(&self, entry: &Entry, target: &Path) -> Result<(), QuarantineError> {
        if std::fs::symlink_metadata(target).is_ok() {
            return Err(QuarantineError::InvalidPlan(format!(
                "Am ursprünglichen Ort liegt bereits etwas ({}) – es wird nichts überschrieben",
                target.display()
            )));
        }
        let parent = target
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .ok_or_else(|| QuarantineError::InvalidPlan("ursprünglicher Ort ohne Ordner".into()))?;
        create_restore_parent(parent)?;
        let part = parent.join(format!(".{}.aegis-restore", entry.id));
        let (sha, size) = {
            let mut out = BufWriter::new(create_new_file(&part)?);
            let source = BufReader::new(File::open(self.container_path(&entry.id))?);
            let result = crypto::decrypt(&self.key, source, &mut out);
            let flushed = out
                .into_inner()
                .map_err(io::IntoInnerError::into_error)
                .and_then(|f| f.sync_all());
            match (result, flushed) {
                (Ok(r), Ok(())) => r,
                (Err(e), _) => {
                    remove_restore_part(&part)?;
                    return Err(e.into());
                }
                (_, Err(e)) => {
                    remove_restore_part(&part)?;
                    return Err(e.into());
                }
            }
        };
        if hex(&sha) != entry.sha256 || size != entry.size {
            remove_restore_part(&part)?;
            return Err(QuarantineError::Crypto(CryptoError::Tampered));
        }
        if std::fs::symlink_metadata(target).is_ok() {
            remove_restore_part(&part)?;
            return Err(QuarantineError::InvalidPlan(
                "Ziel ist inzwischen belegt – nichts überschrieben".into(),
            ));
        }
        commit_restore(&part, target)?;
        remove_own_file(&self.meta_path(&entry.id))?;
        remove_own_file(&self.container_path(&entry.id))?;
        Ok(())
    }

    /// Löscht einen Eintrag endgültig (Art `DeletePermanently`, **nur mit zweiter
    /// Bestätigung**, Parameter `quarantine_id`).
    ///
    /// # Errors
    /// Falsche Planart, fehlende zweite Bestätigung, Parameter/Ziel passen nicht.
    pub fn delete_permanently(&self, permit: ExecutionPermit) -> Result<Outcome, QuarantineError> {
        let plan = permit.ensure_kind(ActionKind::DeletePermanently)?;
        if permit.second_confirmation().is_none() {
            return Err(QuarantineError::InvalidPlan(
                "zweite Bestätigung fehlt".into(),
            ));
        }
        let (entry, target) =
            self.planned_entry(plan.parameter(param::QUARANTINE_ID), plan.targets())?;
        let result = remove_own_file(&self.container_path(&entry.id))
            .and_then(|()| remove_own_file(&self.meta_path(&entry.id)));
        let (entries, failures) = match result {
            Ok(()) => (vec![entry], vec![]),
            Err(e) => (vec![], vec![(target, e.to_string())]),
        };
        Ok(finish(permit, entries, failures, None))
    }
}

fn finish(
    permit: ExecutionPermit,
    entries: Vec<Entry>,
    failures: Vec<(PathBuf, String)>,
    undo: Option<UndoRecord>,
) -> Outcome {
    let result = match (entries.is_empty(), failures.is_empty()) {
        (_, true) => ExecutionResult::Succeeded,
        (false, false) => ExecutionResult::PartiallySucceeded {
            message: failures
                .iter()
                .map(|(p, e)| format!("{}: {e}", p.display()))
                .collect::<Vec<_>>()
                .join("; "),
        },
        (true, false) => ExecutionResult::Failed {
            message: failures
                .iter()
                .map(|(p, e)| format!("{}: {e}", p.display()))
                .collect::<Vec<_>>()
                .join("; "),
        },
    };
    Outcome {
        event: permit.complete(result),
        undo,
        entries,
        failures,
    }
}

fn canonical_id(id: &str) -> Result<String, QuarantineError> {
    // Nur echte UUIDs – verhindert Pfad-Tricks wie „../x“ im Dateinamen.
    Uuid::parse_str(id)
        .map(|u| u.hyphenated().to_string())
        .map_err(|_| QuarantineError::InvalidPlan(format!("ungültige Quarantäne-Kennung „{id}“")))
}

fn read_entry(path: &Path) -> Result<Entry, QuarantineError> {
    let mut text = String::new();
    File::open(path)?
        .take(64 * 1024)
        .read_to_string(&mut text)?;
    let entry: Entry = serde_json::from_str(&text)
        .map_err(|_| QuarantineError::BadEntry(path.display().to_string()))?;
    if canonical_id(&entry.id)? != entry.id
        || path.file_stem().and_then(|s| s.to_str()) != Some(entry.id.as_str())
    {
        return Err(QuarantineError::BadEntry(path.display().to_string()));
    }
    Ok(entry)
}

fn hex(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------------------
// Verändernde Aufrufe – jeder einzeln markiert und in crates/core/mutation-allowlist.txt.
// ---------------------------------------------------------------------------------------

fn create_vault_dir(dir: &Path) -> io::Result<()> {
    // AEGIS-eigener Tresor-Ordner.
    // aegis-mutation: quarantine-create-vault-dir
    #[allow(clippy::disallowed_methods)]
    std::fs::create_dir_all(dir)
}

fn create_new_file(path: &Path) -> io::Result<File> {
    // Nur neue Dateien (create_new): Tresor-Container, Metadaten, Wiederherstellungs-Teil.
    // aegis-mutation: quarantine-create-new-file
    #[allow(clippy::disallowed_methods)]
    OpenOptions::new().write(true).create_new(true).open(path)
}

fn write_new_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut f = create_new_file(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

fn commit_own_file(from: &Path, to: &Path) -> io::Result<()> {
    // Teil-Datei im Tresor nach erfolgreicher Prüfung übernehmen.
    // aegis-mutation: quarantine-commit-container
    #[allow(clippy::disallowed_methods)]
    std::fs::rename(from, to)
}

fn remove_own_file(path: &Path) -> io::Result<()> {
    // Nur Dateien im AEGIS-Tresor (Teil-Dateien, übernommene/gelöschte Einträge).
    // aegis-mutation: quarantine-remove-own-file
    #[allow(clippy::disallowed_methods)]
    match std::fs::remove_file(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

fn remove_user_file(path: &Path) -> io::Result<()> {
    // Entfernt das Original NACH geprüfter verschlüsselter Kopie – nur aus `quarantine`,
    // also nur mit ExecutionPermit (Nutzer hat „Ja, ausführen“ gewählt).
    // aegis-mutation: quarantine-remove-original
    #[allow(clippy::disallowed_methods)]
    std::fs::remove_file(path)
}

fn create_restore_parent(dir: &Path) -> io::Result<()> {
    // Ursprünglichen Ordner wiederherstellen, falls er inzwischen fehlt (nur mit Erlaubnis).
    // aegis-mutation: quarantine-restore-create-parent
    #[allow(clippy::disallowed_methods)]
    std::fs::create_dir_all(dir)
}

fn remove_restore_part(path: &Path) -> io::Result<()> {
    // Eigene, unfertige Wiederherstellungs-Datei verwerfen.
    // aegis-mutation: quarantine-remove-restore-part
    #[allow(clippy::disallowed_methods)]
    match std::fs::remove_file(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

fn commit_restore(from: &Path, to: &Path) -> io::Result<()> {
    // Geprüfte Datei an den ursprünglichen Ort legen (vorher geprüft: Ziel ist frei).
    // aegis-mutation: quarantine-restore-commit
    #[allow(clippy::disallowed_methods)]
    std::fs::rename(from, to)
}
