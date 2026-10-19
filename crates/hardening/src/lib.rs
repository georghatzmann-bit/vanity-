//! Härtung & Systemzustand (P6): Sicherheits-Score aus nachvollziehbaren Prüfungen.
//!
//! Diese Bibliothek **bewertet nur**: Sie bekommt die gelesenen [`SystemFacts`] (unter Windows
//! sammelt sie `aegis-winffi` im Dienst) und liefert je Prüfung ein Ergebnis mit Erklärung und
//! – wo möglich – einen Vorschlag zum Beheben. Behoben wird nie hier, sondern nur über einen
//! Plan mit „Ja“ (Vorschau, Rückgängig, Prüfprotokoll).
//!
//! Ehrlich: Was nicht lesbar war, zählt als „unbekannt“ und fließt nicht in den Score ein – es
//! wird nicht schöngerechnet. Liegen zu wenige Prüfungen vor, gibt es keinen Score.
#![forbid(unsafe_code)]

pub mod checks;
pub mod collect;
pub mod drivers;
pub mod facts;
pub mod persistence;

pub use checks::{CheckId, CheckResult, CheckStatus, FixKind, Score, evaluate, score};
pub use facts::SystemFacts;
