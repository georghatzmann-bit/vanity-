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
//! - Nutzerdateien werden nur mit den **Rechten des anfragenden Nutzers** angefasst
//!   ([`UserAccess`]), ohne Links zu folgen ([`userfs`]).
//! - **Endgültig löschen** (`DeletePermanently`): nur mit zweiter Bestätigung.
//! - Es wird **nie automatisch** gelöscht – auch nicht nach Fristen.
//!
//! Schlüssel: liegt im Tresor-Ordner (nur SYSTEM/Administratoren), unter Windows zusätzlich
//! per DPAPI an diesen Rechner gebunden – ein kopierter Ordner ist anderswo nicht lesbar.
//! Ehrliche Grenze: Administratoren dieses Rechners können ihn auspacken.
#![forbid(unsafe_code)]

pub mod bait;
pub mod crypto;
pub mod safe;
pub mod userfs;

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
pub use crate::userfs::{OwnProcess, UserAccess, UserScope};

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
    /// Konto, das isoliert hat (Windows: SID). Nur dieses Konto sieht den Eintrag und darf
    /// ihn wiederherstellen oder löschen. `None` bei Einträgen ohne Kontotrennung.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
}

impl Entry {
    /// Darf das Konto `identity` diesen Eintrag sehen und bearbeiten?
    #[must_use]
    pub fn visible_to(&self, identity: Option<&str>) -> bool {
        match (&self.owner, identity) {
            (Some(owner), Some(id)) => owner == id,
            // Ohne Kontotrennung (eigener Prozess) bzw. alte Einträge: nur ohne Kennung.
            (None, None) => true,
            (Some(_), None) | (None, Some(_)) => false,
        }
    }
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
    warning: Option<String>,
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
        let mut warning = None;
        let key = match std::fs::read(&key_path) {
            Ok(bytes) => {
                let bytes = zeroize::Zeroizing::new(bytes);
                let (key, legacy) = decode_key(&bytes)?;
                if legacy && cfg!(windows) {
                    // Alter, ungeschützter Schlüssel: geschützt neu schreiben (Rechner-Bindung).
                    // Gelingt das nicht, bleibt der alte Schlüssel in Gebrauch – die Quarantäne
                    // muss erreichbar bleiben; der Dienst meldet den Hinweis.
                    if let Err(e) = upgrade_key_file(dir, &key_path, &key) {
                        warning = Some(format!(
                            "Quarantäne-Schlüssel nicht an den Rechner gebunden ({e}) – alter Schlüssel bleibt in Gebrauch"
                        ));
                    }
                }
                key
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                let key = crypto::new_key()?;
                write_new_file(&key_path, &encode_key(&key)?)?;
                key
            }
            Err(e) => return Err(e.into()),
        };
        Ok(Self {
            dir: dir.to_owned(),
            key,
            warning,
        })
    }

    /// Hinweis vom Öffnen (z. B. Schlüssel nicht umgestellt).
    #[must_use]
    pub fn warning(&self) -> Option<&str> {
        self.warning.as_deref()
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

    /// Isoliert alle Datei-Ziele des Plans (Art `Quarantine`). Die Originale werden mit den
    /// Rechten von `user` geöffnet und entfernt.
    ///
    /// # Errors
    /// Falsche Planart. Fehler einzelner Ziele stehen in [`Outcome::failures`].
    pub fn quarantine(
        &self,
        permit: ExecutionPermit,
        user: &dyn UserAccess,
    ) -> Result<Outcome, QuarantineError> {
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
            match self.isolate_one(path, now, &plan_id, &reason, user) {
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
        user: &dyn UserAccess,
    ) -> Result<Entry, QuarantineError> {
        // Mit den Rechten des Nutzers öffnen: exklusiv, ohne Links.
        let original = {
            let _scope = user.enter()?;
            userfs::open_original(path)?
        };
        let id = Uuid::new_v4().hyphenated().to_string();
        let container = self.container_path(&id);
        let part = self.dir.join(format!("{id}.{CONTAINER_EXT}.part"));

        // 1. Verschlüsselt in eine neue Teil-Datei schreiben (aus dem geöffneten Handle).
        let (sha, size) = {
            let source = BufReader::new(&original.file);
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
            owner: user.identity(),
        };
        let json = serde_json::to_vec_pretty(&entry)
            .map_err(|e| QuarantineError::BadEntry(e.to_string()))?;
        if let Err(e) = write_new_file(&self.meta_path(&id), &json) {
            remove_own_file(&container)?;
            return Err(e.into());
        }
        // 3. Erst jetzt das Original entfernen – geschützt durch die Erlaubnis des Nutzers,
        //    mit seinen Rechten und über das exklusiv geöffnete Handle.
        let removed = user
            .enter()
            .and_then(|_scope| userfs::remove_original(original));
        if let Err(e) = removed {
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
    /// Das Ziel wird mit den Rechten von `user` neu angelegt.
    ///
    /// # Errors
    /// Falsche Planart, fehlender/ungültiger Parameter, Ziel passt nicht zum Eintrag.
    pub fn restore(
        &self,
        permit: ExecutionPermit,
        user: &dyn UserAccess,
    ) -> Result<Outcome, QuarantineError> {
        let plan = permit.ensure_kind(ActionKind::Restore)?;
        let ids: Vec<&str> = plan
            .parameter(param::QUARANTINE_ID)
            .map(|ids| ids.split(',').collect())
            .unwrap_or_default();
        if ids.len() != plan.targets().len() || ids.is_empty() {
            return Err(QuarantineError::InvalidPlan(
                "je Datei-Ziel genau eine Eintrags-Kennung erwartet".into(),
            ));
        }
        // Alle Einträge vorab prüfen: Passt einer nicht zum Plan, wird nichts angefasst.
        let mut planned = Vec::with_capacity(ids.len());
        for (id, target) in ids.iter().zip(plan.targets()) {
            planned.push(self.planned_entry(Some(id), std::slice::from_ref(target))?);
        }
        let mut entries = Vec::new();
        let mut failures = Vec::new();
        for (entry, target) in planned {
            let result = if entry.visible_to(user.identity().as_deref()) {
                self.restore_one(&entry, &target, user)
            } else {
                Err(QuarantineError::InvalidPlan(
                    "Eintrag gehört einem anderen Konto".into(),
                ))
            };
            match result {
                Ok(()) => entries.push(entry),
                Err(e) => failures.push((target, e.to_string())),
            }
        }
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

    fn restore_one(
        &self,
        entry: &Entry,
        target: &Path,
        user: &dyn UserAccess,
    ) -> Result<(), QuarantineError> {
        // Mit den Rechten des Nutzers nachsehen (nichts über fremde Ordner verraten).
        let occupied = user.enter().map(|_scope| userfs::occupied(target))?;
        if occupied {
            return Err(QuarantineError::InvalidPlan(format!(
                "Am ursprünglichen Ort liegt bereits etwas ({}) – es wird nichts überschrieben",
                target.display()
            )));
        }
        // 1. Im Tresor entschlüsseln und prüfen – noch nichts beim Nutzer angefasst.
        let part = self.dir.join(format!("{}.restore.part", entry.id));
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
                    remove_own_file(&part)?;
                    return Err(e.into());
                }
                (_, Err(e)) => {
                    remove_own_file(&part)?;
                    return Err(e.into());
                }
            }
        };
        if hex(&sha) != entry.sha256 || size != entry.size {
            remove_own_file(&part)?;
            return Err(QuarantineError::Crypto(CryptoError::Tampered));
        }
        // 2. Ziel mit den Rechten des Nutzers neu anlegen (nie überschreiben, keine Links,
        //    keine fehlenden Ordner anlegen).
        let restored = {
            let scope = user.enter();
            match scope.and_then(|_scope| userfs::create_restored(target)) {
                Ok(r) => r,
                Err(e) => {
                    remove_own_file(&part)?;
                    let message = match e.kind() {
                        io::ErrorKind::AlreadyExists => {
                            "Ziel ist inzwischen belegt – nichts überschrieben".to_owned()
                        }
                        io::ErrorKind::NotFound => format!(
                            "Der ursprüngliche Ordner existiert nicht mehr ({}) – bitte zuerst anlegen",
                            target
                                .parent()
                                .map_or_else(String::new, |p| p.display().to_string())
                        ),
                        _ => format!("Ziel kann nicht angelegt werden: {e}"),
                    };
                    return Err(QuarantineError::InvalidPlan(message));
                }
            }
        };
        // 3. Geprüften Inhalt in das neue Ziel kopieren.
        let copied = File::open(&part).and_then(|mut source| {
            let mut out = &restored.file;
            io::copy(&mut source, &mut out)?;
            restored.file.sync_all()
        });
        remove_own_file(&part)?;
        if let Err(e) = copied {
            user.enter()
                .and_then(|_scope| userfs::discard_restored(restored))?;
            return Err(e.into());
        }
        drop(restored);
        remove_own_file(&self.meta_path(&entry.id))?;
        remove_own_file(&self.container_path(&entry.id))?;
        Ok(())
    }

    /// Löscht einen Eintrag endgültig (Art `DeletePermanently`, **nur mit zweiter
    /// Bestätigung**, Parameter `quarantine_id`).
    ///
    /// # Errors
    /// Falsche Planart, fehlende zweite Bestätigung, Parameter/Ziel passen nicht, Eintrag
    /// gehört einem anderen Konto.
    pub fn delete_permanently(
        &self,
        permit: ExecutionPermit,
        user: &dyn UserAccess,
    ) -> Result<Outcome, QuarantineError> {
        let plan = permit.ensure_kind(ActionKind::DeletePermanently)?;
        if permit.second_confirmation().is_none() {
            return Err(QuarantineError::InvalidPlan(
                "zweite Bestätigung fehlt".into(),
            ));
        }
        let (entry, target) =
            self.planned_entry(plan.parameter(param::QUARANTINE_ID), plan.targets())?;
        if !entry.visible_to(user.identity().as_deref()) {
            return Err(QuarantineError::InvalidPlan(
                "Eintrag gehört einem anderen Konto".into(),
            ));
        }
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

/// Kennung eines per DPAPI (Rechner) geschützten Schlüssels.
const KEY_MAGIC: &[u8] = b"AEGISK2\n";

/// Schlüsseldatei schreiben: unter Windows an den Rechner gebunden (DPAPI), sonst roh (der
/// Ordner ist nur für den Dienst lesbar).
fn encode_key(key: &crypto::Key) -> Result<zeroize::Zeroizing<Vec<u8>>, QuarantineError> {
    #[cfg(windows)]
    {
        let mut out = KEY_MAGIC.to_vec();
        out.extend(
            aegis_winffi::dpapi::protect_machine(key.as_ref()).map_err(QuarantineError::Io)?,
        );
        Ok(zeroize::Zeroizing::new(out))
    }
    #[cfg(not(windows))]
    {
        Ok(zeroize::Zeroizing::new(key.to_vec()))
    }
}

/// Schlüsseldatei lesen; `true` = alte, ungeschützte Form.
fn decode_key(bytes: &[u8]) -> Result<(crypto::Key, bool), QuarantineError> {
    let to_key = |raw: &[u8]| -> Result<crypto::Key, QuarantineError> {
        let arr: [u8; 32] = raw.try_into().map_err(|_| QuarantineError::BadKey)?;
        Ok(zeroize::Zeroizing::new(arr))
    };
    if let Some(blob) = bytes.strip_prefix(KEY_MAGIC) {
        #[cfg(windows)]
        {
            let raw = zeroize::Zeroizing::new(
                aegis_winffi::dpapi::unprotect(blob).map_err(|_| QuarantineError::BadKey)?,
            );
            return Ok((to_key(&raw)?, false));
        }
        #[cfg(not(windows))]
        {
            let _ = blob;
            return Err(QuarantineError::BadKey);
        }
    }
    Ok((to_key(bytes)?, true))
}

/// Ersetzt einen alten, ungeschützten Schlüssel durch die geschützte Form (erst prüfen, dann
/// atomar ersetzen – der Schlüssel geht nie verloren).
#[cfg_attr(not(windows), allow(dead_code))]
fn upgrade_key_file(dir: &Path, key_path: &Path, key: &crypto::Key) -> Result<(), QuarantineError> {
    let fresh = dir.join(format!("{KEY_FILE}.neu"));
    remove_own_file(&fresh)?;
    let encoded = encode_key(key)?;
    let (check, legacy) = decode_key(&encoded)?;
    if legacy || check.as_ref() != key.as_ref() {
        return Err(QuarantineError::BadKey);
    }
    write_new_file(&fresh, &encoded)?;
    commit_own_file(&fresh, key_path)?;
    Ok(())
}

fn create_vault_dir(dir: &Path) -> io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    // AEGIS-eigener Tresor-Ordner (unter Unix nur für den Eigentümer).
    // aegis-mutation: quarantine-create-vault-dir
    #[allow(clippy::disallowed_methods)]
    builder.create(dir)
}

fn create_new_file(path: &Path) -> io::Result<File> {
    // Nur neue Dateien (create_new) im Tresor: Container, Metadaten, Schlüssel, Teil-Dateien.
    // aegis-mutation: quarantine-create-new-file
    #[allow(clippy::disallowed_methods)]
    let options = {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        options
    };
    options.open(path)
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
