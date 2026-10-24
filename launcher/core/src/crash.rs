//! Liest Fortnites Absturzberichte und erklärt sie in einfacher Sprache.
//!
//! Ordner: `%LOCALAPPDATA%\FortniteGame\Saved\Crashes\<Bericht>\`
//! Darin u. a. `CrashContext.runtime-xml` mit Fehlermeldung und Aufrufliste.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReport {
    pub id: String,
    pub folder: String,
    /// Sekunden seit 1970 (für Sortierung und Anzeige)
    pub time: u64,
    pub version: String,
    pub title: String,
    pub severity: &'static str,
    pub what_happened: String,
    pub likely_cause: String,
    pub what_to_do: Vec<String>,
    pub technical: Vec<(String, String)>,
    pub callstack: Vec<String>,
}

pub fn crashes_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join("FortniteGame").join("Saved").join("Crashes"))
}

/// Alle Absturzberichte, neueste zuerst (höchstens `limit`).
pub fn list(limit: usize) -> Vec<CrashReport> {
    let Some(dir) = crashes_dir() else { return vec![] };
    list_in(&dir, limit)
}

pub fn list_in(dir: &Path, limit: usize) -> Vec<CrashReport> {
    let Ok(entries) = fs::read_dir(dir) else { return vec![] };
    let mut folders: Vec<(u64, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .map(|e| {
            let t = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            (t, e.path())
        })
        .collect();
    folders.sort_by(|a, b| b.0.cmp(&a.0));
    folders
        .into_iter()
        .take(limit)
        .filter_map(|(t, p)| analyze_folder(&p, t))
        .collect()
}

fn analyze_folder(folder: &Path, time: u64) -> Option<CrashReport> {
    let xml = fs::read_dir(folder)
        .ok()?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(".runtime-xml")))
        .and_then(|p| fs::read(p).ok())
        .map(|b| decode_text(&b))
        .unwrap_or_default();
    // Das Log im Bericht hilft, wenn die XML fehlt oder leer ist
    let log_tail = fs::read_dir(folder)
        .ok()?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("log")))
        .and_then(|p| fs::read(p).ok())
        .map(|b| {
            let text = decode_text(&b);
            let lines: Vec<&str> = text.lines().collect();
            lines[lines.len().saturating_sub(60)..].join("\n")
        })
        .unwrap_or_default();

    let id = folder.file_name()?.to_string_lossy().into_owned();
    Some(analyze(&id, &folder.to_string_lossy(), time, &xml, &log_tail))
}

/// Text aus UTF-8 oder UTF-16 (mit BOM) lesen.
fn decode_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let units: Vec<u16> = bytes[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&units);
    }
    let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    String::from_utf8_lossy(b).into_owned()
}

fn tag(xml: &str, name: &str) -> Option<String> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(unescape(xml[start..end].trim()))
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#10;", "\n")
        .replace("&#13;", "")
        .replace("&amp;", "&")
}

struct Explanation {
    title: &'static str,
    severity: &'static str,
    what: &'static str,
    cause: String,
    todo: Vec<String>,
}

/// Erstellt die Erklärung aus Fehlermeldung, Aufrufliste und Log.
pub fn analyze(id: &str, folder: &str, time: u64, xml: &str, log_tail: &str) -> CrashReport {
    let error = tag(xml, "ErrorMessage").unwrap_or_default();
    let callstack_raw = tag(xml, "CallStack").unwrap_or_default();
    let version = tag(xml, "BuildVersion")
        .or_else(|| tag(xml, "EngineVersion"))
        .and_then(|v| crate::version::parse_version_string(&v).map(|p| p.version).or(Some(v)))
        .unwrap_or_else(|| "unbekannt".into());
    let callstack: Vec<String> = callstack_raw
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .take(25)
        .map(str::to_string)
        .collect();
    let haystack = format!("{error}\n{callstack_raw}\n{log_tail}");
    let lower = haystack.to_ascii_lowercase();
    let first_module = callstack
        .iter()
        .find_map(|l| l.split('!').next().map(|m| m.trim().to_string()))
        .unwrap_or_default();

    let e = explain(&lower, &first_module.to_ascii_lowercase(), &first_module);

    let mut technical = vec![];
    if !error.is_empty() {
        technical.push(("Fehler".to_string(), error.lines().next().unwrap_or_default().to_string()));
    }
    if !first_module.is_empty() {
        technical.push(("Modul".to_string(), first_module));
    }
    technical.push(("Ordner".to_string(), folder.to_string()));

    CrashReport {
        id: id.to_string(),
        folder: folder.to_string(),
        time,
        version,
        title: e.title.to_string(),
        severity: e.severity,
        what_happened: e.what.to_string(),
        likely_cause: e.cause,
        what_to_do: e.todo,
        technical,
        callstack,
    }
}

fn explain(lower: &str, module_lower: &str, module: &str) -> Explanation {
    let todo = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();

    if lower.contains("pak chunk signature") || lower.contains("when 0 bytes remain") || lower.contains("corrupt") {
        return Explanation {
            title: "Build-Dateien beschädigt",
            severity: "high",
            what: "Fortnite hat sich beim Laden geschlossen, weil Spieldateien nicht stimmen.",
            cause: "Eine der großen Spieldateien (.pak) ist kaputt oder unvollständig – meistens beim Entpacken oder durch ein Virenprogramm.".into(),
            todo: todo(&["Den Build-Ordner neu entpacken.", "Den Ordner im Virenprogramm als Ausnahme eintragen."]),
        };
    }
    if lower.contains("dxgi_error_device_removed") || lower.contains("device removed") || lower.contains("gpu crash") || lower.contains("d3d device") {
        return Explanation {
            title: "Grafikkarte hat aufgegeben",
            severity: "medium",
            what: "Das Bild ist eingefroren und Fortnite wurde beendet.",
            cause: "Der Grafiktreiber hat die Verbindung zum Spiel verloren. Bei alten Builds passiert das oft mit DirectX 12 oder mit Overlays anderer Programme.".into(),
            todo: todo(&["Mit -d3d11 starten (Profil → Startargumente).", "Overlays von Discord, Steam oder GeForce Experience ausschalten.", "Grafiktreiber aktualisieren."]),
        };
    }
    if lower.contains("out of memory") || lower.contains("ran out of memory") {
        return Explanation {
            title: "Arbeitsspeicher voll",
            severity: "high",
            what: "Fortnite hatte keinen freien Arbeitsspeicher mehr.",
            cause: "Server und Spiel laufen gleichzeitig – das braucht viel RAM.".into(),
            todo: todo(&["Andere Programme schließen.", "Server ohne Grafik starten (Einstellungen → Spiel)."]),
        };
    }
    if lower.contains("gfsdk_aftermath") {
        return Explanation {
            title: "NVIDIA-Absturzhilfe stört",
            severity: "medium",
            what: "Fortnite ist in einer NVIDIA-Datei abgestürzt.",
            cause: "Die Datei GFSDK_Aftermath_Lib.dll im Build verträgt sich nicht mit dem alten Spiel.".into(),
            todo: todo(&["In Vanity unter Bibliothek → Build → „Aftermath-Datei umbenennen“ (Vanity fragt vorher)."]),
        };
    }
    let access_violation = lower.contains("access_violation") || lower.contains("access violation");
    let (title, what, cause, steps): (&str, &str, String, Vec<&str>) = if module_lower.contains("vanity_client") {
        ("Absturz im Ingame-Menü", "Fortnite wurde beendet – der Fehler kam aus dem Vanity-Ingame-Menü.",
         "Das Menü hat auf etwas im Spiel zugegriffen, das in dieser Version anders aufgebaut ist.".into(),
         vec!["Den Bericht kopieren und an mich schicken – dann kann ich das Menü reparieren.", "Bis dahin in Einstellungen das Ingame-Menü ausschalten."])
    } else if module_lower.contains("vanity_server") {
        ("Absturz im Game Server", "Der Server-Fortnite wurde beendet – der Fehler kam aus dem Game Server.",
         "Der Game Server (Magnesium-Basis) hat in dieser Situation einen Fehler.".into(),
         vec!["Den Bericht kopieren und an mich schicken.", "Mit einer anderen Playlist oder ohne Lategame erneut versuchen."])
    } else if module_lower.contains("vanity_redirect") {
        ("Absturz in der Umleitung", "Fortnite wurde beim Start beendet – der Fehler kam aus der Umleitungs-DLL.",
         "Die Umleitung findet in diesem Build die passende Stelle nicht.".into(),
         vec!["Den Bericht kopieren und an mich schicken."])
    } else if module_lower.contains("console.dll") || module_lower.contains("atlas") || module_lower.contains("magnesium") || module_lower.contains("tellurium") {
        ("Absturz in einer fremden DLL", "Fortnite wurde beendet – der Fehler kam aus einer Zusatz-DLL, die nicht von Vanity ist.",
         format!("Die DLL „{module}“ passt nicht zu dieser Fortnite-Version oder greift im falschen Moment zu."),
         vec!["Diese DLL nicht mehr zusammen mit Vanity verwenden.", "Vanity bringt alle nötigen DLLs selbst mit."])
    } else if access_violation {
        ("Unerlaubter Speicherzugriff", "Fortnite wurde plötzlich beendet.",
         "Ein Programmteil wollte Daten lesen, die es nicht (mehr) gibt. Das passiert bei alten Builds häufiger.".into(),
         vec!["Noch einmal starten – oft klappt es beim zweiten Mal.", "Wenn es immer an derselben Stelle passiert: Bericht kopieren und an mich schicken."])
    } else {
        ("Unbekannter Absturz", "Fortnite wurde unerwartet beendet.",
         "Vanity kennt diesen Fehler noch nicht.".into(),
         vec!["Den Bericht kopieren und an mich schicken."])
    };
    Explanation { title, severity: if access_violation { "high" } else { "medium" }, what, cause, todo: steps.iter().map(|s| s.to_string()).collect() }
}

#[cfg(test)]
mod tests {
    use super::*;

    const XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<FGenericCrashContext>
  <RuntimeProperties>
    <ErrorMessage>Unhandled Exception: EXCEPTION_ACCESS_VIOLATION reading address 0x0000000000000038</ErrorMessage>
    <BuildVersion>++Fortnite+Release-19.40-CL-19215531</BuildVersion>
    <CallStack>console.dll!UnknownFunction []
FortniteClient-Win64-Shipping.exe!UConsole::ConsoleCommand()
kernel32.dll!BaseThreadInitThunk()</CallStack>
  </RuntimeProperties>
</FGenericCrashContext>"#;

    #[test]
    fn explains_foreign_console_dll() {
        let r = analyze("x", "C:\\Crashes\\x", 0, XML, "");
        assert_eq!(r.version, "19.40");
        assert_eq!(r.title, "Absturz in einer fremden DLL");
        assert!(r.likely_cause.contains("console.dll"));
        assert_eq!(r.callstack.len(), 3);
        assert_eq!(r.severity, "high");
    }

    #[test]
    fn explains_pak() {
        let r = analyze("y", "f", 0, "", "LogPakFile: Error: Pak chunk signature verification failed!");
        assert_eq!(r.title, "Build-Dateien beschädigt");
    }

    #[test]
    fn explains_own_client() {
        let xml = XML.replace("console.dll", "vanity_client.dll");
        let r = analyze("z", "f", 0, &xml, "");
        assert_eq!(r.title, "Absturz im Ingame-Menü");
    }

    #[test]
    fn decodes_utf16() {
        let mut b = vec![0xFF, 0xFE];
        b.extend("<ErrorMessage>x</ErrorMessage>".encode_utf16().flat_map(|u| u.to_le_bytes()));
        assert_eq!(tag(&decode_text(&b), "ErrorMessage").as_deref(), Some("x"));
    }

    #[test]
    fn lists_folders() {
        let dir = std::env::temp_dir().join(format!("vanity-crash-{}", std::process::id()));
        let c = dir.join("UECC-Windows-ABC");
        fs::create_dir_all(&c).unwrap();
        fs::write(c.join("CrashContext.runtime-xml"), XML).unwrap();
        let list = list_in(&dir, 10);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "UECC-Windows-ABC");
        fs::remove_dir_all(&dir).ok();
    }
}
