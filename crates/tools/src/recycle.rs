//! Papierkorb von Windows: Begleitdateien `$I…` lesen (Originalpfad, Löschzeit), um eine eben
//! in den Papierkorb gelegte Datei für „Rückgängig“ wiederzufinden.

use std::path::PathBuf;

/// Inhalt einer `$I…`-Datei.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InfoFile {
    /// Ursprünglicher Pfad.
    pub original: PathBuf,
    /// Größe der Datei.
    pub size: u64,
    /// Löschzeit (FILETIME).
    pub deleted: u64,
}

fn u64_at(bytes: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_le_bytes(bytes.get(at..at + 8)?.try_into().ok()?))
}

fn utf16(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .take_while(|u| *u != 0)
        .collect();
    String::from_utf16_lossy(&units)
}

/// Liest eine `$I…`-Datei (Version 1: Windows Vista–8, Version 2: ab Windows 10).
#[must_use]
pub fn parse_info(bytes: &[u8]) -> Option<InfoFile> {
    let version = u64_at(bytes, 0)?;
    let size = u64_at(bytes, 8)?;
    let deleted = u64_at(bytes, 16)?;
    let path = match version {
        1 => utf16(bytes.get(24..24 + 520)?),
        2 => {
            let chars = usize::try_from(u32::from_le_bytes(bytes.get(24..28)?.try_into().ok()?))
                .ok()?
                .min(32_768);
            utf16(bytes.get(28..28 + chars * 2)?)
        }
        _ => return None,
    };
    (!path.is_empty()).then(|| InfoFile {
        original: PathBuf::from(path),
        size,
        deleted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v2(path: &str) -> Vec<u8> {
        let units: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let mut b = Vec::new();
        b.extend_from_slice(&2u64.to_le_bytes());
        b.extend_from_slice(&5u64.to_le_bytes());
        b.extend_from_slice(&7u64.to_le_bytes());
        b.extend_from_slice(&u32::try_from(units.len()).unwrap().to_le_bytes());
        for u in units {
            b.extend_from_slice(&u.to_le_bytes());
        }
        b
    }

    #[test]
    fn begleitdateien() {
        let info = parse_info(&v2(r"C:\Users\anna\Downloads\x.zip")).unwrap();
        assert_eq!(
            info.original,
            PathBuf::from(r"C:\Users\anna\Downloads\x.zip")
        );
        assert_eq!((info.size, info.deleted), (5, 7));
        let mut v1 = Vec::new();
        v1.extend_from_slice(&1u64.to_le_bytes());
        v1.extend_from_slice(&9u64.to_le_bytes());
        v1.extend_from_slice(&3u64.to_le_bytes());
        let mut name: Vec<u8> = "C:\\a.txt"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        name.resize(520, 0);
        v1.extend_from_slice(&name);
        assert_eq!(
            parse_info(&v1).unwrap().original,
            PathBuf::from("C:\\a.txt")
        );
        assert!(parse_info(b"kurz").is_none());
        assert!(parse_info(&[9u8; 40]).is_none());
    }
}
