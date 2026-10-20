//! Dateiformat und Verschlüsselung des Tresors.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::entry::{Entry, EntryInput};

/// Kennung des Formats.
pub const FORMAT: &str = "AEGIS-VAULT-1";
/// Mindestlänge des Master-Passworts.
pub const MIN_MASTER: usize = 12;
/// Höchstzahl Einträge.
pub const MAX_ENTRIES: usize = 20_000;
/// Größte Tresordatei (Bytes).
pub const MAX_FILE: usize = 64 * 1024 * 1024;

/// Argon2id-Parameter (stehen in der Datei).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KdfParams {
    /// Speicher in KiB (mindestens 64 MiB).
    pub m_kib: u32,
    /// Durchläufe (mindestens 3).
    pub t: u32,
    /// Parallelität.
    pub p: u32,
}

impl KdfParams {
    /// Standard beim Anlegen: 64 MiB, 3 Durchläufe, 1 Spur.
    pub const DEFAULT: Self = Self {
        m_kib: 64 * 1024,
        t: 3,
        p: 1,
    };

    /// Zulässig? Untergrenzen laut Vorgabe, Obergrenzen gegen manipulierte Dateien
    /// (sonst ließe sich das Öffnen beliebig verlangsamen).
    #[must_use]
    pub fn acceptable(&self) -> bool {
        (64 * 1024..=1024 * 1024).contains(&self.m_kib)
            && (3..=20).contains(&self.t)
            && (1..=8).contains(&self.p)
    }
}

/// Fehler.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultError {
    /// Falsches Master-Passwort (oder manipulierter Kopf).
    WrongPassword,
    /// Datei beschädigt oder unbekanntes Format.
    Corrupt(String),
    /// Ungültige Eingabe (Text für die Oberfläche).
    Input(String),
    /// Zufallsquelle oder Krypto nicht verfügbar.
    Crypto,
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WrongPassword => f.write_str("Falsches Master-Passwort"),
            Self::Corrupt(m) => write!(f, "Tresordatei beschädigt: {m}"),
            Self::Input(m) => f.write_str(m),
            Self::Crypto => f.write_str("Verschlüsselung nicht verfügbar"),
        }
    }
}

impl std::error::Error for VaultError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Sealed {
    nonce: String,
    ct: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SealedEntry {
    id: String,
    nonce: String,
    ct: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileFormat {
    format: String,
    kdf: KdfParams,
    salt: String,
    key: Sealed,
    /// Zufallswert dieser Speicherung: Jeder Eintrag ist mit ihm, seiner Position und der
    /// Gesamtzahl verknüpft – Entfernen, Vertauschen, Verdoppeln oder das Einmischen alter
    /// Einträge fällt auf.
    epoch: String,
    entries: Vec<SealedEntry>,
}

type Key = Zeroizing<[u8; 32]>;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || text.len() > 2 * MAX_FILE {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

fn random<const N: usize>() -> Result<[u8; N], VaultError> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).map_err(|_| VaultError::Crypto)?;
    Ok(b)
}

fn derive(password: &str, salt: &[u8], kdf: KdfParams) -> Result<Key, VaultError> {
    let params = Params::new(kdf.m_kib, kdf.t, kdf.p, Some(32)).map_err(|_| VaultError::Crypto)?;
    let mut out = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, out.as_mut())
        .map_err(|_| VaultError::Crypto)?;
    Ok(out)
}

fn seal(key: &Key, plain: &[u8], aad: &[u8]) -> Result<(String, String), VaultError> {
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| VaultError::Crypto)?;
    let nonce = random::<12>()?;
    let ct = cipher
        .encrypt(&Nonce::from(nonce), Payload { msg: plain, aad })
        .map_err(|_| VaultError::Crypto)?;
    Ok((hex(&nonce), hex(&ct)))
}

fn open(key: &Key, nonce: &str, ct: &str, aad: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).ok()?;
    let nonce: [u8; 12] = unhex(nonce)?.try_into().ok()?;
    let ct = unhex(ct)?;
    cipher
        .decrypt(&Nonce::from(nonce), Payload { msg: &ct, aad })
        .ok()
        .map(Zeroizing::new)
}

/// Bindet den verpackten Schlüssel an Format, Parameter und Salz.
fn key_aad(kdf: KdfParams, salt: &str) -> Vec<u8> {
    format!("{FORMAT}|{}|{}|{}|{salt}", kdf.m_kib, kdf.t, kdf.p).into_bytes()
}

fn entry_aad(id: &str, epoch: &str, index: usize, count: usize) -> Vec<u8> {
    format!("{FORMAT}|entry|{epoch}|{index}/{count}|{id}").into_bytes()
}

/// Entsperrter Tresor im Speicher.
pub struct Vault {
    kdf: KdfParams,
    salt: String,
    wrapped: Sealed,
    key: Key,
    entries: Vec<Entry>,
}

impl std::fmt::Debug for Vault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Vault")
            .field("entries", &self.entries.len())
            .finish_non_exhaustive()
    }
}

fn check_master(password: &str) -> Result<(), VaultError> {
    if password.chars().count() < MIN_MASTER {
        return Err(VaultError::Input(format!(
            "Das Master-Passwort braucht mindestens {MIN_MASTER} Zeichen."
        )));
    }
    if password.len() > 1024 {
        return Err(VaultError::Input("Das Master-Passwort ist zu lang.".into()));
    }
    Ok(())
}

impl Vault {
    /// Neuer, leerer Tresor.
    ///
    /// # Errors
    /// Master-Passwort zu kurz, Parameter unzulässig, Krypto nicht verfügbar.
    pub fn create(master: &str, kdf: KdfParams) -> Result<Self, VaultError> {
        check_master(master)?;
        if !kdf.acceptable() {
            return Err(VaultError::Input("Unzulässige Schlüssel-Parameter.".into()));
        }
        let salt = hex(&random::<16>()?);
        let kek = derive(master, salt.as_bytes(), kdf)?;
        let key: Key = Zeroizing::new(random::<32>()?);
        let (nonce, ct) = seal(&kek, key.as_ref(), &key_aad(kdf, &salt))?;
        Ok(Self {
            kdf,
            salt,
            wrapped: Sealed { nonce, ct },
            key,
            entries: Vec::new(),
        })
    }

    /// Öffnet eine Tresordatei.
    ///
    /// # Errors
    /// Falsches Passwort, beschädigte Datei, unzulässige Parameter.
    pub fn open(bytes: &[u8], master: &str) -> Result<Self, VaultError> {
        if bytes.len() > MAX_FILE {
            return Err(VaultError::Corrupt("zu groß".into()));
        }
        let file: FileFormat =
            serde_json::from_slice(bytes).map_err(|e| VaultError::Corrupt(e.to_string()))?;
        if file.format != FORMAT {
            return Err(VaultError::Corrupt("unbekanntes Format".into()));
        }
        if !file.kdf.acceptable() || file.salt.len() != 32 {
            return Err(VaultError::Corrupt(
                "unzulässige Schlüssel-Parameter".into(),
            ));
        }
        if file.entries.len() > MAX_ENTRIES {
            return Err(VaultError::Corrupt("zu viele Einträge".into()));
        }
        let kek = derive(master, file.salt.as_bytes(), file.kdf)?;
        let raw = open(
            &kek,
            &file.key.nonce,
            &file.key.ct,
            &key_aad(file.kdf, &file.salt),
        )
        .ok_or(VaultError::WrongPassword)?;
        let key: Key = Zeroizing::new(
            raw.as_slice()
                .try_into()
                .map_err(|_| VaultError::Corrupt("Schlüssel".into()))?,
        );
        if file.epoch.len() != 32 {
            return Err(VaultError::Corrupt("Speicherkennung".into()));
        }
        let count = file.entries.len();
        let mut entries: Vec<Entry> = Vec::with_capacity(count);
        for (index, sealed) in file.entries.iter().enumerate() {
            if entries.iter().any(|e| e.id == sealed.id) {
                return Err(VaultError::Corrupt("Eintrag doppelt".into()));
            }
            let aad = entry_aad(&sealed.id, &file.epoch, index, count);
            let plain = open(&key, &sealed.nonce, &sealed.ct, &aad)
                .ok_or_else(|| VaultError::Corrupt("Eintrag manipuliert".into()))?;
            let entry: Entry = serde_json::from_slice(&plain)
                .map_err(|_| VaultError::Corrupt("Eintrag unlesbar".into()))?;
            if entry.id != sealed.id {
                return Err(VaultError::Corrupt("Eintrag vertauscht".into()));
            }
            entries.push(entry);
        }
        Ok(Self {
            kdf: file.kdf,
            salt: file.salt,
            wrapped: file.key,
            key,
            entries,
        })
    }

    /// Verschlüsselt alles neu (neue Nonce je Eintrag) und liefert die Datei.
    ///
    /// # Errors
    /// Krypto nicht verfügbar.
    pub fn to_bytes(&self) -> Result<Vec<u8>, VaultError> {
        let epoch = hex(&random::<16>()?);
        let count = self.entries.len();
        let mut entries = Vec::with_capacity(count);
        for (index, e) in self.entries.iter().enumerate() {
            let plain = Zeroizing::new(serde_json::to_vec(e).map_err(|_| VaultError::Crypto)?);
            let aad = entry_aad(&e.id, &epoch, index, count);
            let (nonce, ct) = seal(&self.key, &plain, &aad)?;
            entries.push(SealedEntry {
                id: e.id.clone(),
                nonce,
                ct,
            });
        }
        serde_json::to_vec_pretty(&FileFormat {
            format: FORMAT.to_owned(),
            kdf: self.kdf,
            salt: self.salt.clone(),
            key: self.wrapped.clone(),
            epoch,
            entries,
        })
        .map_err(|_| VaultError::Crypto)
    }

    /// Master-Passwort ändern: neuer Datenschlüssel (alle Einträge werden beim Speichern damit
    /// neu verschlüsselt), neues Salz. Alte Kopien der Datei bleiben nur mit dem alten Passwort
    /// lesbar und verraten nichts über spätere Fassungen.
    ///
    /// # Errors
    /// Altes Passwort falsch, neues zu kurz.
    pub fn change_master(&mut self, old: &str, new: &str) -> Result<(), VaultError> {
        check_master(new)?;
        let kek = derive(old, self.salt.as_bytes(), self.kdf)?;
        open(
            &kek,
            &self.wrapped.nonce,
            &self.wrapped.ct,
            &key_aad(self.kdf, &self.salt),
        )
        .ok_or(VaultError::WrongPassword)?;
        let salt = hex(&random::<16>()?);
        let kek = derive(new, salt.as_bytes(), self.kdf)?;
        let key: Key = Zeroizing::new(random::<32>()?);
        let (nonce, ct) = seal(&kek, key.as_ref(), &key_aad(self.kdf, &salt))?;
        self.key = key;
        self.salt = salt;
        self.wrapped = Sealed { nonce, ct };
        Ok(())
    }

    /// Parameter der Schlüsselableitung.
    #[must_use]
    pub fn kdf(&self) -> KdfParams {
        self.kdf
    }

    /// Alle Einträge.
    #[must_use]
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    /// Ein Eintrag.
    #[must_use]
    pub fn get(&self, id: &str) -> Option<&Entry> {
        self.entries.iter().find(|e| e.id == id)
    }

    /// Neuer Eintrag; liefert die Kennung.
    ///
    /// # Errors
    /// Ungültige Eingabe, Tresor voll.
    pub fn add(&mut self, input: &EntryInput, now: i64) -> Result<String, VaultError> {
        if self.entries.len() >= MAX_ENTRIES {
            return Err(VaultError::Input("Der Tresor ist voll.".into()));
        }
        let v = input.validated().map_err(VaultError::Input)?;
        let id = uuid::Uuid::new_v4().hyphenated().to_string();
        self.entries.push(Entry {
            id: id.clone(),
            title: v.title.clone(),
            username: v.username.clone(),
            password: v.password.clone(),
            urls: v.urls.clone(),
            notes: v.notes.clone(),
            folder: v.folder.clone(),
            tags: v.tags.clone(),
            favorite: v.favorite,
            created: now,
            modified: now,
            password_changed: now,
        });
        Ok(id)
    }

    /// Eintrag ändern.
    ///
    /// # Errors
    /// Unbekannt oder ungültige Eingabe.
    pub fn update(&mut self, id: &str, input: &EntryInput, now: i64) -> Result<(), VaultError> {
        let v = input.validated().map_err(VaultError::Input)?;
        let e = self
            .entries
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or_else(|| VaultError::Input("Eintrag nicht gefunden.".into()))?;
        if e.password != v.password {
            e.password_changed = now;
        }
        e.title = v.title.clone();
        e.username = v.username.clone();
        e.password = v.password.clone();
        e.urls = v.urls.clone();
        e.notes = v.notes.clone();
        e.folder = v.folder.clone();
        e.tags = v.tags.clone();
        e.favorite = v.favorite;
        e.modified = now;
        Ok(())
    }

    /// Eintrag entfernen (der Nutzer hat in der Oberfläche bestätigt).
    ///
    /// # Errors
    /// Unbekannt.
    pub fn remove(&mut self, id: &str) -> Result<(), VaultError> {
        let before = self.entries.len();
        self.entries.retain(|e| e.id != id);
        if self.entries.len() == before {
            return Err(VaultError::Input("Eintrag nicht gefunden.".into()));
        }
        Ok(())
    }

    /// Alle Ordner (sortiert).
    #[must_use]
    pub fn folders(&self) -> Vec<String> {
        let mut f: Vec<String> = self
            .entries
            .iter()
            .filter(|e| !e.folder.is_empty())
            .map(|e| e.folder.clone())
            .collect();
        f.sort();
        f.dedup();
        f
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parameter der Tests (die echte Untergrenze; Argon2 ist im Testprofil optimiert).
    fn fast() -> KdfParams {
        KdfParams::DEFAULT
    }

    fn input(title: &str, password: &str) -> EntryInput {
        let mut e = EntryInput::default();
        e.title = title.into();
        e.username = "anna".into();
        e.password = password.into();
        e.urls = vec!["https://bank.example".into()];
        e
    }

    #[test]
    fn anlegen_speichern_oeffnen() {
        let mut v = Vault::create("ein langes Master-Passwort", fast()).unwrap();
        let id = v.add(&input("Bank", "S3hr-geheim!"), 10).unwrap();
        let bytes = v.to_bytes().unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains("S3hr-geheim"));
        assert!(!text.contains("Bank"));
        assert!(text.contains("\"m_kib\": 65536"));
        let w = Vault::open(&bytes, "ein langes Master-Passwort").unwrap();
        assert_eq!(w.get(&id).unwrap().password, "S3hr-geheim!");
        assert_eq!(
            Vault::open(&bytes, "falsches Master-Passwort").unwrap_err(),
            VaultError::WrongPassword
        );
        // Neue Nonces bei jedem Speichern.
        assert_ne!(bytes, v.to_bytes().unwrap());
    }

    #[test]
    fn manipulation_wird_erkannt() {
        let mut v = Vault::create("ein langes Master-Passwort", fast()).unwrap();
        v.add(&input("A", "pa"), 1).unwrap();
        v.add(&input("B", "pb"), 1).unwrap();
        v.add(&input("C", "pc"), 1).unwrap();
        let mut file: serde_json::Value = serde_json::from_slice(&v.to_bytes().unwrap()).unwrap();
        // Kennungen zweier Einträge vertauschen → AAD passt nicht mehr.
        let entries = file["entries"].as_array_mut().unwrap();
        let first = entries[0]["id"].clone();
        entries[0]["id"] = entries[1]["id"].clone();
        entries[1]["id"] = first;
        let bytes = serde_json::to_vec(&file).unwrap();
        assert!(matches!(
            Vault::open(&bytes, "ein langes Master-Passwort"),
            Err(VaultError::Corrupt(_))
        ));
        // Parameter herabsetzen → abgelehnt bzw. Schlüssel passt nicht.
        let mut file: serde_json::Value = serde_json::from_slice(&v.to_bytes().unwrap()).unwrap();
        file["kdf"]["t"] = 4.into();
        let bytes = serde_json::to_vec(&file).unwrap();
        assert_eq!(
            Vault::open(&bytes, "ein langes Master-Passwort").unwrap_err(),
            VaultError::WrongPassword
        );
        file["kdf"]["m_kib"] = 1024.into();
        let bytes = serde_json::to_vec(&file).unwrap();
        assert!(matches!(
            Vault::open(&bytes, "ein langes Master-Passwort"),
            Err(VaultError::Corrupt(_))
        ));
        assert!(Vault::open(b"kein json", "x").is_err());

        let master = "ein langes Master-Passwort";
        let corrupt = |file: &serde_json::Value| {
            matches!(
                Vault::open(&serde_json::to_vec(file).unwrap(), master),
                Err(VaultError::Corrupt(_))
            )
        };
        let original: serde_json::Value = serde_json::from_slice(&v.to_bytes().unwrap()).unwrap();
        // Eintrag entfernen → Gesamtzahl passt nicht mehr.
        let mut file = original.clone();
        file["entries"].as_array_mut().unwrap().pop();
        assert!(corrupt(&file));
        // Eintrag verdoppeln.
        let mut file = original.clone();
        let copy = file["entries"][0].clone();
        file["entries"].as_array_mut().unwrap()[2] = copy;
        assert!(corrupt(&file));
        // Reihenfolge tauschen.
        let mut file = original.clone();
        file["entries"].as_array_mut().unwrap().swap(0, 1);
        assert!(corrupt(&file));
        // Alten Eintrag aus einer früheren Speicherung einmischen (gleicher Schlüssel).
        let older: serde_json::Value = serde_json::from_slice(&v.to_bytes().unwrap()).unwrap();
        let mut file = original.clone();
        file["entries"][1] = older["entries"][1].clone();
        assert!(corrupt(&file));
        assert!(Vault::open(&serde_json::to_vec(&original).unwrap(), master).is_ok());
    }

    #[test]
    fn master_aendern_und_eintraege() {
        assert!(matches!(
            Vault::create("kurz", fast()),
            Err(VaultError::Input(_))
        ));
        let mut v = Vault::create("ein langes Master-Passwort", fast()).unwrap();
        let id = v.add(&input("Mail", "alt"), 1).unwrap();
        v.update(&id, &input("Mail", "neu"), 5).unwrap();
        assert_eq!(v.get(&id).unwrap().password_changed, 5);
        let mut changed = input("Mail", "neu");
        changed.folder = "Privat".into();
        v.update(&id, &changed, 9).unwrap();
        assert_eq!(v.get(&id).unwrap().password_changed, 5);
        assert_eq!(v.folders(), vec!["Privat"]);
        assert_eq!(
            v.change_master("falsch falsch falsch", "ein neues Master-Passwort"),
            Err(VaultError::WrongPassword)
        );
        v.change_master("ein langes Master-Passwort", "ein neues Master-Passwort")
            .unwrap();
        let before = v.to_bytes().unwrap();
        let old_key = v.key.clone();
        v.change_master("ein langes Master-Passwort", "ein neues Master-Passwort")
            .unwrap_err();
        v.change_master("ein neues Master-Passwort", "ein drittes Master-Passwort")
            .unwrap();
        // Neuer Datenschlüssel: Wer das alte Passwort und eine alte Kopie hat, liest nichts Neues.
        assert_ne!(*old_key, *v.key);
        assert!(Vault::open(&before, "ein neues Master-Passwort").is_ok());
        v.change_master("ein drittes Master-Passwort", "ein neues Master-Passwort")
            .unwrap();
        let bytes = v.to_bytes().unwrap();
        assert!(Vault::open(&bytes, "ein langes Master-Passwort").is_err());
        let w = Vault::open(&bytes, "ein neues Master-Passwort").unwrap();
        assert_eq!(w.entries().len(), 1);
        let mut w = w;
        w.remove(&id).unwrap();
        assert!(w.remove(&id).is_err());
        assert!(
            !KdfParams {
                m_kib: 32 * 1024,
                t: 3,
                p: 1
            }
            .acceptable()
        );
        assert!(
            !KdfParams {
                m_kib: 64 * 1024,
                t: 2,
                p: 1
            }
            .acceptable()
        );
    }
}
