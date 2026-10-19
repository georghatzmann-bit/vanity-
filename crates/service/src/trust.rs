//! Vertrauensliste („Vertraut“): Hash **und** Pfad, mit Grund und Datum, je Konto, jederzeit
//! widerrufbar. Einträge entstehen nur aus der Nutzerentscheidung „Vertrauen“ im
//! Freigabe-Dialog (`TrustGrant`). Gespeichert als JSON im Datenordner des Dienstes,
//! atomar ersetzt (Teil-Datei → umbenennen).

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use aegis_core::time::OffsetDateTime;
use serde::{Deserialize, Serialize};

/// Höchstzahl Einträge (Schutz vor beliebigem Anwachsen).
pub const MAX_ENTRIES: usize = 10_000;
/// Höchstgröße der Datei beim Lesen.
const MAX_FILE: u64 = 16 * 1024 * 1024;

/// Ein vertrauter Eintrag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrustEntry {
    /// Kennung (UUID).
    pub id: String,
    /// SHA-256 (Hex) der vertrauten Datei.
    pub sha256: String,
    /// Pfad der vertrauten Datei.
    pub path: PathBuf,
    /// Grund (aus dem Vorschlag, in dem „Vertrauen“ gewählt wurde).
    pub reason: String,
    /// Zeitpunkt.
    #[serde(with = "aegis_core::time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// Konto (SID); `None` = ohne Kontotrennung (Entwicklung).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
}

/// Die Vertrauensliste.
#[derive(Debug)]
pub struct TrustStore {
    path: Option<PathBuf>,
    entries: Vec<TrustEntry>,
}

fn same_path(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

impl TrustStore {
    /// Öffnet die Liste (fehlt die Datei: leer).
    ///
    /// # Errors
    /// Datei beschädigt oder nicht lesbar – dann startet der Dienst nicht (lieber sichtbar
    /// als still „alles vertraut“ oder „nichts vertraut“).
    pub fn open(path: &Path) -> io::Result<Self> {
        let entries = match std::fs::File::open(path) {
            Ok(file) => {
                let mut text = String::new();
                file.take(MAX_FILE).read_to_string(&mut text)?;
                serde_json::from_str(&text).map_err(|e| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("Vertrauensliste {} beschädigt: {e}", path.display()),
                    )
                })?
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e),
        };
        Ok(Self {
            path: Some(path.to_owned()),
            entries,
        })
    }

    /// Nur im Speicher (Tests, Werkzeuge).
    #[must_use]
    pub fn in_memory() -> Self {
        Self {
            path: None,
            entries: Vec::new(),
        }
    }

    /// Einträge eines Kontos.
    #[must_use]
    pub fn list(&self, owner: Option<&str>) -> Vec<TrustEntry> {
        self.entries
            .iter()
            .filter(|e| e.owner.as_deref() == owner)
            .cloned()
            .collect()
    }

    /// Vertraut das Konto genau dieser Datei (Hash **und** Pfad)?
    #[must_use]
    pub fn lookup(&self, sha256: &str, path: &Path, owner: Option<&str>) -> Option<&TrustEntry> {
        self.entries.iter().find(|e| {
            e.owner.as_deref() == owner
                && e.sha256.eq_ignore_ascii_case(sha256)
                && same_path(&e.path, path)
        })
    }

    /// Fügt Einträge hinzu (doppelte Hash+Pfad-Paare eines Kontos werden ersetzt).
    ///
    /// # Errors
    /// Zu viele Einträge oder Speichern fehlgeschlagen (dann bleibt die Liste unverändert).
    pub fn add(&mut self, new: Vec<TrustEntry>) -> io::Result<()> {
        let mut entries = self.entries.clone();
        for entry in new {
            entries.retain(|e| {
                !(e.owner == entry.owner
                    && e.sha256.eq_ignore_ascii_case(&entry.sha256)
                    && same_path(&e.path, &entry.path))
            });
            entries.push(entry);
        }
        if entries.len() > MAX_ENTRIES {
            return Err(io::Error::other("Vertrauensliste ist voll"));
        }
        self.save(&entries)?;
        self.entries = entries;
        Ok(())
    }

    /// Widerruft einen Eintrag des Kontos.
    ///
    /// # Errors
    /// Speichern fehlgeschlagen.
    pub fn revoke(&mut self, id: &str, owner: Option<&str>) -> io::Result<bool> {
        let mut entries = self.entries.clone();
        let before = entries.len();
        entries.retain(|e| !(e.id == id && e.owner.as_deref() == owner));
        if entries.len() == before {
            return Ok(false);
        }
        self.save(&entries)?;
        self.entries = entries;
        Ok(true)
    }

    fn save(&self, entries: &[TrustEntry]) -> io::Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let json = serde_json::to_vec_pretty(entries).map_err(io::Error::other)?;
        let part = path.with_extension("json.part");
        remove_part(&part)?;
        {
            let mut file = create_part(&part)?;
            file.write_all(&json)?;
            file.sync_all()?;
        }
        commit(&part, path)
    }
}

// ---------------------------------------------------------------------------------------
// Verändernde Aufrufe – nur die eigene Datei im Datenordner, jeweils markiert.
// ---------------------------------------------------------------------------------------

fn remove_part(path: &Path) -> io::Result<()> {
    // Eigene, liegengebliebene Teil-Datei der Vertrauensliste entfernen.
    // aegis-mutation: service-trust-remove-part
    #[allow(clippy::disallowed_methods)]
    match std::fs::remove_file(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

fn create_part(path: &Path) -> io::Result<std::fs::File> {
    // Neue Teil-Datei der Vertrauensliste im eigenen Datenordner.
    // aegis-mutation: service-trust-create-part
    #[allow(clippy::disallowed_methods)]
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path);
    file
}

fn commit(from: &Path, to: &Path) -> io::Result<()> {
    // Vertrauensliste atomar ersetzen (eigene Datei im Datenordner).
    // aegis-mutation: service-trust-commit
    #[allow(clippy::disallowed_methods)]
    std::fs::rename(from, to)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, owner: Option<&str>) -> TrustEntry {
        TrustEntry {
            id: id.into(),
            sha256: "AB".repeat(32),
            path: PathBuf::from("/home/x/trainer.exe"),
            reason: "Spiel-Tool, bewusst installiert".into(),
            created_at: OffsetDateTime::UNIX_EPOCH,
            owner: owner.map(str::to_owned),
        }
    }

    #[test]
    fn hinzufuegen_finden_widerrufen_und_dauerhaft() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("trust.json");
        let mut store = TrustStore::open(&file).unwrap();
        store
            .add(vec![entry("1", Some("S-A")), entry("2", Some("S-B"))])
            .unwrap();
        let sha = "ab".repeat(32);
        let path = Path::new("/home/x/trainer.exe");
        assert!(store.lookup(&sha, path, Some("S-A")).is_some());
        assert!(
            store
                .lookup(&sha, Path::new("/anders.exe"), Some("S-A"))
                .is_none()
        );
        assert!(store.lookup(&"cd".repeat(32), path, Some("S-A")).is_none());
        assert_eq!(store.list(Some("S-B")).len(), 1);
        // Fremdes Konto kann nicht widerrufen.
        assert!(!store.revoke("1", Some("S-B")).unwrap());
        let reopened = TrustStore::open(&file).unwrap();
        assert_eq!(reopened.list(Some("S-A")).len(), 1);
        assert!(store.revoke("1", Some("S-A")).unwrap());
        assert!(
            TrustStore::open(&file)
                .unwrap()
                .list(Some("S-A"))
                .is_empty()
        );
        // Gleiches Paar ersetzt den alten Eintrag.
        store.add(vec![entry("3", Some("S-B"))]).unwrap();
        assert_eq!(store.list(Some("S-B")).len(), 1);
    }

    #[test]
    fn beschaedigte_liste_wird_gemeldet() {
        let dir = tempfile::tempdir().unwrap();
        let file =
            aegis_core::testing::write_fixture(dir.path(), "trust.json", b"{kaputt").unwrap();
        assert!(TrustStore::open(&file).is_err());
    }
}
