//! Gemeinsame Helfer: Zeichenketten, Sicherheitsbeschreibungen, Handles, SIDs.

use std::ffi::OsStr;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use std::ptr;

use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    ACL, GetSecurityDescriptorDacl, GetTokenInformation, IsWellKnownSid, PSECURITY_DESCRIPTOR,
    PSID, SECURITY_ATTRIBUTES, TOKEN_USER, TokenUser, WELL_KNOWN_SID_TYPE,
};

/// Nullterminierte UTF-16-Zeichenkette.
pub fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(std::iter::once(0)).collect()
}

/// Übernimmt ein gerade erhaltenes Handle (ungültig → letzter Fehler).
pub fn own(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle == INVALID_HANDLE_VALUE || handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `handle` ist gültig und gehört allein dem Aufrufer (gerade von einer
    // Win32-Funktion geliefert, die ein neues Handle zurückgibt).
    // aegis-unsafe: winffi-own-handle
    #[allow(unsafe_code)]
    let owned = unsafe { OwnedHandle::from_raw_handle(handle) };
    Ok(owned)
}

/// Sicherheitsbeschreibung aus SDDL; wird beim Verwerfen freigegeben.
pub struct SecurityDescriptor(pub PSECURITY_DESCRIPTOR);

impl SecurityDescriptor {
    /// Wandelt feste SDDL-Texte (Konstanten dieses Crates) um.
    pub fn from_sddl(sddl: &str) -> io::Result<Self> {
        let text = wide(sddl);
        let mut sd: PSECURITY_DESCRIPTOR = ptr::null_mut();
        // SAFETY: `text` ist nullterminiert und lebt bis nach dem Aufruf; `sd` ist ein
        // gültiger Ausgabezeiger; die optionale Längenangabe ist null.
        // aegis-unsafe: service-sddl-parse
        #[allow(unsafe_code)]
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                text.as_ptr(),
                SDDL_REVISION_1,
                &mut sd,
                ptr::null_mut(),
            )
        };
        if ok == 0 || sd.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(sd))
    }

    /// Attribute für `CreateNamedPipeW`/`CreateDirectoryW` (leben so lange wie `self`).
    pub fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>()).unwrap_or(24),
            lpSecurityDescriptor: self.0,
            bInheritHandle: 0,
        }
    }

    /// Die DACL (zeigt in `self`).
    pub fn dacl(&self) -> io::Result<*mut ACL> {
        let mut present = 0;
        let mut defaulted = 0;
        let mut dacl: *mut ACL = ptr::null_mut();
        // SAFETY: `self.0` ist eine gültige Sicherheitsbeschreibung; alle Ausgabezeiger gültig.
        // aegis-unsafe: service-dacl-read
        #[allow(unsafe_code)]
        let ok =
            unsafe { GetSecurityDescriptorDacl(self.0, &mut present, &mut dacl, &mut defaulted) };
        if ok == 0 || present == 0 || dacl.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(dacl)
    }
}

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        // SAFETY: `self.0` wurde mit LocalAlloc angelegt (SDDL-Umwandlung bzw.
        // GetSecurityInfo) und wird genau einmal freigegeben.
        // aegis-unsafe: service-sddl-free
        #[allow(unsafe_code)]
        let _ = unsafe { LocalFree(self.0) };
    }
}

/// Ist die SID eine der angegebenen bekannten SIDs?
pub fn sid_is(sid: PSID, kinds: &[WELL_KNOWN_SID_TYPE]) -> bool {
    kinds.iter().any(|&kind| {
        // SAFETY: `sid` ist eine gültige SID (aus Token bzw. Sicherheitsbeschreibung, die
        // der Aufrufer am Leben hält); IsWellKnownSid liest nur.
        // aegis-unsafe: winffi-sid-compare
        #[allow(unsafe_code)]
        let ok = unsafe { IsWellKnownSid(sid, kind) };
        ok != 0
    })
}

/// Ist der Benutzer des Tokens eine der angegebenen bekannten SIDs?
pub fn token_user_is(token: HANDLE, kinds: &[WELL_KNOWN_SID_TYPE]) -> io::Result<bool> {
    token_user(token, |sid| sid_is(sid, kinds))
}

/// Ruft `f` mit der SID des Token-Benutzers auf (die SID lebt nur während des Aufrufs).
pub fn token_user<T>(token: HANDLE, f: impl FnOnce(PSID) -> T) -> io::Result<T> {
    // TOKEN_USER + SID passen sicher in 256 Byte (SID ≤ 68 Byte); u64-Ausrichtung.
    let mut buffer = [0u64; 32];
    let mut needed = 0u32;
    // SAFETY: `token` ist ein gültiges Token mit TOKEN_QUERY; der Puffer ist 256 Byte groß
    // und ausreichend ausgerichtet; `needed` ist ein gültiger Ausgabezeiger.
    // aegis-unsafe: winffi-token-user
    #[allow(unsafe_code)]
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            u32::try_from(size_of_val(&buffer)).unwrap_or(256),
            &mut needed,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: GetTokenInformation(TokenUser) hat eine TOKEN_USER-Struktur an den Anfang des
    // Puffers geschrieben; die SID liegt im selben Puffer, der bis zum Ende lebt.
    // aegis-unsafe: winffi-token-user-read
    #[allow(unsafe_code)]
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    Ok(f(user.User.Sid))
}
