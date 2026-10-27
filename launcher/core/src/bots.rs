//! AI player bots ("play with bots") and the match settings the launcher sends to the game server.
//!
//! The server DLL only spawns real AI players on 19.10-CL-18675304 (experimental, ported from
//! Artemis). Every other version keeps today's behaviour. The server decides itself whether its
//! safety checks pass and reports back with the pipe event `playerBots`.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::profiles::{Profile, Settings};

/// How good the bots are. Saved in the profile as "easy" / "normal" / "hard".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BotSkill {
    #[default]
    Easy,
    Normal,
    Hard,
}

impl BotSkill {
    /// Skill rating the server gives its bots (`PlayerBotTargetELO`). Starting values, to be tuned
    /// in game (Artemis falls back to 1100).
    pub fn target_elo(self) -> u32 {
        match self {
            BotSkill::Easy => 500,
            BotSkill::Normal => 1000,
            BotSkill::Hard => 2000,
        }
    }
}

/// Reads "easy" / "normal" / "hard" (any case). Anything else becomes Easy, so a config file
/// with an unknown value still loads.
impl<'de> Deserialize<'de> for BotSkill {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = Value::deserialize(d)?;
        Ok(match v.as_str().map(str::to_ascii_lowercase).as_deref() {
            Some("normal") => BotSkill::Normal,
            Some("hard") => BotSkill::Hard,
            _ => BotSkill::Easy,
        })
    }
}

pub const BOT_COUNT_MIN: u32 = 1;
pub const BOT_COUNT_MAX: u32 = 99;
pub const BOT_COUNT_DEFAULT: u32 = 30;

/// The server clamps the target rating to this range too.
pub const BOT_ELO_MAX: u32 = 5000;

pub fn clamp_bot_count(count: u32) -> u32 {
    count.clamp(BOT_COUNT_MIN, BOT_COUNT_MAX)
}

/// Whether AI bots can be switched on for a version.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BotsLevel {
    Experimental,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotsSupport {
    pub level: BotsLevel,
    pub note: String,
}

/// The one build the bot port was made for.
pub const BOTS_VERSION: &str = "19.10";
pub const BOTS_CHANGELIST: u32 = 18675304;

pub const BOTS_NOTE_EXPERIMENTAL: &str =
    "Experimental, 19.10 only. Bots may not loot, fight or build well yet.";
pub const BOTS_NOTE_NOT_IN_GAME: &str = "AI bots don't exist in this Fortnite version.";
pub const BOTS_NOTE_NOT_YET: &str = "AI bots aren't available for this version yet.";

/// `{ level, note }` for a Fortnite version and changelist. Only 19.10-CL-18675304 gets
/// "experimental"; versions before 11.00 never had AI players.
pub fn bots_support(version: &str, changelist: Option<u32>) -> BotsSupport {
    let v = crate::version::parse_version_number(version);
    if v == Some((19, 10)) && changelist == Some(BOTS_CHANGELIST) {
        return BotsSupport { level: BotsLevel::Experimental, note: BOTS_NOTE_EXPERIMENTAL.into() };
    }
    let note = match v {
        Some(v) if v < (11, 0) => BOTS_NOTE_NOT_IN_GAME,
        _ => BOTS_NOTE_NOT_YET,
    };
    BotsSupport { level: BotsLevel::Unavailable, note: note.into() }
}

/// The match settings sent to the server right after the control pipe connects, in this order
/// (the server handles the pipe in order). `bEnableCheats` comes first: without it the server
/// refuses every other key. The "Bosses & NPCs" keys (`bLivingWorld`, `LivingWorldMaxAI`, see
/// `crate::livingworld`) come last and only when the profile has them on: the server's default is
/// off, and a key it refuses (the pipe connected after "Start match") would only bring a pop-up.
pub fn server_config_for(profile: &Profile) -> Vec<(&'static str, Value)> {
    let mut out: Vec<(&'static str, Value)> = vec![("bEnableCheats", Value::Bool(true))];
    if !profile.playlist.is_empty() {
        out.push(("playlist", Value::String(profile.playlist.clone())));
    }
    out.push(("bLateGame", Value::Bool(profile.lategame)));
    out.push(("bInfiniteAmmo", Value::Bool(profile.infinite_ammo)));
    out.push(("bInfiniteMats", Value::Bool(profile.infinite_mats)));
    out.push(("bPlayerBots", Value::Bool(profile.bots)));
    out.push(("PlayerBotCount", Value::from(clamp_bot_count(profile.bot_count))));
    out.push(("PlayerBotTargetELO", Value::from(profile.bot_skill.target_elo().min(BOT_ELO_MAX))));
    if profile.living_world {
        out.push(("bLivingWorld", Value::Bool(true)));
        out.push(("LivingWorldMaxAI", Value::from(crate::livingworld::clamp_max_ai(profile.living_world_max_ai))));
    }
    out
}

/// Pipe key of the launcher setting "Show the server window (for troubleshooting)". The server
/// creates its window hidden (native/server/Erbium/Private/GUI.cpp); `true` shows it, `false` hides it
/// again. A server that no launcher reached within 30 s shows it by itself.
pub const SHOW_SERVER_WINDOW_KEY: &str = "bShowServerWindow";

/// The server window setting as a pipe config pair, sent after the match settings and again when
/// the setting changes while a server is connected.
pub fn server_window_config(settings: &Settings) -> (&'static str, Value) {
    (SHOW_SERVER_WINDOW_KEY, Value::Bool(settings.show_server_window))
}

/// Pipe event `{"event":"playerBots","state":"active"|"unavailable","reason":"…"}` from the server,
/// forwarded to the UI as the Tauri event `server:playerBots`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerBotsEvent {
    pub state: String,
    pub reason: String,
}

impl PlayerBotsEvent {
    /// Reads the fields of the pipe event (everything except `event`). Unknown states pass through.
    pub fn from_pipe(fields: &serde_json::Map<String, Value>) -> PlayerBotsEvent {
        let text = |k: &str| fields.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        PlayerBotsEvent { state: text("state"), reason: text("reason") }
    }

    /// One line for the live log.
    pub fn log_line(&self) -> String {
        match self.state.as_str() {
            "active" => "AI bots are on for this match.".to_string(),
            _ if self.reason.is_empty() => "AI bots are off for this match.".to_string(),
            _ => format!("AI bots are off: {}", self.reason),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_window_setting_is_off_by_default_and_sent_as_bool() {
        let mut settings = Settings::default();
        assert!(!settings.show_server_window);
        assert_eq!(server_window_config(&settings), ("bShowServerWindow", Value::Bool(false)));
        settings.show_server_window = true;
        assert_eq!(server_window_config(&settings), ("bShowServerWindow", Value::Bool(true)));
        // Older config files without the field load with the window hidden.
        let old: Settings = serde_json::from_str("{}").unwrap();
        assert!(!old.show_server_window);
    }

    fn profile() -> Profile {
        serde_json::from_str(r#"{"id":"p","name":"P","buildId":"b"}"#).unwrap()
    }

    #[test]
    fn skill_to_elo() {
        assert_eq!(BotSkill::Easy.target_elo(), 500);
        assert_eq!(BotSkill::Normal.target_elo(), 1000);
        assert_eq!(BotSkill::Hard.target_elo(), 2000);
        assert_eq!(BotSkill::default(), BotSkill::Easy);
    }

    #[test]
    fn skill_reads_and_writes_lowercase() {
        assert_eq!(serde_json::to_value(BotSkill::Hard).unwrap(), "hard");
        let s: BotSkill = serde_json::from_str(r#""normal""#).unwrap();
        assert_eq!(s, BotSkill::Normal);
        let s: BotSkill = serde_json::from_str(r#""HARD""#).unwrap();
        assert_eq!(s, BotSkill::Hard);
        // unknown values don't break the config
        let s: BotSkill = serde_json::from_str(r#""expert""#).unwrap();
        assert_eq!(s, BotSkill::Easy);
        let s: BotSkill = serde_json::from_str("3").unwrap();
        assert_eq!(s, BotSkill::Easy);
    }

    #[test]
    fn support_by_version() {
        let s = bots_support("19.10", Some(18675304));
        assert_eq!(s.level, BotsLevel::Experimental);
        assert_eq!(s.note, BOTS_NOTE_EXPERIMENTAL);
        assert_eq!(bots_support("19.1", Some(18675304)).level, BotsLevel::Experimental);
        // other 19.10 changelists are not the build the addresses were made for
        assert_eq!(bots_support("19.10", Some(18640491)).note, BOTS_NOTE_NOT_YET);
        assert_eq!(bots_support("19.10", None).level, BotsLevel::Unavailable);
        assert_eq!(bots_support("10.40", None).note, BOTS_NOTE_NOT_IN_GAME);
        assert_eq!(bots_support("1.7.2", None).note, BOTS_NOTE_NOT_IN_GAME);
        assert_eq!(bots_support("4.5", None).note, BOTS_NOTE_NOT_IN_GAME);
        assert_eq!(bots_support("11.00", None).note, BOTS_NOTE_NOT_YET);
        assert_eq!(bots_support("18.30", Some(17882303)).note, BOTS_NOTE_NOT_YET);
        assert_eq!(bots_support("22.40", None).note, BOTS_NOTE_NOT_YET);
        assert_eq!(bots_support("Cert", None).note, BOTS_NOTE_NOT_YET);
        let json = serde_json::to_value(bots_support("19.10", Some(18675304))).unwrap();
        assert_eq!(json["level"], "experimental");
        assert_eq!(serde_json::to_value(bots_support("5.0", None)).unwrap()["level"], "unavailable");
    }

    #[test]
    fn server_keys_in_order() {
        let mut p = profile();
        p.playlist = "Playlist_DefaultSolo".into();
        p.bots = true;
        p.bot_count = 40;
        p.bot_skill = BotSkill::Normal;
        p.infinite_ammo = true;
        let keys: Vec<&str> = server_config_for(&p).iter().map(|(k, _)| *k).collect();
        // Bosses & NPCs off (the default): their keys aren't sent at all
        assert_eq!(
            keys,
            [
                "bEnableCheats",
                "playlist",
                "bLateGame",
                "bInfiniteAmmo",
                "bInfiniteMats",
                "bPlayerBots",
                "PlayerBotCount",
                "PlayerBotTargetELO"
            ]
        );
        // switched on: the two keys come last
        p.living_world = true;
        let keys: Vec<&str> = server_config_for(&p).iter().map(|(k, _)| *k).collect();
        assert_eq!(
            keys,
            [
                "bEnableCheats",
                "playlist",
                "bLateGame",
                "bInfiniteAmmo",
                "bInfiniteMats",
                "bPlayerBots",
                "PlayerBotCount",
                "PlayerBotTargetELO",
                "bLivingWorld",
                "LivingWorldMaxAI"
            ]
        );
        let cfg = server_config_for(&p);
        assert_eq!(cfg[0].1, Value::Bool(true));
        assert_eq!(cfg[1].1, "Playlist_DefaultSolo");
        assert_eq!(cfg[2].1, false);
        assert_eq!(cfg[3].1, true);
        assert_eq!(cfg[4].1, false);
        assert_eq!(cfg[5].1, true);
        assert_eq!(cfg[6].1, 40);
        assert_eq!(cfg[7].1, 1000);
        assert_eq!(cfg[8].1, true);
        assert_eq!(cfg[9].1, 40);
    }

    #[test]
    fn living_world_keys_come_last() {
        let mut p = profile();
        p.living_world = true;
        p.living_world_max_ai = 25;
        let cfg = server_config_for(&p);
        // after the bot keys, in this order, and nothing after them
        let n = cfg.len();
        assert_eq!(cfg[n - 3].0, "PlayerBotTargetELO");
        assert_eq!(cfg[n - 2], ("bLivingWorld", Value::Bool(true)));
        assert_eq!(cfg[n - 1], ("LivingWorldMaxAI", Value::from(25)));
        // the count is kept to 1–100
        p.living_world_max_ai = 0;
        assert_eq!(server_config_for(&p)[n - 1].1, 1);
        p.living_world_max_ai = 250;
        assert_eq!(server_config_for(&p)[n - 1].1, 100);
        // with a playlist (one key more) they are still the last two
        p.playlist = "Playlist_DefaultSolo".into();
        let keys: Vec<&str> = server_config_for(&p).iter().map(|(k, _)| *k).collect();
        assert_eq!(keys.len(), n + 1);
        assert_eq!(&keys[keys.len() - 2..], ["bLivingWorld", "LivingWorldMaxAI"]);
        // switched off again: neither key, whatever the count says
        p.living_world = false;
        let keys: Vec<&str> = server_config_for(&p).iter().map(|(k, _)| *k).collect();
        assert_eq!(keys.len(), n - 1);
        assert_eq!(keys.last(), Some(&"PlayerBotTargetELO"));
        assert!(!keys.contains(&"bLivingWorld") && !keys.contains(&"LivingWorldMaxAI"));
    }

    #[test]
    fn classic_profile_sends_classic_values() {
        // An old profile without the new fields: no playlist key, everything "like back then"
        let p = profile();
        let cfg = server_config_for(&p);
        let keys: Vec<&str> = cfg.iter().map(|(k, _)| *k).collect();
        assert!(!keys.contains(&"playlist"));
        let get = |k: &str| cfg.iter().find(|(key, _)| *key == k).unwrap().1.clone();
        assert_eq!(get("bLateGame"), false);
        assert_eq!(get("bInfiniteAmmo"), false);
        assert_eq!(get("bInfiniteMats"), false);
        assert_eq!(get("bPlayerBots"), false);
        assert_eq!(get("PlayerBotCount"), 30);
        assert_eq!(get("PlayerBotTargetELO"), 500);
        // Bosses & NPCs off: nothing is sent (the server's default is off)
        assert!(!keys.contains(&"bLivingWorld"));
        assert!(!keys.contains(&"LivingWorldMaxAI"));
        assert_eq!(keys.last(), Some(&"PlayerBotTargetELO"));
    }

    #[test]
    fn bot_count_is_clamped() {
        let mut p = profile();
        p.bot_count = 0;
        assert_eq!(server_config_for(&p)[5].1, 1);
        p.bot_count = 500;
        assert_eq!(server_config_for(&p)[5].1, 99);
        assert_eq!(clamp_bot_count(30), 30);
    }

    #[test]
    fn pipe_event_reads() {
        let ev: serde_json::Map<String, Value> = serde_json::from_str(
            r#"{"state":"unavailable","reason":"Bots aren't available for this copy of 19.10."}"#,
        )
        .unwrap();
        let e = PlayerBotsEvent::from_pipe(&ev);
        assert_eq!(e.state, "unavailable");
        assert_eq!(e.log_line(), "AI bots are off: Bots aren't available for this copy of 19.10.");
        let on = PlayerBotsEvent::from_pipe(&serde_json::from_str(r#"{"state":"active"}"#).unwrap());
        assert_eq!(on.reason, "");
        assert_eq!(on.log_line(), "AI bots are on for this match.");
        assert_eq!(serde_json::to_value(&on).unwrap(), serde_json::json!({"state":"active","reason":""}));
    }
}
