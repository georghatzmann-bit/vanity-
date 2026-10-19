//! Start des Dienstes: Datenordner, Prüfprotokoll, Engine, Tresor, Freigabe-Tor, Transport.

use std::fs::File;
use std::io::{self, BufReader};
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::sync::atomic::AtomicU64;
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
use crate::trust::TrustStore;
use crate::worker::{Scanner, WORKER_NAME};

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

/// Unterordner des Labors im Datenordner. Seine Lauf-Ordner enthalten auch Dateien, die die
/// Probe bzw. die Windows Sandbox geschrieben hat – die Besitzerprüfung beim Start steigt
/// deshalb nicht hinein (der Ordner selbst wird geprüft, sein Inhalt verworfen).
const LAB_DIR: &str = "labor";
/// Ordner der Rückfall-Kopien im Datenordner.
const BACKUP_DIR: &str = "rueckfall";

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
    // Labor: eigener Ordner; Reste früherer Läufe (auch vom Nutzer/Labor geschriebene Berichte)
    // werden beim Start verworfen.
    let lab_dir = data_dir.join(LAB_DIR);
    secure_lab_dir(&lab_dir)?;
    crate::lab::cleanup_stale(&lab_dir);
    let audit_path = audit_dir.join("audit.jsonl");
    let audit = open_audit(&audit_path)?;

    let vault = Vault::open(&data_dir.join("quarantine")).map_err(io::Error::other)?;
    if let Some(warning) = vault.warning() {
        eprintln!("AEGIS-Dienst: {warning}");
    }
    // Fremde Dateien parst nur der eingeschränkte Prüfprozess – ohne ihn startet der Dienst
    // nicht (kein stiller Rückfall auf das Parsen im Dienst).
    let worker = Scanner::locate_worker().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            format!("Prüfprogramm {WORKER_NAME} fehlt neben dem Dienst – Installation reparieren"),
        )
    })?;
    // Die eingebauten Regeln werden schon hier geprüft (Fehler beim Start statt beim Scan).
    let engine = Engine::new(EngineConfig {
        yara: Some(YaraRules::builtin().map_err(io::Error::other)?),
        ..EngineConfig::default()
    });
    let gate = ConsentGate::new(ConsentConfig::default()).map_err(io::Error::other)?;
    let trust = TrustStore::open(&data_dir.join("trust.json"))?;
    let history = crate::history::History::open(&data_dir.join("history.json"))?;
    let settings = crate::schedule::SettingsStore::open(&data_dir.join("settings.json"))?;
    let backup_dir = data_dir.join(BACKUP_DIR);
    secure_lab_dir(&backup_dir)?;
    let backup =
        aegis_quarantine::backup::BackupStore::open(&backup_dir).map_err(io::Error::other)?;
    let service = Service::new(engine, vault, gate, audit)
        .with_protected(vec![data_dir.to_owned()])
        .with_backup(Arc::new(backup), backup_dir)
        .with_trust(trust)
        .with_history(history)
        .with_settings(settings)
        .with_lab(crate::lab::Lab::new(Some(lab_dir)));
    service.watch().attach_history(service.history());
    service.sync_baits();
    Ok(service.with_scanner(Scanner::Worker {
        exe: worker,
        clamav: ClamAv::locate().is_some(),
    }))
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
    let service = build_service(&config.data_dir)?;
    // Echtzeit-Wächter: meldet nur (Prüfung im eingeschränkten Prüfprozess); der eigene
    // Datenordner wird nie geprüft. Startet er nicht, läuft der Dienst trotzdem – der Status
    // zeigt das an.
    let mut watch_config =
        crate::watch::WatchConfig::default_for_platform(vec![config.data_dir.clone()]);
    watch_config.protected.extend(service.protected_folders());
    if let Err(e) = crate::watch::start(
        watch_config,
        service.scanner(),
        service.watch(),
        Arc::clone(stop),
    ) {
        service
            .watch()
            .note_failure(&format!("Echtzeit-Wächter nicht gestartet: {e}"));
    }
    let history = service.history();
    let service = Arc::new(Mutex::new(service));
    spawn_scheduler(Arc::clone(&service), Arc::clone(stop));
    let result = serve(&config.endpoint, &service, stop);
    save_history(&history);
    result
}

/// Sichert den Verlauf: unter der Sperre nur serialisieren, geschrieben wird außerhalb.
fn save_history(history: &Mutex<crate::history::History>) {
    let lock = || {
        history
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    };
    let save = lock().prepare_save();
    if let Some(save) = save {
        let ok = save.write().is_ok();
        lock().saved(ok);
    }
}

/// Zeitplaner: prüft jede Minute, ob geplante Scans oder ein Signatur-Update fällig sind.
/// Scans laufen im eingeschränkten Prüfprozess außerhalb der Sperre und **melden nur**.
fn spawn_scheduler(service: Arc<Mutex<LiveService>>, stop: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let lock = || {
            service
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
        };
        while !stop.load(Ordering::SeqCst) {
            let (work, scanner, history, backups, store) = {
                let mut guard = lock();
                (
                    guard.take_due_work(),
                    guard.scanner(),
                    guard.history(),
                    guard.take_due_backups(),
                    guard.backup_store(),
                )
            };
            save_history(&history);
            // Rückfall-Kopien (vom Nutzer per Plan eingeschaltet): lesen mit den Rechten des
            // angemeldeten Besitzers, schreiben nur in den eigenen Ordner – ohne Dienst-Sperre.
            if let Some(store) = &store {
                for job in &backups {
                    let access = crate::worker::BackgroundAccess {
                        profile: job.profile.clone(),
                        require_owner: true,
                    };
                    let outcome = crate::handler::backup::run_job(store, job, &access);
                    lock().record_backup(job, &outcome);
                }
            }
            for schedule in &work.schedules {
                let folders: Vec<PathBuf> = crate::schedule::SCHEDULED_FOLDERS
                    .iter()
                    .map(|f| schedule.profile.join(f))
                    .filter(|p| p.is_dir())
                    .collect();
                // Mit den Rechten des Profil-Besitzers (angemeldet), sonst „nur Nutzer“ – nie
                // mit den Rechten des Dienstes.
                let access = crate::worker::BackgroundAccess {
                    profile: Some(schedule.profile.clone()),
                    require_owner: true,
                };
                let result = scanner.scan(&folders, &access);
                lock().record_scheduled(schedule, result);
            }
            if work.update {
                let result = ClamAv::locate()
                    .ok_or_else(|| "ClamAV ist nicht installiert".to_owned())
                    .and_then(|c| c.update_signatures(aegis_engine::clamav::UPDATE_TIMEOUT));
                lock().record_update(result);
            }
            for _ in 0..60 {
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
        }
    });
}

static CONNECTIONS: AtomicUsize = AtomicUsize::new(0);

/// Wie lange eine Verbindung höchstens auf die nächste Anfrage warten darf.
#[cfg(windows)]
const IDLE_LIMIT_SECS: u64 = 30;

/// Bedient den Endpunkt mit einem vorhandenen Dienst-Zustand. Fehler einzelner Verbindungen
/// (z. B. sofort wieder getrennte Clients) beenden den Dienst nicht. Es gibt immer eine
/// freie Instanz, bevor eine andere freigegeben wird – so kann niemand den Namen in einer
/// Lücke übernehmen. Wartet eine Verbindung zu lange auf eine Anfrage, wird sie getrennt.
///
/// # Errors
/// Endpunkt belegt oder nicht anlegbar.
#[cfg(windows)]
pub fn serve<W: Durable + Send + 'static>(
    endpoint: &str,
    service: &Arc<Mutex<Service<SystemClock, W>>>,
    stop: &Arc<AtomicBool>,
) -> io::Result<()> {
    use crate::transport::windows::{accept, create_instance};
    // Die erste Instanz muss exklusiv gelingen – sonst hat jemand den Namen besetzt.
    let mut current = create_instance(endpoint, true)?;
    while !stop.load(Ordering::SeqCst) {
        // Ersatz zuerst anlegen, dann erst die aktuelle Instanz verbrauchen.
        let next = loop {
            match create_instance(endpoint, false) {
                Ok(i) => break i,
                Err(_) if !stop.load(Ordering::SeqCst) => {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
                Err(e) => return Err(e),
            }
        };
        let accepted = accept(std::mem::replace(&mut current, next));
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let Ok(connection) = accepted else {
            continue;
        };
        let Some(slot) = Slot::try_take(&CONNECTIONS, MAX_CONNECTIONS) else {
            continue; // Verbindung wird sofort wieder geschlossen.
        };
        let service = Arc::clone(service);
        std::thread::spawn(move || {
            let _slot = slot;
            serve_pipe_connection(&service, connection);
        });
    }
    Ok(())
}

/// Eine Verbindung mit Leerlauf-Wächter bedienen.
#[cfg(windows)]
fn serve_pipe_connection<W: Durable>(
    service: &Mutex<Service<SystemClock, W>>,
    connection: std::fs::File,
) {
    use crate::transport::windows::{PipeClient, disconnect};
    let connection = Arc::new(connection);
    let waiting_since = Arc::new(AtomicU64::new(0));
    let done = Arc::new(AtomicBool::new(false));
    let watchdog = {
        let (connection, waiting_since, done) = (
            Arc::clone(&connection),
            Arc::clone(&waiting_since),
            Arc::clone(&done),
        );
        std::thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(500));
                let since = waiting_since.load(Ordering::SeqCst);
                if since != 0 && now_secs().saturating_sub(since) > IDLE_LIMIT_SECS {
                    let _ = disconnect(&connection);
                    break;
                }
            }
        })
    };
    let mut stream = IdleTracked {
        file: &connection,
        waiting_since: &waiting_since,
    };
    let _ = crate::transport::serve_connection(service, &mut stream, &PipeClient::new(&connection));
    done.store(true, Ordering::SeqCst);
    let _ = watchdog.join();
}

#[cfg(windows)]
fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Merkt sich, seit wann auf Daten gewartet wird (für den Leerlauf-Wächter).
#[cfg(windows)]
struct IdleTracked<'a> {
    file: &'a std::fs::File,
    waiting_since: &'a AtomicU64,
}

#[cfg(windows)]
impl io::Read for IdleTracked<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.waiting_since
            .store(now_secs().max(1), Ordering::SeqCst);
        let result = io::Read::read(&mut self.file, buf);
        self.waiting_since.store(0, Ordering::SeqCst);
        result
    }
}

#[cfg(windows)]
impl io::Write for IdleTracked<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        io::Write::write(&mut self.file, buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        io::Write::flush(&mut self.file)
    }
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

/// Windows: mit Zugriffsliste anlegen bzw. Besitzer/Links prüfen (`aegis-winffi`); auch alle
/// vorhandenen Inhalte müssen SYSTEM/Administratoren gehören und dürfen keine Links sein
/// (sonst könnte ein früher hineingelegter Schlüssel oder Eintrag eines Nutzers verwendet
/// werden).
#[cfg(windows)]
fn secure_dir(dir: &Path) -> io::Result<()> {
    use crate::transport::windows::{create_secure_dir, owner_is_trusted};
    create_secure_dir(dir)?;
    let mut stack = vec![(dir.to_owned(), 0usize)];
    let mut checked = 0usize;
    while let Some((current, depth)) = stack.pop() {
        for item in std::fs::read_dir(&current)? {
            let path = item?.path();
            checked += 1;
            if checked > 200_000 || !owner_is_trusted(&path)? {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!(
                        "{} gehört nicht SYSTEM/Administratoren oder ist ein Link – der Dienst startet nicht (bitte prüfen)",
                        path.display()
                    ),
                ));
            }
            // Labor (Reste gehören teils dem Nutzer) und Rückfall-Kopien (sehr viele eigene
            // Dateien) werden nur selbst geprüft, nicht durchlaufen.
            let lab = depth == 0
                && path
                    .file_name()
                    .is_some_and(|n| n == LAB_DIR || n == BACKUP_DIR);
            if !lab && depth < 3 && std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir()) {
                stack.push((path, depth + 1));
            }
        }
    }
    Ok(())
}

/// Labor-Ordner: wie `secure_dir`, aber ohne Prüfung des Inhalts (Reste früherer Läufe
/// gehören teils dem Nutzer und werden danach verworfen).
#[cfg(windows)]
fn secure_lab_dir(dir: &Path) -> io::Result<()> {
    crate::transport::windows::create_secure_dir(dir)
}

/// Unix: `secure_dir` prüft keine Inhalte.
#[cfg(unix)]
fn secure_lab_dir(dir: &Path) -> io::Result<()> {
    secure_dir(dir)
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
