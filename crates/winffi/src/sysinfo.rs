//! Systeminfo (Werkzeug 22) – nur lesend: Arbeitsspeicher, Laufzeit seit dem Start, feste
//! Laufwerke mit freiem Platz.

use std::io;
use std::path::PathBuf;

use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
use windows_sys::Win32::System::SystemInformation::{
    GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX,
};

/// `DRIVE_FIXED`.
const DRIVE_FIXED: u32 = 3;

/// Arbeitsspeicher (gesamt, verfügbar) in Byte.
///
/// # Errors
/// Nicht abfragbar.
pub fn memory() -> io::Result<(u64, u64)> {
    let mut status = MEMORYSTATUSEX {
        dwLength: u32::try_from(size_of::<MEMORYSTATUSEX>()).unwrap_or(0),
        ..MEMORYSTATUSEX::default()
    };
    // SAFETY: `status` ist belegt und `dwLength` gesetzt; nur Abfrage.
    // aegis-unsafe: winffi-memory-status
    #[allow(unsafe_code)]
    let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((status.ullTotalPhys, status.ullAvailPhys))
}

/// Sekunden seit dem Start von Windows.
#[must_use]
pub fn uptime_seconds() -> u64 {
    // SAFETY: ohne Argumente; nur Abfrage.
    // aegis-unsafe: winffi-uptime
    #[allow(unsafe_code)]
    let ms = unsafe { GetTickCount64() };
    ms / 1000
}

/// Feste Laufwerke (`C:\` …).
#[must_use]
pub fn fixed_drives() -> Vec<PathBuf> {
    // SAFETY: ohne Argumente; liefert eine Bitmaske.
    // aegis-unsafe: winffi-logical-drives
    #[allow(unsafe_code)]
    let mask = unsafe { GetLogicalDrives() };
    (0u8..26)
        .filter(|i| mask & (1 << i) != 0)
        .map(|i| format!("{}:\\", char::from(b'A' + i)))
        .filter(|root| {
            let name = crate::util::wide(std::path::Path::new(root));
            // SAFETY: `name` nullterminiert; nur Abfrage.
            // aegis-unsafe: winffi-drive-type
            #[allow(unsafe_code)]
            let kind = unsafe { GetDriveTypeW(name.as_ptr()) };
            kind == DRIVE_FIXED
        })
        .map(PathBuf::from)
        .collect()
}
