//! Epic Games Launcher: Manifeste in `%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item`.

use serde_json::Value;

use crate::models::{GameKind, GameSource, LaunchConfig, ScannedEntry};

#[cfg_attr(not(windows), allow(dead_code))]
fn join_win(base: &str, rel: &str) -> String {
    let rel = rel.trim().replace('/', "\\");
    let rel = rel.trim_start_matches('\\');
    let base = base.trim().trim_end_matches(['\\', '/']);
    if rel.is_empty() {
        base.to_string()
    } else {
        format!("{base}\\{rel}")
    }
}

/// Ein Epic-Manifest (JSON) auswerten. `None` für unvollständige Installationen, DLCs,
/// Unreal-Engine-Pakete und Nicht-Spiele.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn parse_manifest(text: &str) -> Option<ScannedEntry> {
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    let s = |k: &str| {
        v.get(k)
            .and_then(|x| x.as_str())
            .map(|x| x.trim().to_string())
            .filter(|x| !x.is_empty())
    };
    if v.get("bIsIncompleteInstall").and_then(|b| b.as_bool()) == Some(true) {
        return None;
    }
    let app_name = s("AppName")?;
    if app_name.starts_with("UE_") {
        return None;
    }
    if let Some(cats) = v.get("AppCategories").and_then(|c| c.as_array()) {
        let is_game = cats
            .iter()
            .filter_map(|c| c.as_str())
            .any(|c| c.eq_ignore_ascii_case("games"));
        if !is_game {
            return None;
        }
    }
    // DLCs verweisen auf ein anderes Hauptspiel
    if let Some(main) = s("MainGameAppName") {
        if main != app_name {
            return None;
        }
    }
    let install = s("InstallLocation")?;
    let namespace = s("CatalogNamespace").unwrap_or_default();
    let item = s("CatalogItemId").unwrap_or_default();
    let name = s("DisplayName").unwrap_or_else(|| app_name.clone());
    let exe = s("LaunchExecutable").map(|e| join_win(&install, &e));
    Some(ScannedEntry {
        name,
        kind: GameKind::Game,
        source: GameSource::Epic,
        source_id: Some(app_name.clone()),
        launch: LaunchConfig::url(format!(
            "com.epicgames.launcher://apps/{namespace}%3A{item}%3A{app_name}?action=launch&silent=true"
        )),
        install_dir: Some(install),
        exe_path: exe,
    })
}

/// Alle Epic-Spiele finden (nur Windows).
pub fn scan(entries: &mut Vec<ScannedEntry>, messages: &mut Vec<String>) {
    #[cfg(windows)]
    {
        let base = std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".into());
        let dir = std::path::Path::new(&base)
            .join("Epic")
            .join("EpicGamesLauncher")
            .join("Data")
            .join("Manifests");
        let Ok(rd) = std::fs::read_dir(&dir) else {
            messages.push("Epic Games Launcher wurde nicht gefunden.".into());
            return;
        };
        let mut found = 0usize;
        for e in rd.filter_map(|e| e.ok()) {
            let p = e.path();
            if !p
                .extension()
                .map(|x| x.eq_ignore_ascii_case("item"))
                .unwrap_or(false)
            {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&p) else { continue };
            let Some(entry) = parse_manifest(&text) else { continue };
            if !entry
                .install_dir
                .as_deref()
                .map(|d| std::path::Path::new(d).is_dir())
                .unwrap_or(false)
            {
                continue;
            }
            entries.push(entry);
            found += 1;
        }
        messages.push(match found {
            0 => "Epic Games: keine installierten Spiele gefunden.".into(),
            1 => "Epic Games: 1 Spiel gefunden.".into(),
            n => format!("Epic Games: {n} Spiele gefunden."),
        });
    }
    #[cfg(not(windows))]
    {
        let _ = entries;
        messages.push("Epic Games: nur unter Windows verfügbar.".into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FORTNITE: &str = r#"{
        "FormatVersion": 0,
        "bIsIncompleteInstall": false,
        "LaunchExecutable": "FortniteGame/Binaries/Win64/FortniteLauncher.exe",
        "DisplayName": "Fortnite",
        "InstallLocation": "C:\\Program Files\\Epic Games\\Fortnite",
        "CatalogNamespace": "fn",
        "CatalogItemId": "4fe75bbc5a674f4f9b356b5c90567da5",
        "AppName": "Fortnite",
        "AppCategories": ["public", "games", "applications"],
        "MainGameAppName": "Fortnite"
    }"#;

    #[test]
    fn parses_game_manifest() {
        let e = parse_manifest(FORTNITE).unwrap();
        assert_eq!(e.name, "Fortnite");
        assert_eq!(e.source, GameSource::Epic);
        assert_eq!(e.source_id.as_deref(), Some("Fortnite"));
        assert_eq!(
            e.launch.target,
            "com.epicgames.launcher://apps/fn%3A4fe75bbc5a674f4f9b356b5c90567da5%3AFortnite?action=launch&silent=true"
        );
        assert_eq!(
            e.exe_path.as_deref(),
            Some(r"C:\Program Files\Epic Games\Fortnite\FortniteGame\Binaries\Win64\FortniteLauncher.exe")
        );
        assert_eq!(e.install_dir.as_deref(), Some(r"C:\Program Files\Epic Games\Fortnite"));
    }

    #[test]
    fn skips_non_games() {
        let incomplete = FORTNITE.replace("\"bIsIncompleteInstall\": false", "\"bIsIncompleteInstall\": true");
        assert!(parse_manifest(&incomplete).is_none());
        let ue = FORTNITE.replace("\"AppName\": \"Fortnite\"", "\"AppName\": \"UE_5.3\"");
        assert!(parse_manifest(&ue).is_none());
        let app = FORTNITE.replace("[\"public\", \"games\", \"applications\"]", "[\"applications\"]");
        assert!(parse_manifest(&app).is_none());
        let dlc = FORTNITE.replace("\"MainGameAppName\": \"Fortnite\"", "\"MainGameAppName\": \"Other\"");
        assert!(parse_manifest(&dlc).is_none());
        assert!(parse_manifest("kein json").is_none());
        // Ohne AppCategories wird das Spiel übernommen
        let no_cats = FORTNITE.replace("\"AppCategories\": [\"public\", \"games\", \"applications\"],", "");
        assert!(parse_manifest(&no_cats).is_some());
    }
}
