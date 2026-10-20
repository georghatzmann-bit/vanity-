//! Windows-Tools (Modul J, P10/P11): Sortierer, Quellen-Ordner, Regeln, Desktop-Symbole,
//! Hintergrundbild, Duplikate, Speicherplatz, große & alte Dateien, leere Ordner, Cleaner,
//! Autostart.
//!
//! Jedes Werkzeug erstellt zuerst nur lesend eine Vorschau ([`plan::Plan`]). Ausgeführt wird
//! genau diese Vorschau – nach „Ausführen“ des Nutzers oder durch eine vom Nutzer angelegte und
//! eingeschaltete Regel ([`plan::Approved`]). Jeder Lauf kommt ins Protokoll
//! ([`journal::Journal`]) und lässt sich zurücknehmen ([`exec::undo`]). Nichts wird endgültig
//! gelöscht (Papierkorb), nichts überschrieben, Systemorte sind tabu ([`guard`]).
#![forbid(unsafe_code)]

pub mod autostart;
pub mod category;
pub mod desktop;
pub mod exec;
pub mod guard;
pub mod journal;
pub mod plan;
pub mod platform;
pub mod recycle;
pub mod rules;
pub mod tools;
pub mod walk;
#[cfg(windows)]
pub mod win;
