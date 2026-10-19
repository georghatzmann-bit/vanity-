//! EICAR-Testdatei: ein harmloser, weltweit vereinbarter Prüfstandard für Virenscanner.
//!
//! Die Zeichenkette steht absichtlich **nicht** am Stück im Quelltext (sonst meldet
//! Windows Defender schon die Quelldatei); sie wird zur Laufzeit zusammengesetzt.

const PARTS: [&str; 4] = [
    r"X5O!P%@AP[4\PZX54(P^)7CC)7}$",
    "EICAR-STANDARD-",
    "ANTIVIRUS-TEST-",
    "FILE!$H+H*",
];

/// Die 68 Byte der EICAR-Zeichenkette.
#[must_use]
pub fn signature() -> Vec<u8> {
    PARTS.concat().into_bytes()
}

/// Erkennt die EICAR-Datei nach der offiziellen Regel: Die Datei beginnt mit der
/// Zeichenkette, danach folgen höchstens Leerraum-Zeichen, Gesamtlänge ≤ 128 Byte.
#[must_use]
pub fn is_eicar(bytes: &[u8]) -> bool {
    let sig = signature();
    bytes.len() <= 128
        && bytes.starts_with(&sig)
        && bytes[sig.len()..]
            .iter()
            .all(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n' | 0x1a))
}

/// Kommt die EICAR-Zeichenkette irgendwo vor (Speicher-Scan)?
#[must_use]
pub fn occurs_in(bytes: &[u8]) -> bool {
    let sig = signature();
    bytes.windows(sig.len()).any(|w| w == sig.as_slice())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn erkennt_nur_den_standard() {
        let sig = signature();
        assert_eq!(sig.len(), 68);
        assert!(is_eicar(&sig));
        let mut with_newline = sig.clone();
        with_newline.extend_from_slice(b"\r\n");
        assert!(is_eicar(&with_newline));
        let mut with_text = sig.clone();
        with_text.extend_from_slice(b"x");
        assert!(!is_eicar(&with_text));
        assert!(!is_eicar(&sig[1..]));
        assert!(!is_eicar(b""));
        assert_eq!(sig, aegis_core::testing::eicar());
        let mut memory = vec![0u8; 100];
        memory.extend_from_slice(&sig);
        memory.extend_from_slice(&[0u8; 50]);
        assert!(occurs_in(&memory));
        assert!(!occurs_in(&memory[..120]));
    }
}
