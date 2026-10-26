//! Build downloader – the Tauri side: commands, the job thread, progress events, auto-import.
//!
//! The downloader itself (manifest/chunk formats, the full check, resume, pause/cancel) is in
//! `niobium_core::epic`. Manifests come from the GitHub archive pinned by SHA-1; every game byte
//! comes from Epic's own CDN.
//!
//! Commands: `catalog_list`, `download_start`, `download_pause`, `download_resume`,
//! `download_cancel`, `download_status`, `default_download_folder`.
//! Events: `download:progress` (every 500 ms while running), `download:done`, `download:error`,
//! `download:state`.

mod disk;
mod http;

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

use niobium_core::epic::catalog::{self, Catalog};
use niobium_core::epic::cdn::{self, Cdn};
use niobium_core::epic::errors::{self, DownloadError};
use niobium_core::epic::folder;
use niobium_core::epic::install::{self, Control, InstallError, InstallJob, InstallOptions, Notice, Phase, Plan, Progress, SpeedMeter, StopReason};
use niobium_core::epic::journal::{self, JobInfo, Journal};
use niobium_core::epic::manifest::Manifest;
use niobium_core::{epic, profiles, version};

use crate::engine::Engine;

pub const EVENT_PROGRESS: &str = "download:progress";
pub const EVENT_DONE: &str = "download:done";
pub const EVENT_ERROR: &str = "download:error";
pub const EVENT_STATE: &str = "download:state";

/// The biggest Fortnite manifests are ~35 MB.
const MAX_MANIFEST_BYTES: u64 = 128 << 20;
const PROGRESS_EVERY: Duration = Duration::from_millis(500);
const SPEED_WINDOW: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Running,
    Paused,
    Error,
    Done,
    Cancelled,
}

/// Payload of `download:progress`, and `progress` in `download_status`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    pub key: String,
    pub phase: Phase,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub files_done: u64,
    pub files_total: u64,
    /// Download speed (5 s average); 0 outside the "downloading" phase.
    pub speed_bps: u64,
    /// Seconds left in this phase (None while unknown).
    pub eta_secs: Option<u64>,
    pub current_file: String,
}

impl ProgressPayload {
    fn empty(key: &str) -> ProgressPayload {
        ProgressPayload {
            key: key.into(),
            phase: Phase::Checking,
            bytes_done: 0,
            bytes_total: 0,
            files_done: 0,
            files_total: 0,
            speed_bps: 0,
            eta_secs: None,
            current_file: String::new(),
        }
    }
}

/// One entry of `download_status`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStatus {
    pub key: String,
    pub version: String,
    pub cl: u32,
    pub folder: String,
    pub state: JobState,
    pub progress: ProgressPayload,
    pub error: Option<DownloadError>,
    pub build_id: Option<String>,
    /// Files of this build are in the folder (it has a journal): "Remove" offers to delete them.
    pub files_kept: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DonePayload {
    key: String,
    build_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorPayload {
    key: String,
    code: String,
    message: String,
    /// Same as `JobStatus::files_kept`.
    files_kept: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatePayload {
    key: String,
    state: JobState,
}

/// What `downloads.json` keeps of an unfinished download (so Resume works after a restart).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedJob {
    key: String,
    folder: String,
}

struct Job {
    key: String,
    folder: PathBuf,
    state: JobState,
    control: Arc<Control>,
    progress: Arc<Progress>,
    last: ProgressPayload,
    error: Option<DownloadError>,
    build_id: Option<String>,
    delete_files: bool,
}

impl Job {
    fn new(key: &str, folder: PathBuf, state: JobState) -> Job {
        Job {
            key: key.into(),
            folder,
            state,
            control: Arc::new(Control::new()),
            progress: Arc::new(Progress::new()),
            last: ProgressPayload::empty(key),
            error: None,
            build_id: None,
            delete_files: false,
        }
    }

    fn status(&self) -> JobStatus {
        let entry = catalog::find_build(&self.key);
        JobStatus {
            key: self.key.clone(),
            version: entry.as_ref().map(|e| e.version.clone()).unwrap_or_default(),
            cl: entry.as_ref().map(|e| e.cl).unwrap_or(0),
            folder: self.folder.to_string_lossy().into_owned(),
            state: self.state,
            progress: self.last.clone(),
            error: self.error.clone(),
            build_id: self.build_id.clone(),
            files_kept: journal::read_job(&self.folder).is_some(),
        }
    }
}

/// All downloads of this launcher run (only one runs at a time).
pub struct Downloads {
    jobs: Mutex<Vec<Job>>,
}

fn saved_jobs_path() -> PathBuf {
    profiles::config_dir().join("downloads.json")
}

/// How a job thread ended.
enum JobEnd {
    Stopped(StopReason),
    /// The error for the user, plus a technical detail for the live log.
    Failed(DownloadError, String),
}

impl Downloads {
    /// Unfinished downloads from the last run come back as "paused".
    pub fn load() -> Downloads {
        let saved: Vec<SavedJob> = fs::read(saved_jobs_path())
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let jobs = saved
            .into_iter()
            .filter_map(|s| {
                let entry = catalog::find_build(&s.key)?;
                let mut job = Job::new(&s.key, PathBuf::from(s.folder), JobState::Paused);
                job.last = paused_progress(&s.key, &job.folder, &entry);
                Some(job)
            })
            .collect();
        Downloads { jobs: Mutex::new(jobs) }
    }

    fn save(jobs: &[Job]) {
        let saved: Vec<SavedJob> = jobs
            .iter()
            .filter(|j| matches!(j.state, JobState::Running | JobState::Paused | JobState::Error))
            .map(|j| SavedJob { key: j.key.clone(), folder: j.folder.to_string_lossy().into_owned() })
            .collect();
        let path = saved_jobs_path();
        let result = (|| -> std::io::Result<()> {
            if let Some(dir) = path.parent() {
                fs::create_dir_all(dir)?;
            }
            let tmp = path.with_extension("json.tmp");
            fs::write(&tmp, serde_json::to_vec_pretty(&saved).map_err(std::io::Error::other)?)?;
            fs::rename(&tmp, &path)
        })();
        if let Err(e) = result {
            eprintln!("[Niobium] Couldn't save the download list: {e}");
        }
    }

    /// For "Close Niobium?": e.g. `["Download (18.30)"]`.
    pub fn running_names(&self) -> Vec<String> {
        self.jobs
            .lock()
            .unwrap()
            .iter()
            .filter(|j| j.state == JobState::Running)
            .map(|j| format!("Download ({})", catalog::find_build(&j.key).map(|e| e.version).unwrap_or_else(|| j.key.clone())))
            .collect()
    }

    /// Niobium is closing: running downloads stop where they are (Resume continues next time).
    pub fn pause_all(&self) {
        for j in self.jobs.lock().unwrap().iter() {
            if j.state == JobState::Running {
                j.control.pause();
            }
        }
    }

    fn statuses(&self) -> Vec<JobStatus> {
        self.jobs.lock().unwrap().iter().map(Job::status).collect()
    }

    /// Starts (or continues) the download of `key` into `folder` in its own thread.
    fn launch(self: &Arc<Self>, app: &AppHandle, key: &str, folder: PathBuf) -> Result<(), DownloadError> {
        let (control, progress) = {
            let mut jobs = self.jobs.lock().unwrap();
            if let Some(running) = jobs.iter().find(|j| j.state == JobState::Running) {
                return Err(if running.key == key { DownloadError::already_running() } else { DownloadError::another_running() });
            }
            jobs.retain(|j| j.key != key);
            let job = Job::new(key, folder.clone(), JobState::Running);
            let handles = (job.control.clone(), job.progress.clone());
            jobs.push(job);
            Self::save(&jobs);
            handles
        };
        emit_state(app, key, JobState::Running);
        let (dl, app, key) = (self.clone(), app.clone(), key.to_string());
        std::thread::spawn(move || dl.run(app, key, folder, control, progress));
        Ok(())
    }

    fn with_job<T>(&self, key: &str, f: impl FnOnce(&mut Job) -> T) -> Option<T> {
        self.jobs.lock().unwrap().iter_mut().find(|j| j.key == key).map(f)
    }

    /// The job thread: runs the steps, reports progress every 500 ms, then records the end.
    fn run(self: Arc<Self>, app: AppHandle, key: String, folder: PathBuf, control: Arc<Control>, progress: Arc<Progress>) {
        let finished = Arc::new(AtomicBool::new(false));
        let reporter = {
            let (dl, app, key, progress, finished) = (self.clone(), app.clone(), key.clone(), progress.clone(), finished.clone());
            std::thread::spawn(move || {
                let mut meter = Meter::new();
                while !finished.load(Ordering::SeqCst) {
                    let p = meter.payload(&key, &progress);
                    dl.with_job(&key, |j| j.last = p.clone());
                    let _ = app.emit(EVENT_PROGRESS, p);
                    cdn::sleep_unless(&finished, PROGRESS_EVERY);
                }
            })
        };
        let result = job_steps(&app, &key, &folder, &control, &progress);
        finished.store(true, Ordering::SeqCst);
        let _ = reporter.join();
        let last = Meter::new().payload(&key, &progress);
        self.with_job(&key, |j| j.last = last.clone());
        let _ = app.emit(EVENT_PROGRESS, last);
        self.finish(&app, &key, &folder, result);
    }

    fn finish(&self, app: &AppHandle, key: &str, folder: &Path, result: Result<String, JobEnd>) {
        let engine = app.state::<Arc<Engine>>();
        let version = catalog::find_build(key).map(|e| e.version).unwrap_or_else(|| key.to_string());
        match result {
            Ok(build_id) => {
                {
                    let mut jobs = self.jobs.lock().unwrap();
                    if let Some(j) = jobs.iter_mut().find(|j| j.key == key) {
                        j.state = JobState::Done;
                        j.build_id = Some(build_id.clone());
                    }
                    Self::save(&jobs);
                }
                engine.log_line("info", &format!("Download of {version} finished and added to your Library"));
                let _ = app.emit(EVENT_DONE, DonePayload { key: key.into(), build_id });
                emit_state(app, key, JobState::Done);
                engine.toast_msg("success", &format!("{version} is ready"), &format!("{version} is ready. Press Play."));
            }
            Err(JobEnd::Stopped(StopReason::Pause)) => {
                {
                    let mut jobs = self.jobs.lock().unwrap();
                    if let Some(j) = jobs.iter_mut().find(|j| j.key == key) {
                        j.state = JobState::Paused;
                    }
                    Self::save(&jobs);
                }
                emit_state(app, key, JobState::Paused);
            }
            Err(JobEnd::Stopped(StopReason::Cancel)) => {
                let delete = self.with_job(key, |j| j.delete_files).unwrap_or(false);
                if delete {
                    delete_files(folder);
                }
                {
                    let mut jobs = self.jobs.lock().unwrap();
                    jobs.retain(|j| j.key != key);
                    Self::save(&jobs);
                }
                engine.log_line("info", &format!("Download of {version} cancelled"));
                emit_state(app, key, JobState::Cancelled);
            }
            Err(JobEnd::Failed(error, detail)) => {
                // files already on disk: texts without "nothing was downloaded", Resume for write errors
                let files_kept = journal::read_job(folder).is_some();
                let error = if files_kept { error.after_files_written() } else { error };
                {
                    let mut jobs = self.jobs.lock().unwrap();
                    if let Some(j) = jobs.iter_mut().find(|j| j.key == key) {
                        j.state = JobState::Error;
                        j.error = Some(error.clone());
                    }
                    Self::save(&jobs);
                }
                let line = if detail.is_empty() { error.message.clone() } else { format!("{} ({detail})", error.message) };
                engine.log_line("error", &format!("Download of {version}: {line}"));
                let _ = app.emit(EVENT_ERROR, ErrorPayload { key: key.into(), code: error.code, message: error.message, files_kept });
                emit_state(app, key, JobState::Error);
            }
        }
    }
}

/// Progress of an unfinished download from an earlier run, from its journal (finished files;
/// download bytes estimated from their share of the build).
fn paused_progress(key: &str, folder: &Path, entry: &catalog::BuildEntry) -> ProgressPayload {
    let mut p = ProgressPayload::empty(key);
    p.phase = Phase::Downloading;
    p.files_total = entry.files as u64;
    p.bytes_total = entry.download_bytes;
    if let Ok(Some(j)) = Journal::open_existing(folder) {
        p.files_done = j.done_count() as u64;
        let share = j.done_bytes() as f64 / entry.installed_bytes.max(1) as f64;
        p.bytes_done = ((entry.download_bytes as f64) * share.min(1.0)) as u64;
    }
    p
}

fn emit_state(app: &AppHandle, key: &str, state: JobState) {
    let _ = app.emit(EVENT_STATE, StatePayload { key: key.into(), state });
}

/// Speed and time left, measured per phase.
struct Meter {
    phase: Option<Phase>,
    meter: SpeedMeter,
}

impl Meter {
    fn new() -> Meter {
        Meter { phase: None, meter: SpeedMeter::new(SPEED_WINDOW) }
    }

    fn payload(&mut self, key: &str, progress: &Progress) -> ProgressPayload {
        let s = progress.snapshot();
        if self.phase != Some(s.phase) {
            self.phase = Some(s.phase);
            self.meter = SpeedMeter::new(SPEED_WINDOW);
        }
        let rate = self.meter.push(Instant::now(), s.bytes_done);
        let timed = matches!(s.phase, Phase::Checking | Phase::Downloading) && s.bytes_total > 0;
        ProgressPayload {
            key: key.into(),
            phase: s.phase,
            bytes_done: s.bytes_done,
            bytes_total: s.bytes_total,
            files_done: s.files_done,
            files_total: s.files_total,
            speed_bps: if s.phase == Phase::Downloading { rate } else { 0 },
            eta_secs: if timed { SpeedMeter::eta(s.bytes_total.saturating_sub(s.bytes_done), rate) } else { None },
            current_file: s.current_file,
        }
    }
}

/// Niobium's own folders – never downloaded into.
fn own_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        dirs.push(dir);
    }
    if let Ok(res) = app.path().resource_dir() {
        dirs.push(res);
    }
    dirs
}

/// Cancel + "Delete the downloaded files": only the build's own files go (see `delete_download`).
fn delete_files(folder: &Path) {
    let manifest = journal::read_saved_manifest(folder).and_then(|b| Manifest::parse(&b).ok());
    if let Err(e) = install::delete_download(folder, manifest.as_ref()) {
        eprintln!("[Niobium] Couldn't delete the downloaded files: {e}");
    }
}

/// The steps of one download: manifest → folder checks → full check → download → verify → import.
/// Returns the id of the build added to the Library.
fn job_steps(app: &AppHandle, key: &str, folder: &Path, control: &Control, progress: &Progress) -> Result<String, JobEnd> {
    let failed = |e: DownloadError, detail: String| JobEnd::Failed(e, detail);
    let entry = catalog::find_build(key).ok_or_else(|| failed(DownloadError::unknown_build(), String::new()))?;
    progress.set_phase(Phase::Checking);
    progress.set_files(0, entry.files as u64);

    // 1) The manifest: the copy saved by an earlier run, or from the archive. Always the pinned SHA-1.
    let bytes = match journal::read_saved_manifest(folder) {
        Some(b) if epic::sha1_hex(&b) == entry.manifest_sha1 => b,
        _ => {
            let transport = http::UreqTransport::for_manifests();
            match cdn::fetch_manifest(&transport, &entry.manifest_urls(), &entry.manifest_sha1, MAX_MANIFEST_BYTES, control.stop_flag()) {
                Ok(b) => b,
                Err(_) if control.reason().is_some() => return Err(JobEnd::Stopped(control.reason().unwrap())),
                Err(true) => return Err(failed(DownloadError::manifest_mismatch(), "the file isn't the pinned one".into())),
                Err(false) => return Err(failed(DownloadError::manifest_unavailable(), String::new())),
            }
        }
    };
    let manifest = Manifest::parse(&bytes).map_err(|e| failed(DownloadError::manifest_mismatch(), e.to_string()))?;
    if manifest.version() != Some((entry.version.clone(), entry.cl)) {
        return Err(failed(DownloadError::manifest_mismatch(), format!("it is for {}", manifest.build_version)));
    }

    // 2) The folder, now with the exact bytes still to write
    let plan = {
        let existing = Journal::open_existing(folder).ok().flatten();
        Plan::new(&manifest, folder, existing.as_ref())
    };
    let facts = disk::folder_facts(folder, own_dirs(app));
    folder::check_folder(&facts, key, folder::space_needed(plan.remaining_bytes)).map_err(|e| failed(e, String::new()))?;
    let created = disk::write_probe(folder).map_err(|e| failed(DownloadError::write_failed(), e.to_string()))?;

    // 3) Full check of every chunk, download, last check
    let cdn = Cdn::epic(Arc::new(http::UreqTransport::for_chunks()));
    let job = InstallJob {
        manifest: &manifest,
        manifest_bytes: &bytes,
        root: folder,
        job: JobInfo { key: key.into(), manifest_sha1: entry.manifest_sha1.clone() },
    };
    let engine = app.state::<Arc<Engine>>();
    let notice = |n: Notice| match n {
        Notice::Redownloading(path) => engine.log_line("warning", &format!("{} ({path})", errors::TEXT_VERIFY_RETRY)),
    };
    if let Err(e) = install::install(&job, &plan, &cdn, control, progress, &InstallOptions::default(), &notice) {
        // Stopped before anything was written (a missing chunk, Pause while checking): leave none
        // of the folders made just now behind (e.g. D:\Niobium\Builds\<key> and its parents)
        if journal::read_job(folder).is_none() {
            disk::remove_empty_dirs(&created);
        }
        return Err(match e {
            InstallError::Stopped(r) => JobEnd::Stopped(r),
            other => failed(other.to_download_error(), other.to_string()),
        });
    }

    // 4) Add it to the Library (same as "Add a build")
    progress.set_phase(Phase::Importing);
    progress.set_current("");
    let report = version::detect_build(folder);
    let detail = report.checks.iter().filter(|c| !c.ok).map(|c| c.text.clone()).collect::<Vec<_>>().join("; ");
    let build = report
        .build
        .filter(|b| b.version == entry.version && b.changelist == Some(entry.cl))
        .ok_or_else(|| failed(DownloadError::import_failed(), detail))?;
    Ok(engine.import_build(build))
}

// --- Commands --------------------------------------------------------------------

type Dl<'a> = State<'a, Arc<Downloads>>;

/// Chapters → seasons → builds that can be downloaded.
#[tauri::command]
pub fn catalog_list() -> Catalog {
    catalog::catalog()
}

/// `<fixed drive with the most free space>:\Niobium\Builds\<version>-CL-<cl>`
/// (`<drive>:\Niobium Builds\<key>` if Niobium itself is installed in `<drive>:\Niobium`.)
#[tauri::command]
pub fn default_download_folder(app: AppHandle, key: String) -> Result<String, String> {
    catalog::find_build(&key).ok_or_else(|| DownloadError::unknown_build().message)?;
    let mut path = disk::default_folder(&key);
    if own_dirs(&app).iter().any(|d| folder::is_inside(&path, d)) {
        if let Some(drive_root) = path.ancestors().nth(3) {
            path = drive_root.join("Niobium Builds").join(&key);
        }
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Every download of this run (and unfinished ones from earlier runs, as "paused").
#[tauri::command]
pub fn download_status(dl: Dl) -> Vec<JobStatus> {
    dl.statuses()
}

/// Starts a download. Problems with the folder are refused right here (`{code, message}`);
/// everything after that comes as `download:error`.
#[tauri::command(async)]
pub fn download_start(app: AppHandle, dl: Dl, key: String, folder: String) -> Result<(), DownloadError> {
    let entry = catalog::find_build(&key).ok_or_else(DownloadError::unknown_build)?;
    let folder = PathBuf::from(folder.trim());
    if !folder.is_absolute() {
        return Err(DownloadError::write_failed());
    }
    let facts = disk::folder_facts(&folder, own_dirs(&app));
    // an unfinished download of this build continues there: its exact space is checked in the job
    let need = if facts.journal_key.as_deref() == Some(key.as_str()) { 0 } else { folder::space_needed(entry.installed_bytes) };
    folder::check_folder(&facts, &key, need)?;
    dl.inner().launch(&app, &key, folder)
}

/// Continues a paused or failed download in its folder.
#[tauri::command(async)]
pub fn download_resume(app: AppHandle, dl: Dl, key: String) -> Result<(), DownloadError> {
    let folder = dl.with_job(&key, |j| j.folder.clone()).ok_or_else(DownloadError::unknown_build)?;
    dl.inner().launch(&app, &key, folder)
}

/// Pauses a running download (it stops between chunks; everything downloaded is kept).
#[tauri::command]
pub fn download_pause(dl: Dl, key: String) -> Result<(), String> {
    dl.with_job(&key, |j| {
        if j.state == JobState::Running {
            j.control.pause();
        }
    })
    .ok_or_else(|| "This download doesn't exist.".to_string())
}

/// Cancels a download. `deleteFiles` = also delete what was downloaded (only the build's own files).
#[tauri::command(async)]
pub fn download_cancel(app: AppHandle, dl: Dl, key: String, delete_files: bool) -> Result<(), String> {
    let running = dl
        .with_job(&key, |j| {
            j.delete_files = delete_files;
            if j.state == JobState::Running {
                j.control.cancel();
                true
            } else {
                false
            }
        })
        .ok_or_else(|| "This download doesn't exist.".to_string())?;
    if running {
        // the job thread stops within seconds, deletes (if asked) and sends `download:state`
        return Ok(());
    }
    let folder = dl.with_job(&key, |j| j.folder.clone()).unwrap_or_default();
    let done = dl.with_job(&key, |j| j.state == JobState::Done).unwrap_or(false);
    // a finished build is in the Library now – never delete it from here
    if delete_files && !done {
        self::delete_files(&folder);
    }
    {
        let mut jobs = dl.jobs.lock().unwrap();
        jobs.retain(|j| j.key != key);
        Downloads::save(&jobs);
    }
    emit_state(&app, &key, JobState::Cancelled);
    Ok(())
}
