//! Privacy-Browser der AEGIS Suite (P12) – reine Logik ohne Netz und ohne Fenster:
//!
//! - [`address`] – Eingabe der Adresszeile → Adresse oder Suche, HTTPS-only, gesperrte Schemata,
//! - [`blocker`] – Werbe-/Tracker-Blocker auf Filterlisten (EasyList/EasyPrivacy, Adblock-Plus-
//!   Format; die Listen lädt die App nur auf Wunsch),
//! - [`settings`] – Einstellungen und daraus die Schalter für WebView2 (DoH, WebRTC),
//! - [`bookmarks`] – Lesezeichen.
//!
//! Ehrlich: Der Browser reduziert Tracking, er anonymisiert nicht. Für Anonymität ist der
//! offizielle Tor Browser stärker (Fingerabdruck-Schutz, geprüfte Einstellungen).
#![forbid(unsafe_code)]

pub mod address;
pub mod blocker;
pub mod bookmarks;
pub mod settings;
