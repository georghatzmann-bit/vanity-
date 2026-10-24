//! Die Funktionen, die die Oberfläche aufruft (Tauri-Commands).

use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

use vanity_core::crash::{self, CrashReport};
use vanity_core::profiles::{self, Config, Friend, Profile, Settings};
use vanity_core::version::{self, BuildInfo, DetectReport};

use crate::engine::Engine;
use vanity_core::profiles::TrickshotPreset;

type E<'a> = State<'a, Arc<Engine>>;
type R<T> = Result<T, String>;

fn save(engine: &Engine) {
    let cfg = engine.config.lock().unwrap();
    if let Err(e) = profiles::save(&cfg) {
        eprintln!("[Vanity] Einstellungen konnten nicht gespeichert werden: {e}");
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
    engine.config.lock().unwrap().settings = settings;
    save(&engine);
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

/// Lokale IP-Adressen, die der Host an Freunde weitergeben kann.
#[tauri::command]
pub fn share_addresses(engine: E) -> Vec<(String, String)> {
    let port = engine.config.lock().unwrap().settings.game_server_port;
    let mut out = vec![("Nur dieser PC".to_string(), format!("127.0.0.1:{port}"))];
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
                    "Netzwerk"
                };
                out.push((label.to_string(), format!("{v4}:{port}")));
            }
        }
    }
    out
}

// --- Aktionen, die etwas starten ---------------------------------------------

#[tauri::command]
pub fn host_and_play(engine: E, profile_id: String) -> R<()> {
    let e = Arc::clone(&engine);
    std::thread::spawn(move || {
        if let Err(err) = e.host_and_play(&profile_id) {
            let _ = tauri::Emitter::emit(&e.app, "toast", crate::engine::Toast {
                kind: "error".into(), title: "Start fehlgeschlagen".into(), description: err,
            });
            e.stop_all();
        }
    });
    Ok(())
}

#[tauri::command]
pub fn stop_all(engine: E) -> R<()> {
    engine.stop_all();
    Ok(())
}

#[tauri::command]
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

// --- Einstellungen des Ingame-Menüs (client.json, auch von der Client-DLL gelesen) ------------

fn client_settings_path() -> PathBuf {
    profiles::config_dir().join("client.json")
}

fn default_client_settings() -> serde_json::Value {
    // Gleiches Format wie die Ingame-Menü-DLL (ATLAS-Console-Basis) – beide lesen/schreiben dieselbe Datei.
    serde_json::json!({
        "hotkey": 120,       // F9 – Menü
        "joinHotkey": 116,   // F5 – schnell beitreten
        "consoleMode": 0,    // 0 = Vanity-Konsole, 1 = Original-Unreal-Konsole
        "preferences": {
            "saveTogglePreferences": true, "slashKey": true,
            "editOnRelease": true, "resetOnRelease": true, "disablePreEdits": true,
            "mobileBuilds": false, "inGameFog": true, "firstPerson": false,
            "sprintByDefault": true, "respawnsEnabled": true
        },
        "commands": [], "macros": []
    })
}

#[tauri::command]
pub fn get_client_settings() -> serde_json::Value {
    let mut value = default_client_settings();
    if let Ok(bytes) = std::fs::read(client_settings_path()) {
        if let Ok(serde_json::Value::Object(saved)) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            if let serde_json::Value::Object(base) = &mut value {
                for (k, v) in saved {
                    if k == "preferences" {
                        // feldweise übernehmen, damit fehlende Schalter ihre Vorgabe behalten
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
    value
}

#[tauri::command]
pub fn set_client_settings(value: serde_json::Value) -> R<()> {
    let path = client_settings_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vanity_paths() -> serde_json::Value {
    let local = dirs::data_local_dir().unwrap_or_default().join("Vanity");
    serde_json::json!({
        "config": profiles::config_dir().to_string_lossy(),
        "logs": local.join("logs").to_string_lossy(),
        "crashes": crash::crashes_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        "fortniteLogs": dirs::data_local_dir().unwrap_or_default().join("FortniteGame").join("Saved").join("Logs").to_string_lossy(),
    })
}
