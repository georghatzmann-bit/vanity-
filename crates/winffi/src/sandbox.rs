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
use windows_sys::Win32::Security::Isolation::DeriveAppContainerSidFromAppContainerName;
use windows_sys::Win32::Security::{
    DuplicateTokenEx, FreeSid, PSID, SECURITY_CAPABILITIES, SecurityImpersonation,
    TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_SESSIONID, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE,
    TOKEN_QUERY, TokenPrimary,
};
use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;
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
    CREATE_NEW_CONSOLE, CREATE_SUSPENDED, CreateProcessAsUserW, DeleteProcThreadAttributeList,
    EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess, GetCurrentThread, GetExitCodeProcess,
    InitializeProcThreadAttributeList, OpenProcessToken, OpenThreadToken,
    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, PROCESS_INFORMATION, ResumeThread, STARTUPINFOEXW,
    UpdateProcThreadAttribute, WaitForSingleObject,
};

use crate::util::{SecurityDescriptor, own, wide};

/// Name des AppContainers des Labors.
pub const LAB_APPCONTAINER: &str = "AEGIS.Labor";

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

/// Primär-Token des aktuellen Nutzers (während eines Identitätswechsels: des anfragenden
/// Nutzers), **nicht** eingeschränkt – die Einschränkung liefert der AppContainer.
#[derive(Debug)]
pub struct UserToken(OwnedHandle);

const TOKEN_ACCESS: u32 = TOKEN_QUERY
    | TOKEN_DUPLICATE
    | TOKEN_ASSIGN_PRIMARY
    | TOKEN_ADJUST_DEFAULT
    | TOKEN_ADJUST_SESSIONID;

impl UserToken {
    /// Muss innerhalb des Identitätswechsels aufgerufen werden (sonst: eigener Prozess).
    ///
    /// # Errors
    /// Token nicht lesbar.
    pub fn from_current_identity() -> io::Result<Self> {
        let mut source: HANDLE = ptr::null_mut();
        // SAFETY: Pseudo-Handle des Threads; OpenAsSelf = 1; Ausgabezeiger gültig.
        // aegis-unsafe: winffi-lab-thread-token
        #[allow(unsafe_code)]
        let ok = unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_ACCESS, 1, &mut source) };
        if ok == 0 {
            let err = io::Error::last_os_error();
            if err.raw_os_error() != i32::try_from(ERROR_NO_TOKEN).ok() {
                return Err(err);
            }
            // SAFETY: Pseudo-Handle des eigenen Prozesses; Ausgabezeiger gültig.
            // aegis-unsafe: winffi-lab-process-token
            #[allow(unsafe_code)]
            let ok = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_ACCESS, &mut source) };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        let source = own(source)?;
        let mut primary: HANDLE = ptr::null_mut();
        // SAFETY: `source` hat TOKEN_DUPLICATE; Ausgabezeiger gültig.
        // aegis-unsafe: winffi-lab-duplicate-token
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
        Ok(Self(own(primary)?))
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
            token.0.as_raw_handle(),
            application.as_ptr(),
            line.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            0,
            CREATE_SUSPENDED | CREATE_NEW_CONSOLE | EXTENDED_STARTUPINFO_PRESENT,
            ptr::null(),
            dir.as_ptr(),
            &raw const info.StartupInfo,
            &mut process,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
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
