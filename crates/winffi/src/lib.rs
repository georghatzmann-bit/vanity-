//! Windows-FFI der AEGIS Suite – **die einzige Bibliothek mit `unsafe`**.
//!
//! Jeder `unsafe`-Block ist klein, mit `// SAFETY:` begründet, mit `// aegis-unsafe:`
//! markiert und in `crates/core/mutation-allowlist.txt` eingetragen (vom Mutations-Wächter
//! erzwungen). Alle anderen Crates nutzen nur die sicheren Hüllen von hier.
//!
//! - [`pipe`]: Named Pipe mit Zugriffsliste, Identitätswechsel auf den Client, Prüfung der
//!   Server-Identität,
//! - [`fs`]: Dateien ohne Links öffnen/anlegen/löschen (Quarantäne mit Nutzerrechten),
//!   geschützte Ordner anlegen.
//!
//! Auf anderen Systemen ist das Crate leer.
#![deny(unsafe_code)]

#[cfg(windows)]
mod util;

#[cfg(windows)]
pub mod pipe;

#[cfg(windows)]
pub mod fs;

#[cfg(windows)]
pub use fs::{
    DATA_DIR_SDDL, create_new, create_secure_dir, delete_by_handle, final_path, open_exclusive,
};
#[cfg(windows)]
pub use pipe::{
    Impersonation, PIPE_NAME, PIPE_SDDL, ServerIdentity, accept, create_instance,
    impersonate_client, server_identity, thread_is_impersonating,
};

/// Vergleicht den von Windows gelieferten tatsächlichen Pfad (`\\?\C:\…`) mit dem
/// angefragten (`C:\…`), ohne Groß-/Kleinschreibung. Netzwerk- und Gerätepfade gelten nie
/// als gleich. Rein (ohne FFI), damit es überall getestet werden kann.
#[must_use]
pub fn final_path_matches(actual: &str, requested: &str) -> bool {
    let Some(actual) = actual.strip_prefix(r"\\?\") else {
        return false;
    };
    if actual.starts_with(r"UNC\") || requested.starts_with(r"\\") {
        return false;
    }
    let fold = |s: &str| s.trim_end_matches('\\').to_uppercase();
    fold(actual) == fold(requested)
}

#[cfg(test)]
mod tests {
    use super::final_path_matches;

    #[test]
    fn pfadvergleich() {
        assert!(final_path_matches(
            r"\\?\C:\Users\a\x.exe",
            r"C:\users\A\X.EXE"
        ));
        assert!(!final_path_matches(
            r"\\?\C:\Windows\x.exe",
            r"C:\Users\a\x.exe"
        ));
        assert!(!final_path_matches(
            r"C:\Users\a\x.exe",
            r"C:\Users\a\x.exe"
        ));
        assert!(!final_path_matches(r"\\?\UNC\srv\s\x", r"\\srv\s\x"));
        assert!(!final_path_matches(r"\\?\C:\a\b", r"C:\a\b\c"));
    }
}
