//! Bibliothek scannen: Steam, Epic, GOG, Startmenü und eigene Ordner, plus Drag & Drop.

pub mod epic;
pub mod folder;
pub mod gog;
pub mod startmenu;
pub mod steam;
pub mod vdf;

use std::collections::HashSet;
use std::path::Path;

use crate::error::{blocking, CmdResult};
use crate::models::{GameKind, GameSource, LaunchConfig, ScanOptions, ScanResult, ScannedEntry};
use crate::tracker::normalize_path;
use crate::util::{clean_path, display_path, prettify_name};

/// Doppelte Einträge entfernen (gleiche Quelle + ID oder gleiche `.exe`). Der erste gewinnt.
pub fn dedupe(entries: Vec<ScannedEntry>) -> Vec<ScannedEntry> {
    let mut seen_ids = HashSet::new();
    let mut seen_exes = HashSet::new();
    let mut seen_targets = HashSet::new();
    let mut out = Vec::with_capacity(entries.len());
    for e in entries {
        if let Some(id) = &e.source_id {
            if !seen_ids.insert(format!("{:?}:{}", e.source, id.to_lowercase())) {
                continue;
            }
        }
        if let Some(exe) = &e.exe_path {
            if !seen_exes.insert(normalize_path(exe)) {
                continue;
            }
        } else if e.source_id.is_none() && !seen_targets.insert(e.launch.target.trim().to_lowercase()) {
            continue;
        }
        out.push(e);
    }
    out
}

/// Kompletter Scan nach den gewählten Optionen (blockierend).
pub fn run_scan(options: &ScanOptions) -> ScanResult {
    let mut entries = Vec::new();
    let mut messages = Vec::new();
    if options.steam {
        steam::scan(&mut entries, &mut messages);
    }
    if options.epic {
        epic::scan(&mut entries, &mut messages);
    }
    if options.gog {
        gog::scan(&mut entries, &mut messages);
    }
    if !options.folders.is_empty() {
        folder::scan(&options.folders, &mut entries, &mut messages);
    }
    if options.start_menu {
        startmenu::scan(&mut entries, &mut messages);
    }
    let entries = dedupe(entries);
    ScanResult { entries, messages }
}

/// `URL=` aus einer Internetverknüpfung (`.url`) lesen.
pub fn parse_url_file(text: &str) -> Option<String> {
    text.lines()
        .map(|l| l.trim())
        .find_map(|l| {
            let (k, v) = l.split_once('=')?;
            k.trim().eq_ignore_ascii_case("URL").then(|| v.trim().to_string())
        })
        .filter(|u| !u.is_empty())
}

/// Steam-AppID aus `steam://rungameid/<id>` bzw. `steam://run/<id>`.
pub fn steam_id_from_url(url: &str) -> Option<String> {
    let lower = url.to_lowercase();
    let rest = lower
        .strip_prefix("steam://rungameid/")
        .or_else(|| lower.strip_prefix("steam://run/"))?;
    let id: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    (!id.is_empty()).then_some(id)
}

/// Epic-AppName aus `com.epicgames.launcher://apps/<ns>%3A<item>%3A<AppName>?action=launch`.
pub fn epic_app_from_url(url: &str) -> Option<String> {
    let rest = url.strip_prefix("com.epicgames.launcher://apps/")?;
    let main = rest.split('?').next()?;
    let decoded = main.replace("%3A", ":").replace("%3a", ":");
    decoded
        .rsplit(':')
        .next()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Allgemeine Ordnernamen, die als Spielname nichts taugen.
fn is_generic_stem(stem: &str) -> bool {
    matches!(
        stem.to_lowercase().as_str(),
        "game" | "launcher" | "start" | "play" | "main" | "client" | "app" | "run" | "bin"
    )
}

fn is_generic_dir(name: &str) -> bool {
    matches!(
        name.to_lowercase().as_str(),
        "bin" | "bin64" | "x64" | "x86" | "win64" | "win32" | "binaries" | "game" | "release"
    )
}

/// Anzeigename für eine `.exe`: Dateiname, bei allgemeinen Namen der Ordnername.
fn exe_display_name(path: &Path) -> String {
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    if is_generic_stem(&stem) {
        let mut dir = path.parent();
        while let Some(d) = dir {
            let name = d.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if name.is_empty() {
                break;
            }
            if !is_generic_dir(&name) {
                return prettify_name(&name);
            }
            dir = d.parent();
        }
    }
    prettify_name(&stem)
}

fn exe_entry(path: &Path) -> ScannedEntry {
    let display = display_path(path);
    let parent = path.parent().map(display_path);
    ScannedEntry {
        name: exe_display_name(path),
        kind: startmenu::classify_kind(&display),
        source: GameSource::Manual,
        source_id: None,
        launch: LaunchConfig::exe(display.clone(), None, parent.clone()),
        install_dir: parent,
        exe_path: Some(display),
    }
}

fn url_entry(name: String, url: &str) -> ScannedEntry {
    if let Some(id) = steam_id_from_url(url) {
        return ScannedEntry {
            name,
            kind: GameKind::Game,
            source: GameSource::Steam,
            source_id: Some(id.clone()),
            launch: LaunchConfig::url(format!("steam://rungameid/{id}")),
            install_dir: None,
            exe_path: None,
        };
    }
    if let Some(app) = epic_app_from_url(url) {
        return ScannedEntry {
            name,
            kind: GameKind::Game,
            source: GameSource::Epic,
            source_id: Some(app),
            launch: LaunchConfig::url(url),
            install_dir: None,
            exe_path: None,
        };
    }
    let lower = url.to_lowercase();
    let web = lower.starts_with("http://") || lower.starts_with("https://");
    ScannedEntry {
        name,
        kind: if web { GameKind::App } else { GameKind::Game },
        source: GameSource::Manual,
        source_id: None,
        launch: LaunchConfig::url(url),
        install_dir: None,
        exe_path: None,
    }
}

/// Einen per Drag & Drop abgelegten Pfad auswerten (blockierend).
pub fn inspect_one(path: &Path) -> Vec<ScannedEntry> {
    if path.is_dir() {
        return folder::scan_root(path);
    }
    if !path.is_file() {
        return Vec::new();
    }
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let name = prettify_name(&stem);
    match ext.as_str() {
        "exe" => vec![exe_entry(path)],
        "url" => {
            let text = std::fs::read(path)
                .map(|b| String::from_utf8_lossy(&b).to_string())
                .unwrap_or_default();
            match parse_url_file(&text) {
                Some(url) => vec![url_entry(name, &url)],
                None => Vec::new(),
            }
        }
        "lnk" => {
            #[cfg(windows)]
            {
                let _com = startmenu::ComGuard::new();
                if let Some(info) = startmenu::resolve_lnk(path) {
                    let target = Path::new(&info.target);
                    let is_exe = target
                        .extension()
                        .map(|x| x.eq_ignore_ascii_case("exe"))
                        .unwrap_or(false);
                    if is_exe {
                        return vec![ScannedEntry {
                            name,
                            kind: startmenu::classify_kind(&info.target),
                            source: GameSource::Manual,
                            source_id: None,
                            launch: LaunchConfig::shell(display_path(path)),
                            install_dir: target.parent().map(display_path),
                            exe_path: Some(info.target.clone()),
                        }];
                    }
                    if target.is_dir() {
                        return folder::scan_root(target);
                    }
                }
            }
            vec![ScannedEntry {
                name,
                kind: GameKind::App,
                source: GameSource::Manual,
                source_id: None,
                launch: LaunchConfig::shell(display_path(path)),
                install_dir: None,
                exe_path: None,
            }]
        }
        "bat" | "cmd" | "appref-ms" => vec![ScannedEntry {
            name,
            kind: startmenu::classify_kind(&display_path(path)),
            source: GameSource::Manual,
            source_id: None,
            launch: LaunchConfig::shell(display_path(path)),
            install_dir: path.parent().map(display_path),
            exe_path: None,
        }],
        _ => Vec::new(),
    }
}

// =============================================================================================
// Befehle
// =============================================================================================

#[tauri::command]
pub async fn scan_library(options: ScanOptions) -> CmdResult<ScanResult> {
    blocking(move || Ok(run_scan(&options))).await
}

#[tauri::command]
pub async fn inspect_paths(paths: Vec<String>) -> CmdResult<Vec<ScannedEntry>> {
    blocking(move || {
        let mut out = Vec::new();
        for p in paths.iter().take(200) {
            if p.trim().is_empty() {
                continue;
            }
            out.extend(inspect_one(&clean_path(p)));
        }
        Ok(dedupe(out))
    })
    .await
}

#[tauri::command]
pub async fn paths_exist(paths: Vec<String>) -> CmdResult<Vec<bool>> {
    blocking(move || {
        Ok(paths
            .iter()
            .map(|p| !p.trim().is_empty() && clean_path(p).exists())
            .collect())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn entry(source: GameSource, id: Option<&str>, exe: Option<&str>, target: &str) -> ScannedEntry {
        ScannedEntry {
            name: "x".into(),
            kind: GameKind::Game,
            source,
            source_id: id.map(|s| s.into()),
            launch: LaunchConfig::url(target),
            install_dir: None,
            exe_path: exe.map(|s| s.into()),
        }
    }

    #[test]
    fn dedupe_by_id_and_exe() {
        let list = vec![
            entry(GameSource::Steam, Some("570"), None, "steam://rungameid/570"),
            entry(GameSource::Steam, Some("570"), None, "steam://rungameid/570"),
            entry(GameSource::Gog, Some("1"), Some(r"C:\GOG Games\W\w.exe"), "a"),
            entry(GameSource::Startmenu, None, Some("c:/gog games/w/W.EXE"), "b"),
            entry(GameSource::Manual, None, None, "https://x"),
            entry(GameSource::Manual, None, None, "https://X"),
        ];
        let out = dedupe(list);
        assert_eq!(out.len(), 3);
        assert_eq!(out[1].source, GameSource::Gog);
    }

    #[test]
    fn url_files() {
        let text = "[{000214A0-0000-0000-C000-000000000046}]\r\nProp3=19,0\r\n[InternetShortcut]\r\nIDList=\r\nURL=steam://rungameid/1145360\r\nIconIndex=0\r\n";
        assert_eq!(parse_url_file(text).as_deref(), Some("steam://rungameid/1145360"));
        assert_eq!(steam_id_from_url("steam://rungameid/1145360").as_deref(), Some("1145360"));
        assert_eq!(steam_id_from_url("steam://run/42//"), Some("42".into()));
        assert_eq!(steam_id_from_url("https://store.steampowered.com"), None);
        assert_eq!(
            epic_app_from_url("com.epicgames.launcher://apps/fn%3Aabc%3AFortnite?action=launch&silent=true").as_deref(),
            Some("Fortnite")
        );
    }

    #[test]
    fn inspect_drag_and_drop() {
        let dir = tempfile::tempdir().unwrap();
        let games = dir.path().join("Games").join("Dead_Cells");
        fs::create_dir_all(games.join("bin")).unwrap();
        let exe = games.join("bin").join("game.exe");
        fs::write(&exe, b"x").unwrap();
        let e = inspect_one(&exe);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].name, "Dead Cells", "allgemeiner Name → Ordnername");
        assert_eq!(e[0].kind, GameKind::Game, "liegt unter \\Games\\");
        assert_eq!(e[0].launch.kind, crate::models::LaunchType::Exe);

        let url = dir.path().join("My_Game.url");
        fs::write(&url, "[InternetShortcut]\nURL=steam://rungameid/570\n").unwrap();
        let e = inspect_one(&url);
        assert_eq!(e[0].source, GameSource::Steam);
        assert_eq!(e[0].source_id.as_deref(), Some("570"));
        assert_eq!(e[0].name, "My Game");

        let tool = dir.path().join("Some_Tool.exe");
        fs::write(&tool, b"x").unwrap();
        let e = inspect_one(&tool);
        assert_eq!(e[0].kind, GameKind::App);
        assert_eq!(e[0].name, "Some Tool");

        assert!(inspect_one(&dir.path().join("fehlt.exe")).is_empty());
        let folder = inspect_one(&dir.path().join("Games"));
        assert_eq!(folder.len(), 1);
        assert_eq!(folder[0].source, GameSource::Folder);
    }
}
