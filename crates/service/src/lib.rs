//! Windows-Dienst `aegis-service`: Scans, Quarantäne, Freigabe-Tor und Prüfprotokoll.
//!
//! - [`protocol`] – Nachrichten zwischen Oberfläche und Dienst,
//! - [`handler`] – Verarbeitung; einzige Stelle, die Nutzerantworten annimmt,
//! - [`worker`] – Prüfprozess: fremde Dateien werden nur dort geparst.
#![forbid(unsafe_code)]

pub mod handler;
pub mod history;
pub mod protocol;
pub mod schedule;
#[cfg(windows)]
pub mod scm;
pub mod server;
pub mod store;
pub mod transport;
pub mod trust;
pub mod watch;
pub mod worker;

pub use handler::Service;
pub use protocol::{Request, Response};
