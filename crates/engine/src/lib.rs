//! Erkennungs-Engine der AEGIS Suite – **nur lesend**.
//!
//! Die Engine prüft Dateien und liefert einen [`finding::Finding`] mit Risikostufe,
//! Sicherheit der Einschätzung, Begründungen und einer kurzen Erklärung. Sie verändert,
//! verschiebt oder löscht nie etwas (Goldene Regel): Isolieren übernimmt die Quarantäne,
//! und zwar nur mit einer `ExecutionPermit` aus `aegis-core`.
//!
//! Schichten (siehe `docs/ARCHITECTURE.md`):
//! - [`eicar`] – EICAR-Testdatei (harmloser Prüfstandard),
//! - [`hashlist`] – Abgleich mit Hash-Listen (SHA-256),
//! - [`yara`] – YARA-X-Regeln (eigene + lizenzierte, Herkunft in `docs/LICENSES.md`),
//! - [`pe`] – statische PE-Analyse (Header, Importe, Entropie, Packer, Signatur-Verzeichnis),
//! - [`heuristics`] – Dateiname, Ort, Mark-of-the-Web,
//! - [`clamav`] – ClamAV als **getrennter Prozess** (GPL, nie eingelinkt),
//! - [`finding`] – gewichtete Bewertung zu Risikostufen.
#![forbid(unsafe_code)]

pub mod clamav;
pub mod eicar;
pub mod entropy;
pub mod finding;
pub mod hash;
pub mod hashlist;
pub mod heuristics;
pub mod pe;
pub mod scan;
pub mod yara;

pub use finding::{Category, Finding, Reason, Recommendation, Source};
pub use scan::{Engine, EngineConfig, ScanLimits, ScanReport};
