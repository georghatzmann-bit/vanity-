//! Shannon-Entropie (Bit je Byte, 0–8): Werte nahe 8 deuten auf verschlüsselte oder
//! gepackte Daten hin – viele frisch geschriebene Dateien mit hoher Entropie sind ein
//! typisches Zeichen von Ransomware.

use std::io::{self, Read};
use std::path::Path;

/// Höchstens so viele Byte werden je Datei betrachtet.
pub const SAMPLE_BYTES: u64 = 1024 * 1024;
/// Ab dieser Entropie gilt eine Datei als „wie verschlüsselt“.
pub const HIGH: f64 = 7.5;

/// Entropie eines Puffers.
#[must_use]
pub fn of_bytes(data: &[u8]) -> f64 {
    if data.is_empty() {
        return 0.0;
    }
    let mut counts = [0u64; 256];
    for &b in data {
        counts[usize::from(b)] += 1;
    }
    #[allow(clippy::cast_precision_loss)]
    let len = data.len() as f64;
    counts
        .iter()
        .filter(|&&c| c > 0)
        .map(|&c| {
            #[allow(clippy::cast_precision_loss)]
            let p = c as f64 / len;
            -p * p.log2()
        })
        .sum()
}

/// Entropie der ersten [`SAMPLE_BYTES`] einer Datei (nur lesend).
///
/// # Errors
/// Datei nicht lesbar.
pub fn of_file(path: &Path) -> io::Result<f64> {
    let mut data = Vec::new();
    std::fs::File::open(path)?
        .take(SAMPLE_BYTES)
        .read_to_end(&mut data)?;
    Ok(of_bytes(&data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grenzen() {
        assert!(of_bytes(&[]).abs() < f64::EPSILON);
        assert!(of_bytes(&[7; 1000]).abs() < f64::EPSILON);
        let all: Vec<u8> = (0..=255u8).cycle().take(256 * 64).collect();
        assert!((of_bytes(&all) - 8.0).abs() < 1e-9);
        let text = b"Hallo Welt, das ist ein ganz normaler Text.".repeat(20);
        assert!(of_bytes(&text) < 5.0);
    }
}
