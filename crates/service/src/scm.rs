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
