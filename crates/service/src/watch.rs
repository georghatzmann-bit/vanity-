//! Echtzeit-Wächter: **meldet, handelt nicht von allein.**
//!
//! - Dateien: neue/geänderte Dateien in Downloads, Desktop, Temp (je Nutzerprofil, auch später
//!   angelegte Profile) und auf Wechseldatenträgern werden nach kurzer Ruhezeit im
//!   eingeschränkten Prüfprozess geprüft – mit den Rechten des Profil-Besitzers bzw. eines
//!   „nur Nutzer“-Kontos, nie als SYSTEM.
//! - Prozesse (Windows): Prozessstarts über ETW (`Microsoft-Windows-Kernel-Process`); das
//!   Programm wird geprüft, die Meldung gehört dem Konto, das es gestartet hat. Ehrlich: Der
//!   Prozess läuft dann bereits – AEGIS warnt, blockiert nicht vor dem Start (kein Treiber).
//! - Gaming-Modus je Konto: keine Hinweise und keine Prüfungen im eigenen Profil, solange er
//!   an ist (höchstens 4 h); was ankam, wird danach geprüft. Andere Konten sind nicht betroffen.
//! - Funde landen in einem Ereignis-Puffer; die App holt sie ab und zeigt „Isolieren /
//!   Ignorieren / Vertrauen / Mehr Infos“ – jede Aktion nur über den Freigabe-Dialog.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use aegis_core::risk::RiskLevel;
use aegis_core::time::OffsetDateTime;
use aegis_engine::Finding;
use serde::Serialize;

use crate::paths::{is_within, profile_of, same_path};
use crate::worker::Scanner;

/// Höchstzahl gemerkter Ereignisse insgesamt.
pub const MAX_EVENTS: usize = 1000;
/// Höchstzahl gemerkter Ereignisse je Konto/Profil (bzw. gemeinsamer Orte).
pub const MAX_EVENTS_PER_SCOPE: usize = 200;
/// Dateien über dieser Größe prüft der Wächter nicht selbst (nur der manuelle Scan).
pub const MAX_WATCH_FILE: u64 = 64 * 1024 * 1024;
/// Höchstzahl Dateien je Prüflauf.
const BATCH: usize = 32;
/// Höchstzahl gemerkter, bereits geprüfter Dateien (Pfad + Änderungszeit + Größe).
const SEEN: usize = 20_000;
/// Höchstzahl wartender Dateien; darüber zählt der Wächter nur noch (sichtbar im Status).
const MAX_PENDING: usize = 10_000;
/// Größe der Warteschlange zwischen Beobachtern und Prüfschleife.
const QUEUE: usize = 4096;
/// Höchstzahl Meldungen, die je Durchlauf aus der Warteschlange übernommen werden.
const DRAIN: usize = 2048;
/// Der Gaming-Modus endet spätestens nach dieser Zeit von selbst.
pub const GAMING_MAX: Duration = Duration::from_secs(4 * 60 * 60);

/// Woher ein Ereignis kommt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WatchKind {
    /// Neue oder geänderte Datei.
    File,
    /// Gestartetes Programm.
    Process,
    /// Fund eines geplanten Scans.
    Schedule,
    /// Ransomware-Verdacht (Köderdatei oder Massenänderungen).
    Ransomware,
    /// Neues Gerät (z. B. Tastatur – BadUSB-Hinweis).
    Device,
    /// Kamera bzw. Mikrofon wird benutzt.
    Privacy,
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
    /// Konto (SID), dem die Meldung gehört (Prozessstart: wer ihn gestartet hat).
    #[serde(skip)]
    pub owner: Option<String>,
    /// Ergebnis der Prüfung.
    pub finding: Finding,
}

/// Zustand für die Anzeige.
#[derive(Debug, Clone, Default, Serialize)]
pub struct WatchStatus {
    /// Läuft der Wächter?
    pub active: bool,
    /// Überwachte Ordner (für das abfragende Konto gefiltert).
    pub folders: Vec<PathBuf>,
    /// Werden Prozessstarts beobachtet?
    pub processes: bool,
    /// Gaming-Modus (des abfragenden Kontos) an?
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
    /// Ein Konto: eigene Meldungen, Meldungen des eigenen Profils und gemeinsamer Orte.
    Account {
        /// SID.
        sid: &'a str,
        /// Profilordner (falls ermittelbar).
        profile: Option<&'a Path>,
    },
}

impl Viewer<'_> {
    fn sees(&self, owner: Option<&str>, scope: Option<&Path>) -> bool {
        match *self {
            Viewer::All => true,
            Viewer::Account { sid, profile } => match (owner, scope) {
                (Some(o), _) => o == sid,
                (None, None) => true,
                (None, Some(s)) => profile.is_some_and(|p| same_path(p, s)),
            },
        }
    }
}

/// Gemeinsamer Zustand zwischen Wächter und Dienst.
#[derive(Debug, Default)]
pub struct WatchShared {
    events: Mutex<VecDeque<WatchEvent>>,
    next_seq: Mutex<u64>,
    /// Gaming-Modus je Profil (`None` = ohne Kontotrennung: alles).
    gaming_until: Mutex<HashMap<Option<PathBuf>, Instant>>,
    status: Mutex<WatchStatus>,
    history: Mutex<Option<Arc<Mutex<crate::history::History>>>>,
    /// Alle Profilordner, die der Wächter kennt (für die Anzeige gefiltert).
    profiles: Mutex<Vec<PathBuf>>,
    /// Ransomware-Erkennung (nur Warnungen).
    ransom: crate::ransom::RansomGuard,
    /// Geschützte Ordner – nur für die Ransomware-Erkennung beobachtet (ohne jede Datei zu
    /// prüfen). Ein Ordner kann mehreren Konten gehören (je ein Eintrag).
    protected: Mutex<Vec<Protected>>,
    /// Wartende Entropie-Stichproben (Pfad, Profil) und ihre Rate je Profil.
    entropy_queue: Mutex<VecDeque<(PathBuf, Option<PathBuf>)>>,
    entropy_rate: Mutex<HashMap<Option<PathBuf>, VecDeque<Instant>>>,
    /// Zuletzt gestartete Programme: (Zeit, Programm, Konto) – für „Einfrieren“ im Alarm.
    recent_starts: Mutex<VecDeque<(Instant, PathBuf, Option<String>)>>,
    /// Letzte Ransomware-Warnung je Profil (Rückfall-Kopien pausieren danach).
    ransom_alerts: Mutex<HashMap<Option<PathBuf>, Instant>>,
    /// Die Dateiüberwachung (zum späteren Hinzufügen geschützter Ordner).
    watcher: Mutex<Option<Arc<Mutex<notify::RecommendedWatcher>>>>,
}

/// Höchstzahl wartender Entropie-Stichproben.
const ENTROPY_QUEUE: usize = 500;
/// Höchstzahl Stichproben je Profil im Zeitfenster der Ransomware-Erkennung.
const ENTROPY_PER_WINDOW: usize = 40;
/// So lange gelten Programmstarts als „kürzlich“.
pub const RECENT_STARTS: Duration = Duration::from_secs(30 * 60);

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
            .filter(|e| viewer.sees(e.owner.as_deref(), e.scope.as_deref()))
            .cloned()
            .collect()
    }

    /// Gaming-Modus für ein Profil setzen (`None` = ohne Kontotrennung); endet spätestens nach
    /// [`GAMING_MAX`].
    pub fn set_gaming(&self, profile: Option<&Path>, on: bool) {
        let mut map = lock(&self.gaming_until);
        let key = profile.map(Path::to_path_buf);
        if on {
            map.insert(key, Instant::now() + GAMING_MAX);
        } else {
            map.remove(&key);
        }
    }

    fn gaming_until(&self, key: Option<&Path>) -> Option<Instant> {
        let mut map = lock(&self.gaming_until);
        map.retain(|_, t| Instant::now() < *t);
        map.iter()
            .find(|(k, _)| match (k, key) {
                (None, None) => true,
                (Some(k), Some(p)) => same_path(k, p),
                _ => false,
            })
            .map(|(_, t)| *t)
    }

    /// Gaming-Modus für Dateien dieses Profils (bzw. gemeinsamer Orte) an? Ohne
    /// Kontotrennung gesetzt (`None`) gilt er für alles.
    #[must_use]
    pub fn gaming_for(&self, scope: Option<&Path>) -> bool {
        self.gaming_until(None).is_some()
            || scope.is_some_and(|s| self.gaming_until(Some(s)).is_some())
    }

    /// Restdauer des Gaming-Modus eines Profils in Sekunden.
    #[must_use]
    pub fn gaming_left(&self, profile: Option<&Path>) -> Option<u64> {
        self.gaming_until(profile)
            .and_then(|t| t.checked_duration_since(Instant::now()))
            .map(|d| d.as_secs())
    }

    /// Meldungen zusätzlich im Verlauf festhalten.
    pub fn attach_history(&self, history: Arc<Mutex<crate::history::History>>) {
        *lock(&self.history) = Some(history);
    }

    /// Meldet einen Fund (Wächter, geplanter Scan).
    pub fn report(
        &self,
        kind: WatchKind,
        path: PathBuf,
        scope: Option<PathBuf>,
        owner: Option<String>,
        finding: Finding,
    ) {
        self.push(kind, path, scope, owner, finding);
    }

    /// Hält fest, dass der Wächter nicht läuft (und warum).
    pub fn note_failure(&self, note: &str) {
        let mut status = lock(&self.status);
        status.active = false;
        status.note = Some(note.to_owned());
    }

    fn note(&self, note: String) {
        lock(&self.status).note = Some(note);
    }

    fn count_drop(&self) {
        lock(&self.status).dropped += 1;
    }

    /// Ransomware-Erkennung (Köderdateien setzen).
    #[must_use]
    pub fn ransom(&self) -> &crate::ransom::RansomGuard {
        &self.ransom
    }

    /// Dateiänderung für die Ransomware-Erkennung; meldet ein erkanntes Muster (nur Warnung).
    ///
    /// `shown`: Liegt die Datei außerhalb der Profile in einem geschützten Ordner, nennt die
    /// Meldung nur diesen Ordner – Dateinamen aus Unterordnern, die das Konto nicht lesen darf,
    /// verlassen den Dienst so nie.
    pub fn observe_change(
        &self,
        change: crate::ransom::FileChange,
        path: &Path,
        scope: Option<PathBuf>,
        shown: Option<&Path>,
    ) {
        let now = Instant::now();
        if crate::ransom::wants_entropy(change, path, scope.as_deref()) {
            let mut rate = lock(&self.entropy_rate);
            if rate.len() > 1000 {
                rate.clear();
            }
            let times = rate.entry(scope.clone()).or_default();
            while times
                .front()
                .is_some_and(|t| now.duration_since(*t) > crate::ransom::WINDOW)
            {
                times.pop_front();
            }
            let mut queue = lock(&self.entropy_queue);
            if times.len() < ENTROPY_PER_WINDOW && queue.len() < ENTROPY_QUEUE {
                times.push_back(now);
                queue.push_back((path.to_path_buf(), scope.clone()));
            }
        }
        if let Some(signal) = self.ransom.observe(change, path, scope.as_deref(), now) {
            let (signal, path) = match shown {
                Some(root) => (signal.shown_as(root), root.to_path_buf()),
                None => (signal, path.to_path_buf()),
            };
            let finding = signal.finding();
            self.push(WatchKind::Ransomware, path, scope, None, finding);
        }
    }

    /// Beobachtet `dir` zusätzlich für die Ransomware-Erkennung (Köder, Massenänderungen,
    /// Entropie) – geprüft wird dort nicht jede Datei. `profile`: Besitzer (für Meldungen).
    /// Vom Nutzer gewählt: [`Self::unprotect`] nimmt ihn wieder heraus.
    pub fn protect(&self, dir: PathBuf, profile: Option<PathBuf>) -> bool {
        self.add_protected(dir, profile, false)
    }

    /// Wie [`Self::protect`] für die Standardordner (Dokumente, Bilder): bleibt immer.
    pub fn protect_default(&self, dir: PathBuf, profile: Option<PathBuf>) -> bool {
        self.add_protected(dir, profile, true)
    }

    fn add_protected(&self, dir: PathBuf, profile: Option<PathBuf>, pinned: bool) -> bool {
        use notify::Watcher as _;
        let dir = long_name(dir);
        let profile = profile.map(long_name);
        let already_watched = {
            let mut list = lock(&self.protected);
            if let Some(entry) = list
                .iter_mut()
                .find(|e| same_path(&e.dir, &dir) && same_profile(&e.profile, &profile))
            {
                entry.pinned |= pinned;
                return true;
            }
            if list.len() >= MAX_PROTECTED {
                return false;
            }
            let watched = list.iter().any(|e| same_path(&e.dir, &dir));
            list.push(Protected {
                dir: dir.clone(),
                profile,
                pinned,
            });
            watched
        };
        already_watched
            || lock(&self.watcher).as_ref().is_some_and(|w| {
                lock(w)
                    .watch(&dir, notify::RecursiveMode::Recursive)
                    .is_ok()
            })
    }

    /// Beendet die zusätzliche Beobachtung von `dir` für das Konto mit `profile` (Standard-
    /// ordner bleiben; beobachtet wird weiter, solange noch jemand den Ordner schützt oder er
    /// ohnehin geprüft wird).
    pub fn unprotect(&self, dir: &Path, profile: Option<&Path>) {
        use notify::Watcher as _;
        let dir = long_name(dir.to_path_buf());
        let profile = profile.map(|p| long_name(p.to_path_buf()));
        let mut list = lock(&self.protected);
        let before = list.len();
        list.retain(|e| {
            e.pinned || !(same_path(&e.dir, &dir) && same_profile(&e.profile, &profile))
        });
        let still = list.iter().any(|e| same_path(&e.dir, &dir));
        drop(list);
        let scanned = lock(&self.status)
            .folders
            .iter()
            .any(|f| same_path(f, &dir));
        if before != lock(&self.protected).len()
            && !still
            && !scanned
            && let Some(w) = lock(&self.watcher).as_ref()
        {
            let _ = lock(w).unwatch(&dir);
        }
    }

    /// Wem gehört `path` als geschützter Ordner? Je Konto: (Profil, Schutzordner).
    fn protected_scopes(&self, path: &Path) -> Vec<(Option<PathBuf>, PathBuf)> {
        let mut out: Vec<(Option<PathBuf>, PathBuf)> = Vec::new();
        for e in lock(&self.protected)
            .iter()
            .filter(|e| is_within(path, &e.dir))
        {
            if !out.iter().any(|(p, _)| same_profile(p, &e.profile)) {
                out.push((e.profile.clone(), e.dir.clone()));
            }
        }
        out
    }

    fn is_protected(&self, path: &Path) -> bool {
        lock(&self.protected)
            .iter()
            .any(|e| is_within(path, &e.dir))
    }

    /// Gab es für das Profil in der letzten Zeit `within` eine Ransomware-Warnung?
    #[must_use]
    pub fn ransom_alert_within(&self, profile: Option<&Path>, within: Duration) -> bool {
        lock(&self.ransom_alerts).iter().any(|(scope, t)| {
            t.elapsed() < within
                && match (scope, profile) {
                    (Some(s), Some(p)) => same_path(s, p),
                    (None, None) => true,
                    _ => false,
                }
        })
    }

    /// Ein Programm wurde gestartet (für „Einfrieren“ im Ransomware-Alarm).
    pub fn record_start(&self, program: PathBuf, owner: Option<String>) {
        let now = Instant::now();
        let mut starts = lock(&self.recent_starts);
        while starts
            .front()
            .is_some_and(|(t, ..)| now.duration_since(*t) > RECENT_STARTS)
            || starts.len() >= 1000
        {
            starts.pop_front();
        }
        starts.push_back((now, program, owner));
    }

    /// Kürzlich gestartete Programme eines Kontos (neueste zuerst, je Programm einmal).
    #[must_use]
    pub fn recent_starts_of(&self, owner: Option<&str>) -> Vec<PathBuf> {
        let now = Instant::now();
        let mut out: Vec<PathBuf> = Vec::new();
        for (t, program, by) in lock(&self.recent_starts).iter().rev() {
            if now.duration_since(*t) > RECENT_STARTS || by.as_deref() != owner {
                continue;
            }
            if !out.iter().any(|p| same_path(p, program)) {
                out.push(program.clone());
            }
            if out.len() >= 20 {
                break;
            }
        }
        out
    }

    /// Nimmt bis zu `max` wartende Entropie-Stichproben.
    fn take_entropy(&self, max: usize) -> Vec<(PathBuf, Option<PathBuf>)> {
        let mut queue = lock(&self.entropy_queue);
        let n = queue.len().min(max);
        queue.drain(..n).collect()
    }

    /// Ergebnis einer Entropie-Stichprobe.
    pub fn observe_entropy(&self, path: &Path, scope: Option<PathBuf>, entropy: f64) {
        if let Some(signal) =
            self.ransom
                .observe_entropy(path, scope.as_deref(), entropy, Instant::now())
        {
            let finding = signal.finding();
            self.push(
                WatchKind::Ransomware,
                path.to_path_buf(),
                scope,
                None,
                finding,
            );
        }
    }

    fn add_profiles(&self, profiles: impl IntoIterator<Item = PathBuf>) {
        let mut known = lock(&self.profiles);
        for p in profiles {
            if !known.iter().any(|k| same_path(k, &p)) {
                known.push(p);
            }
        }
    }

    /// Zustand für `viewer`: Ordner anderer Profile werden nicht gezeigt.
    #[must_use]
    pub fn status(&self, viewer: Viewer<'_>) -> WatchStatus {
        let mut status = lock(&self.status).clone();
        let profiles = lock(&self.profiles).clone();
        if let Viewer::Account { profile, .. } = viewer {
            status
                .folders
                .retain(|f| match profiles.iter().find(|p| is_within(f, p)) {
                    None => true,
                    Some(owner) => profile.is_some_and(|mine| same_path(owner, mine)),
                });
        }
        status.gaming = match viewer {
            Viewer::All => self.gaming_until(None).is_some(),
            Viewer::Account { profile, .. } => profile.is_some_and(|p| self.gaming_for(Some(p))),
        };
        status
    }

    fn push(
        &self,
        kind: WatchKind,
        path: PathBuf,
        scope: Option<PathBuf>,
        owner: Option<String>,
        finding: Finding,
    ) {
        let seq = {
            let mut next = lock(&self.next_seq);
            let seq = *next;
            *next += 1;
            seq
        };
        if kind == WatchKind::Ransomware {
            let mut alerts = lock(&self.ransom_alerts);
            if alerts.len() > 1000 {
                alerts.clear();
            }
            alerts.insert(scope.clone(), Instant::now());
        }
        let now = OffsetDateTime::now_utc();
        let at = now
            .format(&aegis_core::time::format_description::well_known::Rfc3339)
            .unwrap_or_default();
        if kind != WatchKind::Schedule
            && let Some(history) = lock(&self.history).as_ref()
        {
            let label = match kind {
                WatchKind::Process => "Programmstart",
                WatchKind::Ransomware => "Ransomware-Verdacht",
                _ => "Neue Datei",
            };
            lock(history).add(
                now,
                crate::history::NewEntry {
                    kind: crate::history::HistoryKind::Watch,
                    risk: Some(finding.risk),
                    title: format!("Wächter – {label}: {}", finding.summary_de),
                    detail: finding.not_scannable.clone().unwrap_or_default(),
                    paths: vec![path.clone()],
                    owner: owner.clone(),
                    scope: scope.clone(),
                },
            );
        }
        let mut events = lock(&self.events);
        let same = |e: &WatchEvent| e.scope == scope && e.owner == owner;
        if events.iter().filter(|e| same(e)).count() >= MAX_EVENTS_PER_SCOPE
            && let Some(i) = events.iter().position(same)
        {
            events.remove(i);
        }
        events.push_back(WatchEvent {
            seq,
            at,
            kind,
            path,
            scope,
            owner,
            finding,
        });
        while events.len() > MAX_EVENTS {
            events.pop_front();
        }
    }
}

/// Was überwacht wird.
#[derive(Debug, Clone)]
pub struct WatchConfig {
    /// (Ordner, Profilordner des Besitzers oder `None`).
    pub folders: Vec<(PathBuf, Option<PathBuf>)>,
    /// Wurzeln der Nutzerprofile (`C:\Users`): Dateien darunter gehören immer einem Profil –
    /// auch, wenn es erst nach dem Start entstanden ist.
    pub profile_roots: Vec<PathBuf>,
    /// Ordner, die nie geprüft werden (AEGIS-Datenordner).
    pub exclude: Vec<PathBuf>,
    /// Standard-Schutzordner (nur Ransomware-Erkennung): (Ordner, Profil).
    pub protected: Vec<(PathBuf, Option<PathBuf>)>,
    /// Vom Nutzer gewählte Schutzordner: (Ordner, Profil des Besitzers).
    pub custom_protected: Vec<(PathBuf, Option<PathBuf>)>,
    /// Wechseldatenträger und neue Profile mit überwachen (Windows).
    pub removable: bool,
    /// Prozessstarts beobachten (Windows, ETW).
    pub processes: bool,
    /// Ruhezeit, bevor eine Datei geprüft wird (Schreiben abgeschlossen).
    pub settle: Duration,
    /// Mit welchen Rechten geprüft wird.
    pub identity: ScanIdentity,
}

/// Rechte für Prüfungen des Wächters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanIdentity {
    /// Betrieb: Profil-Besitzer bzw. „nur Nutzer“-Token, nie der Dienst selbst.
    Background,
    /// Nur Tests und Konsolenbetrieb als normaler Nutzer: der eigene Prozess.
    OwnProcess,
}

/// Unterordner eines Profils, die der Wächter beobachtet.
#[cfg(windows)]
const PROFILE_FOLDERS: [&str; 3] = ["Downloads", "Desktop", r"AppData\Local\Temp"];

/// Standard-Schutzordner je Profil (Ransomware-Erkennung; Desktop wird ohnehin beobachtet).
pub const PROTECTED_FOLDERS: [&str; 2] = ["Documents", "Pictures"];

/// Höchstzahl geschützter Ordner (alle Konten).
const MAX_PROTECTED: usize = 2000;

/// Ein geschützter Ordner eines Kontos.
#[derive(Debug, Clone)]
struct Protected {
    dir: PathBuf,
    profile: Option<PathBuf>,
    /// Standardordner (bleibt, auch wenn das Konto ihn zusätzlich selbst wählt und wieder
    /// entfernt).
    pinned: bool,
}

fn same_profile(a: &Option<PathBuf>, b: &Option<PathBuf>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => same_path(a, b),
        (None, None) => true,
        _ => false,
    }
}

/// Wurzel der Nutzerprofile.
#[cfg(windows)]
fn users_root() -> PathBuf {
    std::env::var_os("SystemDrive")
        .map(|d| PathBuf::from(format!("{}\\Users", d.to_string_lossy())))
        .unwrap_or_else(|| PathBuf::from(r"C:\Users"))
}

/// Profile unter `root` (ohne Public/Default).
#[cfg(windows)]
fn profiles_in(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_lowercase();
            !["public", "default", "default user", "all users"].contains(&name.as_str())
                && e.path().is_dir()
        })
        .map(|e| e.path())
        .collect()
}

impl WatchConfig {
    /// Standard: je Nutzerprofil Downloads, Desktop und Temp; Wechseldatenträger; Prozesse.
    /// Unter Unix (Entwicklung): Downloads/Desktop des eigenen Kontos.
    #[must_use]
    pub fn default_for_platform(exclude: Vec<PathBuf>) -> Self {
        let mut folders = Vec::new();
        #[cfg_attr(not(windows), allow(unused_mut))]
        let mut profile_roots = Vec::new();
        #[cfg_attr(not(windows), allow(unused_mut))]
        let mut protected = Vec::new();
        #[cfg(windows)]
        {
            let users = users_root();
            for profile in profiles_in(&users) {
                for sub in PROFILE_FOLDERS {
                    let dir = profile.join(sub);
                    if dir.is_dir() {
                        folders.push((dir, Some(profile.clone())));
                    }
                }
                for sub in PROTECTED_FOLDERS {
                    let dir = profile.join(sub);
                    if dir.is_dir() {
                        protected.push((dir, Some(profile.clone())));
                    }
                }
            }
            profile_roots.push(users);
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
            profile_roots,
            exclude,
            protected,
            custom_protected: Vec::new(),
            removable: cfg!(windows),
            processes: cfg!(windows),
            settle: Duration::from_secs(2),
            identity: ScanIdentity::Background,
        }
    }

    /// Profil einer Datei: über die Profil-Wurzeln oder die konfigurierten Ordner.
    fn scope_of(&self, path: &Path) -> Option<PathBuf> {
        profile_of(path, &self.profile_roots).or_else(|| {
            self.folders
                .iter()
                .filter_map(|(_, scope)| scope.as_ref())
                .find(|profile| is_within(path, profile))
                .cloned()
        })
    }
}

/// Zuordnung Pfad → Profil (für den Rückruf der Dateiüberwachung).
struct ScopeMap {
    folders: Vec<(PathBuf, Option<PathBuf>)>,
    profile_roots: Vec<PathBuf>,
}

impl ScopeMap {
    fn in_scan_folder(&self, path: &Path) -> bool {
        self.folders.iter().any(|(d, _)| is_within(path, d))
    }

    fn scope_of(&self, path: &Path) -> Option<PathBuf> {
        profile_of(path, &self.profile_roots).or_else(|| {
            self.folders
                .iter()
                .filter_map(|(_, scope)| scope.as_ref())
                .find(|profile| is_within(path, profile))
                .cloned()
        })
    }
}

/// Art der Änderung für die Ransomware-Erkennung (Umbenennen: alter und neuer Name zählen als
/// „umbenannt“; gezählt wird je Endung, also fällt der neue Name ins Gewicht).
fn ransom_change(kind: &notify::EventKind) -> Option<crate::ransom::FileChange> {
    use crate::ransom::FileChange;
    use notify::EventKind;
    use notify::event::{ModifyKind, RenameMode};
    match kind {
        EventKind::Create(_) => Some(FileChange::Created),
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => Some(FileChange::RenamedFrom),
        EventKind::Modify(ModifyKind::Name(_)) => Some(FileChange::Renamed),
        EventKind::Modify(ModifyKind::Metadata(_)) => None,
        EventKind::Modify(_) => Some(FileChange::Modified),
        EventKind::Remove(_) => Some(FileChange::Removed),
        _ => None,
    }
}

/// Eine Beobachtung (Datei bzw. gestartetes Programm mit Konto).
type Incoming = (PathBuf, WatchKind, Option<String>);

/// Reicht eine Beobachtung weiter; ist die Warteschlange voll, wird gezählt statt gewartet.
fn offer(tx: &SyncSender<Incoming>, shared: &WatchShared, item: Incoming) {
    match tx.try_send(item) {
        Ok(()) | Err(TrySendError::Disconnected(_)) => {}
        Err(TrySendError::Full(_)) => shared.count_drop(),
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
    config.profile_roots = config.profile_roots.into_iter().map(long_name).collect();
    config.exclude = config.exclude.into_iter().map(long_name).collect();
    shared.add_profiles(config.folders.iter().filter_map(|(_, s)| s.clone()));
    let (tx, rx) = mpsc::sync_channel::<Incoming>(QUEUE);
    let file_tx = tx.clone();
    let file_shared = Arc::clone(&shared);
    let scopes = ScopeMap {
        folders: config.folders.clone(),
        profile_roots: config.profile_roots.clone(),
    };
    let exclude = config.exclude.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let Ok(event) = result else { return };
        if event.need_rescan() {
            file_shared.note(
                "Zu viele Dateiänderungen auf einmal – einige wurden nicht einzeln gemeldet. Bitte bei Bedarf einen Scan starten.".into(),
            );
        }
        if let Some(change) = ransom_change(&event.kind) {
            // Umbenennen in einem Ereignis (alt, neu): der alte Name zählt nur für Köder.
            let both = event.paths.len() == 2 && change == crate::ransom::FileChange::Renamed;
            for (i, path) in event.paths.iter().enumerate() {
                let change = if both && i == 0 {
                    crate::ransom::FileChange::RenamedFrom
                } else {
                    change
                };
                let path = long_name(path.clone());
                // Der AEGIS-Datenordner zählt nie mit (eigene Schreibvorgänge des Dienstes).
                if exclude.iter().any(|e| is_within(&path, e)) {
                    continue;
                }
                if let Some(scope) = scopes.scope_of(&path) {
                    file_shared.observe_change(change, &path, Some(scope), None);
                    continue;
                }
                // Außerhalb der Profile: jedem Konto, das den Ordner schützt, nur mit dem
                // Schutzordner als Ort (keine fremden Dateinamen).
                let owners = file_shared.protected_scopes(&path);
                if owners.is_empty() {
                    file_shared.observe_change(change, &path, None, None);
                }
                for (scope, root) in owners {
                    file_shared.observe_change(change, &path, scope, Some(&root));
                }
            }
        }
        if !matches!(
            event.kind,
            notify::EventKind::Create(_) | notify::EventKind::Modify(_)
        ) {
            return;
        }
        for path in event.paths {
            // Geschützte Ordner dienen nur der Ransomware-Erkennung – dort wird nicht jede
            // Datei geprüft (außer sie liegt zugleich in einem geprüften Ordner).
            let long = long_name(path.clone());
            if file_shared.is_protected(&long) && !scopes.in_scan_folder(&long) {
                continue;
            }
            offer(&file_tx, &file_shared, (path, WatchKind::File, None));
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
    let processes = config.processes && start_process_watch(&tx, &shared, &stop, &mut note);
    {
        let mut status = lock(&shared.status);
        *status = WatchStatus {
            active: true,
            folders: watched,
            processes,
            gaming: false,
            pending: 0,
            dropped: 0,
            note,
        };
    }
    let watcher = Arc::new(Mutex::new(watcher));
    *lock(&shared.watcher) = Some(Arc::clone(&watcher));
    for (dir, profile) in std::mem::take(&mut config.protected) {
        shared.protect_default(dir, profile);
    }
    for (dir, profile) in std::mem::take(&mut config.custom_protected) {
        shared.protect(dir, profile);
    }
    spawn_entropy(
        config.identity,
        Arc::clone(&scanner),
        Arc::clone(&shared),
        Arc::clone(&stop),
    );
    if config.removable {
        spawn_poller(Arc::clone(&watcher), Arc::clone(&shared), Arc::clone(&stop));
    }
    drop(tx);
    std::thread::spawn(move || {
        let _keep = watcher;
        scan_loop(&config, &rx, &scanner, &shared, &stop);
    });
    Ok(())
}

/// Misst wartende Entropie-Stichproben im Prüfprozess – mit den Rechten des Profil-Besitzers
/// (angemeldet), sonst gar nicht; nie mit den Rechten des Dienstes.
fn spawn_entropy(
    identity: ScanIdentity,
    scanner: Arc<Scanner>,
    shared: Arc<WatchShared>,
    stop: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        while !stop.load(Ordering::SeqCst) {
            let batch = shared.take_entropy(crate::worker::MAX_ENTROPY_FILES);
            if batch.is_empty() {
                std::thread::sleep(Duration::from_millis(500));
                continue;
            }
            let mut groups: HashMap<Option<PathBuf>, Vec<PathBuf>> = HashMap::new();
            for (path, scope) in batch {
                let group = groups.entry(scope).or_default();
                if !group.iter().any(|p| same_path(p, &path)) {
                    group.push(path);
                }
            }
            for (scope, paths) in groups {
                let background = crate::worker::BackgroundAccess {
                    profile: scope.clone(),
                    require_owner: true,
                    owner: None,
                };
                let access: &dyn aegis_quarantine::UserAccess = match identity {
                    ScanIdentity::Background => &background,
                    ScanIdentity::OwnProcess => &aegis_quarantine::OwnProcess,
                };
                if let Ok(values) = scanner.entropy(&paths, access) {
                    for (path, value) in paths.iter().zip(values) {
                        if let Some(v) = value {
                            shared.observe_entropy(path, scope.clone(), v);
                        }
                    }
                }
            }
        }
    });
}

/// Wechseldatenträger kommen und gehen; neue Nutzerprofile werden nachträglich beobachtet.
#[cfg(windows)]
fn spawn_poller(
    watcher: Arc<Mutex<notify::RecommendedWatcher>>,
    shared: Arc<WatchShared>,
    stop: Arc<AtomicBool>,
) {
    use notify::Watcher as _;
    std::thread::spawn(move || {
        let mut drives: Vec<PathBuf> = Vec::new();
        let mut round = 0u32;
        while !stop.load(Ordering::SeqCst) {
            let now = aegis_winffi::removable_drives();
            for gone in drives.iter().filter(|d| !now.contains(d)) {
                let _ = lock(&watcher).unwatch(gone);
                lock(&shared.status).folders.retain(|f| f != gone);
            }
            drives.retain(|d| now.contains(d));
            for drive in now {
                if !drives.contains(&drive)
                    && lock(&watcher)
                        .watch(&drive, notify::RecursiveMode::Recursive)
                        .is_ok()
                {
                    lock(&shared.status).folders.push(drive.clone());
                    drives.push(drive);
                }
            }
            // Jede Minute: neue Profile (z. B. neues Konto) aufnehmen.
            if round.is_multiple_of(4) {
                let known = lock(&shared.profiles).clone();
                for profile in profiles_in(&users_root()).into_iter().map(long_name) {
                    if known.iter().any(|k| same_path(k, &profile)) {
                        continue;
                    }
                    for sub in PROFILE_FOLDERS {
                        let dir = profile.join(sub);
                        if dir.is_dir()
                            && lock(&watcher)
                                .watch(&dir, notify::RecursiveMode::Recursive)
                                .is_ok()
                        {
                            lock(&shared.status).folders.push(dir);
                        }
                    }
                    for sub in PROTECTED_FOLDERS {
                        let dir = profile.join(sub);
                        if dir.is_dir() {
                            shared.protect_default(dir, Some(profile.clone()));
                        }
                    }
                    shared.add_profiles([profile]);
                }
            }
            round = round.wrapping_add(1);
            std::thread::sleep(Duration::from_secs(15));
        }
    });
}

#[cfg(not(windows))]
fn spawn_poller(
    _watcher: Arc<Mutex<notify::RecommendedWatcher>>,
    _shared: Arc<WatchShared>,
    _stop: Arc<AtomicBool>,
) {
}

/// Prozessstarts über ETW; liefert `false` (mit Hinweis), wenn nicht möglich.
#[cfg(windows)]
fn start_process_watch(
    tx: &SyncSender<Incoming>,
    shared: &Arc<WatchShared>,
    stop: &Arc<AtomicBool>,
    note: &mut Option<String>,
) -> bool {
    use ferrisetw::EventRecord;
    use ferrisetw::parser::Parser;
    use ferrisetw::provider::Provider;
    use ferrisetw::schema_locator::SchemaLocator;
    use ferrisetw::trace::UserTrace;

    const KERNEL_PROCESS: &str = "22fb2cd6-0e7b-422b-a0c7-2fad1fd0e716";
    // Eigener Name je Dienst-Start: Eine fremde Sitzung gleichen Namens kann den Wächter nicht
    // aushebeln, und AEGIS beendet nie fremde Sitzungen.
    let session = format!("AEGIS-Prozessstarts-{}", std::process::id());
    let tx = tx.clone();
    let cb_shared = Arc::clone(shared);
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
                let owner = aegis_winffi::process_user_sid(pid).ok();
                cb_shared.record_start(path.clone(), owner.clone());
                offer(&tx, &cb_shared, (path, WatchKind::Process, owner));
            }
        })
        .build();
    match UserTrace::new()
        .named(session)
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
    _tx: &SyncSender<Incoming>,
    _shared: &Arc<WatchShared>,
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

/// Wartende Datei.
#[derive(Debug, Clone)]
struct Waiting {
    since: Instant,
    kind: WatchKind,
    scope: Option<PathBuf>,
    owner: Option<String>,
}

/// Bereit zur Prüfung: Pfad, Art, Konto, Kennzeichen.
type Ready = (PathBuf, WatchKind, Option<String>, (SystemTime, u64));

fn scan_loop(
    config: &WatchConfig,
    rx: &Receiver<Incoming>,
    scanner: &Scanner,
    shared: &WatchShared,
    stop: &AtomicBool,
) {
    let mut pending: HashMap<PathBuf, Waiting> = HashMap::new();
    let mut seen: HashMap<PathBuf, (SystemTime, u64)> = HashMap::new();
    while !stop.load(Ordering::SeqCst) {
        // Warten höchstens 250 ms, dann begrenzt übernehmen – ein Dauerstrom an Ereignissen
        // kann die Prüfung nicht aushungern.
        let mut incoming = Vec::new();
        if let Ok(item) = rx.recv_timeout(Duration::from_millis(250)) {
            incoming.push(item);
            while incoming.len() < DRAIN
                && let Ok(item) = rx.try_recv()
            {
                incoming.push(item);
            }
        }
        for (path, kind, owner) in incoming {
            let path = long_name(path);
            if config.exclude.iter().any(|d| is_within(&path, d)) {
                continue;
            }
            if pending.len() >= MAX_PENDING && !pending.contains_key(&path) {
                shared.count_drop();
                continue;
            }
            let scope = config.scope_of(&path);
            pending.insert(
                path,
                Waiting {
                    since: Instant::now(),
                    kind,
                    scope,
                    owner,
                },
            );
        }
        lock(&shared.status).pending = pending.len();
        // Gaming-Modus: Dateien des betroffenen Profils warten, der Rest wird geprüft.
        let ready_paths: Vec<PathBuf> = pending
            .iter()
            .filter(|(_, w)| w.since.elapsed() >= config.settle)
            .filter(|(_, w)| !shared.gaming_for(w.scope.as_deref()))
            .map(|(p, _)| p.clone())
            .take(BATCH)
            .collect();
        let mut groups: HashMap<Option<PathBuf>, Vec<Ready>> = HashMap::new();
        for path in ready_paths {
            let Some(w) = pending.remove(&path) else {
                continue;
            };
            let Some(fp) = fingerprint(&path) else {
                continue;
            };
            if fp.1 > MAX_WATCH_FILE || seen.get(&path) == Some(&fp) {
                continue;
            }
            groups
                .entry(w.scope)
                .or_default()
                .push((path, w.kind, w.owner, fp));
        }
        for (scope, items) in groups {
            scan_group(config, scanner, shared, &mut seen, scope, items);
        }
    }
    lock(&shared.status).active = false;
}

/// Prüft die Dateien eines Profils (bzw. gemeinsamer Orte). Gelingt der Lauf nicht, wird jede
/// Datei einzeln geprüft – eine Datei, die den Prüfprozess abstürzen lässt, versteckt so keine
/// anderen und wird selbst als „nicht prüfbar“ gemeldet.
fn scan_group(
    config: &WatchConfig,
    scanner: &Scanner,
    shared: &WatchShared,
    seen: &mut HashMap<PathBuf, (SystemTime, u64)>,
    scope: Option<PathBuf>,
    items: Vec<Ready>,
) {
    let background = crate::worker::BackgroundAccess {
        profile: scope.clone(),
        require_owner: false,
        owner: None,
    };
    let access: &dyn aegis_quarantine::UserAccess = match config.identity {
        ScanIdentity::Background => &background,
        ScanIdentity::OwnProcess => &aegis_quarantine::OwnProcess,
    };
    let paths: Vec<PathBuf> = items.iter().map(|(p, ..)| p.clone()).collect();
    let results: Vec<Result<Finding, String>> = match scanner.examine(&paths, access) {
        Ok(findings) => findings.into_iter().map(Ok).collect(),
        Err(e) => {
            shared.note(format!("Prüfprozess: {e}"));
            paths
                .iter()
                .map(|p| {
                    scanner
                        .examine(std::slice::from_ref(p), access)
                        .and_then(|mut f| f.pop().ok_or_else(|| "kein Ergebnis".to_owned()))
                })
                .collect()
        }
    };
    for ((path, kind, owner, fp), result) in items.into_iter().zip(results) {
        if seen.len() >= SEEN {
            seen.clear();
        }
        match result {
            Ok(finding) => {
                seen.insert(path.clone(), fp);
                if finding.risk > RiskLevel::Info {
                    shared.push(kind, path, scope.clone(), owner, finding);
                }
            }
            Err(message) => {
                seen.insert(path.clone(), fp);
                let finding = Finding::unscannable(path.clone(), &message);
                shared.push(kind, path, scope.clone(), owner, finding);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ransomware_verdacht_nur_fuer_das_profil() {
        let shared = WatchShared::new();
        let profile = PathBuf::from("/u/a");
        for i in 0..crate::ransom::RENAMED_LIMIT {
            shared.observe_change(
                crate::ransom::FileChange::Renamed,
                &PathBuf::from(format!("/u/a/Dokumente/{i}.docx.locked")),
                Some(profile.clone()),
                None,
            );
        }
        let own = shared.events_after(
            0,
            Viewer::Account {
                sid: "S-A",
                profile: Some(&profile),
            },
        );
        assert_eq!(own.len(), 1);
        assert_eq!(own[0].kind, WatchKind::Ransomware);
        assert!(own[0].finding.summary_de.contains("nichts verändert"));
        let other = shared.events_after(
            0,
            Viewer::Account {
                sid: "S-B",
                profile: Some(Path::new("/u/b")),
            },
        );
        assert!(other.is_empty());
    }

    #[test]
    fn geteilter_schutzordner_meldet_nur_den_ordner_und_jedem_konto() {
        let shared = WatchShared::new();
        let root = PathBuf::from("/daten/geteilt");
        let (a, b) = (PathBuf::from("/u/a"), PathBuf::from("/u/b"));
        shared.protect(root.clone(), Some(a.clone()));
        shared.protect(root.clone(), Some(b.clone()));
        assert_eq!(shared.protected_scopes(&root.join("x")).len(), 2);
        for i in 0..crate::ransom::RENAMED_LIMIT {
            let path = root.join(format!("B-privat/{i}.docx.locked"));
            for (scope, shown) in shared.protected_scopes(&path) {
                shared.observe_change(
                    crate::ransom::FileChange::Renamed,
                    &path,
                    scope,
                    Some(&shown),
                );
            }
        }
        for (sid, profile) in [("S-A", &a), ("S-B", &b)] {
            let seen = shared.events_after(
                0,
                Viewer::Account {
                    sid,
                    profile: Some(profile),
                },
            );
            assert_eq!(seen.len(), 1, "{sid}");
            assert_eq!(seen[0].path, root, "nur der Schutzordner, kein Dateiname");
            assert!(!format!("{:?}", seen[0].finding).contains("B-privat"));
        }
        // A nimmt den Ordner heraus: B schützt ihn weiter.
        shared.unprotect(&root, Some(&a));
        let left = shared.protected_scopes(&root.join("x"));
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].0.as_deref(), Some(b.as_path()));
    }

    #[test]
    fn standardordner_bleibt_beim_entfernen_eigener_auswahl() {
        let shared = WatchShared::new();
        let docs = PathBuf::from("/u/a/Documents");
        let a = Some(PathBuf::from("/u/a"));
        shared.protect_default(docs.clone(), a.clone());
        shared.protect(docs.clone(), a.clone());
        shared.unprotect(&docs, a.as_deref());
        assert!(shared.is_protected(&docs.join("brief.docx")));
    }

    #[test]
    fn ereignisse_nach_konto_profil_und_nummer() {
        let shared = WatchShared::new();
        let f = Finding::unscannable(PathBuf::from("/a"), "x");
        shared.push(
            WatchKind::File,
            PathBuf::from("/u/a/x"),
            Some(PathBuf::from("/u/a")),
            None,
            f.clone(),
        );
        shared.push(
            WatchKind::File,
            PathBuf::from("/u/b/y"),
            Some(PathBuf::from("/u/b")),
            None,
            f.clone(),
        );
        shared.push(
            WatchKind::File,
            PathBuf::from("/usb/z"),
            None,
            None,
            f.clone(),
        );
        shared.push(
            WatchKind::Process,
            PathBuf::from("/opt/tool"),
            None,
            Some("S-B".into()),
            f,
        );
        assert_eq!(shared.events_after(0, Viewer::All).len(), 4);
        let a = Viewer::Account {
            sid: "S-A",
            profile: Some(Path::new("/u/a")),
        };
        let seqs: Vec<u64> = shared.events_after(0, a).iter().map(|e| e.seq).collect();
        assert_eq!(
            seqs,
            [1, 3],
            "eigenes Profil + gemeinsame Orte, kein fremder Prozess"
        );
        let b = Viewer::Account {
            sid: "S-B",
            profile: None,
        };
        let seqs: Vec<u64> = shared.events_after(0, b).iter().map(|e| e.seq).collect();
        assert_eq!(seqs, [3, 4]);
        assert_eq!(shared.events_after(2, Viewer::All).len(), 2);
    }

    #[test]
    fn gaming_je_profil() {
        let shared = WatchShared::new();
        let a = Path::new("/u/a");
        shared.set_gaming(Some(a), true);
        assert!(shared.gaming_for(Some(a)));
        assert!(
            !shared.gaming_for(Some(Path::new("/u/b"))),
            "andere Konten nicht betroffen"
        );
        assert!(!shared.gaming_for(None), "gemeinsame Orte weiter geprüft");
        assert!(
            shared
                .gaming_left(Some(a))
                .is_some_and(|s| s <= GAMING_MAX.as_secs())
        );
        let viewer = Viewer::Account {
            sid: "S-A",
            profile: Some(a),
        };
        assert!(shared.status(viewer).gaming);
        shared.set_gaming(Some(a), false);
        assert!(!shared.gaming_for(Some(a)));
        shared.set_gaming(None, true);
        assert!(shared.gaming_for(Some(a)) && shared.gaming_for(None));
    }

    #[test]
    fn ereignisse_je_bereich_begrenzt() {
        let shared = WatchShared::new();
        let f = Finding::unscannable(PathBuf::from("/a"), "x");
        shared.push(
            WatchKind::File,
            PathBuf::from("/u/a/x"),
            Some(PathBuf::from("/u/a")),
            None,
            f.clone(),
        );
        for i in 0..(MAX_EVENTS_PER_SCOPE + 50) {
            shared.push(
                WatchKind::File,
                PathBuf::from(format!("/usb/{i}")),
                None,
                None,
                f.clone(),
            );
        }
        let all = shared.events_after(0, Viewer::All);
        assert_eq!(all.len(), MAX_EVENTS_PER_SCOPE + 1);
        assert_eq!(all[0].seq, 1, "Meldung eines anderen Bereichs bleibt");
    }

    #[test]
    fn waechter_meldet_eicar_im_ordner() {
        let dir = tempfile::tempdir().unwrap();
        let shared = WatchShared::new();
        let stop = Arc::new(AtomicBool::new(false));
        let config = WatchConfig {
            folders: vec![(dir.path().to_path_buf(), None)],
            profile_roots: Vec::new(),
            exclude: Vec::new(),
            protected: Vec::new(),
            custom_protected: Vec::new(),
            removable: false,
            processes: false,
            settle: Duration::from_millis(100),
            identity: ScanIdentity::OwnProcess,
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

    #[test]
    fn geschuetzter_ordner_erkennt_verschluesselung_ohne_dateien_zu_pruefen() {
        let dir = tempfile::tempdir().unwrap();
        let docs = dir.path().join("Dokumente");
        for i in 0..12 {
            aegis_core::testing::write_fixture(
                dir.path(),
                &format!("Dokumente/brief{i}.txt"),
                "Liebe Grüße aus dem Urlaub. ".repeat(400).as_bytes(),
            )
            .unwrap();
        }
        let shared = WatchShared::new();
        let stop = Arc::new(AtomicBool::new(false));
        let config = WatchConfig {
            folders: Vec::new(),
            profile_roots: Vec::new(),
            exclude: Vec::new(),
            protected: vec![(docs.clone(), Some(dir.path().to_path_buf()))],
            custom_protected: Vec::new(),
            removable: false,
            processes: false,
            settle: Duration::from_millis(100),
            identity: ScanIdentity::OwnProcess,
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
        // Harmloser „Verschlüsselungs-Simulator“: überschreibt die eigenen Testdateien mit
        // Pseudo-Zufallsdaten (kein echter Schadcode).
        let mut x: u32 = 2_654_435_761;
        for i in 0..12 {
            let noise: Vec<u8> = (0..8192)
                .map(|_| {
                    x ^= x << 13;
                    x ^= x >> 17;
                    x ^= x << 5;
                    x.to_le_bytes()[2]
                })
                .collect();
            aegis_core::testing::write_fixture(
                dir.path(),
                &format!("Dokumente/brief{i}.txt"),
                &noise,
            )
            .unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut events = Vec::new();
        while Instant::now() < deadline && events.is_empty() {
            std::thread::sleep(Duration::from_millis(100));
            events = shared.events_after(0, Viewer::All);
        }
        stop.store(true, Ordering::SeqCst);
        assert_eq!(events.len(), 1, "{events:?}");
        assert_eq!(events[0].kind, WatchKind::Ransomware);
        assert_eq!(events[0].finding.risk, RiskLevel::Dangerous);
        assert!(events[0].finding.summary_de.contains("verschlüsselt"));
    }
}
