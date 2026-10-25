//! Trickshot-Parkours: die fertigen Strecken aus `launcher/src/data/parkours.json`.
//!
//! Die Datei steckt fest im Launcher. Beim Start und direkt vor jedem Server-Start schreibt der
//! Launcher sie nach `%LOCALAPPDATA%\Vanity\server\parkours.json`. Dort lesen sie die Server-DLL
//! (Befehl „cheat parkour <id>“) und das F9-Menü (Reiter „Trickshot“).
//!
//! `validate` prüft die Form der Datei. Der Test unten prüft damit die echte Datei, damit ein
//! Tippfehler schon beim Bauen auffällt und nicht erst im Spiel.

use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Inhalt von `launcher/src/data/parkours.json` (dieselbe Datei nutzt auch die Oberfläche).
pub const EMBEDDED: &str = include_str!("../../src/data/parkours.json");

/// Dateiname im Server-Ordner.
pub const FILE_NAME: &str = "parkours.json";

/// Wörter nach „parkour“, die schon Befehle sind – so darf keine Strecke heißen.
pub const RESERVED_IDS: [&str; 4] = ["retry", "clear", "sniper", "list"];

/// Höchstens so lang darf eine id sein (der Befehl „cheat parkour <id>“ bleibt damit kurz).
pub const MAX_ID_LEN: usize = 40;

// Grenzen wie in Server-DLL (VanityParkour.cpp) und F9-Menü (VanityTrickshotTab.cpp).
// Was darüber liegt, würden die beiden still kürzen oder weglassen – darum lehnt `validate` es ab.

/// Höchstens so viele Parkours (das F9-Menü zeigt nicht mehr an).
pub const MAX_PARKOURS: usize = 64;
/// Höchstens so viele Sprung-Teile pro Parkour.
pub const MAX_ELEMENTS: usize = 48;
/// Höchstens so viele Ziel-Bots pro Parkour.
pub const MAX_BOTS: usize = 12;
/// Höchstens so viele Boden-Platten pro Seite einer Plattform.
pub const MAX_TILES_PER_SIDE: u64 = 9;
/// So weit (in Metern, je Richtung) darf ein Teil oder Bot höchstens vom Start weg sein.
pub const MAX_OFFSET_METERS: f64 = 1000.0;
/// So hoch (in Metern) darf ein Parkour höchstens über dir liegen.
pub const MAX_HEIGHT_METERS: f64 = 300.0;
/// So viel Platz (waagerecht, in Metern) bleibt um den Startpunkt `[0, 0]` frei. Dort landet der
/// Spieler beim Laden und bei „parkour retry“. Ein Sprung-Teil oder Bot näher dran würde ihn sofort
/// wegschleudern oder im Weg stehen. Das prüft nur der Launcher – der Server baut, was in der Datei steht.
pub const MIN_START_CLEARANCE_METERS: f64 = 3.0;

/// `%LOCALAPPDATA%\Vanity\server` – hier lesen Server-DLL und F9-Menü.
pub fn server_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join("Vanity").join("server"))
}

/// Ziel-Datei `%LOCALAPPDATA%\Vanity\server\parkours.json`.
pub fn server_file() -> Option<PathBuf> {
    server_dir().map(|d| d.join(FILE_NAME))
}

/// Schreibt die eingebaute Parkour-Liste für Server und F9-Menü (überschreibt jedes Mal).
/// Gibt den Pfad zurück. Fehler sind nie schlimm – der Aufrufer schreibt sie nur ins Log.
pub fn write_for_server() -> Result<PathBuf, String> {
    let path = server_file().ok_or("Ordner %LOCALAPPDATA% nicht gefunden")?;
    write_atomic(&path, EMBEDDED).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(path)
}

/// Schreibt `contents` sicher: erst in eine Hilfsdatei daneben, dann umbenennen.
/// So liest der Server nie eine halb geschriebene Datei. Ordner werden angelegt.
pub fn write_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| FILE_NAME.into());
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_file_name(format!("{file_name}.{}-{n}.tmp", std::process::id()));
    std::fs::write(&tmp, contents)?;
    // Unter Windows ersetzt rename eine vorhandene Datei (MoveFileExW mit REPLACE_EXISTING).
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// Prüft die Form einer Parkour-Datei. Gibt die ids in Datei-Reihenfolge zurück.
///
/// Regeln: es gibt `kinds`, `snipers` und 1 bis [`MAX_PARKOURS`] Parkours. Jeder Parkour hat
/// `id` (nur a–z, 0–9 und „-“, einmalig, kein Befehlswort), `name`, `level` 1–3, `description`,
/// `height` (0 bis [`MAX_HEIGHT_METERS`]), `platform`, höchstens [`MAX_ELEMENTS`] `elements` und
/// höchstens [`MAX_BOTS`] `bots`. Jedes Element nutzt eine Art aus `kinds`. Positionen liegen
/// höchstens [`MAX_OFFSET_METERS`] vom Start weg, aber (waagerecht, egal in welcher Höhe) mindestens
/// [`MIN_START_CLEARANCE_METERS`] neben dem Startpunkt. Plattformen haben 0 bis
/// [`MAX_TILES_PER_SIDE`] Platten pro Seite.
pub fn validate(json: &str) -> Result<Vec<String>, String> {
    let root: Value = serde_json::from_str(json).map_err(|e| format!("kein gültiges JSON: {e}"))?;
    let root = root.as_object().ok_or("oberste Ebene muss ein Objekt sein")?;

    match root.get("version").and_then(Value::as_u64) {
        Some(v) if v >= 1 => {}
        _ => return Err("„version“ fehlt oder ist keine Zahl ab 1".into()),
    }

    // Arten von Sprung-Objekten
    let kinds = root.get("kinds").and_then(Value::as_object).ok_or("„kinds“ fehlt")?;
    if kinds.is_empty() {
        return Err("„kinds“ ist leer".into());
    }
    for (name, kind) in kinds {
        let at = format!("kinds.{name}");
        non_empty_str(kind.get("label"), &format!("{at}.label"))?;
        non_empty_str_list(kind.get("summon"), &format!("{at}.summon"))?;
    }

    non_empty_str_list(root.get("snipers"), "snipers")?;

    let parkours = root.get("parkours").and_then(Value::as_array).ok_or("„parkours“ fehlt")?;
    if parkours.is_empty() {
        return Err("„parkours“ ist leer".into());
    }
    if parkours.len() > MAX_PARKOURS {
        return Err(format!("„parkours“ hat {} Einträge, erlaubt sind höchstens {MAX_PARKOURS}", parkours.len()));
    }

    let mut ids = Vec::with_capacity(parkours.len());
    let mut seen = HashSet::new();
    for (i, p) in parkours.iter().enumerate() {
        let at = format!("parkours[{i}]");
        let id = p.get("id").and_then(Value::as_str).ok_or(format!("{at}.id fehlt"))?;
        check_id(id).map_err(|e| format!("{at}.id „{id}“: {e}"))?;
        if !seen.insert(id.to_string()) {
            return Err(format!("{at}.id „{id}“ gibt es doppelt"));
        }
        let at = format!("parkours[{i}] ({id})");

        non_empty_str(p.get("name"), &format!("{at}.name"))?;
        match p.get("level").and_then(Value::as_u64) {
            Some(1..=3) => {}
            _ => return Err(format!("{at}.level muss 1, 2 oder 3 sein")),
        }
        if !p.get("description").is_some_and(Value::is_string) {
            return Err(format!("{at}.description fehlt"));
        }
        match p.get("height").and_then(Value::as_f64) {
            Some(h) if h.is_finite() && (0.0..=MAX_HEIGHT_METERS).contains(&h) => {}
            _ => return Err(format!("{at}.height muss eine Zahl von 0 bis {MAX_HEIGHT_METERS} sein")),
        }
        tiles(p.get("platform"), &format!("{at}.platform"))?;

        let elements = p.get("elements").and_then(Value::as_array).ok_or(format!("{at}.elements fehlt"))?;
        if elements.len() > MAX_ELEMENTS {
            return Err(format!("{at}.elements hat {} Teile, erlaubt sind höchstens {MAX_ELEMENTS}", elements.len()));
        }
        for (j, el) in elements.iter().enumerate() {
            let eat = format!("{at}.elements[{j}]");
            let kind = el.get("kind").and_then(Value::as_str).ok_or(format!("{eat}.kind fehlt"))?;
            if !kinds.contains_key(kind) {
                return Err(format!("{eat}.kind „{kind}“ steht nicht in „kinds“"));
            }
            position(el.get("at"), &format!("{eat}.at"))?;
            start_clearance(el.get("at"), &format!("{eat}.at"))?;
            if let Some(platform) = el.get("platform") {
                tiles(Some(platform), &format!("{eat}.platform"))?;
            }
        }

        let bots = p.get("bots").and_then(Value::as_array).ok_or(format!("{at}.bots fehlt"))?;
        if bots.len() > MAX_BOTS {
            return Err(format!("{at}.bots hat {} Bots, erlaubt sind höchstens {MAX_BOTS}", bots.len()));
        }
        for (j, bot) in bots.iter().enumerate() {
            let bat = format!("{at}.bots[{j}]");
            position(bot.get("at"), &format!("{bat}.at"))?;
            start_clearance(bot.get("at"), &format!("{bat}.at"))?;
            match bot.get("hp").and_then(Value::as_f64) {
                Some(hp) if (1.0..=500.0).contains(&hp) => {}
                _ => return Err(format!("{bat}.hp muss zwischen 1 und 500 liegen")),
            }
            if let Some(platform) = bot.get("platform") {
                tiles(Some(platform), &format!("{bat}.platform"))?;
            }
        }

        ids.push(id.to_string());
    }
    Ok(ids)
}

/// Erlaubt sind nur Kleinbuchstaben a–z, Ziffern und „-“ (der Server macht alles klein).
fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("ist leer".into());
    }
    if id.len() > MAX_ID_LEN {
        return Err(format!("ist länger als {MAX_ID_LEN} Zeichen"));
    }
    if !id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
        return Err("nur a–z, 0–9 und „-“ erlaubt".into());
    }
    if RESERVED_IDS.contains(&id) {
        return Err("ist schon ein Befehl".into());
    }
    Ok(())
}

fn non_empty_str(v: Option<&Value>, at: &str) -> Result<(), String> {
    match v.and_then(Value::as_str) {
        Some(s) if !s.trim().is_empty() => Ok(()),
        _ => Err(format!("{at} fehlt oder ist leer")),
    }
}

fn non_empty_str_list(v: Option<&Value>, at: &str) -> Result<(), String> {
    let list = v.and_then(Value::as_array).ok_or(format!("{at} fehlt"))?;
    if list.is_empty() {
        return Err(format!("{at} ist leer"));
    }
    for (i, item) in list.iter().enumerate() {
        non_empty_str(Some(item), &format!("{at}[{i}]"))?;
    }
    Ok(())
}

/// `[vorne, rechts, oben]` in Metern, je höchstens [`MAX_OFFSET_METERS`] vom Start weg.
fn position(v: Option<&Value>, at: &str) -> Result<(), String> {
    let list = v.and_then(Value::as_array).ok_or(format!("{at} fehlt"))?;
    if list.len() != 3 || !list.iter().all(|n| n.as_f64().is_some_and(f64::is_finite)) {
        return Err(format!("{at} muss [vorne, rechts, oben] sein"));
    }
    if !list.iter().all(|n| n.as_f64().is_some_and(|m| m.abs() <= MAX_OFFSET_METERS)) {
        return Err(format!("{at} liegt zu weit weg (höchstens {MAX_OFFSET_METERS} m je Richtung)"));
    }
    Ok(())
}

/// Waagerechter Abstand von `[vorne, rechts, …]` zum Startpunkt `[0, 0]`: mindestens
/// [`MIN_START_CLEARANCE_METERS`]. Aufrufen erst nach [`position`] (die Form ist dann schon geprüft).
fn start_clearance(v: Option<&Value>, at: &str) -> Result<(), String> {
    let list = v.and_then(Value::as_array).ok_or(format!("{at} fehlt"))?;
    let forward = list.first().and_then(Value::as_f64).unwrap_or(0.0);
    let right = list.get(1).and_then(Value::as_f64).unwrap_or(0.0);
    let distance = forward.hypot(right);
    if distance < MIN_START_CLEARANCE_METERS {
        return Err(format!(
            "{at} steht nur {distance:.1} m neben dem Startpunkt – dort landet der Spieler. \
             Mindestens {MIN_START_CLEARANCE_METERS} m Abstand"
        ));
    }
    Ok(())
}

/// `[breite, tiefe]` in Boden-Platten (je 5,12 m), 0 = keine Platte.
fn tiles(v: Option<&Value>, at: &str) -> Result<(), String> {
    let list = v.and_then(Value::as_array).ok_or(format!("{at} fehlt"))?;
    if list.len() != 2 || !list.iter().all(|n| n.as_u64().is_some_and(|t| t <= MAX_TILES_PER_SIDE)) {
        return Err(format!("{at} muss [breite, tiefe] mit 0 bis {MAX_TILES_PER_SIDE} Platten sein"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echte_datei_ist_gueltig() {
        let ids = validate(EMBEDDED).expect("launcher/src/data/parkours.json ist ungültig");
        assert!(!ids.is_empty());
        assert!(ids.iter().any(|id| id == "erster-sprung"));
    }

    fn minimal(id: &str, kind: &str, level: u64) -> String {
        format!(
            r#"{{"version":1,"kinds":{{"trampoline":{{"label":"Trampolin","summon":["tire"]}}}},
            "snipers":["heavy_sr"],
            "parkours":[{{"id":"{id}","name":"Test","level":{level},"description":"","height":0,
              "platform":[1,1],"elements":[{{"kind":"{kind}","at":[8,0,0]}}],
              "bots":[{{"at":[20,0,0],"hp":50}}]}}]}}"#
        )
    }

    #[test]
    fn minimal_ist_gueltig() {
        assert_eq!(validate(&minimal("abc-1", "trampoline", 2)).unwrap(), vec!["abc-1".to_string()]);
    }

    #[test]
    fn falsche_ids_werden_abgelehnt() {
        assert!(validate(&minimal("Gross", "trampoline", 1)).is_err());
        assert!(validate(&minimal("mit leerzeichen", "trampoline", 1)).is_err());
        assert!(validate(&minimal("ümlaut", "trampoline", 1)).is_err());
        assert!(validate(&minimal("", "trampoline", 1)).is_err());
        assert!(validate(&minimal("retry", "trampoline", 1)).is_err());
        assert!(validate(&minimal(&"a".repeat(MAX_ID_LEN + 1), "trampoline", 1)).is_err());
    }

    #[test]
    fn unbekannte_art_und_falsche_stufe_werden_abgelehnt() {
        assert!(validate(&minimal("abc", "rakete", 1)).unwrap_err().contains("rakete"));
        assert!(validate(&minimal("abc", "trampoline", 0)).is_err());
        assert!(validate(&minimal("abc", "trampoline", 4)).is_err());
    }

    #[test]
    fn doppelte_id_wird_abgelehnt() {
        let one = minimal("abc", "trampoline", 1);
        let root: Value = serde_json::from_str(&one).unwrap();
        let mut root = root.as_object().unwrap().clone();
        let p = root["parkours"][0].clone();
        root.insert("parkours".into(), Value::Array(vec![p.clone(), p]));
        let err = validate(&Value::Object(root).to_string()).unwrap_err();
        assert!(err.contains("doppelt"), "{err}");
    }

    #[test]
    fn fehlende_felder_werden_abgelehnt() {
        assert!(validate("{}").is_err());
        assert!(validate("[]").is_err());
        assert!(validate("kein json").is_err());
        let no_bots = minimal("abc", "trampoline", 1).replace(r#""bots":[{"at":[20,0,0],"hp":50}]"#, r#""x":1"#);
        assert!(validate(&no_bots).unwrap_err().contains("bots"));
    }

    /// Eine Parkour-Datei als JSON-Wert, damit Tests einzelne Felder ändern können.
    fn minimal_value() -> Value {
        serde_json::from_str(&minimal("abc", "trampoline", 1)).unwrap()
    }

    #[test]
    fn zu_grosse_plattform_wird_abgelehnt() {
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
    fn zu_viele_teile_werden_abgelehnt() {
        let element = serde_json::json!({ "kind": "trampoline", "at": [8, 0, 0] });
        let mut ok = minimal_value();
        ok["parkours"][0]["elements"] = Value::Array(vec![element.clone(); MAX_ELEMENTS]);
        assert!(validate(&ok.to_string()).is_ok());

        let mut too_many = minimal_value();
        too_many["parkours"][0]["elements"] = Value::Array(vec![element; MAX_ELEMENTS + 1]);
        assert!(validate(&too_many.to_string()).unwrap_err().contains("elements"));
    }

    #[test]
    fn zu_viele_bots_werden_abgelehnt() {
        let bot = serde_json::json!({ "at": [20, 0, 0], "hp": 50 });
        let mut ok = minimal_value();
        ok["parkours"][0]["bots"] = Value::Array(vec![bot.clone(); MAX_BOTS]);
        assert!(validate(&ok.to_string()).is_ok());

        let mut too_many = minimal_value();
        too_many["parkours"][0]["bots"] = Value::Array(vec![bot; MAX_BOTS + 1]);
        assert!(validate(&too_many.to_string()).unwrap_err().contains("bots"));
    }

    #[test]
    fn zu_weit_weg_wird_abgelehnt() {
        let mut ok = minimal_value();
        ok["parkours"][0]["elements"][0]["at"] = serde_json::json!([MAX_OFFSET_METERS, -MAX_OFFSET_METERS, 0]);
        assert!(validate(&ok.to_string()).is_ok());

        let mut element = minimal_value();
        element["parkours"][0]["elements"][0]["at"] = serde_json::json!([MAX_OFFSET_METERS + 1.0, 0, 0]);
        assert!(validate(&element.to_string()).unwrap_err().contains("zu weit"));

        let mut bot = minimal_value();
        bot["parkours"][0]["bots"][0]["at"] = serde_json::json!([0, 0, -(MAX_OFFSET_METERS + 1.0)]);
        assert!(validate(&bot.to_string()).unwrap_err().contains("zu weit"));
    }

    #[test]
    fn zu_hoch_wird_abgelehnt() {
        let mut ok = minimal_value();
        ok["parkours"][0]["height"] = serde_json::json!(MAX_HEIGHT_METERS);
        assert!(validate(&ok.to_string()).is_ok());

        let mut too_high = minimal_value();
        too_high["parkours"][0]["height"] = serde_json::json!(MAX_HEIGHT_METERS + 1.0);
        assert!(validate(&too_high.to_string()).unwrap_err().contains("height"));
    }

    #[test]
    fn zu_nah_am_start_wird_abgelehnt() {
        // Dort landet der Spieler: weder Sprung-Teil noch Bot, egal in welcher Höhe.
        for at in [[0.0, 0.0, 0.0], [2.0, 2.0, 0.0], [0.0, -2.9, 5.0], [-1.0, 0.0, -20.0]] {
            let mut element = minimal_value();
            element["parkours"][0]["elements"][0]["at"] = serde_json::json!(at);
            let err = validate(&element.to_string()).unwrap_err();
            assert!(err.contains("elements[0].at") && err.contains("Startpunkt"), "{at:?}: {err}");

            let mut bot = minimal_value();
            bot["parkours"][0]["bots"][0]["at"] = serde_json::json!(at);
            let err = validate(&bot.to_string()).unwrap_err();
            assert!(err.contains("bots[0].at") && err.contains("Startpunkt"), "{at:?}: {err}");
        }

        // Genau am Rand der freien Fläche ist erlaubt.
        let mut ok = minimal_value();
        ok["parkours"][0]["elements"][0]["at"] = serde_json::json!([0.0, -MIN_START_CLEARANCE_METERS, 0.0]);
        ok["parkours"][0]["bots"][0]["at"] = serde_json::json!([MIN_START_CLEARANCE_METERS, 0.0, 0.0]);
        assert!(validate(&ok.to_string()).is_ok());
    }

    #[test]
    fn echte_parkours_lassen_den_start_frei() {
        // Früher stand in „Freies Üben“ ein Sprung-Geysir genau auf dem Startpunkt.
        let root: Value = serde_json::from_str(EMBEDDED).unwrap();
        for p in root["parkours"].as_array().unwrap() {
            for o in p["elements"].as_array().unwrap().iter().chain(p["bots"].as_array().unwrap()) {
                let (f, r) = (o["at"][0].as_f64().unwrap(), o["at"][1].as_f64().unwrap());
                assert!(f.hypot(r) >= MIN_START_CLEARANCE_METERS, "{}: {:?}", p["id"], o["at"]);
            }
        }
    }

    #[test]
    fn zu_viele_parkours_werden_abgelehnt() {
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
        assert!(validate(&make(MAX_PARKOURS + 1)).unwrap_err().contains("höchstens"));
    }

    #[test]
    fn schreiben_legt_ordner_an_und_ueberschreibt() {
        let dir = std::env::temp_dir().join(format!("vanity-parkour-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("server").join(FILE_NAME);
        write_atomic(&path, "alt").unwrap();
        write_atomic(&path, EMBEDDED).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), EMBEDDED);
        // keine Hilfsdateien übrig
        let leftovers = std::fs::read_dir(path.parent().unwrap()).unwrap().count();
        assert_eq!(leftovers, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
