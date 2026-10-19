//! Prüfprozess (`aegis-scanworker`): Fremde Dateien werden **nicht im Dienst** geparst, sondern
//! in einem eigenen Kindprozess – unter Windows mit eingeschränktem Token (abgeleitet vom
//! anfragenden Nutzer), niedriger Integrität und in einem Job-Objekt (Speicher, Prozesszahl,
//! keine UI-Zugriffe). Stürzt ein Parser ab oder hängt er, ist nur dieser Lauf betroffen:
//! Ergebnis „nicht prüfbar“, der Dienst läuft weiter.
//!
//! Protokoll: Anfrage als JSON auf der Standardeingabe ([`WorkerRequest`]), Bericht als JSON
//! ([`ScanReport`]) auf der Standardausgabe.

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use aegis_engine::{Engine, Finding, ScanReport};
use aegis_quarantine::UserAccess;
use serde::{Deserialize, Serialize};

/// Name des Prüfprogramms (ohne Endung).
pub const WORKER_NAME: &str = "aegis-scanworker";
/// Höchstgröße einer Anfrage an den Prüfprozess.
pub const MAX_REQUEST: u64 = 16 * 1024 * 1024;
/// Höchstgröße des Berichts.
pub const MAX_REPORT: u64 = 64 * 1024 * 1024;
/// Zeitlimit für einen Ordner-Scan.
pub const SCAN_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// Zeitlimit für die Prüfung einzelner Dateien (Vorschlag).
pub const EXAMINE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Speichergrenze des Prüfprozesses samt ClamAV.
pub const MEMORY_LIMIT: usize = 2 * 1024 * 1024 * 1024;

/// Anfrage an den Prüfprozess.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerRequest {
    /// Zu prüfende Pfade.
    pub paths: Vec<PathBuf>,
    /// Nur diese Dateien prüfen (kein Ordner-Durchlauf) – für Vorschläge.
    pub files_only: bool,
    /// ClamAV verwenden, falls installiert.
    pub clamav: bool,
    /// Speicherbereiche (Speicher-Scan): statt Pfaden geprüft, nur YARA/EICAR.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub memory: Vec<MemoryBlock>,
    /// Nur die Entropie der Dateianfänge messen (Ransomware-Erkennung): Antwort ist eine
    /// Liste `[Wert | null]` in der Reihenfolge der Pfade.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub entropy: bool,
}

/// Höchstzahl Dateien je Entropie-Anfrage.
pub const MAX_ENTROPY_FILES: usize = 200;

/// Ein gelesener Speicherbereich für den Prüfprozess.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemoryBlock {
    /// Herkunft (Programm, PID, Adresse).
    pub label: String,
    /// Inhalt (Base64).
    pub data: String,
}

/// Höchstgröße der Rohdaten je Anfrage (Base64 vergrößert um 4/3, Rest: Rahmen).
pub const MAX_MEMORY_PER_REQUEST: usize = 10 * 1024 * 1024;

/// Wo geprüft wird.
#[derive(Debug, Clone)]
pub enum Scanner {
    /// Im Dienstprozess (Tests, Entwicklung) – mit Identitätswechsel.
    InProcess(Arc<Engine>),
    /// Im eingeschränkten Prüfprozess (Betrieb).
    Worker {
        /// Pfad zu `aegis-scanworker`.
        exe: PathBuf,
        /// ClamAV verwenden.
        clamav: bool,
    },
}

impl Scanner {
    /// Sucht `aegis-scanworker` neben dem laufenden Programm (bzw. einen Ordner darüber,
    /// wie bei `cargo test`).
    #[must_use]
    pub fn locate_worker() -> Option<PathBuf> {
        let exe = std::env::current_exe().ok()?;
        let name = format!("{WORKER_NAME}{}", std::env::consts::EXE_SUFFIX);
        let dir = exe.parent()?;
        [dir.join(&name), dir.parent()?.join(&name)]
            .into_iter()
            .find(|p| p.is_file())
    }

    /// Prüft Dateien und Ordner.
    ///
    /// # Errors
    /// Prüfprozess nicht startbar, abgestürzt, Zeitlimit oder ungültiger Bericht.
    pub fn scan(&self, paths: &[PathBuf], user: &dyn UserAccess) -> Result<ScanReport, String> {
        match self {
            Self::InProcess(engine) => {
                let _scope = user.enter().map_err(identity)?;
                Ok(engine.scan_paths(paths))
            }
            Self::Worker { exe, clamav } => run(
                exe,
                &WorkerRequest {
                    paths: paths.to_vec(),
                    files_only: false,
                    clamav: *clamav,
                    memory: Vec::new(),
                    entropy: false,
                },
                user,
                SCAN_TIMEOUT,
            ),
        }
    }

    /// Prüft einzelne Dateien (für einen Vorschlag).
    ///
    /// # Errors
    /// Wie [`Scanner::scan`].
    pub fn examine(
        &self,
        paths: &[PathBuf],
        user: &dyn UserAccess,
    ) -> Result<Vec<Finding>, String> {
        match self {
            Self::InProcess(engine) => {
                let _scope = user.enter().map_err(identity)?;
                Ok(paths.iter().map(|p| engine.scan_file(p)).collect())
            }
            Self::Worker { exe, clamav } => run(
                exe,
                &WorkerRequest {
                    paths: paths.to_vec(),
                    files_only: true,
                    clamav: *clamav,
                    memory: Vec::new(),
                    entropy: false,
                },
                user,
                EXAMINE_TIMEOUT,
            )
            .map(|r| r.findings),
        }
    }
}

impl Scanner {
    /// Prüft gelesene Speicherbereiche (nur YARA/EICAR) – im Prüfprozess, nie im Dienst.
    ///
    /// # Errors
    /// Wie [`Scanner::scan`].
    /// Entropie der Dateianfänge (nur lesen) – mit den Rechten von `user`, im Prüfprozess.
    ///
    /// # Errors
    /// Prüfprozess nicht startbar, abgestürzt oder Antwort unlesbar.
    pub fn entropy(
        &self,
        paths: &[PathBuf],
        user: &dyn UserAccess,
    ) -> Result<Vec<Option<f64>>, String> {
        let paths = &paths[..paths.len().min(MAX_ENTROPY_FILES)];
        match self {
            Self::InProcess(_) => {
                let _scope = user.enter().map_err(identity)?;
                Ok(paths
                    .iter()
                    .map(|p| aegis_engine::entropy::sample_file(p))
                    .collect())
            }
            Self::Worker { exe, .. } => {
                let raw = run_raw(
                    exe,
                    &WorkerRequest {
                        paths: paths.to_vec(),
                        files_only: true,
                        clamav: false,
                        memory: Vec::new(),
                        entropy: true,
                    },
                    user,
                    EXAMINE_TIMEOUT,
                )?;
                let values: Vec<Option<f64>> =
                    serde_json::from_slice(&raw).map_err(|e| format!("Antwort unlesbar: {e}"))?;
                if values.len() != paths.len() {
                    return Err("Antwort passt nicht zur Anfrage".into());
                }
                Ok(values)
            }
        }
    }

    pub fn scan_memory(
        &self,
        blocks: Vec<MemoryBlock>,
        user: &dyn UserAccess,
    ) -> Result<Vec<Finding>, String> {
        use base64::Engine as _;
        match self {
            Self::InProcess(engine) => Ok(blocks
                .iter()
                .map(|b| {
                    let data = base64::engine::general_purpose::STANDARD
                        .decode(&b.data)
                        .unwrap_or_default();
                    engine.scan_memory(&b.label, &data)
                })
                .collect()),
            Self::Worker { exe, .. } => run(
                exe,
                &WorkerRequest {
                    paths: Vec::new(),
                    files_only: true,
                    clamav: false,
                    memory: blocks,
                    entropy: false,
                },
                user,
                EXAMINE_TIMEOUT,
            )
            .map(|r| r.findings),
        }
    }
}

/// Identität für Prüfungen **ohne** anfragenden Nutzer (Wächter, geplante Scans): Rechte
/// des Profil-Besitzers, wenn er angemeldet ist, sonst ein „nur Nutzer“-Token. Der Dienst
/// liest fremde Dateien so nie mit seinen eigenen (SYSTEM-)Rechten – ein Link in einem
/// Nutzerordner führt nicht zu Dateien, die dieser Nutzer nicht lesen darf.
#[derive(Debug, Clone, Default)]
pub struct BackgroundAccess {
    /// Profilordner, zu dem die Dateien gehören (`None` = gemeinsamer Ort).
    pub profile: Option<PathBuf>,
    /// Nur mit den Rechten des Profil-Besitzers prüfen (geplante Scans): Ist er nicht
    /// angemeldet, wird nicht geprüft statt mit einem schwächeren Konto „nichts“ zu finden.
    pub require_owner: bool,
}

impl UserAccess for BackgroundAccess {
    fn enter(&self) -> io::Result<aegis_quarantine::UserScope> {
        #[cfg(windows)]
        {
            let guard = match (&self.profile, self.require_owner) {
                (Some(profile), true) => aegis_winffi::impersonate_profile_owner(profile)?,
                (profile, _) => aegis_winffi::impersonate_for_background(profile.as_deref())?,
            };
            Ok(aegis_quarantine::UserScope::holding(guard))
        }
        #[cfg(not(windows))]
        {
            // Unix (nur Entwicklung): der Dienst läuft dort als normaler Nutzer.
            Ok(aegis_quarantine::UserScope::unchanged())
        }
    }
}

fn identity(e: io::Error) -> String {
    format!("Rechte des Nutzers nicht übernehmbar ({e}) – nichts geprüft")
}

/// Laufender Prüfprozess, plattformunabhängig.
trait Child {
    fn take_stdin(&mut self) -> Option<Box<dyn Write + Send>>;
    fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>>;
    fn wait_timeout(&mut self, timeout: Duration) -> io::Result<Option<i64>>;
    fn kill(&mut self);
}

fn run(
    exe: &Path,
    request: &WorkerRequest,
    user: &dyn UserAccess,
    timeout: Duration,
) -> Result<ScanReport, String> {
    let output = run_raw(exe, request, user, timeout)?;
    serde_json::from_slice(&output)
        .map_err(|e| format!("Ungültiger Bericht des Prüfprozesses: {e}"))
}

/// Startet den Prüfprozess und liefert seine Ausgabe (höchstens [`MAX_REPORT`] Byte).
fn run_raw(
    exe: &Path,
    request: &WorkerRequest,
    user: &dyn UserAccess,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    let body = serde_json::to_vec(request).map_err(|e| e.to_string())?;
    let mut child = spawn(exe, user).map_err(|e| format!("Prüfprozess nicht startbar: {e}"))?;
    let stdin = child.take_stdin();
    let writer = std::thread::spawn(move || {
        if let Some(mut stdin) = stdin {
            let _ = stdin.write_all(&body);
        }
    });
    let stdout = child.take_stdout();
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        if let Some(stdout) = stdout {
            let _ = stdout.take(MAX_REPORT + 1).read_to_end(&mut out);
        }
        out
    });
    let status = child.wait_timeout(timeout);
    let status = match status {
        Ok(Some(code)) => code,
        Ok(None) => {
            child.kill();
            return Err(format!(
                "Prüfprozess hat das Zeitlimit ({} min) überschritten und wurde beendet – nicht prüfbar",
                timeout.as_secs() / 60
            ));
        }
        Err(e) => {
            child.kill();
            return Err(format!("Prüfprozess: {e}"));
        }
    };
    let _ = writer.join();
    let output = reader.join().unwrap_or_default();
    if status != 0 {
        return Err(format!(
            "Prüfprozess ist abgebrochen (Code {status}) – Datei möglicherweise beschädigt oder bösartig aufgebaut; nicht prüfbar"
        ));
    }
    if output.len() as u64 > MAX_REPORT {
        return Err("Bericht des Prüfprozesses zu groß".into());
    }
    Ok(output)
}

#[cfg(windows)]
fn spawn(exe: &Path, user: &dyn UserAccess) -> io::Result<Box<dyn Child>> {
    use aegis_winffi::{JobLimits, RestrictedChild, RestrictedToken, spawn_restricted};

    struct Win(RestrictedChild);
    impl Child for Win {
        fn take_stdin(&mut self) -> Option<Box<dyn Write + Send>> {
            self.0
                .stdin
                .take()
                .map(|f| Box::new(f) as Box<dyn Write + Send>)
        }
        fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
            self.0
                .stdout
                .take()
                .map(|f| Box::new(f) as Box<dyn Read + Send>)
        }
        fn wait_timeout(&mut self, timeout: Duration) -> io::Result<Option<i64>> {
            Ok(self.0.wait_timeout(timeout)?.map(i64::from))
        }
        fn kill(&mut self) {
            let _ = self.0.terminate();
        }
    }

    let limits = JobLimits {
        memory_bytes: MEMORY_LIMIT,
        processes: 2,
    };
    // Token mit den Rechten des Nutzers ableiten – nur während des Identitätswechsels.
    let token = {
        let _scope = user.enter()?;
        RestrictedToken::from_current_identity()?
    };
    match spawn_restricted(&token, exe, &[], limits) {
        Ok(child) => Ok(Box::new(Win(child))),
        // Konsolenbetrieb ohne SYSTEM (Entwicklung, CI): Ein fremdes Token darf nur der
        // Dienst zuweisen – dann das eigene, eingeschränkte Token verwenden. Als Dienst
        // (SYSTEM) nie: Das wäre das Token des Dienstes selbst.
        Err(e)
            if e.raw_os_error() == Some(1314)
                && !aegis_winffi::pipe::current_process_is_system().unwrap_or(true) =>
        {
            let own = RestrictedToken::from_current_identity()?;
            Ok(Box::new(Win(spawn_restricted(&own, exe, &[], limits)?)))
        }
        Err(e) => Err(e),
    }
}

#[cfg(unix)]
fn spawn(exe: &Path, user: &dyn UserAccess) -> io::Result<Box<dyn Child>> {
    use std::process::{Command, Stdio};

    struct Unix(std::process::Child);
    impl Child for Unix {
        fn take_stdin(&mut self) -> Option<Box<dyn Write + Send>> {
            self.0
                .stdin
                .take()
                .map(|f| Box::new(f) as Box<dyn Write + Send>)
        }
        fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
            self.0
                .stdout
                .take()
                .map(|f| Box::new(f) as Box<dyn Read + Send>)
        }
        fn wait_timeout(&mut self, timeout: Duration) -> io::Result<Option<i64>> {
            let deadline = std::time::Instant::now() + timeout;
            loop {
                if let Some(status) = self.0.try_wait()? {
                    return Ok(Some(status.code().map_or(-1, i64::from)));
                }
                if std::time::Instant::now() >= deadline {
                    return Ok(None);
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        fn kill(&mut self) {
            // Eigenen, hängenden Prüfprozess beenden (Zeitlimit) – kein Nutzerprozess.
            // aegis-mutation: service-worker-kill
            #[allow(clippy::disallowed_methods)]
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    let _scope = user.enter()?;
    // Startet den eigenen Prüfprozess (festes Programm, keine Argumente); unter Unix nur
    // Entwicklung – ohne Token-Einschränkung.
    // aegis-mutation: service-worker-spawn
    #[allow(clippy::disallowed_methods)]
    let child = Command::new(exe)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(Box::new(Unix(child)))
}
