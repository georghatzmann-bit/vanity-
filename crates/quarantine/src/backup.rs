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
//! - **Grenzen:** je Konto Speichergrenze und Versionen, über alle Konten eine Gesamtgrenze,
//!   und auf dem Laufwerk bleibt immer ein Rest frei (≥ 10 GiB bzw. 10 %) – sonst könnte eine
//!   volle Platte das Prüfprotokoll und damit jede Aktion von AEGIS lahmlegen. Gelesen wird
//!   höchstens die vorher geprüfte Größe; wächst eine Datei beim Lesen, wird die Kopie verworfen.
//! - **Index:** eine Zeile je Version (anhängen statt neu schreiben); beschädigte Zeilen werden
//!   übersprungen, nicht der ganze Speicher. Ausdünnen schreibt ihn neu und räumt verwaiste
//!   Kopien mit auf.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use aegis_core::consent::ExecutionPermit;
use aegis_core::plan::{ActionKind, Target, param};
use aegis_core::time::OffsetDateTime;
use aegis_core::uuid::Uuid;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::userfs::{self, UserAccess};
use crate::{
    QuarantineError, Vault, append_own_file, commit_own_file, create_new_file, crypto,
    remove_own_file,
};

/// Kennung der Einstellung „Rückfall-Kopien“.
pub const BACKUP_SETTING: &str = "ransomware.backup";
/// Größte Datei, die gesichert wird.
pub const MAX_FILE: u64 = 200 * 1024 * 1024;
/// Höchstzahl Versionen je Konto.
pub const MAX_VERSIONS: usize = 100_000;
/// Höchstbelegung über alle Konten.
pub const TOTAL_MAX: u64 = 200 * 1024 * 1024 * 1024;
/// Mindestens so viel bleibt auf dem Laufwerk frei …
pub const FREE_FLOOR: u64 = 10 * 1024 * 1024 * 1024;
/// … bzw. dieser Anteil (Prozent) der Laufwerksgröße, je nachdem was größer ist.
pub const FREE_FLOOR_PERCENT: u64 = 10;
const INDEX_FILE: &str = "index.jsonl";
const CONTAINER_EXT: &str = "abk";
/// Größte Index-Datei (gelesen wird höchstens so viel).
const MAX_INDEX: u64 = 64 * 1024 * 1024;
/// Ab dieser Größe kommen keine Versionen mehr hinzu (Reserve bis `MAX_INDEX`).
const INDEX_LIMIT: u64 = MAX_INDEX / 10 * 9;
/// Längste Index-Zeile.
const MAX_LINE: usize = 8 * 1024;

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

/// Index eines Kontos: Versionen in der Reihenfolge des Sicherns (älteste zuerst).
#[derive(Debug, Default)]
struct Index {
    versions: Vec<BackupVersion>,
    /// Größe der Index-Datei.
    bytes: u64,
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

/// Warum eine Datei nicht gesichert wurde.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// Nur diese Datei überspringen (nicht lesbar, zu groß, beim Lesen geändert …).
    Skip(String),
    /// Lauf beenden (Grenze erreicht, Laufwerk fast voll, Speicher nicht schreibbar).
    Stop(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Skip(m) | Self::Stop(m) => f.write_str(m),
        }
    }
}

/// Speicher der Rückfall-Kopien.
#[derive(Debug)]
pub struct BackupStore {
    vault: Vault,
    lock: Mutex<()>,
    /// Belegung aller Konten (Containergrößen), beim ersten Bedarf gezählt.
    total: Mutex<Option<u64>>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn now_text() -> String {
    OffsetDateTime::now_utc()
        .format(&aegis_core::time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// Bleibt nach `needed` Byte genug frei? (mindestens [`FREE_FLOOR`] bzw.
/// [`FREE_FLOOR_PERCENT`] % der Laufwerksgröße)
#[must_use]
pub fn leaves_enough_space(free: u64, total: u64, needed: u64) -> bool {
    let floor = FREE_FLOOR.max(total / 100 * FREE_FLOOR_PERCENT);
    free.saturating_sub(needed) >= floor && free >= needed
}

fn parse_index(text: &[u8]) -> Vec<BackupVersion> {
    text.split(|b| *b == b'\n')
        .filter(|line| !line.is_empty() && line.len() <= MAX_LINE)
        // Beschädigte Zeilen (z. B. abgebrochenes Schreiben) überspringen, nicht alles.
        .filter_map(|line| serde_json::from_slice(line).ok())
        .collect()
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
            total: Mutex::new(None),
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
        let bytes = file.metadata()?.len();
        let mut text = Vec::new();
        // Zu groß (sollte nie vorkommen): nur der Anfang zählt – so bleibt Ausdünnen möglich.
        file.take(MAX_INDEX).read_to_end(&mut text)?;
        Ok(Index {
            versions: parse_index(&text),
            bytes,
        })
    }

    fn write_index(
        &self,
        owner: Option<&str>,
        versions: &[BackupVersion],
    ) -> Result<(), QuarantineError> {
        let dir = self.owner_dir(owner);
        crate::create_vault_dir(&dir)?;
        let part = dir.join(format!("{INDEX_FILE}.{}.part", Uuid::new_v4().simple()));
        let mut bytes = Vec::new();
        for v in versions {
            serde_json::to_writer(&mut bytes, v)
                .map_err(|e| QuarantineError::InvalidPlan(e.to_string()))?;
            bytes.push(b'\n');
        }
        {
            let mut f = create_new_file(&part)?;
            f.write_all(&bytes)?;
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
        let files: HashSet<&Path> = index
            .versions
            .iter()
            .map(|v| v.original.as_path())
            .collect();
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
        // Der Index ist in der Reihenfolge des Sicherns geschrieben.
        v.reverse();
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

    /// Belegung aller Konten (Größe der Kopien), einmal gezählt und danach mitgeführt.
    fn total_bytes(&self) -> u64 {
        let mut total = self
            .total
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *total.get_or_insert_with(|| {
            std::fs::read_dir(&self.vault.dir)
                .into_iter()
                .flatten()
                .flatten()
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .flat_map(|d| std::fs::read_dir(d.path()).into_iter().flatten().flatten())
                .filter(|e| e.path().extension().is_some_and(|x| x == CONTAINER_EXT))
                .filter_map(|e| e.metadata().ok())
                .map(|m| m.len())
                .sum()
        })
    }

    fn adjust_total(&self, add: u64, sub: u64) {
        let mut total = self
            .total
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(t) = total.as_mut() {
            *t = t.saturating_add(add).saturating_sub(sub);
        }
    }

    /// Ist auf dem Laufwerk des Speichers nach `needed` Byte noch genug frei?
    fn space_for(&self, needed: u64) -> Result<(), StoreError> {
        if self.total_bytes().saturating_add(needed) > TOTAL_MAX {
            return Err(StoreError::Stop(
                "Gesamtgrenze aller Konten erreicht – bitte alte Versionen ausdünnen".into(),
            ));
        }
        #[cfg(windows)]
        {
            let (free, total) = aegis_winffi::fs::disk_space(&self.vault.dir)
                .map_err(|e| StoreError::Stop(format!("Freier Platz nicht lesbar: {e}")))?;
            if !leaves_enough_space(free, total, needed) {
                return Err(StoreError::Stop(
                    "Das Laufwerk ist fast voll – Rückfall-Kopien pausieren, damit Windows und AEGIS weiterarbeiten können".into(),
                ));
            }
        }
        Ok(())
    }

    /// Beginnt einen Sicherungslauf: liest den Index des Kontos einmal.
    ///
    /// # Errors
    /// Index nicht lesbar.
    pub fn begin(&self, owner: Option<&str>) -> Result<BackupRun<'_>, QuarantineError> {
        let index = {
            let _g = self.guard();
            self.read_index(owner)?
        };
        let mut latest = HashMap::new();
        let mut bytes = 0u64;
        for v in &index.versions {
            bytes = bytes.saturating_add(v.size);
            // Spätere Zeilen sind neuer.
            latest.insert(v.original.clone(), (v.modified, v.size));
        }
        Ok(BackupRun {
            store: self,
            owner: owner.map(str::to_owned),
            latest,
            versions: index.versions.len(),
            bytes,
            index_bytes: index.bytes,
        })
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
    /// `cancel` bricht zwischen zwei Dateien ab (Dienst wird beendet).
    /// Liefert `(Unterordner, geschrieben, fehlgeschlagen)`.
    ///
    /// # Errors
    /// Plan passt nicht, Ziel kein Ordner oder Unterordner nicht anlegbar.
    pub fn export(
        &self,
        permit: &ExecutionPermit,
        user: &dyn UserAccess,
        cancel: &dyn Fn() -> bool,
    ) -> Result<(PathBuf, usize, usize), String> {
        let plan = permit
            .ensure_kind(ActionKind::ExportBackup)
            .map_err(|e| e.to_string())?;
        let Some(Target::File { path: dest }) = plan.targets().first() else {
            return Err("Plan unvollständig".into());
        };
        let owner = user.identity();
        let mut seen = HashSet::new();
        let newest: Vec<BackupVersion> = self
            .versions(owner.as_deref(), MAX_VERSIONS)
            .map_err(|e| e.to_string())?
            .into_iter()
            // `versions` liefert neueste zuerst.
            .filter(|v| seen.insert(v.original.clone()))
            .collect();
        let stamp: String = now_text()
            .chars()
            .take(19)
            .map(|c| if c == ':' || c == 'T' { '-' } else { c })
            .collect();
        let folder = {
            let _scope = user
                .enter()
                .map_err(|e| format!("Rechte des Nutzers: {e}"))?;
            if !std::fs::symlink_metadata(dest).is_ok_and(|m| m.is_dir()) {
                return Err("Ziel ist kein Ordner".into());
            }
            let mut created = None;
            for n in 1..=20 {
                let name = if n == 1 {
                    format!("AEGIS-Rueckfallkopien {stamp}")
                } else {
                    format!("AEGIS-Rueckfallkopien {stamp} {n}")
                };
                let folder = dest.join(name);
                match create_user_dir(&folder, false) {
                    Ok(()) => {
                        created = Some(folder);
                        break;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(e) => return Err(format!("Ordner nicht anlegbar: {e}")),
                }
            }
            created.ok_or("Ordner nicht anlegbar: Name belegt")?
        };
        let dir = self.owner_dir(owner.as_deref());
        let (mut written, mut failed) = (0usize, 0usize);
        for (i, v) in newest.iter().enumerate() {
            if cancel() {
                failed += newest.len() - i;
                break;
            }
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
    /// Verwaiste Kopien des Kontos (ohne Index-Zeile, z. B. nach einem Absturz) älter als der
    /// Zeitpunkt werden mit entfernt – sie sind ohnehin nicht mehr zurückholbar.
    ///
    /// # Errors
    /// Plan passt nicht oder Index nicht lesbar/schreibbar.
    pub fn prune(&self, permit: &ExecutionPermit, owner: Option<&str>) -> Result<usize, String> {
        let plan = permit
            .ensure_kind(ActionKind::DeletePermanently)
            .map_err(|e| e.to_string())?;
        let rfc = &aegis_core::time::format_description::well_known::Rfc3339;
        let before = plan
            .parameter(param::BACKUP_BEFORE)
            .and_then(|b| OffsetDateTime::parse(b, rfc).ok())
            .ok_or("Plan passt nicht zum Ausdünnen")?;
        let _g = self.guard();
        let index = self.read_index(owner).map_err(|e| e.to_string())?;
        // Neueste Version je Datei = letzte Zeile im Index.
        let newest: HashMap<&Path, usize> = index
            .versions
            .iter()
            .enumerate()
            .map(|(i, v)| (v.original.as_path(), i))
            .collect();
        let mut keep = Vec::new();
        let mut dropped = Vec::new();
        for (i, v) in index.versions.iter().enumerate() {
            let old = OffsetDateTime::parse(&v.stored_at, rfc).is_ok_and(|t| t < before);
            if old && newest.get(v.original.as_path()) != Some(&i) {
                dropped.push(v.id.clone());
            } else {
                keep.push(v.clone());
            }
        }
        self.write_index(owner, &keep).map_err(|e| e.to_string())?;
        let dir = self.owner_dir(owner);
        let kept: HashSet<&str> = keep.iter().map(|v| v.id.as_str()).collect();
        let cutoff = std::time::SystemTime::from(before);
        let orphans: Vec<PathBuf> = std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == CONTAINER_EXT))
            .filter(|p| {
                p.file_stem()
                    .and_then(|s| s.to_str())
                    .is_some_and(|id| !kept.contains(id) && !dropped.iter().any(|d| d == id))
            })
            .filter(|p| {
                std::fs::symlink_metadata(p)
                    .and_then(|m| m.modified())
                    .is_ok_and(|t| t < cutoff)
            })
            .collect();
        let mut freed = 0u64;
        let mut removed = 0usize;
        for path in dropped
            .iter()
            .map(|id| dir.join(format!("{id}.{CONTAINER_EXT}")))
            .chain(orphans)
        {
            let size = std::fs::symlink_metadata(&path).map_or(0, |m| m.len());
            if remove_own_file(&path).is_ok() {
                freed = freed.saturating_add(size);
                removed += 1;
            }
        }
        self.adjust_total(0, freed);
        Ok(removed)
    }
}

/// Ein Sicherungslauf eines Kontos (Index einmal gelesen, je Version eine Zeile angehängt).
#[derive(Debug)]
pub struct BackupRun<'a> {
    store: &'a BackupStore,
    owner: Option<String>,
    latest: HashMap<PathBuf, (i64, u64)>,
    versions: usize,
    bytes: u64,
    index_bytes: u64,
}

impl BackupRun<'_> {
    /// Braucht `path` (Stand `modified`/`size`) eine neue Version?
    #[must_use]
    pub fn needs(&self, path: &Path, modified: i64, size: u64) -> bool {
        self.latest.get(path) != Some(&(modified, size))
    }

    /// Belegung des Kontos (Klartext).
    #[must_use]
    pub fn used(&self) -> u64 {
        self.bytes
    }

    /// Sichert den Inhalt von `file` (vom Aufrufer mit den Rechten des Nutzers geöffnet) als
    /// neue Version – nur, wenn sie noch `expected` Byte groß ist (Stand beim Sammeln), höchstens
    /// so viel wird gelesen, und nur, wenn die
    /// Grenzen (`quota` des Kontos, Gesamtgrenze, freier Platz) es erlauben. Gehört zur vom
    /// Nutzer eingeschalteten Regel „Rückfall-Kopien“ (Plan mit „Ja“); schreibt nur neue
    /// Dateien im AEGIS-eigenen Ordner.
    ///
    /// # Errors
    /// [`StoreError::Skip`] für diese Datei, [`StoreError::Stop`] für den ganzen Lauf.
    pub fn store(
        &mut self,
        original: &Path,
        file: File,
        modified: i64,
        expected: u64,
        quota: u64,
    ) -> Result<BackupVersion, StoreError> {
        if self.versions >= MAX_VERSIONS || self.index_bytes >= INDEX_LIMIT {
            return Err(StoreError::Stop(
                "Zu viele Versionen – bitte alte ausdünnen".into(),
            ));
        }
        let meta = file
            .metadata()
            .map_err(|e| StoreError::Skip(format!("nicht lesbar: {e}")))?;
        if !meta.is_file() {
            return Err(StoreError::Skip("keine Datei".into()));
        }
        let len = meta.len();
        if len != expected {
            return Err(StoreError::Skip(
                "Datei änderte sich – nächster Lauf".into(),
            ));
        }
        if len > MAX_FILE {
            return Err(StoreError::Skip("zu groß".into()));
        }
        if self.bytes.saturating_add(len) > quota {
            return Err(StoreError::Stop(
                "Speichergrenze erreicht – neue Versionen werden nicht gesichert (bitte alte ausdünnen oder Grenze erhöhen)".into(),
            ));
        }
        self.store.space_for(len)?;
        let owner = self.owner.as_deref();
        let dir = self.store.owner_dir(owner);
        crate::create_vault_dir(&dir).map_err(|e| StoreError::Stop(e.to_string()))?;
        let id = Uuid::new_v4().hyphenated().to_string();
        let container = dir.join(format!("{id}.{CONTAINER_EXT}"));
        let discard = |e: StoreError| {
            let _ = remove_own_file(&container);
            e
        };
        let (sha, size) = {
            let mut out = std::io::BufWriter::new(
                create_new_file(&container).map_err(|e| StoreError::Stop(e.to_string()))?,
            );
            // Höchstens ein Byte mehr als geprüft lesen: wächst die Datei, wird verworfen.
            let result = crypto::encrypt(
                &self.store.vault.key,
                BufReader::new(file.take(len.saturating_add(1))),
                &mut out,
                crypto::DEFAULT_CHUNK,
            )
            .map_err(|e| StoreError::Skip(e.to_string()))
            .and_then(|r| {
                out.flush()
                    .and_then(|()| out.get_ref().sync_all())
                    .map_err(|e| StoreError::Stop(e.to_string()))?;
                Ok(r)
            });
            drop(out);
            result.map_err(discard)?
        };
        if size != len {
            return Err(discard(StoreError::Skip(
                "Datei änderte sich beim Lesen".into(),
            )));
        }
        let stored = std::fs::symlink_metadata(&container).map_or(len, |m| m.len());
        let version = BackupVersion {
            id,
            original: original.to_path_buf(),
            modified,
            size,
            sha256: hex(&sha),
            stored_at: now_text(),
        };
        let mut line =
            serde_json::to_vec(&version).map_err(|e| discard(StoreError::Stop(e.to_string())))?;
        line.push(b'\n');
        if line.len() > MAX_LINE {
            return Err(discard(StoreError::Skip("Pfad zu lang".into())));
        }
        {
            let _g = self.store.guard();
            let appended = append_own_file(&dir.join(INDEX_FILE))
                .and_then(|mut f| f.write_all(&line).and_then(|()| f.sync_all()));
            appended
                .map_err(|e| discard(StoreError::Stop(format!("Index nicht schreibbar: {e}"))))?;
        }
        self.store.adjust_total(stored, 0);
        self.versions += 1;
        self.bytes = self.bytes.saturating_add(size);
        self.index_bytes = self.index_bytes.saturating_add(line.len() as u64);
        self.latest
            .insert(version.original.clone(), (modified, size));
        Ok(version)
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

    #[test]
    fn freier_platz_bleibt() {
        const GIB: u64 = 1024 * 1024 * 1024;
        // Kleines Laufwerk: mindestens 10 GiB bleiben frei.
        assert!(leaves_enough_space(20 * GIB, 100 * GIB, 5 * GIB));
        assert!(!leaves_enough_space(14 * GIB, 100 * GIB, 5 * GIB));
        // Großes Laufwerk: 10 % bleiben frei.
        assert!(!leaves_enough_space(150 * GIB, 2000 * GIB, GIB));
        assert!(leaves_enough_space(250 * GIB, 2000 * GIB, GIB));
        assert!(!leaves_enough_space(GIB, 100 * GIB, 2 * GIB));
    }

    #[test]
    fn beschaedigte_index_zeilen_werden_uebersprungen() {
        let good = br#"{"id":"a","original":"/x","modified":1,"size":2,"sha256":"00","stored_at":"2026-01-01T00:00:00Z"}"#;
        let mut text = good.to_vec();
        text.extend_from_slice(b"\n{kaputt\n");
        text.extend_from_slice(good);
        text.extend_from_slice(b"\n{\"id\":\"halb");
        assert_eq!(parse_index(&text).len(), 2);
    }
}
