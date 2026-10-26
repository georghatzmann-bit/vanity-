//! Trickshot parkours: the ready-made courses from `launcher/src/data/parkours.json`.
//!
//! The file is built into the launcher. At start and right before every server start the launcher
//! writes it to `%LOCALAPPDATA%\Niobium\server\parkours.json`. The server DLL (command
//! "cheat parkour <id>") and the F9 menu ("Trickshot" tab) read it there.
//!
//! `validate` checks the shape of the file. The test below checks the real file with it, so a typo
//! shows up when building and not only in the game.

use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Contents of `launcher/src/data/parkours.json` (the UI uses the same file).
pub const EMBEDDED: &str = include_str!("../../src/data/parkours.json");

/// File name in the server folder.
pub const FILE_NAME: &str = "parkours.json";

/// Words after "parkour" that are already commands – no course may use them as its id.
pub const RESERVED_IDS: [&str; 4] = ["retry", "clear", "sniper", "list"];

/// Longest allowed id (keeps the command "cheat parkour <id>" short).
pub const MAX_ID_LEN: usize = 40;

// Limits as in the server DLL (NiobiumParkour.cpp) and the F9 menu (NiobiumTrickshotTab.cpp).
// Both would silently cut or skip anything above them – that's why `validate` refuses it.

/// At most this many parkours (the F9 menu doesn't show more).
pub const MAX_PARKOURS: usize = 64;
/// At most this many jump pieces per parkour.
pub const MAX_ELEMENTS: usize = 48;
/// At most this many target bots per parkour.
pub const MAX_BOTS: usize = 12;
/// At most this many floor tiles per side of a platform.
pub const MAX_TILES_PER_SIDE: u64 = 9;
/// How far (in metres, per direction) a piece or bot may be from the start.
pub const MAX_OFFSET_METERS: f64 = 1000.0;
/// How high (in metres) a parkour may be above you.
pub const MAX_HEIGHT_METERS: f64 = 300.0;
/// This much room (horizontally, in metres) stays free around the start point `[0, 0]`. The player
/// lands there when loading and on "parkour retry". A jump piece or bot closer than that would launch
/// them right away or stand in the way. Only the launcher checks this – the server builds whatever is in the file.
pub const MIN_START_CLEARANCE_METERS: f64 = 3.0;

/// `%LOCALAPPDATA%\Niobium\server` – the server DLL and the F9 menu read from here.
pub fn server_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join(crate::profiles::APP_DIR).join("server"))
}

/// Target file `%LOCALAPPDATA%\Niobium\server\parkours.json`.
pub fn server_file() -> Option<PathBuf> {
    server_dir().map(|d| d.join(FILE_NAME))
}

/// Writes the built-in parkour list for the server and the F9 menu (overwrites every time).
/// Returns the path. Errors are never serious – the caller only logs them.
pub fn write_for_server() -> Result<PathBuf, String> {
    let path = server_file().ok_or("Couldn't find the %LOCALAPPDATA% folder")?;
    write_atomic(&path, EMBEDDED).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(path)
}

/// Writes `contents` safely: first to a helper file next to it, then renames it.
/// So the server never reads a half-written file. Folders are created.
pub fn write_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| FILE_NAME.into());
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_file_name(format!("{file_name}.{}-{n}.tmp", std::process::id()));
    std::fs::write(&tmp, contents)?;
    // On Windows, rename replaces an existing file (MoveFileExW with REPLACE_EXISTING).
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// Checks the shape of a parkour file. Returns the ids in file order.
///
/// Rules: there are `kinds`, `snipers` and 1 to [`MAX_PARKOURS`] parkours. Every parkour has an
/// `id` (only a–z, 0–9 and "-", unique, not a command word), `name`, `level` 1–3, `description`,
/// `height` (0 to [`MAX_HEIGHT_METERS`]), `platform`, at most [`MAX_ELEMENTS`] `elements` and
/// at most [`MAX_BOTS`] `bots`. Every element uses a kind from `kinds`. Positions are at most
/// [`MAX_OFFSET_METERS`] from the start, but (horizontally, at any height) at least
/// [`MIN_START_CLEARANCE_METERS`] away from the start point. Platforms have 0 to
/// [`MAX_TILES_PER_SIDE`] tiles per side.
pub fn validate(json: &str) -> Result<Vec<String>, String> {
    let root: Value = serde_json::from_str(json).map_err(|e| format!("not valid JSON: {e}"))?;
    let root = root.as_object().ok_or("the top level must be an object")?;

    match root.get("version").and_then(Value::as_u64) {
        Some(v) if v >= 1 => {}
        _ => return Err("\"version\" is missing or not a number from 1 up".into()),
    }

    // Kinds of jump objects
    let kinds = root.get("kinds").and_then(Value::as_object).ok_or("\"kinds\" is missing")?;
    if kinds.is_empty() {
        return Err("\"kinds\" is empty".into());
    }
    for (name, kind) in kinds {
        let at = format!("kinds.{name}");
        non_empty_str(kind.get("label"), &format!("{at}.label"))?;
        non_empty_str_list(kind.get("summon"), &format!("{at}.summon"))?;
    }

    non_empty_str_list(root.get("snipers"), "snipers")?;

    let parkours = root.get("parkours").and_then(Value::as_array).ok_or("\"parkours\" is missing")?;
    if parkours.is_empty() {
        return Err("\"parkours\" is empty".into());
    }
    if parkours.len() > MAX_PARKOURS {
        return Err(format!("\"parkours\" has {} entries, at most {MAX_PARKOURS} are allowed", parkours.len()));
    }

    let mut ids = Vec::with_capacity(parkours.len());
    let mut seen = HashSet::new();
    for (i, p) in parkours.iter().enumerate() {
        let at = format!("parkours[{i}]");
        let id = p.get("id").and_then(Value::as_str).ok_or(format!("{at}.id is missing"))?;
        check_id(id).map_err(|e| format!("{at}.id \"{id}\": {e}"))?;
        if !seen.insert(id.to_string()) {
            return Err(format!("{at}.id \"{id}\" is used twice"));
        }
        let at = format!("parkours[{i}] ({id})");

        non_empty_str(p.get("name"), &format!("{at}.name"))?;
        match p.get("level").and_then(Value::as_u64) {
            Some(1..=3) => {}
            _ => return Err(format!("{at}.level must be 1, 2 or 3")),
        }
        if !p.get("description").is_some_and(Value::is_string) {
            return Err(format!("{at}.description is missing"));
        }
        match p.get("height").and_then(Value::as_f64) {
            Some(h) if h.is_finite() && (0.0..=MAX_HEIGHT_METERS).contains(&h) => {}
            _ => return Err(format!("{at}.height must be a number from 0 to {MAX_HEIGHT_METERS}")),
        }
        tiles(p.get("platform"), &format!("{at}.platform"))?;

        let elements = p.get("elements").and_then(Value::as_array).ok_or(format!("{at}.elements is missing"))?;
        if elements.len() > MAX_ELEMENTS {
            return Err(format!("{at}.elements has {} pieces, at most {MAX_ELEMENTS} are allowed", elements.len()));
        }
        for (j, el) in elements.iter().enumerate() {
            let eat = format!("{at}.elements[{j}]");
            let kind = el.get("kind").and_then(Value::as_str).ok_or(format!("{eat}.kind is missing"))?;
            if !kinds.contains_key(kind) {
                return Err(format!("{eat}.kind \"{kind}\" is not in \"kinds\""));
            }
            position(el.get("at"), &format!("{eat}.at"))?;
            start_clearance(el.get("at"), &format!("{eat}.at"))?;
            if let Some(platform) = el.get("platform") {
                tiles(Some(platform), &format!("{eat}.platform"))?;
            }
        }

        let bots = p.get("bots").and_then(Value::as_array).ok_or(format!("{at}.bots is missing"))?;
        if bots.len() > MAX_BOTS {
            return Err(format!("{at}.bots has {} bots, at most {MAX_BOTS} are allowed", bots.len()));
        }
        for (j, bot) in bots.iter().enumerate() {
            let bat = format!("{at}.bots[{j}]");
            position(bot.get("at"), &format!("{bat}.at"))?;
            start_clearance(bot.get("at"), &format!("{bat}.at"))?;
            match bot.get("hp").and_then(Value::as_f64) {
                Some(hp) if (1.0..=500.0).contains(&hp) => {}
                _ => return Err(format!("{bat}.hp must be between 1 and 500")),
            }
            if let Some(platform) = bot.get("platform") {
                tiles(Some(platform), &format!("{bat}.platform"))?;
            }
        }

        ids.push(id.to_string());
    }
    Ok(ids)
}

/// Only lower-case letters a–z, digits and "-" are allowed (the server makes everything lower case).
fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("is empty".into());
    }
    if id.len() > MAX_ID_LEN {
        return Err(format!("is longer than {MAX_ID_LEN} characters"));
    }
    if !id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
        return Err("only a–z, 0–9 and \"-\" are allowed".into());
    }
    if RESERVED_IDS.contains(&id) {
        return Err("is already a command".into());
    }
    Ok(())
}

fn non_empty_str(v: Option<&Value>, at: &str) -> Result<(), String> {
    match v.and_then(Value::as_str) {
        Some(s) if !s.trim().is_empty() => Ok(()),
        _ => Err(format!("{at} is missing or empty")),
    }
}

fn non_empty_str_list(v: Option<&Value>, at: &str) -> Result<(), String> {
    let list = v.and_then(Value::as_array).ok_or(format!("{at} is missing"))?;
    if list.is_empty() {
        return Err(format!("{at} is empty"));
    }
    for (i, item) in list.iter().enumerate() {
        non_empty_str(Some(item), &format!("{at}[{i}]"))?;
    }
    Ok(())
}

/// `[forward, right, up]` in metres, each at most [`MAX_OFFSET_METERS`] from the start.
fn position(v: Option<&Value>, at: &str) -> Result<(), String> {
    let list = v.and_then(Value::as_array).ok_or(format!("{at} is missing"))?;
    if list.len() != 3 || !list.iter().all(|n| n.as_f64().is_some_and(f64::is_finite)) {
        return Err(format!("{at} must be [forward, right, up]"));
    }
    if !list.iter().all(|n| n.as_f64().is_some_and(|m| m.abs() <= MAX_OFFSET_METERS)) {
        return Err(format!("{at} is too far away (at most {MAX_OFFSET_METERS} m per direction)"));
    }
    Ok(())
}

/// Horizontal distance of `[forward, right, …]` from the start point `[0, 0]`: at least
/// [`MIN_START_CLEARANCE_METERS`]. Call only after [`position`] (the shape is checked then).
fn start_clearance(v: Option<&Value>, at: &str) -> Result<(), String> {
    let list = v.and_then(Value::as_array).ok_or(format!("{at} is missing"))?;
    let forward = list.first().and_then(Value::as_f64).unwrap_or(0.0);
    let right = list.get(1).and_then(Value::as_f64).unwrap_or(0.0);
    let distance = forward.hypot(right);
    if distance < MIN_START_CLEARANCE_METERS {
        return Err(format!(
            "{at} is only {distance:.1} m from the start point – the player lands there. \
             Keep at least {MIN_START_CLEARANCE_METERS} m away"
        ));
    }
    Ok(())
}

/// `[width, depth]` in floor tiles (5.12 m each), 0 = no tile.
fn tiles(v: Option<&Value>, at: &str) -> Result<(), String> {
    let list = v.and_then(Value::as_array).ok_or(format!("{at} is missing"))?;
    if list.len() != 2 || !list.iter().all(|n| n.as_u64().is_some_and(|t| t <= MAX_TILES_PER_SIDE)) {
        return Err(format!("{at} must be [width, depth] with 0 to {MAX_TILES_PER_SIDE} tiles"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_file_is_valid() {
        let ids = validate(EMBEDDED).expect("launcher/src/data/parkours.json is invalid");
        assert_eq!(
            ids,
            [
                "first-jump",
                "geyser-shot",
                "trampoline-stairs",
                "double-target",
                "spin-360",
                "long-shot",
                "jump-chain",
                "ground-course",
                "free-practice"
            ]
        );
    }

    #[test]
    fn real_file_is_english() {
        let root: Value = serde_json::from_str(EMBEDDED).unwrap();
        let names: Vec<&str> = root["parkours"].as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            [
                "First Jump",
                "Geyser Shot",
                "Trampoline Stairs",
                "Double Target",
                "360 Spin",
                "Long Shot",
                "Jump Chain",
                "Ground Course",
                "Free Practice"
            ]
        );
        let labels: Vec<&str> = ["trampoline", "launcher", "sideLauncher"].iter().map(|k| root["kinds"][k]["label"].as_str().unwrap()).collect();
        assert_eq!(labels, ["Trampoline", "Launcher", "Side launcher"]);
        // no German left (umlauts, German quote marks)
        assert!(!EMBEDDED.chars().any(|c| "äöüÄÖÜß„“".contains(c)), "German text in parkours.json");
    }

    fn minimal(id: &str, kind: &str, level: u64) -> String {
        format!(
            r#"{{"version":1,"kinds":{{"trampoline":{{"label":"Trampoline","summon":["tire"]}}}},
            "snipers":["heavy_sr"],
            "parkours":[{{"id":"{id}","name":"Test","level":{level},"description":"","height":0,
              "platform":[1,1],"elements":[{{"kind":"{kind}","at":[8,0,0]}}],
              "bots":[{{"at":[20,0,0],"hp":50}}]}}]}}"#
        )
    }

    #[test]
    fn minimal_is_valid() {
        assert_eq!(validate(&minimal("abc-1", "trampoline", 2)).unwrap(), vec!["abc-1".to_string()]);
    }

    #[test]
    fn bad_ids_are_refused() {
        assert!(validate(&minimal("Gross", "trampoline", 1)).is_err());
        assert!(validate(&minimal("with spaces", "trampoline", 1)).is_err());
        assert!(validate(&minimal("ümlaut", "trampoline", 1)).is_err());
        assert!(validate(&minimal("", "trampoline", 1)).is_err());
        assert!(validate(&minimal("retry", "trampoline", 1)).is_err());
        assert!(validate(&minimal(&"a".repeat(MAX_ID_LEN + 1), "trampoline", 1)).is_err());
    }

    #[test]
    fn unknown_kind_and_bad_level_are_refused() {
        assert!(validate(&minimal("abc", "rocket", 1)).unwrap_err().contains("rocket"));
        assert!(validate(&minimal("abc", "trampoline", 0)).is_err());
        assert!(validate(&minimal("abc", "trampoline", 4)).is_err());
    }

    #[test]
    fn duplicate_id_is_refused() {
        let one = minimal("abc", "trampoline", 1);
        let root: Value = serde_json::from_str(&one).unwrap();
        let mut root = root.as_object().unwrap().clone();
        let p = root["parkours"][0].clone();
        root.insert("parkours".into(), Value::Array(vec![p.clone(), p]));
        let err = validate(&Value::Object(root).to_string()).unwrap_err();
        assert!(err.contains("twice"), "{err}");
    }

    #[test]
    fn missing_fields_are_refused() {
        assert!(validate("{}").is_err());
        assert!(validate("[]").is_err());
        assert!(validate("not json").is_err());
        let no_bots = minimal("abc", "trampoline", 1).replace(r#""bots":[{"at":[20,0,0],"hp":50}]"#, r#""x":1"#);
        assert!(validate(&no_bots).unwrap_err().contains("bots"));
    }

    /// A parkour file as a JSON value, so tests can change single fields.
    fn minimal_value() -> Value {
        serde_json::from_str(&minimal("abc", "trampoline", 1)).unwrap()
    }

    #[test]
    fn too_big_platform_is_refused() {
        let mut ok = minimal_value();
        ok["parkours"][0]["platform"] = serde_json::json!([MAX_TILES_PER_SIDE, MAX_TILES_PER_SIDE]);
        ok["parkours"][0]["elements"][0]["platform"] = serde_json::json!([0, MAX_TILES_PER_SIDE]);
        assert!(validate(&ok.to_string()).is_ok());

        let mut start = minimal_value();
        start["parkours"][0]["platform"] = serde_json::json!([MAX_TILES_PER_SIDE + 1, 1]);
        assert!(validate(&start.to_string()).unwrap_err().contains("platform"));

        let mut element = minimal_value();
        element["parkours"][0]["elements"][0]["platform"] = serde_json::json!([1, MAX_TILES_PER_SIDE + 1]);
        assert!(validate(&element.to_string()).unwrap_err().contains("elements[0].platform"));

        let mut bot = minimal_value();
        bot["parkours"][0]["bots"][0]["platform"] = serde_json::json!([MAX_TILES_PER_SIDE + 1, 1]);
        assert!(validate(&bot.to_string()).unwrap_err().contains("bots[0].platform"));
    }

    #[test]
    fn too_many_pieces_are_refused() {
        let element = serde_json::json!({ "kind": "trampoline", "at": [8, 0, 0] });
        let mut ok = minimal_value();
        ok["parkours"][0]["elements"] = Value::Array(vec![element.clone(); MAX_ELEMENTS]);
        assert!(validate(&ok.to_string()).is_ok());

        let mut too_many = minimal_value();
        too_many["parkours"][0]["elements"] = Value::Array(vec![element; MAX_ELEMENTS + 1]);
        assert!(validate(&too_many.to_string()).unwrap_err().contains("elements"));
    }

    #[test]
    fn too_many_bots_are_refused() {
        let bot = serde_json::json!({ "at": [20, 0, 0], "hp": 50 });
        let mut ok = minimal_value();
        ok["parkours"][0]["bots"] = Value::Array(vec![bot.clone(); MAX_BOTS]);
        assert!(validate(&ok.to_string()).is_ok());

        let mut too_many = minimal_value();
        too_many["parkours"][0]["bots"] = Value::Array(vec![bot; MAX_BOTS + 1]);
        assert!(validate(&too_many.to_string()).unwrap_err().contains("bots"));
    }

    #[test]
    fn too_far_away_is_refused() {
        let mut ok = minimal_value();
        ok["parkours"][0]["elements"][0]["at"] = serde_json::json!([MAX_OFFSET_METERS, -MAX_OFFSET_METERS, 0]);
        assert!(validate(&ok.to_string()).is_ok());

        let mut element = minimal_value();
        element["parkours"][0]["elements"][0]["at"] = serde_json::json!([MAX_OFFSET_METERS + 1.0, 0, 0]);
        assert!(validate(&element.to_string()).unwrap_err().contains("too far"));

        let mut bot = minimal_value();
        bot["parkours"][0]["bots"][0]["at"] = serde_json::json!([0, 0, -(MAX_OFFSET_METERS + 1.0)]);
        assert!(validate(&bot.to_string()).unwrap_err().contains("too far"));
    }

    #[test]
    fn too_high_is_refused() {
        let mut ok = minimal_value();
        ok["parkours"][0]["height"] = serde_json::json!(MAX_HEIGHT_METERS);
        assert!(validate(&ok.to_string()).is_ok());

        let mut too_high = minimal_value();
        too_high["parkours"][0]["height"] = serde_json::json!(MAX_HEIGHT_METERS + 1.0);
        assert!(validate(&too_high.to_string()).unwrap_err().contains("height"));
    }

    #[test]
    fn too_close_to_the_start_is_refused() {
        // The player lands there: no jump piece and no bot, at any height.
        for at in [[0.0, 0.0, 0.0], [2.0, 2.0, 0.0], [0.0, -2.9, 5.0], [-1.0, 0.0, -20.0]] {
            let mut element = minimal_value();
            element["parkours"][0]["elements"][0]["at"] = serde_json::json!(at);
            let err = validate(&element.to_string()).unwrap_err();
            assert!(err.contains("elements[0].at") && err.contains("start point"), "{at:?}: {err}");

            let mut bot = minimal_value();
            bot["parkours"][0]["bots"][0]["at"] = serde_json::json!(at);
            let err = validate(&bot.to_string()).unwrap_err();
            assert!(err.contains("bots[0].at") && err.contains("start point"), "{at:?}: {err}");
        }

        // Exactly at the edge of the free area is allowed.
        let mut ok = minimal_value();
        ok["parkours"][0]["elements"][0]["at"] = serde_json::json!([0.0, -MIN_START_CLEARANCE_METERS, 0.0]);
        ok["parkours"][0]["bots"][0]["at"] = serde_json::json!([MIN_START_CLEARANCE_METERS, 0.0, 0.0]);
        assert!(validate(&ok.to_string()).is_ok());
    }

    #[test]
    fn real_parkours_keep_the_start_free() {
        // "Free Practice" once had a launcher right on the start point.
        let root: Value = serde_json::from_str(EMBEDDED).unwrap();
        for p in root["parkours"].as_array().unwrap() {
            for o in p["elements"].as_array().unwrap().iter().chain(p["bots"].as_array().unwrap()) {
                let (f, r) = (o["at"][0].as_f64().unwrap(), o["at"][1].as_f64().unwrap());
                assert!(f.hypot(r) >= MIN_START_CLEARANCE_METERS, "{}: {:?}", p["id"], o["at"]);
            }
        }
    }

    #[test]
    fn too_many_parkours_are_refused() {
        let make = |count: usize| {
            let mut root = minimal_value();
            let template = root["parkours"][0].clone();
            let list = (0..count)
                .map(|i| {
                    let mut p = template.clone();
                    p["id"] = Value::String(format!("p-{i}"));
                    p
                })
                .collect();
            root["parkours"] = Value::Array(list);
            root.to_string()
        };
        assert!(validate(&make(MAX_PARKOURS)).is_ok());
        assert!(validate(&make(MAX_PARKOURS + 1)).unwrap_err().contains("at most"));
    }

    #[test]
    fn writing_creates_folders_and_overwrites() {
        let dir = std::env::temp_dir().join(format!("niobium-parkour-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("server").join(FILE_NAME);
        write_atomic(&path, "old").unwrap();
        write_atomic(&path, EMBEDDED).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), EMBEDDED);
        // no helper files left
        let leftovers = std::fs::read_dir(path.parent().unwrap()).unwrap().count();
        assert_eq!(leftovers, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
