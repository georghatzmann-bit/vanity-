//! Passwort-Tresor (P9): eine verschlüsselte Datei je Konto.
//!
//! - **Schlüssel:** Master-Passwort → Argon2id (mindestens 64 MiB, 3 Durchläufe; Parameter und
//!   Salz stehen in der Datei) → Schlüssel, der einen zufälligen Datenschlüssel (256 Bit) per
//!   AES-256-GCM verpackt. Das Master-Passwort wird nirgends gespeichert.
//! - **Einträge:** jeder einzeln mit dem Datenschlüssel verschlüsselt, bei jedem Speichern mit
//!   neuer Nonce; die Kennung ist als zusätzliche Daten gebunden (kein Vertauschen).
//! - **Im Speicher:** Schlüssel und Geheimnisse in `Zeroizing` – beim Sperren überschrieben.
//! - Dazu: Generator, Stärke-Schätzung, Wiederverwendung, CSV-Import des **eigenen** Exports,
//!   Adressvergleich fürs Ausfüllen.
//!
//! Diese Bibliothek liest und schreibt keine Dateien (nur Bytes) – rein und testbar.
#![forbid(unsafe_code)]

pub mod bridge;
pub mod entry;
pub mod generate;
pub mod import;
pub mod strength;
pub mod url;
pub mod vault;

pub use entry::{Entry, EntryInput, EntrySummary};
pub use vault::{KdfParams, Vault, VaultError};
