//! The model of an Epic manifest: the pieces ("chunks") on the CDN and the files made from them.
//!
//! Ported from Legendary (`legendary/models/manifest.py`, GPL-3.0-or-later,
//! <https://github.com/derrod/legendary>). The two file formats are read by `manifest_bin` (binary,
//! Fortnite 17.30 and newer) and `manifest_json` (JSON, up to 17.21).

use std::collections::{HashMap, HashSet};

use super::pathsafe::{self, PathError};

/// Chunk GUID as four 32-bit numbers (Epic's own layout).
pub type Guid = [u32; 4];

/// "0011…EEFF" – the GUID as it appears in chunk file names (upper-case hex, no dashes).
pub fn guid_hex(g: &Guid) -> String {
    g.iter().map(|x| format!("{x:08X}")).collect()
}

/// One piece on the CDN. Unpacked it is `window_size` bytes (1 MiB); files take slices of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkInfo {
    pub guid: Guid,
    /// Epic's 64-bit rolling hash of the unpacked data (also part of the file name).
    pub hash: u64,
    /// SHA-1 of the unpacked data (`None` if the manifest has none).
    pub sha1: Option<[u8; 20]>,
    /// Sub-folder number on the CDN (00–99).
    pub group: u8,
    /// Unpacked size.
    pub window_size: u32,
    /// Size of the download.
    pub file_size: u64,
}

/// A slice of a chunk that becomes the next bytes of a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkPart {
    pub guid: Guid,
    pub offset: u32,
    pub size: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileEntry {
    /// Relative path with `/` (as in the manifest).
    pub path: String,
    pub sha1: [u8; 20],
    pub install_tags: Vec<String>,
    pub parts: Vec<ChunkPart>,
}

impl FileEntry {
    pub fn size(&self) -> u64 {
        self.parts.iter().map(|p| p.size as u64).sum()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManifestFormat {
    Binary,
    Json,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestError {
    NotAManifest,
    Truncated,
    Corrupt(String),
    /// The unpacked body doesn't match the SHA-1 in the header.
    HashMismatch,
    /// Encrypted manifests need keys only Epic's API hands out.
    Encrypted,
    /// Manifest format 22 or newer (Fortnite 30.50+): not supported.
    TooNew(u32),
    Json(String),
    /// A file uses a chunk the chunk list doesn't have.
    UnknownChunk(String),
    BadPath(String, PathError),
}

impl std::fmt::Display for ManifestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ManifestError::NotAManifest => write!(f, "not a manifest"),
            ManifestError::Truncated => write!(f, "manifest is cut off"),
            ManifestError::Corrupt(w) => write!(f, "manifest is damaged ({w})"),
            ManifestError::HashMismatch => write!(f, "manifest body doesn't match its SHA-1"),
            ManifestError::Encrypted => write!(f, "manifest is encrypted"),
            ManifestError::TooNew(v) => write!(f, "manifest version {v} isn't supported"),
            ManifestError::Json(e) => write!(f, "manifest JSON: {e}"),
            ManifestError::UnknownChunk(g) => write!(f, "file uses unknown chunk {g}"),
            ManifestError::BadPath(p, e) => write!(f, "unsafe path '{p}': {e}"),
        }
    }
}

/// From this manifest version on, chunks are encrypted and stored differently (ChunksV5).
pub const FIRST_UNSUPPORTED_VERSION: u32 = 22;

/// Chunk folder on the CDN for a manifest feature level (Legendary `get_chunk_dir`).
pub fn chunk_dir(feature_level: u32) -> &'static str {
    match feature_level {
        22.. => "ChunksV5",
        15.. => "ChunksV4",
        6.. => "ChunksV3",
        3.. => "ChunksV2",
        _ => "Chunks",
    }
}

#[derive(Debug, Clone)]
pub struct Manifest {
    pub format: ManifestFormat,
    pub feature_level: u32,
    pub app_name: String,
    /// "++Fortnite+Release-18.30-CL-17882303-Windows"
    pub build_version: String,
    pub launch_exe: String,
    pub chunks: Vec<ChunkInfo>,
    pub files: Vec<FileEntry>,
    index: HashMap<Guid, usize>,
}

impl Manifest {
    /// Reads a manifest (binary or JSON) and checks it: every file's chunks exist, slices fit into
    /// their chunk, and every path is safe.
    pub fn parse(data: &[u8]) -> Result<Manifest, ManifestError> {
        let first = data.iter().find(|b| !b.is_ascii_whitespace()).copied();
        let m = if first == Some(b'{') { super::manifest_json::parse(data)? } else { super::manifest_bin::parse(data)? };
        m.validate()?;
        Ok(m)
    }

    pub(crate) fn new(
        format: ManifestFormat,
        feature_level: u32,
        app_name: String,
        build_version: String,
        launch_exe: String,
        chunks: Vec<ChunkInfo>,
        files: Vec<FileEntry>,
    ) -> Manifest {
        let index = chunks.iter().enumerate().map(|(i, c)| (c.guid, i)).collect();
        Manifest { format, feature_level, app_name, build_version, launch_exe, chunks, files, index }
    }

    fn validate(&self) -> Result<(), ManifestError> {
        if self.feature_level >= FIRST_UNSUPPORTED_VERSION {
            return Err(ManifestError::TooNew(self.feature_level));
        }
        let mut seen = HashSet::new();
        for f in &self.files {
            pathsafe::check_relative(&f.path).map_err(|e| ManifestError::BadPath(f.path.clone(), e))?;
            // Windows doesn't tell upper and lower case apart
            if !seen.insert(f.path.replace('\\', "/").to_lowercase()) {
                return Err(ManifestError::Corrupt(format!("'{}' is listed twice", f.path)));
            }
            for p in &f.parts {
                let c = self.chunk(&p.guid).ok_or_else(|| ManifestError::UnknownChunk(guid_hex(&p.guid)))?;
                if p.offset as u64 + p.size as u64 > c.window_size as u64 {
                    return Err(ManifestError::Corrupt(format!("a part of '{}' is bigger than its chunk", f.path)));
                }
            }
        }
        Ok(())
    }

    pub fn chunk(&self, guid: &Guid) -> Option<&ChunkInfo> {
        self.index.get(guid).map(|&i| &self.chunks[i])
    }

    pub fn chunk_index(&self, guid: &Guid) -> Option<usize> {
        self.index.get(guid).copied()
    }

    pub fn chunk_dir(&self) -> &'static str {
        chunk_dir(self.feature_level)
    }

    /// Path of a chunk below `/Builds/Fortnite/CloudDir/`, e.g.
    /// `ChunksV4/12/0123456789ABCDEF_00112233445566778899AABBCCDDEEFF.chunk`.
    pub fn chunk_path(&self, c: &ChunkInfo) -> String {
        format!("{}/{:02}/{:016X}_{}.chunk", self.chunk_dir(), c.group, c.hash, guid_hex(&c.guid))
    }

    /// Size of all files together.
    pub fn installed_bytes(&self) -> u64 {
        self.files.iter().map(FileEntry::size).sum()
    }

    /// The chunks the files use, each once, in the order they are first needed.
    pub fn used_chunks(&self) -> Vec<&ChunkInfo> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for f in &self.files {
            for p in &f.parts {
                if seen.insert(p.guid) {
                    if let Some(c) = self.chunk(&p.guid) {
                        out.push(c);
                    }
                }
            }
        }
        out
    }

    /// Download size: every used chunk once.
    pub fn download_bytes(&self) -> u64 {
        self.used_chunks().iter().map(|c| c.file_size).sum()
    }

    pub fn file(&self, path: &str) -> Option<&FileEntry> {
        self.files.iter().find(|f| f.path == path)
    }

    /// Version and changelist from the build version string.
    pub fn version(&self) -> Option<(String, u32)> {
        let v = crate::version::parse_version_string(&self.build_version)?;
        Some((v.version, v.changelist?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::epic::fixtures::{self, FixtureChunk};

    #[test]
    fn chunk_dirs_and_paths() {
        assert_eq!(chunk_dir(13), "ChunksV3");
        assert_eq!(chunk_dir(17), "ChunksV4");
        assert_eq!(chunk_dir(21), "ChunksV4");
        assert_eq!(chunk_dir(22), "ChunksV5");
        assert_eq!(chunk_dir(3), "ChunksV2");
        assert_eq!(chunk_dir(2), "Chunks");
        let c = ChunkInfo {
            guid: [0x00112233, 0x44556677, 0x8899AABB, 0xCCDDEEFF],
            hash: 0x0123456789ABCDEF,
            sha1: None,
            group: 7,
            window_size: 1 << 20,
            file_size: 10,
        };
        let m = Manifest::new(ManifestFormat::Binary, 17, String::new(), String::new(), String::new(), vec![c.clone()], vec![]);
        assert_eq!(m.chunk_path(&c), "ChunksV4/07/0123456789ABCDEF_00112233445566778899AABBCCDDEEFF.chunk");
    }

    fn sample() -> (Vec<FixtureChunk>, Vec<fixtures::FixtureFile>) {
        let a = FixtureChunk::new(1, 4096);
        let b = FixtureChunk::new(2, 4096);
        let files = vec![
            fixtures::FixtureFile::new("Game/Bin/game.exe", vec![(&a, 0, 4096), (&b, 0, 100)]),
            fixtures::FixtureFile::new("Game/readme.txt", vec![(&b, 100, 50)]),
            fixtures::FixtureFile::new("Game/empty.ini", vec![]),
        ];
        (vec![a, b], files)
    }

    #[test]
    fn binary_and_json_give_the_same_model() {
        let (chunks, files) = sample();
        for (data, format, level) in [
            (fixtures::binary_manifest(17, "++Fortnite+Release-18.30-CL-17882303-Windows", &chunks, &files, true), ManifestFormat::Binary, 17),
            (fixtures::binary_manifest(17, "++Fortnite+Release-18.30-CL-17882303-Windows", &chunks, &files, false), ManifestFormat::Binary, 17),
            (fixtures::json_manifest(13, "++Fortnite+Release-18.30-CL-17882303-Windows", &chunks, &files), ManifestFormat::Json, 13),
        ] {
            let m = Manifest::parse(&data).unwrap();
            assert_eq!(m.format, format);
            assert_eq!(m.feature_level, level);
            assert_eq!(m.app_name, "FortniteReleaseBuilds");
            assert_eq!(m.version(), Some(("18.30".to_string(), 17882303)));
            assert_eq!(m.chunks.len(), 2);
            assert_eq!(m.files.len(), 3);
            let exe = m.file("Game/Bin/game.exe").unwrap();
            assert_eq!(exe.size(), 4196);
            assert_eq!(exe.sha1, files[0].sha1());
            assert_eq!(exe.parts[1], ChunkPart { guid: chunks[1].guid, offset: 0, size: 100 });
            assert_eq!(m.file("Game/empty.ini").unwrap().size(), 0);
            assert_eq!(m.installed_bytes(), 4196 + 50);
            assert_eq!(m.used_chunks().len(), 2);
            assert_eq!(m.download_bytes(), chunks.iter().map(|c| c.download_size() as u64).sum::<u64>());
            let c = m.chunk(&chunks[0].guid).unwrap();
            assert_eq!(c.sha1, Some(chunks[0].sha1()));
            assert_eq!(c.hash, chunks[0].rolling());
            assert_eq!(c.group, chunks[0].group);
            assert_eq!(c.window_size, 4096.max(if format == ManifestFormat::Json { 1 << 20 } else { 0 }));
            assert_eq!(m.files[0].install_tags, vec!["chunk0".to_string()]);
        }
    }

    #[test]
    fn refuses_bad_manifests() {
        let (chunks, files) = sample();
        let good = fixtures::binary_manifest(17, "x", &chunks, &files, true);
        // wrong magic
        let mut bad = good.clone();
        bad[0] ^= 0xff;
        assert_eq!(Manifest::parse(&bad).unwrap_err(), ManifestError::NotAManifest);
        // cut off
        assert!(Manifest::parse(&good[..good.len() / 2]).is_err());
        // body changed → SHA-1 doesn't match
        let raw = fixtures::binary_manifest(17, "x", &chunks, &files, false);
        let mut changed = raw.clone();
        let last = changed.len() - 1;
        changed[last] ^= 1;
        assert_eq!(Manifest::parse(&changed).unwrap_err(), ManifestError::HashMismatch);
        // encrypted flag
        let mut enc = good.clone();
        enc[36] |= 2;
        assert_eq!(Manifest::parse(&enc).unwrap_err(), ManifestError::Encrypted);
        // version 22+
        let new = fixtures::binary_manifest(22, "x", &chunks, &files, true);
        assert!(matches!(Manifest::parse(&new).unwrap_err(), ManifestError::TooNew(22)));
        // unsafe path
        let evil = vec![fixtures::FixtureFile::new("../evil.dll", vec![(&chunks[0], 0, 10)])];
        let m = fixtures::binary_manifest(17, "x", &chunks, &evil, true);
        assert!(matches!(Manifest::parse(&m).unwrap_err(), ManifestError::BadPath(_, PathError::DotFolder)));
        let evil = vec![fixtures::FixtureFile::new("C:/Windows/evil.dll", vec![])];
        let m = fixtures::json_manifest(13, "x", &chunks, &evil);
        assert!(matches!(Manifest::parse(&m).unwrap_err(), ManifestError::BadPath(_, PathError::DriveOrStream)));
        // a part bigger than its chunk
        let big = vec![fixtures::FixtureFile::new("a.bin", vec![(&chunks[0], 4000, 200)])];
        let m = fixtures::binary_manifest(17, "x", &chunks, &big, true);
        assert!(matches!(Manifest::parse(&m).unwrap_err(), ManifestError::Corrupt(_)));
        // the same file twice (different case)
        let twice = vec![fixtures::FixtureFile::new("a.bin", vec![]), fixtures::FixtureFile::new("A.BIN", vec![])];
        let m = fixtures::binary_manifest(17, "x", &chunks, &twice, true);
        assert!(matches!(Manifest::parse(&m).unwrap_err(), ManifestError::Corrupt(_)));
        // a chunk that isn't in the list
        let other = FixtureChunk::new(9, 100);
        let lost = vec![fixtures::FixtureFile::new("a.bin", vec![(&other, 0, 10)])];
        let m = fixtures::binary_manifest(17, "x", &chunks, &lost, true);
        assert!(matches!(Manifest::parse(&m).unwrap_err(), ManifestError::UnknownChunk(_)));
        // JSON junk
        assert!(matches!(Manifest::parse(b"{not json").unwrap_err(), ManifestError::Json(_)));
        assert!(Manifest::parse(b"").is_err());
    }
}
