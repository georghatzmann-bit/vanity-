//! The functions the UI calls (Tauri commands).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

use niobium_core::bots::{self, BotsSupport};
use niobium_core::crash::{self, CrashReport};
use niobium_core::launchargs::{self, BubbleBuildsInfo};
use niobium_core::profiles::{self, Config, Friend, Profile, Settings, TrickshotPreset};
use niobium_core::version::{self, BuildInfo, DetectReport};

use crate::engine::{Engine, LogLinePayload};

type E<'a> = State<'a, Arc<Engine>>;
type R<T> = Result<T, String>;

fn save(engine: &Engine) {
    let cfg = engine.config.lock().unwrap();
    if let Err(e) = profiles::save(&cfg) {
        eprintln!("[Niobium] Couldn't save the settings: {e}");
    }
}

#[tauri::command]
pub fn get_config(engine: E) -> Config {
    engine.config.lock().unwrap().clone()
}

#[tauri::command]
pub fn platform() -> String {
    std::env::consts::OS.to_string()
}

#[tauri::command]
pub fn update_settings(engine: E, settings: Settings) -> R<()> {
    let mut settings = settings;
    // Backend and game server ports are fixed – other values are set back (and noted once in the log)
    let notes = settings.pin_fixed_ports();
    engine.config.lock().unwrap().settings = settings;
    save(&engine);
    engine.note_fixed_ports(notes);
    Ok(())
}

#[tauri::command]
pub fn detect_build(path: String) -> DetectReport {
    version::detect_build(&PathBuf::from(path))
}

#[tauri::command]
pub fn add_build(engine: E, build: BuildInfo) -> Config {
    {
        let mut cfg = engine.config.lock().unwrap();
        cfg.upsert_build(build);
    }
    save(&engine);
    engine.config.lock().unwrap().clone()
}

#[tauri::command]
pub fn remove_build(engine: E, id: String) -> Config {
    engine.config.lock().unwrap().remove_build(&id);
    save(&engine);
    engine.config.lock().unwrap().clone()
}

#[tauri::command]
pub fn add_profile(engine: E, profile: Profile) -> Config {
    engine.config.lock().unwrap().profiles.push(profile);
    save(&engine);
    engine.config.lock().unwrap().clone()
}

#[tauri::command]
pub fn update_profile(engine: E, profile: Profile) -> Config {
    {
        let mut cfg = engine.config.lock().unwrap();
        if let Some(p) = cfg.profiles.iter_mut().find(|p| p.id == profile.id) {
            *p = profile;
        }
    }
    save(&engine);
    engine.config.lock().unwrap().clone()
}

#[tauri::command]
pub fn remove_profile(engine: E, id: String) -> Config {
    {
        let mut cfg = engine.config.lock().unwrap();
        cfg.profiles.retain(|p| p.id != id);
        if cfg.active_profile_id == id {
            cfg.active_profile_id = cfg.profiles.first().map(|p| p.id.clone()).unwrap_or_default();
        }
    }
    save(&engine);
    engine.config.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_active_profile(engine: E, id: String) -> R<()> {
    engine.config.lock().unwrap().active_profile_id = id;
    save(&engine);
    Ok(())
}

#[tauri::command]
pub fn add_friend(engine: E, friend: Friend) -> Config {
    engine.config.lock().unwrap().friends.push(friend);
    save(&engine);
    engine.config.lock().unwrap().clone()
}

#[tauri::command]
pub fn remove_friend(engine: E, id: String) -> Config {
    engine.config.lock().unwrap().friends.retain(|f| f.id != id);
    save(&engine);
    engine.config.lock().unwrap().clone()
}

#[tauri::command]
pub fn list_crashes() -> Vec<CrashReport> {
    crash::list(30)
}

/// Local IP addresses the host can give to friends. The port is always the fixed game server
/// port (7777).
#[tauri::command]
pub fn share_addresses() -> Vec<(String, String)> {
    let port = profiles::GAME_SERVER_PORT;
    let mut out = vec![("This PC only".to_string(), format!("127.0.0.1:{port}"))];
    if let Ok(addrs) = if_addrs::get_if_addrs() {
        for a in addrs {
            if a.is_loopback() {
                continue;
            }
            if let std::net::IpAddr::V4(v4) = a.ip() {
                let o = v4.octets();
                let label = if o[0] == 100 {
                    "Tailscale"
                } else if o[0] == 26 {
                    "Radmin VPN"
                } else {
                    "Network"
                };
                out.push((label.to_string(), format!("{v4}:{port}")));
            }
        }
    }
    out
}

// --- Actions that start something ---------------------------------------------

// The commands that start or stop things run off the main thread (`async`): they wait for the
// `running` lock (held while a process starts) or for the backend, and the window must not freeze
// meanwhile. Their events then also reach the UI in the order they were sent (the "-1" of
// "Stop all" always comes after the last start step).

/// Starts backend + server + game in the background. Progress comes as "launch:step" (0–5 = a
/// start is in progress, 6 = server ready, -1 = idle); problems come as a toast.
/// Refused while a start or Fortnite still runs (e.g. a double click).
#[tauri::command(async)]
pub fn host_and_play(engine: E, profile_id: String) -> R<()> {
    let token = engine.begin_start()?;
    let e = Arc::clone(&engine);
    std::thread::spawn(move || e.host_and_play(token, &profile_id));
    Ok(())
}

/// Stops everything (game, server, helpers, backend). During a start this also cancels the start:
/// nothing more is launched, the timeline goes back to idle (-1), the log says "Start cancelled.".
#[tauri::command(async)]
pub fn stop_all(engine: E) -> R<()> {
    engine.stop_all();
    Ok(())
}

/// "Stop & close" in the "Close Niobium?" dialog: stops everything like "Stop all" (incl. helpers
/// and the backend), then quits Niobium.
#[tauri::command(async)]
pub fn quit_app(app: AppHandle, engine: E) {
    engine.shutdown();
    app.exit(0);
}

/// The UI shows "Close Niobium?" (question `id` from `app:close-requested`). Without this answer
/// Niobium stops everything and closes by itself after a few seconds.
#[tauri::command]
pub fn close_prompt_shown(engine: E, id: u64) {
    engine.close_prompt_shown(id);
}

#[tauri::command(async)]
pub fn join_ip(engine: E, address: String) -> R<()> {
    engine.join_ip(&address)
}

#[tauri::command]
pub fn server_exec(engine: E, text: String) -> R<()> {
    engine.server_exec(&text)
}

#[tauri::command]
pub fn server_config(engine: E, key: String, value: serde_json::Value) -> R<()> {
    engine.server_config(&key, value)
}

#[tauri::command]
pub fn server_start_match(engine: E) -> R<()> {
    engine.server_start_match()
}

#[tauri::command]
pub fn spawn_bots(engine: E, count: u32) -> R<()> {
    engine.server_exec(&format!("spawnbot {count}"))
}

#[tauri::command]
pub fn remove_bots(engine: E) -> R<()> {
    engine.server_exec("delbot")
}

#[tauri::command]
pub fn set_trickshot_presets(engine: E, presets: Vec<TrickshotPreset>) -> Config {
    let mut c = engine.config.lock().unwrap();
    c.trickshot_presets = presets;
    let _ = profiles::save(&c);
    c.clone()
}

// --- Settings of the in-game menu (client.json, also read by the client DLL) ------------

fn client_settings_path() -> PathBuf {
    profiles::config_dir().join("client.json")
}

fn default_client_settings() -> serde_json::Value {
    // Same format as the in-game menu DLL (based on ATLAS Console) – both read/write the same file.
    serde_json::json!({
        "hotkey": 120,       // F9 – menu
        "joinHotkey": 116,   // F5 – quick join
        "consoleMode": 0,    // 0 = Niobium console, 1 = original Unreal console
        "preferences": {
            "saveTogglePreferences": true, "slashKey": true,
            "editOnRelease": true, "resetOnRelease": true, "disablePreEdits": true,
            "mobileBuilds": false, "inGameFog": true, "firstPerson": false,
            "sprintByDefault": false, "respawnsEnabled": true
        },
        "commands": [], "macros": []
    })
}

/// "Always sprint" was removed: it is off for everyone. The key stays in client.json (older
/// files keep loading, and the menu DLL finds it), but it is always read and written as `false`.
fn force_sprint_off(value: &mut serde_json::Value) {
    if let Some(serde_json::Value::Object(prefs)) = value.get_mut("preferences") {
        prefs.insert("sprintByDefault".into(), serde_json::Value::Bool(false));
    }
}

#[tauri::command]
pub fn get_client_settings() -> serde_json::Value {
    let mut value = default_client_settings();
    if let Ok(bytes) = std::fs::read(client_settings_path()) {
        if let Ok(serde_json::Value::Object(saved)) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            if let serde_json::Value::Object(base) = &mut value {
                for (k, v) in saved {
                    if k == "preferences" {
                        // take over field by field, so missing switches keep their default
                        if let (Some(serde_json::Value::Object(defaults)), serde_json::Value::Object(saved_prefs)) =
                            (base.get_mut("preferences"), v)
                        {
                            for (pk, pv) in saved_prefs {
                                defaults.insert(pk, pv);
                            }
                        }
                        continue;
                    }
                    base.insert(k, v);
                }
            }
        }
    }
    force_sprint_off(&mut value);
    value
}

#[tauri::command]
pub fn set_client_settings(value: serde_json::Value) -> R<()> {
    let mut value = value;
    force_sprint_off(&mut value);
    let path = client_settings_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Folders the UI shows (Settings / Logs): config, logs, Fortnite crash reports and logs.
#[tauri::command]
pub fn niobium_paths() -> serde_json::Value {
    let local = profiles::local_dir();
    serde_json::json!({
        "config": profiles::config_dir().to_string_lossy(),
        "logs": local.join("logs").to_string_lossy(),
        "crashes": crash::crashes_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        "fortniteLogs": dirs::data_local_dir().unwrap_or_default().join("FortniteGame").join("Saved").join("Logs").to_string_lossy(),
    })
}

// --- Splash screen -----------------------------------------------------------------

static MAIN_SHOWN: AtomicBool = AtomicBool::new(false);

/// How long after the main window shows the start log lines still wait for `pending_log_lines`.
/// After that they are sent as normal "log:line" events (in case the UI never asks).
const EARLY_LOG_FALLBACK: Duration = Duration::from_secs(10);

/// Shows and focuses the main window and closes the splash. Only the first call does anything
/// (the UI calls it, and the safety net in `lib.rs` calls it again after 8 s).
pub fn show_main_window(app: &AppHandle) {
    if MAIN_SHOWN.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
    // Log lines from the start (e.g. the note about copied Vanity settings) wait for the UI to
    // fetch them with `pending_log_lines`. Safety net if it never does: send them as events later.
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(EARLY_LOG_FALLBACK);
        if let Some(engine) = handle.try_state::<Arc<Engine>>() {
            engine.release_early_log();
        }
    });
}

/// Launcher log lines written before the UI listened to "log:line" (e.g. "Copied your settings
/// from Vanity to Niobium …", "Backend port is fixed at 3551 …"), oldest first. The UI calls this
/// once, right after its "log:line" listener is registered. From then on every line comes as a
/// "log:line" event; later calls return an empty list.
#[tauri::command]
pub fn pending_log_lines(engine: E) -> Vec<LogLinePayload> {
    engine.pending_log_lines()
}

/// The UI has loaded its config and drawn the first frame.
#[tauri::command]
pub fn app_ready(app: AppHandle) {
    show_main_window(&app);
}

// --- Bubble Builds -------------------------------------------------------------------

/// `{ level: "supported" | "experimental" | "unavailable", note }` for a Fortnite version.
#[tauri::command]
pub fn bubble_builds_support(version: String) -> BubbleBuildsInfo {
    launchargs::bubble_builds_support(&version)
}

/// Puts the two remembered `[D3DRHIPreference]` lines back into Fortnite's GameUserSettings.ini
/// (only after the user clicked "Reset" on the "bubble:ini-changed" question).
#[tauri::command]
pub fn reset_performance_mode_ini(engine: E) -> R<()> {
    engine.reset_performance_mode_ini()
}

// --- AI bots ---------------------------------------------------------------------------

/// `{ level: "experimental" | "unavailable", note }` for a Fortnite version and changelist.
/// Only 19.10-CL-18675304 is "experimental".
#[tauri::command]
pub fn bots_support(version: String, cl: Option<u32>) -> BotsSupport {
    bots::bots_support(&version, cl)
}
