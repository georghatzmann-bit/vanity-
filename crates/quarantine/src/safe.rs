//! Datei-Safe (P5): eigene Dateien passwortgeschützt verschlüsselt aufbewahren.
//!
//! - Ort: im Profil des Nutzers ([`SAFE_DIR`]); alle Dateizugriffe mit den Rechten des Nutzers
//!   ([`UserAccess`]) und ohne Links.
//! - Schlüssel: zufälliger Datenschlüssel (256 Bit), verpackt mit einem aus dem Passwort
//!   abgeleiteten Schlüssel (Argon2id, 64 MiB, 3 Durchläufe) per AES-256-GCM. Das Passwort
//!   wird nirgends gespeichert; ohne Passwort sind die Dateien nicht lesbar (auch nicht für
//!   AEGIS) – ein vergessenes Passwort kann niemand zurückholen.
//! - Inhalte: Container wie in der Quarantäne ([`crate::crypto`]); Name und Herkunft stehen
//!   verschlüsselt in einer eigenen Datei je Eintrag.
//! - Hineinlegen/Herausholen nur mit Erlaubnis ([`ExecutionPermit`]) des jeweiligen Plans;
//!   hineingelegte Originale werden erst nach geprüfter Kopie entfernt, herausgeholte Dateien
//!   überschreiben nie etwas.

use std::io::{self, BufReader, Read, Write};
use std::path::{Path, PathBuf};

use aegis_core::consent::ExecutionPermit;
use aegis_core::plan::{ActionKind, Target, param};
use aegis_core::time::OffsetDateTime;
use aegis_core::uuid::Uuid;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::crypto::{self, Key};
use crate::userfs::{self, UserAccess};

/// Ordner des Safes im Profil.
pub const SAFE_DIR: &str = "AppData/Local/AEGIS/Datei-Safe";
/// Kennung der Einstellung „Datei-Safe anlegen“.
pub const SAFE_SETTING: &str = "filesafe.create";
const HEADER_FILE: &str = "safe.json";
const CONTAINER_EXT: &str = "asf";
const META_EXT: &str = "meta";
const FORMAT: &str = "AEGIS-SAFE-1";
/// Mindestlänge des Passworts.
pub const MIN_PASSWORD: usize = 10;
/// Argon2id-Speicher (KiB) und Durchläufe, mit denen AEGIS Safes anlegt. Größere Werte aus
/// einem Safe-Kopf werden abgelehnt: Der Kopf liegt im Profil des Nutzers, und die
/// Ableitung läuft im Dienst – sonst könnte ein Kopf den Dienst Speicher und Zeit kosten.
pub const KDF_MEMORY_KIB: u32 = 64 * 1024;
/// Durchläufe (siehe [`KDF_MEMORY_KIB`]).
pub const KDF_PASSES: u32 = 3;
/// Fehlermeldung bei falschem Passwort (nur diese zählt als Fehlversuch).
pub const WRONG_PASSWORD: &str = "Falsches Passwort";
/// Höchstzahl Einträge, die beim Auflisten gelesen werden.
const MAX_ENTRIES: usize = 10_000;

/// Fehler des Safes (Texte für die Oberfläche).
pub type SafeResult<T> = Result<T, String>;

/// Ordner des Safes für ein Profil.
#[must_use]
pub fn safe_dir(profile: &Path) -> PathBuf {
    SAFE_DIR
        .split('/')
        .fold(profile.to_path_buf(), |p, c| p.join(c))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Header {
    format: String,
    salt: String,
    m_kib: u32,
    t: u32,
    p: u32,
    nonce: String,
    wrapped: String,
}

/// Vorbereiteter Safe: Kopf (zum Schreiben) und Datenschlüssel.
pub struct Prepared {
    header: Vec<u8>,
    key: Key,
}

impl std::fmt::Debug for Prepared {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Prepared { … }")
    }
}

impl Prepared {
    /// Der Datenschlüssel (für die Sitzung nach dem Anlegen).
    #[must_use]
    pub fn key(&self) -> Key {
        self.key.clone()
    }
}

/// Ein Eintrag im Safe.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SafeEntry {
    /// Kennung.
    pub id: String,
    /// Ursprünglicher Pfad.
    pub original_path: PathBuf,
    /// Größe (Byte).
    pub size: u64,
    /// SHA-256 des Inhalts.
    pub sha256: String,
    /// Hineingelegt (RFC 3339).
    pub stored_at: String,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

fn derive(password: &str, salt: &[u8], m_kib: u32, t: u32, p: u32) -> SafeResult<Key> {
    use argon2::{Algorithm, Argon2, Params, Version};
    let params = Params::new(m_kib, t, p, Some(32)).map_err(|e| e.to_string())?;
    let mut out = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, out.as_mut())
        .map_err(|e| e.to_string())?;
    Ok(out)
}

fn random<const N: usize>() -> SafeResult<[u8; N]> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).map_err(|_| "Zufallsquelle nicht verfügbar".to_owned())?;
    Ok(b)
}

/// Mit dem Schlüssel versiegeln (Nonce ‖ Chiffretext).
fn seal(key: &Key, plain: &[u8]) -> SafeResult<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|e| e.to_string())?;
    let nonce = random::<12>()?;
    let ct = cipher
        .encrypt(&Nonce::from(nonce), plain)
        .map_err(|_| "Verschlüsselung fehlgeschlagen".to_owned())?;
    let mut out = nonce.to_vec();
    out.extend(ct);
    Ok(out)
}

fn open_sealed(key: &Key, blob: &[u8]) -> SafeResult<Zeroizing<Vec<u8>>> {
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|e| e.to_string())?;
    let (nonce, ct) = blob.split_at_checked(12).ok_or("Eintrag beschädigt")?;
    let nonce: [u8; 12] = nonce.try_into().map_err(|_| "Eintrag beschädigt")?;
    cipher
        .decrypt(&Nonce::from(nonce), ct)
        .map(Zeroizing::new)
        .map_err(|_| "Falsches Passwort oder beschädigter Eintrag".to_owned())
}

/// Prüft das Passwort (Länge) und bereitet einen neuen Safe vor (Schlüssel ableiten,
/// Datenschlüssel erzeugen und verpacken). Schreibt nichts.
///
/// # Errors
/// Passwort zu kurz oder Ableitung nicht möglich.
pub fn prepare(password: &str) -> SafeResult<Prepared> {
    prepare_with(password, KDF_MEMORY_KIB, KDF_PASSES)
}

fn prepare_with(password: &str, m_kib: u32, t: u32) -> SafeResult<Prepared> {
    if password.chars().count() < MIN_PASSWORD {
        return Err(format!(
            "Das Passwort muss mindestens {MIN_PASSWORD} Zeichen haben"
        ));
    }
    let salt = random::<16>()?;
    let kek = derive(password, &salt, m_kib, t, 1)?;
    let key: Key = Zeroizing::new(random::<32>()?);
    let wrapped = seal(&kek, key.as_ref())?;
    let (nonce, ct) = wrapped.split_at(12);
    let header = Header {
        format: FORMAT.into(),
        salt: hex(&salt),
        m_kib,
        t,
        p: 1,
        nonce: hex(nonce),
        wrapped: hex(ct),
    };
    Ok(Prepared {
        header: serde_json::to_vec_pretty(&header).map_err(|e| e.to_string())?,
        key,
    })
}

/// Entsperrt mit dem Kopf (Bytes) und dem Passwort.
fn unlock_header(bytes: &[u8], password: &str) -> SafeResult<Key> {
    let header: Header =
        serde_json::from_slice(bytes).map_err(|_| "Safe-Kopf beschädigt".to_owned())?;
    if header.format != FORMAT
        || header.m_kib > KDF_MEMORY_KIB
        || header.m_kib < 8
        || header.t > KDF_PASSES
        || header.t == 0
        || header.p != 1
    {
        return Err("Unbekanntes Safe-Format".into());
    }
    let salt = unhex(&header.salt).ok_or("Safe-Kopf beschädigt")?;
    let mut blob = unhex(&header.nonce).ok_or("Safe-Kopf beschädigt")?;
    blob.extend(unhex(&header.wrapped).ok_or("Safe-Kopf beschädigt")?);
    let kek = derive(password, &salt, header.m_kib, header.t, header.p)?;
    let raw = open_sealed(&kek, &blob).map_err(|_| WRONG_PASSWORD.to_owned())?;
    let arr: [u8; 32] = raw
        .as_slice()
        .try_into()
        .map_err(|_| "Safe-Kopf beschädigt")?;
    Ok(Zeroizing::new(arr))
}

/// Gibt es im Ordner einen Safe?
#[must_use]
pub fn exists(dir: &Path) -> bool {
    std::fs::symlink_metadata(dir.join(HEADER_FILE)).is_ok_and(|m| m.is_file())
}

/// Liest eine kleine Datei des Safes (im Identitätswechsel), ohne Links.
fn read_small(path: &Path, max: u64) -> SafeResult<Vec<u8>> {
    let original = userfs::open_original(path).map_err(|e| e.to_string())?;
    let mut data = Vec::new();
    (&original.file)
        .take(max + 1)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() as u64 > max {
        return Err("Datei zu groß".into());
    }
    Ok(data)
}

/// Entsperrt den Safe (Kopf mit den Rechten des Nutzers gelesen).
///
/// # Errors
/// Kein Safe, falsches Passwort oder beschädigt.
pub fn unlock(user: &dyn UserAccess, dir: &Path, password: &str) -> SafeResult<Key> {
    let bytes = {
        let _scope = user.enter().map_err(|e| e.to_string())?;
        if !exists(dir) {
            return Err("Es gibt noch keinen Datei-Safe".into());
        }
        read_small(&dir.join(HEADER_FILE), 64 * 1024)?
    };
    unlock_header(&bytes, password)
}

/// Ordner anlegen (im Identitätswechsel) und prüfen, dass er ein echter Ordner ohne Umweg
/// über Verknüpfungen ist.
fn ensure_dir(dir: &Path) -> SafeResult<()> {
    // Legt den Ordner des Datei-Safes im Profil des Nutzers an – nur nach Freigabe des Plans
    // „Datei-Safe anlegen“, mit den Rechten des Nutzers.
    // aegis-mutation: quarantine-safe-create-dir
    #[allow(clippy::disallowed_methods)]
    std::fs::create_dir_all(dir).map_err(|e| format!("Ordner nicht anlegbar: {e}"))?;
    let meta = std::fs::symlink_metadata(dir).map_err(|e| e.to_string())?;
    let real = std::fs::canonicalize(dir).map_err(|e| e.to_string())?;
    let real_text = real.to_string_lossy();
    let real = real_text
        .strip_prefix(r"\\?\")
        .map_or_else(|| real.clone(), PathBuf::from);
    let same = if cfg!(windows) {
        real.to_string_lossy()
            .eq_ignore_ascii_case(&dir.to_string_lossy())
    } else {
        real == dir
    };
    if !meta.is_dir() || !same {
        return Err("Der Safe-Ordner führt über eine Verknüpfung – abgelehnt".into());
    }
    Ok(())
}

fn write_new(path: &Path, data: &[u8]) -> SafeResult<()> {
    let mut created = userfs::create_restored(path).map_err(|e| e.to_string())?;
    let written = created
        .file
        .write_all(data)
        .and_then(|()| created.file.sync_all());
    if let Err(e) = written {
        let _ = userfs::discard_restored(created);
        return Err(e.to_string());
    }
    Ok(())
}

fn safe_target(permit: &ExecutionPermit) -> SafeResult<PathBuf> {
    let plan = permit
        .ensure_kind(ActionKind::ChangeSetting)
        .map_err(|e| e.to_string())?;
    let ok = plan
        .targets()
        .iter()
        .any(|t| matches!(t, Target::Setting { id } if id == SAFE_SETTING));
    let dir = plan.targets().iter().find_map(|t| match t {
        Target::Other { description } => Some(PathBuf::from(description)),
        _ => None,
    });
    match dir {
        Some(dir) if ok && dir.is_absolute() => Ok(dir),
        _ => Err("Plan passt nicht zum Datei-Safe".into()),
    }
}

/// Legt den Safe an (Ordner + Kopf) – Ort aus dem Plan „Datei-Safe anlegen“.
///
/// # Errors
/// Plan passt nicht, Safe existiert schon oder Schreiben nicht möglich.
pub fn create(
    permit: &ExecutionPermit,
    user: &dyn UserAccess,
    prepared: &Prepared,
) -> SafeResult<()> {
    let dir = safe_target(permit)?;
    let _scope = user.enter().map_err(|e| e.to_string())?;
    if exists(&dir) {
        return Err("Es gibt schon einen Datei-Safe".into());
    }
    ensure_dir(&dir)?;
    write_new(&dir.join(HEADER_FILE), &prepared.header)
}

/// Einträge des Safes (Namen entschlüsselt).
///
/// # Errors
/// Ordner nicht lesbar.
pub fn list(user: &dyn UserAccess, dir: &Path, key: &Key) -> SafeResult<Vec<SafeEntry>> {
    let _scope = user.enter().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    for item in entries.flatten().take(MAX_ENTRIES) {
        let path = item.path();
        if path.extension().and_then(|e| e.to_str()) != Some(META_EXT) {
            continue;
        }
        let Ok(blob) = read_small(&path, 64 * 1024) else {
            continue;
        };
        let Ok(plain) = open_sealed(key, &blob) else {
            continue;
        };
        if let Ok(entry) = serde_json::from_slice::<SafeEntry>(&plain) {
            out.push(entry);
        }
    }
    out.sort_by(|a, b| b.stored_at.cmp(&a.stored_at));
    Ok(out)
}

/// Ergebnis je Datei.
pub type SafeResults = Vec<(PathBuf, Result<SafeEntry, String>)>;

/// Legt die Dateien des Plans verschlüsselt in den Safe; Originale werden erst nach geprüfter
/// Kopie entfernt.
///
/// # Errors
/// Plan passt nicht.
pub fn store(
    permit: &ExecutionPermit,
    user: &dyn UserAccess,
    dir: &Path,
    key: &Key,
) -> SafeResult<SafeResults> {
    let plan = permit
        .ensure_kind(ActionKind::SafeStore)
        .map_err(|e| e.to_string())?;
    let files: Vec<PathBuf> = plan
        .targets()
        .iter()
        .filter_map(|t| match t {
            Target::File { path } => Some(path.clone()),
            _ => None,
        })
        .collect();
    let now = OffsetDateTime::now_utc()
        .format(&aegis_core::time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    let _scope = user.enter().map_err(|e| e.to_string())?;
    if !exists(dir) {
        return Err("Es gibt noch keinen Datei-Safe".into());
    }
    Ok(files
        .into_iter()
        .map(|path| {
            let result = store_one(&path, dir, key, &now);
            (path, result)
        })
        .collect())
}

fn store_one(path: &Path, dir: &Path, key: &Key, now: &str) -> SafeResult<SafeEntry> {
    let original = userfs::open_original(path).map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().hyphenated().to_string();
    let container = dir.join(format!("{id}.{CONTAINER_EXT}"));
    let meta_path = dir.join(format!("{id}.{META_EXT}"));
    let mut out = userfs::create_restored(&container).map_err(|e| e.to_string())?;
    let encrypted = crypto::encrypt(
        key,
        BufReader::new(&original.file),
        &mut out.file,
        crypto::DEFAULT_CHUNK,
    )
    .map_err(|e| e.to_string())
    .and_then(|r| out.file.sync_all().map(|()| r).map_err(|e| e.to_string()));
    let (sha, size) = match encrypted {
        Ok(r) => r,
        Err(e) => {
            let _ = userfs::discard_restored(out);
            return Err(e);
        }
    };
    drop(out);
    // Kopie prüfen, bevor das Original entfernt wird.
    let check = userfs::open_original(&container)
        .map_err(|e| e.to_string())
        .and_then(|c| {
            crypto::decrypt(key, BufReader::new(&c.file), io::sink()).map_err(|e| e.to_string())
        });
    let entry = SafeEntry {
        id,
        original_path: path.to_path_buf(),
        size,
        sha256: hex(&sha),
        stored_at: now.to_owned(),
    };
    let sealed = serde_json::to_vec(&entry)
        .map_err(|e| e.to_string())
        .and_then(|j| seal(key, &j));
    let fail = |message: String| {
        if let Ok(c) = userfs::open_original(&container) {
            let _ = userfs::remove_original(c);
        }
        if let Ok(m) = userfs::open_original(&meta_path) {
            let _ = userfs::remove_original(m);
        }
        Err(message)
    };
    match check {
        Ok((h, n)) if h == sha && n == size => {}
        Ok(_) => return fail("Kopie im Safe stimmt nicht – Original bleibt".into()),
        Err(e) => return fail(e),
    }
    let sealed = match sealed {
        Ok(s) => s,
        Err(e) => return fail(e),
    };
    if let Err(e) = write_new(&meta_path, &sealed) {
        return fail(e);
    }
    if let Err(e) = userfs::remove_original(original) {
        return fail(format!(
            "Original nicht entfernbar ({e}) – nichts verschoben"
        ));
    }
    Ok(entry)
}

/// Holt den Eintrag des Plans an den Ort aus dem Plan zurück (nie überschreiben) und entfernt
/// ihn danach aus dem Safe.
///
/// # Errors
/// Plan passt nicht, Eintrag fehlt, Ziel belegt oder Inhalt beschädigt.
pub fn retrieve(
    permit: &ExecutionPermit,
    user: &dyn UserAccess,
    dir: &Path,
    key: &Key,
) -> SafeResult<SafeEntry> {
    let plan = permit
        .ensure_kind(ActionKind::SafeRetrieve)
        .map_err(|e| e.to_string())?;
    let (Some(Target::File { path: target }), Some(id)) =
        (plan.targets().first(), plan.parameter(param::SAFE_ENTRY))
    else {
        return Err("Plan unvollständig".into());
    };
    let id = Uuid::parse_str(id)
        .map_err(|_| "Ungültiger Eintrag".to_owned())?
        .hyphenated()
        .to_string();
    let _scope = user.enter().map_err(|e| e.to_string())?;
    let meta_path = dir.join(format!("{id}.{META_EXT}"));
    let container = dir.join(format!("{id}.{CONTAINER_EXT}"));
    let blob = read_small(&meta_path, 64 * 1024)?;
    let plain = open_sealed(key, &blob)?;
    let entry: SafeEntry =
        serde_json::from_slice(&plain).map_err(|_| "Eintrag beschädigt".to_owned())?;
    if entry.id != id {
        return Err("Eintrag beschädigt".into());
    }
    let source = userfs::open_original(&container).map_err(|e| e.to_string())?;
    let mut restored = userfs::create_restored(target).map_err(|e| e.to_string())?;
    let result = crypto::decrypt(key, BufReader::new(&source.file), &mut restored.file)
        .map_err(|e| e.to_string())
        .and_then(|r| {
            restored
                .file
                .sync_all()
                .map(|()| r)
                .map_err(|e| e.to_string())
        });
    match result {
        Ok((sha, size)) if hex(&sha) == entry.sha256 && size == entry.size => {}
        Ok(_) | Err(_) => {
            let _ = userfs::discard_restored(restored);
            return Err("Inhalt im Safe ist beschädigt – nichts zurückgelegt".into());
        }
    }
    drop(restored);
    // Erst nach geprüfter Wiederherstellung aus dem Safe entfernen.
    let _ = userfs::remove_original(source);
    if let Ok(m) = userfs::open_original(&meta_path) {
        let _ = userfs::remove_original(m);
    }
    Ok(entry)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passwort_entsperrt_nur_richtig() {
        let p = prepare_with("richtig-langes-passwort", 64, 1).unwrap();
        let key = unlock_header(&p.header, "richtig-langes-passwort").unwrap();
        assert_eq!(key.as_ref(), p.key.as_ref());
        assert!(unlock_header(&p.header, "falsches-passwort!").is_err());
        assert!(prepare_with("kurz", 64, 1).is_err());
        // Zu teure Ableitung aus einem fremden Kopf wird abgelehnt (nicht ausgeführt).
        let costly = String::from_utf8(p.header.clone())
            .unwrap()
            .replace("\"m_kib\": 64", "\"m_kib\": 1048576");
        assert_eq!(
            unlock_header(costly.as_bytes(), "richtig-langes-passwort").unwrap_err(),
            "Unbekanntes Safe-Format"
        );
        assert_eq!(
            unlock_header(&p.header, "falsches-passwort!").unwrap_err(),
            WRONG_PASSWORD
        );
        let text = String::from_utf8(p.header.clone()).unwrap();
        assert!(!text.contains("richtig"), "Passwort steht nirgends");
    }

    #[test]
    fn versiegelte_eintraege() {
        let key: Key = Zeroizing::new([7u8; 32]);
        let blob = seal(&key, b"geheim").unwrap();
        assert_eq!(open_sealed(&key, &blob).unwrap().as_slice(), b"geheim");
        let mut bad = blob.clone();
        let last = bad.len() - 1;
        bad[last] ^= 1;
        assert!(open_sealed(&key, &bad).is_err());
        let other: Key = Zeroizing::new([8u8; 32]);
        assert!(open_sealed(&other, &blob).is_err());
    }

    #[test]
    fn ort_im_profil() {
        let d = safe_dir(Path::new("/home/a"));
        assert!(d.ends_with("AppData/Local/AEGIS/Datei-Safe"));
    }
}
