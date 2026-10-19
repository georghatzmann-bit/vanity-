//! Speicher-Scan (P5): liest – **nur lesend** – die geladenen Module und den ausführbaren,
//! privaten Speicher eines Prozesses (typisch für nachgeladenen oder eingeschleusten Code).
//! Im Identitätswechsel des Nutzers aufrufen: Windows lässt dann nur Prozesse zu, die der
//! Nutzer selbst lesen darf.

use std::ffi::OsString;
use std::io;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::AsRawHandle;
use std::path::PathBuf;

use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, MODULEENTRY32W, Module32FirstW, Module32NextW, TH32CS_SNAPMODULE,
    TH32CS_SNAPMODULE32,
};
use windows_sys::Win32::System::Memory::{
    MEM_COMMIT, MEM_PRIVATE, MEMORY_BASIC_INFORMATION, PAGE_EXECUTE, PAGE_EXECUTE_READ,
    PAGE_EXECUTE_READWRITE, PAGE_EXECUTE_WRITECOPY, PAGE_GUARD, PAGE_NOACCESS, VirtualQueryEx,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
};

use crate::util::own;

/// Gelesener Speicherbereich.
#[derive(Debug, Clone)]
pub struct Region {
    /// Startadresse.
    pub base: u64,
    /// Inhalt (ggf. gekürzt).
    pub data: Vec<u8>,
}

/// Höchstgröße je Bereich.
const MAX_REGION: usize = 4 * 1024 * 1024;

/// Pfade der geladenen Module eines Prozesses (höchstens `max`).
///
/// # Errors
/// Prozess nicht lesbar.
pub fn modules(pid: u32, max: usize) -> io::Result<Vec<PathBuf>> {
    // SAFETY: Schnappschuss der Module; Handle sofort übernommen.
    // aegis-unsafe: winffi-memory-module-snapshot
    #[allow(unsafe_code)]
    let snapshot =
        own(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid) })?;
    let mut entry = MODULEENTRY32W {
        dwSize: u32::try_from(size_of::<MODULEENTRY32W>()).unwrap_or(0),
        ..Default::default()
    };
    let mut out = Vec::new();
    // SAFETY: gültiger Schnappschuss; `entry` mit gesetzter Größe.
    // aegis-unsafe: winffi-memory-module-first
    #[allow(unsafe_code)]
    let mut ok = unsafe { Module32FirstW(snapshot.as_raw_handle(), &mut entry) };
    while ok != 0 && out.len() < max {
        let end = entry
            .szExePath
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(entry.szExePath.len());
        out.push(PathBuf::from(OsString::from_wide(&entry.szExePath[..end])));
        // SAFETY: wie oben.
        // aegis-unsafe: winffi-memory-module-next
        #[allow(unsafe_code)]
        let next = unsafe { Module32NextW(snapshot.as_raw_handle(), &mut entry) };
        ok = next;
    }
    Ok(out)
}

fn executable(protect: u32) -> bool {
    protect & (PAGE_GUARD | PAGE_NOACCESS) == 0
        && protect
            & (PAGE_EXECUTE | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY)
            != 0
}

/// Ausführbare, private Speicherbereiche (nicht aus einer Datei geladen) – höchstens
/// `max_total` Byte insgesamt.
///
/// # Errors
/// Prozess nicht lesbar.
pub fn executable_private_regions(pid: u32, max_total: usize) -> io::Result<Vec<Region>> {
    // SAFETY: OpenProcess nur mit Lese-/Abfragerechten; Handle sofort übernommen.
    // aegis-unsafe: winffi-memory-open-process
    #[allow(unsafe_code)]
    let process = own(unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid) })?;
    let mut regions = Vec::new();
    let mut total = 0usize;
    let mut address: usize = 0;
    for _ in 0..100_000 {
        let mut info = MEMORY_BASIC_INFORMATION::default();
        // SAFETY: gültiges Handle; `info` ist eine passend große Ausgabestruktur.
        // aegis-unsafe: winffi-memory-query
        #[allow(unsafe_code)]
        let got = unsafe {
            VirtualQueryEx(
                process.as_raw_handle(),
                address as *const core::ffi::c_void,
                &mut info,
                size_of::<MEMORY_BASIC_INFORMATION>(),
            )
        };
        if got == 0 || info.RegionSize == 0 {
            break;
        }
        let base = info.BaseAddress as usize;
        if info.State == MEM_COMMIT && info.Type == MEM_PRIVATE && executable(info.Protect) {
            let want = info.RegionSize.min(MAX_REGION).min(max_total - total);
            if want > 0 {
                let mut data = vec![0u8; want];
                let mut read = 0usize;
                // SAFETY: Puffer mit `want` Byte; nur lesen aus dem fremden Prozess.
                // aegis-unsafe: winffi-memory-read
                #[allow(unsafe_code)]
                let ok = unsafe {
                    ReadProcessMemory(
                        process.as_raw_handle(),
                        base as *const core::ffi::c_void,
                        data.as_mut_ptr().cast(),
                        want,
                        &mut read,
                    )
                };
                if ok != 0 && read > 0 {
                    data.truncate(read);
                    total += read;
                    regions.push(Region {
                        base: base as u64,
                        data,
                    });
                }
            }
            if total >= max_total {
                break;
            }
        }
        match base.checked_add(info.RegionSize) {
            Some(next) if next > address => address = next,
            _ => break,
        }
    }
    Ok(regions)
}
