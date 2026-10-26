//! Settings, profiles, builds and friends – saved in `%APPDATA%\Niobium\config.json`.
//!
//! All state lives in one file. It is written to a temporary file first and then renamed,
//! so an interrupted write can't break the file.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::bots::BotSkill;
use crate::version::BuildInfo;

pub const PORT_BACKEND_DEFAULT: u16 = 3551;
pub const PORT_MATCHMAKER_DEFAULT: u16 = 80;
pub const PORT_GAMESERVER_DEFAULT: u16 = 7777;

/// The backend always runs on this port. The redirect DLL sends every request of the game to
/// `http://127.0.0.1:3551`, and that address is built into the DLL (native/redirect/Options.h).
pub const BACKEND_PORT: u16 = PORT_BACKEND_DEFAULT;

/// The game server always listens on this port. The server DLL takes its port from its own
/// settings (`%LOCALAPPDATA%\Niobium\server\auto_hosting.json`, default 7777), never from the
/// launcher – so the matchmaker must send players to 7777.
pub const GAME_SERVER_PORT: u16 = PORT_GAMESERVER_DEFAULT;

/// Live-log note when a saved config holds another backend port (see `Settings::pin_fixed_ports`).
pub const NOTE_BACKEND_PORT_FIXED: &str = "Backend port is fixed at 3551 (the game connects there).";

/// Live-log note when a saved config holds another game server port.
pub const NOTE_GAME_SERVER_PORT_FIXED: &str = "Game server port is fixed at 7777 (the server listens there).";

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
    /// Infinite ammo on the server. Off = "like back then" (Classic match).
    #[serde(default)]
    pub infinite_ammo: bool,
    /// Infinite building materials on the server. Off = Classic match.
    #[serde(default)]
    pub infinite_mats: bool,
    /// Play with AI bots (only 19.10-CL-18675304 for now, see `bots::bots_support`).
    #[serde(default)]
    pub bots: bool,
    /// Number of AI bots, 1–99 (clamped when sent to the server).
    #[serde(default = "default_bot_count")]
    pub bot_count: u32,
    #[serde(default)]
    pub bot_skill: BotSkill,
    /// "Bosses & NPCs" (experimental): the season's bosses, guards and creatures walk around.
    /// Off by default, also in a Classic match (see `livingworld`).
    #[serde(default)]
    pub living_world: bool,
    /// Most bosses and NPCs at once, 1–100 (clamped when sent to the server).
    #[serde(default = "default_living_world_max_ai", rename = "livingWorldMaxAI")]
    pub living_world_max_ai: u32,
}

fn default_bot_count() -> u32 {
    crate::bots::BOT_COUNT_DEFAULT
}

fn default_living_world_max_ai() -> u32 {
    crate::livingworld::LIVING_WORLD_MAX_AI_DEFAULT
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
    /// Not used. "Restart the server after a match" was never built; the field only stays so
    /// config files that have it still load (and keep it when saved).
    #[serde(default)]
    pub auto_restart: bool,
    /// Not used: the backend port is fixed (`BACKEND_PORT`). Kept so old config files still load;
    /// `pin_fixed_ports` sets it back to 3551.
    #[serde(default = "PORT_BACKEND_DEFAULT_fn")]
    pub backend_port: u16,
    /// Port of the matchmaker and XMPP WebSocket. Can be changed: the backend puts it into the
    /// matchmaking ticket and into the XMPP hotfix (DefaultEngine.ini) the game downloads.
    #[serde(default = "PORT_MATCHMAKER_DEFAULT_fn")]
    pub matchmaker_port: u16,
    /// Not used: the game server port is fixed (`GAME_SERVER_PORT`). Kept so old config files
    /// still load; `pin_fixed_ports` sets it back to 7777.
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
    /// Bubble Builds: start the player's game in Performance Mode on versions that can show the
    /// Chapter 2 "bubble wrap" build look (see `launchargs::BubbleSupport`). Applies on next launch.
    #[serde(default)]
    pub bubble_builds: bool,
    /// App version the user last saw (first-run welcome / "What's new"). `None` = never opened.
    #[serde(default)]
    pub last_seen_version: Option<String>,
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
            bubble_builds: false,
            last_seen_version: None,
        }
    }
}

impl Settings {
    /// Sets the fixed ports back (backend 3551, game server 7777) when the config holds other
    /// values, e.g. from an older launcher that let you change them. Returns one note for the
    /// live log per port that was set back (empty if nothing changed).
    pub fn pin_fixed_ports(&mut self) -> Vec<&'static str> {
        let mut notes = Vec::new();
        if self.backend_port != BACKEND_PORT {
            self.backend_port = BACKEND_PORT;
            notes.push(NOTE_BACKEND_PORT_FIXED);
        }
        if self.game_server_port != GAME_SERVER_PORT {
            self.game_server_port = GAME_SERVER_PORT;
            notes.push(NOTE_GAME_SERVER_PORT_FIXED);
        }
        notes
    }
}

/// A trickshot preset: a name plus server commands that are sent to the game server one after another.
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
    /// Adds a build or updates it (same id) and creates a default profile if there is none.
    pub fn upsert_build(&mut self, build: BuildInfo) {
        let id = build.id.clone();
        if let Some(existing) = self.builds.iter_mut().find(|b| b.id == id) {
            *existing = build;
        } else {
            self.builds.push(build);
        }
        if self.profiles.is_empty() {
            let p = Profile {
                id: "p-default".into(),
                name: "Default".into(),
                description: "A normal match on your own server".into(),
                build_id: id.clone(),
                player_name: self.settings.player_name.clone(),
                launch_args: self.settings.launch_args.clone(),
                headless_server: true,
                playlist: "Playlist_DefaultSolo".into(),
                lategame: false,
                tags: vec!["Solo".into()],
                infinite_ammo: false,
                infinite_mats: false,
                bots: false,
                bot_count: crate::bots::BOT_COUNT_DEFAULT,
                bot_skill: BotSkill::Easy,
                living_world: false,
                living_world_max_ai: default_living_world_max_ai(),
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

    /// Brings stored texts up to date after loading. Runs on every load and is cheap.
    ///
    /// - Each build's season and support level/note are worked out again from its version, so
    ///   notes saved by an older launcher (e.g. German ones from Vanity) are replaced and always
    ///   match the current version rules.
    /// - Texts the old Vanity launcher wrote itself (default profile, profile descriptions,
    ///   playlist tags, friend network) become English. Only exact old texts are changed –
    ///   anything the user typed stays as it is.
    pub fn refresh_after_load(&mut self) {
        for b in &mut self.builds {
            b.season = crate::version::season_for(&b.version);
            b.support = crate::version::support_for(&b.version, b.changelist);
            b.support_note = crate::version::support_note(&b.version);
        }
        for p in &mut self.profiles {
            if p.id == "p-standard" && p.name == "Standard" {
                p.name = "Default".into();
            }
            if let Some(english) = legacy_text(LEGACY_PROFILE_DESCRIPTIONS, &p.description) {
                p.description = english.into();
            }
            for tag in &mut p.tags {
                if let Some(english) = legacy_text(LEGACY_TAGS, tag) {
                    *tag = english.into();
                }
            }
        }
        for f in &mut self.friends {
            if f.via == "Netzwerk" {
                f.via = "Other".into();
            }
        }
    }
}

/// Profile descriptions the Vanity launcher wrote by itself → English.
const LEGACY_PROFILE_DESCRIPTIONS: &[(&str, &str)] = &[
    ("Normales Match auf deinem eigenen Server", "A normal match on your own server"),
    ("Eigenes Profil", "Custom profile"),
];

/// Playlist tags the Vanity launcher wrote by itself → English.
const LEGACY_TAGS: &[(&str, &str)] = &[("Turnier Solo", "Tournament Solo"), ("Turnier Duos", "Tournament Duos")];

fn legacy_text(table: &[(&str, &'static str)], text: &str) -> Option<&'static str> {
    table.iter().find(|(old, _)| *old == text).map(|(_, new)| *new)
}

pub fn config_dir() -> PathBuf {
    dirs::config_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_DIR)
}

/// Folder name of the app's own data (in `%APPDATA%` and `%LOCALAPPDATA%`).
pub const APP_DIR: &str = "Niobium";

/// Folder name the app used before it was renamed to Niobium (only read, for the one-time migration).
pub const LEGACY_APP_DIR: &str = "Vanity";

/// `%LOCALAPPDATA%\Niobium` – logs, server settings and backend data.
pub fn local_dir() -> PathBuf {
    dirs::data_local_dir().unwrap_or_else(|| PathBuf::from(".")).join(APP_DIR)
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

pub fn load() -> Config {
    load_from(&config_path())
}

pub fn load_from(path: &Path) -> Config {
    let mut config = match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|_| {
            // Don't lose a broken file: move it aside and carry on with the defaults
            let _ = fs::rename(path, path.with_extension("json.broken"));
            Config::default()
        }),
        Err(_) => Config::default(),
    };
    config.refresh_after_load();
    config
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
        assert_eq!(c.active_profile().unwrap().name, "Default");
        // A second build doesn't create a second profile
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
        let dir = std::env::temp_dir().join(format!("niobium-cfg-{}", std::process::id()));
        let path = dir.join("config.json");
        let mut c = Config::default();
        c.settings.player_name = "georg".into();
        c.upsert_build(build("19.10-18675304"));
        save_to(&path, &c).unwrap();
        let loaded = load_from(&path);
        assert_eq!(loaded.settings.player_name, "georg");
        assert_eq!(loaded.builds.len(), 1);
        assert_eq!(loaded.active_profile().unwrap().id, "p-default");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_fields_fill_defaults() {
        let c: Config = serde_json::from_str(r#"{"settings":{"playerName":"x"}}"#).unwrap();
        assert_eq!(c.settings.player_name, "x");
        assert_eq!(c.settings.backend_port, 3551);
        assert!(c.settings.animated_background);
        assert!(!c.settings.bubble_builds);
        assert_eq!(c.settings.last_seen_version, None);
    }

    #[test]
    fn new_settings_use_camel_case() {
        let mut s = Settings::default();
        s.bubble_builds = true;
        s.last_seen_version = Some("0.1.0".into());
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["bubbleBuilds"], true);
        assert_eq!(json["lastSeenVersion"], "0.1.0");
        let back: Settings = serde_json::from_value(json).unwrap();
        assert!(back.bubble_builds);
        assert_eq!(back.last_seen_version.as_deref(), Some("0.1.0"));
        // An old config without the fields still loads
        let old: Settings = serde_json::from_str(r#"{"playerName":"x"}"#).unwrap();
        assert!(!old.bubble_builds && old.last_seen_version.is_none());
    }

    #[test]
    fn vanity_era_config_loads_in_english() {
        // What the old Vanity launcher saved (German texts it wrote itself)
        let old = r#"{
          "configVersion": 1,
          "settings": { "playerName": "georg" },
          "builds": [
            { "id": "15.40-0", "version": "15.40", "changelist": null, "season": "Chapter 2 · Season 5",
              "engine": "Unreal Engine 4.26", "path": "C:/b", "binaries": "C:/b/bin", "support": "experimental",
              "supportNote": "ungetestet – Start wird versucht · den Pre-Edits-Schalter gibt es ab 15.20 nicht mehr",
              "launchArgs": "-d3d11" },
            { "id": "19.10-18675304", "version": "19.10", "changelist": 18675304, "season": "Chapter 3 · Season 1",
              "engine": "Unreal Engine 5.0", "path": "C:/c", "binaries": "C:/c/bin", "support": "supported",
              "supportNote": "getestet", "launchArgs": "-d3d11" },
            { "id": "x-0", "version": "", "changelist": null, "season": "Unbekannte Season",
              "engine": "", "path": "C:/d", "binaries": "C:/d/bin", "support": "unsupported",
              "supportNote": "Version unlesbar", "launchArgs": "" }
          ],
          "profiles": [
            { "id": "p-standard", "name": "Standard", "description": "Normales Match auf deinem eigenen Server",
              "buildId": "19.10-18675304", "tags": ["Solo"] },
            { "id": "p-1", "name": "Turnier mit Max", "description": "Eigenes Profil",
              "buildId": "19.10-18675304", "tags": ["Turnier Duos", "Lategame"] }
          ],
          "activeProfileId": "p-standard",
          "friends": [ { "id": "f1", "name": "Max", "address": "1.2.3.4:7777", "via": "Netzwerk" },
                       { "id": "f2", "name": "Lena", "address": "100.1.1.1:7777", "via": "Tailscale" } ]
        }"#;
        let dir = std::env::temp_dir().join(format!("niobium-vanity-cfg-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        fs::write(&path, old).unwrap();
        let c = load_from(&path);

        assert_eq!(c.builds[0].support_note, crate::version::support_note("15.40"));
        assert!(c.builds[0].support_note.starts_with("Untested"));
        assert_eq!(c.builds[0].season, "Chapter 2 · Season 5");
        assert_eq!(c.builds[1].support_note, "Tested");
        assert_eq!(c.builds[1].support, Support::Supported);
        assert_eq!(c.builds[2].season, "Unknown season");
        assert_eq!(c.builds[2].support_note, "Can't read the version");
        assert_eq!(c.builds[2].support, Support::Unsupported);

        assert_eq!(c.profiles[0].name, "Default");
        assert_eq!(c.profiles[0].description, "A normal match on your own server");
        assert_eq!(c.active_profile().unwrap().id, "p-standard");
        // a name the user typed stays as it is
        assert_eq!(c.profiles[1].name, "Turnier mit Max");
        assert_eq!(c.profiles[1].description, "Custom profile");
        assert_eq!(c.profiles[1].tags, vec!["Tournament Duos".to_string(), "Lategame".to_string()]);

        assert_eq!(c.friends[0].via, "Other");
        assert_eq!(c.friends[1].via, "Tailscale");
        assert_eq!(c.settings.player_name, "georg");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fixed_ports_are_set_back() {
        // An older launcher let you pick these ports; the game can only use 3551 and 7777.
        let mut c: Config = serde_json::from_str(
            r#"{"settings":{"backendPort":4000,"matchmakerPort":8080,"gameServerPort":7778,"autoRestart":true}}"#,
        )
        .unwrap();
        let notes = c.settings.pin_fixed_ports();
        assert_eq!(notes, vec![NOTE_BACKEND_PORT_FIXED, NOTE_GAME_SERVER_PORT_FIXED]);
        assert_eq!(c.settings.backend_port, 3551);
        assert_eq!(c.settings.game_server_port, 7777);
        // the matchmaker port really works with other values, so it stays
        assert_eq!(c.settings.matchmaker_port, 8080);
        // the unused field still loads and is saved again
        assert!(c.settings.auto_restart);
        assert_eq!(serde_json::to_value(&c.settings).unwrap()["autoRestart"], true);
        // second time: nothing left to say
        assert!(c.settings.pin_fixed_ports().is_empty());
    }

    #[test]
    fn default_ports_need_no_note() {
        let mut s = Settings::default();
        assert!(s.pin_fixed_ports().is_empty());
        assert_eq!(NOTE_BACKEND_PORT_FIXED, "Backend port is fixed at 3551 (the game connects there).");
        let mut only_backend = Settings { backend_port: 3552, ..Settings::default() };
        assert_eq!(only_backend.pin_fixed_ports(), vec![NOTE_BACKEND_PORT_FIXED]);
    }

    #[test]
    fn old_profile_gets_classic_defaults() {
        // A profile saved before the bot and ammo/mats fields existed
        let p: Profile = serde_json::from_str(
            r#"{"id":"p-1","name":"Mine","buildId":"19.10-18675304","playlist":"Playlist_DefaultDuo","lategame":true,"tags":["Duos"]}"#,
        )
        .unwrap();
        assert!(p.lategame, "an existing Lategame choice stays");
        assert!(!p.infinite_ammo && !p.infinite_mats);
        assert!(!p.bots);
        assert_eq!(p.bot_count, 30);
        assert_eq!(p.bot_skill, BotSkill::Easy);
        assert!(!p.living_world, "Bosses & NPCs stay off in an old profile");
        assert_eq!(p.living_world_max_ai, 40);
        // the whole config of an old launcher still loads
        let c: Config = serde_json::from_str(
            r#"{"profiles":[{"id":"p-default","name":"Default","buildId":"x"}],"activeProfileId":"p-default"}"#,
        )
        .unwrap();
        assert_eq!(c.profiles[0].bot_count, 30);
        assert!(!c.profiles[0].lategame);
        assert!(!c.profiles[0].living_world);
        assert_eq!(c.profiles[0].living_world_max_ai, 40);
    }

    #[test]
    fn living_world_fields_load_and_save() {
        // The default profile (Classic match) has Bosses & NPCs off, 40 at most
        let mut c = Config::default();
        c.upsert_build(build("19.10-18675304"));
        let mut p = c.profiles[0].clone();
        assert!(!p.living_world);
        assert_eq!(p.living_world_max_ai, 40);
        // camelCase with "AI" in capitals, like the server key
        p.living_world = true;
        p.living_world_max_ai = 75;
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["livingWorld"], true);
        assert_eq!(json["livingWorldMaxAI"], 75);
        assert!(json.get("livingWorldMaxAi").is_none());
        let back: Profile = serde_json::from_value(json).unwrap();
        assert!(back.living_world);
        assert_eq!(back.living_world_max_ai, 75);
        // what the UI sends
        let ui: Profile = serde_json::from_str(r#"{"id":"p","name":"P","buildId":"b","livingWorld":true,"livingWorldMaxAI":12}"#).unwrap();
        assert!(ui.living_world);
        assert_eq!(ui.living_world_max_ai, 12);
        // an out-of-range number still loads (it is clamped when sent to the server)
        let big: Profile = serde_json::from_str(r#"{"id":"p","name":"P","buildId":"b","livingWorldMaxAI":500}"#).unwrap();
        assert_eq!(big.living_world_max_ai, 500);
    }

    #[test]
    fn new_profile_fields_use_camel_case() {
        let mut c = Config::default();
        c.upsert_build(build("19.10-18675304"));
        let mut p = c.profiles[0].clone();
        assert!(!p.lategame && !p.infinite_ammo && !p.infinite_mats && !p.bots, "Classic match");
        assert_eq!((p.bot_count, p.bot_skill), (30, BotSkill::Easy));
        p.bots = true;
        p.bot_count = 12;
        p.bot_skill = BotSkill::Hard;
        p.infinite_ammo = true;
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["bots"], true);
        assert_eq!(json["botCount"], 12);
        assert_eq!(json["botSkill"], "hard");
        assert_eq!(json["infiniteAmmo"], true);
        assert_eq!(json["infiniteMats"], false);
        let back: Profile = serde_json::from_value(json).unwrap();
        assert_eq!(back.bot_skill, BotSkill::Hard);
        assert_eq!(back.bot_count, 12);
    }

    #[test]
    fn profile_with_bots_survives_save_and_load() {
        let dir = std::env::temp_dir().join(format!("niobium-bots-cfg-{}", std::process::id()));
        let path = dir.join("config.json");
        let mut c = Config::default();
        c.upsert_build(build("19.10-18675304"));
        c.profiles[0].bots = true;
        c.profiles[0].bot_skill = BotSkill::Normal;
        save_to(&path, &c).unwrap();
        let loaded = load_from(&path);
        assert!(loaded.profiles[0].bots);
        assert_eq!(loaded.profiles[0].bot_skill, BotSkill::Normal);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn broken_file_does_not_crash() {
        let dir = std::env::temp_dir().join(format!("niobium-broken-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        fs::write(&path, b"not json {{{").unwrap();
        let c = load_from(&path);
        assert!(c.profiles.is_empty());
        assert!(path.with_extension("json.broken").exists());
        fs::remove_dir_all(&dir).ok();
    }
}
