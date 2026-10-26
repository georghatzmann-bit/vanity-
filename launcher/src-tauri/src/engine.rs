//! The control centre of the launcher: starts the backend and Fortnite, loads the DLLs,
//! reads the logs live and controls the game server through the pipe.
//!
//! Anything that touches the real game only works on Windows. On other systems the
//! checks (version, crashes) still work.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use niobium_core::earlylog::EarlyLines;
use niobium_core::helperprocs::HelperPids;
use niobium_core::launchargs;
use niobium_core::logparse::{self, Detection};
use niobium_core::perfmode;
use niobium_core::profiles::{self, Config, Profile, BACKEND_PORT, GAME_SERVER_PORT};
use niobium_core::version::{self, BuildInfo, Support};

use crate::pipe::{ServerEvent, ServerLink};
use crate::proc;

/// Names of the DLLs (in the resource folder `dlls/`).
const DLL_REDIRECT: &str = "niobium_redirect.dll";
const DLL_SERVER: &str = "niobium_server.dll";
const DLL_CLIENT: &str = "niobium_client.dll";

/// Tauri event when Fortnite saved Performance Mode as the default (payload `{ path }`).
pub const EVENT_BUBBLE_INI_CHANGED: &str = "bubble:ini-changed";

/// Category of the launcher's own log lines in the live log.
const CAT: &str = "Niobium";

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
    stopping: bool,
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
    /// Bubble Builds: the `[D3DRHIPreference]` lines of GameUserSettings.ini from before the last
    /// launch (None = file didn't exist or Bubble Builds weren't used).
    perf_mode_ini: Mutex<Option<perfmode::Snapshot>>,
    /// Launcher log lines from before the UI listens; the UI fetches them once with the
    /// `pending_log_lines` command (see `niobium_core::earlylog`).
    early_log: EarlyLines<LogLinePayload>,
    /// Fixed-port notes already written to the live log (each only once per run).
    port_notes_logged: Mutex<Vec<&'static str>>,
}

impl Engine {
    pub fn new(app: AppHandle) -> Self {
        Engine {
            config: Mutex::new(profiles::load()),
            running: Mutex::new(Running::default()),
            signals: Arc::new(Signals::default()),
            perf_mode_ini: Mutex::new(None),
            early_log: EarlyLines::new(),
            port_notes_logged: Mutex::new(Vec::new()),
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

    fn emit_step(&self, step: i32) {
        self.running.lock().unwrap().step = step;
        let _ = self.app.emit("launch:step", step);
    }

    fn toast(&self, kind: &str, title: &str, description: &str) {
        let _ = self.app.emit(
            "toast",
            Toast { kind: kind.into(), title: title.into(), description: description.into() },
        );
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

    /// Fallback if the UI never calls `pending_log_lines`: send the waiting lines as events.
    pub fn release_early_log(&self) {
        for line in self.early_log.take() {
            let _ = self.app.emit("log:line", line);
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

    pub fn start_backend(&self) -> Result<(), String> {
        {
            let r = self.running.lock().unwrap();
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

        self.log("backend", "info", CAT, "Starting the backend …", None);
        let pid = proc::start(&main_as_node_arg(&node), &node_args(&main), &env, false, false)
            .or_else(|_| proc::start(&node, &node_args(&main), &env, false, false))?;
        self.running.lock().unwrap().backend_pid = Some(pid);

        // Wait until it reports "healthy" (up to 20 s)
        if !wait_backend_health(port, Duration::from_secs(20)) {
            return Err("The backend didn't start (is the port already in use?)".into());
        }
        self.log("backend", "info", "Backend", &format!("Backend is listening on 127.0.0.1:{port}"), None);
        self.emit_services();
        Ok(())
    }

    pub fn stop_backend(&self) {
        let pid = self.running.lock().unwrap().backend_pid.take();
        if let Some(pid) = pid {
            let _ = proc::kill(pid);
        }
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
    /// helper processes) is stored in `running` right away, so "Stop all" can close it.
    /// `bubble_builds` = the Bubble Builds setting (only used for the player's game, see `launchargs`).
    fn launch_instance(&self, build: &BuildInfo, profile: &Profile, host: bool, headless: bool, bubble_builds: bool) -> Result<u32, String> {
        if build.support == Support::Unsupported {
            return Err(format!("Niobium can't start version {} ({})", build.version, version::support_note(&build.version)));
        }
        if build.support == Support::Experimental {
            self.log("launcher", "warning", CAT, &format!("Version {} is untested – trying anyway", build.version), None);
        }
        let bin = Path::new(&build.binaries);
        let exe = bin.join(version::SHIPPING_EXE);
        if !exe.is_file() {
            return Err(format!("{} not found", version::SHIPPING_EXE));
        }

        // Reset the log signals of this role – `stream_logs` sets them again
        if host {
            self.signals.server_login.store(false, Ordering::SeqCst);
            self.signals.server_listening.store(false, Ordering::SeqCst);
        } else {
            self.signals.game_login.store(false, Ordering::SeqCst);
        }

        // Start the helper processes paused (they never run – the old build only checks that they exist).
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
        self.log("launcher", "info", CAT, &format!("Starting {who}: {}", args.join(" ")), None);

        let mut child = match proc::start_captured(&exe, &args, &env) {
            Ok(child) => child,
            Err(e) => {
                close_helpers(&helpers);
                return Err(e);
            }
        };
        let pid = child.id();
        self.stream_logs(&mut child, host);
        // Keep it, so "Stop all" closes it and its helpers. When it closes by itself (crash, the
        // player quits, or it is closed below), `watch_exit` closes the helpers and drops it.
        {
            let mut r = self.running.lock().unwrap();
            let slot = if host { &mut r.server } else { &mut r.game };
            *slot = Some(Instance { pid, helpers: helpers.clone() });
        }
        self.watch_exit(child, host, helpers);

        // Load the redirect right away. Without it the build would talk to Epic's real servers –
        // that must never happen, so the process is closed again at once.
        let Some(dll) = self.dll_path(DLL_REDIRECT) else {
            let _ = proc::kill(pid);
            return Err("The redirect DLL is missing from the launcher – start stopped so nothing goes to Epic".into());
        };
        if let Err(e) = proc::load_helper(pid, &dll) {
            let _ = proc::kill(pid);
            return Err(format!("Couldn't load the redirect ({e}) – start stopped so nothing goes to Epic"));
        }
        self.log("launcher", "info", CAT, "Redirect loaded", None);
        self.watch_early_exit(pid, host);

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
    fn watch_early_exit(&self, pid: u32, host: bool) {
        let app = self.app.clone();
        let log_path = self.data_local().join("logs").join("redirect.log");
        std::thread::spawn(move || {
            let started = std::time::Instant::now();
            while started.elapsed() < Duration::from_secs(240) {
                std::thread::sleep(Duration::from_secs(2));
                let engine = app.state::<Arc<Engine>>();
                if engine.running.lock().unwrap().stopping {
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

    /// The big sequence: backend + server + game.
    pub fn host_and_play(&self, profile_id: &str) -> Result<(), String> {
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

        self.running.lock().unwrap().stopping = false;
        self.emit_step(0);
        self.start_backend().inspect_err(|_| self.emit_step(-1))?;
        self.set_backend_status(&build.version, true, &profile.playlist);

        // Server Fortnite – put a fresh parkour list in place first (the server DLL reads it)
        self.emit_step(1);
        write_parkour_file(Some(self));
        // The server never gets Bubble Builds (launchargs::build ignores the setting for the host)
        let server_pid = self.launch_instance(&build, &profile, true, headless, bubble_builds)?;
        self.emit_step(2); // the redirect is loaded in launch_instance
        self.emit_services();

        // Step 3: the server logs in (spotted in the log) → then load the server DLL.
        self.emit_step(3);
        self.inject_after_login(server_pid, true, &build);

        // Step 4: your game starts at the same time – the server loads the map in the background.
        self.emit_step(4);
        let bubble = launchargs::bubble_builds_active(false, bubble_builds, &build.version);
        if bubble {
            self.remember_perf_mode_ini();
        }
        let game_pid = self.launch_instance(&build, &profile, false, false, bubble_builds)?;
        if bubble {
            self.watch_perf_mode_ini(game_pid);
        }
        self.inject_after_login(game_pid, false, &build);
        self.emit_services();

        // Steps 5/6 in the background: first connect to the control pipe of the server DLL (turn on
        // commands, send playlist/Lategame, unlock "Start match"), then wait until the game server
        // listens on port 7777.
        self.emit_step(5);
        let app = self.app.clone();
        let profile_bg = profile.clone();
        std::thread::spawn(move || {
            let engine = app.state::<Arc<Engine>>();

            // 1) Control pipe – shows up once the server DLL runs (wait up to 4 minutes)
            let (tx, rx) = channel::<ServerEvent>();
            let started = std::time::Instant::now();
            let mut link = None;
            while started.elapsed() < Duration::from_secs(240) {
                if engine.running.lock().unwrap().stopping {
                    return;
                }
                if let Some(l) = ServerLink::connect(tx.clone()) {
                    link = Some(l);
                    break;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            match link {
                Some(link) => {
                    let link = Arc::new(link);
                    engine.running.lock().unwrap().link = Some(link.clone());
                    engine.spawn_server_event_loop(rx);
                    engine.apply_profile_to_server(&link, &profile_bg);
                    engine.log("launcher", "info", CAT, "Connected to the server's control pipe – commands on, playlist and Lategame sent", None);
                    engine.toast(
                        "info",
                        "The server is waiting for you",
                        "Go to Match and press \"Start match\" (or START SERVER in the server window). Then the server loads the map.",
                    );
                }
                None => {
                    engine.log("launcher", "info", CAT, "No control pipe – use the server's own window", None);
                    engine.toast("info", "Server window", "In the server window, pick a playlist and press START SERVER.");
                }
            }

            // 2) Wait for "listening on port 7777" – starting is done by hand, so wait generously (30 minutes)
            let listening = engine.wait_signal(|s| &s.server_listening, Duration::from_secs(1800));
            if engine.running.lock().unwrap().stopping {
                return;
            }
            if !listening {
                engine.toast(
                    "error",
                    "The game server isn't answering",
                    "\"IpNetDriver listening\" is missing from the server log. Check the live log (source: server) and Crashes.",
                );
                return;
            }
            engine.log("launcher", "info", CAT, "The game server is listening on port 7777", None);
            engine.emit_step(6);
            engine.emit_services();
            engine.toast("success", "Server ready", "Press Play in the game – the match runs on 127.0.0.1.");
        });
        Ok(())
    }

    /// Waits (at most `timeout`) for a log signal; gives up when stopping.
    fn wait_signal(&self, pick: impl Fn(&Signals) -> &AtomicBool, timeout: Duration) -> bool {
        let start = std::time::Instant::now();
        while start.elapsed() < timeout {
            if pick(&self.signals).load(Ordering::SeqCst) {
                return true;
            }
            if self.running.lock().unwrap().stopping {
                return false;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        false
    }

    /// Loads the matching DLL into the instance once the log shows the login
    /// (waits at most 3 minutes, then loads it anyway). Runs in its own thread.
    fn inject_after_login(&self, pid: u32, host: bool, build: &BuildInfo) {
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
            let seen = engine.wait_signal(|s| if host { &s.server_login } else { &s.game_login }, Duration::from_secs(180));
            if engine.running.lock().unwrap().stopping {
                return;
            }
            if !seen {
                engine.log(
                    "launcher",
                    "warning",
                    CAT,
                    &format!("{who}: no login seen in the log – loading {dll_name} anyway"),
                    None,
                );
            }
            // short grace period so the engine objects / the lobby world are ready
            std::thread::sleep(Duration::from_secs(delay));
            match proc::load_helper(pid, &dll) {
                Ok(_) => engine.log(if host { "server" } else { "game" }, "info", CAT, &format!("{dll_name} loaded"), None),
                Err(e) => engine.log("launcher", "error", CAT, &format!("Couldn't load {dll_name}: {e}"), None),
            }
        });
    }

    fn spawn_server_event_loop(&self, rx: std::sync::mpsc::Receiver<ServerEvent>) {
        let app = self.app.clone();
        std::thread::spawn(move || {
            let mut was_ready = false;
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
                // Show refused commands as a hint (the server explains why)
                if ev.event == "reply" && ev.rest.get("ok").and_then(|v| v.as_bool()) == Some(false) {
                    let msg = ev.rest.get("message").and_then(|v| v.as_str()).unwrap_or("Command refused").to_string();
                    let _ = app.emit("toast", Toast { kind: "warning".into(), title: "Server".into(), description: msg });
                }
                if ev.event == "matchEnd" {
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
    fn apply_profile_to_server(&self, link: &ServerLink, profile: &Profile) {
        if let Err(e) = link.set_config("bEnableCheats", serde_json::Value::Bool(true)) {
            self.log("launcher", "warning", CAT, &format!("Couldn't turn on commands: {e}"), None);
        }
        if !profile.playlist.is_empty() {
            let _ = link.set_config("playlist", serde_json::Value::String(profile.playlist.clone()));
        }
        let _ = link.set_config("bLateGame", serde_json::Value::Bool(profile.lategame));
    }

    // --- Bubble Builds: read-only check of GameUserSettings.ini ------------------

    /// Before the player's game starts with Bubble Builds: remember the `[D3DRHIPreference]` lines of
    /// Fortnite's GameUserSettings.ini. Only reads. If the file doesn't exist, nothing is remembered.
    fn remember_perf_mode_ini(&self) {
        let snap = perfmode::game_user_settings_path().and_then(|p| perfmode::snapshot(&p));
        *self.perf_mode_ini.lock().unwrap() = snap;
    }

    /// After the player's game closed: if Fortnite saved Performance Mode (ES3.1) as the default,
    /// ask the UI (event `bubble:ini-changed`). The UI asks the user and only calls
    /// `reset_performance_mode_ini` on "Reset".
    fn watch_perf_mode_ini(&self, game_pid: u32) {
        let Some(snap) = self.perf_mode_ini.lock().unwrap().clone() else { return };
        let app = self.app.clone();
        std::thread::spawn(move || {
            // Wait as long as the game runs (also after "Stop": Fortnite may have saved the file earlier)
            while proc::is_running(game_pid) {
                std::thread::sleep(Duration::from_secs(2));
            }
            // give Fortnite a moment to finish writing its settings
            std::thread::sleep(Duration::from_secs(1));
            if perfmode::switched_to_es31(&snap) {
                let engine = app.state::<Arc<Engine>>();
                engine.log("launcher", "warning", CAT, "Fortnite saved Performance Mode as your default (GameUserSettings.ini)", None);
                let _ = app.emit(EVENT_BUBBLE_INI_CHANGED, serde_json::json!({ "path": snap.path.to_string_lossy() }));
            }
        });
    }

    /// Puts back exactly the two remembered lines (nothing else in the file changes).
    pub fn reset_performance_mode_ini(&self) -> Result<(), String> {
        let snap = self
            .perf_mode_ini
            .lock()
            .unwrap()
            .clone()
            .ok_or("There is nothing to reset – Niobium only remembers the setting from the last game with Bubble Builds.")?;
        match perfmode::restore(&snap) {
            Ok(true) => {
                self.log("launcher", "info", CAT, "Performance Mode reset: GameUserSettings.ini has its old lines back", None);
                Ok(())
            }
            Ok(false) => Ok(()),
            Err(e) => Err(format!("Couldn't reset Performance Mode: {e}")),
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
        self.start_backend()?;
        self.set_backend_gameserver(&ip, port);
        self.toast("info", "Join", &format!("Press Play in the game – you'll land on {ip}:{port}."));
        Ok(())
    }

    // --- Stopping ------------------------------------------------------------

    pub fn stop_all(&self) {
        let mut r = self.running.lock().unwrap();
        r.stopping = true;
        r.link = None;
        for inst in [r.game.take(), r.server.take()].into_iter().flatten() {
            let _ = proc::kill(inst.pid);
            close_helpers(&inst.helpers);
        }
        r.step = -1;
        drop(r);
        self.stop_backend();
        let _ = self.app.emit("launch:step", -1);
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

fn wait_backend_health(port: u16, timeout: Duration) -> bool {
    let start = std::time::Instant::now();
    let url = format!("http://127.0.0.1:{port}/niobium/health");
    while start.elapsed() < timeout {
        if let Ok(mut resp) = ureq::get(&url).call() {
            if let Ok(v) = resp.body_mut().read_json::<serde_json::Value>() {
                if v.get("ok").and_then(|b| b.as_bool()) == Some(true) {
                    return true;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    false
}

/// Detection from the log for the UI (kept for later reactions).
#[allow(dead_code)]
fn detection_label(d: Detection) -> &'static str {
    d.label()
}
