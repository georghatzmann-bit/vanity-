//! Transport zwischen Oberfläche und Dienst.
//!
//! - **Windows:** Named Pipe `\\.\pipe\aegis-service` mit Zugriffsliste (SYSTEM und
//!   Administratoren voll, angemeldete Nutzer lesen/schreiben), keine Netzwerk-Clients,
//!   erste Instanz exklusiv (verhindert, dass ein anderes Programm den Namen vorher belegt).
//! - **Unix** (nur Entwicklung/Tests): Unix-Socket in einem privaten Ordner.

use std::io::{self, Read, Write};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use aegis_core::audit::Durable;
use aegis_core::consent::Clock;
use aegis_quarantine::UserAccess;

use crate::handler::{Service, examine_as_user, long_paths, scan_as_user};
use crate::protocol::{Request, Response, read_frame, write_frame};

/// Höchstzahl gleichzeitiger Verbindungen.
pub const MAX_CONNECTIONS: usize = 16;
/// Höchstzahl gleichzeitig laufender Scans (lange Läufe blockieren so niemanden ganz).
pub const MAX_PARALLEL_SCANS: usize = 2;

static RUNNING_SCANS: AtomicUsize = AtomicUsize::new(0);
/// Höchstzahl gleichzeitiger Passwort-Ableitungen (Argon2id, je 64 MiB) des Datei-Safes.
pub const MAX_PARALLEL_KDF: usize = 2;
static RUNNING_KDF: AtomicUsize = AtomicUsize::new(0);

/// Zählt eine belegte Stelle, gibt sie beim Verwerfen frei.
#[derive(Debug)]
pub struct Slot(&'static AtomicUsize);

impl Slot {
    /// Belegt eine Stelle, wenn weniger als `max` belegt sind.
    #[must_use]
    pub fn try_take(counter: &'static AtomicUsize, max: usize) -> Option<Self> {
        counter
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < max).then_some(n + 1)
            })
            .ok()
            .map(|_| Self(counter))
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn busy() -> Response {
    Response::error(
        "busy",
        "Es laufen schon zu viele Prüfungen – bitte gleich noch einmal",
    )
}

/// Bedient eine Verbindung, bis die Gegenseite schließt. Scans und die Prüfung für
/// Vorschläge laufen **ohne** Sperre des Dienst-Zustands (und höchstens
/// [`MAX_PARALLEL_SCANS`] gleichzeitig); alles andere unter der Sperre.
///
/// # Errors
/// Ein-/Ausgabefehler der Verbindung.
pub fn serve_connection<C: Clock, W: Durable, S: Read + Write>(
    service: &Mutex<Service<C, W>>,
    stream: &mut S,
    user: &dyn UserAccess,
) -> io::Result<()> {
    // Eine Panik in einer anderen Verbindung soll den Dienst nicht für alle sperren: Der
    // Zustand bleibt konsistent, weil jede Änderung vollständig unter der Sperre geschieht.
    let lock = || -> io::Result<_> {
        Ok(service
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner))
    };
    loop {
        let mut payload = match read_frame(stream) {
            Ok(p) => p,
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(e) => return Err(e),
        };
        let request = serde_json::from_slice::<Request>(&payload);
        // Rahmen sofort überschreiben (kann ein Passwort des Datei-Safes enthalten).
        zeroize::Zeroize::zeroize(&mut payload);
        let response = match request {
            Ok(Request::Scan { paths }) => {
                let (scanner, checked) = {
                    let guard = lock()?;
                    (guard.scanner(), guard.check_paths(&paths))
                };
                match (checked, Slot::try_take(&RUNNING_SCANS, MAX_PARALLEL_SCANS)) {
                    (Err(e), _) => Response::error("input", e),
                    (Ok(()), None) => busy(),
                    (Ok(()), Some(slot)) => {
                        let mut response = scan_as_user(&scanner, &paths, user);
                        drop(slot);
                        let guard = lock()?;
                        guard.mark_trusted_response(&mut response, user.identity().as_deref());
                        guard.record_scan(&response, user);
                        response
                    }
                }
            }
            Ok(Request::ProposeQuarantine { paths }) => {
                let (scanner, checked) = {
                    let guard = lock()?;
                    (guard.scanner(), guard.check_paths(&paths))
                };
                match (checked, Slot::try_take(&RUNNING_SCANS, MAX_PARALLEL_SCANS)) {
                    (Err(e), _) => Response::error("input", e),
                    (Ok(()), None) => busy(),
                    (Ok(()), Some(slot)) => match long_paths(&paths, user)
                        .map(|paths| (examine_as_user(&scanner, &paths, user), paths))
                    {
                        Ok((findings, paths)) => {
                            drop(slot);
                            lock()?.propose_quarantine(&paths, &findings, user.identity())
                        }
                        Err(response) => response,
                    },
                }
            }
            Ok(Request::ProposeLabRun {
                path,
                stage,
                seconds,
                network,
            }) => {
                let paths = [path];
                let (scanner, checked) = {
                    let guard = lock()?;
                    (guard.scanner(), guard.check_paths(&paths))
                };
                match (checked, Slot::try_take(&RUNNING_SCANS, MAX_PARALLEL_SCANS)) {
                    (Err(e), _) => Response::error("input", e),
                    (Ok(()), None) => busy(),
                    (Ok(()), Some(slot)) => match long_paths(&paths, user)
                        .map(|paths| (examine_as_user(&scanner, &paths, user), paths))
                    {
                        Ok((findings, paths)) => {
                            drop(slot);
                            lock()?.propose_lab_run(
                                &paths[0],
                                &findings,
                                &crate::handler::LabOptions {
                                    stage,
                                    seconds,
                                    network,
                                },
                                user.identity(),
                            )
                        }
                        Err(response) => response,
                    },
                }
            }
            // Speicher-Scan außerhalb der Dienst-Sperre (dauert).
            Ok(Request::MemoryScan {}) => {
                let scanner = lock()?.scanner();
                match Slot::try_take(&RUNNING_SCANS, MAX_PARALLEL_SCANS) {
                    None => busy(),
                    Some(slot) => {
                        let mut response = crate::handler::memory_scan(&scanner, user);
                        drop(slot);
                        lock()?.mark_trusted_response(&mut response, user.identity().as_deref());
                        response
                    }
                }
            }
            // Datei-Safe: Passwort-Ableitung (Argon2id) außerhalb der Dienst-Sperre.
            Ok(Request::SafeUnlock { password }) => {
                match Slot::try_take(&RUNNING_KDF, MAX_PARALLEL_KDF) {
                    None => busy(),
                    Some(slot) => {
                        let begun = lock()?.safe_unlock_begin(user);
                        match begun {
                            Err(response) => response,
                            Ok(dir) => {
                                let result =
                                    aegis_quarantine::safe::unlock(user, &dir, password.expose());
                                drop(slot);
                                lock()?.safe_unlock_finish(user, result)
                            }
                        }
                    }
                }
            }
            Ok(Request::ProposeSafeSetup { password }) => {
                match Slot::try_take(&RUNNING_KDF, MAX_PARALLEL_KDF) {
                    None => busy(),
                    Some(slot) => {
                        let begun = lock()?.safe_setup_begin(user);
                        match begun {
                            Err(response) => response,
                            Ok(dir) => {
                                let prepared = aegis_quarantine::safe::prepare(password.expose());
                                drop(slot);
                                lock()?.safe_setup_finish(user, &dir, prepared)
                            }
                        }
                    }
                }
            }
            // Notfall-Scan außerhalb der Dienst-Sperre (dauert).
            Ok(Request::EmergencyScan {}) => {
                let (scanner, note) = {
                    let mut guard = lock()?;
                    (guard.scanner(), guard.request_update())
                };
                match Slot::try_take(&RUNNING_SCANS, MAX_PARALLEL_SCANS) {
                    None => busy(),
                    Some(slot) => {
                        let mut response = crate::emergency::emergency_scan(&scanner, user, note);
                        drop(slot);
                        let guard = lock()?;
                        guard.mark_trusted_response(&mut response, user.identity().as_deref());
                        guard.record_emergency(&response, user);
                        response
                    }
                }
            }
            // Bildschirmfoto außerhalb der Dienst-Sperre lesen (die Datei kann warten lassen).
            Ok(Request::LabScreenshot { run_id, name }) => {
                let lab = lock()?.lab();
                crate::handler::lab_screenshot_response(&lab, user, &run_id, &name)
            }
            Ok(request) => lock()?.handle(request, user),
            Err(e) => Response::error("invalid", format!("Ungültige Anfrage: {e}")),
        };
        let bytes = serde_json::to_vec(&response).map_err(io::Error::other)?;
        write_frame(stream, &bytes)?;
    }
}

/// Client: sendet eine Anfrage (JSON) und liefert die Antwort (JSON).
///
/// # Errors
/// Ein-/Ausgabefehler.
pub fn roundtrip<S: Read + Write>(stream: &mut S, request_json: &[u8]) -> io::Result<Vec<u8>> {
    write_frame(stream, request_json)?;
    read_frame(stream)
}

/// Unix-Socket (Entwicklung und Tests unter Linux).
#[cfg(unix)]
pub mod unix {
    use std::io;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::Path;

    /// Bindet den Socket. Der Ordner muss AEGIS gehören (z. B. Datenordner des Dienstes).
    ///
    /// # Errors
    /// Pfad belegt oder nicht anlegbar.
    pub fn bind(path: &Path) -> io::Result<UnixListener> {
        // Socket-Datei im AEGIS-eigenen Datenordner anlegen (nur Entwicklung unter Linux).
        // aegis-mutation: service-unix-socket-bind
        #[allow(clippy::disallowed_methods)]
        let listener = UnixListener::bind(path);
        listener
    }

    /// Verbindet sich mit dem Dienst.
    ///
    /// # Errors
    /// Dienst nicht erreichbar.
    pub fn connect(path: &Path) -> io::Result<UnixStream> {
        UnixStream::connect(path)
    }
}

/// Named Pipe mit Zugriffsliste (Windows) – FFI liegt in `aegis-winffi`.
#[cfg(windows)]
pub mod windows {
    use std::fs::File;
    use std::io;

    use std::os::windows::fs::OpenOptionsExt;

    use aegis_quarantine::{UserAccess, UserScope};
    pub use aegis_winffi::{
        DATA_DIR_SDDL, PIPE_NAME, PIPE_SDDL, ServerIdentity, accept, client_sid, create_instance,
        create_secure_dir, disconnect, impersonate_client, owner_is_trusted, server_identity,
        thread_is_impersonating,
    };

    /// `SECURITY_IMPERSONATION` (Stufe 2 « 16): Der Dienst darf mit den Rechten des Clients
    /// auf dessen Dateien zugreifen – mehr nicht (keine Delegation ins Netz).
    pub const SECURITY_IMPERSONATION: u32 = 2 << 16;

    /// Verbindet sich als Client mit der Pipe (Identitätswechsel nur auf Stufe
    /// „Impersonation“). Vor dem ersten Senden mit [`server_identity`] prüfen, wer antwortet.
    ///
    /// # Errors
    /// Dienst nicht erreichbar oder Zugriff verweigert.
    pub fn connect(name: &str) -> io::Result<File> {
        // Öffnet die Pipe des Dienstes zum Senden der Anfrage – keine Datei.
        // aegis-mutation: service-pipe-client-open
        #[allow(clippy::disallowed_methods)]
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .security_qos_flags(SECURITY_IMPERSONATION)
            .open(name);
        file
    }

    /// Nutzerdateien mit den Rechten des Pipe-Clients anfassen; Kennung = SID des Clients.
    #[derive(Debug)]
    pub struct PipeClient<'a> {
        pipe: &'a File,
        sid: std::sync::OnceLock<Option<String>>,
        profile: std::sync::OnceLock<Option<std::path::PathBuf>>,
    }

    impl<'a> PipeClient<'a> {
        /// Client einer verbundenen Pipe.
        #[must_use]
        pub fn new(pipe: &'a File) -> Self {
            Self {
                pipe,
                sid: std::sync::OnceLock::new(),
                profile: std::sync::OnceLock::new(),
            }
        }
    }

    impl UserAccess for PipeClient<'_> {
        fn enter(&self) -> io::Result<UserScope> {
            Ok(UserScope::holding(impersonate_client(self.pipe)?))
        }

        fn identity(&self) -> Option<String> {
            // Ohne lesbare SID: eine zufällige Kennung nur für diese Verbindung – sie passt zu
            // keinem gespeicherten Eintrag und wird mit keinem anderen Client geteilt.
            self.sid
                .get_or_init(|| {
                    Some(client_sid(self.pipe).unwrap_or_else(|_| {
                        format!(
                            "unbekannt-{}",
                            aegis_core::uuid::Uuid::new_v4().hyphenated()
                        )
                    }))
                })
                .clone()
        }

        fn is_admin(&self) -> bool {
            aegis_winffi::client_is_admin(self.pipe).unwrap_or(false)
        }

        fn profile(&self) -> Option<std::path::PathBuf> {
            self.profile
                .get_or_init(|| aegis_winffi::client_profile_dir(self.pipe).ok())
                .clone()
        }
    }
}
