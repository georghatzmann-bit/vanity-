//! Lesende Systemabfragen für den Echtzeit-Wächter: Programmpfad eines Prozesses,
//! Wechseldatenträger.

use std::ffi::OsString;
use std::io;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::AsRawHandle;
use std::path::PathBuf;

use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};

use crate::util::{own, wide};

/// `DRIVE_REMOVABLE` (USB-Sticks, Speicherkarten).
const DRIVE_REMOVABLE: u32 = 2;

/// Vollständiger Programmpfad eines laufenden Prozesses (nur Abfrage-Recht).
///
/// # Errors
/// Prozess beendet oder nicht abfragbar.
pub fn process_image_path(pid: u32) -> io::Result<PathBuf> {
    // SAFETY: Nur Abfrage-Recht; das Handle wird sofort übernommen.
    // aegis-unsafe: winffi-open-process-query
    #[allow(unsafe_code)]
    let process = own(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })?;
    let mut buffer = vec![0u16; 32 * 1024];
    let mut len = u32::try_from(buffer.len()).unwrap_or(u32::MAX);
    // SAFETY: `process` ist gültig; `buffer`/`len` beschreiben einen gültigen Puffer.
    // aegis-unsafe: winffi-process-image-name
    #[allow(unsafe_code)]
    let ok = unsafe {
        QueryFullProcessImageNameW(process.as_raw_handle(), 0, buffer.as_mut_ptr(), &mut len)
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    buffer.truncate(usize::try_from(len).unwrap_or(0));
    Ok(PathBuf::from(OsString::from_wide(&buffer)))
}

/// SID des Kontos, unter dem ein Prozess läuft (nur Abfrage).
///
/// # Errors
/// Prozess beendet oder Token nicht lesbar.
pub fn process_user_sid(pid: u32) -> io::Result<String> {
    use windows_sys::Win32::Security::TOKEN_QUERY;
    use windows_sys::Win32::System::Threading::OpenProcessToken;
    // SAFETY: Nur Abfrage-Recht; das Handle wird sofort übernommen.
    // aegis-unsafe: winffi-open-process-sid
    #[allow(unsafe_code)]
    let process = own(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })?;
    let mut token = std::ptr::null_mut();
    // SAFETY: gültiges Prozess-Handle; nur TOKEN_QUERY; Ausgabezeiger gültig.
    // aegis-unsafe: winffi-process-token-query
    #[allow(unsafe_code)]
    let ok = unsafe { OpenProcessToken(process.as_raw_handle(), TOKEN_QUERY, &mut token) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = own(token)?;
    crate::util::token_user(token.as_raw_handle(), crate::pipe::sid_to_string)?
}

/// Wurzeln aller Wechseldatenträger (`E:\` …).
#[must_use]
pub fn removable_drives() -> Vec<PathBuf> {
    // SAFETY: Keine Argumente; liefert eine Bitmaske der Laufwerke.
    // aegis-unsafe: winffi-logical-drives
    #[allow(unsafe_code)]
    let mask = unsafe { GetLogicalDrives() };
    (0u8..26)
        .filter(|i| mask & (1 << i) != 0)
        .map(|i| format!("{}:\\", char::from(b'A' + i)))
        .filter(|root| {
            let name = wide(root);
            // SAFETY: `name` ist nullterminiert.
            // aegis-unsafe: winffi-drive-type
            #[allow(unsafe_code)]
            let kind = unsafe { GetDriveTypeW(name.as_ptr()) };
            kind == DRIVE_REMOVABLE
        })
        .map(PathBuf::from)
        .collect()
}

/// Name (ohne Domäne) des Kontos, unter dem der eigene Prozess läuft – aus dem Token, nicht aus
/// Umgebungsvariablen.
///
/// # Errors
/// Token oder Konto nicht lesbar.
pub fn current_account_name() -> io::Result<String> {
    use windows_sys::Win32::Security::{LookupAccountSidW, SID_NAME_USE, TOKEN_QUERY};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    let mut token = std::ptr::null_mut();
    // SAFETY: Pseudo-Handle des eigenen Prozesses; nur TOKEN_QUERY; Ausgabezeiger gültig.
    // aegis-unsafe: winffi-own-token-account
    #[allow(unsafe_code)]
    let ok = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = own(token)?;
    crate::util::token_user(token.as_raw_handle(), |sid| {
        let mut name = vec![0u16; 256];
        let mut domain = vec![0u16; 256];
        let mut name_len = 256u32;
        let mut domain_len = 256u32;
        let mut kind: SID_NAME_USE = 0;
        // SAFETY: `sid` lebt während des Rückrufs; Puffer und Längen gültig.
        // aegis-unsafe: winffi-lookup-account
        #[allow(unsafe_code)]
        let ok = unsafe {
            LookupAccountSidW(
                std::ptr::null(),
                sid,
                name.as_mut_ptr(),
                &mut name_len,
                domain.as_mut_ptr(),
                &mut domain_len,
                &mut kind,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        name.truncate(usize::try_from(name_len).unwrap_or(0));
        Ok(String::from_utf16_lossy(&name))
    })?
}
