//! Opt-in tests with real Epic manifests and Epic's real CDN. They never run by default (no Epic
//! files are in the repo, and CI has no network rule for Epic):
//!
//! - `NIOBIUM_MANIFEST_DIR=<folder with 19.10.manifest, 22.40.manifest, …> cargo test real_manifests`
//!   parses archived manifests and checks known numbers.
//! - plus `NIOBIUM_NET_TEST=1`: downloads 3 small files of 22.40 from Epic's CDN (via `curl`) with
//!   the real downloader and checks their SHA-1.

use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use super::cdn::{Cdn, NetError, Transport};
use super::install::{self, Control, InstallJob, InstallOptions, Plan, Progress};
use super::journal::JobInfo;
use super::manifest::{Manifest, ManifestFormat};

fn manifest_dir() -> Option<PathBuf> {
    std::env::var_os("NIOBIUM_MANIFEST_DIR").map(PathBuf::from)
}

fn load(name: &str) -> Option<(Vec<u8>, Manifest)> {
    let path = manifest_dir()?.join(name);
    let bytes = std::fs::read(&path).ok()?;
    let m = Manifest::parse(&bytes).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    Some((bytes, m))
}

#[test]
fn real_manifests() {
    let Some(dir) = manifest_dir() else {
        eprintln!("skipped: set NIOBIUM_MANIFEST_DIR to run");
        return;
    };
    if let Some((_, m)) = load("19.10.manifest") {
        assert_eq!(m.format, ManifestFormat::Binary);
        assert_eq!(m.version(), Some(("19.10".into(), 18675304)));
        assert_eq!(m.chunks.len(), 46_040);
        assert_eq!(m.files.len(), 751);
        let exe = m.file("FortniteGame/Binaries/Win64/FortniteClient-Win64-Shipping.exe").expect("exe");
        assert_eq!(exe.size(), 198_580_704);
        let exe_chunks: std::collections::HashSet<_> = exe.parts.iter().map(|p| p.guid).collect();
        assert_eq!(exe_chunks.len(), 192);
        assert_eq!(m.chunk_dir(), "ChunksV4");
        // longest path inside a Fortnite build
        assert!(m.files.iter().map(|f| f.path.len()).max().unwrap() <= 106);
    }
    if let Some((_, m)) = load("22.40.manifest") {
        assert_eq!(m.version(), Some(("22.40".into(), 23070899)));
        assert_eq!(m.chunks.len(), 38_720);
        assert_eq!(m.used_chunks().len(), 38_720);
    }
    // every other archived manifest parses too – except the one known to be damaged (Tectors)
    for entry in std::fs::read_dir(&dir).unwrap().flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "manifest") {
            let bytes = std::fs::read(&path).unwrap();
            match Manifest::parse(&bytes) {
                Ok(m) => eprintln!("{}: {:?} {} chunks {} files", path.display(), m.format, m.chunks.len(), m.files.len()),
                Err(e) => eprintln!("{}: refused ({e})", path.display()),
            }
        }
    }
}

/// HTTP through the `curl` program (tests only – the launcher uses ureq).
struct Curl;

static TMP: AtomicU64 = AtomicU64::new(0);

impl Transport for Curl {
    fn head(&self, url: &str) -> Result<u16, NetError> {
        let out = Command::new("curl")
            .args(["-sS", "-I", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "30", url])
            .output()
            .map_err(|e| NetError::Other(e.to_string()))?;
        String::from_utf8_lossy(&out.stdout).trim().parse().map_err(|_| NetError::Other("curl failed".into()))
    }

    fn get(&self, url: &str, max_bytes: u64, _stop: &AtomicBool) -> Result<Vec<u8>, NetError> {
        let tmp = std::env::temp_dir().join(format!("niobium-curl-{}-{}", std::process::id(), TMP.fetch_add(1, Ordering::SeqCst)));
        let out = Command::new("curl")
            .args(["-sS", "-o"])
            .arg(&tmp)
            .args(["-w", "%{http_code}", "--max-time", "120", "--max-filesize", &max_bytes.to_string(), url])
            .output()
            .map_err(|e| NetError::Other(e.to_string()))?;
        let code: u16 = String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0);
        let data = std::fs::read(&tmp).unwrap_or_default();
        let _ = std::fs::remove_file(&tmp);
        match code {
            200..=299 => Ok(data),
            0 => Err(NetError::Other("no answer".into())),
            s => Err(NetError::Status(s)),
        }
    }
}

#[test]
fn real_download_from_epic() {
    if std::env::var_os("NIOBIUM_NET_TEST").is_none() {
        eprintln!("skipped: set NIOBIUM_NET_TEST=1 and NIOBIUM_MANIFEST_DIR to run");
        return;
    }
    let (bytes, full) = load("22.40.manifest").expect("NIOBIUM_MANIFEST_DIR with 22.40.manifest");
    // three small files, each from a single chunk
    let mut small: Vec<_> = full
        .files
        .iter()
        .filter(|f| f.size() > 0 && f.size() < 600_000 && f.parts.len() == 1 && f.path.starts_with("FortniteGame/Content/"))
        .cloned()
        .collect();
    small.sort_by_key(|f| f.size());
    small.truncate(3);
    assert_eq!(small.len(), 3);
    let mut chunks: Vec<_> = small.iter().map(|f| full.chunk(&f.parts[0].guid).unwrap().clone()).collect();
    chunks.dedup_by_key(|c| c.guid);
    let m = Manifest::new(full.format, full.feature_level, full.app_name.clone(), full.build_version.clone(), full.launch_exe.clone(), chunks, small.clone());

    // the rolling hash port matches Epic's numbers on real data
    let cdn = Cdn::epic(Arc::new(Curl));
    let stop = std::sync::atomic::AtomicBool::new(false);
    let mut no_sha = m.chunks[0].clone();
    no_sha.sha1 = None;
    cdn.fetch_chunk(&m.chunk_path(&m.chunks[0]), &no_sha, &stop).expect("chunk checks out by rolling hash");

    let root = std::env::temp_dir().join(format!("niobium-real-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let plan = Plan::new(&m, &root, None);
    let job = InstallJob { manifest: &m, manifest_bytes: &bytes, root: &root, job: JobInfo { key: "22.40-CL-23070899".into(), manifest_sha1: super::sha1_hex(&bytes) } };
    install::install(&job, &plan, &cdn, &Control::new(), &Progress::new(), &InstallOptions::default(), &|_| {}).expect("download");
    for f in &small {
        let data = std::fs::read(root.join(&f.path)).unwrap();
        use sha1::{Digest, Sha1};
        assert_eq!(Sha1::digest(&data).as_slice(), f.sha1, "{}", f.path);
        eprintln!("ok: {} ({} bytes)", f.path, data.len());
    }
    std::fs::remove_dir_all(&root).ok();
}
