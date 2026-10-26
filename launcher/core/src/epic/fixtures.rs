//! Test files the tests build themselves (no Epic files in the repo): chunks, binary and JSON
//! manifests in Epic's formats (writers modelled on Legendary's `write` methods).

use std::io::Write;

use sha1::{Digest, Sha1};

use super::chunk::{rolling_hash, CHUNK_MAGIC};
use super::manifest::{ChunkInfo, Guid};
use super::manifest_bin::MANIFEST_MAGIC;

/// A chunk with made-up but deterministic content.
#[derive(Debug, Clone)]
pub struct FixtureChunk {
    pub guid: Guid,
    pub group: u8,
    pub data: Vec<u8>,
}

impl FixtureChunk {
    pub fn new(seed: u32, size: usize) -> FixtureChunk {
        let mut x = seed.wrapping_mul(2_654_435_761).wrapping_add(12345);
        let data = (0..size)
            .map(|i| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                // half pattern, half noise: compresses a bit, like real data
                if i % 2 == 0 { (i / 7) as u8 } else { x as u8 }
            })
            .collect();
        FixtureChunk { guid: [seed, seed ^ 0xA5A5_A5A5, seed.wrapping_mul(7), 0x1234_0000 | seed], group: (seed % 100) as u8, data }
    }

    pub fn sha1(&self) -> [u8; 20] {
        Sha1::digest(&self.data).into()
    }

    pub fn rolling(&self) -> u64 {
        rolling_hash(&self.data)
    }

    /// Size of the chunk file as stored on the "CDN" (version 3, compressed).
    pub fn download_size(&self) -> usize {
        encode_chunk(self, 3, true).len()
    }

    /// The manifest's view of this chunk.
    pub fn info(&self, file_size: u64) -> ChunkInfo {
        ChunkInfo {
            guid: self.guid,
            hash: self.rolling(),
            sha1: Some(self.sha1()),
            group: self.group,
            window_size: self.data.len() as u32,
            file_size,
        }
    }
}

/// A file made of slices of fixture chunks.
#[derive(Debug, Clone)]
pub struct FixtureFile {
    pub path: String,
    pub parts: Vec<(Guid, u32, u32)>,
    pub content: Vec<u8>,
}

impl FixtureFile {
    pub fn new(path: &str, parts: Vec<(&FixtureChunk, u32, u32)>) -> FixtureFile {
        let mut content = Vec::new();
        for (c, off, size) in &parts {
            let end = (*off as usize + *size as usize).min(c.data.len());
            content.extend_from_slice(&c.data[(*off as usize).min(end)..end]);
        }
        FixtureFile { path: path.into(), parts: parts.iter().map(|(c, o, s)| (c.guid, *o, *s)).collect(), content }
    }

    pub fn sha1(&self) -> [u8; 20] {
        Sha1::digest(&self.content).into()
    }
}

fn zlib(data: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
    e.write_all(data).unwrap();
    e.finish().unwrap()
}

fn guid_le(out: &mut Vec<u8>, g: &Guid) {
    for x in g {
        out.extend(x.to_le_bytes());
    }
}

/// Chunk file in Epic's format (Legendary `Chunk.write`), header version 1–4.
pub fn encode_chunk(c: &FixtureChunk, version: u32, compress: bool) -> Vec<u8> {
    let body = if compress { zlib(&c.data) } else { c.data.clone() };
    let header_size: u32 = match version {
        1 => 41,
        2 => 62,
        3 => 66,
        _ => 98,
    };
    let mut out = Vec::new();
    out.extend(CHUNK_MAGIC.to_le_bytes());
    out.extend(version.to_le_bytes());
    out.extend(header_size.to_le_bytes());
    out.extend((body.len() as u32).to_le_bytes());
    guid_le(&mut out, &c.guid);
    out.extend(c.rolling().to_le_bytes());
    out.push(if compress { 1 } else { 0 });
    if version >= 2 {
        out.extend(c.sha1());
        out.push(3);
    }
    if version >= 3 {
        out.extend((c.data.len() as u32).to_le_bytes());
    }
    if version >= 4 {
        out.extend([0u8; 32]);
    }
    assert_eq!(out.len(), header_size as usize);
    out.extend(body);
    out
}

fn fstring(out: &mut Vec<u8>, s: &str) {
    if s.is_empty() {
        out.extend(0i32.to_le_bytes());
    } else if s.is_ascii() {
        out.extend((s.len() as i32 + 1).to_le_bytes());
        out.extend(s.as_bytes());
        out.push(0);
    } else {
        let units: Vec<u16> = s.encode_utf16().collect();
        out.extend((-(units.len() as i32 + 1)).to_le_bytes());
        for u in units {
            out.extend(u.to_le_bytes());
        }
        out.extend([0, 0]);
    }
}

fn sized_section(out: &mut Vec<u8>, version: u8, count: usize, body: impl FnOnce(&mut Vec<u8>)) {
    let start = out.len();
    out.extend(0u32.to_le_bytes());
    out.push(version);
    out.extend((count as u32).to_le_bytes());
    body(out);
    let size = (out.len() - start) as u32;
    out[start..start + 4].copy_from_slice(&size.to_le_bytes());
}

/// Binary manifest (Legendary `Manifest.write`): header + metadata + chunk list + file list +
/// custom fields. `feature_level` also goes into the header version.
pub fn binary_manifest(
    feature_level: u32,
    build_version: &str,
    chunks: &[FixtureChunk],
    files: &[FixtureFile],
    compress: bool,
) -> Vec<u8> {
    let mut body = Vec::new();
    // metadata (data version 1 = with build id)
    let meta_start = body.len();
    body.extend(0u32.to_le_bytes());
    body.push(1);
    body.extend(feature_level.to_le_bytes());
    body.push(0);
    body.extend(0u32.to_le_bytes());
    fstring(&mut body, "FortniteReleaseBuilds");
    fstring(&mut body, build_version);
    fstring(&mut body, "FortniteGame/Binaries/Win64/FortniteClient-Win64-Shipping.exe");
    fstring(&mut body, "");
    body.extend(1u32.to_le_bytes());
    fstring(&mut body, "prereq-ä");
    fstring(&mut body, "");
    fstring(&mut body, "");
    fstring(&mut body, "");
    fstring(&mut body, "build-id");
    let meta_size = (body.len() - meta_start) as u32;
    body[meta_start..meta_start + 4].copy_from_slice(&meta_size.to_le_bytes());

    sized_section(&mut body, 0, chunks.len(), |b| {
        for c in chunks {
            guid_le(b, &c.guid);
        }
        for c in chunks {
            b.extend(c.rolling().to_le_bytes());
        }
        for c in chunks {
            b.extend(c.sha1());
        }
        for c in chunks {
            b.push(c.group);
        }
        for c in chunks {
            b.extend((c.data.len() as u32).to_le_bytes());
        }
        for c in chunks {
            b.extend((c.download_size() as i64).to_le_bytes());
        }
    });

    sized_section(&mut body, 0, files.len(), |b| {
        for f in files {
            fstring(b, &f.path);
        }
        for _ in files {
            fstring(b, "");
        }
        for f in files {
            b.extend(f.sha1());
        }
        for _ in files {
            b.push(0);
        }
        for _ in files {
            b.extend(1u32.to_le_bytes());
            fstring(b, "chunk0");
        }
        for f in files {
            b.extend((f.parts.len() as u32).to_le_bytes());
            for (g, off, size) in &f.parts {
                b.extend(28u32.to_le_bytes());
                guid_le(b, g);
                b.extend(off.to_le_bytes());
                b.extend(size.to_le_bytes());
            }
        }
    });

    // custom fields (empty)
    sized_section(&mut body, 0, 0, |_| {});

    let sha: [u8; 20] = Sha1::digest(&body).into();
    let stored = if compress { zlib(&body) } else { body.clone() };
    let mut out = Vec::new();
    out.extend(MANIFEST_MAGIC.to_le_bytes());
    out.extend(41u32.to_le_bytes());
    out.extend((body.len() as u32).to_le_bytes());
    out.extend((stored.len() as u32).to_le_bytes());
    out.extend(sha);
    out.push(if compress { 1 } else { 0 });
    out.extend(feature_level.to_le_bytes());
    out.extend(stored);
    out
}

/// A number as a JSON manifest "blob" (3 decimal digits per byte, little-endian).
pub fn blob(value: u64, bytes: usize) -> String {
    (0..bytes).map(|i| format!("{:03}", (value >> (8 * i)) as u8)).collect()
}

fn guid_json(g: &Guid) -> String {
    g.iter().map(|x| format!("{x:08X}")).collect()
}

/// JSON manifest (the layout Legendary's `JSONManifest` reads).
pub fn json_manifest(feature_level: u32, build_version: &str, chunks: &[FixtureChunk], files: &[FixtureFile]) -> Vec<u8> {
    use serde_json::{json, Map, Value};
    let mut sizes = Map::new();
    let mut hashes = Map::new();
    let mut shas = Map::new();
    let mut groups = Map::new();
    for c in chunks {
        let k = guid_json(&c.guid);
        sizes.insert(k.clone(), Value::String(blob(c.download_size() as u64, 8)));
        hashes.insert(k.clone(), Value::String(blob(c.rolling(), 8)));
        shas.insert(k.clone(), Value::String(super::hex(&c.sha1())));
        groups.insert(k, Value::String(blob(c.group as u64, 1)));
    }
    let file_list: Vec<Value> = files
        .iter()
        .map(|f| {
            let sha: String = f.sha1().iter().map(|b| format!("{b:03}")).collect();
            json!({
                "Filename": f.path,
                "FileHash": sha,
                "InstallTags": ["chunk0"],
                "FileChunkParts": f.parts.iter().map(|(g, off, size)| json!({
                    "Guid": guid_json(g), "Offset": blob(*off as u64, 4), "Size": blob(*size as u64, 4)
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    let doc = json!({
        "ManifestFileVersion": blob(feature_level as u64, 4),
        "bIsFileData": false,
        "AppID": blob(0, 4),
        "AppNameString": "FortniteReleaseBuilds",
        "BuildVersionString": build_version,
        "LaunchExeString": "FortniteGame/Binaries/Win64/FortniteClient-Win64-Shipping.exe",
        "LaunchCommand": "",
        "PrereqIds": [],
        "FileManifestList": file_list,
        "ChunkHashList": hashes,
        "ChunkShaList": shas,
        "DataGroupList": groups,
        "ChunkFilesizeList": sizes,
        "CustomFields": {},
    });
    serde_json::to_vec_pretty(&doc).unwrap()
}
