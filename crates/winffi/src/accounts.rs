//! Lokale Konten und Prozess-Grundlagen für die Härtung (nur lesend bzw. einmalig beim Start):
//! Gastkonto ohne WMI, restriktive COM-Sicherheit des Dienstes, Systemordner.

use std::ffi::OsString;
use std::io;
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;
use std::ptr;

use windows_sys::Win32::NetworkManagement::NetManagement::{
    FILTER_NORMAL_ACCOUNT, MAX_PREFERRED_LENGTH, NetApiBufferFree, NetUserEnum, UF_ACCOUNTDISABLE,
    USER_INFO_23,
};
use windows_sys::Win32::Security::{
    ACL, MakeAbsoluteSD, PSECURITY_DESCRIPTOR, PSID, SECURITY_DESCRIPTOR,
};
use windows_sys::Win32::System::Com::{
    CO_MTA_USAGE_COOKIE, CoIncrementMTAUsage, CoInitializeSecurity, RPC_C_AUTHN_LEVEL_PKT_PRIVACY,
    RPC_C_IMP_LEVEL_IMPERSONATE,
};
use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;

use crate::util::SecurityDescriptor;

/// `ERROR_MORE_DATA`.
const MORE_DATA: u32 = 234;

fn wide_text(p: *const u16) -> String {
    if p.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    // SAFETY: `p` ist ein nullterminierter Text aus dem Puffer von NetUserEnum; gelesen wird
    // bis zur Null, höchstens 512 Zeichen.
    // aegis-unsafe: winffi-accounts-text
    #[allow(unsafe_code)]
    let units = unsafe {
        while len < 512 && *p.add(len) != 0 {
            len += 1;
        }
        std::slice::from_raw_parts(p, len).to_vec()
    };
    String::from_utf16_lossy(&units)
}

/// Das eingebaute Gastkonto (RID 501): `(Name, aktiviert?)`. Nur lesend, ohne WMI.
///
/// # Errors
/// Konten nicht lesbar.
pub fn guest_account() -> io::Result<Option<(String, bool)>> {
    let mut resume = 0u32;
    for _ in 0..64 {
        let mut buffer: *mut u8 = ptr::null_mut();
        let mut read = 0u32;
        let mut total = 0u32;
        // SAFETY: lokaler Rechner (null); Stufe 23; Ausgabezeiger gültig; der Puffer wird
        // unten mit NetApiBufferFree genau einmal freigegeben.
        // aegis-unsafe: winffi-accounts-enum
        #[allow(unsafe_code)]
        let status = unsafe {
            NetUserEnum(
                ptr::null(),
                23,
                FILTER_NORMAL_ACCOUNT,
                &mut buffer,
                MAX_PREFERRED_LENGTH,
                &mut read,
                &mut total,
                &mut resume,
            )
        };
        if status != 0 && status != MORE_DATA {
            return Err(io::Error::from_raw_os_error(
                i32::try_from(status).unwrap_or(i32::MAX),
            ));
        }
        let mut found = None;
        if !buffer.is_null() {
            // SAFETY: NetUserEnum liefert `read` zusammenhängende USER_INFO_23-Einträge.
            // aegis-unsafe: winffi-accounts-slice
            #[allow(unsafe_code)]
            let entries = unsafe {
                std::slice::from_raw_parts(
                    buffer.cast::<USER_INFO_23>(),
                    usize::try_from(read).unwrap_or(0),
                )
            };
            for e in entries {
                let sid: PSID = e.usri23_user_sid;
                let is_guest = !sid.is_null()
                    && crate::pipe::sid_to_string(sid).is_ok_and(|s| s.ends_with("-501"));
                if is_guest {
                    found = Some((
                        wide_text(e.usri23_name),
                        e.usri23_flags & UF_ACCOUNTDISABLE == 0,
                    ));
                    break;
                }
            }
            // SAFETY: Puffer stammt von NetUserEnum; genau einmal freigeben.
            // aegis-unsafe: winffi-accounts-free
            #[allow(unsafe_code)]
            let _ = unsafe { NetApiBufferFree(buffer.cast()) };
        }
        if found.is_some() || status != MORE_DATA {
            return Ok(found);
        }
    }
    Ok(None)
}

/// Systemordner (`C:\Windows\System32`) – unabhängig von Umgebungsvariablen.
///
/// # Errors
/// Nicht lesbar.
pub fn system_dir() -> io::Result<PathBuf> {
    let mut buffer = vec![0u16; 520];
    // SAFETY: Puffer der angegebenen Länge.
    // aegis-unsafe: winffi-system-dir
    #[allow(unsafe_code)]
    let len = unsafe {
        GetSystemDirectoryW(
            buffer.as_mut_ptr(),
            u32::try_from(buffer.len()).unwrap_or(0),
        )
    };
    let len = usize::try_from(len).unwrap_or(0);
    if len == 0 || len >= buffer.len() {
        return Err(io::Error::last_os_error());
    }
    buffer.truncate(len);
    Ok(PathBuf::from(OsString::from_wide(&buffer)))
}

/// Legt die COM-Sicherheit des Dienstprozesses einmalig und restriktiv fest, bevor eine
/// Bibliothek (WMI) es mit offenen Standardwerten tut: Zugriff auf eigene COM-Objekte nur für
/// SYSTEM und Administratoren, verschlüsselte Aufrufe (`PKT_PRIVACY`), Identitätswechsel-Stufe
/// „Impersonate“ (für WMI nötig). Hält das MTA dauerhaft offen.
///
/// # Errors
/// COM nicht einrichtbar (z. B. schon von anderer Stelle festgelegt).
pub fn init_com_security() -> io::Result<()> {
    let mut cookie: CO_MTA_USAGE_COOKIE = ptr::null_mut();
    // SAFETY: Ausgabezeiger gültig; das Cookie wird bewusst nie freigegeben (MTA bleibt offen).
    // aegis-unsafe: winffi-com-mta
    #[allow(unsafe_code)]
    let hr = unsafe { CoIncrementMTAUsage(&mut cookie) };
    if hr < 0 {
        return Err(io::Error::other(format!("COM: 0x{hr:08x}")));
    }
    let relative = SecurityDescriptor::from_sddl("O:SYG:SYD:(A;;0x7;;;SY)(A;;0x7;;;BA)")?;
    // Absolute Form (verlangt CoInitializeSecurity): Puffergrößen abfragen, dann umwandeln.
    let (mut sd_len, mut dacl_len, mut sacl_len, mut owner_len, mut group_len) =
        (0u32, 0u32, 0u32, 0u32, 0u32);
    // SAFETY: Größenabfrage mit null-Puffern.
    // aegis-unsafe: winffi-com-sd-size
    #[allow(unsafe_code)]
    let _ = unsafe {
        MakeAbsoluteSD(
            relative.0,
            ptr::null_mut(),
            &mut sd_len,
            ptr::null_mut(),
            &mut dacl_len,
            ptr::null_mut(),
            &mut sacl_len,
            ptr::null_mut(),
            &mut owner_len,
            ptr::null_mut(),
            &mut group_len,
        )
    };
    // Die Puffer leben bis zum Prozessende (COM verweist ggf. darauf).
    let leak = |len: u32| -> *mut u8 {
        Box::leak(vec![0u64; usize::try_from(len).unwrap_or(0) / 8 + 1].into_boxed_slice())
            .as_mut_ptr()
            .cast()
    };
    let (sd, dacl, sacl, owner, group) = (
        leak(sd_len.max(u32::try_from(size_of::<SECURITY_DESCRIPTOR>()).unwrap_or(64))),
        leak(dacl_len),
        leak(sacl_len),
        leak(owner_len),
        leak(group_len),
    );
    // SAFETY: Puffer mindestens der abgefragten Größe, 8-Byte-ausgerichtet.
    // aegis-unsafe: winffi-com-sd-absolute
    #[allow(unsafe_code)]
    let ok = unsafe {
        MakeAbsoluteSD(
            relative.0,
            sd.cast(),
            &mut sd_len,
            dacl.cast::<ACL>(),
            &mut dacl_len,
            sacl.cast::<ACL>(),
            &mut sacl_len,
            owner.cast(),
            &mut owner_len,
            group.cast(),
            &mut group_len,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let absolute: PSECURITY_DESCRIPTOR = sd.cast();
    // SAFETY: absolute Sicherheitsbeschreibung (lebt bis Prozessende); keine eigenen
    // Authentifizierungsdienste (-1 = COM wählt); alle übrigen Zeiger null.
    // aegis-unsafe: winffi-com-security
    #[allow(unsafe_code)]
    let hr = unsafe {
        CoInitializeSecurity(
            absolute,
            -1,
            ptr::null(),
            ptr::null(),
            RPC_C_AUTHN_LEVEL_PKT_PRIVACY,
            RPC_C_IMP_LEVEL_IMPERSONATE,
            ptr::null(),
            0, // EOAC_NONE
            ptr::null(),
        )
    };
    if hr < 0 {
        return Err(io::Error::other(format!("COM-Sicherheit: 0x{hr:08x}")));
    }
    Ok(())
}
