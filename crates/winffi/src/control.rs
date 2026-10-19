//! Prozesse beenden, anhalten, fortsetzen – **nur** nach Freigabe (der Dienst ruft das mit
//! einer `ExecutionPermit` und im Identitätswechsel auf: Windows prüft dann selbst, ob der Nutzer
//! diesen Prozess beenden darf). Vorher wird geprüft, dass die Prozess-ID noch zum Programm aus
//! dem Plan gehört (wiederverwendete IDs) und dass es kein kritischer Systemprozess ist.

use std::io;
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::path::Path;

use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows_sys::Win32::System::Threading::{
    GetProcessIdOfThread, IsProcessCritical, OpenProcess, OpenThread,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SUSPEND_RESUME, PROCESS_TERMINATE, ResumeThread,
    SuspendThread, THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
};

/// Wie oft „Anhalten“ nach neu entstandenen Threads sucht.
const SUSPEND_ROUNDS: usize = 5;

use crate::util::own;

/// Was mit dem Prozess geschehen soll.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessAction {
    /// Beenden.
    Terminate,
    /// Anhalten (alle Threads).
    Suspend,
    /// Fortsetzen.
    Resume,
}

/// Prozess öffnen und prüfen: Programm wie im Plan, nicht kritisch, nicht AEGIS selbst.
fn open_checked(pid: u32, expected_image: &Path, access: u32) -> io::Result<OwnedHandle> {
    if pid == 0 || pid == 4 || pid == std::process::id() {
        return Err(io::Error::other("Dieser Prozess ist geschützt"));
    }
    // SAFETY: OpenProcess mit festen Rechten; das Handle wird sofort übernommen.
    // aegis-unsafe: winffi-control-open-process
    #[allow(unsafe_code)]
    let process = own(unsafe { OpenProcess(access | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })?;
    let actual = crate::system::process_image_path(pid)?;
    let same = crate::fs::ordinal_eq_ignore_case(
        &actual.to_string_lossy(),
        &expected_image.to_string_lossy(),
    );
    if !same {
        return Err(io::Error::other(
            "Die Prozess-ID gehört inzwischen zu einem anderen Programm – nichts getan",
        ));
    }
    let mut critical = 0;
    // SAFETY: gültiges Handle mit Abfrage-Recht; Ausgabezeiger gültig.
    // aegis-unsafe: winffi-control-critical
    #[allow(unsafe_code)]
    let ok = unsafe { IsProcessCritical(process.as_raw_handle(), &mut critical) };
    if ok == 0 || critical != 0 {
        return Err(io::Error::other(
            "Kritischer Systemprozess – AEGIS beendet oder hält ihn nicht an",
        ));
    }
    Ok(process)
}

/// Führt die Aktion aus. Im Identitätswechsel des Nutzers aufrufen.
///
/// # Errors
/// Kein Zugriff, Prozess beendet/ausgetauscht, kritisch oder Aktion fehlgeschlagen.
pub fn control_process(pid: u32, expected_image: &Path, action: ProcessAction) -> io::Result<()> {
    match action {
        ProcessAction::Terminate => {
            let process = open_checked(pid, expected_image, PROCESS_TERMINATE)?;
            // SAFETY: gültiges Handle mit PROCESS_TERMINATE.
            // aegis-unsafe: winffi-control-terminate
            #[allow(unsafe_code)]
            // Beendet den Prozess aus dem freigegebenen Plan „Prozess beenden“.
            // aegis-mutation: winffi-control-terminate-call
            #[allow(clippy::disallowed_methods)]
            let ok = unsafe {
                windows_sys::Win32::System::Threading::TerminateProcess(process.as_raw_handle(), 1)
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
        ProcessAction::Suspend | ProcessAction::Resume => {
            // Rechte am Prozess prüfen; das offene Handle hält die Prozess-ID fest.
            let _process = open_checked(pid, expected_image, PROCESS_SUSPEND_RESUME)?;
            let suspend = action == ProcessAction::Suspend;
            let mut handled: Vec<u32> = Vec::new();
            let mut done = 0usize;
            // Anhalten: mehrere Runden, damit auch zwischenzeitlich gestartete Threads
            // erfasst werden. Fortsetzen: eine Runde genügt.
            let rounds = if suspend { SUSPEND_ROUNDS } else { 1 };
            let mut settled = false;
            for _ in 0..rounds {
                let fresh: Vec<u32> = threads_of(pid)?
                    .into_iter()
                    .filter(|t| !handled.contains(t))
                    .collect();
                if fresh.is_empty() {
                    settled = true;
                    break;
                }
                for tid in fresh {
                    handled.push(tid);
                    if thread_action(pid, tid, suspend) {
                        done += 1;
                    }
                }
            }
            if done == 0 {
                return Err(io::Error::other("Kein Thread erreichbar"));
            }
            if suspend && !settled && threads_of(pid)?.iter().any(|t| !handled.contains(t)) {
                return Err(io::Error::other(
                    "Das Programm startet laufend neue Threads – nur teilweise angehalten",
                ));
            }
            Ok(())
        }
    }
}

/// Hält einen Thread an bzw. setzt ihn fort – nur, wenn er (noch) zum Prozess gehört
/// (Thread-IDs werden wiederverwendet).
fn thread_action(pid: u32, tid: u32, suspend: bool) -> bool {
    // SAFETY: OpenThread mit festen Rechten; Handle sofort übernommen.
    // aegis-unsafe: winffi-control-open-thread
    #[allow(unsafe_code)]
    let Ok(thread) = own(unsafe {
        OpenThread(
            THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
            0,
            tid,
        )
    }) else {
        return false;
    };
    // SAFETY: gültiges Thread-Handle mit Abfrage-Recht.
    // aegis-unsafe: winffi-control-thread-owner
    #[allow(unsafe_code)]
    let owner = unsafe { GetProcessIdOfThread(thread.as_raw_handle()) };
    if owner != pid {
        return false;
    }
    let result = if suspend {
        // SAFETY: gültiges Thread-Handle mit THREAD_SUSPEND_RESUME.
        // aegis-unsafe: winffi-control-suspend
        #[allow(unsafe_code)]
        // Hält einen Thread des Prozesses aus dem freigegebenen Plan an.
        // aegis-mutation: winffi-control-suspend-call
        #[allow(clippy::disallowed_methods)]
        let r = unsafe { SuspendThread(thread.as_raw_handle()) };
        r
    } else {
        // SAFETY: gültiges Thread-Handle mit THREAD_SUSPEND_RESUME.
        // aegis-unsafe: winffi-control-resume
        #[allow(unsafe_code)]
        let r = unsafe { ResumeThread(thread.as_raw_handle()) };
        r
    };
    result != u32::MAX
}

/// Threads eines Prozesses.
fn threads_of(pid: u32) -> io::Result<Vec<u32>> {
    // SAFETY: Schnappschuss der Threads; Handle sofort übernommen.
    // aegis-unsafe: winffi-control-thread-snapshot
    #[allow(unsafe_code)]
    let snapshot = own(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) })?;
    let mut entry = THREADENTRY32 {
        dwSize: u32::try_from(size_of::<THREADENTRY32>()).unwrap_or(0),
        ..Default::default()
    };
    let mut out = Vec::new();
    // SAFETY: gültiger Schnappschuss; `entry` mit gesetzter Größe.
    // aegis-unsafe: winffi-control-thread-first
    #[allow(unsafe_code)]
    let mut ok = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
    while ok != 0 && out.len() < 10_000 {
        if entry.th32OwnerProcessID == pid {
            out.push(entry.th32ThreadID);
        }
        // SAFETY: wie oben.
        // aegis-unsafe: winffi-control-thread-next
        #[allow(unsafe_code)]
        let next = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
        ok = next;
    }
    Ok(out)
}
