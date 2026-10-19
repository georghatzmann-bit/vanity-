//! Windows-Dienst `aegis-service`: Scans, Quarantäne, Freigabe-Tor und Prüfprotokoll.
//!
//! - [`protocol`] – Nachrichten zwischen Oberfläche und Dienst,
//! - [`handler`] – Verarbeitung; einzige Stelle, die Nutzerantworten annimmt,
//! - [`worker`] – Prüfprozess: fremde Dateien werden nur dort geparst.
#![forbid(unsafe_code)]

pub mod handler;
pub mod protocol;
#[cfg(windows)]
pub mod scm;
pub mod server;
pub mod transport;
pub mod worker;

pub use handler::Service;
pub use protocol::{Request, Response};
