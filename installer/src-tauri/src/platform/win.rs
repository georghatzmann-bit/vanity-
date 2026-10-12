//! Windows-Implementierung.

use super::{ElevateError, UninstallEntry};
use crate::config::{RUN_VALUE_NAME, STATE_KEY, STATE_PARENT_KEY, UNINSTALL_KEY_NAME};
use crate::util::{log, tr};
use std::ffi::{c_void, OsStr, OsString};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use windows::core::{Interface, GUID, HRESULT, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, ERROR_CANCELLED, HANDLE};
use windows::Win32::Globalization::GetUserDefaultUILanguage;
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};
use windows::Win32::UI::Shell::{
    IShellLinkW, SHGetKnownFolderPath, ShellExecuteExW, ShellExecuteW, ShellLink, FOLDERID_Desktop, FOLDERID_Programs, KF_FLAG_DEFAULT,
    SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, IDYES, MB_ICONERROR, MB_ICONQUESTION, MB_OK, MB_SETFOREGROUND, MB_TOPMOST, MB_YESNO, SW_SHOWNORMAL,
};
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
use winreg::RegKey;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const WEBVIEW2_GUID: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
const WEBVIEW2_BOOTSTRAPPER: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
const WEBVIEW2_INFO_URL: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";

fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(std::iter::once(0)).collect()
}

fn uninstall_key_path() -> String {
    format!(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{UNINSTALL_KEY_NAME}")
}

/// COM für die Dauer eines Aufrufs initialisieren (empfohlen für ShellExecute*).
struct ComGuard(bool);

impl ComGuard {
    fn new() -> Self {
        ComGuard(unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok())
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

fn is_not_found(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::NotFound
}

// ---------------------------------------------------------------- Sprache / Rechte / Laufwerke

pub fn system_lang_is_german() -> bool {
    // LANG_GERMAN = 0x07 (primäre Sprache = untere 10 Bit)
    (unsafe { GetUserDefaultUILanguage() } & 0x3ff) == 0x07
}

pub fn is_elevated() -> bool {
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut TOKEN_ELEVATION as *mut c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok && elevation.TokenIsElevated != 0
    }
}

pub fn program_files_dirs() -> Vec<PathBuf> {
    ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
        .iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .collect()
}

pub fn disk_free_total(path: &Path) -> Option<(u64, u64)> {
    // UNC-Pfade brauchen einen abschließenden Backslash; bei Ordnern schadet er nicht.
    let mut s = path.as_os_str().to_os_string();
    if !s.to_string_lossy().ends_with('\\') {
        s.push("\\");
    }
    let w = wide(&s);
    let mut free = 0u64;
    let mut total = 0u64;
    unsafe { GetDiskFreeSpaceExW(PCWSTR(w.as_ptr()), Some(&mut free), Some(&mut total), None) }.ok()?;
    Some((free, total))
}

pub fn attach_parent_console() {
    unsafe {
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

pub fn integration_supported() -> bool {
    true
}

// ---------------------------------------------------------------- Prozesse

pub fn running_process_ids(exe_name: &str) -> Vec<u32> {
    let mut out = Vec::new();
    let me = std::process::id();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return out;
        };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                if name.eq_ignore_ascii_case(exe_name) && entry.th32ProcessID != me {
                    out.push(entry.th32ProcessID);
                }
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    out
}

pub fn is_process_running(exe_name: &str) -> bool {
    !running_process_ids(exe_name).is_empty()
}

/// Beendet alle Prozesse mit diesem Namen und wartet, bis sie weg sind.
pub fn kill_processes(exe_name: &str) -> Result<usize, String> {
    let mut killed = 0usize;
    let mut failed = false;
    for pid in running_process_ids(exe_name) {
        unsafe {
            match OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, false, pid) {
                Ok(h) => {
                    if TerminateProcess(h, 1).is_ok() {
                        let _ = WaitForSingleObject(h, 5000);
                        killed += 1;
                    } else {
                        failed = true;
                    }
                    let _ = CloseHandle(h);
                }
                Err(_) => failed = true,
            }
        }
    }
    if failed {
        let _ = Command::new("taskkill").args(["/F", "/IM", exe_name]).creation_flags(CREATE_NO_WINDOW).status();
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    if is_process_running(exe_name) {
        return Err(tr(
            "Nova Launcher läuft noch und konnte nicht beendet werden. Bitte die App schließen.",
            "Nova Launcher is still running and could not be closed. Please close the app.",
        ));
    }
    Ok(killed)
}

// ---------------------------------------------------------------- Verknüpfungen

fn known_folder(id: &GUID) -> Option<PathBuf> {
    unsafe {
        let p = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
        let path = PathBuf::from(OsString::from_wide(p.as_wide()));
        CoTaskMemFree(Some(p.0 as *const c_void));
        Some(path).filter(|p| !p.as_os_str().is_empty())
    }
}

pub fn start_menu_dir() -> Option<PathBuf> {
    known_folder(&FOLDERID_Programs)
        .or_else(|| dirs::config_dir().map(|d| d.join(r"Microsoft\Windows\Start Menu\Programs")))
}

pub fn desktop_dir() -> Option<PathBuf> {
    known_folder(&FOLDERID_Desktop).or_else(dirs::desktop_dir)
}

/// Legt eine `.lnk`-Datei über `IShellLinkW` + `IPersistFile` an (eigener STA-Thread).
pub fn create_shortcut(lnk: &Path, target: &Path, workdir: &Path, description: &str) -> Result<(), String> {
    if let Some(parent) = lnk.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let (lnk, target, workdir, description) = (wide(lnk), wide(target), wide(workdir), wide(description));
    let worker = std::thread::spawn(move || unsafe {
        let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let result = (|| -> windows::core::Result<()> {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.SetPath(PCWSTR(target.as_ptr()))?;
            link.SetWorkingDirectory(PCWSTR(workdir.as_ptr()))?;
            link.SetIconLocation(PCWSTR(target.as_ptr()), 0)?;
            link.SetDescription(PCWSTR(description.as_ptr()))?;
            let file: IPersistFile = link.cast()?;
            file.Save(PCWSTR(lnk.as_ptr()), true)?;
            Ok(())
        })();
        if init.is_ok() {
            CoUninitialize();
        }
        result.map_err(|e| e.message())
    });
    worker.join().unwrap_or_else(|_| Err("shortcut thread failed".into()))
}

// ---------------------------------------------------------------- Registry

/// Autostart setzen (`Some(exe)`) oder entfernen (`None`).
pub fn set_autostart(exe: Option<&Path>) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    match exe {
        Some(exe) => {
            let (key, _) = hkcu.create_subkey(RUN_KEY).map_err(|e| e.to_string())?;
            key.set_value(RUN_VALUE_NAME, &format!("\"{}\" --minimized", exe.display())).map_err(|e| e.to_string())
        }
        None => match hkcu.open_subkey_with_flags(RUN_KEY, winreg::enums::KEY_SET_VALUE) {
            Ok(key) => match key.delete_value(RUN_VALUE_NAME) {
                Ok(()) => Ok(()),
                Err(e) if is_not_found(&e) => Ok(()),
                Err(e) => Err(e.to_string()),
            },
            Err(e) if is_not_found(&e) => Ok(()),
            Err(e) => Err(e.to_string()),
        },
    }
}

pub fn autostart_command() -> Option<String> {
    RegKey::predef(HKEY_CURRENT_USER).open_subkey(RUN_KEY).ok()?.get_value::<String, _>(RUN_VALUE_NAME).ok()
}

pub fn register_uninstall(e: &UninstallEntry, machine: bool) -> Result<(), String> {
    let root = RegKey::predef(if machine { HKEY_LOCAL_MACHINE } else { HKEY_CURRENT_USER });
    let (key, _) = root.create_subkey(uninstall_key_path()).map_err(|e| e.to_string())?;
    let strings = [
        ("DisplayName", &e.display_name),
        ("DisplayVersion", &e.display_version),
        ("Publisher", &e.publisher),
        ("DisplayIcon", &e.display_icon),
        ("InstallLocation", &e.install_location),
        ("UninstallString", &e.uninstall_string),
        ("QuietUninstallString", &e.quiet_uninstall_string),
        ("InstallDate", &e.install_date),
        ("URLInfoAbout", &e.url_info_about),
    ];
    for (name, value) in strings {
        if !value.is_empty() {
            key.set_value(name, value).map_err(|err| format!("{name}: {err}"))?;
        }
    }
    key.set_value("EstimatedSize", &e.estimated_size_kb).map_err(|err| err.to_string())?;
    key.set_value("NoModify", &1u32).map_err(|err| err.to_string())?;
    key.set_value("NoRepair", &1u32).map_err(|err| err.to_string())?;
    Ok(())
}

/// (HKCU-Eintrag vorhanden, HKLM-Eintrag vorhanden)
pub fn uninstall_entry_exists() -> (bool, bool) {
    let path = uninstall_key_path();
    (
        RegKey::predef(HKEY_CURRENT_USER).open_subkey(&path).is_ok(),
        RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(&path).is_ok(),
    )
}

/// Entfernt den Eintrag aus HKCU und (falls vorhanden und erlaubt) HKLM. Liefert Fehlermeldungen.
pub fn unregister_uninstall() -> Vec<String> {
    let path = uninstall_key_path();
    let mut errors = Vec::new();
    for (root, name) in [(HKEY_CURRENT_USER, "HKCU"), (HKEY_LOCAL_MACHINE, "HKLM")] {
        let key = RegKey::predef(root);
        if key.open_subkey(&path).is_err() {
            continue;
        }
        if let Err(e) = key.delete_subkey_all(&path) {
            if !is_not_found(&e) {
                errors.push(format!("{name}\\{path}: {e}"));
            }
        }
    }
    errors
}

pub fn write_install_state(dir: &Path, version: &str) -> Result<(), String> {
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(STATE_KEY).map_err(|e| e.to_string())?;
    key.set_value("InstallDir", &dir.to_string_lossy().into_owned()).map_err(|e| e.to_string())?;
    key.set_value("Version", &version.to_string()).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn read_install_state() -> Option<(PathBuf, String)> {
    let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey(STATE_KEY).ok()?;
    let dir: String = key.get_value("InstallDir").ok()?;
    let version: String = key.get_value("Version").unwrap_or_default();
    let dir = dir.trim();
    (!dir.is_empty()).then(|| (PathBuf::from(dir), version))
}

pub fn delete_install_state() -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    match hkcu.delete_subkey_all(STATE_KEY) {
        Ok(()) => {}
        Err(e) if is_not_found(&e) => {}
        Err(e) => return Err(e.to_string()),
    }
    // `Software\Nova` nur löschen, wenn leer.
    let _ = hkcu.delete_subkey(STATE_PARENT_KEY);
    Ok(())
}

// ---------------------------------------------------------------- Starten / Öffnen

/// Startet `exe` über UAC ("runas") neu.
pub fn shell_execute_elevated(exe: &Path, args: &[String]) -> Result<(), ElevateError> {
    let _com = ComGuard::new();
    let verb = wide("runas");
    let file = wide(exe);
    let params = wide(crate::util::join_windows_args(args));
    let dir = exe.parent().map(wide);
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOASYNC,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(params.as_ptr()),
        lpDirectory: dir.as_ref().map(|d| PCWSTR(d.as_ptr())).unwrap_or(PCWSTR::null()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    match unsafe { ShellExecuteExW(&mut info) } {
        Ok(()) => Ok(()),
        Err(e) if e.code() == HRESULT::from_win32(ERROR_CANCELLED.0) => Err(ElevateError::Declined),
        Err(e) => {
            log(format!("ShellExecuteExW(runas) fehlgeschlagen: {e}"));
            Err(ElevateError::Failed(e.message()))
        }
    }
}

/// Startet die App ohne Adminrechte: aus einem erhöhten Prozess über `explorer.exe`.
pub fn launch_unelevated(exe: &Path, workdir: &Path, elevated: bool) -> Result<(), String> {
    let result = if elevated {
        let explorer = std::env::var_os("WINDIR")
            .map(|w| PathBuf::from(w).join("explorer.exe"))
            .unwrap_or_else(|| PathBuf::from("explorer.exe"));
        Command::new(explorer).arg(exe).spawn()
    } else {
        let mut cmd = Command::new(exe);
        cmd.current_dir(workdir).creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
        // WebView2-Einstellungen des Setups nicht an die App vererben.
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().to_ascii_uppercase().starts_with("WEBVIEW2_") {
                cmd.env_remove(key);
            }
        }
        cmd.spawn()
    };
    result.map(|_| ()).map_err(|e| format!("{}: {e}", tr("Nova Launcher konnte nicht gestartet werden", "Could not start Nova Launcher")))
}

/// Startet ein Programm losgelöst (ohne Konsole).
pub fn spawn_detached(exe: &Path, args: &[String]) -> Result<(), String> {
    Command::new(exe)
        .args(args)
        .current_dir(std::env::temp_dir())
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn open_url(url: &str) -> Result<(), String> {
    let _com = ComGuard::new();
    let verb = wide("open");
    let target = wide(url);
    let h = unsafe { ShellExecuteW(None, PCWSTR(verb.as_ptr()), PCWSTR(target.as_ptr()), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
    if (h.0 as isize) > 32 {
        Ok(())
    } else {
        Err(tr("Der Link konnte nicht geöffnet werden.", "Could not open the link."))
    }
}

/// Löscht die laufende Exe (und den leeren Ordner) kurz nach dem Beenden über `cmd`.
/// `purge` = Ordner, die komplett entfernt werden (nur eigene Datenordner).
pub fn schedule_self_delete(exe: &Path, dir: Option<&Path>, purge: &[PathBuf]) -> Result<(), String> {
    let mut script = format!("/d /c ping 127.0.0.1 -n 4 >nul & del /f /q \"{}\"", exe.display());
    if let Some(d) = dir {
        script.push_str(&format!(" & rmdir \"{}\"", d.display()));
    }
    for p in purge {
        script.push_str(&format!(" & rmdir /s /q \"{}\"", p.display()));
    }
    let cmd = std::env::var_os("ComSpec").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("cmd.exe"));
    Command::new(cmd)
        .raw_arg(script)
        .current_dir(std::env::temp_dir())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- Meldungen / WebView2

fn message_box(text: &str, caption: &str, style: windows::Win32::UI::WindowsAndMessaging::MESSAGEBOX_STYLE) -> i32 {
    let t = wide(text);
    let c = wide(caption);
    unsafe { MessageBoxW(None, PCWSTR(t.as_ptr()), PCWSTR(c.as_ptr()), style | MB_SETFOREGROUND | MB_TOPMOST).0 }
}

pub fn show_error_box(caption: &str, text: &str) {
    message_box(text, caption, MB_OK | MB_ICONERROR);
}

fn webview2_installed() -> bool {
    let candidates = [
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients"),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\EdgeUpdate\Clients"),
        (HKEY_CURRENT_USER, r"Software\Microsoft\EdgeUpdate\Clients"),
    ];
    candidates.iter().any(|(root, path)| {
        RegKey::predef(*root)
            .open_subkey(format!(r"{path}\{WEBVIEW2_GUID}"))
            .and_then(|k| k.get_value::<String, _>("pv"))
            .map(|pv| {
                let pv = pv.trim();
                !pv.is_empty() && pv != "0.0.0.0"
            })
            .unwrap_or(false)
    })
}

fn download_webview2_bootstrapper() -> Result<PathBuf, String> {
    let target = std::env::temp_dir().join(format!("MicrosoftEdgeWebview2Setup-{}.exe", crate::util::random_suffix()));
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
    rt.block_on(async {
        let client = crate::manifest::build_client()?;
        let resp = client.get(WEBVIEW2_BOOTSTRAPPER).send().await.map_err(|e| crate::manifest::describe_network_error(&e))?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status().as_u16()));
        }
        let bytes = resp.bytes().await.map_err(|e| crate::manifest::describe_network_error(&e))?;
        std::fs::write(&target, &bytes).map_err(|e| e.to_string())?;
        Ok(target)
    })
}

fn run_and_wait(exe: &Path, params: &str) -> Result<(), String> {
    let _com = ComGuard::new();
    let file = wide(exe);
    let p = wide(params);
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(p.as_ptr()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    unsafe {
        ShellExecuteExW(&mut info).map_err(|e| e.message())?;
        if !info.hProcess.is_invalid() {
            let _ = WaitForSingleObject(info.hProcess, 15 * 60 * 1000);
            let _ = CloseHandle(info.hProcess);
        }
    }
    Ok(())
}

/// Prüft die WebView2-Runtime und bietet bei Bedarf die Installation an.
/// `false` = Setup kann nicht laufen (Benutzer hat abgelehnt oder Installation fehlgeschlagen).
pub fn ensure_webview2() -> bool {
    if webview2_installed() {
        return true;
    }
    log("WebView2-Runtime fehlt");
    let caption = "Nova Setup";
    let question = tr(
        "Für Nova Setup wird die Microsoft Edge WebView2 Runtime benötigt. Sie ist auf diesem PC nicht installiert.\n\nJetzt von Microsoft herunterladen und installieren?",
        "Nova Setup requires the Microsoft Edge WebView2 Runtime, which is not installed on this PC.\n\nDownload and install it from Microsoft now?",
    );
    if message_box(&question, caption, MB_YESNO | MB_ICONQUESTION) != IDYES.0 {
        return false;
    }
    let outcome = download_webview2_bootstrapper().and_then(|path| {
        let r = run_and_wait(&path, "/silent /install");
        let _ = std::fs::remove_file(&path);
        r
    });
    if let Err(e) = &outcome {
        log(format!("WebView2-Installation fehlgeschlagen: {e}"));
    }
    if webview2_installed() {
        return true;
    }
    let text = format!(
        "{}\n\n{WEBVIEW2_INFO_URL}",
        tr(
            "Die WebView2 Runtime konnte nicht installiert werden. Bitte installiere sie manuell von der folgenden Seite und starte das Setup danach erneut:",
            "The WebView2 Runtime could not be installed. Please install it manually from the following page and then start the setup again:",
        )
    );
    show_error_box(caption, &text);
    false
}
