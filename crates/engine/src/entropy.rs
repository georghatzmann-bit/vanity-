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

#[cfg(test)]
mod tests {
    use super::shannon;

    #[test]
    fn grenzen() {
        assert!(shannon(&[]).abs() < f64::EPSILON);
        assert!(shannon(&[7; 1000]).abs() < f64::EPSILON);
        let all: Vec<u8> = (0..=255u8).collect();
        assert!((shannon(&all) - 8.0).abs() < 1e-9);
        assert!((shannon(b"abab") - 1.0).abs() < 1e-9);
    }
}
