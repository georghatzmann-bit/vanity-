//! GOG Galaxy / GOG-Installer: Registry `HKLM\SOFTWARE\WOW6432Node\GOG.com\Games\<id>`.

use crate::models::ScannedEntry;
#[cfg(windows)]
use crate::models::{GameKind, GameSource, LaunchConfig};

/// Rohdaten eines GOG-Registry-Eintrags.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Default, Clone)]
pub struct GogRecord {
    pub id: String,
    pub name: String,
    pub exe: String,
    pub path: String,
    pub work_dir: String,
    pub launch_param: String,
    pub depends_on: String,
}

/// Registry-Werte in einen Scan-Eintrag umwandeln (`None` für DLCs/unvollständige Einträge).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn to_entry(r: &GogRecord) -> Option<ScannedEntry> {
    #[cfg(windows)]
    {
        if !r.depends_on.trim().is_empty() || r.exe.trim().is_empty() || r.name.trim().is_empty() {
            return None;
        }
        let work = if r.work_dir.trim().is_empty() {
            r.path.clone()
        } else {
            r.work_dir.clone()
        };
        Some(ScannedEntry {
            name: r.name.trim().to_string(),
            kind: GameKind::Game,
            source: GameSource::Gog,
            source_id: Some(r.id.clone()),
            launch: LaunchConfig::exe(
                r.exe.trim(),
                Some(r.launch_param.clone()),
                Some(work),
            ),
            install_dir: Some(r.path.trim().to_string()).filter(|p| !p.is_empty()),
            exe_path: Some(r.exe.trim().to_string()),
        })
    }
    #[cfg(not(windows))]
    {
        let _ = r;
        None
    }
}

/// Alle GOG-Spiele finden (nur Windows).
pub fn scan(entries: &mut Vec<ScannedEntry>, messages: &mut Vec<String>) {
    #[cfg(windows)]
    {
        use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
        use winreg::RegKey;
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        let mut found = 0usize;
        let mut any_key = false;
        let mut seen = std::collections::HashSet::new();
        for sub in [r"SOFTWARE\WOW6432Node\GOG.com\Games", r"SOFTWARE\GOG.com\Games"] {
            let Ok(games) = hklm.open_subkey_with_flags(sub, KEY_READ) else { continue };
            any_key = true;
            for id in games.enum_keys().filter_map(|k| k.ok()) {
                let Ok(k) = games.open_subkey_with_flags(&id, KEY_READ) else { continue };
                let get = |n: &str| k.get_value::<String, _>(n).unwrap_or_default();
                let rec = GogRecord {
                    id: {
                        let gid = get("gameID");
                        if gid.trim().is_empty() { id.clone() } else { gid }
                    },
                    name: get("gameName"),
                    exe: get("exe"),
                    path: get("path"),
                    work_dir: get("workingDir"),
                    launch_param: get("launchParam"),
                    depends_on: get("dependsOn"),
                };
                if !seen.insert(rec.id.clone()) {
                    continue;
                }
                let Some(entry) = to_entry(&rec) else { continue };
                if !std::path::Path::new(&rec.exe).is_file() {
                    continue;
                }
                entries.push(entry);
                found += 1;
            }
        }
        if !any_key {
            messages.push("GOG Galaxy wurde nicht gefunden.".into());
            return;
        }
        messages.push(match found {
            0 => "GOG: keine installierten Spiele gefunden.".into(),
            1 => "GOG: 1 Spiel gefunden.".into(),
            n => format!("GOG: {n} Spiele gefunden."),
        });
    }
    #[cfg(not(windows))]
    {
        let _ = entries;
        messages.push("GOG: nur unter Windows verfügbar.".into());
    }
}
