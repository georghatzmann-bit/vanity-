//! Interne Hilfen: kanonische Binärkodierung (für Prüfsummen) und Hex-Darstellung.
//!
//! Die Kodierung ist bewusst simpel und eindeutig: Jedes Element beginnt mit einem
//! Typ-Byte; Zeichenketten tragen ihre Länge (u64, Big Endian) vorweg, Zahlen haben feste
//! Breite. Listen schreiben zuerst ihre Länge. Damit können zwei verschiedene Werte nie
//! dieselbe Bytefolge ergeben (keine Mehrdeutigkeit durch Trennzeichen, keine
//! Abhängigkeit von JSON-Formatierung oder `HashMap`-Reihenfolge).

use sha2::{Digest, Sha256};

const TAG_DOMAIN: u8 = 0x00;
const TAG_FIELD: u8 = 0x01;
const TAG_STR: u8 = 0x02;
const TAG_U64: u8 = 0x03;
const TAG_I128: u8 = 0x04;
const TAG_BYTES: u8 = 0x05;

/// Baut die kanonische Bytefolge eines Werts auf.
#[derive(Debug)]
pub(crate) struct CanonicalWriter {
    buf: Vec<u8>,
}

impl CanonicalWriter {
    /// Beginnt eine neue Kodierung mit einer Domänen-Kennung (z. B. `AEGIS-ACTIONPLAN-V1`),
    /// damit Prüfsummen verschiedener Typen nie verwechselt werden können.
    pub(crate) fn new(domain: &str) -> Self {
        let mut writer = Self {
            buf: Vec::with_capacity(256),
        };
        writer.buf.push(TAG_DOMAIN);
        writer.raw_str(domain);
        writer
    }

    fn raw_str(&mut self, value: &str) {
        self.raw_bytes(value.as_bytes());
    }

    fn raw_bytes(&mut self, value: &[u8]) {
        // `usize` passt auf allen unterstützten Plattformen in `u64`.
        let len = u64::try_from(value.len()).unwrap_or(u64::MAX);
        self.buf.extend_from_slice(&len.to_be_bytes());
        self.buf.extend_from_slice(value);
    }

    /// Feldname (macht die Kodierung selbstbeschreibend und reihenfolgefest).
    pub(crate) fn field(&mut self, name: &str) {
        self.buf.push(TAG_FIELD);
        self.raw_str(name);
    }

    pub(crate) fn str(&mut self, value: &str) {
        self.buf.push(TAG_STR);
        self.raw_str(value);
    }

    pub(crate) fn bytes(&mut self, value: &[u8]) {
        self.buf.push(TAG_BYTES);
        self.raw_bytes(value);
    }

    pub(crate) fn u64(&mut self, value: u64) {
        self.buf.push(TAG_U64);
        self.buf.extend_from_slice(&value.to_be_bytes());
    }

    /// Länge einer Liste (vor den Elementen geschrieben).
    pub(crate) fn len(&mut self, len: usize) {
        self.u64(u64::try_from(len).unwrap_or(u64::MAX));
    }

    pub(crate) fn i128(&mut self, value: i128) {
        self.buf.push(TAG_I128);
        self.buf.extend_from_slice(&value.to_be_bytes());
    }

    pub(crate) fn into_bytes(self) -> Vec<u8> {
        self.buf
    }
}

/// SHA-256 über beliebige Bytes.
pub(crate) fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

/// SHA-256 über mehrere Teile hintereinander (ohne Zwischenpuffer).
pub(crate) fn sha256_parts(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

const HEX: &[u8; 16] = b"0123456789abcdef";

/// Kleinbuchstaben-Hex-Darstellung.
pub(crate) fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(HEX[usize::from(byte >> 4)]));
        out.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    out
}

/// Liest genau 64 Kleinbuchstaben-Hex-Zeichen (kanonisch, keine Großbuchstaben).
pub(crate) fn parse_hex32(text: &str) -> Option<[u8; 32]> {
    fn nibble(c: u8) -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            _ => None,
        }
    }
    let (pairs, rest) = text.as_bytes().as_chunks::<2>();
    if pairs.len() != 32 || !rest.is_empty() {
        return None;
    }
    let mut out = [0u8; 32];
    for (slot, [hi, lo]) in out.iter_mut().zip(pairs) {
        *slot = (nibble(*hi)? << 4) | nibble(*lo)?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_roundtrip() {
        let mut bytes = [0u8; 32];
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = u8::try_from(i * 8 + 3).unwrap();
        }
        let text = hex_lower(&bytes);
        assert_eq!(text.len(), 64);
        assert_eq!(parse_hex32(&text), Some(bytes));
    }

    #[test]
    fn hex_rejects_non_canonical() {
        let upper = "AB".repeat(32);
        assert_eq!(parse_hex32(&upper), None);
        assert_eq!(parse_hex32("ab"), None);
        assert_eq!(parse_hex32(&"zz".repeat(32)), None);
        assert_eq!(parse_hex32(&"ab".repeat(33)), None);
        assert_eq!(parse_hex32(&format!("{}a", "ab".repeat(32))), None);
        // Mehrbyte-Zeichen mit passender Byte-Länge
        let tricky = format!("{}ä", "a".repeat(62));
        assert_eq!(tricky.len(), 64);
        assert_eq!(parse_hex32(&tricky), None);
    }

    #[test]
    fn sha256_known_vector() {
        assert_eq!(
            hex_lower(&sha256(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(sha256_parts(&[b"a", b"bc"]), sha256(b"abc"));
    }

    #[test]
    fn encoding_is_unambiguous() {
        // ("ab", "c") darf nicht wie ("a", "bc") kodiert werden.
        let mut w1 = CanonicalWriter::new("T");
        w1.str("ab");
        w1.str("c");
        let mut w2 = CanonicalWriter::new("T");
        w2.str("a");
        w2.str("bc");
        assert_ne!(w1.into_bytes(), w2.into_bytes());

        // Unterschiedliche Domänen ergeben unterschiedliche Kodierungen.
        let mut d1 = CanonicalWriter::new("A");
        d1.u64(1);
        let mut d2 = CanonicalWriter::new("B");
        d2.u64(1);
        assert_ne!(d1.into_bytes(), d2.into_bytes());

        // Typ-Bytes trennen Zahl und Zeichenkette.
        let mut t1 = CanonicalWriter::new("T");
        t1.field("x");
        t1.bytes(&[1, 2]);
        t1.len(2);
        t1.i128(-1);
        let mut t2 = CanonicalWriter::new("T");
        t2.field("x");
        t2.str("\u{1}\u{2}");
        t2.len(2);
        t2.i128(-1);
        assert_ne!(t1.into_bytes(), t2.into_bytes());
    }
}
