//! Identitäten für Prüfungen **ohne** anfragenden Pipe-Client (Echtzeit-Wächter, geplante
//! Scans): Der Dienst liest fremde Dateien nie mit seinen eigenen (SYSTEM-)Rechten.
//!
//! - Datei in einem Nutzerprofil → Rechte dieses Nutzers (Token seiner angemeldeten Sitzung).
//! - Gemeinsame Orte (USB, Programme) oder Nutzer nicht angemeldet → „nur Nutzer“-Token:
//!   SYSTEM und Administratoren nur noch „deny“, zusätzlich eingeschränkt auf Everyone,
//!   Authentifizierte Benutzer, Benutzer und RESTRICTED. Damit ist nur lesbar, was jeder
//!   angemeldete Nutzer lesen darf.

use std::io;
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::ptr;

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Security::{
    CreateRestrictedToken, CreateWellKnownSid, DISABLE_MAX_PRIVILEGE, ImpersonateLoggedOnUser,
    LUA_TOKEN, SECURITY_MAX_SID_SIZE, SID_AND_ATTRIBUTES, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE,
    TOKEN_IMPERSONATE, TOKEN_QUERY, WELL_KNOWN_SID_TYPE, WinAuthenticatedUserSid,
    WinBuiltinAdministratorsSid, WinBuiltinUsersSid, WinLocalSystemSid, WinRestrictedCodeSid,
    WinWorldSid,
};
use windows_sys::Win32::System::RemoteDesktop::{
    WTS_SESSION_INFOW, WTSActive, WTSDisconnected, WTSEnumerateSessionsW, WTSFreeMemory,
    WTSQueryUserToken,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows_sys::Win32::UI::Shell::GetUserProfileDirectoryW;

use crate::pipe::{Impersonation, thread_is_impersonating};
use crate::util::own;

fn impersonate(token: HANDLE) -> io::Result<Impersonation> {
    if thread_is_impersonating()? {
        return Err(io::Error::other(
            "Identitätswechsel ist bereits aktiv – verschachteln nicht erlaubt",
        ));
    }
    // SAFETY: `token` ist ein gültiges Token mit TOKEN_QUERY | TOKEN_DUPLICATE |
    // TOKEN_IMPERSONATE; der Wechsel wird vom Rückgabewert (RevertToSelf) beendet.
    // aegis-unsafe: winffi-impersonate-token
    #[allow(unsafe_code)]
    let ok = unsafe { ImpersonateLoggedOnUser(token) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Impersonation::started())
}

fn profile_dir_of(token: HANDLE) -> Option<Vec<u16>> {
    let mut buffer = vec![0u16; 1024];
    let mut len = u32::try_from(buffer.len()).unwrap_or(1024);
    // SAFETY: `token` hat TOKEN_QUERY; Puffer/Länge gültig.
    // aegis-unsafe: winffi-identity-profile-dir
    #[allow(unsafe_code)]
    let ok = unsafe { GetUserProfileDirectoryW(token, buffer.as_mut_ptr(), &mut len) };
    if ok == 0 {
        return None;
    }
    let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    buffer.truncate(end);
    Some(buffer)
}

fn same_dir(a: &[u16], b: &[u16]) -> bool {
    let fold = |c: &u16| u8::try_from(*c).map_or(*c, |b| u16::from(b.to_ascii_lowercase()));
    let trim = |s: &[u16]| {
        let mut s = s;
        while let [head @ .., last] = s
            && (*last == u16::from(b'\\') || *last == u16::from(b'/'))
        {
            s = head;
        }
        s.to_vec()
    };
    let (a, b) = (trim(a), trim(b));
    a.len() == b.len() && a.iter().map(fold).eq(b.iter().map(fold))
}

/// Wechselt auf den Nutzer, dem der Profilordner `profile` gehört – nur, wenn er angemeldet
/// ist (Token seiner Sitzung). Braucht SYSTEM-Rechte (Dienst).
///
/// # Errors
/// Nutzer nicht angemeldet, keine Berechtigung oder Wechsel nicht möglich.
pub fn impersonate_profile_owner(profile: &Path) -> io::Result<Impersonation> {
    use std::os::windows::ffi::OsStrExt;
    let wanted: Vec<u16> = profile.as_os_str().encode_wide().collect();
    let mut sessions: *mut WTS_SESSION_INFOW = ptr::null_mut();
    let mut count = 0u32;
    // SAFETY: lokaler Server (null), Version 1; Ausgabezeiger gültig; Speicher wird unten mit
    // WTSFreeMemory freigegeben.
    // aegis-unsafe: winffi-wts-sessions
    #[allow(unsafe_code)]
    let ok = unsafe { WTSEnumerateSessionsW(ptr::null_mut(), 0, 1, &mut sessions, &mut count) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: WTSEnumerateSessionsW liefert `count` zusammenhängende Einträge.
    // aegis-unsafe: winffi-wts-sessions-slice
    #[allow(unsafe_code)]
    let list: Vec<(u32, i32)> = unsafe {
        std::slice::from_raw_parts(sessions, usize::try_from(count).unwrap_or(0))
            .iter()
            .map(|s| (s.SessionId, s.State))
            .collect()
    };
    // SAFETY: Speicher stammt von WTSEnumerateSessionsW; genau einmal freigeben.
    // aegis-unsafe: winffi-wts-free
    #[allow(unsafe_code)]
    unsafe {
        WTSFreeMemory(sessions.cast());
    }
    for (id, state) in list {
        if state != WTSActive && state != WTSDisconnected {
            continue;
        }
        let mut token: HANDLE = ptr::null_mut();
        // SAFETY: Ausgabezeiger gültig; das Token wird sofort übernommen.
        // aegis-unsafe: winffi-wts-user-token
        #[allow(unsafe_code)]
        let ok = unsafe { WTSQueryUserToken(id, &mut token) };
        if ok == 0 {
            continue;
        }
        let token = own(token)?;
        if profile_dir_of(token.as_raw_handle()).is_some_and(|dir| same_dir(&dir, &wanted)) {
            return impersonate(token.as_raw_handle());
        }
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "Nutzer des Profils ist nicht angemeldet",
    ))
}

fn well_known(kind: WELL_KNOWN_SID_TYPE) -> io::Result<Vec<u8>> {
    let mut sid = vec![0u8; SECURITY_MAX_SID_SIZE as usize];
    let mut size = SECURITY_MAX_SID_SIZE;
    // SAFETY: Puffer der angegebenen Größe; keine Domänen-SID nötig.
    // aegis-unsafe: winffi-well-known-sid
    #[allow(unsafe_code)]
    let ok =
        unsafe { CreateWellKnownSid(kind, ptr::null_mut(), sid.as_mut_ptr().cast(), &mut size) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    sid.truncate(usize::try_from(size).unwrap_or(sid.len()));
    Ok(sid)
}

/// Wechselt auf ein „nur Nutzer“-Token, abgeleitet vom eigenen Prozess (SYSTEM): SYSTEM und
/// Administratoren nur „deny“, keine Privilegien, eingeschränkt auf Everyone,
/// Authentifizierte Benutzer, Benutzer und RESTRICTED.
///
/// # Errors
/// Token nicht ableitbar oder Wechsel nicht möglich.
pub fn impersonate_shared_reader() -> io::Result<Impersonation> {
    let mut process: HANDLE = ptr::null_mut();
    // SAFETY: Pseudo-Handle des eigenen Prozesses; Ausgabezeiger gültig.
    // aegis-unsafe: winffi-shared-reader-process-token
    #[allow(unsafe_code)]
    let ok = unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_IMPERSONATE,
            &mut process,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let process = own(process)?;
    let mut disable = [
        well_known(WinLocalSystemSid)?,
        well_known(WinBuiltinAdministratorsSid)?,
    ];
    let mut restrict = [
        well_known(WinWorldSid)?,
        well_known(WinAuthenticatedUserSid)?,
        well_known(WinBuiltinUsersSid)?,
        well_known(WinRestrictedCodeSid)?,
    ];
    let as_attrs = |sids: &mut [Vec<u8>]| -> Vec<SID_AND_ATTRIBUTES> {
        sids.iter_mut()
            .map(|s| SID_AND_ATTRIBUTES {
                Sid: s.as_mut_ptr().cast(),
                Attributes: 0,
            })
            .collect()
    };
    let disable_attrs = as_attrs(&mut disable);
    let restrict_attrs = as_attrs(&mut restrict);
    let mut restricted: HANDLE = ptr::null_mut();
    // SAFETY: `process` gültig; die SID-Listen zeigen in `disable`/`restrict`, die bis nach
    // dem Aufruf leben; Zähler passen zu den Listen.
    // aegis-unsafe: winffi-shared-reader-token
    #[allow(unsafe_code)]
    let ok = unsafe {
        CreateRestrictedToken(
            process.as_raw_handle(),
            DISABLE_MAX_PRIVILEGE | LUA_TOKEN,
            u32::try_from(disable_attrs.len()).unwrap_or(0),
            disable_attrs.as_ptr(),
            0,
            ptr::null(),
            u32::try_from(restrict_attrs.len()).unwrap_or(0),
            restrict_attrs.as_ptr(),
            &mut restricted,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let restricted = own(restricted)?;
    impersonate(restricted.as_raw_handle())
}

/// Wechselt für eine Hintergrundprüfung: auf den Profil-Besitzer, sonst „nur Nutzer“.
///
/// # Errors
/// Kein Wechsel möglich – dann wird **nicht** geprüft.
pub fn impersonate_for_background(profile: Option<&Path>) -> io::Result<Impersonation> {
    if let Some(profile) = profile
        && let Ok(guard) = impersonate_profile_owner(profile)
    {
        return Ok(guard);
    }
    impersonate_shared_reader()
}

#[cfg(test)]
mod tests {
    use super::same_dir;

    #[test]
    fn profilvergleich() {
        let w = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
        assert!(same_dir(&w(r"C:\Users\Anna"), &w(r"c:\users\anna\")));
        assert!(!same_dir(&w(r"C:\Users\Anna"), &w(r"C:\Users\Annabel")));
    }
}
