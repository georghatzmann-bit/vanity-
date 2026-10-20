//! Anbindung an den Windows-Dienststeuerungs-Manager (SCM).
//!
//! Installiert wird der Dienst vom Setup (P13) mit Administratorrechten; hier nur Start und
//! sauberes Beenden.

use std::ffi::OsString;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use windows_service::service::{
    ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::{define_windows_service, service_dispatcher};

use crate::server::{ServerConfig, run};

/// Name des Dienstes.
pub const SERVICE_NAME: &str = "aegis-service";

define_windows_service!(ffi_service_main, service_main);

/// Übergibt die Kontrolle an den SCM (blockiert, bis der Dienst endet).
///
/// # Errors
/// Nicht vom SCM gestartet.
pub fn start() -> windows_service::Result<()> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
}

fn service_main(_args: Vec<OsString>) {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_handler = Arc::clone(&stop);
    let handler = move |control| match control {
        ServiceControl::Stop | ServiceControl::Shutdown => {
            stop_handler.store(true, Ordering::SeqCst);
            // Blockierendes Warten auf einen Client lösen.
            let _ = crate::transport::windows::connect(crate::transport::windows::PIPE_NAME);
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    };
    let Ok(status) = service_control_handler::register(SERVICE_NAME, handler) else {
        return;
    };
    let set = |state, accept| {
        let _ = status.set_service_status(ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: accept,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::from_secs(5),
            process_id: None,
        });
    };
    set(
        ServiceState::Running,
        ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
    );
    if let Some(config) = ServerConfig::default_for_platform() {
        let _ = run(&config, &stop);
    }
    set(ServiceState::Stopped, ServiceControlAccept::empty());
}

/// Anzeigename des Dienstes.
pub const DISPLAY_NAME: &str = "AEGIS Suite – Schutzdienst";

/// Legt den Dienst an (automatischer Start, Konto LocalSystem, Argument `service`) und startet
/// ihn. Nur vom Installationsprogramm aufgerufen (mit Administratorrechten, nach der
/// Entscheidung des Nutzers zu installieren). Ist er schon da, wird nur der Pfad aktualisiert.
///
/// # Errors
/// Keine Rechte oder SCM meldet einen Fehler.
pub fn install(exe: &std::path::Path) -> windows_service::Result<()> {
    use windows_service::service::{
        ServiceAccess, ServiceErrorControl, ServiceInfo, ServiceStartType,
    };
    use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

    let manager = ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
    )?;
    let info = ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from(DISPLAY_NAME),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: exe.to_path_buf(),
        launch_arguments: vec![OsString::from("service")],
        dependencies: Vec::new(),
        account_name: None,
        account_password: None,
    };
    let access = ServiceAccess::QUERY_STATUS | ServiceAccess::START | ServiceAccess::CHANGE_CONFIG;
    let service = match manager.open_service(SERVICE_NAME, access) {
        Ok(existing) => {
            // Installation (Update): denselben Dienst auf die neue Datei zeigen lassen.
            // aegis-mutation: scm-install-update-config
            #[allow(clippy::disallowed_methods)]
            existing.change_config(&info)?;
            existing
        }
        Err(_) => {
            // Installation: legt den Schutzdienst an (vom Nutzer gestartetes Setup, UAC).
            // aegis-mutation: scm-install-create
            #[allow(clippy::disallowed_methods)]
            let created = manager.create_service(&info, access)?;
            created
        }
    };
    // Installation: Beschreibung des eigenen Dienstes.
    // aegis-mutation: scm-install-description
    #[allow(clippy::disallowed_methods)]
    service.set_description(
        "Prüft Dateien und meldet Funde. Verändert nichts ohne ausdrückliche Bestätigung in der AEGIS-App.",
    )?;
    if service.query_status()?.current_state != ServiceState::Running {
        // Installation: startet den eben angelegten Dienst.
        // aegis-mutation: scm-install-start
        #[allow(clippy::disallowed_methods)]
        service.start::<&str>(&[])?;
    }
    Ok(())
}

/// Hält den Dienst an und entfernt ihn (nur vom Deinstallationsprogramm aufgerufen, nach der
/// Entscheidung des Nutzers zu deinstallieren). Fehlt er: kein Fehler.
///
/// # Errors
/// Keine Rechte oder SCM meldet einen Fehler.
pub fn uninstall() -> windows_service::Result<()> {
    use windows_service::service::ServiceAccess;
    use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
    let Ok(service) = manager.open_service(
        SERVICE_NAME,
        ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE,
    ) else {
        return Ok(());
    };
    if service.query_status()?.current_state != ServiceState::Stopped {
        // Deinstallation: hält den eigenen Dienst an.
        // aegis-mutation: scm-uninstall-stop
        #[allow(clippy::disallowed_methods)]
        let _ = service.stop();
        for _ in 0..50 {
            if service.query_status()?.current_state == ServiceState::Stopped {
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
    // Deinstallation: entfernt den eigenen Dienst.
    // aegis-mutation: scm-uninstall-delete
    #[allow(clippy::disallowed_methods)]
    service.delete()
}
