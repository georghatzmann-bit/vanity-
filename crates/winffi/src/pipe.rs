//! Named Pipe des Dienstes: Zugriffsliste, Identitätswechsel auf den Client (Dateizugriffe
//! mit dessen Rechten), Prüfung der Server-Identität durch den Client.

use std::fs::File;
use std::io;
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::ptr;

use windows_sys::Win32::Foundation::{ERROR_NO_TOKEN, ERROR_PIPE_CONNECTED, HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, GetSecurityInfo, SE_KERNEL_OBJECT,
};
use windows_sys::Win32::Security::{
    OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, RevertToSelf, TOKEN_QUERY,
    WinLocalSystemSid,
};
use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
    GetNamedPipeServerProcessId, GetNamedPipeServerSessionId, ImpersonateNamedPipeClient,
    PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES,
    PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentThread, OpenProcessToken, OpenThreadToken,
};

use crate::util::{SecurityDescriptor, own, sid_is, token_user, token_user_is, wide};

/// Name der Pipe des Dienstes.
pub const PIPE_NAME: &str = r"\\.\pipe\aegis-service";

/// Pipe: geschützt (keine geerbten Rechte); SYSTEM und Administratoren voll; interaktiv
/// angemeldete Nutzer nur lesen/schreiben **ohne** `FILE_CREATE_PIPE_INSTANCE` (0x4):
/// `0x12019b` = `FILE_GENERIC_READ | FILE_GENERIC_WRITE` ohne `FILE_APPEND_DATA`. Sonst
/// könnten Nutzer eigene Server-Instanzen anlegen und Verbindungen abfangen.
/// Netzwerk-Clients lehnt die Pipe zusätzlich ab.
pub const PIPE_SDDL: &str = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x12019b;;;IU)";

/// Legt eine Pipe-Instanz an. `first = true` für die erste Instanz: Dann schlägt das
/// Anlegen fehl, wenn ein anderes Programm den Namen schon belegt (Schutz vor Übernahme).
///
/// # Errors
/// Name belegt, Zugriffsliste ungültig.
pub fn create_instance(name: &str, first: bool) -> io::Result<OwnedHandle> {
    // Läuft der Dienst als SYSTEM, gehört die Pipe ausdrücklich SYSTEM – daran erkennt die App
    // den echten Dienst (ein normales Programm kann SYSTEM nicht als Besitzer eintragen).
    let sddl = if current_process_is_system()? {
        format!("O:SY{PIPE_SDDL}")
    } else {
        PIPE_SDDL.to_owned()
    };
    let sd = SecurityDescriptor::from_sddl(&sddl)?;
    let attributes = sd.attributes();
    let name = wide(name);
    let open_mode = PIPE_ACCESS_DUPLEX
        | if first {
            FILE_FLAG_FIRST_PIPE_INSTANCE
        } else {
            0
        };
    // SAFETY: `name` ist nullterminiert, `attributes` verweist auf eine gültige
    // Sicherheitsbeschreibung, die bis nach dem Aufruf lebt (`sd`).
    // aegis-unsafe: service-pipe-create
    #[allow(unsafe_code)]
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            open_mode,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            64 * 1024,
            64 * 1024,
            0,
            &attributes,
        )
    };
    own(handle)
}

/// Wartet (blockierend), bis sich ein Client verbindet, und liefert die Verbindung.
///
/// # Errors
/// Verbindungsfehler dieses einen Clients (z. B. sofort wieder getrennt) – der Aufrufer
/// legt dann einfach die nächste Instanz an.
pub fn accept(instance: OwnedHandle) -> io::Result<File> {
    // SAFETY: Das Handle ist eine gültige Pipe-Instanz; synchroner Aufruf ohne OVERLAPPED.
    // aegis-unsafe: service-pipe-connect
    #[allow(unsafe_code)]
    let ok = unsafe { ConnectNamedPipe(instance.as_raw_handle(), ptr::null_mut()) };
    if ok == 0 {
        let err = io::Error::last_os_error();
        if err.raw_os_error() != i32::try_from(ERROR_PIPE_CONNECTED).ok() {
            return Err(err);
        }
    }
    Ok(File::from(instance))
}

/// Solange dieser Wert lebt, arbeitet der aktuelle Thread mit den Rechten des Clients.
/// Beim Verwerfen kehrt er zur eigenen Identität zurück; gelingt das nicht, wird der Prozess
/// sofort beendet (mit fremder Identität weiterzuarbeiten wäre gefährlicher).
#[derive(Debug)]
pub struct Impersonation {
    _not_send: std::marker::PhantomData<*const ()>,
}

impl Impersonation {
    /// Wächter für einen eben begonnenen Identitätswechsel (nur innerhalb dieses Crates).
    pub(crate) fn started() -> Self {
        Self {
            _not_send: std::marker::PhantomData,
        }
    }
}

impl Drop for Impersonation {
    fn drop(&mut self) {
        // SAFETY: Keine Argumente; setzt nur das Thread-Token zurück.
        // aegis-unsafe: winffi-revert-to-self
        #[allow(unsafe_code)]
        let ok = unsafe { RevertToSelf() };
        if ok == 0 {
            std::process::abort();
        }
    }
}

/// Wechselt den aktuellen Thread auf die Identität des Pipe-Clients. Vorher muss mindestens
/// eine Nachricht gelesen worden sein (Windows-Vorgabe). Verschachteln ist nicht erlaubt:
/// Das Beenden würde sonst stillschweigend zur eigenen Identität zurückkehren.
///
/// # Errors
/// Client erlaubt keinen Identitätswechsel, Pipe ungültig oder bereits gewechselt.
pub fn impersonate_client(pipe: &File) -> io::Result<Impersonation> {
    if thread_is_impersonating()? {
        return Err(io::Error::other(
            "Identitätswechsel ist bereits aktiv – verschachteln nicht erlaubt",
        ));
    }
    // SAFETY: `pipe` ist ein gültiges Server-Ende einer verbundenen Named Pipe.
    // aegis-unsafe: winffi-impersonate-client
    #[allow(unsafe_code)]
    let ok = unsafe { ImpersonateNamedPipeClient(pipe.as_raw_handle()) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Impersonation {
        _not_send: std::marker::PhantomData,
    })
}

/// Arbeitet der aktuelle Thread gerade mit fremder Identität? (für Tests und Diagnose)
///
/// # Errors
/// Unerwarteter Fehler beim Abfragen.
pub fn thread_is_impersonating() -> io::Result<bool> {
    let mut token: HANDLE = ptr::null_mut();
    // SAFETY: GetCurrentThread liefert ein Pseudo-Handle; `token` ist ein gültiger
    // Ausgabezeiger. OpenAsSelf = 1, damit die Abfrage nicht selbst am Client-Token scheitert.
    // aegis-unsafe: winffi-open-thread-token
    #[allow(unsafe_code)]
    let ok = unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut token) };
    if ok == 0 {
        let err = io::Error::last_os_error();
        return if err.raw_os_error() == i32::try_from(ERROR_NO_TOKEN).ok() {
            Ok(false)
        } else {
            Err(err)
        };
    }
    drop(own(token)?);
    Ok(true)
}

/// Wer betreibt den Server einer Pipe?
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerIdentity {
    /// Konto SYSTEM (so läuft der installierte Dienst).
    LocalSystem,
    /// Jemand anderes (z. B. `aegis-service run` in einer Konsole oder ein Programm, das den
    /// Namen besetzt hat) – eine Release-App sendet dann nichts.
    Other,
}

/// Prüft (als Client, **vor** dem ersten Senden), ob der echte Dienst antwortet: Die Pipe muss
/// SYSTEM gehören (das kann nur ein SYSTEM-Prozess eintragen) und in Sitzung 0 laufen. Das
/// klappt auch für normale Nutzer (anders als ein Blick in das Token des Server-Prozesses).
///
/// # Errors
/// Pipe nicht abfragbar.
pub fn server_identity(pipe: &File) -> io::Result<ServerIdentity> {
    let mut owner: PSID = ptr::null_mut();
    let mut sd: PSECURITY_DESCRIPTOR = ptr::null_mut();
    // SAFETY: `pipe` ist ein gültiges Client-Handle mit READ_CONTROL; Ausgabezeiger gültig;
    // `owner` zeigt in `sd`, das per LocalFree (SecurityDescriptor) freigegeben wird.
    // aegis-unsafe: winffi-pipe-owner
    #[allow(unsafe_code)]
    let status = unsafe {
        GetSecurityInfo(
            pipe.as_raw_handle(),
            SE_KERNEL_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut sd,
        )
    };
    if status != 0 {
        return Err(io::Error::from_raw_os_error(
            i32::try_from(status).unwrap_or(i32::MAX),
        ));
    }
    let sd = SecurityDescriptor(sd);
    let system_owned = sid_is(owner, &[WinLocalSystemSid]);
    drop(sd);
    let mut session = u32::MAX;
    // SAFETY: `pipe` ist ein gültiges Client-Ende; `session` ein gültiger Ausgabezeiger.
    // aegis-unsafe: winffi-pipe-server-session
    #[allow(unsafe_code)]
    let ok = unsafe { GetNamedPipeServerSessionId(pipe.as_raw_handle(), &mut session) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(if system_owned && session == 0 {
        ServerIdentity::LocalSystem
    } else {
        ServerIdentity::Other
    })
}

/// Läuft dieser Prozess als SYSTEM?
///
/// # Errors
/// Eigenes Token nicht lesbar.
pub fn current_process_is_system() -> io::Result<bool> {
    let mut token: HANDLE = ptr::null_mut();
    // SAFETY: GetCurrentProcess liefert ein Pseudo-Handle; `token` ist ein gültiger
    // Ausgabezeiger; das Token wird sofort übernommen.
    // aegis-unsafe: winffi-open-own-token
    #[allow(unsafe_code)]
    let ok = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = own(token)?;
    token_user_is(token.as_raw_handle(), &[WinLocalSystemSid])
}

/// Trennt eine Verbindung von der Server-Seite (z. B. nach Leerlauf); ein blockiertes Lesen
/// im Verbindungs-Thread endet dann mit einem Fehler.
///
/// # Errors
/// Pipe ungültig.
pub fn disconnect(pipe: &File) -> io::Result<()> {
    // SAFETY: `pipe` ist ein gültiges Server-Ende einer Named Pipe.
    // aegis-unsafe: winffi-pipe-disconnect
    #[allow(unsafe_code)]
    let ok = unsafe { DisconnectNamedPipe(pipe.as_raw_handle()) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Die SID des Pipe-Clients als Text (`S-1-5-21-…`) – für Eigentum an Quarantäne-Einträgen und
/// Grenzen je Nutzer. Wechselt dafür kurz die Identität.
///
/// # Errors
/// Identitätswechsel oder Abfrage nicht möglich.
pub fn client_sid(pipe: &File) -> io::Result<String> {
    let as_client = impersonate_client(pipe)?;
    let mut token: HANDLE = ptr::null_mut();
    // SAFETY: Pseudo-Handle des Threads; OpenAsSelf = 1 (Zugriffsprüfung gegen das eigene
    // Konto); `token` ist ein gültiger Ausgabezeiger.
    // aegis-unsafe: winffi-open-client-token
    #[allow(unsafe_code)]
    let ok = unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut token) };
    drop(as_client);
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = own(token)?;
    token_user(token.as_raw_handle(), sid_to_string)?
}

/// Profilordner des Pipe-Clients (`C:\Users\name`) – damit der Dienst Funde aus dessen
/// Ordnern nur diesem Konto zeigt.
///
/// # Errors
/// Identitätswechsel oder Abfrage nicht möglich.
pub fn client_profile_dir(pipe: &File) -> io::Result<std::path::PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::UI::Shell::GetUserProfileDirectoryW;
    let as_client = impersonate_client(pipe)?;
    let mut token: HANDLE = ptr::null_mut();
    // SAFETY: Pseudo-Handle des Threads; OpenAsSelf = 1; `token` ist ein Ausgabezeiger.
    // aegis-unsafe: winffi-open-client-token-profile
    #[allow(unsafe_code)]
    let ok = unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut token) };
    drop(as_client);
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = own(token)?;
    let mut buffer = vec![0u16; 1024];
    let mut len = u32::try_from(buffer.len()).unwrap_or(1024);
    // SAFETY: `token` hat TOKEN_QUERY; `buffer`/`len` beschreiben einen gültigen Puffer.
    // aegis-unsafe: winffi-profile-dir
    #[allow(unsafe_code)]
    let ok =
        unsafe { GetUserProfileDirectoryW(token.as_raw_handle(), buffer.as_mut_ptr(), &mut len) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    Ok(std::path::PathBuf::from(std::ffi::OsString::from_wide(
        &buffer[..end],
    )))
}

/// Ist der Pipe-Client ein **erhöhter** Administrator (Administratoren-Gruppe im Token aktiv)?
/// Für rechnerweite Einstellungen. Wie [`client_sid`] erst nach dem Lesen einer Nachricht.
///
/// # Errors
/// Identitätswechsel oder Abfrage nicht möglich.
pub fn client_is_admin(pipe: &File) -> io::Result<bool> {
    use windows_sys::Win32::Security::{
        CheckTokenMembership, CreateWellKnownSid, SECURITY_MAX_SID_SIZE,
        WinBuiltinAdministratorsSid,
    };
    let mut admins = [0u8; SECURITY_MAX_SID_SIZE as usize];
    let mut size = SECURITY_MAX_SID_SIZE;
    // SAFETY: Puffer der angegebenen Größe; keine Domänen-SID.
    // aegis-unsafe: winffi-admins-sid
    #[allow(unsafe_code)]
    let ok = unsafe {
        CreateWellKnownSid(
            WinBuiltinAdministratorsSid,
            ptr::null_mut(),
            admins.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let as_client = impersonate_client(pipe)?;
    let mut member = 0;
    // SAFETY: null = Token des (gewechselten) Threads; SID-Puffer gültig; Ausgabezeiger gültig.
    // aegis-unsafe: winffi-check-admin
    #[allow(unsafe_code)]
    let ok =
        unsafe { CheckTokenMembership(ptr::null_mut(), admins.as_mut_ptr().cast(), &mut member) };
    drop(as_client);
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(member != 0)
}

pub(crate) fn sid_to_string(sid: PSID) -> io::Result<String> {
    let mut text: *mut u16 = ptr::null_mut();
    // SAFETY: `sid` ist eine gültige SID (lebt im Puffer des Aufrufers); `text` erhält einen
    // mit LocalAlloc angelegten, nullterminierten Text, der unten genau einmal freigegeben wird.
    // aegis-unsafe: winffi-sid-to-string
    #[allow(unsafe_code)]
    let ok = unsafe { ConvertSidToStringSidW(sid, &mut text) };
    if ok == 0 || text.is_null() {
        return Err(io::Error::last_os_error());
    }
    let mut len = 0usize;
    // SAFETY: `text` ist nullterminiert (Vertrag von ConvertSidToStringSidW); gelesen wird bis
    // zur Null, höchstens 256 Zeichen (SIDs sind deutlich kürzer).
    // aegis-unsafe: winffi-sid-text-read
    #[allow(unsafe_code)]
    let units = unsafe {
        while len < 256 && *text.add(len) != 0 {
            len += 1;
        }
        std::slice::from_raw_parts(text, len).to_vec()
    };
    // SAFETY: `text` stammt von ConvertSidToStringSidW (LocalAlloc) und wird genau einmal frei.
    // aegis-unsafe: winffi-sid-text-free
    #[allow(unsafe_code)]
    let _ = unsafe { LocalFree(text.cast()) };
    Ok(String::from_utf16_lossy(&units))
}

/// SID des eigenen Prozesses (`S-1-5-21-…`).
///
/// # Errors
/// Token nicht lesbar.
pub fn current_user_sid() -> io::Result<String> {
    let mut token: HANDLE = ptr::null_mut();
    // SAFETY: Pseudo-Handle des eigenen Prozesses; Ausgabezeiger gültig.
    // aegis-unsafe: winffi-user-pipe-token
    #[allow(unsafe_code)]
    let ok = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = own(token)?;
    token_user(token.as_raw_handle(), sid_to_string)?
}

/// Name der Tresor-Pipe eines Kontos (je Konto eigener Name).
#[must_use]
pub fn vault_pipe_name(sid: &str) -> String {
    format!(r"\\.\pipe\aegis-vault-{sid}")
}

/// Legt eine Pipe-Instanz an, auf die **nur das eigene Konto** zugreifen darf (Tresor-Brücke
/// zur Browser-Erweiterung). `first`: wie [`create_instance`].
///
/// # Errors
/// Name belegt oder Zugriffsliste ungültig.
pub fn create_user_instance(name: &str, first: bool) -> io::Result<OwnedHandle> {
    let sid = current_user_sid()?;
    if !sid.starts_with("S-1-")
        || !sid
            .bytes()
            .all(|b| b.is_ascii_digit() || b == b'-' || b == b'S')
    {
        return Err(io::Error::other("unerwartete SID"));
    }
    let sd = SecurityDescriptor::from_sddl(&format!("O:{sid}D:P(A;;GA;;;{sid})"))?;
    let attributes = sd.attributes();
    let name = wide(name);
    let open_mode = PIPE_ACCESS_DUPLEX
        | if first {
            FILE_FLAG_FIRST_PIPE_INSTANCE
        } else {
            0
        };
    // SAFETY: `name` nullterminiert, `attributes` verweist auf eine gültige
    // Sicherheitsbeschreibung, die bis nach dem Aufruf lebt (`sd`).
    // aegis-unsafe: winffi-user-pipe-create
    #[allow(unsafe_code)]
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            open_mode,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            4,
            64 * 1024,
            64 * 1024,
            0,
            &attributes,
        )
    };
    own(handle)
}

/// Prozess-ID des verbundenen Clients.
///
/// # Errors
/// Abfrage nicht möglich.
pub fn client_process_id(pipe: &File) -> io::Result<u32> {
    let mut pid = 0u32;
    // SAFETY: gültiges Pipe-Handle; Ausgabezeiger gültig.
    // aegis-unsafe: winffi-pipe-client-pid
    #[allow(unsafe_code)]
    let ok = unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle(), &mut pid) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(pid)
}

/// Prozess-ID des Servers einer geöffneten Pipe (Client-Seite).
///
/// # Errors
/// Abfrage nicht möglich.
pub fn server_process_id(pipe: &File) -> io::Result<u32> {
    let mut pid = 0u32;
    // SAFETY: gültiges Pipe-Handle; Ausgabezeiger gültig.
    // aegis-unsafe: winffi-pipe-server-pid
    #[allow(unsafe_code)]
    let ok = unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut pid) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(pid)
}
