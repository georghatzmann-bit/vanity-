//! Windows-Dienst `aegis-service`: Scans, Quarantäne, Freigabe-Tor und Prüfprotokoll.
//!
//! - [`protocol`] – Nachrichten zwischen Oberfläche und Dienst,
//! - [`handler`] – Verarbeitung; einzige Stelle, die Nutzerantworten annimmt.
#![forbid(unsafe_code)]

pub mod handler;
pub mod protocol;
#[cfg(windows)]
pub mod scm;
pub mod server;
pub mod transport;

pub use handler::Service;
pub use protocol::{Request, Response};
