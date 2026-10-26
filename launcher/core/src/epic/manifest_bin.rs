//! Binary manifests (Fortnite 17.30 and newer).
//!
//! Layout ported from Legendary, `legendary/models/manifest.py` (GPL-3.0-or-later,
//! <https://github.com/derrod/legendary>): header (`Manifest.read`), metadata (`ManifestMeta.read`),
//! chunk list (`CDL.read`) and file list (`FML.read`). Encrypted manifests and format 22+ are refused.

use std::io::Read;

use super::manifest::{ChunkInfo, ChunkPart, FileEntry, Guid, Manifest, ManifestError, ManifestFormat, FIRST_UNSUPPORTED_VERSION};

pub const MANIFEST_MAGIC: u32 = 0x44BE_C00C;

/// No real manifest unpacks to more than this (the biggest Fortnite ones are ~60 MB).
const MAX_BODY: usize = 512 << 20;

pub(crate) struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub(crate) fn new(data: &'a [u8]) -> Self {
        Reader { data, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.data.len() - self.pos
    }

    pub(crate) fn take(&mut self, n: usize) -> Result<&'a [u8], ManifestError> {
        if n > self.remaining() {
            return Err(ManifestError::Truncated);
        }
        let s = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    fn seek(&mut self, pos: usize) -> Result<(), ManifestError> {
        if pos > self.data.len() {
            return Err(ManifestError::Truncated);
        }
        self.pos = pos;
        Ok(())
    }

    pub(crate) fn u8(&mut self) -> Result<u8, ManifestError> {
        Ok(self.take(1)?[0])
    }

    pub(crate) fn u32(&mut self) -> Result<u32, ManifestError> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn i32(&mut self) -> Result<i32, ManifestError> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    pub(crate) fn u64(&mut self) -> Result<u64, ManifestError> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }

    fn i64(&mut self) -> Result<i64, ManifestError> {
        Ok(i64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }

    pub(crate) fn guid(&mut self) -> Result<Guid, ManifestError> {
        Ok([self.u32()?, self.u32()?, self.u32()?, self.u32()?])
    }

    pub(crate) fn sha1(&mut self) -> Result<[u8; 20], ManifestError> {
        Ok(self.take(20)?.try_into().unwrap())
    }

    /// Unreal FString: length with the terminator; negative = UTF-16.
    fn fstring(&mut self) -> Result<String, ManifestError> {
        let len = self.i32()?;
        if len == 0 {
            return Ok(String::new());
        }
        if len < 0 {
            let chars = len.unsigned_abs() as usize;
            let bytes = self.take(chars.checked_mul(2).ok_or(ManifestError::Truncated)?)?;
            let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            let text = &units[..units.len().saturating_sub(1)];
            return Ok(String::from_utf16_lossy(text));
        }
        let bytes = self.take(len as usize)?;
        Ok(String::from_utf8_lossy(&bytes[..bytes.len() - 1]).into_owned())
    }

    /// Refuses element counts that can't fit into the rest of the data (damaged file).
    fn check_count(&self, count: u32, min_bytes_each: usize) -> Result<usize, ManifestError> {
        let count = count as usize;
        if count.saturating_mul(min_bytes_each) > self.remaining() {
            return Err(ManifestError::Truncated);
        }
        Ok(count)
    }
}

/// Unpacks zlib data, at most `limit` bytes.
pub(crate) fn inflate(data: &[u8], limit: usize) -> Result<Vec<u8>, ManifestError> {
    let mut out = Vec::new();
    flate2::read::ZlibDecoder::new(data)
        .take(limit as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|e| ManifestError::Corrupt(format!("zlib: {e}")))?;
    if out.len() > limit {
        return Err(ManifestError::Corrupt("unpacks bigger than it says".into()));
    }
    Ok(out)
}

pub(crate) fn parse(data: &[u8]) -> Result<Manifest, ManifestError> {
    let mut r = Reader::new(data);
    if data.len() < 4 || r.u32()? != MANIFEST_MAGIC {
        return Err(ManifestError::NotAManifest);
    }
    let header_size = r.u32()? as usize;
    let size_uncompressed = r.u32()? as usize;
    let _size_compressed = r.u32()?;
    let body_sha1 = r.sha1()?;
    let stored_as = r.u8()?;
    let version = r.u32()?;
    if version >= FIRST_UNSUPPORTED_VERSION {
        return Err(ManifestError::TooNew(version));
    }
    if stored_as & 0x2 != 0 {
        return Err(ManifestError::Encrypted);
    }
    if header_size < r.pos || header_size > data.len() {
        return Err(ManifestError::Corrupt("header size".into()));
    }
    let raw = &data[header_size..];
    let body = if stored_as & 0x1 != 0 {
        inflate(raw, size_uncompressed.min(MAX_BODY))?
    } else {
        raw.to_vec()
    };
    {
        use sha1::{Digest, Sha1};
        if Sha1::digest(&body).as_slice() != body_sha1 {
            return Err(ManifestError::HashMismatch);
        }
    }
    parse_body(&body)
}

fn parse_body(body: &[u8]) -> Result<Manifest, ManifestError> {
    let mut r = Reader::new(body);

    // --- metadata (ManifestMeta.read) ---
    let meta_start = r.pos;
    let meta_size = r.u32()? as usize;
    let data_version = r.u8()?;
    let feature_level = r.u32()?;
    let _is_file_data = r.u8()?;
    let _app_id = r.u32()?;
    let app_name = r.fstring()?;
    let build_version = r.fstring()?;
    let launch_exe = r.fstring()?;
    let _launch_command = r.fstring()?;
    let prereqs = r.u32()?;
    let prereqs = r.check_count(prereqs, 4)?;
    for _ in 0..prereqs {
        r.fstring()?;
    }
    let _prereq_name = r.fstring()?;
    let _prereq_path = r.fstring()?;
    let _prereq_args = r.fstring()?;
    if data_version >= 1 {
        let _build_id = r.fstring()?;
    }
    if data_version >= 2 {
        let _uninstall_path = r.fstring()?;
        let _uninstall_args = r.fstring()?;
    }
    r.seek(meta_start + meta_size)?;
    if feature_level >= FIRST_UNSUPPORTED_VERSION {
        return Err(ManifestError::TooNew(feature_level));
    }

    // --- chunk list (CDL.read): one array per field ---
    let cdl_start = r.pos;
    let cdl_size = r.u32()? as usize;
    let _cdl_version = r.u8()?;
    let count = r.u32()?;
    let count = r.check_count(count, 16 + 8 + 20 + 1 + 4 + 8)?;
    let mut chunks: Vec<ChunkInfo> = Vec::with_capacity(count);
    for _ in 0..count {
        chunks.push(ChunkInfo { guid: r.guid()?, hash: 0, sha1: None, group: 0, window_size: 0, file_size: 0 });
    }
    for c in chunks.iter_mut() {
        c.hash = r.u64()?;
    }
    for c in chunks.iter_mut() {
        let sha = r.sha1()?;
        c.sha1 = (sha != [0u8; 20]).then_some(sha);
    }
    for c in chunks.iter_mut() {
        c.group = r.u8()?;
    }
    for c in chunks.iter_mut() {
        c.window_size = r.u32()?;
    }
    for c in chunks.iter_mut() {
        let size = r.i64()?;
        c.file_size = u64::try_from(size).map_err(|_| ManifestError::Corrupt("negative chunk size".into()))?;
    }
    r.seek(cdl_start + cdl_size)?;

    // --- file list (FML.read) ---
    let fml_start = r.pos;
    let fml_size = r.u32()? as usize;
    let _fml_version = r.u8()?;
    let count = r.u32()?;
    let count = r.check_count(count, 4 + 4 + 20 + 1 + 4 + 4)?;
    let mut files: Vec<FileEntry> = Vec::with_capacity(count);
    for _ in 0..count {
        files.push(FileEntry { path: r.fstring()?, sha1: [0; 20], install_tags: Vec::new(), parts: Vec::new() });
    }
    for _ in 0..count {
        let _symlink_target = r.fstring()?;
    }
    for f in files.iter_mut() {
        f.sha1 = r.sha1()?;
    }
    for _ in 0..count {
        let _flags = r.u8()?;
    }
    for f in files.iter_mut() {
        let n = r.u32()?;
        let n = r.check_count(n, 4)?;
        for _ in 0..n {
            f.install_tags.push(r.fstring()?);
        }
    }
    for f in files.iter_mut() {
        let n = r.u32()?;
        let n = r.check_count(n, 28)?;
        f.parts.reserve(n);
        for _ in 0..n {
            let part_start = r.pos;
            let part_size = r.u32()? as usize;
            if part_size < 28 {
                return Err(ManifestError::Corrupt("chunk part too small".into()));
            }
            let guid = r.guid()?;
            let offset = r.u32()?;
            let size = r.u32()?;
            f.parts.push(ChunkPart { guid, offset, size });
            r.seek(part_start + part_size)?;
        }
    }
    // MD5/MIME (file list version 1) and SHA-256 (version 2) follow – not needed.
    r.seek(fml_start + fml_size)?;

    Ok(Manifest::new(ManifestFormat::Binary, feature_level, app_name, build_version, launch_exe, chunks, files))
}
