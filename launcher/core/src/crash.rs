//! Reads Fortnite's crash reports and explains them in plain words.
//!
//! Folder: `%LOCALAPPDATA%\FortniteGame\Saved\Crashes\<report>\`
//! It holds, among others, `CrashContext.runtime-xml` with the error message and the call stack.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReport {
    pub id: String,
    pub folder: String,
    /// Seconds since 1970 (for sorting and display)
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

/// All crash reports, newest first (at most `limit`).
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
    // The log in the report helps when the XML is missing or empty
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

/// Reads text from UTF-8 or UTF-16 (with BOM).
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

/// Builds the explanation from the error message, call stack and log.
pub fn analyze(id: &str, folder: &str, time: u64, xml: &str, log_tail: &str) -> CrashReport {
    let error = tag(xml, "ErrorMessage").unwrap_or_default();
    let callstack_raw = tag(xml, "CallStack").unwrap_or_default();
    let version = tag(xml, "BuildVersion")
        .or_else(|| tag(xml, "EngineVersion"))
        .and_then(|v| crate::version::parse_version_string(&v).map(|p| p.version).or(Some(v)))
        .unwrap_or_else(|| "unknown".into());
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
        technical.push(("Error".to_string(), error.lines().next().unwrap_or_default().to_string()));
    }
    if !first_module.is_empty() {
        technical.push(("Module".to_string(), first_module));
    }
    technical.push(("Folder".to_string(), folder.to_string()));

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
            title: "Build files are damaged",
            severity: "high",
            what: "Fortnite closed while loading because some game files are wrong.",
            cause: "One of the big game files (.pak) is broken or incomplete – usually from unpacking or an antivirus program.".into(),
            todo: todo(&["Unpack the build folder again.", "Add the folder as an exception in your antivirus program."]),
        };
    }
    if lower.contains("dxgi_error_device_removed") || lower.contains("device removed") || lower.contains("gpu crash") || lower.contains("d3d device") {
        return Explanation {
            title: "The graphics card gave up",
            severity: "medium",
            what: "The picture froze and Fortnite was closed.",
            cause: "The graphics driver lost its connection to the game. With old builds this often happens with DirectX 12 or with overlays from other programs.".into(),
            todo: todo(&["Start with -d3d11 (Profile → Launch arguments).", "Turn off overlays from Discord, Steam or GeForce Experience.", "Update your graphics driver."]),
        };
    }
    if lower.contains("out of memory") || lower.contains("ran out of memory") {
        return Explanation {
            title: "Out of memory",
            severity: "high",
            what: "Fortnite ran out of free memory (RAM).",
            cause: "The server and the game run at the same time – that needs a lot of RAM.".into(),
            todo: todo(&["Close other programs.", "Start the server without graphics (Settings → Game)."]),
        };
    }
    if lower.contains("gfsdk_aftermath") {
        return Explanation {
            title: "NVIDIA crash helper gets in the way",
            severity: "medium",
            what: "Fortnite crashed in an NVIDIA file.",
            cause: "The file GFSDK_Aftermath_Lib.dll in the build doesn't work well with the old game.".into(),
            todo: todo(&["In Rift go to Library → your build → \"Rename Aftermath file\" (Rift asks first)."]),
        };
    }
    let access_violation = lower.contains("access_violation") || lower.contains("access violation");
    // Our DLLs were called niobium_*.dll before the rename to Rift; older crash reports still name them so.
    let own = |dll: &str| module_lower.contains(&format!("rift_{dll}")) || module_lower.contains(&format!("niobium_{dll}"));
    let (title, what, cause, steps): (&str, &str, String, Vec<&str>) = if own("client") {
        ("Crash in the in-game menu", "Fortnite was closed – the error came from the Rift in-game menu (F9).",
         "The menu touched something in the game that is built differently in this version.".into(),
         vec!["Copy the report and send it to the developer – then the menu can be fixed.", "Until then, turn off the in-game menu in Settings."])
    } else if own("server") {
        ("Crash in the game server", "The server Fortnite was closed – the error came from the game server.",
         "The game server (based on Magnesium) has a bug in this situation.".into(),
         vec!["Copy the report and send it to the developer.", "Try again with another playlist or without Lategame."])
    } else if own("redirect") {
        ("Crash in the redirect", "Fortnite was closed while starting – the error came from the redirect DLL.",
         "The redirect can't find the right spot in this build.".into(),
         vec!["Copy the report and send it to the developer."])
    } else if module_lower.contains("console.dll") || module_lower.contains("atlas") || module_lower.contains("magnesium") || module_lower.contains("tellurium") {
        ("Crash in a DLL that isn't from Rift", "Fortnite was closed – the error came from an extra DLL that isn't part of Rift.",
         format!("The DLL \"{module}\" doesn't fit this Fortnite version or steps in at the wrong moment."),
         vec!["Stop using this DLL together with Rift.", "Rift already brings every DLL it needs."])
    } else if access_violation {
        ("Memory access error", "Fortnite closed all of a sudden.",
         "A part of the game tried to read data that isn't there (any more). This happens more often with old builds.".into(),
         vec!["Start again – it often works the second time.", "If it always happens at the same spot: copy the report and send it to the developer."])
    } else {
        ("Unknown crash", "Fortnite closed unexpectedly.",
         "Rift doesn't know this error yet.".into(),
         vec!["Copy the report and send it to the developer."])
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
        assert_eq!(r.title, "Crash in a DLL that isn't from Rift");
        assert!(r.likely_cause.contains("console.dll"));
        assert_eq!(r.callstack.len(), 3);
        assert_eq!(r.severity, "high");
    }

    #[test]
    fn explains_pak() {
        let r = analyze("y", "f", 0, "", "LogPakFile: Error: Pak chunk signature verification failed!");
        assert_eq!(r.title, "Build files are damaged");
    }

    #[test]
    fn explains_own_client() {
        let xml = XML.replace("console.dll", "rift_client.dll");
        let r = analyze("z", "f", 0, &xml, "");
        assert_eq!(r.title, "Crash in the in-game menu");
        let xml = XML.replace("console.dll", "rift_redirect.dll");
        assert_eq!(analyze("z", "f", 0, &xml, "").title, "Crash in the redirect");
        // a crash report from before the rename (Niobium) still counts as our own DLL
        let xml = XML.replace("console.dll", "niobium_server.dll");
        assert_eq!(analyze("z", "f", 0, &xml, "").title, "Crash in the game server");
        assert!(analyze("z", "f", 0, "", "").what_to_do.iter().all(|s| s.is_ascii()));
    }

    #[test]
    fn decodes_utf16() {
        let mut b = vec![0xFF, 0xFE];
        b.extend("<ErrorMessage>x</ErrorMessage>".encode_utf16().flat_map(|u| u.to_le_bytes()));
        assert_eq!(tag(&decode_text(&b), "ErrorMessage").as_deref(), Some("x"));
    }

    #[test]
    fn lists_folders() {
        let dir = std::env::temp_dir().join(format!("rift-crash-{}", std::process::id()));
        let c = dir.join("UECC-Windows-ABC");
        fs::create_dir_all(&c).unwrap();
        fs::write(c.join("CrashContext.runtime-xml"), XML).unwrap();
        let list = list_in(&dir, 10);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "UECC-Windows-ABC");
        fs::remove_dir_all(&dir).ok();
    }
}
