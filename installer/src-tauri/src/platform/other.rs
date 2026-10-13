//! Ersatzfunktionen für Linux/macOS: keine Registry, keine Verknüpfungen, keine UAC.
//! Dateien herunterladen, prüfen, kopieren und löschen funktioniert trotzdem.

use super::{ElevateError, UninstallEntry};
use crate::util::tr;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn system_lang_is_german() -> bool {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .filter_map(|v| std::env::var(v).ok())
        .find(|v| !v.is_empty())
        .is_some_and(|v| v.to_ascii_lowercase().starts_with("de"))
}

pub fn is_elevated() -> bool {
    false
}

pub fn program_files_dirs() -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(unix)]
pub fn disk_free_total(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    let frsize = if st.f_frsize > 0 { st.f_frsize as u64 } else { st.f_bsize as u64 };
    Some((st.f_bavail as u64 * frsize, st.f_blocks as u64 * frsize))
}

#[cfg(not(unix))]
pub fn disk_free_total(_path: &Path) -> Option<(u64, u64)> {
    None
}

pub fn attach_parent_console() {}

pub fn integration_supported() -> bool {
    false
}

pub fn running_process_ids(_exe_name: &str) -> Vec<u32> {
    Vec::new()
}

pub fn is_process_running(_exe_name: &str) -> bool {
    false
}

pub fn kill_processes(_exe_name: &str) -> Result<usize, String> {
    Ok(0)
}

pub fn start_menu_dir() -> Option<PathBuf> {
    None
}

pub fn desktop_dir() -> Option<PathBuf> {
    None
}

pub fn create_shortcut(_lnk: &Path, _target: &Path, _workdir: &Path, _description: &str) -> Result<(), String> {
    Err(tr("Verknüpfungen werden nur unter Windows angelegt.", "Shortcuts are only created on Windows."))
}

pub fn set_autostart(_exe: Option<&Path>) -> Result<(), String> {
    Ok(())
}

pub fn autostart_command() -> Option<String> {
    None
}

pub fn register_uninstall(_e: &UninstallEntry, _machine: bool) -> Result<(), String> {
    Ok(())
}

pub fn uninstall_entry_exists() -> (bool, bool) {
    (false, false)
}

pub fn unregister_uninstall() -> Vec<String> {
    Vec::new()
}

pub fn write_install_state(_dir: &Path, _version: &str) -> Result<(), String> {
    Ok(())
}

pub fn read_install_state() -> Option<(PathBuf, String)> {
    None
}

pub fn delete_install_state() -> Result<(), String> {
    Ok(())
}

pub fn shell_execute_elevated(_exe: &Path, _args: &[String]) -> Result<(), ElevateError> {
    Err(ElevateError::Unsupported)
}

pub fn launch_unelevated(exe: &Path, workdir: &Path, _elevated: bool) -> Result<(), String> {
    Command::new(exe)
        .current_dir(workdir)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("{}: {e}", tr("Pulsar konnte nicht gestartet werden", "Could not start Pulsar")))
}

pub fn spawn_detached(exe: &Path, args: &[String]) -> Result<(), String> {
    Command::new(exe).args(args).spawn().map(|_| ()).map_err(|e| e.to_string())
}

pub fn open_url(url: &str) -> Result<(), String> {
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    Command::new(opener)
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|_| tr("Der Link konnte nicht geöffnet werden.", "Could not open the link."))
}

/// Unter Unix darf eine laufende Datei direkt gelöscht werden.
pub fn schedule_self_delete(exe: &Path, dir: Option<&Path>, purge: &[PathBuf]) -> Result<(), String> {
    let _ = std::fs::remove_file(exe);
    if let Some(d) = dir {
        let _ = std::fs::remove_dir(d);
    }
    for p in purge {
        let _ = std::fs::remove_dir_all(p);
    }
    Ok(())
}

pub fn show_error_box(caption: &str, text: &str) {
    crate::util::eprint_line(format!("{caption}: {text}"));
}

pub fn ensure_webview2() -> bool {
    true
}
