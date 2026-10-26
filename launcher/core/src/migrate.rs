//! One-time move from the old name: Niobium used to be called "Vanity".
//!
//! Runs once at launcher start, before the config is read:
//! - `%APPDATA%\Niobium\config.json` missing and `%APPDATA%\Vanity\config.json` there → copy
//!   `config.json` (and `client.json`, the F9 menu settings) over.
//! - `%LOCALAPPDATA%\Niobium\server` missing and `%LOCALAPPDATA%\Vanity\server` there → copy that
//!   folder's files (server settings, loadouts, maps …). Logs are not copied.
//!
//! Only copies, never deletes: the old folders stay as they are.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::profiles::{Config, APP_DIR, LEGACY_APP_DIR};

/// `settings.lastSeenVersion` for a config that came over from Vanity. It is not empty, so the UI
/// doesn't show the full first-run welcome to someone who already used the launcher, and it never
/// equals an app version, so the UI shows the short "What's new" card that explains the new name.
pub const FROM_VANITY_MARKER: &str = "vanity";

/// The four folders the migration looks at.
#[derive(Debug, Clone)]
pub struct MigrationPaths {
    /// `%APPDATA%\Vanity`
    pub old_config: PathBuf,
    /// `%APPDATA%\Niobium`
    pub new_config: PathBuf,
    /// `%LOCALAPPDATA%\Vanity`
    pub old_local: PathBuf,
    /// `%LOCALAPPDATA%\Niobium`
    pub new_local: PathBuf,
}

impl MigrationPaths {
    /// The real folders of this user. None if Windows doesn't tell us where they are.
    pub fn for_this_user() -> Option<MigrationPaths> {
        let roaming = dirs::config_dir().or_else(dirs::data_dir)?;
        let local = dirs::data_local_dir()?;
        Some(MigrationPaths {
            old_config: roaming.join(LEGACY_APP_DIR),
            new_config: roaming.join(APP_DIR),
            old_local: local.join(LEGACY_APP_DIR),
            new_local: local.join(APP_DIR),
        })
    }
}

/// What was copied.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct MigrationReport {
    /// Names of copied files from the config folder (`config.json`, `client.json`)
    pub config_files: Vec<String>,
    /// Number of files copied from the old server folder
    pub server_files: usize,
    /// Problems (the launcher keeps going with whatever worked)
    pub errors: Vec<String>,
}

impl MigrationReport {
    pub fn did_anything(&self) -> bool {
        !self.config_files.is_empty() || self.server_files > 0 || !self.errors.is_empty()
    }

    /// True if the launcher config (`config.json`) was copied over in this run.
    pub fn copied_config(&self) -> bool {
        self.config_files.iter().any(|f| f == "config.json")
    }

    /// One English line for the log, or None if there was nothing to move.
    pub fn summary(&self) -> Option<String> {
        if !self.did_anything() {
            return None;
        }
        let mut moved = Vec::new();
        if !self.config_files.is_empty() {
            moved.push(self.config_files.join(" and "));
        }
        if self.server_files > 0 {
            moved.push(format!(
                "{} server setting file{}",
                self.server_files,
                if self.server_files == 1 { "" } else { "s" }
            ));
        }
        let mut line = if moved.is_empty() {
            "Tried to copy your settings from Vanity to Niobium".to_string()
        } else {
            format!("Copied your settings from Vanity to Niobium ({}). The old Vanity folders were left as they are", moved.join(", "))
        };
        if !self.errors.is_empty() {
            line.push_str(&format!(" – some files couldn't be copied: {}", self.errors.join("; ")));
        }
        line.push('.');
        Some(line)
    }
}

/// Call after loading a config that was just copied from Vanity: marks it so the UI greets the
/// user with "What's new" (Vanity is now Niobium) instead of the first-run welcome. Leaves a config
/// alone that already has a last-seen version. Returns true if it changed something.
pub fn mark_as_from_vanity(config: &mut Config) -> bool {
    if config.settings.last_seen_version.as_deref().is_some_and(|v| !v.trim().is_empty()) {
        return false;
    }
    config.settings.last_seen_version = Some(FROM_VANITY_MARKER.to_string());
    true
}

/// Files in the config folder that move over (in this order).
pub const CONFIG_FILES: [&str; 2] = ["config.json", "client.json"];

/// Copies old data over, if the new places are still empty. Safe to call on every start.
pub fn migrate(paths: &MigrationPaths) -> MigrationReport {
    let mut report = MigrationReport::default();

    // 1) %APPDATA%: config.json (+ client.json)
    let old_cfg = paths.old_config.join("config.json");
    let new_cfg = paths.new_config.join("config.json");
    if !new_cfg.exists() && old_cfg.is_file() {
        if let Err(e) = fs::create_dir_all(&paths.new_config) {
            report.errors.push(format!("{}: {e}", paths.new_config.display()));
        } else {
            for name in CONFIG_FILES {
                let from = paths.old_config.join(name);
                let to = paths.new_config.join(name);
                // client.json may already exist (the F9 menu could have written one); never overwrite
                if !from.is_file() || to.exists() {
                    continue;
                }
                match copy_file(&from, &to) {
                    Ok(()) => report.config_files.push(name.to_string()),
                    Err(e) => report.errors.push(format!("{name}: {e}")),
                }
            }
        }
    }

    // 2) %LOCALAPPDATA%: the server folder (not the logs)
    let old_server = paths.old_local.join("server");
    let new_server = paths.new_local.join("server");
    if !new_server.exists() && old_server.is_dir() {
        match copy_dir(&old_server, &new_server) {
            Ok(n) => report.server_files = n,
            Err(e) => report.errors.push(format!("server: {e}")),
        }
    }

    report
}

/// Copies one file via a temporary file next to the target, so a half-copied file never
/// looks like a real one.
fn copy_file(from: &Path, to: &Path) -> io::Result<()> {
    let tmp = to.with_extension("migrating.tmp");
    fs::copy(from, &tmp)?;
    if let Err(e) = fs::rename(&tmp, to) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// Copies a folder with its sub-folders. Skips folders called `logs` and anything that isn't a
/// normal file or folder (links). Returns the number of copied files.
fn copy_dir(from: &Path, to: &Path) -> io::Result<usize> {
    fs::create_dir_all(to)?;
    let mut count = 0;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let name = entry.file_name();
        let target = to.join(&name);
        if kind.is_dir() {
            if name.to_string_lossy().eq_ignore_ascii_case("logs") {
                continue;
            }
            count += copy_dir(&entry.path(), &target)?;
        } else if kind.is_file() {
            if target.exists() {
                continue;
            }
            fs::copy(entry.path(), &target)?;
            count += 1;
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("niobium-migrate-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn paths(root: &Path) -> MigrationPaths {
        MigrationPaths {
            old_config: root.join("Roaming/Vanity"),
            new_config: root.join("Roaming/Niobium"),
            old_local: root.join("Local/Vanity"),
            new_local: root.join("Local/Niobium"),
        }
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn copies_config_client_and_server_but_not_logs() {
        let root = temp_root("full");
        let p = paths(&root);
        write(&p.old_config.join("config.json"), r#"{"settings":{"playerName":"georg"}}"#);
        write(&p.old_config.join("client.json"), r#"{"hotkey":120}"#);
        write(&p.old_local.join("server/auto_hosting.json"), "{}");
        write(&p.old_local.join("server/loadouts/a.json"), "[]");
        write(&p.old_local.join("server/logs/old.log"), "x");
        write(&p.old_local.join("logs/redirect.log"), "x");
        // The installer already created the new local folder (the app is installed there)
        fs::create_dir_all(&p.new_local).unwrap();

        let r = migrate(&p);
        assert_eq!(r.config_files, vec!["config.json".to_string(), "client.json".to_string()]);
        assert!(r.copied_config());
        assert_eq!(r.server_files, 2);
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(r.summary().unwrap().starts_with("Copied your settings from Vanity to Niobium"));

        assert_eq!(fs::read_to_string(p.new_config.join("config.json")).unwrap(), r#"{"settings":{"playerName":"georg"}}"#);
        assert!(p.new_config.join("client.json").is_file());
        assert!(p.new_local.join("server/auto_hosting.json").is_file());
        assert!(p.new_local.join("server/loadouts/a.json").is_file());
        assert!(!p.new_local.join("server/logs").exists());
        assert!(!p.new_local.join("logs").exists());
        // nothing deleted, no temp files left
        assert!(p.old_config.join("config.json").is_file());
        assert!(p.old_local.join("server/auto_hosting.json").is_file());
        assert_eq!(fs::read_dir(&p.new_config).unwrap().count(), 2);

        // A second start changes nothing
        let again = migrate(&p);
        assert!(!again.did_anything());
        assert_eq!(again.summary(), None);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn existing_niobium_config_is_never_touched() {
        let root = temp_root("existing");
        let p = paths(&root);
        write(&p.old_config.join("config.json"), "old");
        write(&p.old_config.join("client.json"), "old");
        write(&p.new_config.join("config.json"), "new");
        write(&p.old_local.join("server/a.json"), "old");
        write(&p.new_local.join("server/b.json"), "new");

        let r = migrate(&p);
        assert!(!r.did_anything());
        assert_eq!(fs::read_to_string(p.new_config.join("config.json")).unwrap(), "new");
        assert!(!p.new_config.join("client.json").exists());
        assert!(!p.new_local.join("server/a.json").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn nothing_old_means_nothing_to_do() {
        let root = temp_root("empty");
        let p = paths(&root);
        let r = migrate(&p);
        assert!(!r.did_anything());
        assert!(!p.new_config.exists());
        assert!(!p.new_local.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn client_json_alone_does_not_trigger_and_is_not_overwritten() {
        let root = temp_root("client");
        let p = paths(&root);
        // only client.json in the old folder: config.json is the trigger, so nothing happens
        write(&p.old_config.join("client.json"), "old");
        assert!(!migrate(&p).did_anything());
        // config.json there, but the F9 menu already wrote a new client.json: keep the new one
        write(&p.old_config.join("config.json"), "{}");
        write(&p.new_config.join("client.json"), "new");
        let r = migrate(&p);
        assert_eq!(r.config_files, vec!["config.json".to_string()]);
        assert_eq!(fs::read_to_string(p.new_config.join("client.json")).unwrap(), "new");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn server_only_migration_does_not_count_as_copied_config() {
        let r = MigrationReport { server_files: 3, ..Default::default() };
        assert!(r.did_anything());
        assert!(!r.copied_config());
    }

    #[test]
    fn vanity_users_get_whats_new_not_the_first_run_welcome() {
        let mut c = Config::default();
        assert!(mark_as_from_vanity(&mut c));
        assert_eq!(c.settings.last_seen_version.as_deref(), Some(FROM_VANITY_MARKER));
        // never an app version, so the UI shows "What's new"
        assert!(!FROM_VANITY_MARKER.chars().next().unwrap().is_ascii_digit());
        // an empty value counts as "never opened"
        c.settings.last_seen_version = Some(String::new());
        assert!(mark_as_from_vanity(&mut c));
        // a real last-seen version is kept
        c.settings.last_seen_version = Some("0.1.0".into());
        assert!(!mark_as_from_vanity(&mut c));
        assert_eq!(c.settings.last_seen_version.as_deref(), Some("0.1.0"));
    }
}
