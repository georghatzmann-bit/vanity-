//! Rückfall-Kopien (P5, nur nach Opt-in): Versionen der Dateien aus den geschützten Ordnern,
//! verschlüsselt im AEGIS-eigenen Ordner des Dienstes (nur SYSTEM/Administratoren). Dort kommt
//! Ransomware, die mit den Rechten des Nutzers läuft, nicht heran.
//!
//! - **Sichern:** Der Dienst öffnet die Datei mit den Rechten des Nutzers (geteilt, ohne Links –
//!   Programme des Nutzers werden nicht blockiert) und schreibt die verschlüsselte Kopie in
//!   seinen eigenen Ordner. Nur neue Dateien, nie überschreiben; eine Version je Änderung.
//! - **Zurückholen:** nur mit Erlaubnis des Plans „Rückfall-Kopie zurückholen“; neu angelegt mit
//!   den Rechten des Nutzers, nie überschrieben, SHA-256 geprüft.
//! - **Löschen:** nie automatisch – nur „Ausdünnen“ mit zweiter Bestätigung; die neueste Version
//!   jeder Datei bleibt immer.

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use aegis_core::consent::ExecutionPermit;
use aegis_core::plan::{ActionKind, Target, param};
use aegis_core::time::OffsetDateTime;
use aegis_core::uuid::Uuid;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::userfs::{self, UserAccess};
use crate::{QuarantineError, Vault, commit_own_file, create_new_file, crypto, remove_own_file};

/// Kennung der Einstellung „Rückfall-Kopien“.
pub const BACKUP_SETTING: &str = "ransomware.backup";
/// Größte Datei, die gesichert wird.
pub const MAX_FILE: u64 = 200 * 1024 * 1024;
/// Höchstzahl Versionen je Konto im Verzeichnis.
pub const MAX_VERSIONS: usize = 200_000;
const INDEX_FILE: &str = "index.json";
const CONTAINER_EXT: &str = "abk";
/// Größte Index-Datei.
const MAX_INDEX: u64 = 64 * 1024 * 1024;

/// Eine gesicherte Version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackupVersion {
    /// Kennung (UUID).
    pub id: String,
    /// Ursprünglicher Pfad.
    pub original: PathBuf,
    /// Änderungszeit der Datei (Unix-Sekunden) beim Sichern.
    pub modified: i64,
    /// Größe.
    pub size: u64,
    /// SHA-256 des Inhalts.
    pub sha256: String,
    /// Gesichert am (RFC 3339).
    pub stored_at: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Index {
    versions: Vec<BackupVersion>,
}

/// Belegung eines Kontos.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Usage {
    /// Verschiedene Dateien.
    pub files: usize,
    /// Versionen insgesamt.
    pub versions: usize,
    /// Größe aller Versionen (Klartext).
    pub bytes: u64,
}

/// Speicher der Rückfall-Kopien.
#[derive(Debug)]
pub struct BackupStore {
    vault: Vault,
    lock: Mutex<()>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn now_text() -> String {
    OffsetDateTime::now_utc()
        .format(&aegis_core::time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

impl BackupStore {
    /// Öffnet (oder legt an) den Speicher im AEGIS-eigenen Ordner `dir` (eigener Schlüssel,
    /// wie der Quarantäne-Tresor an den Rechner gebunden).
    ///
    /// # Errors
    /// Ordner/Schlüssel nicht anlegbar.
    pub fn open(dir: &Path) -> Result<Self, QuarantineError> {
        Ok(Self {
            vault: Vault::open(dir)?,
            lock: Mutex::new(()),
        })
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Ordner eines Kontos (Kennung aus dem Konto abgeleitet, ohne Pfadteile).
    fn owner_dir(&self, owner: Option<&str>) -> PathBuf {
        let tag = hex(&Sha256::digest(owner.unwrap_or("lokal").as_bytes()))[..24].to_owned();
        self.vault.dir.join(tag)
    }

    fn read_index(&self, owner: Option<&str>) -> Result<Index, QuarantineError> {
        let path = self.owner_dir(owner).join(INDEX_FILE);
        let file = match File::open(&path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Index::default()),
            Err(e) => return Err(e.into()),
        };
        let mut text = Vec::new();
        file.take(MAX_INDEX + 1).read_to_end(&mut text)?;
        if text.len() as u64 > MAX_INDEX {
            return Err(QuarantineError::InvalidPlan("Index zu groß".into()));
        }
        serde_json::from_slice(&text)
            .map_err(|e| QuarantineError::InvalidPlan(format!("Index beschädigt: {e}")))
    }

    fn write_index(&self, owner: Option<&str>, index: &Index) -> Result<(), QuarantineError> {
        let dir = self.owner_dir(owner);
        crate::create_vault_dir(&dir)?;
        let part = dir.join(format!("{INDEX_FILE}.{}.part", Uuid::new_v4().simple()));
        let bytes =
            serde_json::to_vec(index).map_err(|e| QuarantineError::InvalidPlan(e.to_string()))?;
        {
            let mut f = create_new_file(&part)?;
            std::io::Write::write_all(&mut f, &bytes)?;
            f.sync_all()?;
        }
        commit_own_file(&part, &dir.join(INDEX_FILE)).map_err(|e| {
            let _ = remove_own_file(&part);
            QuarantineError::from(e)
        })
    }

    /// Belegung eines Kontos.
    ///
    /// # Errors
    /// Index nicht lesbar.
    pub fn usage(&self, owner: Option<&str>) -> Result<Usage, QuarantineError> {
        let _g = self.guard();
        let index = self.read_index(owner)?;
        let mut files: Vec<&Path> = index
            .versions
            .iter()
            .map(|v| v.original.as_path())
            .collect();
        files.sort();
        files.dedup();
        Ok(Usage {
            files: files.len(),
            versions: index.versions.len(),
            bytes: index.versions.iter().map(|v| v.size).sum(),
        })
    }

    /// Versionen eines Kontos, neueste zuerst (höchstens `limit`).
    ///
    /// # Errors
    /// Index nicht lesbar.
    pub fn versions(
        &self,
        owner: Option<&str>,
        limit: usize,
    ) -> Result<Vec<BackupVersion>, QuarantineError> {
        let _g = self.guard();
        let mut v = self.read_index(owner)?.versions;
        v.sort_by(|a, b| b.stored_at.cmp(&a.stored_at));
        v.truncate(limit);
        Ok(v)
    }

    /// Eine Version des Kontos.
    ///
    /// # Errors
    /// Unbekannt oder Index nicht lesbar.
    pub fn version(&self, owner: Option<&str>, id: &str) -> Result<BackupVersion, QuarantineError> {
        let id = crate::canonical_id(id)?;
        let _g = self.guard();
        self.read_index(owner)?
            .versions
            .into_iter()
            .find(|v| v.id == id)
            .ok_or_else(|| QuarantineError::InvalidPlan("Version nicht gefunden".into()))
    }

    /// Braucht `path` (Stand `modified`/`size`) eine neue Version?
    ///
    /// # Errors
    /// Index nicht lesbar.
    pub fn needs(
        &self,
        owner: Option<&str>,
        path: &Path,
        modified: i64,
        size: u64,
    ) -> Result<bool, QuarantineError> {
        let _g = self.guard();
        let index = self.read_index(owner)?;
        let latest = index
            .versions
            .iter()
            .filter(|v| v.original == path)
            .max_by(|a, b| a.stored_at.cmp(&b.stored_at));
        Ok(latest.is_none_or(|v| v.modified != modified || v.size != size))
    }

    /// Sichert den Inhalt von `file` (vom Aufrufer mit den Rechten des Nutzers geöffnet) als
    /// neue Version. Gehört zur vom Nutzer eingeschalteten Regel „Rückfall-Kopien“ (Plan mit
    /// „Ja“); schreibt nur neue Dateien im AEGIS-eigenen Ordner.
    ///
    /// # Errors
    /// Schreiben/Verschlüsseln nicht möglich oder zu viele Versionen.
    pub fn store(
        &self,
        owner: Option<&str>,
        original: &Path,
        file: File,
        modified: i64,
    ) -> Result<BackupVersion, QuarantineError> {
        let dir = self.owner_dir(owner);
        crate::create_vault_dir(&dir)?;
        let id = Uuid::new_v4().hyphenated().to_string();
        let container = dir.join(format!("{id}.{CONTAINER_EXT}"));
        let (sha, size) = {
            let mut out = std::io::BufWriter::new(create_new_file(&container)?);
            let result = crypto::encrypt(
                &self.vault.key,
                BufReader::new(file),
                &mut out,
                crypto::DEFAULT_CHUNK,
            )
            .map_err(QuarantineError::from)
            .and_then(|r| {
                std::io::Write::flush(&mut out)?;
                out.get_ref().sync_all()?;
                Ok(r)
            });
            match result {
                Ok(r) => r,
                Err(e) => {
                    drop(out);
                    let _ = remove_own_file(&container);
                    return Err(e);
                }
            }
        };
        let version = BackupVersion {
            id,
            original: original.to_path_buf(),
            modified,
            size,
            sha256: hex(&sha),
            stored_at: now_text(),
        };
        let _g = self.guard();
        let mut index = self.read_index(owner)?;
        if index.versions.len() >= MAX_VERSIONS {
            let _ = remove_own_file(&container);
            return Err(QuarantineError::InvalidPlan(
                "Zu viele Versionen – bitte alte ausdünnen".into(),
            ));
        }
        index.versions.push(version.clone());
        if let Err(e) = self.write_index(owner, &index) {
            let _ = remove_own_file(&container);
            return Err(e);
        }
        Ok(version)
    }

    /// Holt die Version aus dem Plan „Rückfall-Kopie zurückholen“ an den Ort aus dem Plan
    /// (neu angelegt mit den Rechten des Nutzers, nie überschrieben, SHA-256 geprüft).
    ///
    /// # Errors
    /// Plan passt nicht, Version unbekannt, Ziel belegt oder Inhalt beschädigt.
    pub fn restore(
        &self,
        permit: &ExecutionPermit,
        user: &dyn UserAccess,
    ) -> Result<BackupVersion, String> {
        let plan = permit
            .ensure_kind(ActionKind::RestoreBackup)
            .map_err(|e| e.to_string())?;
        let (Some(Target::File { path: target }), Some(id)) =
            (plan.targets().first(), plan.parameter(param::BACKUP_ENTRY))
        else {
            return Err("Plan unvollständig".into());
        };
        let owner = user.identity();
        let version = self
            .version(owner.as_deref(), id)
            .map_err(|e| e.to_string())?;
        let container = self
            .owner_dir(owner.as_deref())
            .join(format!("{}.{CONTAINER_EXT}", version.id));
        // Erst als Dienst den eigenen Container öffnen, dann im Identitätswechsel das Ziel.
        let source = File::open(&container).map_err(|e| format!("Kopie nicht lesbar: {e}"))?;
        let _scope = user
            .enter()
            .map_err(|e| format!("Rechte des Nutzers: {e}"))?;
        let mut restored = userfs::create_restored(target).map_err(|e| e.to_string())?;
        let result = crypto::decrypt(&self.vault.key, BufReader::new(source), &mut restored.file)
            .map_err(|e| e.to_string())
            .and_then(|r| {
                restored
                    .file
                    .sync_all()
                    .map(|()| r)
                    .map_err(|e| e.to_string())
            });
        match result {
            Ok((sha, size)) if hex(&sha) == version.sha256 && size == version.size => Ok(version),
            Ok(_) | Err(_) => {
                let _ = userfs::discard_restored(restored);
                Err("Kopie ist beschädigt – nichts angelegt".into())
            }
        }
    }

    /// Exportiert die jeweils neueste Version jeder Datei als normale Datei in einen neuen
    /// Unterordner des Zielordners aus dem Plan „Rückfall-Kopien exportieren“ (z. B. ein
    /// externes Laufwerk) – mit den Rechten des Nutzers, nie überschreibend, SHA-256 geprüft.
    /// Liefert `(Unterordner, geschrieben, fehlgeschlagen)`.
    ///
    /// # Errors
    /// Plan passt nicht, Ziel kein Ordner oder Unterordner nicht anlegbar.
    pub fn export(
        &self,
        permit: &ExecutionPermit,
        user: &dyn UserAccess,
    ) -> Result<(PathBuf, usize, usize), String> {
        let plan = permit
            .ensure_kind(ActionKind::ExportBackup)
            .map_err(|e| e.to_string())?;
        let Some(Target::File { path: dest }) = plan.targets().first() else {
            return Err("Plan unvollständig".into());
        };
        let owner = user.identity();
        let mut newest: Vec<BackupVersion> = Vec::new();
        for v in self
            .versions(owner.as_deref(), MAX_VERSIONS)
            .map_err(|e| e.to_string())?
        {
            // `versions` liefert neueste zuerst.
            if !newest.iter().any(|n| n.original == v.original) {
                newest.push(v);
            }
        }
        let stamp: String = now_text()
            .chars()
            .take(16)
            .map(|c| if c == ':' || c == 'T' { '-' } else { c })
            .collect();
        let folder = dest.join(format!("AEGIS-Rueckfallkopien {stamp}"));
        {
            let _scope = user
                .enter()
                .map_err(|e| format!("Rechte des Nutzers: {e}"))?;
            if !std::fs::symlink_metadata(dest).is_ok_and(|m| m.is_dir()) {
                return Err("Ziel ist kein Ordner".into());
            }
            create_user_dir(&folder, false).map_err(|e| format!("Ordner nicht anlegbar: {e}"))?;
        }
        let dir = self.owner_dir(owner.as_deref());
        let (mut written, mut failed) = (0usize, 0usize);
        for v in newest {
            let relative: PathBuf = v
                .original
                .components()
                .filter_map(|c| match c {
                    std::path::Component::Prefix(p) => Some(
                        p.as_os_str()
                            .to_string_lossy()
                            .chars()
                            .filter(char::is_ascii_alphanumeric)
                            .collect::<String>()
                            .into(),
                    ),
                    std::path::Component::Normal(n) => Some(n.to_os_string()),
                    _ => None,
                })
                .collect();
            let target = folder.join(&relative);
            let Ok(source) = File::open(dir.join(format!("{}.{CONTAINER_EXT}", v.id))) else {
                failed += 1;
                continue;
            };
            let ok = (|| -> Result<(), String> {
                let _scope = user.enter().map_err(|e| e.to_string())?;
                if let Some(parent) = target.parent() {
                    create_user_dir(parent, true).map_err(|e| e.to_string())?;
                }
                let mut out = userfs::create_restored(&target).map_err(|e| e.to_string())?;
                let result =
                    crypto::decrypt(&self.vault.key, BufReader::new(source), &mut out.file)
                        .map_err(|e| e.to_string())
                        .and_then(|r| out.file.sync_all().map(|()| r).map_err(|e| e.to_string()));
                match result {
                    Ok((sha, size)) if hex(&sha) == v.sha256 && size == v.size => Ok(()),
                    _ => {
                        let _ = userfs::discard_restored(out);
                        Err("beschädigt".into())
                    }
                }
            })();
            if ok.is_ok() {
                written += 1;
            } else {
                failed += 1;
            }
        }
        Ok((folder, written, failed))
    }

    /// „Ausdünnen“ aus dem Plan (Endgültig löschen mit zweiter Bestätigung): Versionen des
    /// Kontos älter als der Zeitpunkt werden gelöscht – die neueste jeder Datei bleibt immer.
    ///
    /// # Errors
    /// Plan passt nicht oder Index nicht lesbar/schreibbar.
    pub fn prune(&self, permit: &ExecutionPermit, owner: Option<&str>) -> Result<usize, String> {
        let plan = permit
            .ensure_kind(ActionKind::DeletePermanently)
            .map_err(|e| e.to_string())?;
        let before = plan
            .parameter(param::BACKUP_BEFORE)
            .and_then(|b| {
                OffsetDateTime::parse(
                    b,
                    &aegis_core::time::format_description::well_known::Rfc3339,
                )
                .ok()
            })
            .ok_or("Plan passt nicht zum Ausdünnen")?;
        let _g = self.guard();
        let mut index = self.read_index(owner).map_err(|e| e.to_string())?;
        let newest: std::collections::HashMap<PathBuf, String> =
            index
                .versions
                .iter()
                .fold(std::collections::HashMap::new(), |mut m, v| {
                    let e = m.entry(v.original.clone()).or_insert_with(String::new);
                    if v.stored_at > *e {
                        e.clone_from(&v.stored_at);
                    }
                    m
                });
        let parse = |s: &str| {
            OffsetDateTime::parse(
                s,
                &aegis_core::time::format_description::well_known::Rfc3339,
            )
            .ok()
        };
        let (drop, keep): (Vec<BackupVersion>, Vec<BackupVersion>) =
            index.versions.drain(..).partition(|v| {
                parse(&v.stored_at).is_some_and(|t| t < before)
                    && newest.get(&v.original) != Some(&v.stored_at)
            });
        index.versions = keep;
        self.write_index(owner, &index).map_err(|e| e.to_string())?;
        let dir = self.owner_dir(owner);
        for v in &drop {
            let _ = remove_own_file(&dir.join(format!("{}.{CONTAINER_EXT}", v.id)));
        }
        Ok(drop.len())
    }
}

/// Legt einen Ordner für den Export an (im Identitätswechsel, nur unterhalb des vom Nutzer
/// gewählten Ziels; `all` = mit Zwischenordnern).
fn create_user_dir(path: &Path, all: bool) -> std::io::Result<()> {
    // Legt Ordner des Exports „Rückfall-Kopien exportieren“ an – nur aus export(ExecutionPermit),
    // mit den Rechten des Nutzers, in dem von ihm gewählten Ziel.
    // aegis-mutation: quarantine-backup-export-dir
    #[allow(clippy::disallowed_methods)]
    if all {
        std::fs::create_dir_all(path)
    } else {
        std::fs::create_dir(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn konten_haben_getrennte_ordner_ohne_pfadteile() {
        let dir = tempfile::tempdir().unwrap();
        let store = BackupStore::open(dir.path()).unwrap();
        let a = store.owner_dir(Some("S-1-A"));
        let b = store.owner_dir(Some("../S-1-B"));
        assert_ne!(a, b);
        assert_eq!(a.parent(), Some(dir.path()));
        assert_eq!(b.parent(), Some(dir.path()));
    }
}
