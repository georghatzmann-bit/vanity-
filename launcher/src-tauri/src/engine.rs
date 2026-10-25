//! Die Steuerzentrale des Launchers: Backend und Fortnite starten, DLLs laden,
//! Logs live mitlesen, den Game Server über die Pipe steuern.
//!
//! Was auf das echte Spiel zugreift, geht nur unter Windows. Auf anderen Systemen
//! laufen die Prüf-Funktionen (Version, Absturz) trotzdem.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use vanity_core::launchargs;
use vanity_core::logparse::{self, Detection};
use vanity_core::profiles::{Config, Profile};
use vanity_core::version::{self, BuildInfo, Support};

use crate::pipe::{ServerEvent, ServerLink};
use crate::proc;

/// Namen der DLLs (liegen im Ressourcen-Ordner `dlls/`).
const DLL_REDIRECT: &str = "vanity_redirect.dll";
const DLL_SERVER: &str = "vanity_server.dll";
const DLL_CLIENT: &str = "vanity_client.dll";

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

/// Eine laufende Fortnite-Instanz (Server oder Spiel).
struct Instance {
    pid: u32,
    helper_pids: Vec<u32>,
    host: bool,
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

/// Signale aus den Spiel-Logs, auf die der Startablauf wartet (gesetzt in `stream_logs`).
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
}

impl Engine {
    pub fn new(app: AppHandle) -> Self {
        Engine { config: Mutex::new(vanity_core::profiles::load()), running: Mutex::new(Running::default()), signals: Arc::new(Signals::default()), app }
    }

    // --- Pfade ---------------------------------------------------------------

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
        dirs::data_local_dir().unwrap_or_else(|| PathBuf::from(".")).join("Vanity")
    }

    // --- an die Oberfläche melden -------------------------------------------

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

    fn log(&self, source: &str, level: &str, category: &str, message: &str, detected: Option<String>) {
        let now = now_hms();
        let _ = self.app.emit(
            "log:line",
            LogLinePayload {
                source: source.into(),
                level: level.into(),
                category: category.into(),
                message: message.into(),
                detected,
                time: now,
            },
        );
    }

    // --- Backend -------------------------------------------------------------

    pub fn start_backend(&self) -> Result<(), String> {
        {
            let r = self.running.lock().unwrap();
            if r.backend_pid.map(proc::is_running).unwrap_or(false) {
                return Ok(());
            }
        }
        let node = self.node_exe().ok_or("node.exe fehlt im Launcher – bitte neu installieren")?;
        let main = self.backend_main().ok_or("Backend fehlt im Launcher – bitte neu installieren")?;
        let cfg = self.config.lock().unwrap();
        let s = &cfg.settings;
        let bind = if s.share_backend_lan { "0.0.0.0" } else { "127.0.0.1" };
        let data_dir = self.data_local().join("backend");
        let env = vec![
            ("VANITY_BACKEND_PORT".into(), s.backend_port.to_string()),
            ("VANITY_MATCHMAKER_PORT".into(), s.matchmaker_port.to_string()),
            ("VANITY_BIND".into(), bind.to_string()),
            ("VANITY_DATA_DIR".into(), data_dir.to_string_lossy().into_owned()),
            ("VANITY_GAMESERVER".into(), format!("127.0.0.1:{}", s.game_server_port)),
        ];
        let port = s.backend_port;
        drop(cfg);

        self.log("backend", "info", "Vanity", "Starte Backend …", None);
        let pid = proc::start(&main_as_node_arg(&node), &node_args(&main), &env, false, false)
            .or_else(|_| proc::start(&node, &node_args(&main), &env, false, false))?;
        self.running.lock().unwrap().backend_pid = Some(pid);

        // Auf „gesund“ warten (bis zu 20 s)
        if !wait_backend_health(port, Duration::from_secs(20)) {
            return Err("Backend ist nicht hochgekommen (Port belegt?)".into());
        }
        self.log("backend", "info", "Backend", &format!("Backend hört auf 127.0.0.1:{port}"), None);
        self.emit_services();
        Ok(())
    }

    pub fn stop_backend(&self) {
        let pid = self.running.lock().unwrap().backend_pid.take();
        if let Some(pid) = pid {
            let _ = proc::kill(pid);
        }
    }

    /// Setzt das Matchmaker-Ziel im Backend (für Beitreten per IP).
    fn set_backend_gameserver(&self, ip: &str, port: u16) {
        let backend_port = self.config.lock().unwrap().settings.backend_port;
        let body = serde_json::json!({ "ip": ip, "port": port });
        let _ = ureq::post(format!("http://127.0.0.1:{backend_port}/vanity/gameserver"))
            .send_json(body);
    }

    fn set_backend_status(&self, version: &str, hosting: bool, playlist: &str) {
        let backend_port = self.config.lock().unwrap().settings.backend_port;
        let name = self.config.lock().unwrap().settings.player_name.clone();
        let body = serde_json::json!({
            "name": format!("{name}s Server"),
            "hosting": hosting, "playlist": playlist, "version": version
        });
        let _ = ureq::post(format!("http://127.0.0.1:{backend_port}/vanity/status")).send_json(body);
    }

    // --- Spiel starten -------------------------------------------------------

    fn build_for(&self, profile: &Profile) -> Result<BuildInfo, String> {
        let cfg = self.config.lock().unwrap();
        cfg.builds
            .iter()
            .find(|b| b.id == profile.build_id)
            .cloned()
            .ok_or_else(|| "Der Build dieses Profils fehlt – bitte in der Bibliothek hinzufügen".into())
    }

    /// Startet eine Fortnite-Instanz, lädt die Umleitung und liest das Log mit.
    fn launch_instance(&self, build: &BuildInfo, profile: &Profile, host: bool, headless: bool) -> Result<u32, String> {
        if build.support == Support::Unsupported {
            return Err(format!("Version {} ist zu alt für Vanity", build.version));
        }
        if build.support == Support::Experimental {
            self.log("launcher", "warning", "Vanity", &format!("Version {} ist ungetestet – ich versuche es trotzdem", build.version), None);
        }
        let bin = Path::new(&build.binaries);
        let exe = bin.join(version::SHIPPING_EXE);
        if !exe.is_file() {
            return Err(format!("{} nicht gefunden", version::SHIPPING_EXE));
        }

        // Log-Signale dieser Rolle zurücksetzen – `stream_logs` setzt sie neu
        if host {
            self.signals.server_login.store(false, Ordering::SeqCst);
            self.signals.server_listening.store(false, Ordering::SeqCst);
        } else {
            self.signals.game_login.store(false, Ordering::SeqCst);
        }

        // Hilfs-Prozesse pausiert starten (laufen nie – der alte Build prüft nur, ob sie da sind).
        let mut helper_pids = Vec::new();
        for name in [version::LAUNCHER_EXE, version::EAC_EXE] {
            let p = bin.join(name);
            if p.is_file() {
                if let Ok(pid) = proc::start(&p, &[], &[], true, false) {
                    helper_pids.push(pid);
                }
            }
        }

        let env = vec![("OPENSSL_ia32cap".to_string(), "~0x20000000".to_string())];
        let host_name = self.config.lock().unwrap().settings.player_name.clone();
        let player = if host { host_name.as_str() } else { profile.player_name.as_str() };
        let args = launchargs::build(player, host, headless, &profile.launch_args, &build.version);
        let who = if host { "Server-Fortnite" } else { "dein Spiel" };
        self.log("launcher", "info", "Vanity", &format!("Starte {who}: {}", args.join(" ")), None);

        let mut child = proc::start_captured(&exe, &args, &env)?;
        let pid = child.id();
        self.stream_logs(&mut child, host);

        // Umleitung sofort laden
        if let Some(dll) = self.dll_path(DLL_REDIRECT) {
            match proc::load_helper(pid, &dll) {
                Ok(_) => self.log("launcher", "info", "Vanity", "Umleitung geladen", None),
                Err(e) => self.log("launcher", "error", "Vanity", &format!("Umleitung konnte nicht geladen werden: {e}"), None),
            }
        } else {
            return Err("Umleitungs-DLL fehlt im Launcher".into());
        }

        Ok(pid)
    }

    /// Liest stdout/stderr der Instanz zeilenweise und schickt sie an die Oberfläche.
    /// Erkennt wichtige Stellen (Anmeldung, Server bereit, Fehler) und reagiert darauf.
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

    /// Der große Ablauf: Backend + Server + Spiel.
    pub fn host_and_play(&self, profile_id: &str) -> Result<(), String> {
        if cfg!(not(windows)) {
            return Err("Fortnite starten geht nur unter Windows".into());
        }
        let profile = self
            .config
            .lock()
            .unwrap()
            .profiles
            .iter()
            .find(|p| p.id == profile_id)
            .cloned()
            .or_else(|| self.config.lock().unwrap().active_profile().cloned())
            .ok_or("Kein Profil gewählt")?;
        let build = self.build_for(&profile)?;
        let headless = self.config.lock().unwrap().settings.headless_server;

        self.running.lock().unwrap().stopping = false;
        self.emit_step(0);
        self.start_backend().inspect_err(|_| self.emit_step(-1))?;
        self.set_backend_status(&build.version, true, &profile.playlist);

        // Server-Fortnite
        self.emit_step(1);
        let server_pid = self.launch_instance(&build, &profile, true, headless)?;
        self.running.lock().unwrap().server = Some(Instance { pid: server_pid, helper_pids: vec![], host: true });
        self.emit_step(2); // Umleitung ist in launch_instance geladen
        self.emit_services();

        // Schritt 3: Anmeldung des Servers (im Log erkannt) → danach die Server-DLL laden.
        self.emit_step(3);
        self.inject_after_login(server_pid, true, &build);

        // Schritt 4: dein Spiel startet parallel – der Server lädt im Hintergrund die Karte.
        self.emit_step(4);
        let game_pid = self.launch_instance(&build, &profile, false, false)?;
        self.running.lock().unwrap().game = Some(Instance { pid: game_pid, helper_pids: vec![], host: false });
        self.inject_after_login(game_pid, false, &build);
        self.emit_services();

        // Schritt 5/6 im Hintergrund: erst die Steuer-Pipe der Server-DLL verbinden (Playlist/Lategame
        // übertragen, „Match starten“ freischalten), dann warten, bis der Game Server auf Port 7777 hört.
        self.emit_step(5);
        let app = self.app.clone();
        let profile_bg = profile.clone();
        std::thread::spawn(move || {
            let engine = app.state::<Engine>();

            // 1) Steuer-Pipe – erscheint, sobald die Server-DLL läuft (bis 4 Minuten warten)
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
                    engine.log("launcher", "info", "Vanity", "Steuer-Pipe zum Server verbunden – Playlist und Lategame übertragen", None);
                    engine.toast(
                        "info",
                        "Server wartet auf den Start",
                        "Seite Match → „Match starten“ (oder im Server-Fenster START SERVER). Danach lädt der Server die Karte.",
                    );
                }
                None => {
                    engine.log("launcher", "info", "Vanity", "Keine Steuer-Pipe – der Server wird über sein eigenes Fenster bedient", None);
                    engine.toast("info", "Server-Fenster", "Im Fenster „Magnesium“ Playlist wählen und START SERVER drücken.");
                }
            }

            // 2) Auf „hört auf Port 7777“ warten – der Start ist Handarbeit, deshalb großzügig (30 Minuten)
            let listening = engine.wait_signal(|s| &s.server_listening, Duration::from_secs(1800));
            if engine.running.lock().unwrap().stopping {
                return;
            }
            if !listening {
                engine.toast(
                    "error",
                    "Game Server meldet sich nicht",
                    "Im Server-Log fehlt „IpNetDriver listening“. Schau ins Live-Log (Quelle Server) und unter Abstürze.",
                );
                return;
            }
            engine.log("launcher", "info", "Vanity", "Game Server hört auf Port 7777", None);
            engine.emit_step(6);
            engine.emit_services();
            engine.toast("success", "Server bereit", "Drück im Spiel auf „Spielen“ – das Match läuft auf 127.0.0.1.");
        });
        Ok(())
    }

    /// Wartet (höchstens `timeout`) auf ein Log-Signal; bricht ab, wenn gestoppt wird.
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

    /// Lädt die passende DLL in die Instanz, sobald das Log die Anmeldung zeigt
    /// (höchstens 3 Minuten warten, dann trotzdem laden). Läuft in einem eigenen Thread.
    fn inject_after_login(&self, pid: u32, host: bool, build: &BuildInfo) {
        let dll_name = if host { DLL_SERVER } else { DLL_CLIENT };
        let Some(dll) = self.dll_path(dll_name) else {
            self.log(
                "launcher",
                "warning",
                "Vanity",
                &format!("{dll_name} fehlt im Launcher – dieser Teil wird übersprungen"),
                None,
            );
            return;
        };
        let _ = build; // Versions-Sonderfälle (Chapter 1) braucht 19.10 nicht
        let app = self.app.clone();
        std::thread::spawn(move || {
            let engine = app.state::<Engine>();
            let who = if host { "Server" } else { "Spiel" };
            let seen = engine.wait_signal(|s| if host { &s.server_login } else { &s.game_login }, Duration::from_secs(180));
            if engine.running.lock().unwrap().stopping {
                return;
            }
            if !seen {
                engine.log(
                    "launcher",
                    "warning",
                    "Vanity",
                    &format!("{who}: keine Anmeldung im Log erkannt – lade {dll_name} trotzdem"),
                    None,
                );
            }
            // kurze Schonfrist, damit die Lobby-Welt steht
            std::thread::sleep(Duration::from_secs(if host { 3 } else { 6 }));
            match proc::load_helper(pid, &dll) {
                Ok(_) => engine.log(if host { "server" } else { "game" }, "info", "Vanity", &format!("{dll_name} geladen"), None),
                Err(e) => engine.log("launcher", "error", "Vanity", &format!("{dll_name} konnte nicht geladen werden: {e}"), None),
            }
        });
    }

    fn spawn_server_event_loop(&self, rx: std::sync::mpsc::Receiver<ServerEvent>) {
        let app = self.app.clone();
        std::thread::spawn(move || {
            for ev in rx {
                let _ = app.emit("server:event", serde_json::json!({ "event": ev.event, "data": ev.rest }));
                if ev.event == "trickshot" {
                    let _ = app.emit("trickshot", serde_json::Value::Object(ev.rest.clone()));
                }
                // Abgelehnte Befehle als Hinweis zeigen (der Server erklärt, warum)
                if ev.event == "reply" && ev.rest.get("ok").and_then(|v| v.as_bool()) == Some(false) {
                    let msg = ev.rest.get("message").and_then(|v| v.as_str()).unwrap_or("Befehl abgelehnt").to_string();
                    let _ = app.emit("toast", Toast { kind: "warning".into(), title: "Server".into(), description: msg });
                }
                if ev.event == "matchEnd" {
                    let _ = app.emit("toast", Toast { kind: "info".into(), title: "Match beendet".into(), description: "Der Server meldet das Ende der Runde.".into() });
                }
            }
        });
    }

    /// Überträgt die Profil-Einstellungen an den laufenden Server.
    fn apply_profile_to_server(&self, link: &ServerLink, profile: &Profile) {
        if !profile.playlist.is_empty() {
            let _ = link.set_config("playlist", serde_json::Value::String(profile.playlist.clone()));
        }
        let _ = link.set_config("bLateGame", serde_json::Value::Bool(profile.lategame));
    }

    // --- Host-Befehle --------------------------------------------------------

    fn link(&self) -> Result<Arc<ServerLink>, String> {
        self.running.lock().unwrap().link.clone().ok_or("Kein Server verbunden".into())
    }

    pub fn server_exec(&self, text: &str) -> Result<(), String> {
        self.link()?.exec(text).map(|_| ())
    }

    pub fn server_config(&self, key: &str, value: serde_json::Value) -> Result<(), String> {
        self.link()?.set_config(key, value).map(|_| ())
    }

    pub fn server_start_match(&self) -> Result<(), String> {
        self.link()?.start_match().map(|_| ())
    }

    // --- Beitreten -----------------------------------------------------------

    pub fn join_ip(&self, addr: &str) -> Result<(), String> {
        let (ip, port) = split_addr(addr, self.config.lock().unwrap().settings.game_server_port);
        // Dem eigenen Backend sagen, wohin es den Spieler schicken soll, und im Spiel „open“.
        self.start_backend()?;
        self.set_backend_gameserver(&ip, port);
        if let Ok(link) = self.link() {
            let _ = link.exec(&format!("open {ip}"));
        }
        self.toast("info", "Beitreten", &format!("Verbinde mit {ip}:{port} …"));
        Ok(())
    }

    // --- Stoppen -------------------------------------------------------------

    pub fn stop_all(&self) {
        let mut r = self.running.lock().unwrap();
        r.stopping = true;
        r.link = None;
        for inst in [r.game.take(), r.server.take()].into_iter().flatten() {
            let _ = proc::kill(inst.pid);
            for h in inst.helper_pids {
                let _ = proc::kill(h);
            }
        }
        r.step = -1;
        drop(r);
        self.stop_backend();
        let _ = self.app.emit("launch:step", -1);
        self.emit_services();
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
    // einfache lokale Uhrzeit ohne Zusatz-Bibliothek
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

/// Der Aufruf ist `node.exe main.js` – die exe ist node, das Argument die Backend-Datei.
fn node_args(main: &Path) -> Vec<String> {
    vec![main.to_string_lossy().into_owned()]
}
fn main_as_node_arg(node: &Path) -> PathBuf {
    node.to_path_buf()
}

fn wait_backend_health(port: u16, timeout: Duration) -> bool {
    let start = std::time::Instant::now();
    let url = format!("http://127.0.0.1:{port}/vanity/health");
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

/// Erkennung aus dem Log an die Oberfläche (für spätere Reaktionen reserviert).
#[allow(dead_code)]
fn detection_label(d: Detection) -> &'static str {
    d.label()
}
