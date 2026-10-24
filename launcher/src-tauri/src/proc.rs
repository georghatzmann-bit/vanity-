//! Prozesse unter Windows starten, anhalten, beenden – und unsere eigene Helfer-DLL
//! in ein von uns gestartetes Fortnite laden (Standardweg `LoadLibraryW` + Remote-Thread,
//! wie beim Reboot Launcher).
//!
//! Alles hier ist Windows-spezifisch. Auf anderen Systemen gibt es nur leere Platzhalter,
//! damit sich der Rest weiter übersetzen lässt.

#![allow(dead_code)]

use std::path::Path;

/// Fehler mit verständlichem deutschem Text für die Oberfläche.
pub type ProcResult<T> = Result<T, String>;

#[cfg(windows)]
mod imp {
    use super::*;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use windows::core::{PCSTR, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HMODULE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};
    use windows::Win32::System::Memory::{
        VirtualAllocEx, MEM_COMMIT, MEM_RESERVE, PAGE_READWRITE,
    };
    use windows::Win32::System::Threading::{
        CreateRemoteThread, OpenProcess, WaitForSingleObject, PROCESS_ALL_ACCESS,
    };

    const CREATE_SUSPENDED: u32 = 0x0000_0004;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    /// Startet eine .exe mit Argumenten. `suspended` = sofort angehalten (für die Hilfs-Prozesse),
    /// `window` = eigenes Fenster sichtbar. Gibt die Prozess-ID zurück.
    pub fn start(
        exe: &Path,
        args: &[String],
        env: &[(String, String)],
        suspended: bool,
        window: bool,
    ) -> ProcResult<u32> {
        if !exe.is_file() {
            return Err(format!("Datei nicht gefunden: {}", exe.display()));
        }
        let mut cmd = Command::new(exe);
        cmd.args(args);
        if let Some(dir) = exe.parent() {
            cmd.current_dir(dir);
        }
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut flags = 0u32;
        if suspended {
            flags |= CREATE_SUSPENDED | DETACHED_PROCESS;
        }
        if !window {
            flags |= CREATE_NO_WINDOW;
        }
        cmd.creation_flags(flags);
        let child = cmd
            .spawn()
            .map_err(|e| format!("{} konnte nicht gestartet werden: {e}", name_of(exe)))?;
        let pid = child.id();
        // Wir verwalten den Prozess über seine PID selbst; das Child-Handle geben wir frei.
        std::mem::forget(child);
        Ok(pid)
    }

    fn name_of(p: &Path) -> String {
        p.file_name().and_then(|n| n.to_str()).unwrap_or("Programm").to_string()
    }

    /// Startet das Spiel und gibt den Prozess zurück, damit der Aufrufer die Ausgabe (Log)
    /// mitlesen kann. `-log` sorgt dafür, dass Fortnite seine Zeilen auch nach stdout schreibt.
    pub fn start_captured(
        exe: &Path,
        args: &[String],
        env: &[(String, String)],
    ) -> ProcResult<std::process::Child> {
        use std::process::Stdio;
        if !exe.is_file() {
            return Err(format!("Datei nicht gefunden: {}", exe.display()));
        }
        let mut cmd = Command::new(exe);
        cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(dir) = exe.parent() {
            cmd.current_dir(dir);
        }
        for (k, v) in env {
            cmd.env(k, v);
        }
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.spawn()
            .map_err(|e| format!("{} konnte nicht gestartet werden: {e}", name_of(exe)))
    }

    /// Beendet einen Prozess anhand seiner PID.
    pub fn kill(pid: u32) -> ProcResult<()> {
        unsafe {
            let handle = OpenProcess(PROCESS_ALL_ACCESS, false, pid)
                .map_err(|e| format!("Prozess {pid} nicht erreichbar: {e}"))?;
            let r = windows::Win32::System::Threading::TerminateProcess(handle, 0);
            let _ = CloseHandle(handle);
            r.map_err(|e| format!("Prozess {pid} ließ sich nicht beenden: {e}"))
        }
    }

    /// Hält einen Prozess an bzw. setzt ihn fort (über ntdll).
    pub fn set_suspended(pid: u32, suspend: bool) -> ProcResult<()> {
        #[link(name = "ntdll")]
        extern "system" {
            fn NtSuspendProcess(handle: isize) -> i32;
            fn NtResumeProcess(handle: isize) -> i32;
        }
        unsafe {
            let handle = OpenProcess(PROCESS_ALL_ACCESS, false, pid)
                .map_err(|e| format!("Prozess {pid} nicht erreichbar: {e}"))?;
            let r = if suspend {
                NtSuspendProcess(handle.0 as isize)
            } else {
                NtResumeProcess(handle.0 as isize)
            };
            let _ = CloseHandle(handle);
            if r == 0 {
                Ok(())
            } else {
                Err(format!("Prozess {pid} ließ sich nicht {}", if suspend { "anhalten" } else { "fortsetzen" }))
            }
        }
    }

    pub fn is_running(pid: u32) -> bool {
        unsafe {
            match OpenProcess(PROCESS_ALL_ACCESS, false, pid) {
                Ok(handle) => {
                    let mut code = 0u32;
                    let ok = windows::Win32::System::Threading::GetExitCodeProcess(handle, &mut code)
                        .is_ok();
                    let _ = CloseHandle(handle);
                    ok && code == 259 // STILL_ACTIVE
                }
                Err(_) => false,
            }
        }
    }

    /// Lädt unsere Helfer-DLL in den angegebenen (von uns gestarteten) Prozess.
    /// Standardweg: der Pfad der DLL wird in den Zielprozess geschrieben, dann ruft ein
    /// Remote-Thread `LoadLibraryW` mit diesem Pfad auf. Genau so macht es auch Reboot.
    pub fn load_helper(pid: u32, dll: &Path) -> ProcResult<()> {
        if !dll.is_file() {
            return Err(format!("DLL nicht gefunden: {}", dll.display()));
        }
        // Zugänglichkeit prüfen (Virenprogramm hat sie vielleicht gesperrt)
        std::fs::read(dll).map_err(|_| {
            format!("{} ist nicht lesbar – vom Virenprogramm blockiert?", name_of(dll))
        })?;

        let path_w = wide(&dll.to_string_lossy());
        let bytes = path_w.len() * 2;

        unsafe {
            let process = OpenProcess(PROCESS_ALL_ACCESS, false, pid)
                .map_err(|e| format!("Spielprozess nicht erreichbar: {e}"))?;

            let result = (|| -> ProcResult<()> {
                let kernel32 = GetModuleHandleA(PCSTR(b"kernel32.dll\0".as_ptr()))
                    .map_err(|e| format!("kernel32 nicht gefunden: {e}"))?;
                let load_library = GetProcAddress(kernel32, PCSTR(b"LoadLibraryW\0".as_ptr()))
                    .ok_or("LoadLibraryW nicht gefunden")?;

                let remote = VirtualAllocEx(process, None, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
                if remote.is_null() {
                    return Err("Speicher im Spielprozess konnte nicht reserviert werden".into());
                }

                let mut written = 0usize;
                windows::Win32::System::Diagnostics::Debug::WriteProcessMemory(
                    process,
                    remote,
                    path_w.as_ptr() as *const _,
                    bytes,
                    Some(&mut written),
                )
                .map_err(|e| format!("Pfad konnte nicht übergeben werden: {e}"))?;

                let start: unsafe extern "system" fn(*mut std::ffi::c_void) -> u32 =
                    std::mem::transmute(load_library);
                let thread = CreateRemoteThread(
                    process,
                    None,
                    0,
                    Some(start),
                    Some(remote),
                    0,
                    None,
                )
                .map_err(|e| format!("DLL konnte nicht geladen werden: {e}"))?;

                // Kurz warten, bis LoadLibrary fertig ist
                WaitForSingleObject(thread, 10_000);
                let _ = CloseHandle(thread);
                Ok(())
            })();

            let _ = CloseHandle(process);
            result
        }
    }

    /// Sucht eine laufende Prozess-ID anhand des exe-Namens (z. B. „FortniteLauncher.exe“).
    pub fn find_pid_by_name(name: &str) -> Option<u32> {
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
            let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut found = None;
            if Process32FirstW(snap, &mut entry).is_ok() {
                loop {
                    let exe = String::from_utf16_lossy(
                        &entry.szExeFile[..entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(0)],
                    );
                    if exe.eq_ignore_ascii_case(name) {
                        found = Some(entry.th32ProcessID);
                        break;
                    }
                    if Process32NextW(snap, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
            found
        }
    }

    // Verhindert „ungenutzt“-Warnungen für HANDLE/HMODULE/PCWSTR in manchen Builds
    const _: () = {
        let _ = std::mem::size_of::<HANDLE>();
        let _ = std::mem::size_of::<HMODULE>();
        let _: Option<PCWSTR> = None;
    };
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn start(_: &Path, _: &[String], _: &[(String, String)], _: bool, _: bool) -> ProcResult<u32> {
        Err("Nur unter Windows verfügbar".into())
    }
    pub fn start_captured(_: &Path, _: &[String], _: &[(String, String)]) -> ProcResult<std::process::Child> {
        Err("Nur unter Windows verfügbar".into())
    }
    pub fn kill(_: u32) -> ProcResult<()> {
        Err("Nur unter Windows verfügbar".into())
    }
    pub fn set_suspended(_: u32, _: bool) -> ProcResult<()> {
        Err("Nur unter Windows verfügbar".into())
    }
    pub fn is_running(_: u32) -> bool {
        false
    }
    pub fn load_helper(_: u32, _: &Path) -> ProcResult<()> {
        Err("Nur unter Windows verfügbar".into())
    }
    pub fn find_pid_by_name(_: &str) -> Option<u32> {
        None
    }
}

pub use imp::*;
