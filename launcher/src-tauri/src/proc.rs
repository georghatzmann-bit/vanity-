//! Starts, pauses and closes processes on Windows – and loads our own helper DLL into a
//! Fortnite we started ourselves (the standard way `LoadLibraryW` + remote thread, like
//! Reboot Launcher).
//!
//! Everything here is Windows-only. On other systems there are just empty placeholders,
//! so the rest still compiles.

#![allow(dead_code)]

use std::path::Path;

/// Error with a plain English text for the UI.
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

    /// Starts an .exe with arguments. `suspended` = paused right away (for the helper processes),
    /// `window` = own window visible. Returns the process id.
    pub fn start(
        exe: &Path,
        args: &[String],
        env: &[(String, String)],
        suspended: bool,
        window: bool,
    ) -> ProcResult<u32> {
        if !exe.is_file() {
            return Err(format!("File not found: {}", exe.display()));
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
            .map_err(|e| format!("Couldn't start {}: {e}", name_of(exe)))?;
        let pid = child.id();
        // We manage the process by its PID ourselves. The child is leaked on purpose: its process
        // handle stays open while Niobium runs, so Windows can't give this PID to another process
        // even after it exited – a later `kill(pid)` or `is_running(pid)` never hits a stranger.
        std::mem::forget(child);
        Ok(pid)
    }

    fn name_of(p: &Path) -> String {
        p.file_name().and_then(|n| n.to_str()).unwrap_or("program").to_string()
    }

    /// Starts the game and returns the process, so the caller can read its output (log).
    /// `-log` makes Fortnite write its lines to stdout too.
    pub fn start_captured(
        exe: &Path,
        args: &[String],
        env: &[(String, String)],
    ) -> ProcResult<std::process::Child> {
        use std::process::Stdio;
        if !exe.is_file() {
            return Err(format!("File not found: {}", exe.display()));
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
            .map_err(|e| format!("Couldn't start {}: {e}", name_of(exe)))
    }

    /// Closes a process by its PID.
    pub fn kill(pid: u32) -> ProcResult<()> {
        unsafe {
            let handle = OpenProcess(PROCESS_ALL_ACCESS, false, pid)
                .map_err(|e| format!("Can't reach process {pid}: {e}"))?;
            let r = windows::Win32::System::Threading::TerminateProcess(handle, 0);
            let _ = CloseHandle(handle);
            r.map_err(|e| format!("Couldn't close process {pid}: {e}"))
        }
    }

    /// Pauses or resumes a process (via ntdll).
    pub fn set_suspended(pid: u32, suspend: bool) -> ProcResult<()> {
        #[link(name = "ntdll")]
        extern "system" {
            fn NtSuspendProcess(handle: isize) -> i32;
            fn NtResumeProcess(handle: isize) -> i32;
        }
        unsafe {
            let handle = OpenProcess(PROCESS_ALL_ACCESS, false, pid)
                .map_err(|e| format!("Can't reach process {pid}: {e}"))?;
            let r = if suspend {
                NtSuspendProcess(handle.0 as isize)
            } else {
                NtResumeProcess(handle.0 as isize)
            };
            let _ = CloseHandle(handle);
            if r == 0 {
                Ok(())
            } else {
                Err(format!("Couldn't {} process {pid}", if suspend { "pause" } else { "resume" }))
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

    /// Loads our helper DLL into the given process (one we started).
    /// Standard way: the DLL path is written into the target process, then a remote thread
    /// calls `LoadLibraryW` with that path. Reboot does exactly the same.
    pub fn load_helper(pid: u32, dll: &Path) -> ProcResult<()> {
        if !dll.is_file() {
            return Err(format!("DLL not found: {}", dll.display()));
        }
        // Check that it can be read (an antivirus program may have blocked it)
        std::fs::read(dll).map_err(|_| {
            format!("Can't read {} – blocked by an antivirus program?", name_of(dll))
        })?;

        let path_w = wide(&dll.to_string_lossy());
        let bytes = path_w.len() * 2;

        unsafe {
            let process = OpenProcess(PROCESS_ALL_ACCESS, false, pid)
                .map_err(|e| format!("Can't reach the game process: {e}"))?;

            let result = (|| -> ProcResult<()> {
                let kernel32 = GetModuleHandleA(PCSTR(b"kernel32.dll\0".as_ptr()))
                    .map_err(|e| format!("kernel32 not found: {e}"))?;
                let load_library = GetProcAddress(kernel32, PCSTR(b"LoadLibraryW\0".as_ptr()))
                    .ok_or("LoadLibraryW not found")?;

                let remote = VirtualAllocEx(process, None, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
                if remote.is_null() {
                    return Err("Couldn't reserve memory in the game process".into());
                }

                let mut written = 0usize;
                windows::Win32::System::Diagnostics::Debug::WriteProcessMemory(
                    process,
                    remote,
                    path_w.as_ptr() as *const _,
                    bytes,
                    Some(&mut written),
                )
                .map_err(|e| format!("Couldn't pass the path: {e}"))?;

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
                .map_err(|e| format!("Couldn't load the DLL: {e}"))?;

                // Wait a moment until LoadLibrary is done
                WaitForSingleObject(thread, 10_000);
                let _ = CloseHandle(thread);
                Ok(())
            })();

            let _ = CloseHandle(process);
            result
        }
    }

    /// Finds a running process id by exe name (e.g. "FortniteLauncher.exe").
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

    // Avoids "unused" warnings for HANDLE/HMODULE/PCWSTR in some builds
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
        Err("Only available on Windows".into())
    }
    pub fn start_captured(_: &Path, _: &[String], _: &[(String, String)]) -> ProcResult<std::process::Child> {
        Err("Only available on Windows".into())
    }
    pub fn kill(_: u32) -> ProcResult<()> {
        Err("Only available on Windows".into())
    }
    pub fn set_suspended(_: u32, _: bool) -> ProcResult<()> {
        Err("Only available on Windows".into())
    }
    pub fn is_running(_: u32) -> bool {
        false
    }
    pub fn load_helper(_: u32, _: &Path) -> ProcResult<()> {
        Err("Only available on Windows".into())
    }
    pub fn find_pid_by_name(_: &str) -> Option<u32> {
        None
    }
}

pub use imp::*;
