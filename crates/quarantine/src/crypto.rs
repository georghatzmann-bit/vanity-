//! Container-Format der Quarantäne: AES-256-GCM in Blöcken (gestreamt, beliebig groß).
//!
//! ```text
//! Kopf (20 Byte): "AEGISQ01" | Nonce-Präfix (7) | Blockgröße u32 BE | reserviert (1)
//! Blöcke:        Chiffretext + 16-Byte-Tag, je bis zur Blockgröße Klartext
//! Nonce je Block: Präfix (7) | Zähler u32 BE | Letzter-Block-Flag (1)
//! AAD:            der vollständige Kopf
//! ```
//! Der letzte Block trägt das Flag 1 – so fällt ein abgeschnittener Container auf; der
//! Zähler verhindert Vertauschen, der Kopf als AAD das Austauschen der Blockgröße.

use std::io::{self, Read, Write};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

/// Formatkennung.
pub const MAGIC: &[u8; 8] = b"AEGISQ01";
/// Länge des Kopfes.
pub const HEADER_LEN: usize = 20;
/// Standard-Blockgröße (1 MiB).
pub const DEFAULT_CHUNK: u32 = 1024 * 1024;
const TAG_LEN: usize = 16;

/// Schlüssel (wird beim Verwerfen überschrieben).
pub type Key = Zeroizing<[u8; 32]>;

/// Fehler beim Ver- oder Entschlüsseln.
#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    /// Lese-/Schreibfehler.
    #[error("Ein-/Ausgabefehler: {0}")]
    Io(#[from] io::Error),
    /// Kein AEGIS-Container oder unbekannte Version.
    #[error("Kein gültiger Quarantäne-Container")]
    BadHeader,
    /// Authentifizierung fehlgeschlagen (manipuliert, falscher Schlüssel, abgeschnitten).
    #[error("Container ist beschädigt oder manipuliert")]
    Tampered,
    /// Zufallsquelle des Systems nicht verfügbar.
    #[error("Zufallsquelle nicht verfügbar")]
    Random,
}

/// Erzeugt einen neuen Zufallsschlüssel.
///
/// # Errors
/// Zufallsquelle nicht verfügbar.
pub fn new_key() -> Result<Key, CryptoError> {
    let mut key = Zeroizing::new([0u8; 32]);
    getrandom::fill(key.as_mut()).map_err(|_| CryptoError::Random)?;
    Ok(key)
}

fn nonce(prefix: &[u8; 7], counter: u32, last: bool) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[..7].copy_from_slice(prefix);
    n[7..11].copy_from_slice(&counter.to_be_bytes());
    n[11] = u8::from(last);
    n
}

fn read_full<R: Read>(r: &mut R, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match r.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

/// Verschlüsselt `input` nach `output`. Liefert SHA-256 und Länge des **Klartexts**.
///
/// # Errors
/// Ein-/Ausgabefehler oder fehlende Zufallsquelle.
pub fn encrypt<R: Read, W: Write>(
    key: &Key,
    mut input: R,
    mut output: W,
    chunk: u32,
) -> Result<([u8; 32], u64), CryptoError> {
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| CryptoError::BadHeader)?;
    let mut prefix = [0u8; 7];
    getrandom::fill(&mut prefix).map_err(|_| CryptoError::Random)?;
    let mut header = [0u8; HEADER_LEN];
    header[..8].copy_from_slice(MAGIC);
    header[8..15].copy_from_slice(&prefix);
    header[15..19].copy_from_slice(&chunk.to_be_bytes());
    output.write_all(&header)?;

    let size = usize::try_from(chunk).map_err(|_| CryptoError::BadHeader)?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut current = Zeroizing::new(vec![0u8; size]);
    let mut next = Zeroizing::new(vec![0u8; size]);
    let mut current_len = read_full(&mut input, &mut current)?;
    let mut counter = 0u32;
    loop {
        // Vorauslesen, um den letzten Block zu erkennen.
        let next_len = if current_len == size {
            read_full(&mut input, &mut next)?
        } else {
            0
        };
        let last = next_len == 0;
        let plain = &current[..current_len];
        hasher.update(plain);
        total = total.saturating_add(plain.len() as u64);
        let sealed = cipher
            .encrypt(
                &Nonce::from(nonce(&prefix, counter, last)),
                Payload {
                    msg: plain,
                    aad: &header,
                },
            )
            .map_err(|_| CryptoError::Tampered)?;
        output.write_all(&sealed)?;
        if last {
            break;
        }
        counter = counter.checked_add(1).ok_or(CryptoError::BadHeader)?;
        std::mem::swap(&mut current, &mut next);
        current_len = next_len;
    }
    output.flush()?;
    Ok((hasher.finalize().into(), total))
}

/// Entschlüsselt und prüft einen Container. Schreibt den Klartext nach `output`
/// (`io::sink()` für reine Prüfung). Liefert SHA-256 und Länge des Klartexts.
///
/// Hinweis: Bei einem Fehler kann `output` bereits einen Teil enthalten – Aufrufer schreiben
/// deshalb in eine temporäre Datei und übernehmen sie erst nach Erfolg.
///
/// # Errors
/// [`CryptoError::Tampered`] bei jeder Manipulation, [`CryptoError::BadHeader`] bei
/// fremden Dateien.
pub fn decrypt<R: Read, W: Write>(
    key: &Key,
    mut input: R,
    mut output: W,
) -> Result<([u8; 32], u64), CryptoError> {
    let cipher = Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| CryptoError::BadHeader)?;
    let mut header = [0u8; HEADER_LEN];
    if read_full(&mut input, &mut header)? != HEADER_LEN || &header[..8] != MAGIC || header[19] != 0
    {
        return Err(CryptoError::BadHeader);
    }
    let mut prefix = [0u8; 7];
    prefix.copy_from_slice(&header[8..15]);
    let chunk = u32::from_be_bytes([header[15], header[16], header[17], header[18]]);
    if chunk == 0 || chunk > 64 * 1024 * 1024 {
        return Err(CryptoError::BadHeader);
    }
    let sealed_len = usize::try_from(chunk).map_err(|_| CryptoError::BadHeader)? + TAG_LEN;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut current = vec![0u8; sealed_len];
    let mut next = vec![0u8; sealed_len];
    let mut current_len = read_full(&mut input, &mut current)?;
    let mut counter = 0u32;
    loop {
        if current_len < TAG_LEN {
            return Err(CryptoError::Tampered);
        }
        let next_len = if current_len == sealed_len {
            read_full(&mut input, &mut next)?
        } else {
            0
        };
        let last = next_len == 0;
        let plain = Zeroizing::new(
            cipher
                .decrypt(
                    &Nonce::from(nonce(&prefix, counter, last)),
                    Payload {
                        msg: &current[..current_len],
                        aad: &header,
                    },
                )
                .map_err(|_| CryptoError::Tampered)?,
        );
        hasher.update(plain.as_slice());
        total = total.saturating_add(plain.len() as u64);
        output.write_all(&plain)?;
        if last {
            break;
        }
        counter = counter.checked_add(1).ok_or(CryptoError::Tampered)?;
        std::mem::swap(&mut current, &mut next);
        current_len = next_len;
    }
    output.flush()?;
    Ok((hasher.finalize().into(), total))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(data: &[u8], chunk: u32) {
        let key = new_key().unwrap();
        let mut sealed = Vec::new();
        let (h1, n1) = encrypt(&key, data, &mut sealed, chunk).unwrap();
        let mut plain = Vec::new();
        let (h2, n2) = decrypt(&key, sealed.as_slice(), &mut plain).unwrap();
        assert_eq!(plain, data);
        assert_eq!((h1, n1), (h2, n2));
        assert_eq!(n1, data.len() as u64);
    }

    #[test]
    fn rundweg_auch_an_blockgrenzen() {
        for len in [0usize, 1, 15, 16, 17, 32, 33, 1000] {
            let data: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
            roundtrip(&data, 16);
        }
        roundtrip(b"klein", DEFAULT_CHUNK);
    }

    #[test]
    fn manipulation_wird_erkannt() {
        let key = new_key().unwrap();
        let data: Vec<u8> = (0..100u8).collect();
        let mut sealed = Vec::new();
        encrypt(&key, data.as_slice(), &mut sealed, 16).unwrap();
        let check = |bytes: &[u8]| decrypt(&key, bytes, io::sink());

        // Ein Bit im Chiffretext.
        let mut flipped = sealed.clone();
        flipped[HEADER_LEN + 3] ^= 1;
        assert!(matches!(check(&flipped), Err(CryptoError::Tampered)));
        // Abgeschnitten nach vollen Blöcken (letzter Block fehlt).
        let cut = &sealed[..HEADER_LEN + 2 * (16 + TAG_LEN)];
        assert!(matches!(check(cut), Err(CryptoError::Tampered)));
        // Blöcke vertauscht.
        let mut swapped = sealed.clone();
        let a = HEADER_LEN..HEADER_LEN + 32;
        let b = HEADER_LEN + 32..HEADER_LEN + 64;
        let (x, y) = (sealed[a.clone()].to_vec(), sealed[b.clone()].to_vec());
        swapped[a].copy_from_slice(&y);
        swapped[b].copy_from_slice(&x);
        assert!(matches!(check(&swapped), Err(CryptoError::Tampered)));
        // Blockgröße im Kopf geändert (AAD).
        let mut header = sealed.clone();
        header[18] = 32;
        assert!(check(&header).is_err());
        // Falscher Schlüssel.
        let other = new_key().unwrap();
        assert!(matches!(
            decrypt(&other, sealed.as_slice(), io::sink()),
            Err(CryptoError::Tampered)
        ));
        // Fremde Datei.
        assert!(matches!(
            check(b"MZ das ist kein Container"),
            Err(CryptoError::BadHeader)
        ));
        // Unverändert ok.
        assert!(check(&sealed).is_ok());
    }
}
