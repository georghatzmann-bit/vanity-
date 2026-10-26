//! "Bosses & NPCs" (living world): the season's bosses, guards and creatures walk around like back
//! then. Experimental and still being built on the server: spawning is added season by season, and
//! until a season has it the server answers `unavailable` with the reason. The game server decides
//! itself per match and reports back with the pipe event `livingWorld`.
//!
//! The launcher only sends two settings before the map loads, and only when the profile has the switch
//! on (`bLivingWorld`, `LivingWorldMaxAI`, see `bots::server_config_for`), and shows the server's answer.

use serde::Serialize;
use serde_json::Value;

pub const LIVING_WORLD_MAX_AI_MIN: u32 = 1;
pub const LIVING_WORLD_MAX_AI_MAX: u32 = 100;
pub const LIVING_WORLD_MAX_AI_DEFAULT: u32 = 40;

/// Most bosses and NPCs the server may spawn (`LivingWorldMaxAI`), kept to 1–100.
pub fn clamp_max_ai(count: u32) -> u32 {
    count.clamp(LIVING_WORLD_MAX_AI_MIN, LIVING_WORLD_MAX_AI_MAX)
}

/// Pipe event `{"event":"livingWorld","state":"active"|"unavailable"|"off","reason":"…","spawned":N}`
/// from the server, forwarded to the UI as the Tauri event `server:livingWorld`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LivingWorldEvent {
    pub state: String,
    pub reason: String,
    /// How many bosses and NPCs are in the match so far (0 when not "active").
    pub spawned: u32,
}

impl LivingWorldEvent {
    /// Reads the fields of the pipe event (everything except `event`). Unknown states pass through;
    /// a missing or broken `spawned` counts as 0.
    pub fn from_pipe(fields: &serde_json::Map<String, Value>) -> LivingWorldEvent {
        let text = |k: &str| fields.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let spawned = fields.get("spawned").and_then(Value::as_u64).map(|n| n.min(u32::MAX as u64) as u32).unwrap_or(0);
        LivingWorldEvent { state: text("state"), reason: text("reason"), spawned }
    }

    /// Live-log level of [`log_line`](Self::log_line): only "unavailable" is a warning.
    pub fn log_level(&self) -> &'static str {
        if self.state == "unavailable" {
            "warning"
        } else {
            "info"
        }
    }

    /// One line for the live log.
    pub fn log_line(&self) -> String {
        match self.state.as_str() {
            "active" if self.spawned > 0 => format!("Bosses & NPCs are on: {} spawned.", self.spawned),
            "active" => "Bosses & NPCs are on for this match.".to_string(),
            "unavailable" if self.reason.is_empty() => "Bosses & NPCs aren't available for this match.".to_string(),
            "unavailable" => format!("Bosses & NPCs aren't available: {}", self.reason),
            _ if self.reason.is_empty() => "Bosses & NPCs are off for this match.".to_string(),
            _ => format!("Bosses & NPCs are off: {}", self.reason),
        }
    }

    /// True when the switch is on and the server answered: "active" or "unavailable". Anything else
    /// ("off", or a state this launcher doesn't know) changes nothing you can see.
    pub fn is_on(&self) -> bool {
        self.state == "active" || self.state == "unavailable"
    }

    /// True when the live log should get a new line: the switch is on ([`is_on`](Self::is_on)) and the
    /// state or the reason changed (the launcher forgets the last event at the end of a match). "off"
    /// never gets a line, so with the switch off the log stays as before. A new `spawned` count alone
    /// only updates the status chip (the server's own `[LivingWorld]` lines say more).
    pub fn worth_a_log_line(&self, last: Option<&LivingWorldEvent>) -> bool {
        self.is_on() && last.is_none_or(|l| l.state != self.state || l.reason != self.reason)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(json: &str) -> LivingWorldEvent {
        LivingWorldEvent::from_pipe(&serde_json::from_str(json).unwrap())
    }

    #[test]
    fn max_ai_is_clamped() {
        assert_eq!(clamp_max_ai(0), 1);
        assert_eq!(clamp_max_ai(1), 1);
        assert_eq!(clamp_max_ai(40), 40);
        assert_eq!(clamp_max_ai(100), 100);
        assert_eq!(clamp_max_ai(101), 100);
        assert_eq!(clamp_max_ai(u32::MAX), 100);
        assert_eq!(LIVING_WORLD_MAX_AI_DEFAULT, 40);
    }

    #[test]
    fn pipe_event_reads() {
        let on = ev(r#"{"state":"active","reason":"","spawned":12}"#);
        assert_eq!(on, LivingWorldEvent { state: "active".into(), reason: String::new(), spawned: 12 });
        assert_eq!(on.log_line(), "Bosses & NPCs are on: 12 spawned.");
        assert_eq!(on.log_level(), "info");
        assert_eq!(serde_json::to_value(&on).unwrap(), serde_json::json!({"state":"active","reason":"","spawned":12}));

        let starting = ev(r#"{"state":"active"}"#);
        assert_eq!(starting.spawned, 0);
        assert_eq!(starting.log_line(), "Bosses & NPCs are on for this match.");

        let no = ev(r#"{"state":"unavailable","reason":"This season's spawn data wasn't found.","spawned":0}"#);
        assert_eq!(no.log_line(), "Bosses & NPCs aren't available: This season's spawn data wasn't found.");
        assert_eq!(no.log_level(), "warning");
        assert_eq!(ev(r#"{"state":"unavailable"}"#).log_line(), "Bosses & NPCs aren't available for this match.");

        let off = ev(r#"{"state":"off","reason":""}"#);
        assert_eq!(off.log_line(), "Bosses & NPCs are off for this match.");
        assert_eq!(off.log_level(), "info");
        assert_eq!(ev(r#"{"state":"off","reason":"Switched off in the profile."}"#).log_line(), "Bosses & NPCs are off: Switched off in the profile.");
    }

    #[test]
    fn broken_fields_do_not_break_the_event() {
        // wrong types or a negative count: text fields become "", the count 0
        let e = ev(r#"{"state":5,"reason":null,"spawned":-3}"#);
        assert_eq!(e, LivingWorldEvent { state: String::new(), reason: String::new(), spawned: 0 });
        assert_eq!(ev(r#"{"state":"active","spawned":"7"}"#).spawned, 0);
        assert_eq!(ev(r#"{"state":"active","spawned":99999999999}"#).spawned, u32::MAX);
        // an unknown state passes through and reads as "off"
        let odd = ev(r#"{"state":"paused"}"#);
        assert_eq!(odd.state, "paused");
        assert_eq!(odd.log_line(), "Bosses & NPCs are off for this match.");
    }

    #[test]
    fn only_changes_reach_the_log() {
        let first = ev(r#"{"state":"active","spawned":1}"#);
        assert!(first.worth_a_log_line(None));
        let more = ev(r#"{"state":"active","spawned":9}"#);
        assert!(!more.worth_a_log_line(Some(&first)), "a new count alone isn't a new line");
        let no = ev(r#"{"state":"unavailable","reason":"x"}"#);
        assert!(no.worth_a_log_line(Some(&more)));
        let other_reason = ev(r#"{"state":"unavailable","reason":"y"}"#);
        assert!(other_reason.worth_a_log_line(Some(&no)));
        assert!(!other_reason.worth_a_log_line(Some(&other_reason)), "the same answer twice is one line");
        // what the server sends today with the switch on: one warning line per match
        let today = ev(r#"{"state":"unavailable","reason":"not built yet for this version","spawned":0}"#);
        assert!(today.is_on());
        assert!(today.worth_a_log_line(None));
        assert_eq!(today.log_line(), "Bosses & NPCs aren't available: not built yet for this version");
        assert_eq!(today.log_level(), "warning");
    }

    #[test]
    fn off_changes_nothing_in_the_log() {
        // the switch is off (with or without a reason) or the state is unknown: never a line
        for json in [
            r#"{"state":"off","reason":""}"#,
            r#"{"state":"off","reason":"Switched off in the profile."}"#,
            r#"{"state":"paused"}"#,
            r#"{}"#,
        ] {
            let e = ev(json);
            assert!(!e.is_on(), "{json}");
            assert!(!e.worth_a_log_line(None), "{json}");
            assert!(!e.worth_a_log_line(Some(&ev(r#"{"state":"active","spawned":3}"#))), "{json}");
        }
        // after an "off", an answer with the switch on gets its line again
        let off = ev(r#"{"state":"off"}"#);
        assert!(ev(r#"{"state":"active"}"#).worth_a_log_line(Some(&off)));
    }
}
