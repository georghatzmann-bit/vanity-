//! JSON manifests (Fortnite up to 17.21).
//!
//! Ported from Legendary, `legendary/models/json_manifest.py` (GPL-3.0-or-later,
//! <https://github.com/derrod/legendary>). Numbers are stored as "blobs": three decimal digits per
//! byte, little-endian ("013000000000" = 13).

use serde_json::{Map, Value};

use super::manifest::{ChunkInfo, ChunkPart, FileEntry, Guid, Manifest, ManifestError, ManifestFormat};

/// Chunks of JSON manifests are always 1 MiB unpacked.
const JSON_WINDOW_SIZE: u32 = 1024 * 1024;

fn corrupt(what: impl Into<String>) -> ManifestError {
    ManifestError::Corrupt(what.into())
}

/// "013000000000" → [13, 0, 0, 0]
pub(crate) fn blob_bytes(s: &str) -> Result<Vec<u8>, ManifestError> {
    if s.len() % 3 != 0 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(corrupt(format!("bad number '{s}'")));
    }
    s.as_bytes()
        .chunks(3)
        .map(|c| {
            let n: u32 = std::str::from_utf8(c).unwrap().parse().unwrap();
            u8::try_from(n).map_err(|_| corrupt(format!("bad number '{s}'")))
        })
        .collect()
}

/// A blob as a number (at most 8 bytes; longer blobs must be zero above that).
pub(crate) fn blob_u64(s: &str) -> Result<u64, ManifestError> {
    let bytes = blob_bytes(s)?;
    if bytes.iter().skip(8).any(|&b| b != 0) {
        return Err(corrupt(format!("number too big '{s}'")));
    }
    Ok(bytes.iter().take(8).enumerate().fold(0u64, |n, (i, &b)| n | (b as u64) << (8 * i)))
}

/// "00112233445566778899AABBCCDDEEFF" → four big-endian 32-bit numbers.
pub(crate) fn guid_from_json(s: &str) -> Result<Guid, ManifestError> {
    if s.len() != 32 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(corrupt(format!("bad GUID '{s}'")));
    }
    let mut g = [0u32; 4];
    for (i, part) in g.iter_mut().enumerate() {
        *part = u32::from_str_radix(&s[i * 8..i * 8 + 8], 16).unwrap();
    }
    Ok(g)
}

fn sha1_from_hex(s: &str) -> Result<[u8; 20], ManifestError> {
    if s.len() != 40 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(corrupt(format!("bad SHA-1 '{s}'")));
    }
    let mut out = [0u8; 20];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
    }
    Ok(out)
}

fn text<'a>(obj: &'a Map<String, Value>, key: &str) -> &'a str {
    obj.get(key).and_then(Value::as_str).unwrap_or("")
}

fn blob_field(obj: &Map<String, Value>, key: &str) -> Result<u64, ManifestError> {
    blob_u64(obj.get(key).and_then(Value::as_str).ok_or_else(|| corrupt(format!("'{key}' missing")))?)
}

fn object<'a>(obj: &'a Map<String, Value>, key: &str) -> Result<&'a Map<String, Value>, ManifestError> {
    obj.get(key).and_then(Value::as_object).ok_or_else(|| corrupt(format!("'{key}' missing")))
}

pub(crate) fn parse(data: &[u8]) -> Result<Manifest, ManifestError> {
    let root: Value = serde_json::from_slice(data).map_err(|e| ManifestError::Json(e.to_string()))?;
    let obj = root.as_object().ok_or_else(|| ManifestError::Json("not an object".into()))?;

    let feature_level = match obj.get("ManifestFileVersion").and_then(Value::as_str) {
        Some(s) => blob_u64(s)?,
        None => 13,
    };
    let feature_level = u32::try_from(feature_level).map_err(|_| corrupt("feature level"))?;

    // --- chunk list: four objects keyed by the GUID (JSONCDL.read) ---
    let sizes = object(obj, "ChunkFilesizeList")?;
    let hashes = object(obj, "ChunkHashList")?;
    let groups = object(obj, "DataGroupList")?;
    let shas = obj.get("ChunkShaList").and_then(Value::as_object);
    let mut chunks = Vec::with_capacity(sizes.len());
    for (key, size) in sizes {
        let guid = guid_from_json(key)?;
        let size = size.as_str().ok_or_else(|| corrupt("chunk size"))?;
        let group = blob_field(groups, key)?;
        chunks.push(ChunkInfo {
            guid,
            hash: blob_field(hashes, key)?,
            sha1: match shas.and_then(|m| m.get(key)).and_then(Value::as_str) {
                Some(s) => Some(sha1_from_hex(s)?),
                None => None,
            },
            group: u8::try_from(group).map_err(|_| corrupt("chunk group"))?,
            window_size: JSON_WINDOW_SIZE,
            file_size: blob_u64(size)?,
        });
    }

    // --- file list (JSONFML.read) ---
    let list = obj
        .get("FileManifestList")
        .and_then(Value::as_array)
        .ok_or_else(|| corrupt("'FileManifestList' missing"))?;
    let mut files = Vec::with_capacity(list.len());
    for f in list {
        let f = f.as_object().ok_or_else(|| corrupt("file entry"))?;
        let hash = blob_bytes(f.get("FileHash").and_then(Value::as_str).ok_or_else(|| corrupt("'FileHash' missing"))?)?;
        if hash.len() > 20 && hash[20..].iter().any(|&b| b != 0) {
            return Err(corrupt("file hash too long"));
        }
        let mut sha1 = [0u8; 20];
        for (i, b) in hash.iter().take(20).enumerate() {
            sha1[i] = *b;
        }
        let install_tags = f
            .get("InstallTags")
            .and_then(Value::as_array)
            .map(|tags| tags.iter().filter_map(|t| t.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let mut parts = Vec::new();
        for p in f.get("FileChunkParts").and_then(Value::as_array).ok_or_else(|| corrupt("'FileChunkParts' missing"))? {
            let p = p.as_object().ok_or_else(|| corrupt("chunk part"))?;
            parts.push(ChunkPart {
                guid: guid_from_json(text(p, "Guid"))?,
                offset: u32::try_from(blob_field(p, "Offset")?).map_err(|_| corrupt("part offset"))?,
                size: u32::try_from(blob_field(p, "Size")?).map_err(|_| corrupt("part size"))?,
            });
        }
        files.push(FileEntry { path: text(f, "Filename").to_string(), sha1, install_tags, parts });
    }

    Ok(Manifest::new(
        ManifestFormat::Json,
        feature_level,
        text(obj, "AppNameString").to_string(),
        text(obj, "BuildVersionString").to_string(),
        text(obj, "LaunchExeString").to_string(),
        chunks,
        files,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blobs() {
        assert_eq!(blob_u64("013000000000").unwrap(), 13);
        assert_eq!(blob_u64("000000016000").unwrap(), 1 << 20);
        assert_eq!(blob_u64("000016000000").unwrap(), 4096);
        assert_eq!(blob_u64("255255255255255255255255").unwrap(), u64::MAX);
        assert_eq!(blob_u64("").unwrap(), 0);
        assert!(blob_u64("01300000000").is_err());
        assert!(blob_u64("256000").is_err());
        assert!(blob_u64("0a1").is_err());
        assert_eq!(blob_u64("001000000000000000000000000").unwrap(), 1);
        assert!(blob_u64("000000000000000000000000001").is_err());
        assert_eq!(blob_bytes("001002003").unwrap(), vec![1, 2, 3]);
    }

    #[test]
    fn guids() {
        assert_eq!(
            guid_from_json("00112233445566778899AABBCCDDEEFF").unwrap(),
            [0x00112233, 0x44556677, 0x8899AABB, 0xCCDDEEFF]
        );
        assert!(guid_from_json("0011").is_err());
        assert!(guid_from_json("XX112233445566778899AABBCCDDEEFF").is_err());
    }
}
