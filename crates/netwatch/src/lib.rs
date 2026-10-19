//! Netzwerk & Web-Schutz (P7): Verbindungen pro Programm mit Land und Verlauf, Firewall-Übersicht,
//! Heimnetz, Leck-Check.
//!
//! Diese Bibliothek **bewertet und formuliert nur** (rein, überall testbar). Gelesen wird im
//! Dienst (`aegis-winffi`), verändert wird nur über Pläne mit „Ja“ im Dienst.
#![forbid(unsafe_code)]

pub mod conn;
pub mod firewall;
pub mod geo;
pub mod lan;
