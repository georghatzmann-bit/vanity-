//! Downloads a build into a folder: full check first, then the files, then a last check.
//!
//! - **Check:** a HEAD request for every chunk still needed (32 at a time). Any missing chunk stops
//!   the download before a single byte is written.
//! - **Download:** 16 HTTP workers fetch and check chunks; 4 assemblers each write one file at a time,
//!   strictly in order, into `<file>.part`, with up to 8 chunks fetched ahead. A chunk that two
//!   files share is simply downloaded twice (about 1 % extra, no cache needed).
//! - Every 64 MiB a file's progress is flushed to disk and noted in the journal. At the end of a
//!   file its SHA-1 is checked; then it is renamed and added to the journal. A damaged file is
//!   downloaded once more.
//! - **Pause / cancel / errors:** every worker stops between chunks (a chunk still arriving is
//!   dropped), half-written files keep their committed bytes, and the next start continues there.

use std::collections::{HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use sha1::{Digest, Sha1};

use super::cdn::{Cdn, FetchError};
use super::errors::DownloadError;
use super::journal::{FileProgress, JobInfo, Journal};
use super::manifest::{FileEntry, Manifest};
use super::pathsafe;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Checking,
    Downloading,
    Verifying,
    Importing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    Pause,
    Cancel,
}

/// Pause and Cancel buttons of one download.
#[derive(Debug, Default)]
pub struct Control {
    /// 0 = run, 1 = pause, 2 = cancel
    state: AtomicU8,
    /// Set together with `state` (and on errors), checked by every worker.
    stop: AtomicBool,
}

impl Control {
    pub fn new() -> Control {
        Control::default()
    }

    pub fn pause(&self) {
        let _ = self.state.compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst);
        self.stop.store(true, Ordering::SeqCst);
    }

    pub fn cancel(&self) {
        self.state.store(2, Ordering::SeqCst);
        self.stop.store(true, Ordering::SeqCst);
    }

    /// Stops every worker after an error (no pause/cancel reason). A `Control` is used for one run.
    pub fn halt(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }

    pub fn reason(&self) -> Option<StopReason> {
        match self.state.load(Ordering::SeqCst) {
            1 => Some(StopReason::Pause),
            2 => Some(StopReason::Cancel),
            _ => None,
        }
    }

    pub fn stop_flag(&self) -> &AtomicBool {
        &self.stop
    }

    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }
}

/// What a running download reports (read by the launcher every 500 ms).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressInfo {
    pub phase: Phase,
    /// Checking: bytes of the chunks checked; downloading: bytes downloaded.
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub files_done: u64,
    pub files_total: u64,
    pub current_file: String,
}

#[derive(Debug, Default)]
pub struct Progress {
    phase: AtomicU8,
    bytes_done: AtomicU64,
    bytes_total: AtomicU64,
    files_done: AtomicU64,
    files_total: AtomicU64,
    current: Mutex<String>,
}

impl Progress {
    pub fn new() -> Progress {
        Progress::default()
    }

    pub fn set_phase(&self, p: Phase) {
        self.phase.store(p as u8, Ordering::SeqCst);
    }

    pub fn phase(&self) -> Phase {
        match self.phase.load(Ordering::SeqCst) {
            0 => Phase::Checking,
            1 => Phase::Downloading,
            2 => Phase::Verifying,
            _ => Phase::Importing,
        }
    }

    pub fn set_bytes(&self, done: u64, total: u64) {
        self.bytes_done.store(done, Ordering::SeqCst);
        self.bytes_total.store(total, Ordering::SeqCst);
    }

    pub fn add_bytes(&self, n: u64) {
        self.bytes_done.fetch_add(n, Ordering::SeqCst);
    }

    pub fn set_files(&self, done: u64, total: u64) {
        self.files_done.store(done, Ordering::SeqCst);
        self.files_total.store(total, Ordering::SeqCst);
    }

    fn file_done(&self) {
        self.files_done.fetch_add(1, Ordering::SeqCst);
    }

    pub fn set_current(&self, name: &str) {
        *self.current.lock().unwrap() = name.to_string();
    }

    pub fn snapshot(&self) -> ProgressInfo {
        ProgressInfo {
            phase: self.phase(),
            bytes_done: self.bytes_done.load(Ordering::SeqCst),
            bytes_total: self.bytes_total.load(Ordering::SeqCst),
            files_done: self.files_done.load(Ordering::SeqCst),
            files_total: self.files_total.load(Ordering::SeqCst),
            current_file: self.current.lock().unwrap().clone(),
        }
    }
}

/// Speed over the last few seconds (default 5 s) and the time left.
#[derive(Debug)]
pub struct SpeedMeter {
    window: Duration,
    samples: VecDeque<(Instant, u64)>,
}

impl SpeedMeter {
    pub fn new(window: Duration) -> SpeedMeter {
        SpeedMeter { window, samples: VecDeque::new() }
    }

    /// Adds a reading (bytes done so far) and returns bytes per second.
    pub fn push(&mut self, now: Instant, bytes_done: u64) -> u64 {
        // a reset (new phase) starts over
        if self.samples.back().is_some_and(|(_, b)| *b > bytes_done) {
            self.samples.clear();
        }
        self.samples.push_back((now, bytes_done));
        while self.samples.len() > 2 && now.duration_since(self.samples[1].0) >= self.window {
            self.samples.pop_front();
        }
        let (t0, b0) = self.samples[0];
        let secs = now.duration_since(t0).as_secs_f64();
        if secs < 0.2 {
            return 0;
        }
        ((bytes_done - b0) as f64 / secs) as u64
    }

    /// Seconds left at this speed (None while the speed is unknown).
    pub fn eta(remaining: u64, speed: u64) -> Option<u64> {
        (speed > 0).then(|| remaining.div_ceil(speed))
    }
}

#[derive(Debug, Clone)]
pub struct InstallOptions {
    pub http_workers: usize,
    pub assemblers: usize,
    /// Chunks each assembler fetches ahead.
    pub window: usize,
    pub check_workers: usize,
    /// Progress is flushed to disk and noted after this many bytes of a file.
    pub commit_every: u64,
}

impl Default for InstallOptions {
    fn default() -> Self {
        InstallOptions { http_workers: 16, assemblers: 4, window: 8, check_workers: 32, commit_every: 64 << 20 }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallError {
    /// How many chunks Epic no longer has (the check stops at the first, so usually 1).
    ChunksMissing(usize),
    EpicBlocked,
    Network(String),
    WriteFailed(String),
    /// A file was still damaged after a second download.
    VerifyFailed(String),
    Stopped(StopReason),
}

impl InstallError {
    pub fn to_download_error(&self) -> DownloadError {
        match self {
            InstallError::ChunksMissing(_) => DownloadError::chunks_missing(),
            InstallError::EpicBlocked => DownloadError::epic_blocked(),
            InstallError::Network(_) | InstallError::Stopped(_) => DownloadError::network(),
            InstallError::WriteFailed(_) => DownloadError::write_failed(),
            InstallError::VerifyFailed(_) => DownloadError::verify_failed(),
        }
    }
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstallError::ChunksMissing(n) => write!(f, "{n} chunk(s) missing on Epic's CDN"),
            InstallError::EpicBlocked => write!(f, "Epic's CDN refused (403)"),
            InstallError::Network(e) => write!(f, "network: {e}"),
            InstallError::WriteFailed(e) => write!(f, "write: {e}"),
            InstallError::VerifyFailed(p) => write!(f, "still damaged: {p}"),
            InstallError::Stopped(r) => write!(f, "stopped ({r:?})"),
        }
    }
}

/// Things worth a line in the live log while the download keeps going.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Notice {
    /// A finished file had the wrong SHA-1 and is downloaded again.
    Redownloading(String),
}

fn write_err(e: io::Error, what: &Path) -> InstallError {
    InstallError::WriteFailed(format!("{}: {e}", what.display()))
}

/// One file still to do.
#[derive(Debug, Clone)]
struct Todo {
    file: usize,
    resume: Option<FileProgress>,
}

/// What is left to do in a folder, worked out from the journal and the files on disk.
#[derive(Debug, Clone)]
pub struct Plan {
    todo: Vec<Todo>,
    pub files_total: u64,
    pub files_done: u64,
    /// Download bytes (chunks, counted each time a file fetches them).
    pub bytes_total: u64,
    pub bytes_done: u64,
    /// File bytes still to write (for the free-space check).
    pub remaining_bytes: u64,
}

/// Chunk indexes a file fetches from part `from` on (one fetch per run of parts on the same chunk).
fn fetch_list(m: &Manifest, f: &FileEntry, from: usize) -> Vec<usize> {
    let mut out: Vec<usize> = Vec::new();
    for p in f.parts.iter().skip(from) {
        let i = m.chunk_index(&p.guid).expect("validated manifest");
        if out.last() != Some(&i) {
            out.push(i);
        }
    }
    out
}

fn fetch_bytes(m: &Manifest, list: &[usize]) -> u64 {
    list.iter().map(|&i| m.chunks[i].file_size).sum()
}

fn part_path(final_path: &Path) -> PathBuf {
    let mut s = final_path.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

impl Plan {
    pub fn new(m: &Manifest, root: &Path, journal: Option<&Journal>) -> Plan {
        let mut plan = Plan { todo: vec![], files_total: m.files.len() as u64, files_done: 0, bytes_total: 0, bytes_done: 0, remaining_bytes: 0 };
        for (i, f) in m.files.iter().enumerate() {
            let size = f.size();
            let full = fetch_bytes(m, &fetch_list(m, f, 0));
            plan.bytes_total += full;
            let Ok(path) = pathsafe::safe_join(root, &f.path) else {
                plan.todo.push(Todo { file: i, resume: None });
                plan.remaining_bytes += size;
                continue;
            };
            let done = journal.is_some_and(|j| j.is_done(&f.path, size))
                && fs::metadata(&path).is_ok_and(|md| md.is_file() && md.len() == size);
            if done {
                plan.files_done += 1;
                plan.bytes_done += full;
                continue;
            }
            // a half-written file continues where its committed bytes end
            let resume = journal.and_then(|j| j.progress(&f.path)).filter(|p| {
                p.next_part <= f.parts.len()
                    && p.committed == f.parts[..p.next_part].iter().map(|x| x.size as u64).sum::<u64>()
                    && fs::metadata(part_path(&path)).is_ok_and(|md| md.len() >= p.committed)
            });
            if let Some(r) = resume {
                plan.bytes_done += full - fetch_bytes(m, &fetch_list(m, f, r.next_part));
                plan.remaining_bytes += size - r.committed;
            } else {
                plan.remaining_bytes += size;
            }
            plan.todo.push(Todo { file: i, resume });
        }
        plan
    }

    pub fn is_complete(&self) -> bool {
        self.todo.is_empty()
    }

    /// The chunks the files still to do need, each once.
    pub fn chunks_to_check(&self, m: &Manifest) -> Vec<usize> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for t in &self.todo {
            let from = t.resume.map(|r| r.next_part).unwrap_or(0);
            for i in fetch_list(m, &m.files[t.file], from) {
                if seen.insert(i) {
                    out.push(i);
                }
            }
        }
        out
    }
}

/// Step 1: HEAD request for every chunk still needed. Stops at the first missing one.
pub fn precheck(m: &Manifest, plan: &Plan, cdn: &Cdn, control: &Control, progress: &Progress, opts: &InstallOptions) -> Result<(), InstallError> {
    progress.set_phase(Phase::Checking);
    progress.set_current("");
    let chunks = plan.chunks_to_check(m);
    let total: u64 = chunks.iter().map(|&i| m.chunks[i].file_size).sum();
    progress.set_bytes(0, total);
    progress.set_files(plan.files_done, plan.files_total);
    let next = AtomicUsize::new(0);
    let failure: Mutex<Option<InstallError>> = Mutex::new(None);
    let abort = AtomicBool::new(false);
    std::thread::scope(|s| {
        for _ in 0..opts.check_workers.max(1).min(chunks.len().max(1)) {
            s.spawn(|| loop {
                if abort.load(Ordering::SeqCst) || control.stopped() {
                    return;
                }
                let n = next.fetch_add(1, Ordering::SeqCst);
                let Some(&i) = chunks.get(n) else { return };
                let c = &m.chunks[i];
                // the stop flag of the job plus our own (first failure stops the others)
                let result = cdn.check_chunk(&m.chunk_path(c), control.stop_flag());
                let err = match result {
                    Ok(()) => {
                        progress.add_bytes(c.file_size);
                        continue;
                    }
                    Err(FetchError::Missing) => InstallError::ChunksMissing(1),
                    Err(FetchError::Blocked) => InstallError::EpicBlocked,
                    Err(FetchError::Stopped) => return,
                    Err(FetchError::Network(e)) | Err(FetchError::Damaged(e)) => InstallError::Network(e),
                };
                let mut f = failure.lock().unwrap();
                // a missing chunk is the most important news
                if f.is_none() || matches!(err, InstallError::ChunksMissing(_)) {
                    *f = Some(err);
                }
                abort.store(true, Ordering::SeqCst);
                drop(f);
                // workers waiting between retries stop at once
                control.halt();
                return;
            });
        }
    });
    if let Some(e) = failure.into_inner().unwrap() {
        return Err(e);
    }
    if let Some(r) = control.reason() {
        return Err(InstallError::Stopped(r));
    }
    Ok(())
}

struct FetchReq {
    chunk: usize,
    reply: SyncSender<Result<Vec<u8>, FetchError>>,
}

struct Shared<'a> {
    m: &'a Manifest,
    root: &'a Path,
    journal: Mutex<Journal>,
    control: &'a Control,
    progress: &'a Progress,
    opts: &'a InstallOptions,
    notice: &'a (dyn Fn(Notice) + Sync),
    /// First error of any worker (the others stop).
    failure: Mutex<Option<InstallError>>,
    failed: AtomicBool,
}

impl Shared<'_> {
    fn fail(&self, e: InstallError) {
        let mut f = self.failure.lock().unwrap();
        if f.is_none() {
            *f = Some(e);
        }
        self.failed.store(true, Ordering::SeqCst);
        self.control.halt();
    }

    fn should_stop(&self) -> bool {
        self.failed.load(Ordering::SeqCst) || self.control.stopped()
    }
}

fn fetch_error(e: FetchError) -> InstallError {
    match e {
        FetchError::Missing => InstallError::ChunksMissing(1),
        FetchError::Blocked => InstallError::EpicBlocked,
        FetchError::Network(e) => InstallError::Network(e),
        FetchError::Damaged(e) => InstallError::Network(format!("damaged chunk: {e}")),
        FetchError::Stopped => InstallError::Stopped(StopReason::Pause),
    }
}

enum FileResult {
    Done,
    Stopped,
    Damaged,
}

/// Writes one file (one try). Returns Stopped when pause/cancel/another error came in between.
fn write_file(sh: &Shared, tx: &mpsc::Sender<FetchReq>, f: &FileEntry, final_path: &Path, resume: Option<FileProgress>) -> Result<FileResult, InstallError> {
    let part = part_path(final_path);
    if let Some(dir) = final_path.parent() {
        fs::create_dir_all(dir).map_err(|e| write_err(e, dir))?;
    }
    let file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&part).map_err(|e| write_err(e, &part))?;
    let mut hasher = Sha1::new();
    let (start_part, mut written) = match resume {
        Some(r) => (r.next_part, r.committed),
        None => (0, 0),
    };
    file.set_len(written).map_err(|e| write_err(e, &part))?;
    let mut file = file;
    if written > 0 {
        // the SHA-1 covers the whole file: read the part that is already there
        file.seek(SeekFrom::Start(0)).map_err(|e| write_err(e, &part))?;
        let mut buf = vec![0u8; 1 << 20];
        let mut left = written;
        while left > 0 {
            let n = file.read(&mut buf[..left.min(1 << 20) as usize]).map_err(|e| write_err(e, &part))?;
            if n == 0 {
                return Err(InstallError::WriteFailed(format!("{}: shorter than noted", part.display())));
            }
            hasher.update(&buf[..n]);
            left -= n as u64;
        }
    }
    file.seek(SeekFrom::Start(written)).map_err(|e| write_err(e, &part))?;
    let mut out = BufWriter::with_capacity(1 << 20, file);

    let fetches = fetch_list(sh.m, f, start_part);
    let mut requested = 0usize;
    let mut inflight: VecDeque<Receiver<Result<Vec<u8>, FetchError>>> = VecDeque::new();
    let mut current: Option<(usize, Vec<u8>)> = None;
    let mut since_commit = 0u64;

    let commit = |out: &mut BufWriter<File>, written: u64, next_part: usize| -> Result<(), InstallError> {
        out.flush().map_err(|e| write_err(e, &part))?;
        out.get_ref().sync_data().map_err(|e| write_err(e, &part))?;
        sh.journal
            .lock()
            .unwrap()
            .set_progress(&f.path, FileProgress { committed: written, next_part })
            .map_err(|e| write_err(e, &part))
    };

    for (i, p) in f.parts.iter().enumerate().skip(start_part) {
        if sh.should_stop() {
            commit(&mut out, written, i)?;
            return Ok(FileResult::Stopped);
        }
        let ci = sh.m.chunk_index(&p.guid).expect("validated manifest");
        if current.as_ref().map(|c| c.0) != Some(ci) {
            while inflight.len() < sh.opts.window.max(1) && requested < fetches.len() {
                let (reply, rx) = mpsc::sync_channel(1);
                if tx.send(FetchReq { chunk: fetches[requested], reply }).is_err() {
                    break;
                }
                inflight.push_back(rx);
                requested += 1;
            }
            let rx = inflight.pop_front().expect("a fetch for every chunk change");
            // wait for the chunk, but notice Pause/Cancel/another error while waiting
            let reply = loop {
                match rx.recv_timeout(Duration::from_millis(200)) {
                    Ok(r) => break Some(r),
                    Err(RecvTimeoutError::Timeout) if !sh.should_stop() => continue,
                    Err(_) => break None,
                }
            };
            match reply {
                Some(Ok(data)) => {
                    sh.progress.add_bytes(sh.m.chunks[ci].file_size);
                    current = Some((ci, data));
                }
                Some(Err(FetchError::Stopped)) | None => {
                    commit(&mut out, written, i)?;
                    return Ok(FileResult::Stopped);
                }
                Some(Err(e)) => {
                    commit(&mut out, written, i)?;
                    return Err(fetch_error(e));
                }
            }
        }
        let data = &current.as_ref().unwrap().1;
        let (start, end) = (p.offset as usize, p.offset as usize + p.size as usize);
        if end > data.len() {
            commit(&mut out, written, i)?;
            return Err(InstallError::Network(format!("chunk {} is smaller than the manifest says", ci)));
        }
        out.write_all(&data[start..end]).map_err(|e| write_err(e, &part))?;
        hasher.update(&data[start..end]);
        written += p.size as u64;
        since_commit += p.size as u64;
        if since_commit >= sh.opts.commit_every {
            commit(&mut out, written, i + 1)?;
            since_commit = 0;
        }
    }
    out.flush().map_err(|e| write_err(e, &part))?;
    out.get_ref().sync_all().map_err(|e| write_err(e, &part))?;
    drop(out);

    if hasher.finalize().as_slice() != f.sha1 {
        let _ = fs::remove_file(&part);
        sh.journal.lock().unwrap().clear_progress(&f.path).map_err(|e| write_err(e, &part))?;
        return Ok(FileResult::Damaged);
    }
    if final_path.exists() {
        fs::remove_file(final_path).map_err(|e| write_err(e, final_path))?;
    }
    fs::rename(&part, final_path).map_err(|e| write_err(e, final_path))?;
    sh.journal
        .lock()
        .unwrap()
        .mark_done(&f.path, f.size(), &super::hex(&f.sha1))
        .map_err(|e| write_err(e, final_path))?;
    Ok(FileResult::Done)
}

/// One assembler: takes the next file, writes it (a damaged file gets one more try).
fn assembler(sh: &Shared, queue: &Mutex<VecDeque<Todo>>, tx: mpsc::Sender<FetchReq>) {
    loop {
        if sh.should_stop() {
            return;
        }
        let Some(todo) = queue.lock().unwrap().pop_front() else { return };
        let f = &sh.m.files[todo.file];
        let final_path = match pathsafe::safe_join(sh.root, &f.path) {
            Ok(p) => p,
            Err(e) => return sh.fail(InstallError::WriteFailed(format!("{}: {e}", f.path))),
        };
        sh.progress.set_current(&f.path);
        let mut resume = todo.resume;
        let mut tries = 0;
        loop {
            tries += 1;
            match write_file(sh, &tx, f, &final_path, resume) {
                Ok(FileResult::Done) => {
                    sh.progress.file_done();
                    break;
                }
                Ok(FileResult::Stopped) => return,
                Ok(FileResult::Damaged) if tries < 2 => {
                    (sh.notice)(Notice::Redownloading(f.path.clone()));
                    // the bytes of the first try were counted already: count the new try on top
                    sh.progress.bytes_total.fetch_add(fetch_bytes(sh.m, &fetch_list(sh.m, f, 0)), Ordering::SeqCst);
                    resume = None;
                }
                Ok(FileResult::Damaged) => return sh.fail(InstallError::VerifyFailed(f.path.clone())),
                Err(e) => return sh.fail(e),
            }
        }
    }
}

/// HTTP worker: fetches and checks chunks for the assemblers.
fn http_worker(sh: &Shared, cdn: &Cdn, rx: &Mutex<Receiver<FetchReq>>) {
    loop {
        let req = { rx.lock().unwrap().recv() };
        let Ok(req) = req else { return };
        let result = if sh.should_stop() {
            Err(FetchError::Stopped)
        } else {
            let c = &sh.m.chunks[req.chunk];
            cdn.fetch_chunk(&sh.m.chunk_path(c), c, sh.control.stop_flag())
        };
        let _ = req.reply.send(result);
    }
}

/// Step 2: downloads every file still to do.
#[allow(clippy::too_many_arguments)]
pub fn download(
    m: &Manifest,
    root: &Path,
    plan: &Plan,
    journal: Journal,
    cdn: &Cdn,
    control: &Control,
    progress: &Progress,
    opts: &InstallOptions,
    notice: &(dyn Fn(Notice) + Sync),
) -> Result<(), InstallError> {
    progress.set_phase(Phase::Downloading);
    progress.set_bytes(plan.bytes_done, plan.bytes_total);
    progress.set_files(plan.files_done, plan.files_total);
    let sh = Shared {
        m,
        root,
        journal: Mutex::new(journal),
        control,
        progress,
        opts,
        notice,
        failure: Mutex::new(None),
        failed: AtomicBool::new(false),
    };
    let queue = Mutex::new(plan.todo.iter().cloned().collect::<VecDeque<_>>());
    let (tx, rx) = mpsc::channel::<FetchReq>();
    let rx = Mutex::new(rx);
    std::thread::scope(|s| {
        for _ in 0..opts.http_workers.max(1) {
            s.spawn(|| http_worker(&sh, cdn, &rx));
        }
        let mut assemblers = Vec::new();
        for _ in 0..opts.assemblers.max(1) {
            let tx = tx.clone();
            assemblers.push(s.spawn(|| assembler(&sh, &queue, tx)));
        }
        drop(tx);
        for a in assemblers {
            if a.join().is_err() {
                sh.fail(InstallError::WriteFailed("a download thread crashed".into()));
            }
        }
        // the assemblers' senders are gone now, so the HTTP workers end by themselves
    });
    progress.set_current("");
    if let Some(e) = sh.failure.into_inner().unwrap() {
        return Err(e);
    }
    if let Some(r) = control.reason() {
        return Err(InstallError::Stopped(r));
    }
    Ok(())
}

/// Step 3: every file is there with the right size, and the journal has it.
pub fn verify(m: &Manifest, root: &Path, progress: &Progress) -> Result<(), InstallError> {
    progress.set_phase(Phase::Verifying);
    let journal = Journal::open_existing(root).map_err(|e| write_err(e, root))?;
    let total = m.files.len() as u64;
    progress.set_files(0, total);
    progress.set_bytes(0, m.installed_bytes());
    for f in &m.files {
        progress.set_current(&f.path);
        let path = pathsafe::safe_join(root, &f.path).map_err(|e| InstallError::WriteFailed(format!("{}: {e}", f.path)))?;
        let ok = fs::metadata(&path).is_ok_and(|md| md.is_file() && md.len() == f.size())
            && journal.as_ref().is_some_and(|j| j.is_done(&f.path, f.size()));
        if !ok {
            return Err(InstallError::VerifyFailed(f.path.clone()));
        }
        progress.add_bytes(f.size());
        progress.file_done();
    }
    progress.set_current("");
    Ok(())
}

/// A whole download job for the engine.
pub struct InstallJob<'a> {
    pub manifest: &'a Manifest,
    /// The manifest file as downloaded (kept in the journal folder).
    pub manifest_bytes: &'a [u8],
    pub root: &'a Path,
    pub job: JobInfo,
}

/// Check → download → verify. `plan` comes from [`Plan::new`] (the launcher checks the free space
/// with it first). Nothing is written before the check has passed.
#[allow(clippy::too_many_arguments)]
pub fn install(
    job: &InstallJob,
    plan: &Plan,
    cdn: &Cdn,
    control: &Control,
    progress: &Progress,
    opts: &InstallOptions,
    notice: &(dyn Fn(Notice) + Sync),
) -> Result<(), InstallError> {
    precheck(job.manifest, plan, cdn, control, progress, opts)?;
    let journal = match Journal::open_existing(job.root).map_err(|e| write_err(e, job.root))? {
        Some(j) => {
            j.ensure_manifest(job.manifest_bytes).map_err(|e| write_err(e, job.root))?;
            j
        }
        None => Journal::create(job.root, &job.job, job.manifest_bytes).map_err(|e| write_err(e, job.root))?,
    };
    download(job.manifest, job.root, plan, journal, cdn, control, progress, opts, notice)?;
    verify(job.manifest, job.root, progress)
}

/// Cancel + "Delete the downloaded files": removes the build's files (finished and `.part`), the
/// journal folder, and every folder that is empty afterwards – nothing else.
pub fn delete_download(root: &Path, manifest: Option<&Manifest>) -> io::Result<()> {
    let mut dirs: HashSet<PathBuf> = HashSet::new();
    if let Some(m) = manifest {
        for f in &m.files {
            let Ok(path) = pathsafe::safe_join(root, &f.path) else { continue };
            let _ = fs::remove_file(&path);
            let _ = fs::remove_file(part_path(&path));
            let mut d = path.parent();
            while let Some(dir) = d {
                if dir == root || !dir.starts_with(root) {
                    break;
                }
                dirs.insert(dir.to_path_buf());
                d = dir.parent();
            }
        }
    }
    let state = super::journal::state_dir(root);
    if state.exists() {
        fs::remove_dir_all(&state)?;
    }
    // deepest folders first; remove_dir only removes empty ones
    let mut dirs: Vec<PathBuf> = dirs.into_iter().collect();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    for d in dirs {
        let _ = fs::remove_dir(&d);
    }
    let _ = fs::remove_dir(root);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::epic::cdn::mock::MockCdn;
    use crate::epic::cdn::{RetryPolicy, CDN_HOSTS};
    use crate::epic::fixtures::{self, encode_chunk, FixtureChunk, FixtureFile};
    use std::sync::Arc;

    struct Build {
        manifest: Manifest,
        bytes: Vec<u8>,
        files: Vec<FixtureFile>,
        cdn: Arc<MockCdn>,
    }

    /// A small build: 6 chunks, 5 files (one empty, one shared chunk, a big multi-chunk file).
    fn build() -> Build {
        let chunks: Vec<FixtureChunk> = (1..=6).map(|i| FixtureChunk::new(i, 3000 + i as usize * 500)).collect();
        let files = vec![
            FixtureFile::new("FortniteGame/Binaries/Win64/FortniteClient-Win64-Shipping.exe", vec![
                (&chunks[0], 0, 3500),
                (&chunks[1], 0, 4000),
                (&chunks[2], 100, 4000),
                (&chunks[3], 0, 5000),
            ]),
            FixtureFile::new("FortniteGame/Content/Paks/pakchunk0-WindowsClient.pak", vec![
                (&chunks[4], 0, 5500),
                (&chunks[5], 0, 3000),
                (&chunks[5], 3000, 3000),
            ]),
            // shares chunk 2 with the exe: downloaded twice
            FixtureFile::new("FortniteGame/Content/Paks/small.sig", vec![(&chunks[2], 0, 100)]),
            FixtureFile::new("Engine/empty.ini", vec![]),
            FixtureFile::new("FortniteGame/Content/Paks/two-slices.utoc", vec![(&chunks[0], 0, 10), (&chunks[0], 20, 10)]),
        ];
        let bytes = fixtures::binary_manifest(17, "++Fortnite+Release-18.30-CL-17882303-Windows", &chunks, &files, true);
        let manifest = Manifest::parse(&bytes).unwrap();
        let cdn = Arc::new(MockCdn::default());
        for c in &chunks {
            let info = manifest.chunk(&c.guid).unwrap();
            cdn.files.lock().unwrap().insert(manifest.chunk_path(info), encode_chunk(c, 3, true));
        }
        Build { manifest, bytes, files, cdn }
    }

    fn cdn(t: Arc<MockCdn>) -> Cdn {
        Cdn {
            transport: t,
            hosts: CDN_HOSTS.iter().map(|h| h.to_string()).collect(),
            policy: RetryPolicy { tries: 7, backoff_min: Duration::from_millis(1), backoff_max: Duration::from_millis(5) },
        }
    }

    fn opts() -> InstallOptions {
        // tiny commit size so the resume path is used inside small files
        InstallOptions { http_workers: 3, assemblers: 2, window: 2, check_workers: 4, commit_every: 4000 }
    }

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rift-install-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn job<'a>(b: &'a Build, root: &'a Path) -> InstallJob<'a> {
        InstallJob { manifest: &b.manifest, manifest_bytes: &b.bytes, root, job: JobInfo { key: "18.30-CL-17882303".into(), manifest_sha1: crate::epic::sha1_hex(&b.bytes) } }
    }

    fn run(b: &Build, root: &Path, control: &Control, notices: &Mutex<Vec<Notice>>) -> Result<(), InstallError> {
        let existing = Journal::open_existing(root).unwrap();
        let plan = Plan::new(&b.manifest, root, existing.as_ref());
        drop(existing);
        let notice = |n: Notice| notices.lock().unwrap().push(n);
        install(&job(b, root), &plan, &cdn(b.cdn.clone()), control, &Progress::new(), &opts(), &notice)
    }

    fn assert_files(b: &Build, root: &Path) {
        for f in &b.files {
            let data = fs::read(pathsafe::safe_join(root, &f.path).unwrap()).unwrap();
            assert_eq!(data, f.content, "{}", f.path);
        }
    }

    #[test]
    fn full_download() {
        let b = build();
        let root = temp("full");
        let notices = Mutex::new(vec![]);
        let progress = Progress::new();
        let plan = Plan::new(&b.manifest, &root, None);
        assert_eq!(plan.files_total, 5);
        assert_eq!(plan.remaining_bytes, b.manifest.installed_bytes());
        let notice = |n: Notice| notices.lock().unwrap().push(n);
        install(&job(&b, &root), &plan, &cdn(b.cdn.clone()), &Control::new(), &progress, &opts(), &notice).unwrap();
        assert_files(&b, &root);
        let p = progress.snapshot();
        assert_eq!(p.phase, Phase::Verifying);
        assert_eq!((p.files_done, p.files_total), (5, 5));
        // no .part files left
        assert!(walk(&root).iter().all(|p| !p.to_string_lossy().ends_with(".part")));
        // a second run finds everything done and downloads nothing
        let gets = b.cdn.gets.load(Ordering::SeqCst);
        let j = Journal::open_existing(&root).unwrap();
        let plan = Plan::new(&b.manifest, &root, j.as_ref());
        assert!(plan.is_complete());
        assert_eq!(plan.bytes_done, plan.bytes_total);
        run(&b, &root, &Control::new(), &notices).unwrap();
        assert_eq!(b.cdn.gets.load(Ordering::SeqCst), gets);
        assert!(notices.lock().unwrap().is_empty());
        fs::remove_dir_all(&root).ok();
    }

    fn walk(dir: &Path) -> Vec<PathBuf> {
        let mut out = vec![];
        if let Ok(rd) = fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    out.extend(walk(&p));
                } else {
                    out.push(p);
                }
            }
        }
        out
    }

    #[test]
    fn missing_chunk_stops_before_writing() {
        let b = build();
        let gone = b.manifest.chunk_path(&b.manifest.chunks[3]);
        b.cdn.files.lock().unwrap().remove(&gone);
        let root = temp("missing");
        let err = run(&b, &root, &Control::new(), &Mutex::new(vec![])).unwrap_err();
        assert_eq!(err, InstallError::ChunksMissing(1));
        assert_eq!(err.to_download_error().code, "CHUNKS_MISSING");
        assert!(!root.exists(), "nothing may be written");
        assert_eq!(b.cdn.gets.load(Ordering::SeqCst), 0, "no chunk downloaded");
    }

    #[test]
    fn blocked_cdn() {
        let b = build();
        for h in CDN_HOSTS {
            b.cdn.host_status.lock().unwrap().insert(h.into(), 403);
        }
        let root = temp("blocked");
        assert_eq!(run(&b, &root, &Control::new(), &Mutex::new(vec![])), Err(InstallError::EpicBlocked));
        assert!(!root.exists());
    }

    #[test]
    fn server_errors_are_retried_on_other_hosts() {
        let b = build();
        b.cdn.host_status.lock().unwrap().insert(CDN_HOSTS[0].into(), 503);
        let path = b.manifest.chunk_path(&b.manifest.chunks[4]);
        b.cdn.flaky.lock().unwrap().insert(path, 3);
        let root = temp("retry");
        run(&b, &root, &Control::new(), &Mutex::new(vec![])).unwrap();
        assert_files(&b, &root);
        assert!(b.cdn.log.lock().unwrap().iter().any(|u| u.contains(CDN_HOSTS[1])));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn network_failure_then_resume() {
        let b = build();
        // the CDN dies after a few chunks
        let dead = Arc::new(AtomicBool::new(false));
        {
            let dead = dead.clone();
            let cdn = b.cdn.clone();
            *b.cdn.on_get.lock().unwrap() = Some(Box::new(move |n| {
                if n == 3 && !dead.swap(true, Ordering::SeqCst) {
                    for h in CDN_HOSTS {
                        cdn.host_status.lock().unwrap().insert(h.into(), 502);
                    }
                }
            }));
        }
        let root = temp("netfail");
        let err = run(&b, &root, &Control::new(), &Mutex::new(vec![])).unwrap_err();
        assert!(matches!(err, InstallError::Network(_)), "{err:?}");
        assert_eq!(err.to_download_error().code, "NETWORK");
        assert!(Journal::open_existing(&root).unwrap().is_some(), "the journal stays for Resume");
        // connection back: Resume finishes and every file is right
        b.cdn.host_status.lock().unwrap().clear();
        *b.cdn.on_get.lock().unwrap() = None;
        run(&b, &root, &Control::new(), &Mutex::new(vec![])).unwrap();
        assert_files(&b, &root);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn pause_in_the_middle_then_resume() {
        let b = build();
        let control = Arc::new(Control::new());
        {
            let control = control.clone();
            *b.cdn.on_get.lock().unwrap() = Some(Box::new(move |n| {
                if n == 2 {
                    control.pause();
                }
            }));
        }
        let root = temp("pause");
        let err = run(&b, &root, &control, &Mutex::new(vec![])).unwrap_err();
        assert_eq!(err, InstallError::Stopped(StopReason::Pause));
        let gets_paused = b.cdn.gets.load(Ordering::SeqCst);
        *b.cdn.on_get.lock().unwrap() = None;
        // something was kept (journal and at least one .part or finished file)
        let j = Journal::open_existing(&root).unwrap().unwrap();
        let plan = Plan::new(&b.manifest, &root, Some(&j));
        assert!(plan.bytes_done > 0 || plan.files_done > 0, "{plan:?}");
        drop(j);
        run(&b, &root, &Control::new(), &Mutex::new(vec![])).unwrap();
        assert_files(&b, &root);
        // resume didn't start over: fewer downloads than two full runs
        let total_fetches: usize = b.manifest.files.iter().map(|f| fetch_list(&b.manifest, f, 0).len()).sum();
        assert!(b.cdn.gets.load(Ordering::SeqCst) < (gets_paused as usize + total_fetches) as u32 + 1);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn killed_in_the_middle_of_a_file_resumes_to_the_same_sha1() {
        let b = build();
        let root = temp("killed");
        // simulate a launcher that died while writing the exe: committed after 2 parts, plus junk
        // bytes after the commit point that never got noted
        let exe = &b.manifest.files[0];
        let committed: u64 = exe.parts[..2].iter().map(|p| p.size as u64).sum();
        let job = job(&b, &root);
        let mut j = Journal::create(&root, &job.job, &b.bytes).unwrap();
        j.set_progress(&exe.path, FileProgress { committed, next_part: 2 }).unwrap();
        drop(j);
        let final_path = pathsafe::safe_join(&root, &exe.path).unwrap();
        fs::create_dir_all(final_path.parent().unwrap()).unwrap();
        let mut partial = b.files[0].content[..committed as usize].to_vec();
        partial.extend([0xEE; 777]);
        fs::write(part_path(&final_path), &partial).unwrap();

        let j = Journal::open_existing(&root).unwrap();
        let plan = Plan::new(&b.manifest, &root, j.as_ref());
        assert_eq!(plan.remaining_bytes, b.manifest.installed_bytes() - committed);
        drop(j);
        run(&b, &root, &Control::new(), &Mutex::new(vec![])).unwrap();
        assert_files(&b, &root);
        // chunks 0 and 1 (the exe's first two parts) were not downloaded again for the exe
        let log = b.cdn.log.lock().unwrap().clone();
        let c1 = b.manifest.chunk_path(&b.manifest.chunks[1]);
        assert!(!log.iter().any(|u| u.ends_with(&c1)), "the committed part was downloaded again");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn file_changed_on_disk_is_downloaded_again() {
        let b = build();
        let root = temp("changed");
        let notices = Mutex::new(vec![]);
        // first run: fine
        run(&b, &root, &Control::new(), &notices).unwrap();
        // the user's antivirus "cleaned" a file → journal says done, size differs → redone
        let exe = pathsafe::safe_join(&root, &b.files[0].path).unwrap();
        fs::write(&exe, b"x").unwrap();
        run(&b, &root, &Control::new(), &notices).unwrap();
        assert_files(&b, &root);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn wrong_file_hash_gives_verify_failed() {
        // a manifest whose file SHA-1 is wrong: both tries fail → VERIFY_FAILED, with a notice
        let chunks = vec![FixtureChunk::new(1, 2000)];
        let mut files = vec![FixtureFile::new("a.bin", vec![(&chunks[0], 0, 2000)])];
        files[0].content.push(1); // the SHA-1 written into the manifest is of other content
        let bytes = fixtures::binary_manifest(17, "x", &chunks, &files, true);
        let manifest = Manifest::parse(&bytes).unwrap();
        let t = Arc::new(MockCdn::default());
        t.files.lock().unwrap().insert(manifest.chunk_path(&manifest.chunks[0]), encode_chunk(&chunks[0], 3, true));
        let root = temp("verify");
        let notices = Mutex::new(vec![]);
        let notice = |n: Notice| notices.lock().unwrap().push(n);
        let plan = Plan::new(&manifest, &root, None);
        let j = InstallJob { manifest: &manifest, manifest_bytes: &bytes, root: &root, job: JobInfo { key: "k".into(), manifest_sha1: "s".into() } };
        let err = install(&j, &plan, &cdn(t.clone()), &Control::new(), &Progress::new(), &opts(), &notice).unwrap_err();
        assert_eq!(err, InstallError::VerifyFailed("a.bin".into()));
        assert_eq!(err.to_download_error().code, "VERIFY_FAILED");
        assert_eq!(*notices.lock().unwrap(), vec![Notice::Redownloading("a.bin".into())]);
        assert_eq!(t.gets.load(Ordering::SeqCst), 2);
        assert!(!root.join("a.bin").exists() && !root.join("a.bin.part").exists());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn cancel_and_delete() {
        let b = build();
        let control = Arc::new(Control::new());
        {
            let control = control.clone();
            *b.cdn.on_get.lock().unwrap() = Some(Box::new(move |n| {
                if n == 4 {
                    control.cancel();
                }
            }));
        }
        let root = temp("cancel");
        let err = run(&b, &root, &control, &Mutex::new(vec![])).unwrap_err();
        assert_eq!(err, InstallError::Stopped(StopReason::Cancel));
        assert!(root.exists());
        // a file of the user's that happens to sit next to it is not touched
        fs::create_dir_all(root.join("FortniteGame")).unwrap();
        fs::write(root.join("FortniteGame/mine.txt"), b"keep").unwrap();
        delete_download(&root, Some(&b.manifest)).unwrap();
        assert_eq!(fs::read(root.join("FortniteGame/mine.txt")).unwrap(), b"keep");
        assert!(!root.join(".rift-download").exists());
        assert!(!root.join("FortniteGame/Binaries").exists());
        fs::remove_file(root.join("FortniteGame/mine.txt")).unwrap();
        delete_download(&root, Some(&b.manifest)).unwrap();
        assert!(!root.exists(), "empty folders go away");
    }

    #[test]
    fn pause_is_quick_while_chunks_arrive_slowly() {
        let b = build();
        // every chunk takes 20 s to arrive (a very slow line)
        *b.cdn.slow_body.lock().unwrap() = Duration::from_secs(20);
        let control = Arc::new(Control::new());
        let c2 = control.clone();
        let presser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            c2.pause();
        });
        let root = temp("slowpause");
        let started = Instant::now();
        let err = run(&b, &root, &control, &Mutex::new(vec![])).unwrap_err();
        presser.join().unwrap();
        assert_eq!(err, InstallError::Stopped(StopReason::Pause));
        assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
        // Resume on a normal line finishes every file
        *b.cdn.slow_body.lock().unwrap() = Duration::ZERO;
        run(&b, &root, &Control::new(), &Mutex::new(vec![])).unwrap();
        assert_files(&b, &root);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn cancel_is_quick_even_while_waiting_for_retries() {
        let b = build();
        for h in CDN_HOSTS {
            b.cdn.host_status.lock().unwrap().insert(h.into(), 503);
        }
        let slow = Cdn {
            transport: b.cdn.clone(),
            hosts: CDN_HOSTS.iter().map(|h| h.to_string()).collect(),
            policy: RetryPolicy::default(), // waits up to 8 s between tries
        };
        let control = Arc::new(Control::new());
        let c2 = control.clone();
        let started = Instant::now();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            c2.cancel();
        });
        let plan = Plan::new(&b.manifest, Path::new("/nonexistent-rift"), None);
        let err = precheck(&b.manifest, &plan, &slow, &control, &Progress::new(), &opts()).unwrap_err();
        t.join().unwrap();
        assert_eq!(err, InstallError::Stopped(StopReason::Cancel));
        assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
    }

    #[test]
    fn speed_meter() {
        let mut m = SpeedMeter::new(Duration::from_secs(5));
        let t0 = Instant::now();
        assert_eq!(m.push(t0, 0), 0);
        assert_eq!(m.push(t0 + Duration::from_secs(1), 10_000_000), 10_000_000);
        assert_eq!(m.push(t0 + Duration::from_secs(2), 30_000_000), 15_000_000);
        // after the window, old readings drop out
        for s in 3..=10 {
            m.push(t0 + Duration::from_secs(s), 30_000_000 + (s - 2) * 1_000_000);
        }
        let v = m.push(t0 + Duration::from_secs(11), 39_000_000);
        assert!((900_000..=1_100_000).contains(&v), "{v}");
        assert_eq!(SpeedMeter::eta(10_000_000, 1_000_000), Some(10));
        assert_eq!(SpeedMeter::eta(1, 0), None);
        // a new phase starts again from 0
        assert_eq!(m.push(t0 + Duration::from_secs(12), 0), 0);
    }

    #[test]
    fn control_states() {
        let c = Control::new();
        assert_eq!(c.reason(), None);
        c.pause();
        assert_eq!(c.reason(), Some(StopReason::Pause));
        c.cancel();
        assert_eq!(c.reason(), Some(StopReason::Cancel));
        c.pause();
        assert_eq!(c.reason(), Some(StopReason::Cancel), "pause doesn't undo a cancel");
        assert!(c.stopped());
    }
}
