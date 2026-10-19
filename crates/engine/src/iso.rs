//! ISO-9660-Abbilder (`.iso`): Dateiliste aus dem Primären Volume-Deskriptor, Inhalte als
//! zusammenhängende Bereiche – ohne Entpacken, ohne Einhängen. Windows übernimmt den
//! Download-Hinweis (Mark-of-the-Web) nicht auf Dateien in eingehängten Abbildern; deshalb
//! werden Angriffe gern so verpackt.

use std::ops::Range;

const SECTOR: usize = 2048;
/// Höchste Verzeichnistiefe.
const MAX_DEPTH: usize = 8;

/// Hat die Datei einen ISO-9660-Volume-Deskriptor?
#[must_use]
pub fn is_iso(bytes: &[u8]) -> bool {
    [0x8001usize, 0x8801, 0x9001]
        .iter()
        .any(|&o| bytes.get(o..o + 5) == Some(b"CD001"))
}

/// Eine Datei im Abbild.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IsoFile {
    /// Pfad im Abbild (mit `/`).
    pub name: String,
    /// Bereich im Abbild.
    pub range: Range<usize>,
}

fn u32_le(bytes: &[u8], at: usize) -> Option<u32> {
    bytes
        .get(at..at + 4)
        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

/// Liest die Dateiliste (höchstens `max_files` Einträge).
///
/// # Errors
/// Kein oder beschädigter Primärer Volume-Deskriptor.
pub fn files(bytes: &[u8], max_files: usize) -> Result<(Vec<IsoFile>, bool), String> {
    // Primären Volume-Deskriptor (Typ 1) ab Sektor 16 suchen.
    let mut pvd = None;
    for sector in 16..32 {
        let at = sector * SECTOR;
        match bytes.get(at..at + 6) {
            Some([1, b'C', b'D', b'0', b'0', b'1']) => {
                pvd = Some(at);
                break;
            }
            Some([255, ..]) | None => break,
            Some(_) => {}
        }
    }
    let pvd = pvd.ok_or("Kein ISO-9660-Volume-Deskriptor gefunden")?;
    let root = pvd + 156;
    let extent = u32_le(bytes, root + 2).ok_or("Abbild zu kurz")? as usize;
    let size = u32_le(bytes, root + 10).ok_or("Abbild zu kurz")? as usize;
    let mut out = Vec::new();
    let mut truncated = false;
    let mut visited = std::collections::HashSet::new();
    let mut stack = vec![(extent, size, String::new(), 0usize)];
    while let Some((extent, size, prefix, depth)) = stack.pop() {
        if !visited.insert(extent) || depth > MAX_DEPTH {
            continue;
        }
        let start = extent.saturating_mul(SECTOR);
        let end = start.saturating_add(size).min(bytes.len());
        let mut pos = start;
        while pos < end {
            let len = usize::from(bytes[pos]);
            if len == 0 {
                // Rest des Sektors ist leer – zum nächsten Sektor.
                pos = (pos / SECTOR + 1) * SECTOR;
                continue;
            }
            let Some(record) = bytes.get(pos..pos + len) else {
                break;
            };
            pos += len;
            if record.len() < 34 {
                continue;
            }
            let child_extent = u32_le(record, 2).unwrap_or(0) as usize;
            let child_size = u32_le(record, 10).unwrap_or(0) as usize;
            let is_dir = record[25] & 0x02 != 0;
            let name_len = usize::from(record[32]);
            let Some(raw) = record.get(33..33 + name_len) else {
                continue;
            };
            if raw == [0] || raw == [1] {
                continue; // „.“ und „..“
            }
            let name = String::from_utf8_lossy(raw);
            let name = name
                .split(';')
                .next()
                .unwrap_or_default()
                .trim_end_matches('.');
            let path = if prefix.is_empty() {
                name.to_owned()
            } else {
                format!("{prefix}/{name}")
            };
            if is_dir {
                stack.push((child_extent, child_size, path, depth + 1));
            } else {
                if out.len() >= max_files {
                    truncated = true;
                    break;
                }
                let begin = child_extent.saturating_mul(SECTOR);
                let range =
                    begin.min(bytes.len())..begin.saturating_add(child_size).min(bytes.len());
                out.push(IsoFile { name: path, range });
            }
        }
    }
    Ok((out, truncated))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn record(extent: u32, size: u32, dir: bool, name: &[u8]) -> Vec<u8> {
        let len = 33 + name.len() + (name.len() + 1) % 2;
        let mut r = vec![0u8; len];
        r[0] = u8::try_from(len).unwrap();
        r[2..6].copy_from_slice(&extent.to_le_bytes());
        r[6..10].copy_from_slice(&extent.to_be_bytes());
        r[10..14].copy_from_slice(&size.to_le_bytes());
        r[14..18].copy_from_slice(&size.to_be_bytes());
        r[25] = if dir { 2 } else { 0 };
        r[32] = u8::try_from(name.len()).unwrap();
        r[33..33 + name.len()].copy_from_slice(name);
        r
    }

    /// Baut ein winziges ISO-Abbild mit den angegebenen Dateien im Wurzelordner.
    pub(crate) fn build(files: &[(&str, &[u8])]) -> Vec<u8> {
        let root_sector = 20u32;
        let first_data = 21u32;
        let mut image = vec![0u8; 21 * SECTOR];
        // Primärer Volume-Deskriptor (Sektor 16) + Abschluss (Sektor 17).
        let pvd = 16 * SECTOR;
        image[pvd] = 1;
        image[pvd + 1..pvd + 6].copy_from_slice(b"CD001");
        image[pvd + 6] = 1;
        let root = record(root_sector, u32::try_from(SECTOR).unwrap(), true, &[0]);
        image[pvd + 156..pvd + 156 + root.len()].copy_from_slice(&root);
        image[17 * SECTOR] = 255;
        image[17 * SECTOR + 1..17 * SECTOR + 6].copy_from_slice(b"CD001");
        // Wurzelverzeichnis.
        let mut dir = record(root_sector, 2048, true, &[0]);
        dir.extend(record(root_sector, 2048, true, &[1]));
        let mut sector = first_data;
        let mut data = Vec::new();
        for (name, body) in files {
            let mut n = name.to_ascii_uppercase().into_bytes();
            n.extend_from_slice(b";1");
            dir.extend(record(
                sector,
                u32::try_from(body.len()).unwrap(),
                false,
                &n,
            ));
            let mut padded = body.to_vec();
            padded.resize(body.len().div_ceil(SECTOR).max(1) * SECTOR, 0);
            sector += u32::try_from(padded.len() / SECTOR).unwrap();
            data.extend(padded);
        }
        let r = root_sector as usize * SECTOR;
        image[r..r + dir.len()].copy_from_slice(&dir);
        image.extend(data);
        image
    }

    #[test]
    fn dateiliste_und_inhalt() {
        let image = build(&[("readme.txt", b"Hallo"), ("start.lnk", b"LNK")]);
        assert!(is_iso(&image));
        let (files, truncated) = files(&image, 10).unwrap();
        assert!(!truncated);
        let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["README.TXT", "START.LNK"]);
        assert_eq!(&image[files[0].range.clone()], b"Hallo");
        assert!(!is_iso(b"kein abbild"));
        assert!(super::files(&[0u8; 100], 10).is_err());
        let (some, truncated) = super::files(&image, 1).unwrap();
        assert_eq!((some.len(), truncated), (1, true));
    }
}
