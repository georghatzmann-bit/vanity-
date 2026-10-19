//! Test-Hilfen für alle Crates der AEGIS Suite (Feature `testing`, nur als dev-dependency).
//!
//! Bezug zur Goldenen Regel: Die „Nichts ohne Ja“-Tests späterer Phasen belegen, dass
//! Scans, Wächter und Panic-Button ohne Bestätigung **byte-genau nichts** verändern:
//!
//! ```
//! use aegis_core::testing::{DirSnapshot, assert_unchanged, write_fixture};
//!
//! let dir = tempfile::tempdir()?;
//! write_fixture(dir.path(), "dummy.txt", b"harmlose Dummy-Datei")?;
//! let before = DirSnapshot::capture(dir.path())?;
//! // … hier Scan, Wächter o. Ä. ohne Freigabe laufen lassen …
//! let after = DirSnapshot::capture(dir.path())?;
//! assert_unchanged(&before, &after);
//! # Ok::<(), std::io::Error>(())
//! ```
//!
//! Testdateien werden ausschließlich über die hier freigegebenen Helfer
//! ([`write_fixture`], [`create_fixture_dir`], [`remove_fixture`], [`rename_fixture`],
//! [`set_fixture_readonly`], unter Unix `create_fixture_symlink`) angelegt oder verändert –
//! sie stehen in `crates/core/mutation-allowlist.txt`, weigern sich, außerhalb des
//! übergebenen Test-Ordners zu schreiben, und folgen keinen Links.
//!
//! Schadcode-Ersatz: nur [`eicar`] (zur Laufzeit zusammengesetzt) und selbst erzeugte,
//! harmlose Dummy-Dateien.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime};

use crate::canonical::hex_lower;
use crate::consent::Clock;
use crate::plan::{ActionKind, ActionPlan, ActionPlanBuilder, PlanError, Target, UndoHint, param};
use crate::risk::RiskLevel;

// ---------------------------------------------------------------------------------------
// Uhr
// ---------------------------------------------------------------------------------------

/// Von Hand gestellte Uhr. Klone teilen sich dieselbe Zeit – das Freigabe-Tor bekommt
/// einen Klon, der Test stellt die Zeit über den anderen vor.
#[derive(Debug, Clone)]
pub struct ManualClock {
    now: Arc<Mutex<OffsetDateTime>>,
}

impl ManualClock {
    /// Startzeitpunkt von [`ManualClock::default`]: 2026-01-01 00:00:00 UTC.
    pub const DEFAULT_START: OffsetDateTime = time::macros::datetime!(2026-01-01 00:00 UTC);

    /// Uhr mit festem Startzeitpunkt.
    #[must_use]
    pub fn new(start: OffsetDateTime) -> Self {
        Self {
            now: Arc::new(Mutex::new(start)),
        }
    }

    /// Stellt die Uhr um `by` vor (negativ: zurück). Sättigt an den Grenzen.
    pub fn advance(&self, by: Duration) {
        let mut now = self.lock();
        *now = now.saturating_add(by);
    }

    /// Stellt die Uhr auf einen festen Zeitpunkt.
    pub fn set(&self, to: OffsetDateTime) {
        *self.lock() = to;
    }

    fn lock(&self) -> MutexGuard<'_, OffsetDateTime> {
        self.now.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Default for ManualClock {
    fn default() -> Self {
        Self::new(Self::DEFAULT_START)
    }
}

impl crate::consent::sealed::Sealed for ManualClock {}

impl Clock for ManualClock {
    fn now(&self) -> OffsetDateTime {
        *self.lock()
    }
}

// ---------------------------------------------------------------------------------------
// Beispiel-Pläne
// ---------------------------------------------------------------------------------------

/// Plattformgerechter absoluter Beispielpfad (`C:\aegis-test\…` bzw. `/aegis-test/…`).
/// Greift nicht auf das Dateisystem zu. `name` nutzt `/` als Trenner.
#[must_use]
pub fn test_path(name: &str) -> PathBuf {
    let mut path = PathBuf::from(if cfg!(windows) {
        r"C:\aegis-test"
    } else {
        "/aegis-test"
    });
    for part in name.split('/').filter(|part| !part.is_empty()) {
        path.push(part);
    }
    path
}

/// Vollständig ausgefüllter, gültiger Builder für die angegebene Aktion (Ziele,
/// Pflichttexte, Rückgängig-Hinweis, nötige Parameter). Einzelne Felder lassen sich danach
/// überschreiben.
pub fn sample_plan_builder(kind: ActionKind) -> ActionPlanBuilder {
    let file = Target::file(test_path("Downloads/beispiel.exe"));
    let process = Target::process(4242, test_path("Programme/beispiel.exe"));
    let builder = match kind {
        ActionKind::Quarantine
        | ActionKind::Restore
        | ActionKind::DeletePermanently
        | ActionKind::AddTrust
        | ActionKind::RemoveTrust => ActionPlan::builder(kind).target(file),
        ActionKind::MoveFile => ActionPlan::builder(kind).target(file).parameter(
            param::DESTINATION,
            test_path("Sortiert").display().to_string(),
        ),
        ActionKind::RenameFile => ActionPlan::builder(kind)
            .target(file)
            .parameter(param::NEW_NAME, "umbenannt.exe"),
        ActionKind::SuspendProcess | ActionKind::ResumeProcess | ActionKind::TerminateProcess => {
            ActionPlan::builder(kind).target(process)
        }
        ActionKind::ChangeSetting => {
            ActionPlan::builder(kind).target(Target::setting("realtime.enabled"))
        }
    };
    let undo = if kind.must_be_irreversible() {
        UndoHint::irreversible("Kann nicht rückgängig gemacht werden.")
    } else {
        UndoHint::reversible("Über den Verlauf mit einem Klick rückgängig machen.")
    };
    builder
        .what(format!("Beispiel: {}", kind.label_de()))
        .why("Testfall – harmlose Beispieldaten.")
        .consequence("Im Test passiert nichts außerhalb des Speichers.")
        .undo(undo)
        .severity(RiskLevel::Suspicious)
}

/// Gültiger Beispielplan für die angegebene Aktion.
///
/// # Errors
/// Nur, wenn `created_at` ungültig ist (vor 1970 / nach 9999).
pub fn sample_plan(kind: ActionKind, created_at: OffsetDateTime) -> Result<ActionPlan, PlanError> {
    sample_plan_builder(kind).build(created_at)
}

// ---------------------------------------------------------------------------------------
// Zustands-Schnappschuss
// ---------------------------------------------------------------------------------------

/// Zustand eines Eintrags im Schnappschuss.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileState {
    /// Ordner?
    pub is_dir: bool,
    /// Symbolischer Link (wird nicht verfolgt)?
    pub is_symlink: bool,
    /// Größe in Byte (Ordner und Links: 0).
    pub len: u64,
    /// SHA-256 des Inhalts (Links: des Link-Ziels; Ordner: `None`).
    pub sha256: Option<[u8; 32]>,
    /// Schreibgeschützt?
    pub readonly: bool,
}

impl FileState {
    /// SHA-256 als Hex-Text (`-` für Ordner).
    #[must_use]
    pub fn sha256_hex(&self) -> String {
        self.sha256
            .as_ref()
            .map_or_else(|| "-".to_owned(), |hash| hex_lower(hash))
    }

    fn describe(&self) -> String {
        if self.is_dir {
            "Ordner".to_owned()
        } else if self.is_symlink {
            format!("Link, Ziel-Hash {}", self.sha256_hex())
        } else {
            format!(
                "{} Byte, sha256 {}{}",
                self.len,
                self.sha256_hex(),
                if self.readonly {
                    ", schreibgeschützt"
                } else {
                    ""
                }
            )
        }
    }
}

/// Byte-genauer Schnappschuss eines Ordnerbaums: relativer Pfad → [`FileState`],
/// sortiert. Symbolische Links werden nicht verfolgt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirSnapshot {
    entries: BTreeMap<PathBuf, FileState>,
}

impl DirSnapshot {
    /// Nimmt den Zustand aller Einträge unterhalb von `root` auf (nur lesend).
    ///
    /// # Errors
    /// E/A-Fehler oder `InvalidInput`, wenn `root` kein Ordner ist.
    pub fn capture(root: impl AsRef<Path>) -> io::Result<Self> {
        let root = root.as_ref();
        if !fs::metadata(root)?.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{} ist kein Ordner", root.display()),
            ));
        }
        let mut entries = BTreeMap::new();
        capture_dir(root, Path::new(""), &mut entries)?;
        Ok(Self { entries })
    }

    /// Alle Einträge (relativer Pfad → Zustand).
    #[must_use]
    pub const fn entries(&self) -> &BTreeMap<PathBuf, FileState> {
        &self.entries
    }

    /// Zustand eines Eintrags.
    #[must_use]
    pub fn get(&self, relative: impl AsRef<Path>) -> Option<&FileState> {
        self.entries.get(relative.as_ref())
    }

    /// Unterschiede von `self` (vorher) zu `after` (nachher).
    #[must_use]
    pub fn diff(&self, after: &Self) -> SnapshotDiff {
        let mut diff = SnapshotDiff::default();
        for (path, before) in &self.entries {
            match after.entries.get(path) {
                None => diff.removed.push((path.clone(), before.clone())),
                Some(now) if now != before => {
                    diff.changed
                        .push((path.clone(), before.clone(), now.clone()));
                }
                Some(_) => {}
            }
        }
        for (path, now) in &after.entries {
            if !self.entries.contains_key(path) {
                diff.added.push((path.clone(), now.clone()));
            }
        }
        diff
    }
}

fn capture_dir(
    abs: &Path,
    rel: &Path,
    entries: &mut BTreeMap<PathBuf, FileState>,
) -> io::Result<()> {
    for entry in fs::read_dir(abs)? {
        let entry = entry?;
        let abs_path = entry.path();
        let rel_path = rel.join(entry.file_name());
        let meta = fs::symlink_metadata(&abs_path)?;
        let file_type = meta.file_type();
        if file_type.is_symlink() {
            let target = fs::read_link(&abs_path)?;
            let hash: [u8; 32] = Sha256::digest(target.as_os_str().as_encoded_bytes()).into();
            entries.insert(
                rel_path,
                FileState {
                    is_dir: false,
                    is_symlink: true,
                    len: 0,
                    sha256: Some(hash),
                    readonly: false,
                },
            );
        } else if file_type.is_dir() {
            entries.insert(
                rel_path.clone(),
                FileState {
                    is_dir: true,
                    is_symlink: false,
                    len: 0,
                    sha256: None,
                    readonly: meta.permissions().readonly(),
                },
            );
            capture_dir(&abs_path, &rel_path, entries)?;
        } else {
            entries.insert(
                rel_path,
                FileState {
                    is_dir: false,
                    is_symlink: false,
                    len: meta.len(),
                    sha256: Some(hash_file(&abs_path)?),
                    readonly: meta.permissions().readonly(),
                },
            );
        }
    }
    Ok(())
}

fn hash_file(path: &Path) -> io::Result<[u8; 32]> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(buf.get(..n).unwrap_or_default());
    }
    Ok(hasher.finalize().into())
}

/// Unterschiede zwischen zwei Schnappschüssen.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SnapshotDiff {
    /// Neu hinzugekommen.
    pub added: Vec<(PathBuf, FileState)>,
    /// Entfernt.
    pub removed: Vec<(PathBuf, FileState)>,
    /// Verändert: (Pfad, vorher, nachher).
    pub changed: Vec<(PathBuf, FileState, FileState)>,
}

impl SnapshotDiff {
    /// `true`, wenn beide Schnappschüsse identisch sind.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.changed.is_empty()
    }
}

impl fmt::Display for SnapshotDiff {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.is_empty() {
            return f.write_str("Keine Veränderung.");
        }
        writeln!(f, "Der Ordner wurde verändert:")?;
        for (path, state) in &self.removed {
            writeln!(
                f,
                "  - entfernt:     {} ({})",
                path.display(),
                state.describe()
            )?;
        }
        for (path, state) in &self.added {
            writeln!(
                f,
                "  + hinzugefügt: {} ({})",
                path.display(),
                state.describe()
            )?;
        }
        for (path, before, after) in &self.changed {
            writeln!(
                f,
                "  ~ verändert:   {}: vorher {}, nachher {}",
                path.display(),
                before.describe(),
                after.describe()
            )?;
        }
        for (old, old_state) in &self.removed {
            for (new, new_state) in &self.added {
                if old_state.sha256.is_some() && old_state == new_state {
                    writeln!(
                        f,
                        "  (vermutlich umbenannt/verschoben: {} → {})",
                        old.display(),
                        new.display()
                    )?;
                }
            }
        }
        Ok(())
    }
}

/// Prüft, dass sich zwischen `before` und `after` nichts verändert hat; sonst schlägt der
/// Test mit einer lesbaren Auflistung aller Unterschiede fehl.
#[track_caller]
pub fn assert_unchanged(before: &DirSnapshot, after: &DirSnapshot) {
    let diff = before.diff(after);
    assert!(diff.is_empty(), "{diff}");
}

// ---------------------------------------------------------------------------------------
// Fixture-Helfer (freigegeben in mutation-allowlist.txt)
// ---------------------------------------------------------------------------------------

fn refuse(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message.to_owned())
}

/// Prüft `name` (relativ, nur normale Bestandteile) und liefert die Einzelteile.
fn fixture_components(name: &str) -> io::Result<Vec<&std::ffi::OsStr>> {
    let mut parts = Vec::new();
    for component in Path::new(name).components() {
        match component {
            Component::Normal(part) => parts.push(part),
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("Fixture-Name „{name}“ muss relativ sein und darf kein „..“ enthalten"),
                ));
            }
        }
    }
    if parts.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Fixture-Name ist leer",
        ));
    }
    Ok(parts)
}

/// Löst `name` innerhalb von `dir` auf. Zwischenordner dürfen keine Links sein; fehlende
/// Zwischenordner werden nur bei `create_parents` angelegt.
fn resolve_fixture(dir: &Path, name: &str, create_parents: bool) -> io::Result<PathBuf> {
    let parts = fixture_components(name)?;
    let mut path = dir.to_path_buf();
    let last = parts.len().saturating_sub(1);
    for (index, part) in parts.into_iter().enumerate() {
        path.push(part);
        if index == last {
            break;
        }
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(refuse("Zwischenordner ist ein Link – verweigert"));
            }
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => return Err(refuse("Zwischenpfad ist kein Ordner – verweigert")),
            Err(err) if err.kind() == io::ErrorKind::NotFound && create_parents => {
                // aegis-mutation: testing-fixture-create-dir
                #[allow(clippy::disallowed_methods)]
                fs::create_dir(&path)?;
            }
            Err(err) => return Err(err),
        }
    }
    Ok(path)
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
}

/// Schreibt eine Testdatei `dir/name` (legt fehlende Zwischenordner an, überschreibt eine
/// vorhandene Datei). Verweigert Namen außerhalb von `dir` (absolut, `..`) und Links.
///
/// # Errors
/// `InvalidInput`/`PermissionDenied` bei verbotenen Namen, sonst E/A-Fehler.
pub fn write_fixture(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<PathBuf> {
    let path = resolve_fixture(dir, name, true)?;
    if is_symlink(&path) {
        return Err(refuse("Ziel ist ein Link – verweigert"));
    }
    // aegis-mutation: testing-fixture-write
    #[allow(clippy::disallowed_methods)]
    fs::write(&path, bytes)?;
    Ok(path)
}

/// Legt einen (leeren) Testordner `dir/name` an.
///
/// # Errors
/// Wie [`write_fixture`].
pub fn create_fixture_dir(dir: &Path, name: &str) -> io::Result<PathBuf> {
    let path = resolve_fixture(dir, name, true)?;
    // aegis-mutation: testing-fixture-create-leaf-dir
    #[allow(clippy::disallowed_methods)]
    fs::create_dir(&path)?;
    Ok(path)
}

/// Entfernt eine Testdatei oder einen Testordner (samt Inhalt) `dir/name`. Ein Link wird
/// selbst entfernt, nie sein Ziel.
///
/// # Errors
/// Wie [`write_fixture`].
pub fn remove_fixture(dir: &Path, name: &str) -> io::Result<()> {
    let path = resolve_fixture(dir, name, false)?;
    let meta = fs::symlink_metadata(&path)?;
    if meta.is_dir() {
        // aegis-mutation: testing-fixture-remove-dir
        #[allow(clippy::disallowed_methods)]
        fs::remove_dir_all(&path)?;
    } else {
        // aegis-mutation: testing-fixture-remove-file
        #[allow(clippy::disallowed_methods)]
        fs::remove_file(&path)?;
    }
    Ok(())
}

/// Benennt `dir/from` in `dir/to` um (legt fehlende Zwischenordner für `to` an).
///
/// # Errors
/// Wie [`write_fixture`].
pub fn rename_fixture(dir: &Path, from: &str, to: &str) -> io::Result<PathBuf> {
    let source = resolve_fixture(dir, from, false)?;
    let target = resolve_fixture(dir, to, true)?;
    if is_symlink(&target) {
        return Err(refuse("Ziel ist ein Link – verweigert"));
    }
    // aegis-mutation: testing-fixture-rename
    #[allow(clippy::disallowed_methods)]
    fs::rename(&source, &target)?;
    Ok(target)
}

/// Setzt oder entfernt den Schreibschutz von `dir/name` (Links werden verweigert).
///
/// # Errors
/// Wie [`write_fixture`].
pub fn set_fixture_readonly(dir: &Path, name: &str, readonly: bool) -> io::Result<()> {
    let path = resolve_fixture(dir, name, false)?;
    if is_symlink(&path) {
        return Err(refuse("Ziel ist ein Link – verweigert"));
    }
    let mut permissions = fs::metadata(&path)?.permissions();
    permissions.set_readonly(readonly);
    // aegis-mutation: testing-fixture-set-readonly
    #[allow(clippy::disallowed_methods)]
    fs::set_permissions(&path, permissions)?;
    Ok(())
}

/// Legt einen symbolischen Link `dir/name` → `target` an, um die Link-Behandlung zu testen
/// (nur Unix; unter Windows braucht das Anlegen von Links besondere Rechte). Das Ziel wird
/// dabei weder gelesen noch verändert.
///
/// # Errors
/// Wie [`write_fixture`].
#[cfg(unix)]
pub fn create_fixture_symlink(dir: &Path, name: &str, target: &Path) -> io::Result<PathBuf> {
    let path = resolve_fixture(dir, name, true)?;
    // aegis-mutation: testing-fixture-symlink
    #[allow(clippy::disallowed_methods)]
    std::os::unix::fs::symlink(target, &path)?;
    Ok(path)
}

// ---------------------------------------------------------------------------------------
// EICAR
// ---------------------------------------------------------------------------------------

/// SHA-256 der 68-Byte-EICAR-Testdatei (zum Gegenprüfen).
pub const EICAR_SHA256_HEX: &str =
    "275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f";

/// Die Standard-EICAR-Testzeichenfolge (68 Byte), zur Laufzeit aus Teilen zusammengesetzt.
///
/// Die Quelldatei enthält die Zeichenfolge bewusst **nie am Stück** – sonst würde Windows
/// Defender schon diese Datei beim Klonen in Quarantäne verschieben. EICAR ist harmlos und
/// wird von allen Virenscannern als Test erkannt.
#[must_use]
pub fn eicar() -> Vec<u8> {
    const PARTS: [&str; 7] = [
        "X5O!P%@AP[4\\PZX5",
        "4(P^)7CC)7}$",
        "EIC",
        "AR-STAND",
        "ARD-ANTIV",
        "IRUS-TEST-FI",
        "LE!$H+H*",
    ];
    PARTS.concat().into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eicar_is_standard_test_file() {
        let data = eicar();
        assert_eq!(data.len(), 68);
        assert!(data.starts_with(b"X5O!P%@AP"));
        let hash: [u8; 32] = Sha256::digest(&data).into();
        assert_eq!(hex_lower(&hash), EICAR_SHA256_HEX);
    }

    #[test]
    fn manual_clock_is_shared_between_clones() {
        let clock = ManualClock::default();
        let other = clock.clone();
        assert_eq!(clock.now(), ManualClock::DEFAULT_START);
        other.advance(Duration::seconds(90));
        assert_eq!(
            clock.now(),
            ManualClock::DEFAULT_START + Duration::seconds(90)
        );
        clock.set(ManualClock::DEFAULT_START);
        assert_eq!(other.now(), ManualClock::DEFAULT_START);
        other.advance(Duration::MAX);
        assert!(clock.now() > ManualClock::DEFAULT_START);
    }

    #[test]
    fn sample_plans_exist_for_every_kind() {
        for kind in ActionKind::ALL {
            let plan = sample_plan(kind, ManualClock::DEFAULT_START).unwrap();
            assert_eq!(plan.kind(), kind);
        }
        assert!(
            sample_plan(
                ActionKind::Quarantine,
                OffsetDateTime::UNIX_EPOCH - Duration::DAY
            )
            .is_err()
        );
    }

    #[test]
    fn test_path_is_absolute() {
        let path = test_path("a/b//c.txt");
        assert!(path.is_absolute());
        assert!(path.ends_with("c.txt"));
        assert_eq!(path.components().count(), if cfg!(windows) { 6 } else { 5 });
    }
}
