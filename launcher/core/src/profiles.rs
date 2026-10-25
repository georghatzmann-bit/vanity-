//! Einstellungen, Profile, Builds und Freunde – gespeichert in `%APPDATA%\Vanity\config.json`.
//!
//! Der ganze Zustand liegt in einer Datei. Geschrieben wird über eine temporäre Datei,
//! die danach umbenannt wird – so kann ein abgebrochener Schreibvorgang die Datei nicht zerstören.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::version::BuildInfo;

pub const PORT_BACKEND_DEFAULT: u16 = 3551;
pub const PORT_MATCHMAKER_DEFAULT: u16 = 80;
pub const PORT_GAMESERVER_DEFAULT: u16 = 7777;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub build_id: String,
    #[serde(default = "default_player")]
    pub player_name: String,
    #[serde(default = "default_args")]
    pub launch_args: String,
    #[serde(default = "yes")]
    pub headless_server: bool,
    #[serde(default)]
    pub playlist: String,
    #[serde(default)]
    pub lategame: bool,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Friend {
    pub id: String,
    pub name: String,
    pub address: String,
    #[serde(default)]
    pub via: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_player")]
    pub player_name: String,
    #[serde(default = "default_args")]
    pub launch_args: String,
    #[serde(default = "yes")]
    pub headless_server: bool,
    #[serde(default)]
    pub auto_restart: bool,
    #[serde(default = "PORT_BACKEND_DEFAULT_fn")]
    pub backend_port: u16,
    #[serde(default = "PORT_MATCHMAKER_DEFAULT_fn")]
    pub matchmaker_port: u16,
    #[serde(default = "PORT_GAMESERVER_DEFAULT_fn")]
    pub game_server_port: u16,
    #[serde(default)]
    pub share_backend_lan: bool,
    #[serde(default = "yes")]
    pub glass: bool,
    #[serde(default)]
    pub reduce_motion: bool,
    #[serde(default = "yes")]
    pub animated_background: bool,
}

#[allow(non_snake_case)]
fn PORT_BACKEND_DEFAULT_fn() -> u16 {
    PORT_BACKEND_DEFAULT
}
#[allow(non_snake_case)]
fn PORT_MATCHMAKER_DEFAULT_fn() -> u16 {
    PORT_MATCHMAKER_DEFAULT
}
#[allow(non_snake_case)]
fn PORT_GAMESERVER_DEFAULT_fn() -> u16 {
    PORT_GAMESERVER_DEFAULT
}
fn default_player() -> String {
    "Player".into()
}
fn default_args() -> String {
    "-d3d11".into()
}
fn yes() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            player_name: default_player(),
            launch_args: default_args(),
            headless_server: true,
            auto_restart: false,
            backend_port: PORT_BACKEND_DEFAULT,
            matchmaker_port: PORT_MATCHMAKER_DEFAULT,
            game_server_port: PORT_GAMESERVER_DEFAULT,
            share_backend_lan: false,
            glass: true,
            reduce_motion: false,
            animated_background: true,
        }
    }
}

/// Ein Trickshot-Preset: Name + Server-Befehle, die nacheinander an den Game Server gehen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrickshotPreset {
    pub name: String,
    #[serde(default)]
    pub commands: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default = "config_version")]
    pub config_version: u32,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub builds: Vec<BuildInfo>,
    #[serde(default)]
    pub profiles: Vec<Profile>,
    #[serde(default)]
    pub active_profile_id: String,
    #[serde(default)]
    pub friends: Vec<Friend>,
    #[serde(default)]
    pub trickshot_presets: Vec<TrickshotPreset>,
}

fn config_version() -> u32 {
    1
}

impl Default for Config {
    fn default() -> Self {
        Config {
            config_version: 1,
            settings: Settings::default(),
            builds: vec![],
            profiles: vec![],
            active_profile_id: String::new(),
            friends: vec![],
            trickshot_presets: Vec::new(),
        }
    }
}

impl Config {
    /// Fügt einen Build hinzu oder aktualisiert ihn (gleiche id) und legt bei Bedarf ein Standardprofil an.
    pub fn upsert_build(&mut self, build: BuildInfo) {
        let id = build.id.clone();
        if let Some(existing) = self.builds.iter_mut().find(|b| b.id == id) {
            *existing = build;
        } else {
            self.builds.push(build);
        }
        if self.profiles.is_empty() {
            let p = Profile {
                id: "p-standard".into(),
                name: "Standard".into(),
                description: "Normales Match auf deinem eigenen Server".into(),
                build_id: id.clone(),
                player_name: self.settings.player_name.clone(),
                launch_args: self.settings.launch_args.clone(),
                headless_server: true,
                playlist: "Playlist_DefaultSolo".into(),
                lategame: false,
                tags: vec!["Solo".into()],
            };
            self.active_profile_id = p.id.clone();
            self.profiles.push(p);
        }
    }

    pub fn remove_build(&mut self, id: &str) {
        self.builds.retain(|b| b.id != id);
    }

    pub fn active_profile(&self) -> Option<&Profile> {
        self.profiles
            .iter()
            .find(|p| p.id == self.active_profile_id)
            .or_else(|| self.profiles.first())
    }
}

pub fn config_dir() -> PathBuf {
    dirs::config_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Vanity")
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

pub fn load() -> Config {
    load_from(&config_path())
}

pub fn load_from(path: &Path) -> Config {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|_| {
            // Kaputte Datei nicht verlieren: zur Seite legen, mit Standard weitermachen
            let _ = fs::rename(path, path.with_extension("json.broken"));
            Config::default()
        }),
        Err(_) => Config::default(),
    }
}

pub fn save(config: &Config) -> std::io::Result<()> {
    save_to(&config_path(), config)
}

pub fn save_to(path: &Path, config: &Config) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_vec_pretty(config).map_err(std::io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &json)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::version::{BuildInfo, Support};

    fn build(id: &str) -> BuildInfo {
        BuildInfo {
            id: id.into(),
            version: "19.10".into(),
            changelist: Some(18675304),
            season: "Chapter 3 · Season 1".into(),
            engine: "Unreal Engine 5.0".into(),
            path: "C:/x".into(),
            binaries: "C:/x/bin".into(),
            support_note: String::new(),
            support: Support::Supported,
            launch_args: "-d3d11".into(),
        }
    }

    #[test]
    fn defaults_are_sensible() {
        let c = Config::default();
        assert_eq!(c.settings.backend_port, 3551);
        assert_eq!(c.settings.matchmaker_port, 80);
        assert!(c.settings.glass);
        assert!(c.profiles.is_empty());
    }

    #[test]
    fn first_build_creates_default_profile() {
        let mut c = Config::default();
        c.upsert_build(build("19.10-18675304"));
        assert_eq!(c.builds.len(), 1);
        assert_eq!(c.profiles.len(), 1);
        assert_eq!(c.active_profile().unwrap().name, "Standard");
        // Zweiter Build legt kein zweites Profil an
        c.upsert_build(build("19.40-0"));
        assert_eq!(c.builds.len(), 2);
        assert_eq!(c.profiles.len(), 1);
    }

    #[test]
    fn upsert_replaces_same_id() {
        let mut c = Config::default();
        c.upsert_build(build("x"));
        let mut b2 = build("x");
        b2.path = "D:/other".into();
        c.upsert_build(b2);
        assert_eq!(c.builds.len(), 1);
        assert_eq!(c.builds[0].path, "D:/other");
    }

    #[test]
    fn save_and_load_roundtrip() {
        let dir = std::env::temp_dir().join(format!("vanity-cfg-{}", std::process::id()));
        let path = dir.join("config.json");
        let mut c = Config::default();
        c.settings.player_name = "georg".into();
        c.upsert_build(build("19.10-18675304"));
        save_to(&path, &c).unwrap();
        let loaded = load_from(&path);
        assert_eq!(loaded.settings.player_name, "georg");
        assert_eq!(loaded.builds.len(), 1);
        assert_eq!(loaded.active_profile().unwrap().id, "p-standard");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_fields_fill_defaults() {
        let c: Config = serde_json::from_str(r#"{"settings":{"playerName":"x"}}"#).unwrap();
        assert_eq!(c.settings.player_name, "x");
        assert_eq!(c.settings.backend_port, 3551);
        assert!(c.settings.animated_background);
    }

    #[test]
    fn broken_file_does_not_crash() {
        let dir = std::env::temp_dir().join(format!("vanity-broken-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        fs::write(&path, b"not json {{{").unwrap();
        let c = load_from(&path);
        assert!(c.profiles.is_empty());
        assert!(path.with_extension("json.broken").exists());
        fs::remove_dir_all(&dir).ok();
    }
}
