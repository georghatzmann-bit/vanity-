//! Spiele, Werkzeuge, Ordner und Links starten bzw. öffnen.

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use tauri::{AppHandle, Manager, State};

use crate::error::{blocking, io_err, CmdResult, LockExt};
use crate::models::{LaunchConfig, LaunchType};
use crate::state::Shared;
use crate::util::clean_path;

// =============================================================================================
// Argumente
// =============================================================================================

/// Argumente wie Windows (`CommandLineToArgvW`) zerlegen: Anführungszeichen gruppieren,
/// `\"` ist ein wörtliches Anführungszeichen, `""` innerhalb von Anführungszeichen ebenfalls.
#[cfg_attr(windows, allow(dead_code))]
pub fn parse_args(input: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut has_token = false;
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\\' => {
                let mut n = 0;
                while i < chars.len() && chars[i] == '\\' {
                    n += 1;
                    i += 1;
                }
                if i < chars.len() && chars[i] == '"' {
                    cur.extend(std::iter::repeat_n('\\', n / 2));
                    if n % 2 == 1 {
                        cur.push('"');
                        i += 1;
                    }
                } else {
                    cur.extend(std::iter::repeat_n('\\', n));
                }
                has_token = true;
                continue;
            }
            '"' => {
                if in_quotes && i + 1 < chars.len() && chars[i + 1] == '"' {
                    cur.push('"');
                    i += 2;
                    continue;
                }
                in_quotes = !in_quotes;
                has_token = true;
            }
            c if c.is_whitespace() && !in_quotes => {
                if has_token {
                    args.push(std::mem::take(&mut cur));
                    has_token = false;
                }
            }
            c => {
                cur.push(c);
                has_token = true;
            }
        }
        i += 1;
    }
    if has_token {
        args.push(cur);
    }
    args
}

/// PE-Subsystem einer `.exe` (2 = Fenster, 3 = Konsole).
pub fn pe_subsystem(bytes: &[u8]) -> Option<u16> {
    if bytes.len() < 0x40 || &bytes[0..2] != b"MZ" {
        return None;
    }
    let pe = u32::from_le_bytes(bytes[0x3c..0x40].try_into().ok()?) as usize;
    if bytes.len() < pe + 0x5e || &bytes[pe..pe + 4] != b"PE\0\0" {
        return None;
    }
    Some(u16::from_le_bytes(bytes[pe + 0x5c..pe + 0x5e].try_into().ok()?))
}

fn is_console_exe(path: &Path) -> bool {
    use std::io::Read;
    let mut buf = vec![0u8; 4096];
    let Ok(mut f) = std::fs::File::open(path) else { return false };
    let n = f.read(&mut buf).unwrap_or(0);
    pe_subsystem(&buf[..n]) == Some(3)
}

fn spawn_err(e: &io::Error, exe: &Path) -> String {
    match e.raw_os_error() {
        Some(193) | Some(216) => format!("Die Datei ist kein gültiges Windows-Programm: {}", exe.display()),
        Some(1223) => "Der Start wurde abgebrochen.".into(),
        _ => io_err(e, exe),
    }
}

// =============================================================================================
// Windows: ShellExecuteEx
// =============================================================================================

#[cfg(windows)]
fn shell_execute(verb: &str, file: &str, params: &str, dir: Option<&Path>) -> CmdResult<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }
    let _com = crate::scan::startmenu::ComGuard::new();
    let verb_w = wide(std::ffi::OsStr::new(verb));
    let file_w = wide(std::ffi::OsStr::new(file));
    let params_w = wide(std::ffi::OsStr::new(params));
    let dir_w = dir.map(|d| wide(d.as_os_str()));
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
        lpVerb: PCWSTR(verb_w.as_ptr()),
        lpFile: PCWSTR(file_w.as_ptr()),
        lpParameters: if params.trim().is_empty() {
            PCWSTR::null()
        } else {
            PCWSTR(params_w.as_ptr())
        },
        lpDirectory: dir_w.as_ref().map(|d| PCWSTR(d.as_ptr())).unwrap_or(PCWSTR::null()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    unsafe { ShellExecuteExW(&mut info) }.map_err(|e| {
        let code = (e.code().0 as u32) & 0xFFFF;
        match code {
            1223 => "Der Start wurde abgebrochen.".to_string(),
            2 | 3 => format!("Die Datei wurde nicht gefunden: {file}"),
            5 => format!("Zugriff verweigert: {file}"),
            1155 => format!("Für diese Datei ist kein Programm zum Öffnen eingerichtet: {file}"),
            _ => format!("Konnte nicht gestartet werden: {file} ({})", e.message()),
        }
    })
}

// =============================================================================================
// Starten
// =============================================================================================

/// Programm ohne Konsolenfenster und unabhängig von Nova starten.
fn spawn_detached(exe: &Path, args: &str, work: Option<&Path>) -> CmdResult<()> {
    let mut cmd = Command::new(exe);
    if let Some(w) = work {
        cmd.current_dir(w);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        // Argumente unverändert weitergeben (wie in einer Windows-Verknüpfung)
        if !args.trim().is_empty() {
            cmd.raw_arg(args.trim());
        }
        let flags = if is_console_exe(exe) {
            CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP
        } else {
            DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        };
        cmd.creation_flags(flags);
        match cmd.spawn() {
            Ok(_child) => Ok(()),
            // ERROR_ELEVATION_REQUIRED: Programm verlangt Adminrechte → über die Shell (UAC) starten
            Err(e) if e.raw_os_error() == Some(740) => {
                shell_execute("open", &exe.to_string_lossy(), args, work)
            }
            Err(e) => Err(spawn_err(&e, exe)),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = is_console_exe;
        cmd.args(parse_args(args));
        match cmd.spawn() {
            Ok(mut child) => {
                // Prozess im Hintergrund abholen, damit kein Zombie bleibt
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                Ok(())
            }
            Err(e) => Err(spawn_err(&e, exe)),
        }
    }
}

fn run_as_admin(exe: &Path, args: &str, work: Option<&Path>) -> CmdResult<()> {
    #[cfg(windows)]
    {
        shell_execute("runas", &exe.to_string_lossy(), args, work)
    }
    #[cfg(not(windows))]
    {
        let _ = (exe, args, work);
        Err("Starten mit Administratorrechten ist nur unter Windows möglich.".into())
    }
}

fn existing_file(target: &str) -> CmdResult<PathBuf> {
    let p = clean_path(target);
    if target.trim().is_empty() {
        return Err("Es wurde kein Startziel angegeben.".into());
    }
    if !p.exists() {
        return Err(format!("Die Datei wurde nicht gefunden: {}", p.display()));
    }
    Ok(p)
}

fn work_dir_for(cfg_dir: Option<&str>, exe: &Path) -> Option<PathBuf> {
    cfg_dir
        .map(clean_path)
        .filter(|p| !p.as_os_str().is_empty() && p.is_dir())
        .or_else(|| exe.parent().map(|p| p.to_path_buf()))
}

/// Datei über die Shell öffnen (`.lnk`, `.url`, Dokumente …).
fn shell_open(target: &Path, args: &str, work: Option<&Path>) -> CmdResult<()> {
    #[cfg(windows)]
    {
        shell_execute("open", &target.to_string_lossy(), args, work)
    }
    #[cfg(not(windows))]
    {
        let _ = (args, work);
        tauri_plugin_opener::open_path(target, None::<&str>)
            .map_err(|e| format!("Konnte nicht geöffnet werden: {} ({e})", target.display()))
    }
}

/// URL prüfen (keine gefährlichen Schemata).
pub fn check_url(url: &str) -> CmdResult<String> {
    let u = url.trim();
    let scheme = u.split(':').next().unwrap_or("").to_lowercase();
    let valid_scheme = !scheme.is_empty()
        && u.contains(':')
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.');
    if !valid_scheme || matches!(scheme.as_str(), "file" | "javascript" | "data" | "vbscript") {
        return Err("Ungültiger Link.".into());
    }
    Ok(u.to_string())
}

fn open_url_now(url: &str) -> CmdResult<()> {
    let u = check_url(url)?;
    tauri_plugin_opener::open_url(&u, None::<&str>).map_err(|e| {
        if u.starts_with("steam:") {
            "Steam ist nicht installiert oder konnte nicht gestartet werden.".to_string()
        } else if u.starts_with("com.epicgames.launcher:") {
            "Der Epic Games Launcher ist nicht installiert oder konnte nicht gestartet werden.".to_string()
        } else {
            format!("Der Link konnte nicht geöffnet werden ({e}).")
        }
    })
}

/// Startet ein Spiel nach seiner Startkonfiguration (blockierend).
pub fn launch(cfg: &LaunchConfig) -> CmdResult<()> {
    match cfg.kind {
        LaunchType::Exe => {
            let exe = existing_file(&cfg.target)?;
            if exe.is_dir() {
                return Err(format!("Das Startziel ist ein Ordner, kein Programm: {}", exe.display()));
            }
            let work = work_dir_for(cfg.work_dir.as_deref(), &exe);
            let args = cfg.args.clone().unwrap_or_default();
            if cfg.as_admin == Some(true) {
                run_as_admin(&exe, &args, work.as_deref())
            } else {
                spawn_detached(&exe, &args, work.as_deref())
            }
        }
        LaunchType::Url => open_url_now(&cfg.target),
        LaunchType::Shell => {
            let target = existing_file(&cfg.target)?;
            let work = cfg
                .work_dir
                .as_deref()
                .map(clean_path)
                .filter(|p| p.is_dir());
            shell_open(&target, cfg.args.as_deref().unwrap_or(""), work.as_deref())
        }
    }
}

// =============================================================================================
// Befehle
// =============================================================================================

#[tauri::command]
pub async fn launch_game(
    app: AppHandle,
    state: State<'_, Shared>,
    game_id: String,
    launch: LaunchConfig,
) -> CmdResult<()> {
    if game_id.trim().is_empty() {
        return Err("Ungültige Spiel-ID.".into());
    }
    let cfg = launch.clone();
    blocking(move || self::launch(&cfg)).await?;
    state.tracker.mark_launched(&game_id, &launch);
    let minimize = state.native.lock_safe().settings.minimize_on_launch;
    if minimize {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.minimize();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_game(state: State<'_, Shared>, game_id: String) -> CmdResult<u32> {
    let core = state.inner().clone();
    blocking(move || core.tracker.stop_game(&core, &game_id)).await
}

#[tauri::command]
pub async fn running_games(state: State<'_, Shared>) -> CmdResult<Vec<crate::models::RunningGame>> {
    Ok(state.tracker.running())
}

#[tauri::command]
pub async fn set_tracked_games(state: State<'_, Shared>, games: Vec<crate::models::TrackInfo>) -> CmdResult<()> {
    let core = state.inner().clone();
    blocking(move || {
        core.tracker.set_games(&core, games);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn launch_tool(path: String, args: Option<String>) -> CmdResult<()> {
    blocking(move || {
        let p = existing_file(&path)?;
        if p.is_dir() {
            return tauri_plugin_opener::open_path(&p, None::<&str>)
                .map_err(|e| format!("Der Ordner konnte nicht geöffnet werden ({e})."));
        }
        let args = args.unwrap_or_default();
        let is_exe = p
            .extension()
            .map(|e| e.eq_ignore_ascii_case("exe"))
            .unwrap_or(false);
        if is_exe {
            spawn_detached(&p, &args, p.parent())
        } else {
            shell_open(&p, &args, p.parent())
        }
    })
    .await
}

#[tauri::command]
pub async fn open_path(path: String) -> CmdResult<()> {
    blocking(move || {
        let p = existing_file(&path)?;
        tauri_plugin_opener::open_path(&p, None::<&str>)
            .map_err(|e| format!("Konnte nicht geöffnet werden: {} ({e})", p.display()))
    })
    .await
}

#[tauri::command]
pub async fn reveal_path(path: String) -> CmdResult<()> {
    blocking(move || {
        let p = existing_file(&path)?;
        tauri_plugin_opener::reveal_item_in_dir(&p)
            .map_err(|e| format!("Der Ordner konnte nicht angezeigt werden ({e})."))
    })
    .await
}

#[tauri::command]
pub async fn open_url(url: String) -> CmdResult<()> {
    blocking(move || open_url_now(&url)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_parsing() {
        assert_eq!(parse_args(""), Vec::<String>::new());
        assert_eq!(parse_args("  -windowed   -dx11 "), vec!["-windowed", "-dx11"]);
        assert_eq!(parse_args(r#"-config "C:\My Games\x.ini" -v"#), vec!["-config", r"C:\My Games\x.ini", "-v"]);
        assert_eq!(parse_args(r#"-name="Max Mustermann""#), vec!["-name=Max Mustermann"]);
        assert_eq!(parse_args(r#"a\"b"#), vec![r#"a"b"#]);
        assert_eq!(parse_args(r#""a ""quoted"" word""#), vec![r#"a "quoted" word"#]);
        assert_eq!(parse_args(r#"C:\path\ "x y""#), vec![r"C:\path\", "x y"]);
        assert_eq!(parse_args(r#""""#), vec![""]);
        assert_eq!(parse_args(r#""unclosed arg"#), vec!["unclosed arg"]);
    }

    #[test]
    fn pe_subsystem_detection() {
        let mut bytes = vec![0u8; 512];
        bytes[0] = b'M';
        bytes[1] = b'Z';
        bytes[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        bytes[0x80..0x84].copy_from_slice(b"PE\0\0");
        bytes[0x80 + 0x5c..0x80 + 0x5e].copy_from_slice(&3u16.to_le_bytes());
        assert_eq!(pe_subsystem(&bytes), Some(3));
        bytes[0x80 + 0x5c] = 2;
        assert_eq!(pe_subsystem(&bytes), Some(2));
        assert_eq!(pe_subsystem(b"kein programm"), None);
    }

    #[test]
    fn url_validation() {
        assert!(check_url("https://example.com").is_ok());
        assert!(check_url("steam://rungameid/570").is_ok());
        assert!(check_url("com.epicgames.launcher://apps/x").is_ok());
        assert!(check_url("javascript:alert(1)").is_err());
        assert!(check_url("file:///C:/x").is_err());
        assert!(check_url("kein link").is_err());
    }

    #[test]
    fn missing_exe_is_friendly() {
        let cfg = LaunchConfig::exe("/gibt/es/nicht.exe", None, None);
        let err = launch(&cfg).unwrap_err();
        assert!(err.starts_with("Die Datei wurde nicht gefunden"), "{err}");
    }
}
