//! What a download has finished so far, so it can continue after Pause, a lost connection or a
//! closed launcher. Lives in the build folder: `<folder>\.rift-download\` (a download that Niobium
//! started keeps its `.niobium-download\` folder, see [`state_dir`]).
//!
//! - `job.json` – which build this folder belongs to (catalog key + manifest SHA-1).
//! - `manifest` – the verified manifest, so resuming and deleting work without the internet.
//! - `journal.jsonl` – one line per finished file: `{"path","size","sha1"}`.
//! - `progress.json` – for each half-written `<file>.part`: bytes safely on disk and the next part.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub const STATE_DIR: &str = ".rift-download";
/// The same folder from before the rename to Rift (Niobium). Only used if it is already there.
pub const LEGACY_STATE_DIR: &str = ".niobium-download";
const JOB_FILE: &str = "job.json";
const MANIFEST_FILE: &str = "manifest";
const JOURNAL_FILE: &str = "journal.jsonl";
const PROGRESS_FILE: &str = "progress.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobInfo {
    /// Catalog key, e.g. "18.30-CL-17882303"
    pub key: String,
    pub manifest_sha1: String,
}

/// A half-written file: `committed` bytes are flushed to disk; the next part to write is `next_part`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileProgress {
    pub committed: u64,
    pub next_part: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DoneLine {
    path: String,
    size: u64,
    sha1: String,
}

pub struct Journal {
    dir: PathBuf,
    done: HashMap<String, (u64, String)>,
    progress: BTreeMap<String, FileProgress>,
    /// The last line was cut off (no line end): the next line starts on a new line.
    needs_newline: bool,
}

/// `<root>\.rift-download`. A download Niobium started before the rename keeps using its
/// `.niobium-download` folder (as long as there is no `.rift-download`), so it can still go on and be
/// deleted like any other.
pub fn state_dir(root: &Path) -> PathBuf {
    let dir = root.join(STATE_DIR);
    if !dir.exists() {
        let legacy = root.join(LEGACY_STATE_DIR);
        if legacy.is_dir() {
            return legacy;
        }
    }
    dir
}

/// True for the name of the downloader's own folder (also the one from before the rename).
pub fn is_state_dir_name(name: &std::ffi::OsStr) -> bool {
    name == STATE_DIR || name == LEGACY_STATE_DIR
}

/// `job.json` of an earlier download in this folder (None if there is none or it's unreadable).
pub fn read_job(root: &Path) -> Option<JobInfo> {
    let bytes = fs::read(state_dir(root).join(JOB_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// The manifest saved by an earlier download in this folder.
pub fn read_saved_manifest(root: &Path) -> Option<Vec<u8>> {
    fs::read(state_dir(root).join(MANIFEST_FILE)).ok()
}

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut f = File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

impl Journal {
    /// Reads the journal of an earlier download, without creating anything. None if there is none.
    pub fn open_existing(root: &Path) -> io::Result<Option<Journal>> {
        let dir = state_dir(root);
        if !dir.join(JOB_FILE).is_file() {
            return Ok(None);
        }
        let mut done = HashMap::new();
        let mut needs_newline = false;
        if let Ok(text) = fs::read_to_string(dir.join(JOURNAL_FILE)) {
            needs_newline = !text.is_empty() && !text.ends_with('\n');
            // A line cut off by a crash is simply skipped – that file is downloaded again.
            for line in text.lines() {
                if let Ok(d) = serde_json::from_str::<DoneLine>(line) {
                    done.insert(d.path, (d.size, d.sha1));
                }
            }
        }
        let progress = fs::read(dir.join(PROGRESS_FILE))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Ok(Some(Journal { dir, done, progress, needs_newline }))
    }

    /// Starts a new journal (writes `job.json` and the manifest copy).
    pub fn create(root: &Path, job: &JobInfo, manifest: &[u8]) -> io::Result<Journal> {
        let dir = state_dir(root);
        fs::create_dir_all(&dir)?;
        write_atomic(&dir.join(MANIFEST_FILE), manifest)?;
        let json = serde_json::to_vec_pretty(job).map_err(io::Error::other)?;
        write_atomic(&dir.join(JOB_FILE), &json)?;
        Ok(Journal { dir, done: HashMap::new(), progress: BTreeMap::new(), needs_newline: false })
    }

    /// Saves the manifest copy if it is missing (journals from before it was kept).
    pub fn ensure_manifest(&self, manifest: &[u8]) -> io::Result<()> {
        let path = self.dir.join(MANIFEST_FILE);
        if path.is_file() {
            return Ok(());
        }
        write_atomic(&path, manifest)
    }

    /// True if the journal says the file is finished with this size.
    pub fn is_done(&self, path: &str, size: u64) -> bool {
        self.done.get(path).is_some_and(|(s, _)| *s == size)
    }

    pub fn done_count(&self) -> usize {
        self.done.len()
    }

    /// Size of all finished files together.
    pub fn done_bytes(&self) -> u64 {
        self.done.values().map(|(size, _)| size).sum()
    }

    /// Notes a finished file (and forgets its half-written state).
    pub fn mark_done(&mut self, path: &str, size: u64, sha1_hex: &str) -> io::Result<()> {
        let line = serde_json::to_string(&DoneLine { path: path.into(), size, sha1: sha1_hex.into() }).map_err(io::Error::other)?;
        let mut f = OpenOptions::new().create(true).append(true).open(self.dir.join(JOURNAL_FILE))?;
        if self.needs_newline {
            f.write_all(b"\n")?;
            self.needs_newline = false;
        }
        f.write_all(line.as_bytes())?;
        f.write_all(b"\n")?;
        f.sync_data()?;
        self.done.insert(path.into(), (size, sha1_hex.into()));
        if self.progress.remove(path).is_some() {
            self.save_progress()?;
        }
        Ok(())
    }

    pub fn progress(&self, path: &str) -> Option<FileProgress> {
        self.progress.get(path).copied()
    }

    pub fn set_progress(&mut self, path: &str, p: FileProgress) -> io::Result<()> {
        self.progress.insert(path.into(), p);
        self.save_progress()
    }

    pub fn clear_progress(&mut self, path: &str) -> io::Result<()> {
        if self.progress.remove(path).is_some() {
            self.save_progress()?;
        }
        Ok(())
    }

    fn save_progress(&self) -> io::Result<()> {
        let json = serde_json::to_vec(&self.progress).map_err(io::Error::other)?;
        write_atomic(&self.dir.join(PROGRESS_FILE), &json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rift-journal-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn download_started_by_niobium_keeps_its_folder() {
        let root = temp("legacy");
        assert_eq!(state_dir(&root), root.join(".rift-download"));
        // Niobium wrote the notes of an unfinished download into `.niobium-download`
        let job = JobInfo { key: "19.10-CL-18675304".into(), manifest_sha1: "abc".into() };
        let legacy = root.join(LEGACY_STATE_DIR);
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join(JOB_FILE), serde_json::to_vec(&job).unwrap()).unwrap();
        assert_eq!(state_dir(&root), legacy);
        assert_eq!(read_job(&root), Some(job));
        assert!(Journal::open_existing(&root).unwrap().is_some());
        assert!(is_state_dir_name(std::ffi::OsStr::new(".niobium-download")));
        assert!(is_state_dir_name(std::ffi::OsStr::new(".rift-download")));
        assert!(!is_state_dir_name(std::ffi::OsStr::new("FortniteGame")));
        // once the new folder exists, it wins
        fs::create_dir_all(root.join(STATE_DIR)).unwrap();
        assert_eq!(state_dir(&root), root.join(STATE_DIR));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn journal_round_trip() {
        let root = temp("rt");
        assert!(Journal::open_existing(&root).unwrap().is_none());
        assert!(read_job(&root).is_none());
        let job = JobInfo { key: "18.30-CL-17882303".into(), manifest_sha1: "abc".into() };
        let mut j = Journal::create(&root, &job, b"MANIFEST").unwrap();
        j.set_progress("a/b.pak", FileProgress { committed: 64, next_part: 3 }).unwrap();
        j.mark_done("x.txt", 10, "00ff").unwrap();
        assert!(j.is_done("x.txt", 10));
        assert!(!j.is_done("x.txt", 11));
        drop(j);

        assert_eq!(read_job(&root), Some(job.clone()));
        assert_eq!(read_saved_manifest(&root).unwrap(), b"MANIFEST");
        let mut j = Journal::open_existing(&root).unwrap().unwrap();
        assert!(j.is_done("x.txt", 10));
        assert_eq!(j.done_count(), 1);
        assert_eq!(j.done_bytes(), 10);
        assert_eq!(j.progress("a/b.pak"), Some(FileProgress { committed: 64, next_part: 3 }));
        j.mark_done("a/b.pak", 100, "11").unwrap();
        assert_eq!(j.progress("a/b.pak"), None);
        drop(j);
        let j = Journal::open_existing(&root).unwrap().unwrap();
        assert_eq!(j.progress("a/b.pak"), None);
        assert!(j.is_done("a/b.pak", 100));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn cut_off_line_is_skipped() {
        let root = temp("cut");
        let job = JobInfo { key: "k".into(), manifest_sha1: "s".into() };
        let mut j = Journal::create(&root, &job, b"m").unwrap();
        j.mark_done("one", 1, "aa").unwrap();
        // the launcher died in the middle of writing the next line
        let mut f = OpenOptions::new().append(true).open(state_dir(&root).join(JOURNAL_FILE)).unwrap();
        f.write_all(br#"{"path":"two","si"#).unwrap();
        drop(f);
        fs::write(state_dir(&root).join(PROGRESS_FILE), b"{broken").unwrap();
        let mut j = Journal::open_existing(&root).unwrap().unwrap();
        assert!(j.is_done("one", 1));
        assert!(!j.is_done("two", 2));
        assert_eq!(j.progress("anything"), None);
        // the next finished file still gets a clean line of its own
        j.mark_done("three", 3, "cc").unwrap();
        let j = Journal::open_existing(&root).unwrap().unwrap();
        assert!(j.is_done("one", 1) && j.is_done("three", 3));
        fs::remove_dir_all(&root).ok();
    }
}
