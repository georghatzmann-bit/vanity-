//! Prüfsummen über beliebig große Dateien (gestreamt).

use std::io::{self, Read};

use sha2::{Digest, Sha256};

/// SHA-256 und Länge eines Datenstroms.
///
/// # Errors
/// Lesefehler des Datenstroms.
pub fn sha256_reader<R: Read>(mut reader: R) -> io::Result<([u8; 32], u64)> {
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        hasher.update(&buf[..n]);
        total = total.saturating_add(n as u64);
    }
    Ok((hasher.finalize().into(), total))
}

/// SHA-256 als Kleinbuchstaben-Hex.
#[must_use]
pub fn to_hex(hash: &[u8; 32]) -> String {
    use std::fmt::Write as _;
    hash.iter().fold(String::with_capacity(64), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// Liest einen 64-stelligen Hex-SHA-256 (Groß/Klein egal).
#[must_use]
pub fn from_hex(text: &str) -> Option<[u8; 32]> {
    let text = text.trim();
    if text.len() != 64 || !text.is_ascii() {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, chunk) in text.as_bytes().chunks(2).enumerate() {
        let pair = std::str::from_utf8(chunk).ok()?;
        out[i] = u8::from_str_radix(pair, 16).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bekannter_wert_und_hex_rundweg() {
        let (h, n) = sha256_reader(&b"abc"[..]).unwrap();
        assert_eq!(n, 3);
        let hex = to_hex(&h);
        assert_eq!(
            hex,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(from_hex(&hex.to_uppercase()), Some(h));
        assert_eq!(from_hex("zz"), None);
        assert_eq!(from_hex(&"g".repeat(64)), None);
    }
}
