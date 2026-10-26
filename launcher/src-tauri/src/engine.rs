//! The control centre of the launcher: starts the backend and Fortnite, loads the DLLs,
//! reads the logs live and controls the game server through the pipe.
//!
//! Anything that touches the real game only works on Windows. On other systems the
//! checks (version, crashes) still work.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex, TryLockError};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use niobium_core::bots::{self, PlayerBotsEvent};
use niobium_core::earlylog::EarlyLines;
use niobium_core::helperprocs::HelperPids;
use niobium_core::launchargs;
use niobium_core::livingworld::LivingWorldEvent;
use niobium_core::logparse::{self, Detection};
use niobium_core::perfmode::{self, MeshChange, Prepared, Restored};
use niobium_core::profiles::{self, Config, Profile, BACKEND_PORT, GAME_SERVER_PORT};
use niobium_core::startgate::{wait_for, Busy, ClosePrompt, StartGate, StartToken, Wait};
use niobium_core::version::{self, BuildInfo, Support};

use crate::pipe::{ServerEvent, ServerLink};
use crate::proc;

/// Names of the DLLs (in the resource folder `dlls/`).
const DLL_REDIRECT: &str = "niobium_redirect.dll";
const DLL_SERVER: &str = "niobium_server.dll";
const DLL_CLIENT: &str = "niobium_client.dll";

/// Tauri event when the user wants to close the main window while something still runs
/// (payload [`CloseRequest`]). The UI asks "Close Niobium?" and calls `quit_app` on "Stop & close".
pub const EVENT_CLOSE_REQUESTED: &str = "app:close-requested";

/// Tauri event when the server says whether AI bots run this match (payload
/// `niobium_core::bots::PlayerBotsEvent`: `{ state: "active" | "unavailable", reason }`).
pub const EVENT_PLAYER_BOTS: &str = "server:playerBots";

/// Tauri event when the server says how "Bosses & NPCs" go this match (payload
/// `niobium_core::livingworld::LivingWorldEvent`: `{ state: "active" | "unavailable" | "off", reason, spawned }`).
pub const EVENT_LIVING_WORLD: &str = "server:livingWorld";

/// Category of the launcher's own log lines in the live log.
const CAT: &str = "Niobium";

/// The one log line when "Stop all" (or closing) ends a start that was still running.
const START_CANCELLED: &str = "Start cancelled.";

/// Log line and toast once Fortnite's settings file has its original lines back (Bubble Builds).
const GUS_PUT_BACK: &str = "Fortnite's graphics settings were put back.";

/// Payload of [`EVENT_CLOSE_REQUESTED`]: what still runs, in plain words
/// (e.g. `["Your game", "Game server", "Backend"]`), and the question's number. The UI answers
/// `close_prompt_shown(id)` once the dialog is on screen; without that answer Niobium closes anyway.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseRequest {
    pub running: Vec<String>,
    pub id: u64,
}

/// Why a start step stopped: "Stop all" cancelled it (quiet – `stop_all` already wrote
/// "Start cancelled."), or a real problem (shown as a toast).
#[derive(Debug)]
pub enum StartError {
    Cancelled,
    Failed(String),
}

impl From<String> for StartError {
    fn from(e: String) -> Self {
        StartError::Failed(e)
    }
}

impl From<&str> for StartError {
    fn from(e: &str) -> Self {
        StartError::Failed(e.to_string())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ServiceStatus {
    Stopped,
    Starting,
    Running,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Services {
    pub backend: ServiceStatus,
    pub server: ServiceStatus,
    pub game: ServiceStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLinePayload {
    pub source: String,
    pub level: String,
    pub category: String,
    pub message: String,
    pub detected: Option<String>,
    pub time: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Toast {
    pub kind: String,
    pub title: String,
    pub description: String,
}

/// A running Fortnite instance (server or game) with its paused helper processes.
/// Stored by `launch_instance`; dropped by "Stop all" or when the process closes by itself
/// (`watch_exit`). The helpers are closed in both cases.
struct Instance {
    pid: u32,
    helpers: HelperPids,
}

#[derive(Default)]
pub struct Running {
    backend_pid: Option<u32>,
    server: Option<Instance>,
    game: Option<Instance>,
    link: Option<Arc<ServerLink>>,
    step: i32,
    /// The start in progress and "Stop all" (see `niobium_core::startgate`). Every process start
    /// checks it under this lock, so nothing starts after "Stop all".
    gate: StartGate,
}

/// Signals from the game logs that the start sequence waits for (set in `stream_logs`).
#[derive(Default)]
pub struct Signals {
    pub server_login: AtomicBool,
    pub server_listening: AtomicBool,
    pub game_login: AtomicBool,
}

pub struct Engine {
    pub app: AppHandle,
    pub config: Mutex<Config>,
    pub running: Mutex<Running>,
    pub signals: Arc<Signals>,
    /// Bubble Builds: the GameUserSettings.ini backup of the current start (see `perfmode`). Every
    /// change to that file and its backup happens while holding this lock.
    gus: Mutex<Option<GusSession>>,
    /// A thread is waiting for every Fortnite to close to put a leftover backup back (at most one).
    gus_waiter: AtomicBool,
    /// Launcher log lines from before the UI listens; the UI fetches them once with the
    /// `pending_log_lines` command (see `niobium_core::earlylog`).
    early_log: EarlyLines<LogLinePayload>,
    /// Toasts from before the UI listens (e.g. settings put back at start); fetched once with
    /// `pending_toasts`.
    early_toasts: EarlyLines<Toast>,
    /// Fixed-port notes already written to the live log (each only once per run).
    port_notes_logged: Mutex<Vec<&'static str>>,
    /// The last "Close Niobium?" question and whether the UI showed it (see `on_window_event`).
    close_prompt: Mutex<ClosePrompt>,
}

impl Engine {
    pub fn new(app: AppHandle) -> Self {
        Engine {
            config: Mutex::new(profiles::load()),
            running: Mutex::new(Running::default()),
            signals: Arc::new(Signals::default()),
            gus: Mutex::new(None),
            gus_waiter: AtomicBool::new(false),
            early_log: EarlyLines::new(),
            early_toasts: EarlyLines::new(),
            port_notes_logged: Mutex::new(Vec::new()),
            close_prompt: Mutex::new(ClosePrompt::new()),
            app,
        }
    }

    // --- Paths ---------------------------------------------------------------

    fn resources(&self) -> Option<PathBuf> {
        self.app.path().resource_dir().ok()
    }

    fn dll_path(&self, name: &str) -> Option<PathBuf> {
        self.resources().map(|r| r.join("dlls").join(name)).filter(|p| p.is_file())
    }

    fn node_exe(&self) -> Option<PathBuf> {
        self.resources().map(|r| r.join("node").join("node.exe")).filter(|p| p.is_file())
    }

    fn backend_main(&self) -> Option<PathBuf> {
        self.resources().map(|r| r.join("backend").join("main.js")).filter(|p| p.is_file())
    }

    fn data_local(&self) -> PathBuf {
        profiles::local_dir()
    }

    // --- Reporting to the UI ------------------------------------------------

    pub fn emit_services(&self) {
        let r = self.running.lock().unwrap();
        let backend = status_of(r.backend_pid.map(proc::is_running).unwrap_or(false), r.backend_pid.is_some());
        let server = instance_status(&r.server);
        let game = instance_status(&r.game);
        let _ = self.app.emit("services", Services { backend, server, game });
    }

    /// Moves the timeline to `step` – unless "Stop all" cancelled this start (then the timeline
    /// stays idle and the start ends quietly).
    fn step(&self, token: StartToken, step: i32) -> Result<(), StartError> {
        let mut r = self.running.lock().unwrap();
        if r.gate.is_cancelled(token) {
            return Err(StartError::Cancelled);
        }
        r.step = step;
        // sent under the lock, so a "Stop all" right after it always has the last word (-1)
        let _ = self.app.emit("launch:step", step);
        Ok(())
    }

    /// True once "Stop all" ran after `token` was made (or Niobium is closing).
    fn is_cancelled(&self, token: StartToken) -> bool {
        self.running.lock().unwrap().gate.is_cancelled(token)
    }

    /// Starts processes only if the start still counts. The lock is held from the check until
    /// `spawn` has stored the new PIDs in `running`, so "Stop all" either comes first (then
    /// nothing starts) or comes after and finds – and closes – the new processes.
    fn spawn_guarded<T>(
        &self,
        token: StartToken,
        spawn: impl FnOnce(&mut Running) -> Result<T, String>,
    ) -> Result<T, StartError> {
        let mut r = self.running.lock().unwrap();
        if r.gate.is_cancelled(token) {
            return Err(StartError::Cancelled);
        }
        spawn(&mut r).map_err(StartError::Failed)
    }

    /// A toast from other parts of the launcher (e.g. the build downloader).
    pub fn toast_msg(&self, kind: &str, title: &str, description: &str) {
        self.toast(kind, title, description);
    }

    /// A launcher line in the live log (category "Niobium").
    pub fn log_line(&self, level: &str, message: &str) {
        self.log("launcher", level, CAT, message, None);
    }

    /// Adds a build to the Library (same as the `add_build` command) and saves. Returns its id.
    pub fn import_build(&self, build: BuildInfo) -> String {
        let id = build.id.clone();
        let mut cfg = self.config.lock().unwrap();
        cfg.upsert_build(build);
        if let Err(e) = profiles::save(&cfg) {
            eprintln!("[Niobium] Couldn't save the settings: {e}");
        }
        id
    }

    fn toast(&self, kind: &str, title: &str, description: &str) {
        let toast = Toast { kind: kind.into(), title: title.into(), description: description.into() };
        // Before the UI listens, the toast waits (an event now would be lost)
        if let Some(toast) = self.early_toasts.hold(toast) {
            let _ = self.app.emit("toast", toast);
        }
    }

    /// After the Vanity → Niobium copy: writes the one log line for the live log (it waits until
    /// the UI fetches it, see `pending_log_lines`) and, if the launcher config came over, marks it
    /// so the UI shows "What's new" (Vanity is now Niobium) instead of the first-run welcome.
    pub fn after_migration(&self, report: &niobium_core::migrate::MigrationReport) {
        if let Some(line) = report.summary() {
            self.log("launcher", "info", CAT, &line, None);
        }
        if report.copied_config() {
            let mut cfg = self.config.lock().unwrap();
            if niobium_core::migrate::mark_as_from_vanity(&mut cfg) {
                if let Err(e) = profiles::save(&cfg) {
                    eprintln!("[Niobium] Couldn't save the copied settings: {e}");
                }
            }
        }
    }

    /// The backend and game server ports are fixed (`BACKEND_PORT`, `GAME_SERVER_PORT`). If the
    /// config holds other values (older launcher), they are set back, saved, and the live log
    /// says so once.
    pub fn pin_fixed_ports(&self) {
        let notes = {
            let mut cfg = self.config.lock().unwrap();
            let notes = cfg.settings.pin_fixed_ports();
            if !notes.is_empty() {
                if let Err(e) = profiles::save(&cfg) {
                    eprintln!("[Niobium] Couldn't save the settings: {e}");
                }
            }
            notes
        };
        self.note_fixed_ports(notes);
    }

    /// Writes each fixed-port note to the live log, but each only once per run.
    pub fn note_fixed_ports(&self, notes: Vec<&'static str>) {
        for note in notes {
            {
                let mut logged = self.port_notes_logged.lock().unwrap();
                if logged.contains(&note) {
                    continue;
                }
                logged.push(note);
            }
            self.log("launcher", "warning", CAT, note, None);
        }
    }

    /// Launcher log lines the UI hasn't seen yet (from before it listened to "log:line").
    /// Only the first call returns lines; after it every line comes as a "log:line" event.
    pub fn pending_log_lines(&self) -> Vec<LogLinePayload> {
        self.early_log.take()
    }

    /// Toasts the UI hasn't seen yet (from before it listened to "toast"). Only the first call
    /// returns them; after it every toast comes as a "toast" event.
    pub fn pending_toasts(&self) -> Vec<Toast> {
        self.early_toasts.take()
    }

    /// Fallback if the UI never calls `pending_log_lines` / `pending_toasts`: send what waits as events.
    pub fn release_early_log(&self) {
        for line in self.early_log.take() {
            let _ = self.app.emit("log:line", line);
        }
        for toast in self.early_toasts.take() {
            let _ = self.app.emit("toast", toast);
        }
    }

    fn log(&self, source: &str, level: &str, category: &str, message: &str, detected: Option<String>) {
        let line = LogLinePayload {
            source: source.into(),
            level: level.into(),
            category: category.into(),
            message: message.into(),
            detected,
            time: now_hms(),
        };
        // Before the UI listens, the line waits (an event now would be lost)
        if let Some(line) = self.early_log.hold(line) {
            let _ = self.app.emit("log:line", line);
        }
    }

    // --- Backend -------------------------------------------------------------

    /// Starts the backend (if it doesn't run yet) and waits until it is ready.
    /// "Stop all" during the wait ends it with `StartError::Cancelled`.
    pub fn start_backend(&self, token: StartToken) -> Result<(), StartError> {
        {
            let r = self.running.lock().unwrap();
            if r.gate.is_cancelled(token) {
                return Err(StartError::Cancelled);
            }
            if r.backend_pid.map(proc::is_running).unwrap_or(false) {
                return Ok(());
            }
        }
        let node = self.node_exe().ok_or("node.exe is missing from the launcher – please reinstall Niobium")?;
        let main = self.backend_main().ok_or("The backend is missing from the launcher – please reinstall Niobium")?;
        let cfg = self.config.lock().unwrap();
        let s = &cfg.settings;
        let bind = if s.share_backend_lan { "0.0.0.0" } else { "127.0.0.1" };
        // Not "backend": the installer puts the backend's own files there (the install folder is
        // %LOCALAPPDATA%\Niobium too), so an update or uninstall would reset or delete the locker.
        let data_dir = self.data_local().join("backend-data");
        // Backend and game server ports are fixed (the redirect DLL and the server DLL decide them);
        // only the matchmaker port comes from the settings.
        let port = BACKEND_PORT;
        let env = vec![
            ("NIOBIUM_BACKEND_PORT".into(), port.to_string()),
            ("NIOBIUM_MATCHMAKER_PORT".into(), s.matchmaker_port.to_string()),
            ("NIOBIUM_BIND".into(), bind.to_string()),
            ("NIOBIUM_DATA_DIR".into(), data_dir.to_string_lossy().into_owned()),
            ("NIOBIUM_GAMESERVER".into(), format!("127.0.0.1:{GAME_SERVER_PORT}")),
        ];
        drop(cfg);

        self.spawn_guarded(token, |r| {
            // Checked again under the lock: a Join and a start at the same time start only one backend
            if r.backend_pid.is_some_and(proc::is_running) {
                return Ok(());
            }
            self.log("backend", "info", CAT, "Starting the backend …", None);
            let pid = proc::start(&main_as_node_arg(&node), &node_args(&main), &env, false, false)
                .or_else(|_| proc::start(&node, &node_args(&main), &env, false, false))?;
            r.backend_pid = Some(pid);
            Ok(())
        })?;

        // Wait until it reports "healthy" (up to 20 s)
        match wait_for(Duration::from_secs(20), Duration::from_millis(400), || self.is_cancelled(token), || backend_healthy(port)) {
            Wait::Ready => {}
            Wait::Cancelled => return Err(StartError::Cancelled),
            Wait::TimedOut => return Err("The backend didn't start (is the port already in use?)".into()),
        }
        self.log("backend", "info", "Backend", &format!("Backend is listening on 127.0.0.1:{port}"), None);
        self.emit_services();
        Ok(())
    }

    /// Sets the matchmaker target in the backend (for joining by IP).
    fn set_backend_gameserver(&self, ip: &str, port: u16) {
        let body = serde_json::json!({ "ip": ip, "port": port });
        let _ = ureq::post(format!("http://127.0.0.1:{BACKEND_PORT}/niobium/gameserver"))
            .send_json(body);
    }

    fn set_backend_status(&self, version: &str, hosting: bool, playlist: &str) {
        let name = self.config.lock().unwrap().settings.player_name.clone();
        let body = serde_json::json!({
            "name": format!("{name}'s server"),
            "hosting": hosting, "playlist": playlist, "version": version
        });
        let _ = ureq::post(format!("http://127.0.0.1:{BACKEND_PORT}/niobium/status")).send_json(body);
    }

    // --- Starting the game ---------------------------------------------------

    fn build_for(&self, profile: &Profile) -> Result<BuildInfo, String> {
        let cfg = self.config.lock().unwrap();
        cfg.builds
            .iter()
            .find(|b| b.id == profile.build_id)
            .cloned()
            .ok_or_else(|| "The build of this profile is missing – please add it in the Library".into())
    }

    /// Starts a Fortnite instance, loads the redirect and reads the log. The instance (with its
    /// helper processes) is stored in `running` in the same locked step that starts it, so
    /// "Stop all" can always close it – and nothing starts once "Stop all" ran.
    /// `bubble_builds` = the Bubble Builds setting (only used for the player's game, see `launchargs`).
    fn launch_instance(
        &self,
        token: StartToken,
        build: &BuildInfo,
        profile: &Profile,
        host: bool,
        headless: bool,
        bubble_builds: bool,
    ) -> Result<u32, StartError> {
        if build.support == Support::Unsupported {
            return Err(format!("Niobium can't start version {} ({})", build.version, version::support_note(&build.version)).into());
        }
        if build.support == Support::Experimental {
            self.log("launcher", "warning", CAT, &format!("Version {} is untested – trying anyway", build.version), None);
        }
        let bin = Path::new(&build.binaries);
        let exe = bin.join(version::SHIPPING_EXE);
        if !exe.is_file() {
            return Err(format!("{} not found", version::SHIPPING_EXE).into());
        }

        // Reset the log signals of this role – `stream_logs` sets them again
        if host {
            self.signals.server_login.store(false, Ordering::SeqCst);
            self.signals.server_listening.store(false, Ordering::SeqCst);
        } else {
            self.signals.game_login.store(false, Ordering::SeqCst);
        }

        let env = vec![("OPENSSL_ia32cap".to_string(), "~0x20000000".to_string())];
        let host_name = self.config.lock().unwrap().settings.player_name.clone();
        let player = if host { host_name.as_str() } else { profile.player_name.as_str() };
        let args = launchargs::build(player, host, headless, &profile.launch_args, &build.version, bubble_builds);
        let who = if host { "the server Fortnite" } else { "your game" };
        if !host && bubble_builds {
            if launchargs::bubble_builds_active(host, bubble_builds, &build.version) {
                self.log("launcher", "info", CAT, "Bubble Builds on: starting in Performance Mode (-FeatureLevelES31)", None);
            } else {
                self.log("launcher", "info", CAT, &format!("Bubble Builds are on, but Fortnite {} can't show them – starting normally", build.version), None);
            }
        }

        // Start the helper processes paused (they never run – the old build only checks that they
        // exist), then Fortnite itself. Keep them, so "Stop all" closes them. When Fortnite closes
        // by itself (crash, the player quits, or it is closed below), `watch_exit` closes the
        // helpers and drops it.
        let (mut child, helpers) = self.spawn_guarded(token, |r| {
            // Never start a second one over a running one ("Stop all" would lose track of it)
            if (if host { &r.server } else { &r.game }).is_some() {
                return Err(if host { "The server Fortnite is already running." } else { "Your game is already running." }.to_string());
            }
            let mut helper_pids = Vec::new();
            for name in [version::LAUNCHER_EXE, version::EAC_EXE] {
                let p = bin.join(name);
                if p.is_file() {
                    if let Ok(pid) = proc::start(&p, &[], &[], true, false) {
                        helper_pids.push(pid);
                    }
                }
            }
            let helpers = HelperPids::new(helper_pids);
            self.log("launcher", "info", CAT, &format!("Starting {who}: {}", args.join(" ")), None);
            match proc::start_captured(&exe, &args, &env) {
                Ok(child) => {
                    let slot = if host { &mut r.server } else { &mut r.game };
                    *slot = Some(Instance { pid: child.id(), helpers: helpers.clone() });
                    Ok((child, helpers))
                }
                Err(e) => {
                    close_helpers(&helpers);
                    Err(e)
                }
            }
        })?;
        let pid = child.id();
        self.stream_logs(&mut child, host);
        self.watch_exit(child, host, helpers);

        // Load the redirect right away. Without it the build would talk to Epic's real servers –
        // that must never happen, so the process is closed again at once.
        let Some(dll) = self.dll_path(DLL_REDIRECT) else {
            let _ = proc::kill(pid);
            return Err("The redirect DLL is missing from the launcher – start stopped so nothing goes to Epic".into());
        };
        if self.is_cancelled(token) {
            // "Stop all" already closed it
            return Err(StartError::Cancelled);
        }
        if let Err(e) = proc::load_helper(pid, &dll) {
            let _ = proc::kill(pid);
            return Err(format!("Couldn't load the redirect ({e}) – start stopped so nothing goes to Epic").into());
        }
        self.log("launcher", "info", CAT, "Redirect loaded", None);
        self.watch_early_exit(token, pid, host);

        Ok(pid)
    }

    /// Waits until the instance closes (for any reason), then closes its paused helper processes
    /// and drops it from `running` – unless "Stop all" already did, or a newer instance took its place.
    fn watch_exit(&self, mut child: std::process::Child, host: bool, helpers: HelperPids) {
        let app = self.app.clone();
        let pid = child.id();
        std::thread::spawn(move || {
            // Holding the child keeps its PID from being reused until we are done here.
            let _ = child.wait();
            close_helpers(&helpers);
            let engine = app.state::<Arc<Engine>>();
            {
                let mut r = engine.running.lock().unwrap();
                let slot = if host { &mut r.server } else { &mut r.game };
                if slot.as_ref().is_some_and(|i| i.pid == pid) {
                    *slot = None;
                    if host {
                        // The control pipe belonged to this server
                        r.link = None;
                    }
                }
            }
            engine.emit_services();
        });
    }

    /// If Fortnite closes by itself in the first minutes, we explain why: the redirect closes the
    /// game on purpose when it doesn't know the version (that is then written to redirect.log).
    /// Quiet after "Stop all" (then closing is expected).
    fn watch_early_exit(&self, token: StartToken, pid: u32, host: bool) {
        let app = self.app.clone();
        let log_path = self.data_local().join("logs").join("redirect.log");
        std::thread::spawn(move || {
            let started = std::time::Instant::now();
            while started.elapsed() < Duration::from_secs(240) {
                std::thread::sleep(Duration::from_secs(2));
                let engine = app.state::<Arc<Engine>>();
                if engine.is_cancelled(token) {
                    return;
                }
                if proc::is_running(pid) {
                    continue;
                }
                // The process is gone – was it the redirect?
                let who = if host { "The server Fortnite" } else { "Your game" };
                let marker = format!("pid={pid} ");
                let redirect_error = std::fs::read_to_string(&log_path)
                    .ok()
                    .and_then(|text| {
                        text.lines()
                            .filter(|l| l.contains(&marker) && l.contains("ERROR"))
                            .last()
                            .map(str::to_string)
                    });
                match redirect_error {
                    Some(line) => {
                        engine.log("launcher", "error", CAT, &format!("{who}: the redirect doesn't know this version – {line}"), None);
                        engine.toast(
                            "error",
                            "The redirect doesn't fit this version",
                            "The redirect DLL couldn't find its anchor points in this build and closed the game to be safe. Details: Logs → redirect.log.",
                        );
                    }
                    None => {
                        engine.log("launcher", "warning", CAT, &format!("{who} closed after {} s", started.elapsed().as_secs()), None);
                        engine.toast("warning", "Fortnite closed", "Check Crashes and the live log to see why.");
                    }
                }
                engine.emit_services();
                return;
            }
        });
    }

    /// Reads stdout/stderr of the instance line by line and sends it to the UI.
    /// Spots important moments (login, server ready, errors) and reacts to them.
    fn stream_logs(&self, child: &mut std::process::Child, host: bool) {
        use std::io::{BufRead, BufReader};
        let source = if host { "server" } else { "game" };
        let app = self.app.clone();
        let engine_src = source.to_string();
        let signals = self.signals.clone();
        let mut readers: Vec<Box<dyn std::io::Read + Send>> = Vec::new();
        if let Some(o) = child.stdout.take() {
            readers.push(Box::new(o));
        }
        if let Some(e) = child.stderr.take() {
            readers.push(Box::new(e));
        }
        for reader in readers {
            let app = app.clone();
            let source = engine_src.clone();
            let signals = signals.clone();
            std::thread::spawn(move || {
                let buf = BufReader::new(reader);
                for line in buf.lines() {
                    let Ok(line) = line else { break };
                    if line.trim().is_empty() {
                        continue;
                    }
                    let (level, category, message) = logparse::split_line(&line);
                    let detection = logparse::detect(&line);
                    let _ = app.emit(
                        "log:line",
                        LogLinePayload {
                            source: source.clone(),
                            level: level_str(level).into(),
                            category,
                            message,
                            detected: detection.map(|d| d.label().to_string()),
                            time: now_hms(),
                        },
                    );
                    if let Some(d) = detection {
                        match d {
                            Detection::LoggedIn if host => signals.server_login.store(true, Ordering::SeqCst),
                            Detection::LoggedIn => signals.game_login.store(true, Ordering::SeqCst),
                            Detection::ServerListening if host => signals.server_listening.store(true, Ordering::SeqCst),
                            _ => {}
                        }
                        let _ = app.emit("detect", serde_json::json!({ "source": source, "kind": format!("{d:?}") }));
                    }
                }
            });
        }
    }

    /// Marks a start as in progress (before its thread runs, so an early "Stop all" catches it).
    /// Refused while a start runs or Fortnite still runs (e.g. a double click on "Host & Play"):
    /// a second set of processes would replace the first in `running`, and "Stop all" and closing
    /// would never reach the first one.
    pub fn begin_start(&self) -> Result<StartToken, String> {
        let mut r = self.running.lock().unwrap();
        if r.gate.is_closed() {
            return Err("Niobium is closing.".into());
        }
        if r.gate.in_progress() {
            return Err("A start is already running.".into());
        }
        if r.server.is_some() || r.game.is_some() {
            return Err("Fortnite is still running. Press Stop all first.".into());
        }
        Ok(r.gate.begin())
    }

    /// "Host & Play" (runs in its own thread, see the command): backend + server + game.
    /// `token` comes from `begin_start`. A problem ends as a toast and "Stop all". "Stop all"
    /// during the start ends it quietly: `stop_all` already wrote "Start cancelled." and put the
    /// timeline back to idle.
    pub fn host_and_play(&self, token: StartToken, profile_id: &str) {
        let Err(StartError::Failed(err)) = self.host_and_play_steps(profile_id, token) else {
            return;
        };
        // An error right after "Stop all" (e.g. the redirect can't load into the closed game) is
        // only a result of the stop – nothing to report.
        let cancelled = {
            let mut r = self.running.lock().unwrap();
            let cancelled = r.gate.is_cancelled(token);
            if !cancelled {
                r.gate.finish(token);
            }
            cancelled
        };
        if cancelled {
            return;
        }
        self.toast("error", "Couldn't start", &err);
        self.stop_all();
    }

    /// The steps of "Host & Play". Every step checks `token` first, every wait ends at once on
    /// "Stop all", and processes only start through `spawn_guarded`.
    fn host_and_play_steps(&self, profile_id: &str, token: StartToken) -> Result<(), StartError> {
        if cfg!(not(windows)) {
            return Err("Fortnite can only be started on Windows".into());
        }
        // One lock only: locking again inside `or_else` while the first guard still lives would hang.
        let profile = {
            let cfg = self.config.lock().unwrap();
            cfg.profiles.iter().find(|p| p.id == profile_id).or_else(|| cfg.active_profile()).cloned()
        }
        .ok_or("No profile picked")?;
        let build = self.build_for(&profile)?;
        let (headless, bubble_builds) = {
            let cfg = self.config.lock().unwrap();
            (cfg.settings.headless_server, cfg.settings.bubble_builds)
        };

        self.step(token, 0)?;
        self.start_backend(token)?;
        self.set_backend_status(&build.version, true, &profile.playlist);

        // Server Fortnite – put a fresh parkour list in place first (the server DLL reads it)
        self.step(token, 1)?;
        write_parkour_file(Some(self));
        // Bubble Builds: back up Fortnite's settings file (and set Meshes to Low where the look needs
        // it) before any Fortnite starts – the server Fortnite reads the same file.
        let bubble = launchargs::bubble_builds_active(false, bubble_builds, &build.version);
        if bubble {
            self.gus_prepare(token, &build.version);
        }
        // The server never gets Bubble Builds (launchargs::build ignores the setting for the host)
        let server_pid = self.launch_instance(token, &build, &profile, true, headless, bubble_builds)?;
        self.step(token, 2)?; // the redirect is loaded in launch_instance
        self.emit_services();

        // Step 3: the server logs in (spotted in the log) → then load the server DLL.
        self.step(token, 3)?;
        self.inject_after_login(token, server_pid, true, &build);

        // Step 4: your game starts at the same time – the server loads the map in the background.
        self.step(token, 4)?;
        let game_pid = self.launch_instance(token, &build, &profile, false, false, bubble_builds)?;
        if bubble {
            self.gus_game_started(game_pid);
        }
        self.inject_after_login(token, game_pid, false, &build);
        self.emit_services();

        // Steps 5/6 in the background: first connect to the control pipe of the server DLL (turn on
        // commands, send playlist/Lategame, unlock "Start match"), then wait until the game server
        // listens on port 7777.
        self.step(token, 5)?;
        let app = self.app.clone();
        std::thread::spawn(move || {
            let engine = app.state::<Arc<Engine>>();
            engine.connect_and_wait_for_server(token, &profile);
        });
        Ok(())
    }

    /// Steps 5/6 of "Host & Play" (in the background). Every wait ends at once on "Stop all".
    fn connect_and_wait_for_server(&self, token: StartToken, profile: &Profile) {
        // 1) Control pipe – shows up once the server DLL runs (wait up to 4 minutes)
        let (tx, rx) = channel::<ServerEvent>();
        let mut link = None;
        let waited = wait_for(
            Duration::from_secs(240),
            Duration::from_millis(500),
            || self.is_cancelled(token),
            || {
                link = ServerLink::connect(tx.clone());
                link.is_some()
            },
        );
        if waited == Wait::Cancelled {
            return;
        }
        match link {
            Some(link) => {
                let link = Arc::new(link);
                {
                    // Only keep it while the start still counts ("Stop all" drops the link)
                    let mut r = self.running.lock().unwrap();
                    if r.gate.is_cancelled(token) {
                        return;
                    }
                    r.link = Some(link.clone());
                }
                self.spawn_server_event_loop(rx);
                self.apply_profile_to_server(&link, profile);
                self.log("launcher", "info", CAT, "Connected to the server's control pipe – commands on, match settings sent", None);
                self.toast(
                    "info",
                    "The server is waiting for you",
                    "Go to Match and press \"Start match\" (or START SERVER in the server window). Then the server loads the map.",
                );
            }
            None => {
                self.log("launcher", "info", CAT, "No control pipe – use the server's own window", None);
                self.toast("info", "Server window", "In the server window, pick a playlist and press START SERVER.");
            }
        }

        // 2) Wait for "listening on port 7777" – starting is done by hand, so wait generously (30 minutes)
        match self.wait_signal(token, |s| &s.server_listening, Duration::from_secs(1800)) {
            Wait::Cancelled => {}
            Wait::TimedOut => {
                if !self.is_cancelled(token) {
                    self.toast(
                        "error",
                        "The game server isn't answering",
                        "\"IpNetDriver listening\" is missing from the server log. Check the live log (source: server) and Crashes.",
                    );
                }
            }
            Wait::Ready => {
                {
                    // Step 6 and "start done" in one locked step, so a "Stop all" right now wins
                    let mut r = self.running.lock().unwrap();
                    if r.gate.is_cancelled(token) {
                        return;
                    }
                    r.gate.finish(token);
                    r.step = 6;
                    let _ = self.app.emit("launch:step", 6);
                }
                self.log("launcher", "info", CAT, "The game server is listening on port 7777", None);
                self.emit_services();
                self.toast("success", "Server ready", "Press Play in the game – the match runs on 127.0.0.1.");
            }
        }
    }

    /// Waits (at most `timeout`) for a log signal; ends at once on "Stop all".
    fn wait_signal(&self, token: StartToken, pick: impl Fn(&Signals) -> &AtomicBool, timeout: Duration) -> Wait {
        wait_for(timeout, Duration::from_millis(250), || self.is_cancelled(token), || {
            pick(&self.signals).load(Ordering::SeqCst)
        })
    }

    /// Loads the matching DLL into the instance once the log shows the login
    /// (waits at most 3 minutes, then loads it anyway). Runs in its own thread.
    /// "Stop all" ends the wait; the DLL is then not loaded.
    fn inject_after_login(&self, token: StartToken, pid: u32, host: bool, build: &BuildInfo) {
        let dll_name = if host { DLL_SERVER } else { DLL_CLIENT };
        let Some(dll) = self.dll_path(dll_name) else {
            self.log(
                "launcher",
                "warning",
                CAT,
                &format!("{dll_name} is missing from the launcher – skipping this part"),
                None,
            );
            return;
        };
        // The wait after login depends on the version (see VersionRules)
        let rules = launchargs::VersionRules::for_version(&build.version);
        let delay = if host { rules.server_inject_delay_secs } else { rules.client_inject_delay_secs };
        let app = self.app.clone();
        std::thread::spawn(move || {
            let engine = app.state::<Arc<Engine>>();
            let who = if host { "Server" } else { "Game" };
            let seen = engine.wait_signal(token, |s| if host { &s.server_login } else { &s.game_login }, Duration::from_secs(180));
            if seen == Wait::Cancelled {
                return;
            }
            if seen == Wait::TimedOut {
                engine.log(
                    "launcher",
                    "warning",
                    CAT,
                    &format!("{who}: no login seen in the log – loading {dll_name} anyway"),
                    None,
                );
            }
            // short grace period so the engine objects / the lobby world are ready
            let grace = wait_for(Duration::from_secs(delay), Duration::from_millis(250), || engine.is_cancelled(token), || false);
            if grace == Wait::Cancelled {
                return;
            }
            match proc::load_helper(pid, &dll) {
                Ok(_) => engine.log(if host { "server" } else { "game" }, "info", CAT, &format!("{dll_name} loaded"), None),
                // After "Stop all" the game is gone – that error means nothing
                Err(_) if engine.is_cancelled(token) => {}
                Err(e) => engine.log("launcher", "error", CAT, &format!("Couldn't load {dll_name}: {e}"), None),
            }
        });
    }

    fn spawn_server_event_loop(&self, rx: std::sync::mpsc::Receiver<ServerEvent>) {
        let app = self.app.clone();
        std::thread::spawn(move || {
            let mut was_ready = false;
            let mut last_living_world: Option<LivingWorldEvent> = None;
            for ev in rx {
                let _ = app.emit("server:event", serde_json::json!({ "event": ev.event, "data": ev.rest }));
                // Match just started (launcher, START SERVER or the auto-host countdown in the server window):
                // turn commands on again. "Toggle Auto Host" in the server window turns them off otherwise
                // (GUI.cpp), and friends would get "Commands are currently disabled" on the F9 trickshot buttons.
                if ev.event == "status" {
                    let ready = ev.rest.get("ready").and_then(|v| v.as_bool()).unwrap_or(false);
                    if ready && !was_ready {
                        let engine = app.state::<Arc<Engine>>();
                        if let Ok(link) = engine.link() {
                            if let Err(e) = link.set_config("bEnableCheats", serde_json::Value::Bool(true)) {
                                engine.log("launcher", "warning", CAT, &format!("Couldn't turn on commands: {e}"), None);
                            }
                        }
                    }
                    was_ready = ready;
                }
                if ev.event == "trickshot" {
                    let _ = app.emit("trickshot", serde_json::Value::Object(ev.rest.clone()));
                }
                // AI bots on or off for this match (the server decides once, after its checks)
                if ev.event == "playerBots" {
                    let bots = PlayerBotsEvent::from_pipe(&ev.rest);
                    let engine = app.state::<Arc<Engine>>();
                    let level = if bots.state == "active" { "info" } else { "warning" };
                    // Category "bots", so the Live Log's "AI bots" topic shows it next to the server's lines
                    engine.log("launcher", level, logparse::CATEGORY_BOTS, &bots.log_line(), None);
                    let _ = app.emit(EVENT_PLAYER_BOTS, bots);
                }
                // Bosses & NPCs: on, not available (with the reason) or off – sent at "Start match". The live
                // log only gets a line when the switch is on and the state or reason changes within a match
                // ("off" never gets one); the UI gets every event and ignores "off".
                if ev.event == "livingWorld" {
                    let living = LivingWorldEvent::from_pipe(&ev.rest);
                    if living.worth_a_log_line(last_living_world.as_ref()) {
                        let engine = app.state::<Arc<Engine>>();
                        // Category "livingWorld", so the Live Log's "Bosses & NPCs" topic shows it too
                        engine.log("launcher", living.log_level(), logparse::CATEGORY_LIVING_WORLD, &living.log_line(), None);
                    }
                    let _ = app.emit(EVENT_LIVING_WORLD, living.clone());
                    last_living_world = Some(living);
                }
                // Show refused commands as a hint (the server explains why)
                if ev.event == "reply" && ev.rest.get("ok").and_then(|v| v.as_bool()) == Some(false) {
                    let msg = ev.rest.get("message").and_then(|v| v.as_str()).unwrap_or("Command refused").to_string();
                    let _ = app.emit("toast", Toast { kind: "warning".into(), title: "Server".into(), description: msg });
                }
                if ev.event == "matchEnd" {
                    // the next match gets its own Bosses & NPCs line, even with the same answer
                    last_living_world = None;
                    let _ = app.emit("toast", Toast { kind: "info".into(), title: "Match over".into(), description: "The server says the round has ended.".into() });
                }
            }
        });
    }

    /// Sends the profile settings to the running server.
    ///
    /// The server handles the pipe in order. So `bEnableCheats` = true comes first: without it the
    /// server refuses every command ("Commands are currently disabled") – and saved server settings
    /// (auto host) start with "off". The F9 "Trickshot" tab and the Match page rely on this.
    /// It's your own server, so the commands work for every player on it.
    ///
    /// The launcher never sends `bEnableTrickshotTab` on purpose: `false` resets all trickshot switches
    /// on the server (jump fatigue, auto reload, …) (NiobiumControl.cpp, ApplyConfig).
    ///
    /// Order (see `niobium_core::bots::server_config_for`): bEnableCheats, playlist, bLateGame,
    /// bInfiniteAmmo, bInfiniteMats, bPlayerBots, PlayerBotCount, PlayerBotTargetELO, then
    /// bLivingWorld and LivingWorldMaxAI only when the profile has Bosses & NPCs on. The bot and
    /// "Bosses & NPCs" keys go out before the map loads (the server waits for "Start match"), which
    /// is when it accepts them.
    fn apply_profile_to_server(&self, link: &ServerLink, profile: &Profile) {
        for (key, value) in bots::server_config_for(profile) {
            if let Err(e) = link.set_config(key, value) {
                if key == "bEnableCheats" {
                    self.log("launcher", "warning", CAT, &format!("Couldn't turn on commands: {e}"), None);
                }
            }
        }
    }

    // --- Bubble Builds: Fortnite's settings file (GameUserSettings.ini) --------------------
    //
    // The user allowed Niobium to change this shared file for Bubble Builds, as long as the original
    // values come back by themselves. Before the start the exact lines are backed up to
    // %LOCALAPPDATA%\Niobium\gus-backup.json (see `niobium_core::perfmode`); after the game they are
    // put back and the backup is deleted. A backup left over from a crash is put back at the next start.

    /// At launcher start, before anything else touches the file: put back a backup that is still
    /// there (the launcher closed or crashed during a game). If a Fortnite is still running, that
    /// waits until it is closed.
    pub fn recover_gus_backup(&self) {
        if !perfmode::backup_path().exists() {
            return;
        }
        if !fortnite_running() {
            self.gus_restore(gus_backup_id().as_deref(), false, true);
            return;
        }
        self.log("launcher", "info", CAT, "Fortnite is still running. Its graphics settings are put back once it closes.", None);
        self.restore_gus_once_fortnite_closed();
    }

    /// In the background: waits until no Fortnite runs any more, then puts back the backup that is
    /// there now. Only that one: a later start may have put it back and made its own meanwhile.
    /// At most one such wait runs at a time.
    fn restore_gus_once_fortnite_closed(&self) {
        if self.gus_waiter.swap(true, Ordering::SeqCst) {
            return;
        }
        let id = gus_backup_id();
        let app = self.app.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(2));
                if !fortnite_running() {
                    break;
                }
            }
            std::thread::sleep(Duration::from_secs(1));
            let Some(engine) = app.try_state::<Arc<Engine>>() else { return };
            engine.gus_restore(id.as_deref(), false, true);
            engine.gus_waiter.store(false, Ordering::SeqCst);
        });
    }

    /// Before the first Fortnite of a start with Bubble Builds: back up the lines, set Meshes to Low
    /// on 15.40 – 16.00 and 19.x, and watch the start so they come back afterwards.
    fn gus_prepare(&self, token: StartToken, version: &str) {
        let Some(ini) = perfmode::game_user_settings_path() else { return };
        // A backup from an earlier game that couldn't be put back yet goes first, but only once no
        // Fortnite runs any more (this start's own haven't started yet). A Fortnite from before, e.g.
        // after a launcher crash, still has the changed settings and saves them when it closes, which
        // would undo a restore made now. Then the old backup stays and this game changes nothing.
        if perfmode::backup_path().exists() {
            let closed = wait_for(
                Duration::from_secs(5),
                Duration::from_millis(250),
                || self.is_cancelled(token),
                || !fortnite_running(),
            );
            match closed {
                Wait::Ready => {
                    self.gus_restore(None, false, true);
                }
                Wait::Cancelled => return,
                Wait::TimedOut => {
                    self.log(
                        "launcher",
                        "warning",
                        CAT,
                        "Another Fortnite is still running, so Fortnite's graphics settings were not changed for this game. They are put back once every Fortnite has closed.",
                        None,
                    );
                    self.restore_gus_once_fortnite_closed();
                    return;
                }
            }
        }
        let low_meshes = launchargs::VersionRules::for_version(version).bubble_builds.needs_low_meshes();
        let id = new_gus_id();
        let mut gus = self.gus.lock().unwrap();
        match perfmode::prepare(&ini, &perfmode::backup_path(), low_meshes, &id) {
            Ok(Prepared::NoFile) => {
                self.log("launcher", "info", CAT, "Fortnite has no settings file yet, so there is nothing to back up.", None);
            }
            Ok(Prepared::Skipped(why)) => {
                self.log("launcher", "warning", CAT, &format!("Fortnite's graphics settings were not changed: {why}"), None);
            }
            Ok(Prepared::BackedUp { id, meshes }) => {
                *gus = Some(GusSession { id: id.clone(), game_pid: None });
                drop(gus);
                self.log("launcher", "info", CAT, "Backed up Fortnite's graphics settings. They are put back when the game closes.", None);
                match meshes {
                    MeshChange::SetToLow { from } => self.log(
                        "launcher",
                        "info",
                        CAT,
                        &format!("Meshes set to Low for this game (it was {from})."),
                        None,
                    ),
                    MeshChange::AlreadyLow => self.log("launcher", "info", CAT, "Meshes is already Low.", None),
                    MeshChange::Added => self.log(
                        "launcher",
                        "info",
                        CAT,
                        "Meshes set to Low for this game (Fortnite's settings had no Meshes line yet).",
                        None,
                    ),
                    MeshChange::WriteFailed(e) => self.log(
                        "launcher",
                        "warning",
                        CAT,
                        &format!("Couldn't set Meshes to Low ({e}). Builds may look normal."),
                        None,
                    ),
                    MeshChange::NotNeeded => {}
                }
                self.watch_gus(token, id);
            }
            Err(e) => {
                self.log(
                    "launcher",
                    "warning",
                    CAT,
                    &format!("Couldn't back up Fortnite's graphics settings ({e}), so nothing in them was changed."),
                    None,
                );
            }
        }
    }

    /// The player's game of this start is running (its settings come back once it closes).
    fn gus_game_started(&self, pid: u32) {
        if let Some(session) = self.gus.lock().unwrap().as_mut() {
            session.game_pid = Some(pid);
        }
    }

    /// Waits until the player's game of this start has closed (or the start ended without it),
    /// then puts the lines back. If the server Fortnite still runs, the backup is kept until it is
    /// gone too and the lines are checked once more (it reads and may save the same file).
    fn watch_gus(&self, token: StartToken, id: String) {
        let app = self.app.clone();
        std::thread::spawn(move || {
            let engine = app.state::<Arc<Engine>>();
            let mut server_pid = None;
            let game_pid = loop {
                std::thread::sleep(Duration::from_secs(1));
                let session = engine.gus.lock().unwrap().clone();
                let Some(session) = session.filter(|s| s.id == id) else { return };
                let (starting, server) = {
                    let r = engine.running.lock().unwrap();
                    (!r.gate.is_cancelled(token) && r.gate.in_progress(), r.server.as_ref().map(|i| i.pid))
                };
                if server.is_some() {
                    server_pid = server;
                }
                match session.game_pid {
                    Some(pid) if !proc::is_running(pid) => break Some(pid),
                    Some(_) => {}
                    // The start ended (failed or "Stop all") before the game started
                    None if !starting => break None,
                    None => {}
                }
            };
            // give Fortnite a moment to finish writing its settings
            std::thread::sleep(Duration::from_secs(1));
            let server_alive = server_pid.filter(|p| proc::is_running(*p));
            if !engine.gus_restore(Some(&id), server_alive.is_some(), game_pid.is_some()) {
                return;
            }
            let Some(server) = server_alive else { return };
            while proc::is_running(server) {
                std::thread::sleep(Duration::from_secs(2));
                if engine.gus.lock().unwrap().as_ref().is_none_or(|s| s.id != id) {
                    return;
                }
            }
            std::thread::sleep(Duration::from_secs(1));
            engine.gus_restore(Some(&id), false, false);
        });
    }

    /// Puts the backed-up lines back (see `perfmode::restore`) and says so in the live log, plus a
    /// toast when the file really changed and `announce` is set. `keep` = keep the backup for one
    /// more check later. Returns false if it failed (the backup stays for the next try).
    fn gus_restore(&self, only_id: Option<&str>, keep: bool, announce: bool) -> bool {
        let mut gus = self.gus.lock().unwrap();
        let result = perfmode::restore(&perfmode::backup_path(), only_id, keep);
        if !keep && matches!(result, Ok(_)) && gus.as_ref().is_some_and(|s| only_id.is_none_or(|id| id == s.id)) {
            *gus = None;
        }
        drop(gus);
        match result {
            Ok(Restored::Restored) => {
                self.log("launcher", "info", CAT, &format!("{GUS_PUT_BACK} (GameUserSettings.ini)"), None);
                if announce {
                    self.toast("success", GUS_PUT_BACK, "");
                }
                true
            }
            Ok(Restored::Unchanged) => {
                if announce {
                    self.log("launcher", "info", CAT, "Fortnite's graphics settings are unchanged.", None);
                }
                true
            }
            Ok(Restored::FileGone) => {
                if announce {
                    self.log("launcher", "info", CAT, "Fortnite's settings file is gone, so there was nothing to put back.", None);
                }
                true
            }
            Ok(Restored::Corrupt) => {
                self.log(
                    "launcher",
                    "warning",
                    CAT,
                    "Niobium's backup of Fortnite's graphics settings couldn't be read. Nothing was changed.",
                    None,
                );
                true
            }
            Ok(Restored::NoBackup | Restored::OtherBackup) => true,
            Err(e) => {
                self.log(
                    "launcher",
                    "warning",
                    CAT,
                    &format!("Couldn't put Fortnite's graphics settings back ({e}). Niobium tries again when it starts next time."),
                    None,
                );
                false
            }
        }
    }

    // --- Host commands -------------------------------------------------------

    fn link(&self) -> Result<Arc<ServerLink>, String> {
        self.running.lock().unwrap().link.clone().ok_or("No server connected".into())
    }

    pub fn server_exec(&self, text: &str) -> Result<(), String> {
        self.link()?.exec(text).map(|_| ())
    }

    pub fn server_config(&self, key: &str, value: serde_json::Value) -> Result<(), String> {
        self.link()?.set_config(key, value).map(|_| ())
    }

    pub fn server_start_match(&self) -> Result<(), String> {
        let link = self.link()?;
        // Turn commands on first, then start (the pipe runs in order): "Toggle Auto Host" in the
        // server window may have turned them off again since we connected.
        link.set_config("bEnableCheats", serde_json::Value::Bool(true))?;
        link.start_match().map(|_| ())
    }

    // --- Joining -------------------------------------------------------------

    pub fn join_ip(&self, addr: &str) -> Result<(), String> {
        let (ip, port) = split_addr(addr, GAME_SERVER_PORT);
        // Tell our own backend where to send the player: "Play" in the lobby then goes there
        // (matchmaking, see backend/lawinserver/structure/matchmaking.js).
        // No "open" through the server pipe: that runs as a cheat command on your OWN server, which
        // doesn't know the command – it would only have written the command list into the chat.
        let token = self.running.lock().unwrap().gate.token();
        self.start_backend(token).map_err(|e| match e {
            StartError::Cancelled => "Stopped before the backend was ready.".to_string(),
            StartError::Failed(e) => e,
        })?;
        self.set_backend_gameserver(&ip, port);
        self.toast("info", "Join", &format!("Press Play in the game – you'll land on {ip}:{port}."));
        Ok(())
    }

    // --- Stopping ------------------------------------------------------------

    /// "Stop all": closes your game, the server Fortnite (each with its helper processes) and the
    /// backend. A start that is still running is cancelled: nothing more starts, every wait ends,
    /// the timeline goes back to idle and the log says "Start cancelled." once.
    pub fn stop_all(&self) {
        self.stop_everything(false);
    }

    /// Closing Niobium: like "Stop all", and nothing may start any more afterwards. Sends nothing
    /// to the UI (it is closing). Safe to call more than once (`quit_app`, then again on exit).
    pub fn shutdown(&self) {
        self.stop_everything(true);
    }

    /// For closing the window (runs on the main thread, so it never waits for the lock):
    /// `None` once `shutdown` ran (the window may close), else what still runs or starts in plain
    /// words for "Close Niobium?" (empty = nothing, close at once).
    pub fn close_check(&self) -> Option<Vec<String>> {
        let r = match self.running.try_lock() {
            Ok(r) => r,
            Err(TryLockError::Poisoned(p)) => p.into_inner(),
            // A start step holds the lock right now (e.g. Fortnite is being started)
            Err(TryLockError::WouldBlock) => return Some(Busy { starting: true, ..Busy::default() }.names()),
        };
        if r.gate.is_closed() {
            return None;
        }
        Some(
            Busy {
                game: r.game.is_some(),
                server: r.server.is_some(),
                backend: r.backend_pid.is_some_and(proc::is_running),
                starting: r.gate.in_progress(),
            }
            .names(),
        )
    }

    /// A close was blocked and "Close Niobium?" is sent to the UI: returns the question's number.
    pub fn ask_close(&self) -> u64 {
        self.close_prompt.lock().unwrap().ask()
    }

    /// The UI shows question `id` (command `close_prompt_shown`): the user decides there.
    pub fn close_prompt_shown(&self, id: u64) {
        self.close_prompt.lock().unwrap().shown(id);
    }

    /// True if the UI never showed question `id` (and no newer one was asked).
    pub fn close_prompt_unanswered(&self, id: u64) -> bool {
        self.close_prompt.lock().unwrap().unanswered(id)
    }

    fn stop_everything(&self, closing: bool) {
        let (instances, backend, was_starting) = {
            let mut r = self.running.lock().unwrap();
            // From here on no start step runs and no process starts (see `spawn_guarded`)
            let was_starting = if closing { r.gate.close() } else { r.gate.cancel() };
            r.link = None;
            r.step = -1;
            let instances = [r.game.take(), r.server.take()];
            let backend = r.backend_pid.take();
            if !closing {
                // under the lock, so no start step can come after the -1
                let _ = self.app.emit("launch:step", -1);
            }
            (instances, backend, was_starting)
        };
        let mut killed = Vec::new();
        for inst in instances.into_iter().flatten() {
            let _ = proc::kill(inst.pid);
            close_helpers(&inst.helpers);
            killed.push(inst.pid);
        }
        if let Some(pid) = backend {
            let _ = proc::kill(pid);
        }
        if closing {
            // Bubble Builds: the watcher thread ends with Niobium, so put Fortnite's settings back
            // now – once the games are really gone. Otherwise the next start does it.
            if perfmode::backup_path().exists() {
                let gone = wait_for(Duration::from_secs(5), Duration::from_millis(100), || false, || {
                    !killed.iter().any(|pid| proc::is_running(*pid))
                });
                if gone == Wait::Ready && !fortnite_running() {
                    self.gus_restore(None, false, false);
                }
            }
            return;
        }
        if was_starting {
            self.log("launcher", "info", CAT, START_CANCELLED, None);
        }
        self.emit_services();
    }
}

/// Writes the built-in parkour list to `%LOCALAPPDATA%\Niobium\server\parkours.json`
/// (server DLL: "cheat parkour …", F9 menu: "Trickshot" tab). Errors only go to the log.
pub fn write_parkour_file(engine: Option<&Engine>) {
    match niobium_core::parkours::write_for_server() {
        Ok(path) => {
            if let Some(engine) = engine {
                engine.log("launcher", "info", CAT, &format!("Parkour list ready: {}", path.display()), None);
            }
        }
        Err(e) => {
            let text = format!("Couldn't write the parkour list: {e}");
            match engine {
                Some(engine) => engine.log("launcher", "warning", CAT, &text, None),
                None => eprintln!("[Niobium] {text}"),
            }
        }
    }
}

/// Niobium used to be called Vanity: copies `%APPDATA%\Vanity\config.json` (+ client.json) and
/// `%LOCALAPPDATA%\Vanity\server` over once, if the Niobium places are still empty. Never deletes
/// anything. Returns what happened if something was copied (see `Engine::after_migration`).
pub fn migrate_from_vanity() -> Option<niobium_core::migrate::MigrationReport> {
    let paths = niobium_core::migrate::MigrationPaths::for_this_user()?;
    let report = niobium_core::migrate::migrate(&paths);
    if !report.did_anything() {
        return None;
    }
    if let Some(line) = report.summary() {
        eprintln!("[Niobium] {line}");
    }
    Some(report)
}

/// Closes the paused helper processes of an instance (each PID only once, see `HelperPids`).
fn close_helpers(helpers: &HelperPids) {
    for pid in helpers.take() {
        let _ = proc::kill(pid);
    }
}

fn instance_status(inst: &Option<Instance>) -> ServiceStatus {
    match inst {
        Some(i) if proc::is_running(i.pid) => ServiceStatus::Running,
        Some(_) => ServiceStatus::Starting,
        None => ServiceStatus::Stopped,
    }
}

fn status_of(running: bool, exists: bool) -> ServiceStatus {
    if running {
        ServiceStatus::Running
    } else if exists {
        ServiceStatus::Starting
    } else {
        ServiceStatus::Stopped
    }
}

fn level_str(l: logparse::Level) -> &'static str {
    match l {
        logparse::Level::Info => "info",
        logparse::Level::Warning => "warning",
        logparse::Level::Error => "error",
    }
}

/// The GameUserSettings.ini backup of one start (Bubble Builds).
#[derive(Debug, Clone)]
struct GusSession {
    /// Id written into the backup file, so a watcher only ever restores its own backup.
    id: String,
    /// The player's game of that start, once it runs.
    game_pid: Option<u32>,
}

/// Unique id for a new GameUserSettings.ini backup.
fn new_gus_id() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    format!("{millis}-{}", std::process::id())
}

/// Id of the backup that is on disk now (None if there is none or it can't be read).
fn gus_backup_id() -> Option<String> {
    match perfmode::read_backup(&perfmode::backup_path()) {
        Ok(Some(b)) => Some(b.id),
        _ => None,
    }
}

/// Any Fortnite (ours, an old one, or live Fortnite) is running – they all share the settings file.
fn fortnite_running() -> bool {
    proc::find_pid_by_name(version::SHIPPING_EXE).is_some()
}

fn now_hms() -> String {
    // simple clock time without an extra library
    use std::time::{SystemTime, UNIX_EPOCH};
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs();
    let ms = d.subsec_millis();
    let (h, m, s) = ((secs / 3600) % 24, (secs / 60) % 60, secs % 60);
    format!("{h:02}:{m:02}:{s:02}.{ms:03}")
}

fn split_addr(addr: &str, default_port: u16) -> (String, u16) {
    match addr.trim().rsplit_once(':') {
        Some((ip, port)) => (ip.to_string(), port.parse().unwrap_or(default_port)),
        None => (addr.trim().to_string(), default_port),
    }
}

/// The call is `node.exe main.js` – the exe is node, the argument is the backend file.
fn node_args(main: &Path) -> Vec<String> {
    vec![main.to_string_lossy().into_owned()]
}
fn main_as_node_arg(node: &Path) -> PathBuf {
    node.to_path_buf()
}

/// One check whether the backend says "healthy". Short time limit, so "Stop all" isn't kept waiting.
fn backend_healthy(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/niobium/health");
    let Ok(mut resp) = ureq::get(&url).config().timeout_global(Some(Duration::from_secs(1))).build().call() else {
        return false;
    };
    resp.body_mut()
        .read_json::<serde_json::Value>()
        .is_ok_and(|v| v.get("ok").and_then(|b| b.as_bool()) == Some(true))
}

/// Detection from the log for the UI (kept for later reactions).
#[allow(dead_code)]
fn detection_label(d: Detection) -> &'static str {
    d.label()
}
