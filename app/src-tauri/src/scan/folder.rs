//! Eigene Spieleordner: pro Unterordner ein Spiel, die passendste `.exe` wird gewählt.

use std::fs;
use std::path::{Path, PathBuf};

use crate::models::{GameKind, GameSource, LaunchConfig, ScannedEntry};
use crate::util::{display_path, normalize_name, prettify_name};

/// Maximale Tiefe unterhalb eines Spieleordners.
pub const MAX_DEPTH: usize = 3;

const IGNORED_DIRS: [&str; 22] = [
    "_commonredist",
    "commonredist",
    "redist",
    "_redist",
    "redistributables",
    "redistributable",
    "directx",
    "dotnet",
    "vcredist",
    "__installer",
    "installer",
    "installers",
    "support",
    "easyanticheat",
    "battleye",
    "prerequisites",
    "prereqs",
    "dependencies",
    "crashreporter",
    "uninstall",
    "$recycle.bin",
    "system volume information",
];

/// Hilfsprogramme, Installer und Absturzmelder, die nie das Spiel selbst sind.
pub fn is_ignored_exe(stem: &str) -> bool {
    let s = stem.to_lowercase();
    const STARTS: [&str; 13] = [
        "unins",
        "setup",
        "vc_redist",
        "vcredist",
        "unitycrashhandler",
        "dxsetup",
        "dotnet",
        "ndp4",
        "oalinst",
        "physx",
        "ue4prereq",
        "ueprereq",
        "directx",
    ];
    const CONTAINS: [&str; 12] = [
        "redist",
        "crash",
        "install",
        "update",
        "helper",
        "setup",
        "cefsharp",
        "qtwebengine",
        "webhelper",
        "anticheat",
        "errorreport",
        "bugreport",
    ];
    const EXACT: [&str; 6] = ["cef", "7z", "7za", "unrar", "subprocess", "dxwebsetup"];
    STARTS.iter().any(|p| s.starts_with(p))
        || CONTAINS.iter().any(|p| s.contains(p))
        || EXACT.contains(&s.as_str())
}

/// Eine gefundene `.exe` in einem Spieleordner.
#[derive(Debug, Clone)]
pub struct ExeCandidate {
    pub path: PathBuf,
    pub size: u64,
    /// 1 = direkt im Spieleordner
    pub depth: usize,
}

/// Wie gut passt der Dateiname zum Ordnernamen? (0 = gar nicht)
pub fn name_score(folder_name: &str, exe_stem: &str) -> u32 {
    let folder = normalize_name(folder_name);
    let stem = normalize_name(exe_stem);
    if folder.is_empty() || stem.is_empty() {
        return 0;
    }
    if folder == stem {
        return 1000;
    }
    if (stem.len() >= 3 && folder.contains(&stem)) || (folder.len() >= 3 && stem.contains(&folder)) {
        return 700;
    }
    // Wortweise Übereinstimmung ("The Witcher 3" ⇄ "witcher3")
    let words: Vec<String> = folder_name
        .split(|c: char| !c.is_alphanumeric())
        .map(|w| w.to_lowercase())
        .filter(|w| w.len() >= 3 && w != "the")
        .collect();
    let hits = words.iter().filter(|w| stem.contains(w.as_str())).count() as u32;
    // Anfangsbuchstaben ("Grand Theft Auto V" ⇄ "gta5"); einzelne Zeichen wie "V" oder "3" zählen nicht
    let initials: String = folder_name
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 2)
        .filter_map(|w| w.chars().next())
        .flat_map(|c| c.to_lowercase())
        .collect();
    let acronym = if initials.len() >= 3 && stem.starts_with(&initials) { 300 } else { 0 };
    (hits * 150).min(600).max(acronym)
}

/// Die passendste `.exe` wählen: bester Namensabgleich (flacher bevorzugt), sonst die größte Datei.
pub fn pick_best_exe(folder_name: &str, candidates: &[ExeCandidate]) -> Option<usize> {
    if candidates.is_empty() {
        return None;
    }
    let scored: Vec<(usize, u32)> = candidates
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let stem = c.path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            (i, name_score(folder_name, &stem))
        })
        .collect();
    let best_named = scored
        .iter()
        .filter(|(_, s)| *s > 0)
        .max_by(|a, b| {
            let ca = &candidates[a.0];
            let cb = &candidates[b.0];
            a.1.cmp(&b.1)
                .then(cb.depth.cmp(&ca.depth))
                .then(ca.size.cmp(&cb.size))
        })
        .map(|(i, _)| *i);
    best_named.or_else(|| {
        candidates
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.size.cmp(&b.size).then(b.depth.cmp(&a.depth)))
            .map(|(i, _)| i)
    })
}

fn is_ignored_dir(name: &str) -> bool {
    let l = name.to_lowercase();
    IGNORED_DIRS.contains(&l.as_str()) || l.starts_with('.')
}

/// Alle brauchbaren `.exe` unterhalb von `dir` (bis `max_depth`).
pub fn collect_exes(dir: &Path, max_depth: usize) -> Vec<ExeCandidate> {
    let mut out = Vec::new();
    let walker = walkdir::WalkDir::new(dir)
        .min_depth(1)
        .max_depth(max_depth)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !(e.file_type().is_dir() && is_ignored_dir(&e.file_name().to_string_lossy())));
    for e in walker.filter_map(|e| e.ok()) {
        if !e.file_type().is_file() {
            continue;
        }
        let p = e.path();
        let is_exe = p
            .extension()
            .map(|x| x.eq_ignore_ascii_case("exe"))
            .unwrap_or(false);
        if !is_exe {
            continue;
        }
        let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        if is_ignored_exe(&stem) {
            continue;
        }
        let size = e.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(ExeCandidate {
            path: p.to_path_buf(),
            size,
            depth: e.depth(),
        });
        if out.len() > 400 {
            break; // Schutz vor riesigen Ordnern
        }
    }
    out
}

fn folder_display_name(dir: &Path) -> String {
    dir.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| display_path(dir))
}

/// Einen einzelnen Spieleordner auswerten.
pub fn scan_game_folder(dir: &Path) -> Option<ScannedEntry> {
    let name = folder_display_name(dir);
    let candidates = collect_exes(dir, MAX_DEPTH);
    let best = pick_best_exe(&name, &candidates)?;
    let exe = &candidates[best].path;
    let work = exe.parent().map(display_path);
    Some(ScannedEntry {
        name: prettify_name(&name),
        kind: GameKind::Game,
        source: GameSource::Folder,
        source_id: None,
        launch: LaunchConfig::exe(display_path(exe), None, work),
        install_dir: Some(display_path(dir)),
        exe_path: Some(display_path(exe)),
    })
}

/// Einen vom Benutzer gewählten Ordner scannen: entweder ist er selbst ein Spiel,
/// oder jeder Unterordner ist ein Spiel.
pub fn scan_root(root: &Path) -> Vec<ScannedEntry> {
    let root_name = folder_display_name(root);
    let direct = collect_exes(root, 1);
    let direct_match = direct.iter().any(|c| {
        let stem = c.path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        name_score(&root_name, &stem) > 0
    });
    if direct_match {
        return scan_game_folder(root).into_iter().collect();
    }
    let mut subdirs: Vec<PathBuf> = fs::read_dir(root)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .filter(|e| !is_ignored_dir(&e.file_name().to_string_lossy()))
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default();
    subdirs.sort();
    let entries: Vec<ScannedEntry> = subdirs.iter().filter_map(|d| scan_game_folder(d)).collect();
    if entries.is_empty() && !direct.is_empty() {
        // Keine Unterordner mit Spielen, aber Programme direkt im Ordner → der Ordner ist das Spiel
        return scan_game_folder(root).into_iter().collect();
    }
    entries
}

/// Alle eigenen Ordner scannen.
pub fn scan(folders: &[String], entries: &mut Vec<ScannedEntry>, messages: &mut Vec<String>) {
    for f in folders {
        let path = crate::util::clean_path(f);
        if f.trim().is_empty() {
            continue;
        }
        if !path.is_dir() {
            messages.push(format!("Ordner nicht gefunden: {}", display_path(&path)));
            continue;
        }
        let list = scan_root(&path);
        messages.push(match list.len() {
            0 => format!("{}: keine Spiele gefunden.", display_path(&path)),
            1 => format!("{}: 1 Spiel gefunden.", display_path(&path)),
            n => format!("{}: {n} Spiele gefunden.", display_path(&path)),
        });
        entries.extend(list);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(path: &str, size: u64, depth: usize) -> ExeCandidate {
        ExeCandidate { path: PathBuf::from(path), size, depth }
    }

    #[test]
    fn ignores_helpers() {
        for s in [
            "unins000", "Setup", "vc_redist.x64", "UnityCrashHandler64", "DXSETUP", "CrashReportClient",
            "EpicLauncherHelper", "QtWebEngineProcess", "GameUpdater", "installer", "EasyAntiCheat_Setup",
        ] {
            assert!(is_ignored_exe(s), "{s}");
        }
        for s in ["eldenring", "witcher3", "Hades", "Game"] {
            assert!(!is_ignored_exe(s), "{s}");
        }
    }

    #[test]
    fn picks_name_match_over_size() {
        let c = vec![
            cand("/g/Hollow Knight/tool.exe", 90_000_000, 1),
            cand("/g/Hollow Knight/hollow_knight.exe", 600_000, 1),
        ];
        assert_eq!(pick_best_exe("Hollow Knight", &c), Some(1));
    }

    #[test]
    fn prefers_shallow_exact_match() {
        let c = vec![
            cand("/g/Satisfactory/Engine/Binaries/Win64/Satisfactory-Win64-Shipping.exe", 80_000_000, 4),
            cand("/g/Satisfactory/Satisfactory.exe", 300_000, 1),
        ];
        assert_eq!(pick_best_exe("Satisfactory", &c), Some(1));
    }

    #[test]
    fn falls_back_to_largest() {
        let c = vec![
            cand("/g/Some Game/a.exe", 10, 1),
            cand("/g/Some Game/bin/x64/b.exe", 5_000, 3),
            cand("/g/Some Game/c.exe", 20, 1),
        ];
        assert_eq!(pick_best_exe("Some Game", &c), Some(1));
        assert_eq!(pick_best_exe("x", &[]), None);
    }

    #[test]
    fn word_and_acronym_scores() {
        assert!(name_score("The Witcher 3 Wild Hunt", "witcher3") > 0);
        assert!(name_score("Grand Theft Auto V", "GTA5") > 0);
        assert_eq!(name_score("Factorio", "launcher"), 0);
        assert_eq!(name_score("Hades", "Hades"), 1000);
    }

    #[test]
    fn scans_folder_tree() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Games");
        let g1 = root.join("Celeste");
        fs::create_dir_all(&g1).unwrap();
        fs::write(g1.join("Celeste.exe"), b"x").unwrap();
        fs::write(g1.join("unins000.exe"), b"xxxx").unwrap();
        let g2 = root.join("Big_Game");
        fs::create_dir_all(g2.join("bin").join("x64")).unwrap();
        fs::write(g2.join("bin").join("x64").join("main.exe"), vec![0u8; 2000]).unwrap();
        fs::write(g2.join("tiny.exe"), b"x").unwrap();
        fs::create_dir_all(g2.join("_CommonRedist")).unwrap();
        fs::write(g2.join("_CommonRedist").join("huge.exe"), vec![0u8; 9000]).unwrap();
        fs::create_dir_all(root.join("Leer")).unwrap();

        let list = scan_root(&root);
        assert_eq!(list.len(), 2);
        let big = list.iter().find(|e| e.name == "Big Game").unwrap();
        assert!(big.exe_path.as_deref().unwrap().ends_with("main.exe"));
        assert_eq!(big.launch.work_dir.as_deref().map(|w| w.ends_with("x64")), Some(true));
        let celeste = list.iter().find(|e| e.name == "Celeste").unwrap();
        assert!(celeste.exe_path.as_deref().unwrap().ends_with("Celeste.exe"));

        // Direkt einen Spieleordner gewählt
        let single = scan_root(&g1);
        assert_eq!(single.len(), 1);
        assert_eq!(single[0].name, "Celeste");
    }
}
