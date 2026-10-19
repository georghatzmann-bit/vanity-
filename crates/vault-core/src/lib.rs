//! Passwort-Tresor (P9): Argon2id + AES-256-GCM, Schlüssel nur im RAM.
//!
//! Platzhalter aus Phase P0 – die Umsetzung folgt in der angegebenen Phase.
//! Jede Funktion, die etwas verändert, verlangt eine `aegis_core::consent::Approval`.
#![forbid(unsafe_code)]
