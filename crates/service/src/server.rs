//! Start des Dienstes: Datenordner, Prüfprotokoll, Engine, Tresor, Freigabe-Tor, Transport.

use std::fs::File;
use std::io::{self, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use aegis_core::audit::{AuditLog, Durable, verify_prefix};
use aegis_core::consent::{ConsentConfig, ConsentGate, SystemClock};
use aegis_engine::clamav::ClamAv;
use aegis_engine::yara::YaraRules;
use aegis_engine::{Engine, EngineConfig};
use aegis_quarantine::Vault;

#[cfg(unix)]
use aegis_quarantine::OwnProcess;

use crate::handler::Service;
use crate::transport::{MAX_CONNECTIONS, Slot};

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
    // Jeder Ordner wird mit seiner Zugriffsliste angelegt bzw. – falls vorhanden – auf
    // Besitzer und Links geprüft (ein vorab von einem Nutzer angelegter Ordner wird abgelehnt).
    secure_dir(data_dir)?;
    let audit_dir = data_dir.join("audit");
    secure_dir(&audit_dir)?;
    secure_dir(&data_dir.join("quarantine"))?;
    let audit_path = audit_dir.join("audit.jsonl");
    let audit = open_audit(&audit_path)?;

    let vault = Vault::open(&data_dir.join("quarantine")).map_err(io::Error::other)?;
    let engine = Engine::new(EngineConfig {
        yara: Some(YaraRules::builtin().map_err(io::Error::other)?),
        clamav: ClamAv::locate(),
        ..EngineConfig::default()
    });
    let gate = ConsentGate::new(ConsentConfig::default()).map_err(io::Error::other)?;
    Ok(Service::new(engine, vault, gate, audit).with_protected(vec![data_dir.to_owned()]))
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

static CONNECTIONS: AtomicUsize = AtomicUsize::new(0);

/// Bedient den Endpunkt mit einem vorhandenen Dienst-Zustand. Fehler einzelner Verbindungen
/// (z. B. sofort wieder getrennte Clients) beenden den Dienst nicht.
///
/// # Errors
/// Endpunkt belegt oder nicht anlegbar.
#[cfg(windows)]
pub fn serve<W: Durable + Send + 'static>(
    endpoint: &str,
    service: &Arc<Mutex<Service<SystemClock, W>>>,
    stop: &Arc<AtomicBool>,
) -> io::Result<()> {
    use crate::transport::windows::{PipeClient, accept, create_instance};
    // Die erste Instanz muss exklusiv gelingen – sonst hat jemand den Namen besetzt.
    let mut instance = Some(create_instance(endpoint, true)?);
    while !stop.load(Ordering::SeqCst) {
        let current = match instance.take() {
            Some(i) => i,
            None => match create_instance(endpoint, false) {
                Ok(i) => i,
                Err(_) => {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    continue;
                }
            },
        };
        let Ok(connection) = accept(current) else {
            continue;
        };
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let Some(slot) = Slot::try_take(&CONNECTIONS, MAX_CONNECTIONS) else {
            continue; // Verbindung wird sofort wieder geschlossen.
        };
        let service = Arc::clone(service);
        std::thread::spawn(move || {
            let _slot = slot;
            let mut stream = &connection;
            let _ =
                crate::transport::serve_connection(&service, &mut stream, &PipeClient(&connection));
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
    W: Durable + Send + 'static,
{
    let listener = crate::transport::unix::bind(Path::new(endpoint))?;
    for stream in listener.incoming() {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let Ok(mut stream) = stream else { continue };
        let Some(slot) = Slot::try_take(&CONNECTIONS, MAX_CONNECTIONS) else {
            continue;
        };
        let service = Arc::clone(service);
        std::thread::spawn(move || {
            let _slot = slot;
            // Entwicklung unter Linux: Socket nur für den Eigentümer (Ordner 0700), daher
            // ohne Identitätswechsel.
            let _ = crate::transport::serve_connection(&service, &mut stream, &OwnProcess);
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Verändernde Aufrufe – nur AEGIS-eigene Daten, jeweils markiert.
// ---------------------------------------------------------------------------------------

/// Windows: mit Zugriffsliste anlegen bzw. Besitzer/Links prüfen (`aegis-winffi`).
#[cfg(windows)]
fn secure_dir(dir: &Path) -> io::Result<()> {
    crate::transport::windows::create_secure_dir(dir)
}

/// Unix (Entwicklung): Ordner nur für den Eigentümer; vorhandene Ordner müssen echte
/// Ordner des eigenen Kontos sein.
#[cfg(unix)]
fn secure_dir(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true).mode(0o700);
    // AEGIS-eigener Datenordner des Dienstes (Tresor, Prüfprotokoll).
    // aegis-mutation: service-create-data-dir
    #[allow(clippy::disallowed_methods)]
    builder.create(dir)?;
    let meta = std::fs::symlink_metadata(dir)?;
    let own_uid = std::fs::metadata("/proc/self").map(|m| m.uid()).ok();
    if !meta.file_type().is_dir() || own_uid.is_some_and(|uid| uid != meta.uid()) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "{} ist kein Ordner dieses Kontos (Link oder fremder Besitzer) – Dienst startet nicht",
                dir.display()
            ),
        ));
    }
    if meta.permissions().mode() & 0o077 != 0 {
        // Eigenen Datenordner auf „nur Eigentümer“ beschränken.
        // aegis-mutation: service-data-dir-private
        #[allow(clippy::disallowed_methods)]
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
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
