//! Build downloader: gets an old Fortnite build straight from Epic's own download servers.
//!
//! Where the bytes come from:
//! - The **manifest** (a small file that lists a build's files and the pieces they are made of)
//!   comes from the public GitHub archive `polynite/fn-releases`, with
//!   `VastBlast/FortniteManifestArchive` as fallback. Epic no longer serves old manifests. Each one
//!   is pinned by its SHA-1 in `data/build-catalog.json`, so a changed file is refused.
//! - **Every game byte** (the "chunks") comes from Epic's official CDN hosts ([`cdn::CDN_HOSTS`]).
//!   Nothing is ever taken from re-uploads or mirrors of builds.
//!
//! Before anything is written, every chunk the build needs is checked with a HEAD request: Epic has
//! deleted parts of many old builds, and a download that can't finish must not start.
//!
//! The manifest and chunk formats are ported from Legendary
//! (<https://github.com/derrod/legendary>, GPL-3.0-or-later; `legendary/models/manifest.py`,
//! `json_manifest.py`, `chunk.py`, `utils/rolling_hash.py`), rewritten in Rust.

pub mod catalog;
pub mod cdn;
pub mod chunk;
pub mod errors;
pub mod folder;
pub mod install;
pub mod journal;
pub mod manifest;
mod manifest_bin;
mod manifest_json;
pub mod pathsafe;

#[cfg(test)]
mod fixtures;
#[cfg(test)]
mod local_tests;

/// Lower-case hex of a byte string (SHA-1 values in the catalog and the journal).
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// SHA-1 of `data` as lower-case hex.
pub fn sha1_hex(data: &[u8]) -> String {
    use sha1::{Digest, Sha1};
    hex(&Sha1::digest(data))
}

/// "45.4 GB" (decimal gigabytes, one digit after the point – like Windows Explorer rounds).
pub fn gb(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / 1e9)
}

#[cfg(test)]
mod tests {
    #[test]
    fn helpers() {
        assert_eq!(super::hex(&[0, 0xab, 0x10]), "00ab10");
        assert_eq!(super::sha1_hex(b""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(super::gb(45_400_000_000), "45.4 GB");
        assert_eq!(super::gb(12_349_999_999), "12.3 GB");
    }
}
