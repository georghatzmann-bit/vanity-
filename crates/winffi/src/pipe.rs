//! Named Pipe des Dienstes: Zugriffsliste, Identitätswechsel auf den Client (Dateizugriffe
//! mit dessen Rechten), Prüfung der Server-Identität durch den Client.

use std::fs::File;
use std::io;
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::ptr;

use windows_sys::Win32::Foundation::{ERROR_NO_TOKEN, ERROR_PIPE_CONNECTED, HANDLE};
use windows_sys::Win32::Security::{RevertToSelf, TOKEN_QUERY, WinLocalSystemSid};
use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeServerProcessId, ImpersonateNamedPipeClient,
    PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES,
    PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentThread, OpenProcess, OpenProcessToken, OpenThreadToken,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::util::{SecurityDescriptor, own, token_user_is, wide};

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
    let sd = SecurityDescriptor::from_sddl(PIPE_SDDL)?;
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
/// eine Nachricht gelesen worden sein (Windows-Vorgabe).
///
/// # Errors
/// Client erlaubt keinen Identitätswechsel oder Pipe ungültig.
pub fn impersonate_client(pipe: &File) -> io::Result<Impersonation> {
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

/// Prüft (als Client, **vor** dem ersten Senden), unter welchem Konto der Server läuft.
/// Ein Programm, das den Pipe-Namen besetzt, um Antworten abzufangen, läuft nicht als SYSTEM.
///
/// # Errors
/// Prozess des Servers nicht abfragbar.
pub fn server_identity(pipe: &File) -> io::Result<ServerIdentity> {
    let mut pid = 0u32;
    // SAFETY: `pipe` ist ein gültiges Client-Ende einer Named Pipe; `pid` ist gültig.
    // aegis-unsafe: winffi-pipe-server-pid
    #[allow(unsafe_code)]
    let ok = unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut pid) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: Nur Abfrage-Recht; das Handle wird sofort übernommen und geschlossen.
    // aegis-unsafe: winffi-open-server-process
    #[allow(unsafe_code)]
    let process = own(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })?;
    let mut token: HANDLE = ptr::null_mut();
    // SAFETY: `process` ist ein gültiges Prozess-Handle; `token` ein gültiger Ausgabezeiger.
    // aegis-unsafe: winffi-open-server-token
    #[allow(unsafe_code)]
    let ok = unsafe { OpenProcessToken(process.as_raw_handle(), TOKEN_QUERY, &mut token) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = own(token)?;
    if token_user_is(token.as_raw_handle(), &[WinLocalSystemSid])? {
        Ok(ServerIdentity::LocalSystem)
    } else {
        Ok(ServerIdentity::Other)
    }
}
