//! Labor (P4): unbekannte Programme abgeschottet ausprobieren und ihr Verhalten erklären.
//!
//! - [`wsb`] – Stufe 1: Konfiguration der Windows Sandbox (Netz, Zwischenablage, Drucker,
//!   Audio/Kamera aus; Probe nur lesbar).
//! - [`report`] – Verhaltensbericht und verständliche Einschätzung.
//! - [`snapshot`], [`entropy`] – Vorher/Nachher-Vergleich und Entropie geschriebener Dateien.
//!
//! Ein Labor-Lauf startet ein fremdes Programm – das geschieht nur nach „Ja, ausführen“ im
//! Freigabe-Dialog (Plan des Dienstes). Diese Bibliothek selbst beobachtet und beschreibt nur.
#![forbid(unsafe_code)]

pub mod acl;
pub mod detect;
pub mod entropy;
#[cfg(windows)]
pub mod mini;
#[cfg(windows)]
pub mod observe;
pub mod png;
pub mod report;
pub mod snapshot;
pub mod wsb;

pub use report::{Assessment, Behavior, BehaviorReport, RunEnd, Stage};
