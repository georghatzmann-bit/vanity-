//! Minimaler PNG-Schreiber (RGBA, 8 Bit, Filter „None“, zlib über `flate2`) für die
//! Bildschirmfotos des Labors – ohne zusätzliche Bildbibliothek.

use std::io::Write;

use flate2::Crc;
use flate2::write::ZlibEncoder;

/// Größte Kantenlänge.
pub const MAX_EDGE: u32 = 4096;

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&u32::try_from(data.len()).unwrap_or(0).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc = Crc::new();
    crc.update(kind);
    crc.update(data);
    out.extend_from_slice(&crc.sum().to_be_bytes());
}

/// Kodiert ein BGRA-Bild (Zeilen von oben nach unten) als PNG; Alpha wird auf deckend gesetzt.
///
/// # Errors
/// Falsche Puffergröße oder zu großes Bild.
pub fn encode_bgra(width: u32, height: u32, bgra: &[u8]) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 || width > MAX_EDGE || height > MAX_EDGE {
        return Err("ungültige Bildgröße".into());
    }
    let row = usize::try_from(width).unwrap_or(0) * 4;
    if bgra.len() != row * usize::try_from(height).unwrap_or(0) {
        return Err("Puffergröße passt nicht zum Bild".into());
    }
    let mut raw = Vec::with_capacity(bgra.len() + usize::try_from(height).unwrap_or(0));
    for line in bgra.chunks_exact(row) {
        raw.push(0); // Filter: None
        for px in line.chunks_exact(4) {
            raw.extend_from_slice(&[px[2], px[1], px[0], 255]);
        }
    }
    let mut z = ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
    z.write_all(&raw).map_err(|e| e.to_string())?;
    let idat = z.finish().map_err(|e| e.to_string())?;
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8 Bit, RGBA, Deflate, Filter 0, ohne Interlace
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &idat);
    chunk(&mut out, b"IEND", &[]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn gueltiges_png() {
        // 2×1: blau, rot (BGRA).
        let png = encode_bgra(2, 1, &[255, 0, 0, 0, 0, 0, 255, 0]).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(&png[12..16], b"IHDR");
        assert!(png.ends_with(&[0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]));
        // IDAT entpacken: Filterbyte + RGBA.
        let idat_len = u32::from_be_bytes([png[33], png[34], png[35], png[36]]) as usize;
        let idat = &png[41..41 + idat_len];
        let mut raw = Vec::new();
        flate2::read::ZlibDecoder::new(idat)
            .read_to_end(&mut raw)
            .unwrap();
        assert_eq!(raw, [0, 0, 0, 255, 255, 255, 0, 0, 255]);
        assert!(encode_bgra(2, 2, &[0; 8]).is_err());
        assert!(encode_bgra(0, 1, &[]).is_err());
    }
}
