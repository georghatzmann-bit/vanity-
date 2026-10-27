//! The functions the UI calls (Tauri commands).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

use niobium_core::bots::{self, BotsLevel, BotsSupport};
use niobium_core::friends::{self as fr, HostInfo, Invite, JoinTarget, ShareAddress, VersionMatch};
use niobium_core::crash::{self, CrashReport};
use niobium_core::launchargs::{self, BubbleBuildsInfo};
use niobium_core::profiles::{self, Config, Friend, Profile, Settings, TrickshotPreset};
use niobium_core::version::{self, BuildInfo, DetectReport};

use crate::engine::{Engine, JoinStarted, LogLinePayload, Toast};
use crate::firewall::{self, FirewallStatus};
use crate::friends::{fetch_host_info, local_interfaces, HostCheckError};

type E<'a> = State<'a, Arc<Engine>>;
type R<T> = Result<T, String>;

fn save(engine: &Engine) {
    let cfg = engine.config.lock().unwrap();
    if let Err(e) = profiles::save(&cfg) {
        eprintln!("[Rift] Couldn't save the settings: {e}");
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
    let window_changed = {
        let mut cfg = engine.config.lock().unwrap();
        let changed = cfg.settings.show_server_window != settings.show_server_window;
        cfg.settings = settings;
        changed
    };
    save(&engine);
    engine.note_fixed_ports(notes);
    if window_changed {
        // A running server shows or hides its window right away.
        engine.apply_server_window_setting();
    }
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

/// Addresses the host can give to friends, best first (VPN before home network), plus "This PC
/// only". The port is always the fixed game server port (7777).
#[tauri::command]
pub fn share_addresses() -> Vec<(String, String)> {
    let port = profiles::GAME_SERVER_PORT;
    let mut out = vec![("This PC only".to_string(), format!("127.0.0.1:{port}"))];
    out.extend(fr::share_list(&local_interfaces()).into_iter().map(|a| (a.label, format!("{}:{port}", a.ip))));
    out
}

/// The host's "Invite friends" card.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteInfo {
    /// `RIFT1:…` (None when something is missing, see `problem`)
    pub code: Option<String>,
    /// What "Copy invite" copies: summary · Fortnite version · code
    pub text: Option<String>,
    /// "Squad together · bots on · Lategame"
    pub summary: String,
    pub address: Option<ShareAddress>,
    pub others: Vec<ShareAddress>,
    pub version: Option<String>,
    pub cl: Option<u32>,
    /// Why there is no invite (no build, no VPN address)
    pub problem: Option<String>,
    /// A warning that still allows the invite (home network only)
    pub hint: Option<String>,
}

#[tauri::command]
pub fn invite_info(engine: E) -> InviteInfo {
    let (profile, build) = {
        let cfg = engine.config.lock().unwrap();
        let profile = cfg.active_profile().cloned();
        let build = profile.as_ref().and_then(|p| cfg.builds.iter().find(|b| b.id == p.build_id).cloned());
        (profile, build)
    };
    let mut list = fr::share_list(&local_interfaces());
    let mut info = InviteInfo { code: None, text: None, summary: String::new(), address: None, others: vec![], version: None, cl: None, problem: None, hint: None };
    let (Some(profile), Some(build)) = (profile, build) else {
        info.problem = Some("Pick a profile with a Fortnite build first (Library → Add a build).".into());
        return info;
    };
    let bots_on = profile.bots && bots::bots_support(&build.version, build.changelist).level == BotsLevel::Experimental;
    let mode = fr::invite_mode(profile.friends_together, &profile.playlist);
    info.summary = fr::match_summary(&mode, bots_on, profile.lategame);
    info.version = Some(build.version.clone());
    info.cl = build.changelist;
    if list.is_empty() {
        info.problem = Some(
            "No VPN address found. Install Tailscale or Radmin VPN, join the same network as your friend, then press Refresh.".into(),
        );
        return info;
    }
    let best = list.remove(0);
    if !best.kind.is_vpn() {
        info.hint = Some("This is your home network address. It only works for friends in the same house – for friends elsewhere, use Tailscale or Radmin VPN.".into());
    }
    let invite = Invite {
        ip: best.ip.clone(),
        port: profiles::GAME_SERVER_PORT,
        version: build.version.clone(),
        cl: build.changelist,
        mode: Some(mode),
        bots: bots_on,
        lategame: profile.lategame,
    };
    info.code = Some(invite.to_code());
    info.text = Some(invite.share_text());
    info.address = Some(best);
    info.others = list;
    info
}

/// The friend's check before joining (see `check_join`).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinCheck {
    /// "ready", "starting", "badInput", "wrongVersion", "notHosting", "notReachable", "matchStarted"
    pub status: String,
    /// true = join now
    pub ok: bool,
    pub title: String,
    pub detail: String,
    pub ip: String,
    pub port: u16,
    /// The host's Fortnite (from the host's Rift, else from the invite)
    pub version: Option<String>,
    pub cl: Option<u32>,
    /// "Squad together · bots on · Lategame" from the invite ("" for a plain address)
    pub summary: String,
    pub host: Option<HostInfo>,
    /// The Library build to start for this join
    pub build_id: Option<String>,
    /// Catalog key when the needed build can be downloaded
    pub download_key: Option<String>,
    /// Joining may still work although the check failed (offer "Join anyway")
    pub join_anyway: bool,
}

fn fortnite_name(version: &str, cl: Option<u32>) -> String {
    match cl {
        Some(cl) => format!("Fortnite {version} (CL {cl})"),
        None => format!("Fortnite {version}"),
    }
}

/// Reads the pasted invite or address, asks the host's Rift (3 s) and looks for the same Fortnite
/// in the Library – before anything starts. Plain English for every outcome.
#[tauri::command(async)]
pub fn check_join(engine: E, text: String) -> JoinCheck {
    let mut c = JoinCheck {
        status: "badInput".into(),
        ok: false,
        title: String::new(),
        detail: String::new(),
        ip: String::new(),
        port: profiles::GAME_SERVER_PORT,
        version: None,
        cl: None,
        summary: String::new(),
        host: None,
        build_id: None,
        download_key: None,
        join_anyway: false,
    };
    let target = match fr::parse_join_input(&text) {
        Ok(t) => t,
        Err(e) => {
            c.title = "That isn't an invite".into();
            c.detail = e;
            return c;
        }
    };
    c.ip = target.ip().to_string();
    c.port = target.port();
    if let JoinTarget::Invite(i) = &target {
        c.version = Some(i.version.clone());
        c.cl = i.cl;
        c.summary = i.summary();
    }
    if c.ip == "127.0.0.1" {
        c.status = "ready".into();
        c.ok = true;
        c.title = "Your own server".into();
        c.detail = "Joins the server on this PC.".into();
        return c;
    }
    let host = fetch_host_info(&c.ip);
    if let Ok(h) = &host {
        // The host's Rift knows best (the host may have switched builds since copying the invite)
        c.cl = h.cl.or(if c.version.as_deref().is_some_and(|v| fr::same_version(v, &h.version)) { c.cl } else { None });
        c.version = Some(h.version.clone());
        c.port = h.port;
        c.host = Some(h.clone());
    }
    let unreachable = |c: &mut JoinCheck, e: HostCheckError| {
        c.join_anyway = true;
        if e == HostCheckError::Refused {
            c.status = "notHosting".into();
            c.title = "Your friend isn't hosting right now".into();
            c.detail = format!("{} answered, but Rift there isn't hosting. Ask your friend to press Host & Play, then check again.", c.ip);
        } else {
            c.status = "notReachable".into();
            c.title = "Can't reach your friend's PC".into();
            c.detail = format!(
                "No answer from {}. Check that you're both connected to the same Tailscale or Radmin VPN network, that your friend pressed Host & Play, and that your friend pressed \"Allow friends to connect\" in Rift.",
                c.ip
            );
        }
    };
    let Some(version) = c.version.clone() else {
        // Plain address and no answer: nothing to check the version against
        if let Err(e) = host {
            unreachable(&mut c, e);
            c.detail.push_str(" You can still try to join.");
        }
        return c;
    };
    let builds = engine.config.lock().unwrap().builds.clone();
    match fr::match_build(&builds, &version, c.cl) {
        VersionMatch::Missing => {
            c.status = "wrongVersion".into();
            c.download_key = fr::download_key_for(&niobium_core::epic::catalog::catalog(), &version, c.cl);
            c.title = format!("You need {}", fortnite_name(&version, c.cl));
            c.detail = format!(
                "Your friend plays {}. It isn't in your Library yet.{}",
                fortnite_name(&version, c.cl),
                if c.download_key.is_some() { " Rift can download it for you." } else { " Ask your friend where they got it, then add it in the Library." }
            );
            return c;
        }
        VersionMatch::OtherCl { have_cl, .. } => {
            c.status = "wrongVersion".into();
            c.download_key = fr::download_key_for(&niobium_core::epic::catalog::catalog(), &version, c.cl);
            c.title = format!("You need {}", fortnite_name(&version, c.cl));
            c.detail = format!(
                "Your friend plays {}, but your {version} is another build{}. Both of you need the exact same build.",
                fortnite_name(&version, c.cl),
                have_cl.map(|cl| format!(" (CL {cl})")).unwrap_or_default()
            );
            return c;
        }
        VersionMatch::Same { build_id, .. } => c.build_id = Some(build_id),
    }
    let host = match host {
        Ok(h) => h,
        Err(e) => {
            unreachable(&mut c, e);
            c.detail.push_str(&format!(" Your {version} matches the invite, so you can still try to join."));
            return c;
        }
    };
    let players = match host.players {
        1 => "1 player".to_string(),
        n => format!("{n} players"),
    };
    match host.phase.as_str() {
        "started" | "ended" => {
            c.status = "matchStarted".into();
            c.join_anyway = true;
            c.title = "The match already started".into();
            c.detail = "Your friend's match is running, so you may not get in. Ask your friend to start a new match (Stop all, then Host & Play).".into();
        }
        "starting" => {
            c.status = "starting".into();
            c.ok = true;
            c.title = format!("Host found: Fortnite {}", host.version);
            c.detail = format!("Your Fortnite {version} matches. Your friend's server is still loading – press Play once your lobby shows.");
        }
        _ => {
            c.status = "ready".into();
            c.ok = true;
            c.title = format!("Host found: Fortnite {}", host.version);
            c.detail = format!("Your Fortnite {version} matches – joining now ({players} waiting).");
        }
    }
    c
}

/// "Join" (after `check_join`, or "Join anyway"): starts your game if needed, with `build_id`.
#[tauri::command(async)]
pub fn join_game(engine: E, ip: String, port: u16, build_id: Option<String>) -> R<JoinStarted> {
    let target = fr::parse_join_input(&format!("{ip}:{port}"))?;
    engine.join_game(target.ip(), target.port(), build_id.as_deref())
}

/// The game file of the active profile's build (for the firewall rule).
fn active_game_exe(engine: &Engine) -> Result<String, String> {
    let cfg = engine.config.lock().unwrap();
    let build = cfg
        .active_profile()
        .and_then(|p| cfg.builds.iter().find(|b| b.id == p.build_id))
        .ok_or("Pick a profile with a Fortnite build first.")?;
    let exe = std::path::Path::new(&build.binaries).join(version::SHIPPING_EXE);
    if !exe.is_file() {
        return Err(format!("{} wasn't found in the build's folder.", version::SHIPPING_EXE));
    }
    Ok(exe.to_string_lossy().into_owned())
}

/// "Can friends reach me?" – read-only.
#[tauri::command(async)]
pub fn firewall_status(engine: E) -> FirewallStatus {
    let exe = match active_game_exe(&engine) {
        Ok(e) => e,
        Err(detail) => return FirewallStatus { state: "unknown".into(), detail, ..Default::default() },
    };
    let ip = fr::share_list(&local_interfaces()).into_iter().next().map(|a| a.ip);
    let Some(ip) = ip else {
        return FirewallStatus {
            state: "unknown".into(),
            detail: "No VPN or home network address yet – connect Tailscale or Radmin VPN first.".into(),
            ..Default::default()
        };
    };
    firewall::status(&exe, &ip)
}

/// "Allow friends to connect" – only ever on the user's click; Windows asks first (UAC).
#[tauri::command(async)]
pub fn firewall_allow(engine: E) -> R<FirewallStatus> {
    let exe = active_game_exe(&engine)?;
    firewall::allow(&exe)?;
    engine.log_line("info", "Windows Firewall: \"Rift game server\" and \"Rift host check\" rules added (Allow friends to connect).");
    engine.restart_host_info();
    Ok(firewall_status(engine))
}

/// "Remove the rule" – only on the user's click; Windows asks first (UAC).
#[tauri::command(async)]
pub fn firewall_remove(engine: E) -> R<FirewallStatus> {
    firewall::remove()?;
    engine.log_line("info", "Windows Firewall: Rift's rules removed.");
    Ok(firewall_status(engine))
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

/// "Stop & close" in the "Close Rift?" dialog: stops everything like "Stop all" (incl. helpers
/// and the backend), then quits Rift.
#[tauri::command(async)]
pub fn quit_app(app: AppHandle, engine: E) {
    engine.shutdown();
    app.exit(0);
}

/// The UI shows "Close Rift?" (question `id` from `app:close-requested`). Without this answer
/// Rift stops everything and closes by itself after a few seconds.
#[tauri::command]
pub fn close_prompt_shown(engine: E, id: u64) {
    engine.close_prompt_shown(id);
}

/// Join by an address or invite without the check (F9 settings page "Join"): your own build.
#[tauri::command(async)]
pub fn join_ip(engine: E, address: String) -> R<JoinStarted> {
    let target = fr::parse_join_input(&address)?;
    engine.join_game(target.ip(), target.port(), None)
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
        "consoleMode": 0,    // 0 = Rift console, 1 = original Unreal console
        "preferences": {
            "saveTogglePreferences": true, "slashKey": true,
            "editOnRelease": true, "resetOnRelease": true, "disablePreEdits": true,
            "mobileBuilds": false, "inGameFog": true, "firstPerson": false,
            "sprintByDefault": false, "respawnsEnabled": true,
            "bubbleLook": false, "bubbleStrength": 5,
            "resetBuilds": false, "resetBuildsKey": 0
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
    // Log lines from the start (e.g. the note about settings copied from Niobium) wait for the UI to
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
/// from Niobium to Rift …", "Backend port is fixed at 3551 …"), oldest first. The UI calls this
/// once, right after its "log:line" listener is registered. From then on every line comes as a
/// "log:line" event; later calls return an empty list.
#[tauri::command]
pub fn pending_log_lines(engine: E) -> Vec<LogLinePayload> {
    engine.pending_log_lines()
}

/// Toasts sent before the UI listened to "toast" (e.g. "Fortnite's graphics settings were put
/// back." right at start), oldest first. The UI calls this once, right after its "toast" listener
/// is registered; later calls return an empty list.
#[tauri::command]
pub fn pending_toasts(engine: E) -> Vec<Toast> {
    engine.pending_toasts()
}

/// The UI has loaded its config and drawn the first frame.
#[tauri::command]
pub fn app_ready(app: AppHandle) {
    show_main_window(&app);
}

// --- Bubble Builds -------------------------------------------------------------------

/// `{ level: "supported" | "experimental" | "lowMeshes" | "unavailable", note }` for a Fortnite
/// version. Fortnite's own settings file is backed up and put back by the engine on its own
/// (`Engine::gus_prepare`), so there is no command for it.
#[tauri::command]
pub fn bubble_builds_support(version: String) -> BubbleBuildsInfo {
    launchargs::bubble_builds_support(&version)
}

// --- AI bots ---------------------------------------------------------------------------

/// `{ level: "experimental" | "unavailable", note }` for a Fortnite version and changelist.
/// Only 19.10-CL-18675304 is "experimental".
#[tauri::command]
pub fn bots_support(version: String, cl: Option<u32>) -> BotsSupport {
    bots::bots_support(&version, cl)
}
