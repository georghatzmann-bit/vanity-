//! Start des Dienstes: Datenordner, Prüfprotokoll, Engine, Tresor, Freigabe-Tor, Transport.

use std::fs::File;
use std::io::{self, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use aegis_core::audit::{AuditLog, verify_prefix};
use aegis_core::consent::{ConsentConfig, ConsentGate, SystemClock};
use aegis_engine::clamav::ClamAv;
use aegis_engine::yara::YaraRules;
use aegis_engine::{Engine, EngineConfig};
use aegis_quarantine::Vault;

use crate::handler::Service;

/// Dienst mit Systemuhr und Prüfprotokoll-Datei.
pub type LiveService = Service<SystemClock, File>;

/// Einstellungen für den Start.
#[derive(Debug, Clone)]
pub struct ServerConfig {
    /// AEGIS-Datenordner (Tresor, Schlüssel, Prüfprotokoll).
    pub data_dir: PathBuf,
    /// Endpunkt: Pipe-Name (Windows) bzw. Socket-Pfad (Unix).
    pub endpoint: String,
}

impl ServerConfig {
    /// Standardwerte: `%ProgramData%\AEGIS` und `\\.\pipe\aegis-service` unter Windows;
    /// `$XDG_STATE_HOME/aegis-service` (bzw. `~/.local/state/aegis-service`) und ein Socket
    /// darin unter Unix.
    #[must_use]
    pub fn default_for_platform() -> Option<Self> {
        #[cfg(windows)]
        {
            let base = std::env::var_os("ProgramData")
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())?;
            Some(Self {
                data_dir: base.join("AEGIS"),
                endpoint: crate::transport::windows::PIPE_NAME.to_owned(),
            })
        }
        #[cfg(not(windows))]
        {
            let state = std::env::var_os("XDG_STATE_HOME")
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
                .or_else(|| {
                    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/state"))
                })?;
            let data_dir = state.join("aegis-service");
            let endpoint = data_dir.join("aegis.sock").to_string_lossy().into_owned();
            Some(Self { data_dir, endpoint })
        }
    }
}

/// Baut den Dienst-Zustand auf.
///
/// # Errors
/// Datenordner nicht anlegbar/absicherbar, Prüfprotokoll beschädigt, Regeln fehlerhaft.
pub fn build_service(data_dir: &Path) -> io::Result<LiveService> {
    create_data_dir(data_dir)?;
    #[cfg(windows)]
    crate::transport::windows::secure_data_dir(data_dir)?;

    let audit_dir = data_dir.join("audit");
    create_data_dir(&audit_dir)?;
    let audit_path = audit_dir.join("audit.jsonl");
    let audit = open_audit(&audit_path)?;

    let vault = Vault::open(&data_dir.join("quarantine")).map_err(io::Error::other)?;
    let engine = Engine::new(EngineConfig {
        yara: Some(YaraRules::builtin().map_err(io::Error::other)?),
        clamav: ClamAv::locate(),
        ..EngineConfig::default()
    });
    let gate = ConsentGate::new(ConsentConfig::default()).map_err(io::Error::other)?;
    Ok(Service::new(engine, vault, gate, audit))
}

fn open_audit(path: &Path) -> io::Result<AuditLog<File>> {
    match File::open(path) {
        Ok(file) => {
            let prefix = verify_prefix(BufReader::new(file), None).map_err(|e| {
                io::Error::other(format!(
                    "Prüfprotokoll {} ist beschädigt oder manipuliert ({e}) – der Dienst startet nicht, damit nichts ungeprotokolliert geschieht",
                    path.display()
                ))
            })?;
            if prefix.torn_tail_len() > 0 {
                // Nur eine unvollständige letzte Zeile (Absturz beim Schreiben) wird abgeschnitten.
                truncate_torn_tail(path, prefix.valid_len())?;
            }
            Ok(AuditLog::resume(open_audit_append(path)?, prefix.report()))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            Ok(AuditLog::new(open_audit_append(path)?))
        }
        Err(e) => Err(e),
    }
}

/// Startet den Dienst und bedient Verbindungen, bis `stop` gesetzt wird.
///
/// # Errors
/// Start fehlgeschlagen (Endpunkt belegt, Daten nicht lesbar …).
pub fn run(config: &ServerConfig, stop: &Arc<AtomicBool>) -> io::Result<()> {
    let service = Arc::new(Mutex::new(build_service(&config.data_dir)?));
    serve(&config.endpoint, &service, stop)
}

/// Bedient den Endpunkt mit einem vorhandenen Dienst-Zustand.
///
/// # Errors
/// Endpunkt belegt oder nicht anlegbar.
#[cfg(windows)]
pub fn serve<W: io::Write + Send + 'static>(
    endpoint: &str,
    service: &Arc<Mutex<Service<SystemClock, W>>>,
    stop: &Arc<AtomicBool>,
) -> io::Result<()> {
    use crate::transport::windows::{accept, create_instance};
    let mut first = true;
    while !stop.load(Ordering::SeqCst) {
        let instance = create_instance(endpoint, first)?;
        first = false;
        let mut connection = accept(instance)?;
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let service = Arc::clone(service);
        std::thread::spawn(move || {
            let _ = crate::transport::serve_connection(&service, &mut connection);
        });
    }
    Ok(())
}

/// Bedient den Endpunkt mit einem vorhandenen Dienst-Zustand.
///
/// # Errors
/// Endpunkt belegt oder nicht anlegbar.
#[cfg(unix)]
pub fn serve<C, W>(
    endpoint: &str,
    service: &Arc<Mutex<Service<C, W>>>,
    stop: &Arc<AtomicBool>,
) -> io::Result<()>
where
    C: aegis_core::consent::Clock + Send + 'static,
    W: io::Write + Send + 'static,
{
    let listener = crate::transport::unix::bind(Path::new(endpoint))?;
    for stream in listener.incoming() {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let Ok(mut stream) = stream else { continue };
        let service = Arc::clone(service);
        std::thread::spawn(move || {
            let _ = crate::transport::serve_connection(&service, &mut stream);
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Verändernde Aufrufe – nur AEGIS-eigene Daten, jeweils markiert.
// ---------------------------------------------------------------------------------------

fn create_data_dir(dir: &Path) -> io::Result<()> {
    // AEGIS-eigener Datenordner des Dienstes (Tresor, Prüfprotokoll).
    // aegis-mutation: service-create-data-dir
    #[allow(clippy::disallowed_methods)]
    std::fs::create_dir_all(dir)
}

fn open_audit_append(path: &Path) -> io::Result<File> {
    // Prüfprotokoll nur anhängen (append), nie überschreiben.
    // aegis-mutation: service-audit-append
    #[allow(clippy::disallowed_methods)]
    let file = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(path);
    file
}

fn truncate_torn_tail(path: &Path, valid_len: u64) -> io::Result<()> {
    // Entfernt nur eine unvollständige letzte Zeile des eigenen Prüfprotokolls (Absturz
    // während des Schreibens); alle geprüften Einträge bleiben.
    // aegis-mutation: service-audit-truncate-torn-tail
    #[allow(clippy::disallowed_methods)]
    let file = std::fs::OpenOptions::new().write(true).open(path)?;
    // aegis-mutation: service-audit-truncate-set-len
    #[allow(clippy::disallowed_methods)]
    let result = file.set_len(valid_len);
    result
}
