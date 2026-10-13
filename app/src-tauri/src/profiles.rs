//! Profile (mehrere Spieler an einem PC): Liste in `profiles.json`, eine Datenbank pro Profil.

use std::collections::HashSet;
use std::fs;
use std::sync::Arc;

use tauri::State;

use crate::error::{blocking, io_err, CmdResult, LockExt};
use crate::models::{AppInfo, Profile, ProfilesState};
use crate::state::{Core, Paths, Shared};
use crate::util::{display_path, is_plain_name, now_ms, write_atomic};

pub const DEFAULT_PROFILE_NAME: &str = "Spieler";
pub const DEFAULT_PROFILE_COLOR: &str = "#ff4f8b";

fn new_profile(name: &str, color: &str, avatar: Option<String>) -> Profile {
    Profile {
        id: uuid::Uuid::new_v4().simple().to_string(),
        name: name.to_string(),
        color: color.to_string(),
        avatar,
        created_at: now_ms(),
    }
}

fn clean_name(name: &str) -> CmdResult<String> {
    let n: String = name.trim().chars().take(40).collect();
    if n.trim().is_empty() {
        return Err("Bitte gib einen Namen ein.".into());
    }
    Ok(n.trim().to_string())
}

fn clean_color(color: &str) -> String {
    let c: String = color.trim().chars().take(32).collect();
    if c.is_empty() {
        DEFAULT_PROFILE_COLOR.into()
    } else {
        c
    }
}

fn clean_avatar(avatar: Option<String>) -> CmdResult<Option<String>> {
    match avatar.map(|a| a.trim().to_string()).filter(|a| !a.is_empty()) {
        Some(a) if a.len() > 3_000_000 => Err("Das Profilbild ist zu groß.".into()),
        other => Ok(other),
    }
}

/// Profile laden; beim ersten Start (oder wenn die Datei fehlt/kaputt ist) ein Standardprofil anlegen.
pub fn load_or_init(paths: &Paths) -> ProfilesState {
    let file = paths.profiles_file();
    let raw = fs::read_to_string(&file).ok();
    let parsed: Option<ProfilesState> = raw.as_deref().and_then(|t| serde_json::from_str(t).ok());
    if raw.is_some() && parsed.is_none() {
        // Kaputte Datei aufheben, statt sie stillschweigend zu überschreiben
        let _ = fs::copy(&file, file.with_extension("json.broken"));
    }
    let mut state = parsed.unwrap_or_default();

    let mut seen = HashSet::new();
    state.profiles.retain(|p| is_plain_name(&p.id) && seen.insert(p.id.clone()));
    for p in &mut state.profiles {
        if p.name.trim().is_empty() {
            p.name = DEFAULT_PROFILE_NAME.into();
        }
        if p.color.trim().is_empty() {
            p.color = DEFAULT_PROFILE_COLOR.into();
        }
    }

    if state.profiles.is_empty() {
        // Vorhandene Profilordner wiederfinden (z. B. nach gelöschter profiles.json)
        if let Ok(rd) = fs::read_dir(paths.data_dir.join("profiles")) {
            let mut found: Vec<_> = rd
                .filter_map(|e| e.ok())
                .filter(|e| e.path().join("nova.db").is_file())
                .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
                .filter(|id| is_plain_name(id))
                .collect();
            found.sort();
            for (i, id) in found.into_iter().enumerate() {
                state.profiles.push(Profile {
                    id,
                    name: if i == 0 {
                        DEFAULT_PROFILE_NAME.into()
                    } else {
                        format!("Profil {}", i + 1)
                    },
                    color: DEFAULT_PROFILE_COLOR.into(),
                    avatar: None,
                    created_at: now_ms(),
                });
            }
        }
    }
    if state.profiles.is_empty() {
        state
            .profiles
            .push(new_profile(DEFAULT_PROFILE_NAME, DEFAULT_PROFILE_COLOR, None));
    }
    if !state.profiles.iter().any(|p| p.id == state.active_id) {
        state.active_id = state.profiles[0].id.clone();
    }
    if let Err(e) = save(paths, &state) {
        eprintln!("profiles.json konnte nicht gespeichert werden: {e}");
    }
    state
}

pub fn save(paths: &Paths, state: &ProfilesState) -> CmdResult<()> {
    let json = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    write_atomic(&paths.profiles_file(), &json)
}

/// Wechselt das aktive Profil: Sitzungen abschließen, alte DB schließen, neue öffnen.
pub fn switch_profile(core: &Arc<Core>, id: &str) -> CmdResult<()> {
    {
        let p = core.profiles.lock_safe();
        if !p.profiles.iter().any(|x| x.id == id) {
            return Err("Das Profil wurde nicht gefunden.".into());
        }
        if p.active_id == id {
            return Ok(());
        }
    }
    // Neue Datenbank zuerst öffnen – schlägt das fehl, bleibt alles beim Alten
    let new_db = crate::backup::open_with_recovery(&core.paths, id)?;
    core.tracker.finalize_all(core, true, true);
    core.db.replace(Some(new_db));
    let result = {
        let mut p = core.profiles.lock_safe();
        p.active_id = id.to_string();
        save(&core.paths, &p)
    };
    core.tracker.resume();
    crate::backup::auto_backup_in_background(core.clone());
    result
}

// =============================================================================================
// Befehle
// =============================================================================================

#[tauri::command]
pub async fn app_info(state: State<'_, Shared>) -> CmdResult<AppInfo> {
    let platform = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    Ok(AppInfo {
        version: crate::config::config().version.clone(),
        data_dir: display_path(&state.paths.data_dir),
        cache_dir: display_path(&state.paths.cache_dir),
        profile_id: state.active_profile_id(),
        platform: platform.into(),
        started_minimized: state.started_minimized,
    })
}

#[tauri::command]
pub async fn profiles_list(state: State<'_, Shared>) -> CmdResult<ProfilesState> {
    Ok(state.profiles.lock_safe().clone())
}

#[tauri::command]
pub async fn profile_create(
    state: State<'_, Shared>,
    name: String,
    color: String,
    avatar: Option<String>,
) -> CmdResult<Profile> {
    let profile = new_profile(&clean_name(&name)?, &clean_color(&color), clean_avatar(avatar)?);
    let core = state.inner().clone();
    blocking(move || {
        let dir = core.paths.profile_dir(&profile.id);
        fs::create_dir_all(&dir).map_err(|e| io_err(&e, &dir))?;
        let mut p = core.profiles.lock_safe();
        p.profiles.push(profile.clone());
        if let Err(e) = save(&core.paths, &p) {
            p.profiles.retain(|x| x.id != profile.id);
            return Err(e);
        }
        Ok(profile)
    })
    .await
}

#[tauri::command]
pub async fn profile_update(state: State<'_, Shared>, profile: Profile) -> CmdResult<()> {
    let name = clean_name(&profile.name)?;
    let color = clean_color(&profile.color);
    let avatar = clean_avatar(profile.avatar.clone())?;
    let core = state.inner().clone();
    blocking(move || {
        let mut p = core.profiles.lock_safe();
        let before = p.clone();
        let entry = p
            .profiles
            .iter_mut()
            .find(|x| x.id == profile.id)
            .ok_or_else(|| "Das Profil wurde nicht gefunden.".to_string())?;
        entry.name = name;
        entry.color = color;
        entry.avatar = avatar;
        if let Err(e) = save(&core.paths, &p) {
            *p = before;
            return Err(e);
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn profile_delete(state: State<'_, Shared>, id: String) -> CmdResult<()> {
    let core = state.inner().clone();
    blocking(move || {
        {
            let mut p = core.profiles.lock_safe();
            if p.active_id == id {
                return Err("Das aktive Profil kann nicht gelöscht werden. Wechsle zuerst zu einem anderen Profil.".into());
            }
            if !p.profiles.iter().any(|x| x.id == id) {
                return Err("Das Profil wurde nicht gefunden.".into());
            }
            if p.profiles.len() <= 1 {
                return Err("Das letzte Profil kann nicht gelöscht werden.".into());
            }
            let before = p.clone();
            p.profiles.retain(|x| x.id != id);
            if let Err(e) = save(&core.paths, &p) {
                *p = before;
                return Err(e);
            }
        }
        // Daten des Profils entfernen (Fehler hier sind nicht kritisch)
        let dir = core.paths.profile_dir(&id);
        if dir.exists() {
            if let Err(e) = fs::remove_dir_all(&dir) {
                eprintln!("Profilordner konnte nicht gelöscht werden: {}", io_err(&e, &dir));
            }
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn profile_switch(state: State<'_, Shared>, id: String) -> CmdResult<()> {
    let core = state.inner().clone();
    blocking(move || switch_profile(&core, &id)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn first_run_creates_default_profile() {
        let dir = tempfile::tempdir().unwrap();
        let paths = crate::state::test_paths(dir.path());
        let st = load_or_init(&paths);
        assert_eq!(st.profiles.len(), 1);
        assert_eq!(st.profiles[0].name, "Spieler");
        assert_eq!(st.profiles[0].color, "#ff4f8b");
        assert_eq!(st.active_id, st.profiles[0].id);
        // Zweiter Start liest dieselbe Datei
        let again = load_or_init(&paths);
        assert_eq!(again, st);
    }

    #[test]
    fn broken_file_recovers_existing_profiles() {
        let dir = tempfile::tempdir().unwrap();
        let paths = crate::state::test_paths(dir.path());
        Db::open(&paths.db_path("abc123")).unwrap();
        fs::write(paths.profiles_file(), "{kaputt").unwrap();
        let st = load_or_init(&paths);
        assert_eq!(st.profiles.len(), 1);
        assert_eq!(st.profiles[0].id, "abc123");
        assert!(paths.data_dir.join("profiles.json.broken").exists());
    }

    #[test]
    fn name_validation() {
        assert!(clean_name("   ").is_err());
        assert_eq!(clean_name("  Max ").unwrap(), "Max");
        assert_eq!(clean_color(""), "#ff4f8b");
    }
}
