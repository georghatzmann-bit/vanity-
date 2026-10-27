//! One-time copy from the old names: Rift used to be called "Niobium", and before that "Vanity".
//!
//! Runs once at launcher start, before the config is read. For each item the newest old name that
//! has it is used (Niobium first; Vanity only if there is no Niobium copy of that item):
//! - `%APPDATA%\Rift\config.json` missing and an old `config.json` there → copy `config.json` (and
//!   `client.json`, the F9 menu settings) from that old folder. In the same run (and only then) a
//!   `gus-backup.json` (Fortnite settings backup, see `crate::perfmode`) from that old name comes
//!   along, so a backup left by a crash is still put back – but never again on a later start.
//! - `%LOCALAPPDATA%\Rift\server` missing and an old `server` folder there → copy that folder's
//!   files (server settings, parkours, loadouts, maps …). Logs are not copied.
//! - `%LOCALAPPDATA%\Rift\backend-data` missing and an old `backend-data` there → copy it (the
//!   backend's accounts and lockers). Logs are not copied. (Vanity kept its backend data in
//!   `backend`, which is not copied.)
//!
//! Only copies, never deletes: the old folders stay as they are. Never overwrites a file that is
//! already there. Builds stay where they are (the config keeps their full paths).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::perfmode::BACKUP_FILE;
use crate::profiles::{Config, APP_DIR, OLD_APP_DIRS};

/// `settings.lastSeenVersion` for a config that came over from an old name and had none. It is not
/// empty, so the UI doesn't show the full first-run welcome to someone who already used the
/// launcher, and it never equals an app version, so the UI shows the short "What's new" card that
/// explains the new name. (The value stays "vanity" so configs marked by Niobium keep working.)
pub const FROM_VANITY_MARKER: &str = "vanity";

/// Folder of the backend's data in `%LOCALAPPDATA%\<name>`.
pub const BACKEND_DATA_DIR: &str = "backend-data";

/// One earlier name of the app and its two folders.
#[derive(Debug, Clone)]
pub struct OldPlace {
    /// "Niobium" or "Vanity" (for the log line)
    pub name: &'static str,
    /// `%APPDATA%\<name>`
    pub config: PathBuf,
    /// `%LOCALAPPDATA%\<name>`
    pub local: PathBuf,
}

/// The folders the migration looks at.
#[derive(Debug, Clone)]
pub struct MigrationPaths {
    /// Earlier names, newest first: Niobium, then Vanity
    pub old: Vec<OldPlace>,
    /// `%APPDATA%\Rift`
    pub new_config: PathBuf,
    /// `%LOCALAPPDATA%\Rift`
    pub new_local: PathBuf,
}

impl MigrationPaths {
    /// The real folders of this user. None if Windows doesn't tell us where they are.
    pub fn for_this_user() -> Option<MigrationPaths> {
        let roaming = dirs::config_dir().or_else(dirs::data_dir)?;
        let local = dirs::data_local_dir()?;
        Some(MigrationPaths {
            old: OLD_APP_DIRS
                .iter()
                .map(|&name| OldPlace { name, config: roaming.join(name), local: local.join(name) })
                .collect(),
            new_config: roaming.join(APP_DIR),
            new_local: local.join(APP_DIR),
        })
    }
}

/// What was copied.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct MigrationReport {
    /// Old names something was copied (or tried) from, newest first
    pub from: Vec<&'static str>,
    /// Names of copied files from the config folder (`config.json`, `client.json`)
    pub config_files: Vec<String>,
    /// Number of files copied from the old server folder
    pub server_files: usize,
    /// Number of files copied from the old `backend-data` folder
    pub backend_files: usize,
    /// True if the Fortnite settings backup (`gus-backup.json`) was copied
    pub gus_backup: bool,
    /// Problems (the launcher keeps going with whatever worked)
    pub errors: Vec<String>,
}

impl MigrationReport {
    pub fn did_anything(&self) -> bool {
        !self.config_files.is_empty()
            || self.server_files > 0
            || self.backend_files > 0
            || self.gus_backup
            || !self.errors.is_empty()
    }

    /// True if the launcher config (`config.json`) was copied over in this run.
    pub fn copied_config(&self) -> bool {
        self.config_files.iter().any(|f| f == "config.json")
    }

    fn note_source(&mut self, name: &'static str) {
        if !self.from.contains(&name) {
            self.from.push(name);
        }
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
            moved.push(count(self.server_files, "server setting file"));
        }
        if self.backend_files > 0 {
            moved.push(count(self.backend_files, "backend file"));
        }
        if self.gus_backup {
            moved.push("the backup of Fortnite's graphics settings".to_string());
        }
        let from = if self.from.is_empty() { OLD_APP_DIRS.join(" or ") } else { self.from.join(" and ") };
        let mut line = if moved.is_empty() {
            format!("Tried to copy your settings from {from} to Rift")
        } else {
            format!(
                "Copied your settings from {from} to Rift ({}). The old {from} folders were left as they are",
                moved.join(", ")
            )
        };
        if !self.errors.is_empty() {
            line.push_str(&format!(" – some files couldn't be copied: {}", self.errors.join("; ")));
        }
        line.push('.');
        Some(line)
    }
}

fn count(n: usize, what: &str) -> String {
    format!("{n} {what}{}", if n == 1 { "" } else { "s" })
}

/// Call after loading a config that was just copied from an old name: marks it so the UI greets
/// the user with "What's new" (the new name) instead of the first-run welcome. Leaves a config
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

    // 1) %APPDATA%: config.json (+ client.json), from the newest old name that has a config.json
    let new_cfg = paths.new_config.join("config.json");
    let config_source = paths.old.iter().find(|o| o.config.join("config.json").is_file());
    if let (false, Some(src)) = (new_cfg.exists(), config_source) {
        report.note_source(src.name);
        if let Err(e) = fs::create_dir_all(&paths.new_config) {
            report.errors.push(format!("{}: {e}", paths.new_config.display()));
        } else {
            for name in CONFIG_FILES {
                let from = src.config.join(name);
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

        // 1b) the Fortnite settings backup of the same old name – only together with the config,
        // so a backup that Rift has already put back (and deleted) is never copied a second time
        let from = src.local.join(BACKUP_FILE);
        let to = paths.new_local.join(BACKUP_FILE);
        if report.copied_config() && from.is_file() && !to.exists() {
            match fs::create_dir_all(&paths.new_local).and_then(|()| copy_file(&from, &to)) {
                Ok(()) => report.gus_backup = true,
                Err(e) => report.errors.push(format!("{BACKUP_FILE}: {e}")),
            }
        }
    }

    // 2) %LOCALAPPDATA%: the server folder (not the logs)
    let new_server = paths.new_local.join("server");
    if let (false, Some(src)) = (new_server.exists(), paths.old.iter().find(|o| o.local.join("server").is_dir())) {
        report.note_source(src.name);
        match copy_dir(&src.local.join("server"), &new_server) {
            Ok(n) => report.server_files = n,
            Err(e) => report.errors.push(format!("server: {e}")),
        }
    }

    // 3) %LOCALAPPDATA%: the backend's data (accounts, lockers; not the logs)
    let new_backend = paths.new_local.join(BACKEND_DATA_DIR);
    if let (false, Some(src)) =
        (new_backend.exists(), paths.old.iter().find(|o| o.local.join(BACKEND_DATA_DIR).is_dir()))
    {
        report.note_source(src.name);
        match copy_dir(&src.local.join(BACKEND_DATA_DIR), &new_backend) {
            Ok(n) => report.backend_files = n,
            Err(e) => report.errors.push(format!("{BACKEND_DATA_DIR}: {e}")),
        }
    }

    // Keep the names in the order "newest first", whatever was found first
    report.from.sort_by_key(|name| OLD_APP_DIRS.iter().position(|o| o == name));
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
        let dir = std::env::temp_dir().join(format!("rift-migrate-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn paths(root: &Path) -> MigrationPaths {
        MigrationPaths {
            old: OLD_APP_DIRS
                .iter()
                .map(|&name| OldPlace {
                    name,
                    config: root.join("Roaming").join(name),
                    local: root.join("Local").join(name),
                })
                .collect(),
            new_config: root.join("Roaming/Rift"),
            new_local: root.join("Local/Rift"),
        }
    }

    fn niobium(p: &MigrationPaths) -> &OldPlace {
        p.old.iter().find(|o| o.name == "Niobium").unwrap()
    }

    fn vanity(p: &MigrationPaths) -> &OldPlace {
        p.old.iter().find(|o| o.name == "Vanity").unwrap()
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn old_names_are_niobium_then_vanity() {
        assert_eq!(OLD_APP_DIRS, ["Niobium", "Vanity"]);
        assert_eq!(APP_DIR, "Rift");
    }

    #[test]
    fn vanity_alone_copies_config_client_and_server_but_not_logs() {
        let root = temp_root("full");
        let p = paths(&root);
        let v = vanity(&p).clone();
        write(&v.config.join("config.json"), r#"{"settings":{"playerName":"georg"}}"#);
        write(&v.config.join("client.json"), r#"{"hotkey":120}"#);
        write(&v.local.join("server/auto_hosting.json"), "{}");
        write(&v.local.join("server/loadouts/a.json"), "[]");
        write(&v.local.join("server/logs/old.log"), "x");
        write(&v.local.join("logs/redirect.log"), "x");
        write(&v.local.join("backend/profiles/athena.json"), "{}");
        // The installer already created the new local folder (the app is installed there)
        fs::create_dir_all(&p.new_local).unwrap();

        let r = migrate(&p);
        assert_eq!(r.from, vec!["Vanity"]);
        assert_eq!(r.config_files, vec!["config.json".to_string(), "client.json".to_string()]);
        assert!(r.copied_config());
        assert_eq!(r.server_files, 2);
        assert_eq!(r.backend_files, 0);
        assert!(!r.gus_backup);
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        let summary = r.summary().unwrap();
        assert!(summary.starts_with("Copied your settings from Vanity to Rift"), "{summary}");
        assert!(summary.contains("The old Vanity folders were left as they are"), "{summary}");

        assert_eq!(fs::read_to_string(p.new_config.join("config.json")).unwrap(), r#"{"settings":{"playerName":"georg"}}"#);
        assert!(p.new_config.join("client.json").is_file());
        assert!(p.new_local.join("server/auto_hosting.json").is_file());
        assert!(p.new_local.join("server/loadouts/a.json").is_file());
        assert!(!p.new_local.join("server/logs").exists());
        assert!(!p.new_local.join("logs").exists());
        // Vanity's old backend folder is not copied
        assert!(!p.new_local.join("backend").exists());
        assert!(!p.new_local.join(BACKEND_DATA_DIR).exists());
        // nothing deleted, no temp files left
        assert!(v.config.join("config.json").is_file());
        assert!(v.local.join("server/auto_hosting.json").is_file());
        assert_eq!(fs::read_dir(&p.new_config).unwrap().count(), 2);

        // A second start changes nothing
        let again = migrate(&p);
        assert!(!again.did_anything());
        assert_eq!(again.summary(), None);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn niobium_copies_config_server_backend_data_and_gus_backup_once() {
        let root = temp_root("niobium");
        let p = paths(&root);
        let n = niobium(&p).clone();
        write(&n.config.join("config.json"), r#"{"settings":{"lastSeenVersion":"0.1.0"}}"#);
        write(&n.config.join("client.json"), r#"{"hotkey":120}"#);
        write(&n.config.join("downloads.json"), "[]");
        write(&n.local.join("server/parkours.json"), "{}");
        write(&n.local.join("server/auto_hosting.json"), "{}");
        write(&n.local.join("backend-data/profiles/athena.json"), "{}");
        write(&n.local.join("backend-data/ClientSettings/ClientSettings-1.Sav"), "x");
        write(&n.local.join("backend-data/logs/backend.log"), "x");
        write(&n.local.join("gus-backup.json"), r#"{"format":1}"#);
        write(&n.local.join("logs/launcher.log"), "x");
        write(&n.local.join("Builds/19.10/FortniteGame/x.pak"), "x");
        // The old Niobium program files are still there until its uninstaller ran
        write(&n.local.join("Niobium.exe"), "exe");

        let r = migrate(&p);
        assert_eq!(r.from, vec!["Niobium"]);
        assert_eq!(r.config_files, vec!["config.json".to_string(), "client.json".to_string()]);
        assert_eq!(r.server_files, 2);
        assert_eq!(r.backend_files, 2);
        assert!(r.gus_backup);
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        let summary = r.summary().unwrap();
        assert!(summary.starts_with("Copied your settings from Niobium to Rift"), "{summary}");
        assert!(summary.contains("2 backend files"), "{summary}");
        assert!(summary.contains("The old Niobium folders were left as they are"), "{summary}");

        assert!(p.new_local.join("server/parkours.json").is_file());
        assert!(p.new_local.join("backend-data/profiles/athena.json").is_file());
        assert!(p.new_local.join("backend-data/ClientSettings/ClientSettings-1.Sav").is_file());
        assert!(!p.new_local.join("backend-data/logs").exists());
        assert_eq!(fs::read_to_string(p.new_local.join(BACKUP_FILE)).unwrap(), r#"{"format":1}"#);
        // only what belongs to the user: no logs, no builds, no program files, no download list
        assert!(!p.new_local.join("logs").exists());
        assert!(!p.new_local.join("Builds").exists());
        assert!(!p.new_local.join("Niobium.exe").exists());
        assert!(!p.new_config.join("downloads.json").exists());
        // nothing deleted
        for f in ["Roaming/Niobium/config.json", "Local/Niobium/gus-backup.json", "Local/Niobium/backend-data/profiles/athena.json"] {
            assert!(root.join(f).is_file(), "{f}");
        }

        // Rift puts the Fortnite settings back and deletes its backup: the old one never comes again
        fs::remove_file(p.new_local.join(BACKUP_FILE)).unwrap();
        let again = migrate(&p);
        assert!(!again.did_anything(), "{again:?}");
        assert!(!p.new_local.join(BACKUP_FILE).exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn niobium_wins_over_vanity() {
        let root = temp_root("both");
        let p = paths(&root);
        let (n, v) = (niobium(&p).clone(), vanity(&p).clone());
        write(&v.config.join("config.json"), "vanity");
        write(&v.config.join("client.json"), "vanity");
        write(&v.local.join("server/a.json"), "vanity");
        write(&n.config.join("config.json"), "niobium");
        write(&n.local.join("server/b.json"), "niobium");

        let r = migrate(&p);
        assert_eq!(r.from, vec!["Niobium"]);
        // client.json is only taken from the same folder as config.json
        assert_eq!(r.config_files, vec!["config.json".to_string()]);
        assert_eq!(fs::read_to_string(p.new_config.join("config.json")).unwrap(), "niobium");
        assert!(!p.new_config.join("client.json").exists());
        assert!(p.new_local.join("server/b.json").is_file());
        assert!(!p.new_local.join("server/a.json").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_items_fall_back_to_vanity() {
        let root = temp_root("mixed");
        let p = paths(&root);
        let (n, v) = (niobium(&p).clone(), vanity(&p).clone());
        write(&n.config.join("config.json"), "niobium");
        write(&v.local.join("server/a.json"), "vanity");

        let r = migrate(&p);
        assert_eq!(r.from, vec!["Niobium", "Vanity"]);
        assert_eq!(r.server_files, 1);
        assert!(r.summary().unwrap().starts_with("Copied your settings from Niobium and Vanity to Rift"));
        assert_eq!(fs::read_to_string(p.new_local.join("server/a.json")).unwrap(), "vanity");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn existing_rift_data_is_never_touched() {
        let root = temp_root("existing");
        let p = paths(&root);
        for o in p.old.clone() {
            write(&o.config.join("config.json"), "old");
            write(&o.config.join("client.json"), "old");
            write(&o.local.join("server/a.json"), "old");
            write(&o.local.join("backend-data/a.json"), "old");
            write(&o.local.join("gus-backup.json"), "old");
        }
        write(&p.new_config.join("config.json"), "new");
        write(&p.new_local.join("server/b.json"), "new");
        write(&p.new_local.join("backend-data/b.json"), "new");

        let r = migrate(&p);
        assert!(!r.did_anything(), "{r:?}");
        assert_eq!(fs::read_to_string(p.new_config.join("config.json")).unwrap(), "new");
        assert!(!p.new_config.join("client.json").exists());
        assert!(!p.new_local.join("server/a.json").exists());
        assert!(!p.new_local.join("backend-data/a.json").exists());
        assert!(!p.new_local.join(BACKUP_FILE).exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn nothing_old_means_nothing_to_do() {
        let root = temp_root("empty");
        let p = paths(&root);
        // the old Niobium install folder alone (program files, no user data) is nothing to copy
        write(&niobium(&p).local.join("Niobium.exe"), "exe");
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
        let n = niobium(&p).clone();
        // only client.json in the old folder: config.json is the trigger, so nothing happens
        write(&n.config.join("client.json"), "old");
        assert!(!migrate(&p).did_anything());
        // config.json there, but the F9 menu already wrote a new client.json: keep the new one
        write(&n.config.join("config.json"), "{}");
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
        let r = MigrationReport { backend_files: 1, ..Default::default() };
        assert!(r.did_anything());
        assert!(!r.copied_config());
    }

    #[test]
    fn errors_only_summary_names_the_old_names() {
        let r = MigrationReport { errors: vec!["server: denied".into()], ..Default::default() };
        assert_eq!(
            r.summary().unwrap(),
            "Tried to copy your settings from Niobium or Vanity to Rift – some files couldn't be copied: server: denied."
        );
    }

    #[test]
    fn users_of_an_old_name_get_whats_new_not_the_first_run_welcome() {
        let mut c = Config::default();
        assert!(mark_as_from_vanity(&mut c));
        assert_eq!(c.settings.last_seen_version.as_deref(), Some(FROM_VANITY_MARKER));
        // the marker Niobium wrote keeps its meaning
        assert_eq!(FROM_VANITY_MARKER, "vanity");
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
