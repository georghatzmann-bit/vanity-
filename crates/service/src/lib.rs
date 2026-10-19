//! Windows-Dienst `aegis-service`: Scans, Quarantäne, Freigabe-Tor und Prüfprotokoll.
//!
//! - [`protocol`] – Nachrichten zwischen Oberfläche und Dienst,
//! - [`handler`] – Verarbeitung; einzige Stelle, die Nutzerantworten annimmt.
#![forbid(unsafe_code)]

pub mod handler;
pub mod protocol;

pub use handler::Service;
pub use protocol::{Request, Response};
