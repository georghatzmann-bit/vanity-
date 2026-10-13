//! Steam-Bibliothek: Installationsort finden, `libraryfolders.vdf` und `appmanifest_*.acf` lesen.

use std::fs;
use std::path::{Path, PathBuf};

use super::vdf;
use crate::models::{GameKind, GameSource, LaunchConfig, ScannedEntry};
use crate::tracker::normalize_path;
use crate::util::display_path;

/// Steamworks Common Redistributables und ähnliche Pakete sind keine Spiele.
const NON_GAME_APPIDS: [&str; 4] = ["228980", "1070560", "1391110", "1628350"];
const NON_GAME_WORDS: [&str; 6] = [
    "redistributable",
    "steamworks",
    "proton",
    "steam linux runtime",
    "dedicated server",
    "sdk",
];

/// Ist der Eintrag ein Werkzeug/Paket statt eines Spiels?
pub fn is_non_game(appid: &str, name: &str) -> bool {
    if NON_GAME_APPIDS.contains(&appid) {
        return true;
    }
    let lower = name.to_lowercase();
    NON_GAME_WORDS.iter().any(|w| {
        if *w == "sdk" {
            // nur ganzes Wort "SDK" (nicht z. B. in "Sdkfz")
            lower
                .split(|c: char| !c.is_alphanumeric())
                .any(|part| part == "sdk")
        } else {
            lower.contains(w)
        }
    })
}

/// Mögliche Steam-Installationsordner.
pub fn steam_roots() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    {
        use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
        use winreg::RegKey;
        if let Ok(k) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Software\Valve\Steam") {
            if let Ok(p) = k.get_value::<String, _>("SteamPath") {
                candidates.push(PathBuf::from(p.replace('/', "\\")));
            }
        }
        for sub in [r"SOFTWARE\WOW6432Node\Valve\Steam", r"SOFTWARE\Valve\Steam"] {
            if let Ok(k) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(sub) {
                if let Ok(p) = k.get_value::<String, _>("InstallPath") {
                    candidates.push(PathBuf::from(p));
                }
            }
        }
        candidates.push(PathBuf::from(r"C:\Program Files (x86)\Steam"));
        candidates.push(PathBuf::from(r"C:\Program Files\Steam"));
    }
    #[cfg(not(windows))]
    {
        if let Some(home) = crate::util::home_dir() {
            candidates.push(home.join(".steam/steam"));
            candidates.push(home.join(".local/share/Steam"));
            candidates.push(home.join(".steam/root"));
            candidates.push(home.join(".var/app/com.valvesoftware.Steam/.local/share/Steam"));
        }
    }
    let mut seen = std::collections::HashSet::new();
    candidates
        .into_iter()
        .filter(|p| p.join("steamapps").is_dir() || p.join("SteamApps").is_dir())
        .filter(|p| {
            let key = fs::canonicalize(p)
                .map(|c| normalize_path(&c.to_string_lossy()))
                .unwrap_or_else(|_| normalize_path(&p.to_string_lossy()));
            seen.insert(key)
        })
        .collect()
}

fn steamapps_dir(lib: &Path) -> PathBuf {
    let lower = lib.join("steamapps");
    if lower.is_dir() {
        lower
    } else {
        let upper = lib.join("SteamApps");
        if upper.is_dir() {
            upper
        } else {
            lower
        }
    }
}

/// Bibliotheksordner aus `libraryfolders.vdf` (neues und altes Format).
pub fn parse_library_folders(text: &str) -> Vec<PathBuf> {
    let root = vdf::parse(text);
    let Some(lf) = root.get("libraryfolders") else {
        return Vec::new();
    };
    lf.entries()
        .iter()
        .filter(|(k, _)| k.chars().all(|c| c.is_ascii_digit()))
        .filter_map(|(_, v)| match v {
            vdf::Vdf::Str(p) => Some(p.clone()),
            vdf::Vdf::Obj(_) => v.get_str("path").map(|s| s.to_string()),
        })
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .collect()
}

/// Alle Bibliotheksordner einer Steam-Installation (inklusive des Hauptordners).
pub fn library_folders(root: &Path) -> Vec<PathBuf> {
    let mut libs = vec![root.to_path_buf()];
    for file in [
        steamapps_dir(root).join("libraryfolders.vdf"),
        root.join("config").join("libraryfolders.vdf"),
    ] {
        if let Ok(text) = fs::read_to_string(&file) {
            libs.extend(parse_library_folders(&text));
        }
    }
    let mut seen = std::collections::HashSet::new();
    libs.into_iter()
        .filter(|p| seen.insert(normalize_path(&p.to_string_lossy())))
        .collect()
}

/// `(appid, name, installdir)` aus einem `appmanifest_*.acf`.
pub fn parse_app_manifest(text: &str) -> Option<(String, String, String)> {
    let root = vdf::parse(text);
    let app = root.get("AppState")?;
    let appid = app.get_str("appid")?.trim().to_string();
    let installdir = app.get_str("installdir")?.trim().to_string();
    let name = app
        .get_str("name")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| installdir.clone());
    if appid.is_empty() || installdir.is_empty() || !appid.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some((appid, name, installdir))
}

/// Alle installierten Spiele einer Bibliothek.
pub fn scan_library(lib: &Path) -> Vec<ScannedEntry> {
    let apps = steamapps_dir(lib);
    let Ok(rd) = fs::read_dir(&apps) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in rd.filter_map(|e| e.ok()) {
        let name = e.file_name().to_string_lossy().to_lowercase();
        if !(name.starts_with("appmanifest_") && name.ends_with(".acf")) {
            continue;
        }
        let Ok(text) = fs::read_to_string(e.path()) else { continue };
        let Some((appid, title, installdir)) = parse_app_manifest(&text) else { continue };
        if is_non_game(&appid, &title) {
            continue;
        }
        let install = apps.join("common").join(&installdir);
        if !install.is_dir() {
            continue; // Manifest-Rest eines deinstallierten Spiels
        }
        out.push(ScannedEntry {
            name: title,
            kind: GameKind::Game,
            source: GameSource::Steam,
            source_id: Some(appid.clone()),
            launch: LaunchConfig::url(format!("steam://rungameid/{appid}")),
            install_dir: Some(display_path(&install)),
            exe_path: None,
        });
    }
    out
}

/// Kompletter Steam-Scan.
pub fn scan(entries: &mut Vec<ScannedEntry>, messages: &mut Vec<String>) {
    let roots = steam_roots();
    if roots.is_empty() {
        messages.push("Steam wurde nicht gefunden.".into());
        return;
    }
    let mut found = 0usize;
    let mut seen_libs = std::collections::HashSet::new();
    for root in roots {
        for lib in library_folders(&root) {
            if !seen_libs.insert(normalize_path(&lib.to_string_lossy())) {
                continue;
            }
            let list = scan_library(&lib);
            found += list.len();
            entries.extend(list);
        }
    }
    messages.push(match found {
        0 => "Steam: keine installierten Spiele gefunden.".into(),
        1 => "Steam: 1 Spiel gefunden.".into(),
        n => format!("Steam: {n} Spiele gefunden."),
    });
}

/// Steam-Ordner für Screenshots (`userdata`).
pub fn userdata_dirs() -> Vec<PathBuf> {
    steam_roots()
        .into_iter()
        .map(|r| r.join("userdata"))
        .filter(|p| p.is_dir())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_folders_new_and_old_format() {
        let new = r#""libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
		"label"		""
		"apps" { "228980" "123" }
	}
	"1"
	{
		"path"		"D:\\SteamLibrary"
	}
}"#;
        assert_eq!(
            parse_library_folders(new),
            vec![PathBuf::from(r"C:\Program Files (x86)\Steam"), PathBuf::from(r"D:\SteamLibrary")]
        );
        let old = r#""LibraryFolders" { "TimeNextStatsReport" "1234" "ContentStatsID" "-1" "1" "E:\\Games\\Steam" }"#;
        assert_eq!(parse_library_folders(old), vec![PathBuf::from(r"E:\Games\Steam")]);
        assert!(parse_library_folders("kaputt").is_empty());
    }

    #[test]
    fn app_manifest() {
        let acf = r#""AppState" { "appid" "570" "name" "Dota 2" "installdir" "dota 2 beta" }"#;
        assert_eq!(
            parse_app_manifest(acf),
            Some(("570".into(), "Dota 2".into(), "dota 2 beta".into()))
        );
        assert_eq!(parse_app_manifest(r#""AppState" { "appid" "570" }"#), None);
    }

    #[test]
    fn non_games() {
        assert!(is_non_game("228980", "Steamworks Common Redistributables"));
        assert!(is_non_game("1", "Proton 9.0"));
        assert!(is_non_game("2", "Steam Linux Runtime 3.0 (sniper)"));
        assert!(is_non_game("3", "Counter-Strike 2 Dedicated Server"));
        assert!(is_non_game("4", "Source SDK Base 2013"));
        assert!(!is_non_game("1245620", "ELDEN RING"));
        assert!(!is_non_game("5", "Sdkfz Simulator"));
    }

    #[test]
    fn scans_library_folder() {
        let dir = tempfile::tempdir().unwrap();
        let apps = dir.path().join("steamapps");
        fs::create_dir_all(apps.join("common").join("Hades")).unwrap();
        fs::write(
            apps.join("appmanifest_1145360.acf"),
            r#""AppState" { "appid" "1145360" "name" "Hades" "installdir" "Hades" }"#,
        )
        .unwrap();
        // Deinstalliert (Ordner fehlt) und kein Spiel
        fs::write(apps.join("appmanifest_1.acf"), r#""AppState" { "appid" "1" "name" "Weg" "installdir" "Weg" }"#).unwrap();
        fs::create_dir_all(apps.join("common").join("Steamworks Shared")).unwrap();
        fs::write(
            apps.join("appmanifest_228980.acf"),
            r#""AppState" { "appid" "228980" "name" "Steamworks Common Redistributables" "installdir" "Steamworks Shared" }"#,
        )
        .unwrap();
        let list = scan_library(dir.path());
        assert_eq!(list.len(), 1);
        let e = &list[0];
        assert_eq!(e.name, "Hades");
        assert_eq!(e.source_id.as_deref(), Some("1145360"));
        assert_eq!(e.launch.target, "steam://rungameid/1145360");
        assert!(e.install_dir.as_deref().unwrap().ends_with("Hades"));
    }
}
