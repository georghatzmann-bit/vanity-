//! Spielzeit-Erkennung: Ein Hintergrund-Thread prüft alle 3 Sekunden die laufenden Prozesse,
//! ordnet sie den überwachten Spielen zu und schreibt Sitzungen absturzsicher in die Datenbank.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Emitter};

use crate::error::{CmdResult, LockExt};
use crate::models::{
    GameStartedEvent, GameStoppedEvent, LaunchConfig, LaunchType, RunningGame, Session, TrackInfo,
};
use crate::state::Core;
use crate::util::now_ms;

/// Normales Prüfintervall.
const POLL_INTERVAL: Duration = Duration::from_secs(3);
/// Schnelleres Intervall direkt nach einem Start aus Pulsar heraus.
const FAST_POLL_INTERVAL: Duration = Duration::from_secs(1);
/// So lange nach `launch_game` wird schneller geprüft.
const FAST_POLL_WINDOW: Duration = Duration::from_secs(90);
/// Offene Sitzungen werden in diesem Abstand gespeichert (Schutz bei Absturz/Stromausfall).
const FLUSH_INTERVAL_MS: i64 = 60_000;
/// Kürzere Sitzungen werden verworfen.
pub const MIN_SESSION_SECONDS: i64 = 10;
/// Ein Spiel gilt erst als beendet, wenn es so oft hintereinander nicht gefunden wurde
/// (überbrückt z. B. den Wechsel vom Launcher-Prozess zum eigentlichen Spiel).
const MISSES_TO_STOP: u32 = 2;

// =============================================================================================
// Zuordnung Prozess ⇄ Spiel (reine Funktionen, getestet)
// =============================================================================================

/// Pfad vereinheitlichen: Kleinschreibung, `/` als Trenner, ohne `\\?\`-Präfix und ohne
/// abschließenden Trenner.
pub fn normalize_path(p: &str) -> String {
    let mut s = p.trim().trim_matches('"').replace('\\', "/").to_lowercase();
    if let Some(rest) = s.strip_prefix("//?/unc/") {
        s = format!("//{rest}");
    } else if let Some(rest) = s.strip_prefix("//?/") {
        s = rest.to_string();
    } else if let Some(rest) = s.strip_prefix("/??/") {
        s = rest.to_string();
    } else if let Some(rest) = s.strip_prefix("//./") {
        s = rest.to_string();
    }
    // Doppelte Trenner zusammenfassen (außer am Anfang eines Netzwerkpfads)
    let (lead, body) = if let Some(rest) = s.strip_prefix("//") {
        ("//", rest.to_string())
    } else {
        ("", s.clone())
    };
    let mut out = String::with_capacity(s.len());
    out.push_str(lead);
    let mut prev_slash = false;
    for c in body.chars() {
        if c == '/' {
            if prev_slash {
                continue;
            }
            prev_slash = true;
        } else {
            prev_slash = false;
        }
        out.push(c);
    }
    while out.len() > 1 && out.ends_with('/') {
        out.pop();
    }
    out
}

/// Verzeichnisse, die nie als „Installationsordner eines Spiels“ gelten dürfen.
#[derive(Debug, Clone, Default)]
pub struct DirContext {
    /// Benutzerordner, normalisiert (z. B. `c:/users/max`)
    pub home: Option<String>,
    /// Windows-Ordner, normalisiert (z. B. `c:/windows`)
    pub windir: Option<String>,
}

impl DirContext {
    pub fn current() -> Self {
        let home = crate::util::home_dir().map(|h| normalize_path(&h.to_string_lossy()));
        let windir = std::env::var("WINDIR")
            .or_else(|_| std::env::var("SystemRoot"))
            .ok()
            .map(|w| normalize_path(&w))
            .or_else(|| cfg!(windows).then(|| "c:/windows".to_string()));
        Self { home, windir }
    }
}

fn path_components(norm: &str) -> Vec<&str> {
    let mut parts: Vec<&str> = norm.split('/').filter(|p| !p.is_empty()).collect();
    // Laufwerk (`c:`) zählt nicht als Ebene
    if parts.first().map(|p| p.len() == 2 && p.ends_with(':')).unwrap_or(false) {
        parts.remove(0);
    }
    parts
}

fn is_same_or_under(path: &str, dir: &str) -> bool {
    path == dir || (path.len() > dir.len() && path.starts_with(dir) && path.as_bytes()[dir.len()] == b'/')
}

/// Ist der (normalisierte) Ordner spezifisch genug, um alle Prozesse darin einem Spiel zuzuordnen?
/// Mindestens zwei Ebenen tief und kein bekannter Sammel- oder Systemordner.
pub fn is_specific_dir(dir: &str, ctx: &DirContext) -> bool {
    let parts = path_components(dir);
    if parts.len() < 2 {
        return false;
    }
    if let Some(win) = &ctx.windir {
        if is_same_or_under(dir, win) {
            return false;
        }
    }
    if let Some(home) = &ctx.home {
        if dir == home {
            return false;
        }
        const HOME_CHILDREN: [&str; 12] = [
            "appdata",
            "appdata/local",
            "appdata/roaming",
            "appdata/locallow",
            "appdata/local/programs",
            "desktop",
            "documents",
            "downloads",
            "videos",
            "pictures",
            "music",
            "games",
        ];
        if let Some(rest) = dir.strip_prefix(home).and_then(|r| r.strip_prefix('/')) {
            if HOME_CHILDREN.contains(&rest) || rest.starts_with(".local/share") && rest.len() <= 12 {
                return false;
            }
        }
    }
    let joined = parts.join("/");
    const ROOTS: [&str; 10] = [
        "program files",
        "program files (x86)",
        "programdata",
        "users",
        "windows",
        "program files/common files",
        "program files (x86)/common files",
        "program files/windowsapps",
        "usr/bin",
        "usr/local/bin",
    ];
    if ROOTS.contains(&joined.as_str()) {
        return false;
    }
    const LIBRARY_ENDINGS: [&str; 10] = [
        "steamapps",
        "steamapps/common",
        "epic games",
        "gog games",
        "gog galaxy/games",
        "xboxgames",
        "games",
        "windowsapps",
        "steamlibrary",
        "common files",
    ];
    for end in LIBRARY_ENDINGS {
        if joined == end || joined.ends_with(&format!("/{end}")) {
            return false;
        }
    }
    true
}

/// Erkennungsregeln für ein Spiel.
#[derive(Debug, Clone, PartialEq)]
pub struct Matcher {
    pub game_id: String,
    exe: Option<String>,
    exe_name: Option<String>,
    dir: Option<String>,
    names: Vec<String>,
}

impl Matcher {
    pub fn from_info(info: &TrackInfo, ctx: &DirContext) -> Self {
        let exe = info
            .exe_path
            .as_deref()
            .map(normalize_path)
            .filter(|e| !e.is_empty());
        let exe_name = exe
            .as_deref()
            .and_then(|e| e.rsplit('/').next())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty());
        let dir = info
            .install_dir
            .as_deref()
            .map(normalize_path)
            .filter(|d| !d.is_empty() && is_specific_dir(d, ctx));
        let names = info
            .process_names
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|n| n.trim().trim_matches('"').to_lowercase())
            .map(|n| n.rsplit(['/', '\\']).next().unwrap_or("").to_string())
            .filter(|n| !n.is_empty())
            .collect();
        Self {
            game_id: info.game_id.clone(),
            exe,
            exe_name,
            dir,
            names,
        }
    }

    /// Gibt es überhaupt etwas, woran das Spiel erkannt werden kann?
    pub fn has_criteria(&self) -> bool {
        self.exe.is_some() || self.dir.is_some() || !self.names.is_empty()
    }

    /// Gehört der Prozess zu diesem Spiel?
    /// `exe` = normalisierter Programmpfad (falls lesbar), `name` = Prozessname in Kleinbuchstaben.
    pub fn matches(&self, exe: Option<&str>, name: &str) -> bool {
        if let Some(exe) = exe {
            if self.exe.as_deref() == Some(exe) {
                return true;
            }
            if let Some(dir) = &self.dir {
                if exe.len() > dir.len() && is_same_or_under(exe, dir) {
                    return true;
                }
            }
        }
        if !name.is_empty() {
            let stem = name.strip_suffix(".exe").unwrap_or(name);
            if self.names.iter().any(|n| n == name || n == stem) {
                return true;
            }
            // Programmpfad nicht lesbar (z. B. Spiel läuft mit Adminrechten): Dateiname vergleichen
            if exe.is_none() && self.exe_name.as_deref() == Some(name) {
                return true;
            }
        }
        false
    }
}

/// Ein Prozess-Schnappschuss.
#[derive(Debug, Clone)]
pub struct ProcInfo {
    pub pid: u32,
    pub exe: Option<String>,
    pub name: String,
}

/// Ordnet alle Prozesse den Spielen zu: Spiel-ID → PIDs.
pub fn compute_matches(matchers: &[Matcher], procs: &[ProcInfo]) -> HashMap<String, Vec<u32>> {
    let mut out: HashMap<String, Vec<u32>> = HashMap::new();
    for m in matchers {
        for p in procs {
            if m.matches(p.exe.as_deref(), &p.name) {
                out.entry(m.game_id.clone()).or_default().push(p.pid);
            }
        }
    }
    for pids in out.values_mut() {
        pids.sort_unstable();
        pids.dedup();
    }
    out
}

fn snapshot(sys: &mut System, own_pid: u32) -> Vec<ProcInfo> {
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
    );
    sys.processes()
        .iter()
        .filter(|(pid, _)| pid.as_u32() != own_pid)
        .map(|(pid, p)| ProcInfo {
            pid: pid.as_u32(),
            exe: p
                .exe()
                .map(|e| normalize_path(&e.to_string_lossy()))
                .filter(|e| !e.is_empty()),
            name: p.name().to_string_lossy().to_lowercase(),
        })
        .collect()
}

// =============================================================================================
// Laufzeit-Zustand
// =============================================================================================

#[derive(Debug, Clone)]
struct RunningEntry {
    started_at: i64,
    last_seen: i64,
    /// Zeitpunkt der ersten Prüfung, bei der das Spiel fehlte
    first_miss_at: i64,
    last_flush: i64,
    session_id: Option<i64>,
    pids: Vec<u32>,
    misses: u32,
}

impl RunningEntry {
    /// Geschätztes Ende: läuft es noch → jetzt; sonst Mitte zwischen „zuletzt gesehen“ und
    /// „erstmals vermisst“ (Fehler höchstens ein halbes Prüfintervall).
    fn estimated_end(&self, now: i64) -> i64 {
        if self.misses == 0 {
            now
        } else {
            self.last_seen + (self.first_miss_at - self.last_seen).max(0) / 2
        }
    }
}

#[derive(Default)]
struct TrackerState {
    matchers: Vec<Matcher>,
    /// Spiele, die aus Pulsar gestartet wurden, aber nicht in der überwachten Liste stehen
    adhoc: HashMap<String, Matcher>,
    running: HashMap<String, RunningEntry>,
    launched: HashMap<String, Instant>,
    poll_now: bool,
    paused: bool,
    shutdown: bool,
}

impl TrackerState {
    fn effective_matchers(&self) -> Vec<Matcher> {
        let mut list = self.matchers.clone();
        for (id, m) in &self.adhoc {
            if !self.matchers.iter().any(|x| &x.game_id == id) {
                list.push(m.clone());
            }
        }
        list
    }

    /// Schneller prüfen: kurz nach einem Start oder wenn ein laufendes Spiel gerade fehlt
    /// (damit das Ende schnell erkannt wird).
    fn fast_poll(&self) -> bool {
        self.running.values().any(|r| r.misses > 0)
            || self
                .launched
                .iter()
                .any(|(id, t)| t.elapsed() < FAST_POLL_WINDOW && !self.running.contains_key(id))
    }
}

/// Aktuelle Spielsitzung für den Netzwerk-Verlauf: laufen mehrere Spiele, die zuletzt gestartete
/// mit `session_id`; keine → `None`. Ergebnis `(session_id, started_at)`.
fn current_session_of(running: &HashMap<String, RunningEntry>) -> Option<(i64, i64)> {
    running
        .values()
        .filter_map(|r| r.session_id.map(|id| (id, r.started_at)))
        .max_by_key(|(id, started_at)| (*started_at, *id))
}

/// Die aktuelle Sitzung an den Recorder weitergeben (`NetState.current_session`). Nur **nach**
/// Freigabe der Tracker-Sperre aufrufen.
fn push_session(core: &Core, session: Option<(i64, i64)>) {
    *core.net.current_session.lock_safe() = session;
}

enum TrackerEvent {
    Started(GameStartedEvent),
    Stopped(GameStoppedEvent),
}

/// Spielzeit-Erkennung (ein Exemplar pro App).
#[derive(Default)]
pub struct Tracker {
    state: Mutex<TrackerState>,
    cv: Condvar,
    app: OnceLock<AppHandle>,
}

impl Tracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Startet den Hintergrund-Thread.
    pub fn start(core: Arc<Core>, app: AppHandle) {
        let _ = core.tracker.app.set(app);
        let spawn = std::thread::Builder::new()
            .name("pulsar-tracker".into())
            .spawn(move || thread_main(core));
        if let Err(e) = spawn {
            eprintln!("Spielzeit-Erkennung konnte nicht gestartet werden: {e}");
        }
    }

    fn wake(&self, st: &mut TrackerState) {
        st.poll_now = true;
        self.cv.notify_all();
    }

    fn emit(&self, events: Vec<TrackerEvent>) {
        let Some(app) = self.app.get() else { return };
        for ev in events {
            let _ = match ev {
                TrackerEvent::Started(e) => app.emit("game://started", e),
                TrackerEvent::Stopped(e) => app.emit("game://stopped", e),
            };
        }
    }

    /// Neue Liste der überwachten Spiele. Laufende Spiele, die nicht mehr enthalten sind, werden beendet.
    pub fn set_games(&self, core: &Core, games: Vec<TrackInfo>) {
        let ctx = DirContext::current();
        let matchers: Vec<Matcher> = games
            .iter()
            .filter(|g| !g.game_id.trim().is_empty())
            .map(|g| Matcher::from_info(g, &ctx))
            .filter(|m| m.has_criteria())
            .collect();
        let mut events = Vec::new();
        let session = {
            let mut st = self.state.lock_safe();
            st.matchers = matchers;
            let keep: HashSet<String> = st
                .matchers
                .iter()
                .map(|m| m.game_id.clone())
                .chain(st.adhoc.keys().cloned())
                .collect();
            let removed: Vec<String> = st
                .running
                .keys()
                .filter(|k| !keep.contains(*k))
                .cloned()
                .collect();
            let now = now_ms();
            for id in removed {
                if let Some(entry) = st.running.remove(&id) {
                    let end = entry.estimated_end(now);
                    events.push(TrackerEvent::Stopped(finalize(core, &id, &entry, end)));
                }
            }
            self.wake(&mut st);
            current_session_of(&st.running)
        };
        push_session(core, session);
        self.emit(events);
    }

    /// Nach einem Start aus Pulsar: schneller prüfen, damit die Sitzung sofort beginnt.
    pub fn mark_launched(&self, game_id: &str, launch: &LaunchConfig) {
        let mut st = self.state.lock_safe();
        st.launched.insert(game_id.to_string(), Instant::now());
        let known = st.matchers.iter().any(|m| m.game_id == game_id);
        if !known && launch.kind == LaunchType::Exe && !launch.target.trim().is_empty() {
            let info = TrackInfo {
                game_id: game_id.to_string(),
                exe_path: Some(launch.target.clone()),
                ..Default::default()
            };
            st.adhoc
                .insert(game_id.to_string(), Matcher::from_info(&info, &DirContext::current()));
        }
        self.wake(&mut st);
    }

    /// Aktuell laufende Spiele.
    pub fn running(&self) -> Vec<RunningGame> {
        let st = self.state.lock_safe();
        let mut list: Vec<RunningGame> = st
            .running
            .iter()
            .map(|(id, r)| RunningGame {
                game_id: id.clone(),
                started_at: r.started_at,
                pids: r.pids.clone(),
                session_id: r.session_id,
            })
            .collect();
        list.sort_by_key(|r| r.started_at);
        list
    }

    /// Beendet alle Prozesse eines Spiels. Liefert die Anzahl beendeter Prozesse.
    /// Sind die Prozesse weg, wird die Sitzung sofort abgeschlossen (`game://stopped`).
    pub fn stop_game(&self, core: &Core, game_id: &str) -> CmdResult<u32> {
        let (matcher, cached) = {
            let st = self.state.lock_safe();
            let m = st
                .effective_matchers()
                .into_iter()
                .find(|m| m.game_id == game_id);
            let cached = st.running.get(game_id).map(|r| r.pids.clone()).unwrap_or_default();
            (m, cached)
        };
        let own = std::process::id();
        let mut sys = System::new();
        let procs = snapshot(&mut sys, own);
        let mut pids: HashSet<u32> = HashSet::new();
        if let Some(m) = &matcher {
            for p in &procs {
                if m.matches(p.exe.as_deref(), &p.name) {
                    pids.insert(p.pid);
                }
            }
        }
        for pid in cached {
            if sys.process(Pid::from_u32(pid)).is_some() {
                pids.insert(pid);
            }
        }
        pids.remove(&own);
        let mut killed = 0u32;
        for pid in &pids {
            if let Some(p) = sys.process(Pid::from_u32(*pid)) {
                if p.kill() {
                    killed += 1;
                }
            }
        }
        if killed > 0 {
            // Kurz warten, bis die Prozesse wirklich beendet sind, dann sofort abschließen
            let list: Vec<Pid> = pids.iter().map(|p| Pid::from_u32(*p)).collect();
            let deadline = Instant::now() + Duration::from_secs(2);
            let gone = loop {
                sys.refresh_processes(ProcessesToUpdate::Some(&list), true);
                if !list.iter().any(|p| sys.process(*p).is_some()) {
                    break true;
                }
                if Instant::now() >= deadline {
                    break false;
                }
                std::thread::sleep(Duration::from_millis(150));
            };
            if gone {
                let mut events = Vec::new();
                let session = {
                    let mut st = self.state.lock_safe();
                    if let Some(entry) = st.running.remove(game_id) {
                        st.adhoc.remove(game_id);
                        st.launched.remove(game_id);
                        events.push(TrackerEvent::Stopped(finalize(core, game_id, &entry, now_ms())));
                    }
                    current_session_of(&st.running)
                };
                push_session(core, session);
                self.emit(events);
            }
        }
        {
            let mut st = self.state.lock_safe();
            self.wake(&mut st);
        }
        if killed == 0 && !pids.is_empty() {
            return Err(
                "Das Spiel konnte nicht beendet werden. Eventuell läuft es mit Administratorrechten."
                    .into(),
            );
        }
        Ok(killed)
    }

    /// Alle offenen Sitzungen abschließen. `clear_games` leert zusätzlich die überwachte Liste
    /// (Profilwechsel), `pause` hält die Erkennung bis `resume()` an. Danach gibt es keine laufende
    /// Sitzung mehr (an den Recorder weitergegeben, Rückgabe `None`).
    pub fn finalize_all(&self, core: &Core, clear_games: bool, pause: bool) -> Option<(i64, i64)> {
        let mut events = Vec::new();
        let session = {
            let mut st = self.state.lock_safe();
            let now = now_ms();
            let entries: Vec<(String, RunningEntry)> = st.running.drain().collect();
            for (id, entry) in entries {
                let end = entry.estimated_end(now);
                events.push(TrackerEvent::Stopped(finalize(core, &id, &entry, end)));
            }
            if clear_games {
                st.matchers.clear();
                st.adhoc.clear();
                st.launched.clear();
            }
            if pause {
                st.paused = true;
            }
            current_session_of(&st.running)
        };
        push_session(core, session);
        self.emit(events);
        session
    }

    /// Erkennung nach `finalize_all(…, pause = true)` fortsetzen.
    pub fn resume(&self) {
        let mut st = self.state.lock_safe();
        st.paused = false;
        self.wake(&mut st);
    }

    /// Beim Beenden der App: Sitzungen speichern und Thread stoppen.
    pub fn shutdown(&self, core: &Core) {
        let _ = self.finalize_all(core, true, true);
        let mut st = self.state.lock_safe();
        st.shutdown = true;
        self.cv.notify_all();
    }

    /// Ergebnis einer Prüfung anwenden (Start, Weiterlaufen, Ende). Liefert die Ereignisse und die
    /// aktuelle Sitzung, die der Aufrufer nach Freigabe der Sperre weitergibt. Außen `None` = die
    /// Erkennung ist pausiert/beendet, nichts weitergeben (innen `None` = keine Sitzung).
    fn apply(&self, core: &Core, found: HashMap<String, Vec<u32>>, now: i64) -> (Vec<TrackerEvent>, Option<Option<(i64, i64)>>) {
        let mut events = Vec::new();
        let mut st = self.state.lock_safe();
        if st.paused || st.shutdown {
            return (events, None);
        }
        // Liste kann sich seit dem Schnappschuss geändert haben (set_tracked_games)
        let valid: HashSet<String> = st
            .matchers
            .iter()
            .map(|m| m.game_id.clone())
            .chain(st.adhoc.keys().cloned())
            .collect();
        let found: HashMap<String, Vec<u32>> =
            found.into_iter().filter(|(id, _)| valid.contains(id)).collect();
        for (id, pids) in &found {
            if let Some(r) = st.running.get_mut(id) {
                r.pids = pids.clone();
                r.last_seen = now;
                r.misses = 0;
                let seconds = (now - r.started_at) / 1000;
                match r.session_id {
                    None => {
                        r.session_id = core
                            .db
                            .with(|db| db.session_insert(id, r.started_at, now, seconds))
                            .ok()
                            .map(|s| s.id);
                        r.last_flush = now;
                    }
                    Some(sid) if now - r.last_flush >= FLUSH_INTERVAL_MS => {
                        match core.db.with(|db| db.session_update(sid, now, seconds)) {
                            Ok(true) => {}
                            // Zeile fehlt (z. B. nach Wiederherstellung) → neu anlegen
                            Ok(false) => {
                                r.session_id = core
                                    .db
                                    .with(|db| db.session_insert(id, r.started_at, now, seconds))
                                    .ok()
                                    .map(|s| s.id);
                            }
                            Err(e) => eprintln!("Sitzung konnte nicht gespeichert werden: {e}"),
                        }
                        r.last_flush = now;
                    }
                    Some(_) => {}
                }
            } else {
                let session_id = core
                    .db
                    .with(|db| db.session_insert(id, now, now, 0))
                    .map_err(|e| eprintln!("Sitzung konnte nicht angelegt werden: {e}"))
                    .ok()
                    .map(|s| s.id);
                st.running.insert(
                    id.clone(),
                    RunningEntry {
                        started_at: now,
                        last_seen: now,
                        first_miss_at: now,
                        last_flush: now,
                        session_id,
                        pids: pids.clone(),
                        misses: 0,
                    },
                );
                st.launched.remove(id);
                events.push(TrackerEvent::Started(GameStartedEvent {
                    game_id: id.clone(),
                    started_at: now,
                }));
            }
        }
        let missing: Vec<String> = st
            .running
            .keys()
            .filter(|k| !found.contains_key(*k))
            .cloned()
            .collect();
        for id in missing {
            let stop = match st.running.get_mut(&id) {
                Some(r) => {
                    if r.misses == 0 {
                        r.first_miss_at = now;
                    }
                    r.misses += 1;
                    r.pids.clear();
                    r.misses >= MISSES_TO_STOP
                }
                None => false,
            };
            if stop {
                if let Some(entry) = st.running.remove(&id) {
                    st.adhoc.remove(&id);
                    events.push(TrackerEvent::Stopped(finalize(core, &id, &entry, entry.estimated_end(now))));
                }
            }
        }
        st.launched.retain(|_, t| t.elapsed() < FAST_POLL_WINDOW * 2);
        let session = current_session_of(&st.running);
        (events, Some(session))
    }
}

/// Sitzung abschließen: speichern (oder verwerfen, wenn zu kurz) und das Ereignis bauen.
fn finalize(core: &Core, game_id: &str, entry: &RunningEntry, end: i64) -> GameStoppedEvent {
    let end = end.max(entry.started_at);
    let seconds = (end - entry.started_at) / 1000;
    let mut session = Session {
        id: entry.session_id.unwrap_or(0),
        game_id: game_id.to_string(),
        start: entry.started_at,
        end,
        seconds,
    };
    let result = core.db.with(|db| {
        match entry.session_id {
            Some(id) if seconds < MIN_SESSION_SECONDS => db.session_delete(id)?,
            Some(id) => {
                if !db.session_update(id, end, seconds)? {
                    session.id = db.session_insert(game_id, entry.started_at, end, seconds)?.id;
                }
            }
            None if seconds >= MIN_SESSION_SECONDS => {
                session.id = db.session_insert(game_id, entry.started_at, end, seconds)?.id;
            }
            None => {}
        }
        Ok(())
    });
    if let Err(e) = result {
        eprintln!("Sitzung konnte nicht abgeschlossen werden: {e}");
    }
    // Kurz-Sitzung verworfen → ihre gepufferten Messwerte ebenfalls (Sperre: tracker → recorder)
    if let (Some(id), true) = (entry.session_id, seconds < MIN_SESSION_SECONDS) {
        core.net.recorder.lock_safe().discard_session(id);
    }
    GameStoppedEvent {
        game_id: game_id.to_string(),
        session,
    }
}

fn thread_main(core: Arc<Core>) {
    let mut sys = System::new();
    let own_pid = std::process::id();
    loop {
        let matchers = {
            let st = core.tracker.state.lock_safe();
            if st.shutdown {
                break;
            }
            let timeout = if st.fast_poll() { FAST_POLL_INTERVAL } else { POLL_INTERVAL };
            let (mut st, _) = core
                .tracker
                .cv
                .wait_timeout_while(st, timeout, |s| !s.poll_now && !s.shutdown)
                .unwrap_or_else(|e| e.into_inner());
            if st.shutdown {
                break;
            }
            st.poll_now = false;
            if st.paused || (st.matchers.is_empty() && st.adhoc.is_empty() && st.running.is_empty()) {
                continue;
            }
            st.effective_matchers()
        };
        let procs = snapshot(&mut sys, own_pid);
        let found = compute_matches(&matchers, &procs);
        let (events, session) = core.tracker.apply(&core, found, now_ms());
        // Nach Freigabe der Tracker-Sperre (gleich neben `emit`)
        if let Some(session) = session {
            push_session(&core, session);
        }
        core.tracker.emit(events);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> DirContext {
        DirContext {
            home: Some("c:/users/max".into()),
            windir: Some("c:/windows".into()),
        }
    }

    fn info(exe: Option<&str>, dir: Option<&str>, names: &[&str]) -> TrackInfo {
        TrackInfo {
            game_id: "g".into(),
            name: "Game".into(),
            install_dir: dir.map(|s| s.into()),
            exe_path: exe.map(|s| s.into()),
            process_names: if names.is_empty() {
                None
            } else {
                Some(names.iter().map(|s| s.to_string()).collect())
            },
        }
    }

    #[test]
    fn normalize() {
        assert_eq!(normalize_path(r"C:\Games\Elden Ring\Game\eldenring.exe"), "c:/games/elden ring/game/eldenring.exe");
        assert_eq!(normalize_path(r"\\?\C:\Games\X\"), "c:/games/x");
        assert_eq!(normalize_path(r"\\?\UNC\server\share\x.exe"), "//server/share/x.exe");
        assert_eq!(normalize_path("D:/A//B/"), "d:/a/b");
        assert_eq!(normalize_path(r#""C:\X\y.exe""#), "c:/x/y.exe");
    }

    #[test]
    fn specific_dirs() {
        let c = ctx();
        assert!(is_specific_dir("c:/games/witcher 3", &c));
        assert!(is_specific_dir("d:/steamlibrary/steamapps/common/elden ring", &c));
        assert!(!is_specific_dir("c:", &c), "Laufwerk");
        assert!(!is_specific_dir("c:/games", &c), "nur eine Ebene");
        assert!(!is_specific_dir("c:/program files (x86)", &c));
        assert!(!is_specific_dir("c:/program files/common files", &c));
        assert!(!is_specific_dir("c:/windows/system32", &c));
        assert!(!is_specific_dir("c:/users/max", &c), "Benutzerordner");
        assert!(!is_specific_dir("c:/users/max/appdata/local", &c));
        assert!(!is_specific_dir("d:/steamlibrary/steamapps/common", &c));
        assert!(!is_specific_dir("c:/program files/epic games", &c));
        assert!(is_specific_dir("c:/program files/epic games/fortnite", &c));
        assert!(is_specific_dir("c:/users/max/appdata/local/programs/someapp", &c));
    }

    #[test]
    fn match_by_exe_path_case_insensitive() {
        let m = Matcher::from_info(&info(Some(r"C:\Games\Hades\Hades.exe"), None, &[]), &ctx());
        assert!(m.matches(Some(&normalize_path(r"c:\games\hades\HADES.EXE")), "hades.exe"));
        assert!(!m.matches(Some("c:/games/other/hades.exe"), "hades.exe"));
    }

    #[test]
    fn match_by_install_dir() {
        let m = Matcher::from_info(
            &info(None, Some(r"D:\SteamLibrary\steamapps\common\ELDEN RING"), &[]),
            &ctx(),
        );
        assert!(m.has_criteria());
        assert!(m.matches(Some("d:/steamlibrary/steamapps/common/elden ring/game/eldenring.exe"), "eldenring.exe"));
        assert!(!m.matches(Some("d:/steamlibrary/steamapps/common/elden ring 2/x.exe"), "x.exe"), "Präfix ohne Trenner");
        assert!(!m.matches(Some("d:/steamlibrary/steamapps/common/other/x.exe"), "x.exe"));
    }

    #[test]
    fn unspecific_install_dir_is_ignored() {
        let m = Matcher::from_info(&info(None, Some(r"C:\Program Files"), &[]), &ctx());
        assert!(!m.has_criteria());
        assert!(!m.matches(Some("c:/program files/anything/a.exe"), "a.exe"));
        let m2 = Matcher::from_info(&info(None, Some(r"C:\Windows\System32"), &[]), &ctx());
        assert!(!m2.matches(Some("c:/windows/system32/notepad.exe"), "notepad.exe"));
    }

    #[test]
    fn match_by_process_name() {
        let m = Matcher::from_info(&info(None, None, &["EldenRing.exe", "start_protected_game"]), &ctx());
        assert!(m.matches(Some("x:/whatever/eldenring.exe"), "eldenring.exe"));
        assert!(m.matches(None, "start_protected_game.exe"), "ohne .exe angegeben");
        assert!(!m.matches(None, "explorer.exe"));
    }

    #[test]
    fn exe_name_fallback_when_path_unreadable() {
        let m = Matcher::from_info(&info(Some(r"C:\Games\X\x64\game.exe"), None, &[]), &ctx());
        assert!(m.matches(None, "game.exe"));
        assert!(!m.matches(Some("c:/other/game.exe"), "game.exe"), "lesbarer Pfad muss passen");
    }

    #[test]
    fn end_estimate_is_midpoint() {
        let mut e = RunningEntry {
            started_at: 0,
            last_seen: 30_000,
            first_miss_at: 30_000,
            last_flush: 0,
            session_id: None,
            pids: vec![],
            misses: 0,
        };
        assert_eq!(e.estimated_end(40_000), 40_000, "läuft noch");
        e.misses = 2;
        e.first_miss_at = 33_000;
        assert_eq!(e.estimated_end(40_000), 31_500);
    }

    fn entry(started_at: i64, session_id: Option<i64>) -> RunningEntry {
        RunningEntry { started_at, last_seen: started_at, first_miss_at: started_at, last_flush: started_at, session_id, pids: vec![], misses: 0 }
    }

    #[test]
    fn current_session_is_latest_started_with_id() {
        let mut running = HashMap::new();
        assert_eq!(current_session_of(&running), None);
        running.insert("a".to_string(), entry(1_000, Some(5)));
        assert_eq!(current_session_of(&running), Some((5, 1_000)));
        running.insert("b".to_string(), entry(2_000, Some(9)));
        assert_eq!(current_session_of(&running), Some((9, 2_000)), "zuletzt gestartet");
        running.insert("c".to_string(), entry(3_000, None));
        assert_eq!(current_session_of(&running), Some((9, 2_000)), "ohne session_id zählt nicht");
    }

    #[test]
    fn finalize_pushes_session_and_discards_short_one() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        let short = core.db.with(|db| db.session_insert("g", 1_000, 1_000, 0)).unwrap();
        *core.net.current_session.lock_safe() = Some((short.id, 1_000));
        // Vermisst → Ende ≈ Start, also kürzer als 10 s
        core.tracker.state.lock_safe().running.insert("g".into(), RunningEntry { misses: 2, ..entry(1_000, Some(short.id)) });
        assert_eq!(core.tracker.finalize_all(&core, false, false), None);
        assert_eq!(*core.net.current_session.lock_safe(), None, "keine laufende Sitzung mehr");
        assert!(core.db.with(|db| db.session_get(short.id)).unwrap().is_none(), "Kurz-Sitzung gelöscht");
        // apply im Pausenzustand gibt nichts weiter
        core.tracker.state.lock_safe().paused = true;
        let (events, session) = core.tracker.apply(&core, HashMap::new(), 5_000);
        assert!(events.is_empty() && session.is_none());
    }

    #[test]
    fn compute_matches_groups_pids() {
        let matchers = vec![
            Matcher::from_info(&TrackInfo { game_id: "a".into(), exe_path: Some("C:/A/a.exe".into()), ..Default::default() }, &ctx()),
            Matcher::from_info(&TrackInfo { game_id: "b".into(), install_dir: Some("C:/Games/B".into()), ..Default::default() }, &ctx()),
        ];
        let procs = vec![
            ProcInfo { pid: 3, exe: Some("c:/a/a.exe".into()), name: "a.exe".into() },
            ProcInfo { pid: 5, exe: Some("c:/games/b/bin/b.exe".into()), name: "b.exe".into() },
            ProcInfo { pid: 4, exe: Some("c:/games/b/crash.exe".into()), name: "crash.exe".into() },
            ProcInfo { pid: 9, exe: Some("c:/windows/explorer.exe".into()), name: "explorer.exe".into() },
        ];
        let found = compute_matches(&matchers, &procs);
        assert_eq!(found.get("a"), Some(&vec![3]));
        assert_eq!(found.get("b"), Some(&vec![4, 5]));
        assert_eq!(found.len(), 2);
    }
}
