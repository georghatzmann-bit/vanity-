//! Spots important moments in the lines Fortnite writes.
//! The patterns come from research (Reboot Launcher, Unreal logs) – written from scratch.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Detection {
    /// Login to our own backend finished
    LoggedIn,
    /// Server listens on its port
    ServerListening,
    /// Game files broken or incomplete
    BuildCorrupted,
    /// Backend not reachable / login refused
    CannotConnect,
    /// Match over (only one team left)
    MatchEnded,
    /// Game is shutting down
    Shutdown,
}

impl Detection {
    pub fn label(self) -> &'static str {
        match self {
            Detection::LoggedIn => "Logged in",
            Detection::ServerListening => "Server ready",
            Detection::BuildCorrupted => "Build damaged",
            Detection::CannotConnect => "Can't reach the backend",
            Detection::MatchEnded => "Match over",
            Detection::Shutdown => "Game is closing",
        }
    }
}

const CORRUPTED: &[&str] = &[
    "Critical error",
    "when 0 bytes remain",
    "Pak chunk signature verification failed!",
    "LogWindows:Error: Fatal error!",
];

const CANNOT_CONNECT: &[&str] = &[
    "port 3551 failed: Connection refused",
    "Unable to login to Fortnite servers",
    "Network failure when attempting to check platform restrictions",
    "UOnlineAccountCommon::ForceLogout",
];

pub fn detect(line: &str) -> Option<Detection> {
    if line.contains("[UOnlineAccountCommon::ContinueLoggingIn]") && line.contains("(Completed)") {
        return Some(Detection::LoggedIn);
    }
    if line.contains("FOnlineSubsystemGoogleCommon::Shutdown()") {
        return Some(Detection::Shutdown);
    }
    if CORRUPTED.iter().any(|p| line.contains(p)) {
        return Some(Detection::BuildCorrupted);
    }
    if CANNOT_CONNECT.iter().any(|p| line.contains(p)) {
        return Some(Detection::CannotConnect);
    }
    if line.contains("TeamsLeft: 1") {
        return Some(Detection::MatchEnded);
    }
    if line.contains("IpNetDriver") && line.to_ascii_lowercase().contains("listening on port") {
        return Some(Detection::ServerListening);
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    Info,
    Warning,
    Error,
}

/// Live-log category of the server's loot report (`[NiobiumLoot] …` lines, see [`tagged_line`]).
pub const CATEGORY_LOOT: &str = "loot";
/// Live-log category of the AI bot lines (`[PlayerBots] …`).
pub const CATEGORY_BOTS: &str = "bots";

/// Line tags our own server DLL writes, and the live-log category each one gets.
///
/// - `[NiobiumLoot] features: <comma list>`, `[NiobiumLoot] items: <count>`, then up to 400
///   `[NiobiumLoot] item <ItemDefinitionName>` – written once after the loot setup.
/// - `[PlayerBots] …` – what the AI bot setup did (e.g. `disabled: build doesn't match`).
const TAGS: &[(&str, &str)] = &[("[NiobiumLoot]", CATEGORY_LOOT), ("[PlayerBots]", CATEGORY_BOTS)];

/// Words that make a `[PlayerBots]` line a warning.
const BOT_WARNING_WORDS: &[&str] = &["disabled", "failed", "fail:", "unavailable", "not available", "error"];

/// Recognises a line of our own server DLL by its tag (`[NiobiumLoot]`, `[PlayerBots]`), also
/// behind Unreal's time stamp brackets. Returns (level, category, text after the tag).
pub fn tagged_line(line: &str) -> Option<(Level, &'static str, String)> {
    let mut rest = line.trim();
    loop {
        if let Some((tag, category)) = TAGS.iter().find(|(tag, _)| rest.starts_with(tag)) {
            let message = rest[tag.len()..].trim().to_string();
            let lower = message.to_ascii_lowercase();
            let level = if *category == CATEGORY_BOTS && BOT_WARNING_WORDS.iter().any(|w| lower.contains(w)) {
                Level::Warning
            } else {
                Level::Info
            };
            return Some((level, category, message));
        }
        // skip one time stamp bracket ("[2026.10.23-18.02.11:204]", "[ 12]") and look again
        if !rest.starts_with('[') {
            return None;
        }
        let end = rest.find(']')?;
        rest = rest[end + 1..].trim_start();
    }
}

/// Splits an Unreal log line "[time][frame]LogCategory: Warning: text".
/// Lines of our own server DLL (`[NiobiumLoot]`, `[PlayerBots]`) get their own category.
pub fn split_line(line: &str) -> (Level, String, String) {
    if let Some((level, category, message)) = tagged_line(line) {
        return (level, category.to_string(), message);
    }
    let mut rest = line.trim_end();
    // Remove the time stamp brackets in front
    while rest.starts_with('[') {
        match rest.find(']') {
            Some(end) => rest = &rest[end + 1..],
            None => break,
        }
    }
    let (category, message) = match rest.find(": ") {
        Some(pos) if pos < 48 && !rest[..pos].contains(' ') => (rest[..pos].to_string(), &rest[pos + 2..]),
        _ => (String::new(), rest),
    };
    let (level, message) = if let Some(m) = message.strip_prefix("Error: ") {
        (Level::Error, m)
    } else if let Some(m) = message.strip_prefix("Warning: ") {
        (Level::Warning, m)
    } else if let Some(m) = message.strip_prefix("Fatal: ") {
        (Level::Error, m)
    } else if line.contains("Error:") || line.contains("Fatal error") {
        (Level::Error, message)
    } else {
        (Level::Info, message)
    };
    (level, category, message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login() {
        let l = "[2026.10.23-18.02.11:204][ 12]LogOnlineAccount: Display: [UOnlineAccountCommon::ContinueLoggingIn] Login completed (Completed)";
        assert_eq!(detect(l), Some(Detection::LoggedIn));
    }

    #[test]
    fn listening_and_end() {
        assert_eq!(
            detect("LogNet: GameNetDriver IpNetDriver_2147482533 IpNetDriver listening on port 7777"),
            Some(Detection::ServerListening)
        );
        assert_eq!(detect("LogFort: TeamsLeft: 1"), Some(Detection::MatchEnded));
    }

    #[test]
    fn errors() {
        assert_eq!(detect("LogPakFile: Error: Pak chunk signature verification failed!"), Some(Detection::BuildCorrupted));
        assert_eq!(detect("LogHttp: Warning: ... port 3551 failed: Connection refused"), Some(Detection::CannotConnect));
        assert_eq!(detect("LogInit: Build: ++Fortnite+Release-19.10"), None);
    }

    #[test]
    fn loot_lines() {
        let (lv, cat, msg) = split_line("[NiobiumLoot] features: BattlePassS19, Spiderman, Mending");
        assert_eq!((lv, cat.as_str(), msg.as_str()), (Level::Info, "loot", "features: BattlePassS19, Spiderman, Mending"));
        let (_, cat, msg) = split_line("[NiobiumLoot] items: 312");
        assert_eq!((cat.as_str(), msg.as_str()), ("loot", "items: 312"));
        let (_, cat, msg) = split_line("[NiobiumLoot] item WID_WebShooter_Athena");
        assert_eq!((cat.as_str(), msg.as_str()), ("loot", "item WID_WebShooter_Athena"));
        // also behind Unreal's time stamps and with a Windows line end
        let (_, cat, msg) = split_line("[2026.10.23-18.02.11:204][ 12][NiobiumLoot] items: 5\r");
        assert_eq!((cat.as_str(), msg.as_str()), ("loot", "items: 5"));
        assert_eq!(detect("[NiobiumLoot] items: 5"), None);
    }

    #[test]
    fn bot_lines() {
        let (lv, cat, msg) = split_line("[PlayerBots] disabled: build doesn't match");
        assert_eq!((lv, cat.as_str(), msg.as_str()), (Level::Warning, "bots", "disabled: build doesn't match"));
        let (lv, cat, msg) = split_line("[PlayerBots] service set up, 30 bots, ELO 500");
        assert_eq!((lv, cat.as_str(), msg.as_str()), (Level::Info, "bots", "service set up, 30 bots, ELO 500"));
        let (lv, _, _) = split_line("[  0][PlayerBots] Error: no navigation data");
        assert_eq!(lv, Level::Warning);
    }

    #[test]
    fn other_brackets_stay_normal() {
        // An Unreal line whose text starts with a bracket is not one of our tags
        let (_, cat, msg) = split_line("[2026.10.23-18.02.11:204][  0]LogFort: [Loot] something");
        assert_eq!((cat.as_str(), msg.as_str()), ("LogFort", "[Loot] something"));
        assert!(tagged_line("[NiobiumLootX] nope").is_none());
        assert!(tagged_line("LogFort: [PlayerBots] inside the text").is_none());
        assert!(tagged_line("[unterminated").is_none());
    }

    #[test]
    fn splits() {
        let (lv, cat, msg) = split_line("[2026.10.23-18.02.11:204][  0]LogHttp: Warning: Retry 1");
        assert_eq!(lv, Level::Warning);
        assert_eq!(cat, "LogHttp");
        assert_eq!(msg, "Retry 1");
        let (lv, cat, msg) = split_line("plain text without category");
        assert_eq!(lv, Level::Info);
        assert_eq!(cat, "");
        assert_eq!(msg, "plain text without category");
    }
}
