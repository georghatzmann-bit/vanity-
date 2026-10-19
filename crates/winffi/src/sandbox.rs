//! Mini-Sandbox (Labor, Stufe 2): ein fremdes Programm startet **nur nach Freigabe** in einem
//! AppContainer ohne Fähigkeiten (kein Netzwerk, kein Zugriff auf Nutzerdateien außer dem
//! eigenen Arbeitsordner, niedrige Integrität), in einem Job-Objekt mit Grenzen für Speicher,
//! CPU und Prozesszahl und ohne Zwischenablage. Alles endet mit dem Schließen des Jobs.
//!
//! Ehrlich: schwächer als eine VM (gleicher Kernel, gleicher Desktop).

use std::ffi::OsString;
use std::io;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::ptr;
use std::time::Duration;

use windows_sys::Win32::Foundation::{
    ERROR_NO_TOKEN, HANDLE, LocalFree, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSidToSidW};
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows_sys::Win32::Security::{
    DuplicateTokenEx, FreeSid, GetTokenInformation, PSID, SECURITY_CAPABILITIES,
    SecurityImpersonation, TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_SESSIONID, TOKEN_ASSIGN_PRIMARY,
    TOKEN_DUPLICATE, TOKEN_IMPERSONATE, TOKEN_LINKED_TOKEN, TOKEN_QUERY, TokenElevationType,
    TokenElevationTypeFull, TokenLinkedToken, TokenPrimary, WinLocalServiceSid, WinLocalSystemSid,
    WinNetworkServiceSid,
};
use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;
use windows_sys::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_CPU_RATE_CONTROL_ENABLE,
    JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_JOB_MEMORY,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_UILIMIT_DESKTOP,
    JOB_OBJECT_UILIMIT_DISPLAYSETTINGS, JOB_OBJECT_UILIMIT_EXITWINDOWS,
    JOB_OBJECT_UILIMIT_GLOBALATOMS, JOB_OBJECT_UILIMIT_HANDLES, JOB_OBJECT_UILIMIT_READCLIPBOARD,
    JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS, JOB_OBJECT_UILIMIT_WRITECLIPBOARD,
    JOBOBJECT_BASIC_UI_RESTRICTIONS, JOBOBJECT_CPU_RATE_CONTROL_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicProcessIdList,
    JobObjectBasicUIRestrictions, JobObjectCpuRateControlInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject,
};
use windows_sys::Win32::System::Threading::{
    CREATE_NEW_CONSOLE, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessAsUserW,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess,
    GetCurrentThread, GetExitCodeProcess, InitializeProcThreadAttributeList, OpenProcessToken,
    OpenThreadToken, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, PROCESS_INFORMATION,
    ResumeThread, STARTUPINFOEXW, UpdateProcThreadAttribute, WaitForSingleObject,
};

use crate::pipe::Impersonation;
use crate::util::{SecurityDescriptor, own, token_user_is, wide};

/// Namensanfang der AppContainer des Labors (je Lauf: `AEGIS.Labor.<Kennung>`).
pub const LAB_APPCONTAINER: &str = "AEGIS.Labor";

/// AppContainer-Name eines Laufs (eigenes Profil und eigene SID je Lauf).
#[must_use]
pub fn lab_appcontainer_name(run_id: &str) -> String {
    let id: String = run_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(40)
        .collect();
    format!("{LAB_APPCONTAINER}.{id}")
}

/// Grenzen eines Labor-Laufs.
#[derive(Debug, Clone, Copy)]
pub struct LabLimits {
    /// Speicher aller Prozesse (Byte).
    pub memory_bytes: usize,
    /// Höchstzahl gleichzeitiger Prozesse.
    pub processes: u32,
    /// CPU-Obergrenze in Prozent (1–100).
    pub cpu_percent: u32,
}

/// `HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)`.
const HR_ALREADY_EXISTS: i32 = 0x8007_00B7_u32 as i32;

/// Legt das AppContainer-Profil des Labors für das aktuelle Konto (bzw. das per
/// Identitätswechsel übernommene) an, falls es fehlt. Ohne Profil fehlt der Objekt-Ordner des
/// AppContainers, und `CreateProcess` meldet „Datei nicht gefunden“. Das Profil hat keine
/// Fähigkeiten (kein Netz, keine Bibliotheken); es gehört AEGIS und bleibt bestehen.
///
/// # Errors
/// Profil nicht anlegbar.
pub fn ensure_appcontainer_profile(name: &str) -> io::Result<()> {
    let text = wide(name);
    let display = wide("AEGIS Labor");
    let description = wide("AEGIS Labor – Mini-Sandbox ohne Fähigkeiten");
    let mut sid: PSID = ptr::null_mut();
    // SAFETY: alle Texte nullterminiert; keine Fähigkeiten (Zeiger null, Anzahl 0); `sid`
    // erhält bei Erfolg eine mit FreeSid freizugebende SID.
    // aegis-unsafe: winffi-create-appcontainer-profile
    #[allow(unsafe_code)]
    // Legt das AEGIS-eigene AppContainer-Profil des Labors an (Registrierung + Ordner des
    // Profils, ohne Fähigkeiten) – nur vor einem freigegebenen Labor-Lauf.
    // aegis-mutation: winffi-create-appcontainer-profile-call
    #[allow(clippy::disallowed_methods)]
    let hr = unsafe {
        CreateAppContainerProfile(
            text.as_ptr(),
            display.as_ptr(),
            description.as_ptr(),
            ptr::null(),
            0,
            &mut sid,
        )
    };
    if hr >= 0 {
        if !sid.is_null() {
            // SAFETY: SID von CreateAppContainerProfile; genau einmal freigeben.
            // aegis-unsafe: winffi-appcontainer-profile-sid-free
            #[allow(unsafe_code)]
            let _ = unsafe { FreeSid(sid) };
        }
        return Ok(());
    }
    if hr == HR_ALREADY_EXISTS {
        return Ok(());
    }
    Err(io::Error::from_raw_os_error(hr))
}

/// Löscht das AppContainer-Profil eines beendeten Laufs (Ordner und Registrierung des
/// Profils, samt allem, was die Probe dort abgelegt hat). Nur für Namen des Labors.
///
/// # Errors
/// Fremder Name oder Profil nicht löschbar.
pub fn delete_appcontainer_profile(name: &str) -> io::Result<()> {
    if !name.starts_with(&format!("{LAB_APPCONTAINER}.")) {
        return Err(io::Error::other("Nur Profile des Labors"));
    }
    let text = wide(name);
    // SAFETY: `text` ist nullterminiert.
    // aegis-unsafe: winffi-delete-appcontainer-profile
    #[allow(unsafe_code)]
    // Verwirft das AEGIS-eigene Profil eines beendeten Labor-Laufs (Teil des freigegebenen
    // Laufs: „Das Labor wird nach dem Lauf verworfen“).
    // aegis-mutation: winffi-delete-appcontainer-profile-call
    #[allow(clippy::disallowed_methods)]
    let hr = unsafe { DeleteAppContainerProfile(text.as_ptr()) };
    if hr < 0 {
        return Err(io::Error::from_raw_os_error(hr));
    }
    Ok(())
}

/// SID eines AppContainers als Text (`S-1-15-2-…`), abgeleitet aus dem Namen.
///
/// # Errors
/// Ableitung fehlgeschlagen.
pub fn appcontainer_sid(name: &str) -> io::Result<String> {
    let text = wide(name);
    let mut sid: PSID = ptr::null_mut();
    // SAFETY: `text` ist nullterminiert; `sid` erhält eine mit FreeSid freizugebende SID.
    // aegis-unsafe: winffi-derive-appcontainer-sid
    #[allow(unsafe_code)]
    let hr = unsafe { DeriveAppContainerSidFromAppContainerName(text.as_ptr(), &mut sid) };
    if hr < 0 || sid.is_null() {
        return Err(io::Error::from_raw_os_error(hr));
    }
    let mut out: *mut u16 = ptr::null_mut();
    // SAFETY: `sid` ist gültig; `out` erhält einen LocalAlloc-Text.
    // aegis-unsafe: winffi-appcontainer-sid-text
    #[allow(unsafe_code)]
    let ok = unsafe { ConvertSidToStringSidW(sid, &mut out) };
    let result = if ok == 0 || out.is_null() {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: `out` ist ein nullterminierter UTF-16-Text von ConvertSidToStringSidW.
        // aegis-unsafe: winffi-appcontainer-sid-read
        #[allow(unsafe_code)]
        let text = unsafe {
            let mut len = 0usize;
            while *out.add(len) != 0 {
                len += 1;
            }
            OsString::from_wide(std::slice::from_raw_parts(out, len))
        };
        Ok(text.to_string_lossy().into_owned())
    };
    // SAFETY: `out` (falls gesetzt) stammt von LocalAlloc, `sid` von der Ableitung (FreeSid);
    // jeweils genau einmal freigeben.
    // aegis-unsafe: winffi-appcontainer-sid-free
    #[allow(unsafe_code)]
    unsafe {
        if !out.is_null() {
            let _ = LocalFree(out.cast());
        }
        let _ = FreeSid(sid);
    }
    result
}

/// Legt einen **neuen** Ordner mit der angegebenen Zugriffsliste an (SDDL). Existiert er,
/// schlägt das fehl – der Labor-Ordner wird nie wiederverwendet.
///
/// # Errors
/// Ordner existiert oder ist nicht anlegbar.
pub fn create_dir_with_sddl(path: &Path, sddl: &str) -> io::Result<()> {
    let sd = SecurityDescriptor::from_sddl(sddl)?;
    let attributes = sd.attributes();
    let name = wide(path);
    // SAFETY: `name` ist nullterminiert; `attributes` verweist auf `sd`, das lebt.
    // aegis-unsafe: winffi-create-lab-dir
    #[allow(unsafe_code)]
    // Legt einen neuen, eigenen Labor-Ordner im AEGIS-Datenbereich an (nie vorhandene Ordner).
    // aegis-mutation: winffi-create-lab-dir-call
    #[allow(clippy::disallowed_methods)]
    let ok = unsafe { CreateDirectoryW(name.as_ptr(), &attributes) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Primär-Token des anfragenden Nutzers, **nicht** eingeschränkt – die Einschränkung liefert
/// der AppContainer bzw. die VM. Nie das Token des Dienstes (SYSTEM).
#[derive(Debug)]
pub struct UserToken {
    token: OwnedHandle,
    /// Token des eigenen Prozesses (Konsole, Tests) – nur über [`UserToken::for_console`].
    own: bool,
}

const TOKEN_ACCESS: u32 = TOKEN_QUERY
    | TOKEN_DUPLICATE
    | TOKEN_IMPERSONATE
    | TOKEN_ASSIGN_PRIMARY
    | TOKEN_ADJUST_DEFAULT
    | TOKEN_ADJUST_SESSIONID;

/// Dienstkonten (SYSTEM, LocalService, NetworkService) starten nie etwas im Labor.
fn refuse_service_account(token: HANDLE) -> io::Result<()> {
    if token_user_is(
        token,
        &[WinLocalSystemSid, WinLocalServiceSid, WinNetworkServiceSid],
    )? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Labor startet nie mit einem Dienstkonto",
        ));
    }
    Ok(())
}

fn primary_from(source: HANDLE) -> io::Result<OwnedHandle> {
    let mut primary: HANDLE = ptr::null_mut();
    // SAFETY: `source` hat TOKEN_DUPLICATE; Ausgabezeiger gültig.
    // aegis-unsafe: winffi-lab-duplicate-token
    #[allow(unsafe_code)]
    let ok = unsafe {
        DuplicateTokenEx(
            source,
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
    own(primary)
}

impl UserToken {
    /// Token des Nutzers, dessen Identität der aktuelle Thread angenommen hat (Pipe-Client).
    /// Ohne Identitätswechsel ist das ein Fehler – es gibt keinen stillen Rückfall auf das
    /// Token des Dienstes.
    ///
    /// # Errors
    /// Kein Identitätswechsel aktiv, Dienstkonto oder Token nicht lesbar.
    pub fn from_current_identity() -> io::Result<Self> {
        let mut source: HANDLE = ptr::null_mut();
        // SAFETY: Pseudo-Handle des Threads; OpenAsSelf = 1; Ausgabezeiger gültig.
        // aegis-unsafe: winffi-lab-thread-token
        #[allow(unsafe_code)]
        let ok = unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_ACCESS, 1, &mut source) };
        if ok == 0 {
            let err = io::Error::last_os_error();
            if err.raw_os_error() == i32::try_from(ERROR_NO_TOKEN).ok() {
                return Err(io::Error::other(
                    "Kein Identitätswechsel aktiv – Labor nur mit den Rechten des Nutzers",
                ));
            }
            return Err(err);
        }
        let source = own(source)?;
        refuse_service_account(source.as_raw_handle())?;
        Ok(Self {
            token: primary_from(source.as_raw_handle())?,
            own: false,
        })
    }

    /// Token des eigenen Prozesses – nur für Konsole und Tests (nie als Dienstkonto).
    ///
    /// # Errors
    /// Dienstkonto oder Token nicht lesbar.
    pub fn for_console() -> io::Result<Self> {
        let mut source: HANDLE = ptr::null_mut();
        // SAFETY: Pseudo-Handle des eigenen Prozesses; Ausgabezeiger gültig.
        // aegis-unsafe: winffi-lab-process-token
        #[allow(unsafe_code)]
        let ok = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_ACCESS, &mut source) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let source = own(source)?;
        refuse_service_account(source.as_raw_handle())?;
        Ok(Self {
            token: primary_from(source.as_raw_handle())?,
            own: true,
        })
    }

    /// Bei einem erhöhten Administrator-Token: das verknüpfte, nicht erhöhte Token (die Probe
    /// bekommt nie Administratorrechte). Im Dienst (SYSTEM, ohne Identitätswechsel) aufrufen;
    /// ist das verknüpfte Token nicht als Primär-Token erhältlich, bleibt es beim Original.
    #[must_use]
    pub fn into_unelevated(self) -> Self {
        let mut kind = 0i32;
        let mut needed = 0u32;
        // SAFETY: gültiges Token mit TOKEN_QUERY; Ausgabe ist ein i32.
        // aegis-unsafe: winffi-lab-elevation-type
        #[allow(unsafe_code)]
        let ok = unsafe {
            GetTokenInformation(
                self.token.as_raw_handle(),
                TokenElevationType,
                (&raw mut kind).cast(),
                4,
                &mut needed,
            )
        };
        if ok == 0 || kind != TokenElevationTypeFull {
            return self;
        }
        let mut linked = TOKEN_LINKED_TOKEN {
            LinkedToken: ptr::null_mut(),
        };
        // SAFETY: gültiges Token; Ausgabe ist eine TOKEN_LINKED_TOKEN-Struktur.
        // aegis-unsafe: winffi-lab-linked-token
        #[allow(unsafe_code)]
        let ok = unsafe {
            GetTokenInformation(
                self.token.as_raw_handle(),
                TokenLinkedToken,
                (&raw mut linked).cast(),
                u32::try_from(size_of::<TOKEN_LINKED_TOKEN>()).unwrap_or(0),
                &mut needed,
            )
        };
        if ok == 0 {
            return self;
        }
        let Ok(linked) = own(linked.LinkedToken) else {
            return self;
        };
        match primary_from(linked.as_raw_handle()) {
            Ok(token) => Self {
                token,
                own: self.own,
            },
            Err(_) => self,
        }
    }

    /// Nimmt im aktuellen Thread die Identität dieses Nutzers an (Lesen seiner Labor-Ausgabe,
    /// Profil anlegen/löschen) – endet mit dem Rückgabewert.
    ///
    /// # Errors
    /// Wechsel nicht möglich oder bereits aktiv.
    pub fn impersonate(&self) -> io::Result<Impersonation> {
        crate::identity::impersonate_handle(self.token.as_raw_handle())
    }

    /// Umgebung des Nutzers (statt der des Dienstes) für neue Prozesse.
    fn environment(&self) -> Environment {
        let mut block: *mut core::ffi::c_void = ptr::null_mut();
        // SAFETY: gültiges Token; Ausgabezeiger gültig; ohne Erben der Dienstumgebung.
        // aegis-unsafe: winffi-lab-environment
        #[allow(unsafe_code)]
        let ok = unsafe { CreateEnvironmentBlock(&mut block, self.token.as_raw_handle(), 0) };
        Environment(if ok == 0 { ptr::null_mut() } else { block })
    }
}

/// Umgebungsblock eines Nutzers (wird freigegeben).
struct Environment(*mut core::ffi::c_void);

impl Environment {
    fn ptr(&self) -> *const core::ffi::c_void {
        self.0
    }

    fn flags(&self) -> u32 {
        if self.0.is_null() {
            0
        } else {
            CREATE_UNICODE_ENVIRONMENT
        }
    }
}

impl Drop for Environment {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: Block von CreateEnvironmentBlock; genau einmal freigeben.
            // aegis-unsafe: winffi-lab-environment-free
            #[allow(unsafe_code)]
            let _ = unsafe { DestroyEnvironmentBlock(self.0) };
        }
    }
}

/// Laufendes Programm im Labor.
#[derive(Debug)]
pub struct LabChild {
    process: OwnedHandle,
    job: OwnedHandle,
    /// Prozess-ID des gestarteten Programms.
    pub pid: u32,
}

impl LabChild {
    /// Wartet höchstens `timeout`; `Some(code)` bei Ende des Startprozesses.
    ///
    /// # Errors
    /// Warten fehlgeschlagen.
    pub fn wait_timeout(&self, timeout: Duration) -> io::Result<Option<u32>> {
        let ms = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
        // SAFETY: gültiges Prozess-Handle.
        // aegis-unsafe: winffi-lab-wait
        #[allow(unsafe_code)]
        let event = unsafe { WaitForSingleObject(self.process.as_raw_handle(), ms) };
        match event {
            WAIT_OBJECT_0 => {
                let mut code = 0u32;
                // SAFETY: gültiges Prozess-Handle; Ausgabezeiger gültig.
                // aegis-unsafe: winffi-lab-exit-code
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

    /// Prozess-IDs aller noch laufenden Prozesse des Labor-Jobs.
    ///
    /// # Errors
    /// Abfrage fehlgeschlagen.
    pub fn process_ids(&self) -> io::Result<Vec<u32>> {
        // Kopf (2 × u32) + bis zu 256 IDs.
        let mut buffer = vec![0usize; 2 + 256];
        let size = u32::try_from(buffer.len() * size_of::<usize>()).unwrap_or(0);
        // SAFETY: `buffer` ist groß genug und passend ausgerichtet; Länge stimmt.
        // aegis-unsafe: winffi-lab-job-pids
        #[allow(unsafe_code)]
        let ok = unsafe {
            QueryInformationJobObject(
                self.job.as_raw_handle(),
                JobObjectBasicProcessIdList,
                buffer.as_mut_ptr().cast(),
                size,
                ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        // Aufbau: u32 NumberOfAssignedProcesses, u32 NumberOfProcessIdsInList, dann usize-IDs.
        let header = buffer[0];
        let listed = if cfg!(target_pointer_width = "64") {
            header >> 32
        } else {
            buffer[1]
        };
        let start = if cfg!(target_pointer_width = "64") {
            1
        } else {
            2
        };
        Ok(buffer
            .iter()
            .skip(start)
            .take(listed.min(256))
            .filter_map(|&id| u32::try_from(id).ok())
            .collect())
    }

    /// Beendet alle Prozesse des Labor-Jobs (Ende der Beobachtungszeit). Betrifft nur den
    /// eigenen Labor-Lauf, der nach Freigabe gestartet wurde.
    ///
    /// # Errors
    /// Job nicht beendbar.
    pub fn terminate(&self) -> io::Result<()> {
        // SAFETY: eigenes, gültiges Job-Handle.
        // aegis-unsafe: winffi-lab-terminate
        #[allow(unsafe_code)]
        // Beendet nur die Prozesse des eigenen Labor-Laufs nach Ablauf der Beobachtungszeit.
        // aegis-mutation: winffi-lab-terminate-call
        #[allow(clippy::disallowed_methods)]
        let ok = unsafe { TerminateJobObject(self.job.as_raw_handle(), 1) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

fn set_job_info<T>(job: &OwnedHandle, class: i32, info: &T) -> io::Result<()> {
    // SAFETY: `job` gültig; `info` lebt bis nach dem Aufruf; Größe passt zum Typ.
    // aegis-unsafe: winffi-lab-job-info
    #[allow(unsafe_code)]
    let ok = unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            class,
            (&raw const *info).cast(),
            u32::try_from(size_of::<T>()).unwrap_or(0),
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn lab_job(limits: LabLimits) -> io::Result<OwnedHandle> {
    // SAFETY: anonymer Job ohne Sicherheitsattribute.
    // aegis-unsafe: winffi-lab-create-job
    #[allow(unsafe_code)]
    let job = own(unsafe { CreateJobObjectW(ptr::null(), ptr::null()) })?;
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        | JOB_OBJECT_LIMIT_JOB_MEMORY
        | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
    info.BasicLimitInformation.ActiveProcessLimit = limits.processes;
    info.JobMemoryLimit = limits.memory_bytes;
    set_job_info(&job, JobObjectExtendedLimitInformation, &info)?;
    // Fenster dürfen erscheinen (Bildschirmfotos), aber keine Zwischenablage, keine globalen
    // Einstellungen, kein Abmelden, kein Desktop-Wechsel, keine fremden Fenster-Handles.
    let ui = JOBOBJECT_BASIC_UI_RESTRICTIONS {
        UIRestrictionsClass: JOB_OBJECT_UILIMIT_READCLIPBOARD
            | JOB_OBJECT_UILIMIT_WRITECLIPBOARD
            | JOB_OBJECT_UILIMIT_GLOBALATOMS
            | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS
            | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS
            | JOB_OBJECT_UILIMIT_EXITWINDOWS
            | JOB_OBJECT_UILIMIT_DESKTOP
            | JOB_OBJECT_UILIMIT_HANDLES,
    };
    set_job_info(&job, JobObjectBasicUIRestrictions, &ui)?;
    let mut cpu = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
        ControlFlags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
        ..Default::default()
    };
    // CpuRate: Hundertstel Prozent.
    cpu.Anonymous.CpuRate = limits.cpu_percent.clamp(1, 100) * 100;
    set_job_info(&job, JobObjectCpuRateControlInformation, &cpu)?;
    Ok(job)
}

/// Attributliste mit den Sicherheitsfähigkeiten (AppContainer ohne Fähigkeiten).
struct CapabilityList {
    buffer: Vec<u64>,
    _caps: Box<SECURITY_CAPABILITIES>,
}

impl CapabilityList {
    fn new(caps: Box<SECURITY_CAPABILITIES>) -> io::Result<Self> {
        let mut size = 0usize;
        // SAFETY: Größenabfrage mit null-Liste (dokumentiert, Fehler erwartet).
        // aegis-unsafe: winffi-lab-attr-size
        #[allow(unsafe_code)]
        let _ = unsafe { InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut size) };
        let mut buffer = vec![0u64; size.div_ceil(8).max(1)];
        // SAFETY: Puffer groß genug und ausgerichtet.
        // aegis-unsafe: winffi-lab-attr-init
        #[allow(unsafe_code)]
        let ok = unsafe {
            InitializeProcThreadAttributeList(buffer.as_mut_ptr().cast(), 1, 0, &mut size)
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let list = Self {
            buffer,
            _caps: caps,
        };
        // SAFETY: Liste initialisiert; `_caps` lebt so lange wie die Liste.
        // aegis-unsafe: winffi-lab-attr-update
        #[allow(unsafe_code)]
        let ok = unsafe {
            UpdateProcThreadAttribute(
                list.buffer.as_ptr().cast_mut().cast(),
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                (&raw const *list._caps).cast(),
                size_of::<SECURITY_CAPABILITIES>(),
                ptr::null_mut(),
                ptr::null(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(list)
    }
}

impl Drop for CapabilityList {
    fn drop(&mut self) {
        // SAFETY: erfolgreich initialisierte Liste, genau einmal gelöscht.
        // aegis-unsafe: winffi-lab-attr-delete
        #[allow(unsafe_code)]
        unsafe {
            DeleteProcThreadAttributeList(self.buffer.as_mut_ptr().cast());
        }
    }
}

/// Startet `exe` im AppContainer `appcontainer_sid` (Text-SID, ohne Fähigkeiten = ohne Netz)
/// mit dem Token `token`, Arbeitsordner `workdir`, in einem eigenen Job. Nur nach Freigabe
/// aufrufen (Plan „Im Labor ausführen“).
///
/// # Errors
/// Start fehlgeschlagen.
pub fn spawn_in_appcontainer(
    token: &UserToken,
    appcontainer_sid: &str,
    exe: &Path,
    workdir: &Path,
    limits: LabLimits,
) -> io::Result<LabChild> {
    let sid_text = wide(appcontainer_sid);
    let mut sid: PSID = ptr::null_mut();
    // SAFETY: `sid_text` nullterminiert; `sid` erhält eine LocalAlloc-SID.
    // aegis-unsafe: winffi-lab-sid-parse
    #[allow(unsafe_code)]
    let ok = unsafe { ConvertStringSidToSidW(sid_text.as_ptr(), &mut sid) };
    if ok == 0 || sid.is_null() {
        return Err(io::Error::last_os_error());
    }
    let result = spawn_with_sid(token, sid, exe, workdir, limits);
    // SAFETY: `sid` stammt von ConvertStringSidToSidW; genau einmal freigeben (nach dem Start).
    // aegis-unsafe: winffi-lab-sid-free
    #[allow(unsafe_code)]
    let _ = unsafe { LocalFree(sid.cast()) };
    result
}

fn spawn_with_sid(
    token: &UserToken,
    sid: PSID,
    exe: &Path,
    workdir: &Path,
    limits: LabLimits,
) -> io::Result<LabChild> {
    let job = lab_job(limits)?;
    let mut list = CapabilityList::new(Box::new(SECURITY_CAPABILITIES {
        AppContainerSid: sid,
        Capabilities: ptr::null_mut(),
        CapabilityCount: 0,
        Reserved: 0,
    }))?;
    let mut desktop = wide(r"winsta0\default");
    let mut info = STARTUPINFOEXW::default();
    info.StartupInfo.cb = u32::try_from(size_of::<STARTUPINFOEXW>()).unwrap_or(0);
    info.StartupInfo.lpDesktop = desktop.as_mut_ptr();
    info.lpAttributeList = list.buffer.as_mut_ptr().cast();
    let application = wide(exe);
    // Befehlszeile: nur der Programmpfad in Anführungszeichen (keine Nutzerargumente).
    let mut line: Vec<u16> = Vec::new();
    line.push(u16::from(b'"'));
    line.extend(exe.as_os_str().encode_wide());
    line.push(u16::from(b'"'));
    line.push(0);
    let dir = wide(workdir);
    let environment = token.environment();
    let mut process = PROCESS_INFORMATION::default();
    // SAFETY: Alle Zeiger zeigen auf lebende, nullterminierte Puffer bzw. Strukturen; keine
    // Handles werden vererbt; der Prozess startet angehalten und läuft erst im Job an.
    // aegis-unsafe: winffi-lab-create-process
    #[allow(unsafe_code)]
    // Startet die Probe im Labor – nur nach Freigabe „Im Labor ausführen“ (Plan des Dienstes).
    // aegis-mutation: winffi-lab-create-process-call
    #[allow(clippy::disallowed_methods)]
    let ok = unsafe {
        CreateProcessAsUserW(
            token.token.as_raw_handle(),
            application.as_ptr(),
            line.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            0,
            CREATE_SUSPENDED
                | CREATE_NEW_CONSOLE
                | EXTENDED_STARTUPINFO_PRESENT
                | environment.flags(),
            environment.ptr(),
            dir.as_ptr(),
            &raw const info.StartupInfo,
            &mut process,
        )
    };
    if ok == 0 {
        let err = io::Error::last_os_error();
        // Ohne SYSTEM (Konsole, Tests) fehlt das Recht, ein Token zuzuweisen. Nur wenn es ohnehin
        // das eigene Token ist, startet der Prozess stattdessen mit dem geerbten Token – der
        // AppContainer gilt über die Attributliste genauso.
        if err.raw_os_error() != Some(1314) || !token.own {
            return Err(err);
        }
        // SAFETY: wie oben, ohne Token-Handle (erbt das eigene Token).
        // aegis-unsafe: winffi-lab-create-process-own
        #[allow(unsafe_code)]
        // Startet die Probe im Labor (eigenes Token, AppContainer) – nur nach Freigabe.
        // aegis-mutation: winffi-lab-create-process-own-call
        #[allow(clippy::disallowed_methods)]
        let ok = unsafe {
            windows_sys::Win32::System::Threading::CreateProcessW(
                application.as_ptr(),
                line.as_mut_ptr(),
                ptr::null(),
                ptr::null(),
                0,
                CREATE_SUSPENDED
                    | CREATE_NEW_CONSOLE
                    | EXTENDED_STARTUPINFO_PRESENT
                    | environment.flags(),
                environment.ptr(),
                dir.as_ptr(),
                &raw const info.StartupInfo,
                &mut process,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    // SAFETY: CreateProcessAsUserW hat beide Handles neu geliefert; je einmal übernommen.
    // aegis-unsafe: winffi-lab-own-handles
    #[allow(unsafe_code)]
    let (process_handle, thread) = unsafe {
        (
            OwnedHandle::from_raw_handle(process.hProcess),
            OwnedHandle::from_raw_handle(process.hThread),
        )
    };
    drop(list);
    // SAFETY: `job` und `process_handle` gültig.
    // aegis-unsafe: winffi-lab-assign-job
    #[allow(unsafe_code)]
    let ok =
        unsafe { AssignProcessToJobObject(job.as_raw_handle(), process_handle.as_raw_handle()) };
    if ok == 0 {
        let err = io::Error::last_os_error();
        // SAFETY: beendet nur den eigenen, angehaltenen (nie gelaufenen) Prozess.
        // aegis-unsafe: winffi-lab-kill-unassigned
        #[allow(unsafe_code)]
        // aegis-mutation: winffi-lab-kill-unassigned-call
        #[allow(clippy::disallowed_methods)]
        let _ = unsafe {
            windows_sys::Win32::System::Threading::TerminateProcess(
                process_handle.as_raw_handle(),
                1,
            )
        };
        return Err(err);
    }
    // SAFETY: angehaltener Hauptthread des eigenen Kindes.
    // aegis-unsafe: winffi-lab-resume
    #[allow(unsafe_code)]
    let resumed = unsafe { ResumeThread(thread.as_raw_handle()) };
    if resumed == u32::MAX {
        return Err(io::Error::last_os_error());
    }
    Ok(LabChild {
        process: process_handle,
        job,
        pid: process.dwProcessId,
    })
}

/// Startet ein festes Systemprogramm (z. B. `WindowsSandbox.exe`) als der Nutzer des Tokens
/// in seiner Sitzung – ohne vererbte Handles. Nur nach Freigabe aufrufen.
///
/// # Errors
/// Start fehlgeschlagen.
pub fn spawn_as_user(token: &UserToken, exe: &Path, argument: &Path) -> io::Result<UserProcess> {
    let environment = token.environment();
    let mut desktop = wide(r"winsta0\default");
    let info = windows_sys::Win32::System::Threading::STARTUPINFOW {
        cb: u32::try_from(size_of::<windows_sys::Win32::System::Threading::STARTUPINFOW>())
            .unwrap_or(0),
        lpDesktop: desktop.as_mut_ptr(),
        ..Default::default()
    };
    let application = wide(exe);
    let mut line: Vec<u16> = Vec::new();
    for part in [exe, argument] {
        if !line.is_empty() {
            line.push(u16::from(b' '));
        }
        line.push(u16::from(b'"'));
        line.extend(part.as_os_str().encode_wide());
        line.push(u16::from(b'"'));
    }
    line.push(0);
    let mut process = PROCESS_INFORMATION::default();
    // SAFETY: Alle Zeiger zeigen auf lebende, nullterminierte Puffer bzw. Strukturen; keine
    // Handles werden vererbt.
    // aegis-unsafe: winffi-spawn-as-user
    #[allow(unsafe_code)]
    // Startet die Windows Sandbox für einen freigegebenen Labor-Lauf als der Nutzer.
    // aegis-mutation: winffi-spawn-as-user-call
    #[allow(clippy::disallowed_methods)]
    let mut ok = unsafe {
        CreateProcessAsUserW(
            token.token.as_raw_handle(),
            application.as_ptr(),
            line.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            0,
            environment.flags(),
            environment.ptr(),
            ptr::null(),
            &raw const info,
            &mut process,
        )
    };
    if ok == 0 {
        let err = io::Error::last_os_error();
        if err.raw_os_error() != Some(1314) || !token.own {
            return Err(err);
        }
        // SAFETY: wie oben, mit dem eigenen Token (Konsole, Tests).
        // aegis-unsafe: winffi-spawn-as-user-own
        #[allow(unsafe_code)]
        // Startet die Windows Sandbox mit dem eigenen Token (ohne SYSTEM) – nur nach Freigabe.
        // aegis-mutation: winffi-spawn-as-user-own-call
        #[allow(clippy::disallowed_methods)]
        let own_ok = unsafe {
            windows_sys::Win32::System::Threading::CreateProcessW(
                application.as_ptr(),
                line.as_mut_ptr(),
                ptr::null(),
                ptr::null(),
                0,
                environment.flags(),
                environment.ptr(),
                ptr::null(),
                &raw const info,
                &mut process,
            )
        };
        ok = own_ok;
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    // SAFETY: beide Handles neu geliefert; je einmal übernommen (Thread sofort geschlossen).
    // aegis-unsafe: winffi-spawn-as-user-handles
    #[allow(unsafe_code)]
    let process_handle = unsafe {
        drop(OwnedHandle::from_raw_handle(process.hThread));
        OwnedHandle::from_raw_handle(process.hProcess)
    };
    Ok(UserProcess {
        process: process_handle,
    })
}

/// Als Nutzer gestartetes Programm (Windows Sandbox): warten und am Ende beenden.
#[derive(Debug)]
pub struct UserProcess {
    process: OwnedHandle,
}

impl UserProcess {
    /// Läuft das Programm noch?
    #[must_use]
    pub fn running(&self) -> bool {
        // SAFETY: gültiges Prozess-Handle.
        // aegis-unsafe: winffi-user-process-wait
        #[allow(unsafe_code)]
        let event = unsafe { WaitForSingleObject(self.process.as_raw_handle(), 0) };
        event == WAIT_TIMEOUT
    }

    /// Beendet das Programm (Ende der Beobachtungszeit; schließt die Windows Sandbox).
    ///
    /// # Errors
    /// Beenden fehlgeschlagen.
    pub fn terminate(&self) -> io::Result<()> {
        if !self.running() {
            return Ok(());
        }
        // SAFETY: gültiges Prozess-Handle des selbst gestarteten Programms.
        // aegis-unsafe: winffi-user-process-terminate
        #[allow(unsafe_code)]
        // Beendet die selbst gestartete Windows Sandbox am Ende der freigegebenen Laufzeit.
        // aegis-mutation: winffi-user-process-terminate-call
        #[allow(clippy::disallowed_methods)]
        let ok = unsafe {
            windows_sys::Win32::System::Threading::TerminateProcess(self.process.as_raw_handle(), 1)
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}
