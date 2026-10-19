//! Eingeschränkte Kindprozesse für das Parsen fremder Dateien (und ClamAV):
//!
//! - Token: vom anfragenden Nutzer (bzw. vom eigenen Prozess) abgeleitet, **eingeschränkt**
//!   (`DISABLE_MAX_PRIVILEGE | LUA_TOKEN`: keine Privilegien, Admin-Gruppen nur „deny“) und mit
//!   **niedriger Integrität** (S-1-16-4096): kann Nutzerdateien lesen, aber nirgends schreiben,
//!   wo normale Integrität nötig ist.
//! - Job-Objekt: Speichergrenze, Prozessanzahl, keine UI-Zugriffe (Zwischenablage, Desktop …),
//!   alles endet mit dem Schließen des Jobs (auch bei Absturz des Dienstes).
//! - Nur die beiden Pipe-Enden werden vererbt (Handle-Liste), sonst nichts.
//!
//! Ehrliche Grenze: Netzwerkzugriff verhindert erst die AppContainer-Sandbox (P4).

use std::ffi::OsStr;
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::ptr;
use std::time::Duration;

use windows_sys::Win32::Foundation::{
    ERROR_NO_TOKEN, HANDLE, HANDLE_FLAG_INHERIT, LocalFree, SetHandleInformation, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW;
use windows_sys::Win32::Security::{
    CreateRestrictedToken, DISABLE_MAX_PRIVILEGE, DuplicateTokenEx, GetLengthSid, LUA_TOKEN, PSID,
    SECURITY_ATTRIBUTES, SID_AND_ATTRIBUTES, SecurityImpersonation, SetTokenInformation,
    TOKEN_ADJUST_DEFAULT, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_MANDATORY_LABEL,
    TOKEN_QUERY, TokenIntegrityLevel, TokenPrimary,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_JOB_MEMORY,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_UI_RESTRICTIONS,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicUIRestrictions,
    JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::SystemServices::{JOB_OBJECT_UILIMIT_ALL, SE_GROUP_INTEGRITY};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CreateProcessAsUserW, DETACHED_PROCESS,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess,
    GetCurrentThread, GetExitCodeProcess, InitializeProcThreadAttributeList, OpenProcessToken,
    OpenThreadToken, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION, ResumeThread,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, UpdateProcThreadAttribute, WaitForSingleObject,
};

use crate::util::{own, wide};

/// Grenzen des Job-Objekts.
#[derive(Debug, Clone, Copy)]
pub struct JobLimits {
    /// Höchster Speicher aller Prozesse im Job (Byte).
    pub memory_bytes: usize,
    /// Höchstzahl gleichzeitiger Prozesse (Prüfprozess + z. B. ClamAV).
    pub processes: u32,
}

/// Eingeschränktes Token für einen Kindprozess (Primär-Token).
#[derive(Debug)]
pub struct RestrictedToken(OwnedHandle);

const TOKEN_ACCESS: u32 =
    TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT;

impl RestrictedToken {
    /// Leitet ein eingeschränktes Token mit niedriger Integrität ab: von der aktuellen
    /// Thread-Identität (während eines Identitätswechsels = der anfragende Nutzer), sonst vom
    /// eigenen Prozess. Muss **innerhalb** des Identitätswechsels aufgerufen werden.
    ///
    /// # Errors
    /// Token nicht lesbar oder nicht einschränkbar.
    pub fn from_current_identity() -> io::Result<Self> {
        let mut source: HANDLE = ptr::null_mut();
        let mut own_process = false;
        // SAFETY: Pseudo-Handle des Threads; OpenAsSelf = 1; `source` ist ein Ausgabezeiger.
        // aegis-unsafe: winffi-thread-token-for-child
        #[allow(unsafe_code)]
        let ok = unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_ACCESS, 1, &mut source) };
        if ok == 0 {
            let err = io::Error::last_os_error();
            if err.raw_os_error() != i32::try_from(ERROR_NO_TOKEN).ok() {
                return Err(err);
            }
            // SAFETY: Pseudo-Handle des eigenen Prozesses; `source` ist ein Ausgabezeiger.
            // aegis-unsafe: winffi-process-token-for-child
            #[allow(unsafe_code)]
            let ok = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_ACCESS, &mut source) };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            own_process = true;
        }
        let source = own(source)?;
        // Eigenes Prozess-Token direkt einschränken: Nur ein unmittelbar abgeleitetes
        // („Kind“-)Token darf ohne Sonderrecht einem neuen Prozess zugewiesen werden
        // (Konsolenbetrieb, CI). Das Thread-Token (Identitätswechsel) muss erst zum
        // Primär-Token werden.
        let primary = if own_process {
            source
        } else {
            let mut primary: HANDLE = ptr::null_mut();
            // SAFETY: `source` ist ein gültiges Token mit TOKEN_DUPLICATE; Ausgabezeiger gültig.
            // aegis-unsafe: winffi-duplicate-token
            #[allow(unsafe_code)]
            let ok = unsafe {
                DuplicateTokenEx(
                    source.as_raw_handle(),
                    TOKEN_ACCESS,
                    ptr::null(),
                    SecurityImpersonation,
                    TokenPrimary,
                    &mut primary,
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            own(primary)?
        };
        let mut restricted: HANDLE = ptr::null_mut();
        // SAFETY: `primary` ist gültig; keine SID-/Privilegien-Listen (Zähler 0, Zeiger null).
        // aegis-unsafe: winffi-restrict-token
        #[allow(unsafe_code)]
        let ok = unsafe {
            CreateRestrictedToken(
                primary.as_raw_handle(),
                DISABLE_MAX_PRIVILEGE | LUA_TOKEN,
                0,
                ptr::null(),
                0,
                ptr::null(),
                0,
                ptr::null(),
                &mut restricted,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let restricted = own(restricted)?;
        set_low_integrity(restricted.as_raw_handle())?;
        Ok(Self(restricted))
    }
}

fn set_low_integrity(token: HANDLE) -> io::Result<()> {
    let text = wide("S-1-16-4096");
    let mut sid: PSID = ptr::null_mut();
    // SAFETY: `text` ist nullterminiert; `sid` erhält eine mit LocalAlloc angelegte SID.
    // aegis-unsafe: winffi-low-integrity-sid
    #[allow(unsafe_code)]
    let ok = unsafe { ConvertStringSidToSidW(text.as_ptr(), &mut sid) };
    if ok == 0 || sid.is_null() {
        return Err(io::Error::last_os_error());
    }
    let label = TOKEN_MANDATORY_LABEL {
        Label: SID_AND_ATTRIBUTES {
            Sid: sid,
            Attributes: u32::try_from(SE_GROUP_INTEGRITY).unwrap_or(0x20),
        },
    };
    // SAFETY: `sid` ist gültig (eben angelegt).
    // aegis-unsafe: winffi-sid-length
    #[allow(unsafe_code)]
    let sid_len = unsafe { GetLengthSid(sid) };
    let size = u32::try_from(size_of::<TOKEN_MANDATORY_LABEL>()).unwrap_or(16) + sid_len;
    // SAFETY: `token` hat TOKEN_ADJUST_DEFAULT; `label` und `sid` leben bis nach dem Aufruf.
    // aegis-unsafe: winffi-set-integrity
    #[allow(unsafe_code)]
    let ok =
        unsafe { SetTokenInformation(token, TokenIntegrityLevel, (&raw const label).cast(), size) };
    let result = if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    };
    // SAFETY: `sid` stammt von ConvertStringSidToSidW (LocalAlloc), genau einmal freigeben.
    // aegis-unsafe: winffi-low-integrity-sid-free
    #[allow(unsafe_code)]
    let _ = unsafe { LocalFree(sid.cast()) };
    result
}

/// Laufender eingeschränkter Kindprozess.
#[derive(Debug)]
pub struct RestrictedChild {
    /// Schreib-Ende zur Standardeingabe des Kindes.
    pub stdin: Option<File>,
    /// Lese-Ende der Standardausgabe des Kindes.
    pub stdout: Option<File>,
    process: OwnedHandle,
    job: OwnedHandle,
}

impl RestrictedChild {
    /// Wartet höchstens `timeout`; `Some(code)` bei Ende, `None` bei Zeitüberschreitung.
    ///
    /// # Errors
    /// Warten fehlgeschlagen.
    pub fn wait_timeout(&self, timeout: Duration) -> io::Result<Option<u32>> {
        let ms = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
        // SAFETY: `process` ist ein gültiges Prozess-Handle.
        // aegis-unsafe: winffi-child-wait
        #[allow(unsafe_code)]
        let event = unsafe { WaitForSingleObject(self.process.as_raw_handle(), ms) };
        match event {
            WAIT_OBJECT_0 => {
                let mut code = 0u32;
                // SAFETY: `process` ist gültig; `code` ein gültiger Ausgabezeiger.
                // aegis-unsafe: winffi-child-exit-code
                #[allow(unsafe_code)]
                let ok = unsafe { GetExitCodeProcess(self.process.as_raw_handle(), &mut code) };
                if ok == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(Some(code))
            }
            WAIT_TIMEOUT => Ok(None),
            _ => Err(io::Error::last_os_error()),
        }
    }

    /// Beendet alle Prozesse des eigenen Jobs (Zeitlimit). Betrifft nie fremde Prozesse.
    ///
    /// # Errors
    /// Job nicht beendbar.
    pub fn terminate(&self) -> io::Result<()> {
        // SAFETY: `job` ist das eigene, gültige Job-Handle.
        // aegis-unsafe: winffi-terminate-job
        #[allow(unsafe_code)]
        // Beendet nur den eigenen Prüfprozess (und dessen ClamAV) nach Zeitlimit.
        // aegis-mutation: winffi-terminate-job-call
        #[allow(clippy::disallowed_methods)]
        let ok = unsafe { TerminateJobObject(self.job.as_raw_handle(), 1) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

/// Anonyme Pipe; beide Enden zunächst vererbbar.
fn pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>()).unwrap_or(24),
        lpSecurityDescriptor: ptr::null_mut(),
        bInheritHandle: 1,
    };
    let (mut read, mut write): (HANDLE, HANDLE) = (ptr::null_mut(), ptr::null_mut());
    // SAFETY: Ausgabezeiger gültig; Attribute leben bis nach dem Aufruf.
    // aegis-unsafe: winffi-create-pipe
    #[allow(unsafe_code)]
    let ok = unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((own(read)?, own(write)?))
}

fn not_inheritable(handle: &OwnedHandle) -> io::Result<()> {
    // SAFETY: `handle` ist gültig; nur das Vererbungs-Flag wird gelöscht.
    // aegis-unsafe: winffi-no-inherit
    #[allow(unsafe_code)]
    let ok = unsafe { SetHandleInformation(handle.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Attributliste mit genau den zu vererbenden Handles.
struct HandleList {
    buffer: Vec<u64>,
    _handles: Box<[HANDLE]>,
}

impl HandleList {
    fn new(handles: Box<[HANDLE]>) -> io::Result<Self> {
        let mut size = 0usize;
        // SAFETY: Größenabfrage mit null-Liste (dokumentiertes Vorgehen); Fehler erwartet.
        // aegis-unsafe: winffi-attr-size
        #[allow(unsafe_code)]
        let _ = unsafe { InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut size) };
        let mut buffer = vec![0u64; size.div_ceil(8).max(1)];
        // SAFETY: `buffer` ist mindestens `size` Byte groß und 8-Byte-ausgerichtet.
        // aegis-unsafe: winffi-attr-init
        #[allow(unsafe_code)]
        let ok = unsafe {
            InitializeProcThreadAttributeList(buffer.as_mut_ptr().cast(), 1, 0, &mut size)
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let list = Self {
            buffer,
            _handles: handles,
        };
        // SAFETY: Liste initialisiert; `_handles` lebt so lange wie die Liste (Box im Wert);
        // Größe = Anzahl × Handle-Größe.
        // aegis-unsafe: winffi-attr-update
        #[allow(unsafe_code)]
        let ok = unsafe {
            UpdateProcThreadAttribute(
                list.buffer.as_ptr().cast_mut().cast(),
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                list._handles.as_ptr().cast(),
                list._handles.len() * size_of::<HANDLE>(),
                ptr::null_mut(),
                ptr::null(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(list)
    }

    fn as_ptr(&mut self) -> *mut core::ffi::c_void {
        self.buffer.as_mut_ptr().cast()
    }
}

impl Drop for HandleList {
    fn drop(&mut self) {
        // SAFETY: Die Liste wurde erfolgreich initialisiert und wird genau einmal gelöscht.
        // aegis-unsafe: winffi-attr-delete
        #[allow(unsafe_code)]
        unsafe {
            DeleteProcThreadAttributeList(self.buffer.as_mut_ptr().cast());
        }
    }
}

fn job(limits: JobLimits) -> io::Result<OwnedHandle> {
    // SAFETY: Anonymer Job ohne Sicherheitsattribute.
    // aegis-unsafe: winffi-create-job
    #[allow(unsafe_code)]
    let job = own(unsafe { CreateJobObjectW(ptr::null(), ptr::null()) })?;
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        | JOB_OBJECT_LIMIT_JOB_MEMORY
        | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
    info.BasicLimitInformation.ActiveProcessLimit = limits.processes;
    info.JobMemoryLimit = limits.memory_bytes;
    // SAFETY: `job` gültig; `info` lebt bis nach dem Aufruf; Größe passt zur Struktur.
    // aegis-unsafe: winffi-job-limits
    #[allow(unsafe_code)]
    let ok = unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&raw const info).cast(),
            u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()).unwrap_or(0),
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let ui = JOBOBJECT_BASIC_UI_RESTRICTIONS {
        UIRestrictionsClass: JOB_OBJECT_UILIMIT_ALL,
    };
    // SAFETY: wie oben, mit den UI-Beschränkungen.
    // aegis-unsafe: winffi-job-ui
    #[allow(unsafe_code)]
    let ok = unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectBasicUIRestrictions,
            (&raw const ui).cast(),
            u32::try_from(size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>()).unwrap_or(4),
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(job)
}

/// Ordnet einen bereits gestarteten, eigenen Hilfsprozess (z. B. `freshclam`) einem Job zu,
/// der beim Schließen alles beendet (auch Kindprozesse) und Speicher/Prozesszahl begrenzt.
///
/// # Errors
/// Job nicht anlegbar oder Zuordnung fehlgeschlagen.
pub fn kill_on_close_job(process: &impl AsRawHandle, limits: JobLimits) -> io::Result<OwnedHandle> {
    let job = job(limits)?;
    // SAFETY: `job` und das Prozess-Handle sind gültig.
    // aegis-unsafe: winffi-assign-helper-job
    #[allow(unsafe_code)]
    let ok = unsafe { AssignProcessToJobObject(job.as_raw_handle(), process.as_raw_handle()) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(job)
}

fn command_line(exe: &Path, args: &[&str]) -> Vec<u16> {
    // Nur feste, eigene Argumente (ohne Anführungszeichen/Backslash am Ende) – keine
    // Nutzereingaben in der Befehlszeile; Pfade gehen über die Standardeingabe.
    let mut line: Vec<u16> = Vec::new();
    line.push(u16::from(b'"'));
    line.extend(exe.as_os_str().encode_wide());
    line.push(u16::from(b'"'));
    for arg in args {
        line.push(u16::from(b' '));
        line.extend(OsStr::new(arg).encode_wide());
    }
    line.push(0);
    line
}

/// Startet `exe` mit eingeschränktem Token in einem eigenen Job. Standardeingabe und
/// -ausgabe sind Pipes zum Aufrufer; Fehlerausgabe geht in die Standardausgabe.
///
/// # Errors
/// Prozess nicht startbar, Job nicht anlegbar.
pub fn spawn_restricted(
    token: &RestrictedToken,
    exe: &Path,
    args: &[&str],
    limits: JobLimits,
) -> io::Result<RestrictedChild> {
    if args.iter().any(|a| a.contains('"') || a.ends_with('\\')) {
        return Err(io::Error::other("ungültiges Argument für den Prüfprozess"));
    }
    let job = job(limits)?;
    let (child_in, parent_in) = pipe()?;
    let (parent_out, child_out) = pipe()?;
    not_inheritable(&parent_in)?;
    not_inheritable(&parent_out)?;
    let mut list = HandleList::new(Box::new([
        child_in.as_raw_handle(),
        child_out.as_raw_handle(),
    ]))?;
    let mut info = STARTUPINFOEXW::default();
    info.StartupInfo.cb = u32::try_from(size_of::<STARTUPINFOEXW>()).unwrap_or(0);
    info.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    info.StartupInfo.hStdInput = child_in.as_raw_handle();
    info.StartupInfo.hStdOutput = child_out.as_raw_handle();
    info.StartupInfo.hStdError = child_out.as_raw_handle();
    info.lpAttributeList = list.as_ptr();
    let application = wide(exe);
    let mut line = command_line(exe, args);
    let mut process = PROCESS_INFORMATION::default();
    // Ohne Konsole (DETACHED_PROCESS): Ein- und Ausgabe laufen nur über die Pipes; so muss kein
    // Konsolen-Host für das eingeschränkte Token entstehen (bei Tokens aus dem
    // Identitätswechsel über die Pipe scheiterte das mit 0xC0000142). Manche Tokens (das
    // „nur Nutzer“-Token der Hintergrundprüfung) lehnt Windows damit ab (Fehler 87) – dann
    // einmal mit unsichtbarer Konsole (CREATE_NO_WINDOW).
    let mut ok = 0;
    for console in [DETACHED_PROCESS, CREATE_NO_WINDOW] {
        // SAFETY: Alle Zeiger zeigen auf lebende, nullterminierte Puffer bzw. Strukturen; die
        // Handle-Liste begrenzt die Vererbung auf die beiden Kind-Enden; der Prozess startet
        // angehalten und läuft erst nach der Zuordnung zum Job an.
        // aegis-unsafe: winffi-create-restricted-process
        #[allow(unsafe_code)]
        // Startet den eigenen, eingeschränkten Prüfprozess (bzw. ClamAV) – kein Nutzerprogramm.
        // aegis-mutation: winffi-create-restricted-process-call
        #[allow(clippy::disallowed_methods)]
        let started = unsafe {
            CreateProcessAsUserW(
                token.0.as_raw_handle(),
                application.as_ptr(),
                line.as_mut_ptr(),
                ptr::null(),
                ptr::null(),
                1,
                CREATE_SUSPENDED | console | EXTENDED_STARTUPINFO_PRESENT,
                ptr::null(),
                ptr::null(),
                &raw const info.StartupInfo,
                &mut process,
            )
        };
        ok = started;
        if ok != 0 || io::Error::last_os_error().raw_os_error() != Some(87) {
            break;
        }
    }
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateProcessAsUserW hat beide Handles neu geliefert; jedes wird genau einmal
    // übernommen.
    // aegis-unsafe: winffi-own-process-handles
    #[allow(unsafe_code)]
    let (process_handle, thread) = unsafe {
        (
            OwnedHandle::from_raw_handle(process.hProcess),
            OwnedHandle::from_raw_handle(process.hThread),
        )
    };
    drop(list);
    // SAFETY: `job` und `process_handle` sind gültig.
    // aegis-unsafe: winffi-assign-job
    #[allow(unsafe_code)]
    let ok =
        unsafe { AssignProcessToJobObject(job.as_raw_handle(), process_handle.as_raw_handle()) };
    if ok == 0 {
        let err = io::Error::last_os_error();
        // Der angehaltene Prozess endet mit dem Schließen seines Handles nicht von selbst –
        // er hat aber nie Code ausgeführt; ohne Job lassen wir ihn nicht anlaufen.
        // SAFETY: `process_handle` ist gültig; beendet nur den eigenen, angehaltenen Prozess.
        // aegis-unsafe: winffi-kill-unassigned
        #[allow(unsafe_code)]
        // aegis-mutation: winffi-kill-unassigned-call
        #[allow(clippy::disallowed_methods)]
        let _ = unsafe {
            windows_sys::Win32::System::Threading::TerminateProcess(
                process_handle.as_raw_handle(),
                1,
            )
        };
        return Err(err);
    }
    // SAFETY: `thread` ist der angehaltene Hauptthread des eigenen Kindes.
    // aegis-unsafe: winffi-resume-child
    #[allow(unsafe_code)]
    let resumed = unsafe { ResumeThread(thread.as_raw_handle()) };
    if resumed == u32::MAX {
        return Err(io::Error::last_os_error());
    }
    drop(child_in);
    drop(child_out);
    Ok(RestrictedChild {
        stdin: Some(File::from(parent_in)),
        stdout: Some(File::from(parent_out)),
        process: process_handle,
        job,
    })
}
