//! Fortsetzbarer Download mit automatischen Wiederholungen und SHA-256-Prüfung.
//!
//! Unabhängig von Tauri: Fortschritt geht an einen Callback, Abbruch über ein `CancellationToken`.
//! Arbeitsdateien: `<work_dir>/<file_name>.part` und `<work_dir>/meta.json`.

use crate::manifest::{describe_network_error, Location};
use crate::types::{InstallError, Progress};
use crate::util::tr;
use futures_util::StreamExt;
use reqwest::header::{ACCEPT_ENCODING, CONTENT_RANGE, ETAG, IF_RANGE, LAST_MODIFIED, RANGE};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufWriter};
use tokio_util::sync::CancellationToken;

/// Fortschritts-Callback (wird z. B. auf `install://progress` abgebildet).
pub type ProgressFn = Arc<dyn Fn(Progress) + Send + Sync>;

/// Anteil des Downloads am Gesamtfortschritt.
pub const DOWNLOAD_END: f64 = 85.0;
pub const VERIFY_END: f64 = 92.0;

const EMIT_INTERVAL: Duration = Duration::from_millis(100);
/// So viel Fortschritt innerhalb eines Versuchs setzt den Fehlerzähler zurück.
const PROGRESS_RESETS_RETRIES: u64 = 256 * 1024;

/// Wartezeiten zwischen automatischen Wiederholungen (Standard: 1/2/4/8 s).
#[derive(Debug, Clone)]
pub struct RetryPolicy {
    pub delays: Vec<Duration>,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self { delays: [1, 2, 4, 8].into_iter().map(Duration::from_secs).collect() }
    }
}

impl RetryPolicy {
    pub fn none() -> Self {
        Self { delays: Vec::new() }
    }
}

#[derive(Debug, Clone)]
pub struct DownloadSpec {
    pub source: Location,
    pub sha256: Option<String>,
    pub size: Option<u64>,
    /// Version aus dem Manifest (wird in meta.json gemerkt).
    pub version: String,
    pub work_dir: PathBuf,
    pub file_name: String,
}

impl DownloadSpec {
    pub fn part_path(&self) -> PathBuf {
        self.work_dir.join(format!("{}.part", self.file_name))
    }
    pub fn meta_path(&self) -> PathBuf {
        self.work_dir.join("meta.json")
    }
}

/// Inhalt von meta.json: nur wenn alles übereinstimmt, wird eine .part-Datei fortgesetzt.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PartMeta {
    pub url: String,
    pub sha256: Option<String>,
    pub size: Option<u64>,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<String>,
}

impl PartMeta {
    fn for_spec(spec: &DownloadSpec) -> Self {
        Self {
            url: spec.source.to_url_string(),
            sha256: spec.sha256.clone(),
            size: spec.size,
            version: spec.version.clone(),
            etag: None,
            last_modified: None,
        }
    }
    fn same_target(&self, other: &PartMeta) -> bool {
        self.url == other.url
            && self.sha256.as_deref().map(str::to_ascii_lowercase) == other.sha256.as_deref().map(str::to_ascii_lowercase)
            && self.size == other.size
            && self.version == other.version
    }
    /// Validator für `If-Range` (nur starke ETags, sonst Last-Modified).
    fn validator(&self) -> Option<String> {
        match &self.etag {
            Some(e) if !e.starts_with("W/") => Some(e.clone()),
            _ => self.last_modified.clone(),
        }
    }
}

/// Statistik eines Downloads (für Tests und Protokoll).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DownloadStats {
    pub requests: u32,
    pub resumed_from: Option<u64>,
    pub bytes_transferred: u64,
    pub size: u64,
}

enum AttemptError {
    /// Netzwerkproblem – nach Wartezeit fortsetzen.
    Transient(String),
    /// Server-Antwort passt nicht zur .part-Datei – von vorn beginnen.
    Restart,
    Cancelled,
    Fatal(InstallError),
}

pub fn cancelled_error(phase: &'static str) -> InstallError {
    InstallError::new(phase, "cancelled", tr("Vorgang abgebrochen.", "Cancelled."), true)
}

/// Ordnet einen Dateisystemfehler einem Fehlercode zu.
pub fn classify_io(e: &std::io::Error) -> &'static str {
    use std::io::ErrorKind;
    match e.kind() {
        ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem => return "permission",
        ErrorKind::StorageFull => return "disk",
        _ => {}
    }
    match e.raw_os_error() {
        // Windows: ERROR_HANDLE_DISK_FULL, ERROR_DISK_FULL; Unix: ENOSPC, EDQUOT
        #[cfg(windows)]
        Some(39) | Some(112) => "disk",
        #[cfg(windows)]
        Some(5) | Some(19) => "permission",
        #[cfg(unix)]
        Some(code) if code == libc::ENOSPC || code == libc::EDQUOT => "disk",
        #[cfg(unix)]
        Some(code) if code == libc::EACCES || code == libc::EPERM || code == libc::EROFS => "permission",
        _ => "unknown",
    }
}

/// Dateisystemfehler -> `InstallError` mit verständlicher Meldung.
pub fn io_error(phase: &'static str, e: &std::io::Error, context: &str) -> InstallError {
    crate::util::log(format!("E/A-Fehler ({phase}, {context}): {e}"));
    let code = classify_io(e);
    let message = match code {
        "disk" => tr("Nicht genug Speicherplatz auf dem Laufwerk.", "Not enough disk space on the drive."),
        "permission" => format!(
            "{} ({context})",
            tr("Keine Schreibrechte für den Zielordner", "No write permission for the target folder")
        ),
        _ => format!("{context}: {e}"),
    };
    InstallError::new(phase, code, message, true)
}

/// Misst Geschwindigkeit (gleitender Mittelwert) und drosselt Events auf ~10 pro Sekunde.
struct Meter {
    progress: ProgressFn,
    last_emit: Option<Instant>,
    rate_time: Instant,
    rate_bytes: u64,
    ema: f64,
}

impl Meter {
    fn new(progress: ProgressFn) -> Self {
        Self { progress, last_emit: None, rate_time: Instant::now(), rate_bytes: 0, ema: 0.0 }
    }

    /// Neuer Messbeginn (z. B. nach Wiederverbindung): bereits vorhandene Bytes zählen nicht als Tempo.
    fn rebase(&mut self, downloaded: u64) {
        self.rate_time = Instant::now();
        self.rate_bytes = downloaded;
        self.ema = 0.0;
    }

    fn emit(&mut self, phase: &'static str, downloaded: u64, total: u64, force: bool) {
        let now = Instant::now();
        if !force && self.last_emit.is_some_and(|t| now.duration_since(t) < EMIT_INTERVAL) {
            return;
        }
        let dt = now.duration_since(self.rate_time);
        if dt >= Duration::from_millis(80) {
            let inst = downloaded.saturating_sub(self.rate_bytes) as f64 / dt.as_secs_f64();
            self.ema = if self.ema <= 0.0 { inst } else { 0.3 * inst + 0.7 * self.ema };
            self.rate_time = now;
            self.rate_bytes = downloaded;
        }
        self.last_emit = Some(now);
        let speed = if phase == "download" { self.ema.max(0.0).round() } else { 0.0 };
        let eta = if speed >= 1.0 && total > downloaded { ((total - downloaded) as f64 / speed).ceil() as u64 } else { 0 };
        (self.progress)(Progress { phase, downloaded, total, speed, eta, percent: download_percent(downloaded, total) });
    }
}

fn download_percent(downloaded: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        (downloaded as f64 / total as f64 * DOWNLOAD_END).clamp(0.0, DOWNLOAD_END)
    }
}

fn file_len(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

fn read_meta(p: &Path) -> Option<PartMeta> {
    serde_json::from_slice(&std::fs::read(p).ok()?).ok()
}

fn write_meta(p: &Path, meta: &PartMeta) -> std::io::Result<()> {
    std::fs::write(p, serde_json::to_vec_pretty(meta).unwrap_or_default())
}

/// Entfernt .part und meta.json (z. B. nach Prüfsummenfehler).
pub fn discard_partial(spec: &DownloadSpec) {
    let _ = std::fs::remove_file(spec.part_path());
    let _ = std::fs::remove_file(spec.meta_path());
}

/// `bytes 100-199/1000` -> (100, Some(1000))
fn parse_content_range(v: &str) -> Option<(u64, Option<u64>)> {
    let rest = v.trim().strip_prefix("bytes")?.trim();
    let (range, total) = rest.split_once('/')?;
    let (start, _end) = range.trim().split_once('-')?;
    let start = start.trim().parse().ok()?;
    let total = total.trim().parse().ok();
    Some((start, total))
}

/// Lädt die Datei nach `spec.part_path()`; setzt eine vorhandene, passende .part-Datei fort.
pub async fn download(
    client: &reqwest::Client,
    spec: &DownloadSpec,
    progress: &ProgressFn,
    cancel: &CancellationToken,
    policy: &RetryPolicy,
) -> Result<DownloadStats, InstallError> {
    std::fs::create_dir_all(&spec.work_dir).map_err(|e| io_error("download", &e, &crate::util::display_path(&spec.work_dir)))?;
    let part = spec.part_path();
    let meta_path = spec.meta_path();

    let wanted = PartMeta::for_spec(spec);
    let mut meta = match read_meta(&meta_path) {
        Some(existing) if existing.same_target(&wanted) && part.exists() => existing,
        _ => {
            let _ = std::fs::remove_file(&part);
            write_meta(&meta_path, &wanted).map_err(|e| io_error("download", &e, "meta.json"))?;
            wanted
        }
    };

    let mut stats = DownloadStats::default();
    let mut meter = Meter::new(progress.clone());
    let mut failures = 0usize;
    let mut restarts = 0u32;

    loop {
        if cancel.is_cancelled() {
            return Err(cancelled_error("download"));
        }
        let mut have = file_len(&part);
        if let Some(size) = spec.size {
            if have == size {
                crate::util::log(format!("Download bereits vollständig ({have} Bytes)"));
                stats.size = have;
                meter.emit("download", have, size, true);
                return Ok(stats);
            }
            if have > size {
                let _ = std::fs::remove_file(&part);
                have = 0;
            }
        }
        let total_hint = spec.size.unwrap_or(0);
        meter.rebase(have);
        meter.emit("connect", have, total_hint, true);

        let result = match &spec.source {
            Location::Http(url) => attempt_http(client, url, spec, &mut meta, have, &mut meter, cancel, &mut stats).await,
            Location::File(src) => copy_local(src, spec, &mut meter, cancel, &mut stats).await,
        };
        match result {
            Ok(()) => {
                stats.size = file_len(&part);
                return Ok(stats);
            }
            Err(AttemptError::Cancelled) => return Err(cancelled_error("download")),
            Err(AttemptError::Fatal(e)) => return Err(e),
            Err(AttemptError::Restart) => {
                restarts += 1;
                crate::util::log("Server-Antwort passt nicht zur Teil-Datei – Download beginnt von vorn");
                let _ = std::fs::remove_file(&part);
                meta.etag = None;
                meta.last_modified = None;
                let _ = write_meta(&meta_path, &meta);
                if restarts > 3 {
                    return Err(InstallError::new(
                        "download",
                        "network",
                        tr("Der Server liefert widersprüchliche Daten.", "The server returned inconsistent data."),
                        true,
                    ));
                }
            }
            Err(AttemptError::Transient(message)) => {
                if file_len(&part) >= have + PROGRESS_RESETS_RETRIES {
                    failures = 0;
                }
                if failures >= policy.delays.len() {
                    crate::util::log(format!("Download aufgegeben: {message}"));
                    return Err(InstallError::new("download", "network", message, true));
                }
                let delay = policy.delays[failures];
                failures += 1;
                crate::util::log(format!("Download unterbrochen ({message}) – neuer Versuch {failures} in {delay:?}"));
                let now_have = file_len(&part);
                meter.rebase(now_have);
                meter.emit("connect", now_have, spec.size.unwrap_or(0), true);
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    _ = cancel.cancelled() => return Err(cancelled_error("download")),
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn attempt_http(
    client: &reqwest::Client,
    url: &reqwest::Url,
    spec: &DownloadSpec,
    meta: &mut PartMeta,
    have: u64,
    meter: &mut Meter,
    cancel: &CancellationToken,
    stats: &mut DownloadStats,
) -> Result<(), AttemptError> {
    let mut req = client.get(url.clone()).header(ACCEPT_ENCODING, "identity");
    if have > 0 {
        req = req.header(RANGE, format!("bytes={have}-"));
        if let Some(v) = meta.validator() {
            req = req.header(IF_RANGE, v);
        }
    }
    stats.requests += 1;
    let resp = tokio::select! {
        r = req.send() => r.map_err(|e| AttemptError::Transient(describe_network_error(&e)))?,
        _ = cancel.cancelled() => return Err(AttemptError::Cancelled),
    };
    let status = resp.status().as_u16();
    let header = |name: reqwest::header::HeaderName| resp.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string);

    let (append, start, range_total) = match status {
        206 => match header(CONTENT_RANGE).as_deref().and_then(parse_content_range) {
            Some((s, total)) if s == have => (true, have, total),
            _ => return Err(AttemptError::Restart),
        },
        200 => {
            if have > 0 {
                crate::util::log("Server ignoriert Range – Download beginnt von vorn");
            }
            (false, 0, None)
        }
        416 if have > 0 => {
            return if spec.size.is_none_or(|s| s == have) { Ok(()) } else { Err(AttemptError::Restart) };
        }
        s if (500..600).contains(&s) || s == 408 || s == 429 => {
            return Err(AttemptError::Transient(format!(
                "{} (HTTP {s}).",
                tr("Der Download-Server ist gerade nicht erreichbar", "The download server is currently unavailable")
            )))
        }
        s => {
            let msg = if s == 404 {
                tr("Die App-Datei wurde auf dem Server nicht gefunden (HTTP 404).", "The app file was not found on the server (HTTP 404).")
            } else {
                format!("{} (HTTP {s}).", tr("Download fehlgeschlagen", "Download failed"))
            };
            return Err(AttemptError::Fatal(InstallError::new("download", "network", msg, true)));
        }
    };
    if append && stats.resumed_from.is_none() {
        stats.resumed_from = Some(have);
    }
    let total = range_total
        .or_else(|| resp.content_length().map(|l| start + l))
        .or(spec.size)
        .unwrap_or(0);
    if !append {
        meta.etag = header(ETAG);
        meta.last_modified = header(LAST_MODIFIED);
        let _ = write_meta(&spec.meta_path(), meta);
    }

    let part = spec.part_path();
    let mut opts = tokio::fs::OpenOptions::new();
    if append {
        opts.append(true).create(true);
    } else {
        opts.write(true).create(true).truncate(true);
    }
    let file = opts
        .open(&part)
        .await
        .map_err(|e| AttemptError::Fatal(io_error("download", &e, &crate::util::display_path(&part))))?;
    let mut writer = BufWriter::with_capacity(256 * 1024, file);
    let mut downloaded = start;
    meter.rebase(downloaded);
    meter.emit("download", downloaded, total, true);

    let mut stream = resp.bytes_stream();
    let outcome: Result<(), AttemptError> = loop {
        let next = tokio::select! {
            n = stream.next() => n,
            _ = cancel.cancelled() => break Err(AttemptError::Cancelled),
        };
        match next {
            Some(Ok(chunk)) => {
                if let Err(e) = writer.write_all(&chunk).await {
                    break Err(AttemptError::Fatal(io_error("download", &e, &crate::util::display_path(&part))));
                }
                downloaded += chunk.len() as u64;
                stats.bytes_transferred += chunk.len() as u64;
                meter.emit("download", downloaded, total, false);
            }
            Some(Err(e)) => break Err(AttemptError::Transient(describe_network_error(&e))),
            None => break Ok(()),
        }
    };
    // Immer vollständig schreiben, damit die .part-Datei ein gültiger Anfang bleibt.
    if let Err(e) = writer.flush().await {
        return Err(AttemptError::Fatal(io_error("download", &e, &crate::util::display_path(&part))));
    }
    drop(writer);
    outcome?;
    if total > 0 && downloaded < total {
        return Err(AttemptError::Transient(tr("Die Verbindung wurde unterbrochen.", "The connection was interrupted.")));
    }
    meter.emit("download", downloaded, total.max(downloaded), true);
    Ok(())
}

/// Lokale Quelle (Datei/`file://`): einfach mit Fortschritt kopieren.
async fn copy_local(
    src: &Path,
    spec: &DownloadSpec,
    meter: &mut Meter,
    cancel: &CancellationToken,
    stats: &mut DownloadStats,
) -> Result<(), AttemptError> {
    let mut input = tokio::fs::File::open(src).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AttemptError::Fatal(InstallError::new(
                "download",
                "manifest",
                format!("{}: {}", tr("Die App-Datei wurde nicht gefunden", "The app file was not found"), src.display()),
                false,
            ))
        } else {
            AttemptError::Fatal(io_error("download", &e, &crate::util::display_path(src)))
        }
    })?;
    let total = input.metadata().await.map(|m| m.len()).unwrap_or(0);
    let part = spec.part_path();
    let out = tokio::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&part)
        .await
        .map_err(|e| AttemptError::Fatal(io_error("download", &e, &crate::util::display_path(&part))))?;
    let mut writer = BufWriter::with_capacity(256 * 1024, out);
    stats.requests += 1;
    let mut buf = vec![0u8; 1024 * 1024];
    let mut done = 0u64;
    meter.rebase(0);
    let outcome = loop {
        if cancel.is_cancelled() {
            break Err(AttemptError::Cancelled);
        }
        let n = match input.read(&mut buf).await {
            Ok(0) => break Ok(()),
            Ok(n) => n,
            Err(e) => break Err(AttemptError::Fatal(io_error("download", &e, &crate::util::display_path(src)))),
        };
        if let Err(e) = writer.write_all(&buf[..n]).await {
            break Err(AttemptError::Fatal(io_error("download", &e, &crate::util::display_path(&part))));
        }
        done += n as u64;
        stats.bytes_transferred += n as u64;
        meter.emit("download", done, total, false);
    };
    if let Err(e) = writer.flush().await {
        return Err(AttemptError::Fatal(io_error("download", &e, &crate::util::display_path(&part))));
    }
    outcome?;
    meter.emit("download", done, total.max(done), true);
    Ok(())
}

/// Streaming-SHA-256 der fertigen Datei. `Ok(true)` = geprüft, `Ok(false)` = keine Prüfsumme im Manifest.
/// Bei Abweichung werden .part und meta.json gelöscht (`checksum`-Fehler, wiederholbar).
pub async fn verify(spec: &DownloadSpec, progress: &ProgressFn, cancel: &CancellationToken) -> Result<bool, InstallError> {
    let part = spec.part_path();
    let corrupt = |msg: String| {
        discard_partial(spec);
        InstallError::new("verify", "checksum", msg, true)
    };
    let mut file = tokio::fs::File::open(&part).await.map_err(|e| io_error("verify", &e, &crate::util::display_path(&part)))?;
    let len = file.metadata().await.map(|m| m.len()).unwrap_or(0);
    if len == 0 || spec.size.is_some_and(|s| s != len) {
        return Err(corrupt(tr(
            "Die heruntergeladene Datei ist unvollständig. Bitte erneut versuchen.",
            "The downloaded file is incomplete. Please try again.",
        )));
    }
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    let mut read = 0u64;
    let mut head = [0u8; 2];
    let mut last_emit: Option<Instant> = None;
    loop {
        if cancel.is_cancelled() {
            return Err(cancelled_error("verify"));
        }
        let n = file.read(&mut buf).await.map_err(|e| io_error("verify", &e, &crate::util::display_path(&part)))?;
        if n == 0 {
            break;
        }
        if read == 0 && n >= 2 {
            head.copy_from_slice(&buf[..2]);
        }
        hasher.update(&buf[..n]);
        read += n as u64;
        if last_emit.is_none_or(|t| t.elapsed() >= EMIT_INTERVAL) {
            last_emit = Some(Instant::now());
            let percent = DOWNLOAD_END + (VERIFY_END - DOWNLOAD_END) * (read as f64 / len as f64);
            progress(Progress { phase: "verify", downloaded: len, total: len, speed: 0.0, eta: 0, percent });
        }
    }
    let actual = hex::encode(hasher.finalize());
    progress(Progress { phase: "verify", downloaded: len, total: len, speed: 0.0, eta: 0, percent: VERIFY_END });
    match &spec.sha256 {
        Some(expected) => {
            if !actual.eq_ignore_ascii_case(expected.trim()) {
                crate::util::log(format!("Prüfsumme falsch: erwartet {expected}, erhalten {actual}"));
                return Err(corrupt(tr(
                    "Die Prüfsumme stimmt nicht – die Datei wurde beschädigt übertragen. Bitte erneut versuchen.",
                    "Checksum mismatch – the file was corrupted during download. Please try again.",
                )));
            }
            Ok(true)
        }
        None => {
            // Ohne Prüfsumme wenigstens sicherstellen, dass keine HTML-Fehlerseite als .exe landet.
            if cfg!(windows) && spec.file_name.to_ascii_lowercase().ends_with(".exe") && &head != b"MZ" {
                return Err(corrupt(tr(
                    "Die heruntergeladene Datei ist kein gültiges Programm.",
                    "The downloaded file is not a valid program.",
                )));
            }
            crate::util::log(format!("Keine Prüfsumme im Manifest – SHA-256 der Datei: {actual}"));
            Ok(false)
        }
    }
}

/// SHA-256 einer Datei als Hex (für Tests und Selbsttest).
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}
