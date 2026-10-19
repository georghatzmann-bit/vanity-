//! Shannon-Entropie (0,0 – 8,0 Bit pro Byte). Hohe Werte deuten auf gepackte oder
//! verschlüsselte Daten hin – allein aber kein Beweis für Schadcode.

/// Entropie der Bytes in Bit pro Byte; leere Eingabe ergibt 0.
#[must_use]
pub fn shannon(bytes: &[u8]) -> f64 {
    if bytes.is_empty() {
        return 0.0;
    }
    let mut counts = [0u64; 256];
    for &b in bytes {
        counts[usize::from(b)] += 1;
    }
    #[allow(clippy::cast_precision_loss)]
    let len = bytes.len() as f64;
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

/// Größe der Stichprobe am Dateianfang.
pub const SAMPLE_BYTES: u64 = 64 * 1024;
/// Kleinere Dateien sagen über die Entropie zu wenig aus.
pub const MIN_SAMPLE_BYTES: usize = 4096;

/// Entropie der ersten [`SAMPLE_BYTES`] einer Datei (nur lesen); `None` bei zu kleinen oder
/// nicht lesbaren Dateien. Für die Ransomware-Erkennung: verschlüsselte Inhalte liegen nahe 8.
#[must_use]
pub fn sample_file(path: &std::path::Path) -> Option<f64> {
    use std::io::Read as _;
    let file = std::fs::File::open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut data = Vec::new();
    file.take(SAMPLE_BYTES).read_to_end(&mut data).ok()?;
    (data.len() >= MIN_SAMPLE_BYTES).then(|| shannon(&data))
}

#[cfg(test)]
mod tests {
    use super::{sample_file, shannon};

    #[test]
    fn stichprobe() {
        let dir = tempfile::tempdir().unwrap();
        let text = aegis_core::testing::write_fixture(
            dir.path(),
            "brief.txt",
            "Sehr geehrte Damen und Herren, ".repeat(400).as_bytes(),
        )
        .unwrap();
        assert!(sample_file(&text).unwrap() < 5.0);
        let mut noise = Vec::with_capacity(65536);
        let mut x: u32 = 2_463_534_242;
        for _ in 0..65536 {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            noise.push(x.to_le_bytes()[0]);
        }
        let enc =
            aegis_core::testing::write_fixture(dir.path(), "brief.txt.locked", &noise).unwrap();
        assert!(sample_file(&enc).unwrap() > 7.5);
        let small = aegis_core::testing::write_fixture(dir.path(), "klein.txt", b"kurz").unwrap();
        assert_eq!(sample_file(&small), None);
        assert_eq!(sample_file(dir.path()), None);
    }

    #[test]
    fn grenzen() {
        assert!(shannon(&[]).abs() < f64::EPSILON);
        assert!(shannon(&[7; 1000]).abs() < f64::EPSILON);
        let all: Vec<u8> = (0..=255u8).collect();
        assert!((shannon(&all) - 8.0).abs() < 1e-9);
        assert!((shannon(b"abab") - 1.0).abs() < 1e-9);
    }
}
