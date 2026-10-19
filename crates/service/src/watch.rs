//! Echtzeit-Wächter: **meldet, handelt nicht von allein.**
//!
//! - Dateien: neue/geänderte Dateien in Downloads, Desktop, Temp (je Nutzerprofil) und auf
//!   Wechseldatenträgern werden nach kurzer Ruhezeit im eingeschränkten Prüfprozess geprüft.
//! - Prozesse (Windows): Prozessstarts über ETW (`Microsoft-Windows-Kernel-Process`); das
//!   Programm wird geprüft. Ehrlich: Der Prozess läuft dann bereits – AEGIS warnt, blockiert
//!   nicht vor dem Start (kein Kernel-Treiber).
//! - Gaming-Modus: keine Prüfungen und keine Hinweise, solange er an ist; was ankam, wird
//!   danach geprüft.
//! - Funde landen in einem Ereignis-Puffer; die App holt sie ab und zeigt „Isolieren /
//!   Ignorieren / Vertrauen / Mehr Infos“ – jede Aktion nur über den Freigabe-Dialog.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use aegis_core::risk::RiskLevel;
use aegis_core::time::OffsetDateTime;
use aegis_engine::Finding;
use aegis_quarantine::OwnProcess;
use serde::Serialize;

use crate::worker::Scanner;

/// Höchstzahl gemerkter Ereignisse.
pub const MAX_EVENTS: usize = 500;
/// Dateien über dieser Größe prüft der Wächter nicht selbst (nur der manuelle Scan).
pub const MAX_WATCH_FILE: u64 = 64 * 1024 * 1024;
/// Höchstzahl Dateien je Prüflauf.
const BATCH: usize = 32;
/// Höchstzahl gemerkter, bereits geprüfter Dateien (Pfad + Änderungszeit + Größe).
const SEEN: usize = 20_000;
/// Höchstzahl wartender Dateien; darüber zählt der Wächter nur noch (sichtbar im Status).
const MAX_PENDING: usize = 10_000;
/// Der Gaming-Modus endet spätestens nach dieser Zeit von selbst – ein vergessener
/// Schalter lässt den Wächter nicht dauerhaft schweigen.
pub const GAMING_MAX: Duration = Duration::from_secs(4 * 60 * 60);

/// Woher ein Ereignis kommt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WatchKind {
    /// Neue oder geänderte Datei.
    File,
    /// Gestartetes Programm.
    Process,
}

/// Ein Fund des Wächters.
#[derive(Debug, Clone, Serialize)]
pub struct WatchEvent {
    /// Laufende Nummer (zum Abholen „nach …“).
    pub seq: u64,
    /// Zeitpunkt (RFC 3339).
    pub at: String,
    /// Art.
    pub kind: WatchKind,
    /// Betroffene Datei.
    pub path: PathBuf,
    /// Profilordner, zu dem die Datei gehört (`None` = gemeinsam, z. B. USB).
    #[serde(skip)]
    pub scope: Option<PathBuf>,
    /// Ergebnis der Prüfung.
    pub finding: Finding,
}

/// Zustand für die Anzeige.
#[derive(Debug, Clone, Default, Serialize)]
pub struct WatchStatus {
    /// Läuft der Wächter?
    pub active: bool,
    /// Überwachte Ordner.
    pub folders: Vec<PathBuf>,
    /// Werden Prozessstarts beobachtet?
    pub processes: bool,
    /// Gaming-Modus an?
    pub gaming: bool,
    /// Wartende, noch nicht geprüfte Dateien.
    pub pending: usize,
    /// Wegen Überlastung nicht geprüfte Dateien (seit Start).
    pub dropped: u64,
    /// Hinweis (z. B. warum Prozessstarts nicht beobachtet werden).
    pub note: Option<String>,
}

/// Wer Ereignisse abholt.
#[derive(Debug, Clone, Copy)]
pub enum Viewer<'a> {
    /// Ohne Kontotrennung (eigener Prozess, Entwicklung): alles.
    All,
    /// Ein Konto mit diesem Profilordner: eigene und gemeinsame Ereignisse.
    Profile(&'a Path),
    /// Konto ohne ermittelbaren Profilordner: nur gemeinsame Ereignisse (USB, Programme).
    SharedOnly,
}

/// Gemeinsamer Zustand zwischen Wächter und Dienst.
#[derive(Debug, Default)]
pub struct WatchShared {
    events: Mutex<VecDeque<WatchEvent>>,
    next_seq: Mutex<u64>,
    gaming_until: Mutex<Option<Instant>>,
    status: Mutex<WatchStatus>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl WatchShared {
    /// Neuer, leerer Zustand.
    #[must_use]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            next_seq: Mutex::new(1),
            ..Self::default()
        })
    }

    /// Ereignisse nach `after`, die `viewer` sehen darf.
    #[must_use]
    pub fn events_after(&self, after: u64, viewer: Viewer<'_>) -> Vec<WatchEvent> {
        lock(&self.events)
            .iter()
            .filter(|e| e.seq > after)
            .filter(|e| match (viewer, &e.scope) {
                (Viewer::All, _) | (_, None) => true,
                (Viewer::Profile(p), Some(s)) => same_dir(p, s),
                (Viewer::SharedOnly, Some(_)) => false,
            })
            .cloned()
            .collect()
    }

    /// Gaming-Modus setzen (endet spätestens nach [`GAMING_MAX`]).
    pub fn set_gaming(&self, on: bool) {
        *lock(&self.gaming_until) = on.then(|| Instant::now() + GAMING_MAX);
    }

    /// Gaming-Modus an?
    #[must_use]
    pub fn gaming(&self) -> bool {
        let mut until = lock(&self.gaming_until);
        match *until {
            Some(t) if Instant::now() < t => true,
            Some(_) => {
                *until = None;
                false
            }
            None => false,
        }
    }

    /// Restdauer des Gaming-Modus in Sekunden.
    #[must_use]
    pub fn gaming_left(&self) -> Option<u64> {
        lock(&self.gaming_until)
            .and_then(|t| t.checked_duration_since(Instant::now()))
            .map(|d| d.as_secs())
    }

    /// Hält fest, dass der Wächter nicht läuft (und warum).
    pub fn note_failure(&self, note: &str) {
        let mut status = lock(&self.status);
        status.active = false;
        status.note = Some(note.to_owned());
    }

    /// Aktueller Zustand.
    #[must_use]
    pub fn status(&self) -> WatchStatus {
        let mut status = lock(&self.status).clone();
        status.gaming = self.gaming();
        status
    }

    fn push(&self, kind: WatchKind, path: PathBuf, scope: Option<PathBuf>, finding: Finding) {
        let seq = {
            let mut next = lock(&self.next_seq);
            let seq = *next;
            *next += 1;
            seq
        };
        let at = OffsetDateTime::now_utc()
            .format(&aegis_core::time::format_description::well_known::Rfc3339)
            .unwrap_or_default();
        let mut events = lock(&self.events);
        events.push_back(WatchEvent {
            seq,
            at,
            kind,
            path,
            scope,
            finding,
        });
        while events.len() > MAX_EVENTS {
            events.pop_front();
        }
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

/// Liegt `path` in `dir` (komponentenweise; unter Windows ohne Groß-/Kleinschreibung)?
fn starts_with(path: &Path, dir: &Path) -> bool {
    if cfg!(windows) {
        let p = path.to_string_lossy().to_lowercase();
        let d = dir.to_string_lossy().to_lowercase();
        let d = d.trim_end_matches('\\');
        p == d || p.strip_prefix(d).is_some_and(|rest| rest.starts_with('\\'))
    } else {
        path.starts_with(dir)
    }
}

/// Was überwacht wird.
#[derive(Debug, Clone)]
pub struct WatchConfig {
    /// (Ordner, Profilordner des Besitzers oder `None`).
    pub folders: Vec<(PathBuf, Option<PathBuf>)>,
    /// Ordner, die nie geprüft werden (AEGIS-Datenordner).
    pub exclude: Vec<PathBuf>,
    /// Wechseldatenträger mit überwachen (Windows).
    pub removable: bool,
    /// Prozessstarts beobachten (Windows, ETW).
    pub processes: bool,
    /// Ruhezeit, bevor eine Datei geprüft wird (Schreiben abgeschlossen).
    pub settle: Duration,
}

impl WatchConfig {
    /// Standard: je Nutzerprofil Downloads, Desktop und Temp; Wechseldatenträger; Prozesse.
    /// Unter Unix (Entwicklung): Downloads/Desktop des eigenen Kontos.
    #[must_use]
    pub fn default_for_platform(exclude: Vec<PathBuf>) -> Self {
        let mut folders = Vec::new();
        #[cfg(windows)]
        {
            let users = std::env::var_os("SystemDrive")
                .map(|d| PathBuf::from(format!("{}\\Users", d.to_string_lossy())))
                .unwrap_or_else(|| PathBuf::from(r"C:\Users"));
            if let Ok(entries) = std::fs::read_dir(&users) {
                for entry in entries.flatten() {
                    let profile = entry.path();
                    let name = entry.file_name().to_string_lossy().to_lowercase();
                    if ["public", "default", "default user", "all users"].contains(&name.as_str())
                        || !profile.is_dir()
                    {
                        continue;
                    }
                    for sub in ["Downloads", "Desktop", r"AppData\Local\Temp"] {
                        let dir = profile.join(sub);
                        if dir.is_dir() {
                            folders.push((dir, Some(profile.clone())));
                        }
                    }
                }
            }
        }
        #[cfg(not(windows))]
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            for sub in ["Downloads", "Desktop"] {
                let dir = home.join(sub);
                if dir.is_dir() {
                    folders.push((dir, None));
                }
            }
        }
        Self {
            folders,
            exclude,
            removable: cfg!(windows),
            processes: cfg!(windows),
            settle: Duration::from_secs(2),
        }
    }
}

/// Startet den Wächter in eigenen Threads; endet, sobald `stop` gesetzt wird.
///
/// # Errors
/// Dateiüberwachung nicht startbar.
pub fn start(
    config: WatchConfig,
    scanner: Arc<Scanner>,
    shared: Arc<WatchShared>,
    stop: Arc<AtomicBool>,
) -> io::Result<()> {
    use notify::Watcher as _;
    // Alles in langen Namen vergleichen (Ereignisse, Profile, Ausnahmen).
    let mut config = config;
    config.folders = config
        .folders
        .into_iter()
        .map(|(dir, scope)| (long_name(dir), scope.map(long_name)))
        .collect();
    config.exclude = config.exclude.into_iter().map(long_name).collect();
    let (tx, rx) = mpsc::channel::<(PathBuf, WatchKind)>();
    let file_tx = Mutex::new(tx.clone());
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let Ok(event) = result else { return };
        if !matches!(
            event.kind,
            notify::EventKind::Create(_) | notify::EventKind::Modify(_)
        ) {
            return;
        }
        let tx = lock(&file_tx);
        for path in event.paths {
            let _ = tx.send((path, WatchKind::File));
        }
    })
    .map_err(io::Error::other)?;
    let mut watched = Vec::new();
    for (dir, _) in &config.folders {
        if watcher.watch(dir, notify::RecursiveMode::Recursive).is_ok() {
            watched.push(dir.clone());
        }
    }
    let mut note = None;
    let processes = config.processes && start_process_watch(&tx, &stop, &mut note);
    {
        let mut status = lock(&shared.status);
        *status = WatchStatus {
            active: true,
            folders: watched.clone(),
            processes,
            gaming: shared.gaming(),
            pending: 0,
            dropped: 0,
            note,
        };
    }
    let watcher = Arc::new(Mutex::new(watcher));
    if config.removable {
        spawn_removable_poller(Arc::clone(&watcher), Arc::clone(&shared), Arc::clone(&stop));
    }
    std::thread::spawn(move || {
        let _keep = watcher;
        scan_loop(&config, &rx, &scanner, &shared, &stop);
    });
    Ok(())
}

#[cfg(windows)]
fn spawn_removable_poller(
    watcher: Arc<Mutex<notify::RecommendedWatcher>>,
    shared: Arc<WatchShared>,
    stop: Arc<AtomicBool>,
) {
    use notify::Watcher as _;
    std::thread::spawn(move || {
        let mut known: Vec<PathBuf> = Vec::new();
        while !stop.load(Ordering::SeqCst) {
            for drive in aegis_winffi::removable_drives() {
                if !known.contains(&drive)
                    && lock(&watcher)
                        .watch(&drive, notify::RecursiveMode::Recursive)
                        .is_ok()
                {
                    lock(&shared.status).folders.push(drive.clone());
                    known.push(drive);
                }
            }
            std::thread::sleep(Duration::from_secs(15));
        }
    });
}

#[cfg(not(windows))]
fn spawn_removable_poller(
    _watcher: Arc<Mutex<notify::RecommendedWatcher>>,
    _shared: Arc<WatchShared>,
    _stop: Arc<AtomicBool>,
) {
}

/// Prozessstarts über ETW; liefert `false` (mit Hinweis), wenn nicht möglich.
#[cfg(windows)]
fn start_process_watch(
    tx: &Sender<(PathBuf, WatchKind)>,
    stop: &Arc<AtomicBool>,
    note: &mut Option<String>,
) -> bool {
    use ferrisetw::EventRecord;
    use ferrisetw::parser::Parser;
    use ferrisetw::provider::Provider;
    use ferrisetw::schema_locator::SchemaLocator;
    use ferrisetw::trace::UserTrace;

    const KERNEL_PROCESS: &str = "22fb2cd6-0e7b-422b-a0c7-2fad1fd0e716";
    const SESSION: &str = "AEGIS-Prozessstarts";
    let tx = Mutex::new(tx.clone());
    let provider = Provider::by_guid(KERNEL_PROCESS)
        .any(0x10) // WINEVENT_KEYWORD_PROCESS
        .add_callback(move |record: &EventRecord, locator: &SchemaLocator| {
            if record.event_id() != 1 {
                return;
            }
            let Ok(schema) = locator.event_schema(record) else {
                return;
            };
            let parser = Parser::create(record, &schema);
            let Ok(pid) = parser.try_parse::<u32>("ProcessID") else {
                return;
            };
            if let Ok(path) = aegis_winffi::process_image_path(pid) {
                let _ = lock(&tx).send((path, WatchKind::Process));
            }
        })
        .build();
    // Eine liegengebliebene Sitzung eines früheren Laufs zuerst beenden (eigener Name).
    let _ = ferrisetw::trace::stop_trace_by_name(SESSION);
    match UserTrace::new()
        .named(SESSION.to_owned())
        .enable(provider)
        .start_and_process()
    {
        Ok(trace) => {
            let stop = Arc::clone(stop);
            std::thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(500));
                }
                let _ = trace.stop();
            });
            true
        }
        Err(e) => {
            *note = Some(format!(
                "Prozessstarts werden nicht beobachtet (ETW: {e:?}) – nur Dateien"
            ));
            false
        }
    }
}

#[cfg(not(windows))]
fn start_process_watch(
    _tx: &Sender<(PathBuf, WatchKind)>,
    _stop: &Arc<AtomicBool>,
    note: &mut Option<String>,
) -> bool {
    *note = Some("Prozessstarts beobachtet AEGIS nur unter Windows (ETW)".into());
    false
}

/// Kurznamen (8.3) in lange Namen umschreiben – Meldungen zeigen den echten Namen und passen
/// zur Vertrauensliste und zum Vorschlag (der ebenfalls lange Namen verwendet).
pub(crate) fn long_name(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        aegis_winffi::long_path(&path).unwrap_or(path)
    }
    #[cfg(not(windows))]
    {
        path
    }
}

/// Kennzeichen einer Datei, um sie nicht doppelt zu prüfen.
fn fingerprint(path: &Path) -> Option<(SystemTime, u64)> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    meta.file_type().is_file().then(|| {
        (
            meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            meta.len(),
        )
    })
}

fn scan_loop(
    config: &WatchConfig,
    rx: &Receiver<(PathBuf, WatchKind)>,
    scanner: &Scanner,
    shared: &WatchShared,
    stop: &AtomicBool,
) {
    let mut pending: HashMap<PathBuf, (Instant, WatchKind)> = HashMap::new();
    let mut seen: HashMap<PathBuf, (SystemTime, u64)> = HashMap::new();
    while !stop.load(Ordering::SeqCst) {
        while let Ok((path, kind)) = rx.recv_timeout(Duration::from_millis(250)) {
            let path = long_name(path);
            if config.exclude.iter().any(|d| starts_with(&path, d)) {
                continue;
            }
            if pending.len() >= MAX_PENDING && !pending.contains_key(&path) {
                lock(&shared.status).dropped += 1;
                continue;
            }
            pending.insert(path, (Instant::now(), kind));
        }
        lock(&shared.status).pending = pending.len();
        if shared.gaming() {
            continue; // Gaming-Modus: nichts prüfen, nichts melden – später nachholen.
        }
        let ready: Vec<(PathBuf, WatchKind)> = pending
            .iter()
            .filter(|(_, (t, _))| t.elapsed() >= config.settle)
            .map(|(p, (_, k))| (p.clone(), *k))
            .take(BATCH)
            .collect();
        if ready.is_empty() {
            continue;
        }
        let mut batch = Vec::new();
        for (path, kind) in ready {
            pending.remove(&path);
            let Some(fp) = fingerprint(&path) else {
                continue;
            };
            if fp.1 > MAX_WATCH_FILE || seen.get(&path) == Some(&fp) {
                continue;
            }
            if seen.len() >= SEEN {
                seen.clear();
            }
            seen.insert(path.clone(), fp);
            batch.push((path, kind));
        }
        if batch.is_empty() {
            continue;
        }
        let paths: Vec<PathBuf> = batch.iter().map(|(p, _)| p.clone()).collect();
        let Ok(findings) = scanner.examine(&paths, &OwnProcess) else {
            continue;
        };
        for ((path, kind), finding) in batch.into_iter().zip(findings) {
            if finding.risk > RiskLevel::Info {
                // Gehört die Datei (auch ein gestartetes Programm) zu einem Profil, sieht sie
                // nur dieses Konto; sonst ist sie gemeinsam (USB, Programme-Ordner).
                let scope = config
                    .folders
                    .iter()
                    .filter_map(|(_, scope)| scope.as_ref())
                    .find(|profile| starts_with(&path, profile))
                    .cloned();
                shared.push(kind, path, scope, finding);
            }
        }
    }
    lock(&shared.status).active = false;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ereignisse_nach_profil_und_nummer() {
        let shared = WatchShared::new();
        let f = Finding::unscannable(PathBuf::from("/a"), "x");
        shared.push(
            WatchKind::File,
            PathBuf::from("/u/a/x"),
            Some(PathBuf::from("/u/a")),
            f.clone(),
        );
        shared.push(
            WatchKind::File,
            PathBuf::from("/u/b/y"),
            Some(PathBuf::from("/u/b")),
            f.clone(),
        );
        shared.push(WatchKind::Process, PathBuf::from("/usb/z"), None, f);
        assert_eq!(shared.events_after(0, Viewer::All).len(), 3);
        let a: Vec<u64> = shared
            .events_after(0, Viewer::Profile(Path::new("/u/a")))
            .iter()
            .map(|e| e.seq)
            .collect();
        assert_eq!(a, [1, 3], "eigenes Profil + gemeinsame Orte");
        assert_eq!(shared.events_after(0, Viewer::SharedOnly).len(), 1);
        assert_eq!(shared.events_after(2, Viewer::All).len(), 1);
        shared.set_gaming(true);
        assert!(shared.gaming() && shared.status().gaming);
        assert!(
            shared
                .gaming_left()
                .is_some_and(|s| s <= GAMING_MAX.as_secs())
        );
        shared.set_gaming(false);
        assert!(!shared.gaming());
    }

    #[test]
    fn pfad_liegt_nur_komponentenweise_im_ordner() {
        assert!(starts_with(Path::new("/u/bob/x"), Path::new("/u/bob")));
        assert!(!starts_with(Path::new("/u/bobby/x"), Path::new("/u/bob")));
    }

    #[test]
    fn waechter_meldet_eicar_im_ordner() {
        let dir = tempfile::tempdir().unwrap();
        let shared = WatchShared::new();
        let stop = Arc::new(AtomicBool::new(false));
        let config = WatchConfig {
            folders: vec![(dir.path().to_path_buf(), None)],
            exclude: Vec::new(),
            removable: false,
            processes: false,
            settle: Duration::from_millis(100),
        };
        let engine = aegis_engine::Engine::with_builtin_rules().unwrap();
        start(
            config,
            Arc::new(Scanner::InProcess(Arc::new(engine))),
            Arc::clone(&shared),
            Arc::clone(&stop),
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let eicar = aegis_core::testing::eicar();
        aegis_core::testing::write_fixture(dir.path(), "probe.com", &eicar).unwrap();
        aegis_core::testing::write_fixture(dir.path(), "harmlos.txt", b"hallo").unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut events = Vec::new();
        while Instant::now() < deadline && events.is_empty() {
            std::thread::sleep(Duration::from_millis(100));
            events = shared.events_after(0, Viewer::All);
        }
        stop.store(true, Ordering::SeqCst);
        assert_eq!(events.len(), 1, "nur die EICAR-Datei wird gemeldet");
        assert!(events[0].path.ends_with("probe.com"));
        assert!(events[0].finding.risk >= RiskLevel::Dangerous);
        assert!(
            dir.path().join("probe.com").exists(),
            "Wächter verändert nichts"
        );
    }
}
