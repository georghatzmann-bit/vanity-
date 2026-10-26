//! Chunk files from Epic's CDN: header, zlib, and the hash check.
//!
//! Ported from Legendary (GPL-3.0-or-later, <https://github.com/derrod/legendary>):
//! `legendary/models/chunk.py` (header versions 1–4) and `legendary/utils/rolling_hash.py`
//! (Epic's 64-bit rolling hash, a CRC-64 variant with the polynomial `0xC96C5795D7870F42`).

use super::manifest::{ChunkInfo, Guid};
use super::manifest_bin::{inflate, Reader};

pub const CHUNK_MAGIC: u32 = 0xB1FE_3AA2;

/// No chunk unpacks to more than this (they are 1 MiB).
pub const MAX_CHUNK_BYTES: usize = 16 << 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChunkError {
    NotAChunk,
    Truncated,
    /// The chunk belongs to another GUID than asked for.
    WrongGuid,
    Encrypted,
    BadData(String),
    /// The unpacked data doesn't match the manifest's SHA-1 (or rolling hash).
    HashMismatch,
}

impl std::fmt::Display for ChunkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ChunkError::NotAChunk => write!(f, "not a chunk"),
            ChunkError::Truncated => write!(f, "chunk is cut off"),
            ChunkError::WrongGuid => write!(f, "wrong chunk"),
            ChunkError::Encrypted => write!(f, "chunk is encrypted"),
            ChunkError::BadData(w) => write!(f, "chunk is damaged ({w})"),
            ChunkError::HashMismatch => write!(f, "chunk data doesn't match its hash"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkHeader {
    pub version: u32,
    pub header_size: u32,
    pub compressed_size: u32,
    pub guid: Guid,
    pub hash: u64,
    pub stored_as: u8,
    pub sha1: Option<[u8; 20]>,
    pub hash_type: u8,
    pub uncompressed_size: u32,
}

const fn make_table() -> [u64; 256] {
    const POLY: u64 = 0xC96C_5795_D787_0F42;
    let mut table = [0u64; 256];
    let mut i = 0;
    while i < 256 {
        let mut v = i as u64;
        let mut bit = 0;
        while bit < 8 {
            v = if v & 1 == 1 { (v >> 1) ^ POLY } else { v >> 1 };
            bit += 1;
        }
        table[i] = v;
        i += 1;
    }
    table
}

static HASH_TABLE: [u64; 256] = make_table();

/// Epic's rolling hash of chunk data (Legendary `get_hash`).
pub fn rolling_hash(data: &[u8]) -> u64 {
    data.iter().fold(0u64, |h, &b| h.rotate_left(1) ^ HASH_TABLE[b as usize])
}

pub fn read_header(raw: &[u8]) -> Result<ChunkHeader, ChunkError> {
    let mut r = Reader::new(raw);
    let t = |_| ChunkError::Truncated;
    if r.u32().map_err(t)? != CHUNK_MAGIC {
        return Err(ChunkError::NotAChunk);
    }
    let version = r.u32().map_err(t)?;
    let header_size = r.u32().map_err(t)?;
    let compressed_size = r.u32().map_err(t)?;
    let guid = r.guid().map_err(t)?;
    let hash = r.u64().map_err(t)?;
    let stored_as = r.u8().map_err(t)?;
    let (mut sha1, mut hash_type, mut uncompressed_size) = (None, 0, 1024 * 1024);
    if version >= 2 {
        sha1 = Some(r.sha1().map_err(t)?);
        hash_type = r.u8().map_err(t)?;
    }
    if version >= 3 {
        uncompressed_size = r.u32().map_err(t)?;
    }
    if version >= 4 {
        // secret GUID + encryption tag
        r.take(32).map_err(t)?;
    }
    if (header_size as usize) < 41 || header_size as usize > raw.len() {
        return Err(ChunkError::BadData("header size".into()));
    }
    Ok(ChunkHeader { version, header_size, compressed_size, guid, hash, stored_as, sha1, hash_type, uncompressed_size })
}

/// Unpacks a downloaded chunk and checks it against the manifest: the GUID, then the SHA-1 – or
/// the rolling hash if the manifest has no SHA-1.
pub fn decode(raw: &[u8], expect: &ChunkInfo) -> Result<Vec<u8>, ChunkError> {
    let h = read_header(raw)?;
    if h.guid != expect.guid {
        return Err(ChunkError::WrongGuid);
    }
    if h.stored_as & 0x2 != 0 {
        return Err(ChunkError::Encrypted);
    }
    let start = h.header_size as usize;
    let end = start.checked_add(h.compressed_size as usize).ok_or(ChunkError::Truncated)?;
    if end > raw.len() {
        return Err(ChunkError::Truncated);
    }
    let body = &raw[start..end];
    let data = if h.stored_as & 0x1 != 0 {
        let limit = (h.uncompressed_size as usize).max(expect.window_size as usize).min(MAX_CHUNK_BYTES);
        inflate(body, limit).map_err(|e| ChunkError::BadData(e.to_string()))?
    } else {
        body.to_vec()
    };
    let ok = match expect.sha1 {
        Some(sha) => {
            use sha1::{Digest, Sha1};
            Sha1::digest(&data).as_slice() == sha
        }
        None => rolling_hash(&data) == expect.hash,
    };
    if !ok {
        return Err(ChunkError::HashMismatch);
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::epic::fixtures::{encode_chunk, FixtureChunk};

    #[test]
    fn rolling_hash_known_values() {
        assert_eq!(rolling_hash(b""), 0);
        // one byte: just the table entry
        assert_eq!(rolling_hash(&[1]), HASH_TABLE[1]);
        assert_eq!(HASH_TABLE[0], 0);
        assert_eq!(HASH_TABLE[128], 0xC96C_5795_D787_0F42);
        // two bytes: rotate, then xor
        assert_eq!(rolling_hash(&[1, 2]), HASH_TABLE[1].rotate_left(1) ^ HASH_TABLE[2]);
    }

    #[test]
    fn decodes_every_header_version() {
        let c = FixtureChunk::new(5, 70_000);
        for version in [1, 2, 3, 4] {
            for compress in [true, false] {
                let raw = encode_chunk(&c, version, compress);
                let mut info = c.info(raw.len() as u64);
                assert_eq!(decode(&raw, &info).unwrap(), c.data, "v{version} compress={compress}");
                // without SHA-1 in the manifest the rolling hash is used
                info.sha1 = None;
                assert_eq!(decode(&raw, &info).unwrap(), c.data);
                info.hash ^= 1;
                assert_eq!(decode(&raw, &info), Err(ChunkError::HashMismatch));
            }
        }
    }

    #[test]
    fn refuses_bad_chunks() {
        let c = FixtureChunk::new(6, 1000);
        let raw = encode_chunk(&c, 3, true);
        let info = c.info(raw.len() as u64);
        // damaged data
        let mut bad = raw.clone();
        let last = bad.len() - 2;
        bad[last] ^= 0x55;
        assert!(decode(&bad, &info).is_err());
        // wrong GUID
        let other = FixtureChunk::new(7, 1000);
        assert_eq!(decode(&encode_chunk(&other, 3, true), &info), Err(ChunkError::WrongGuid));
        // cut off
        assert_eq!(decode(&raw[..raw.len() - 10], &info), Err(ChunkError::Truncated));
        assert_eq!(decode(&raw[..10], &info), Err(ChunkError::Truncated));
        // not a chunk (e.g. an HTML error page)
        assert_eq!(decode(b"<html>403 no token</html> padding padding padding padding", &info), Err(ChunkError::NotAChunk));
        // encrypted
        let mut enc = raw.clone();
        enc[40] |= 2;
        assert_eq!(decode(&enc, &info), Err(ChunkError::Encrypted));
        // wrong SHA-1 in the manifest
        let mut wrong = info.clone();
        wrong.sha1 = Some([1; 20]);
        assert_eq!(decode(&raw, &wrong), Err(ChunkError::HashMismatch));
    }
}
