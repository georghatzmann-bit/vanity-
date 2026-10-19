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
pub mod process;

#[cfg(windows)]
pub use fs::{
    DATA_DIR_SDDL, create_new, create_secure_dir, delete_by_handle, final_path, is_name_surrogate,
    long_path, open_exclusive, owner_is_trusted,
};
#[cfg(windows)]
pub use pipe::{
    Impersonation, PIPE_NAME, PIPE_SDDL, ServerIdentity, accept, client_sid, create_instance,
    disconnect, impersonate_client, server_identity, thread_is_impersonating,
};
#[cfg(windows)]
pub use process::{JobLimits, RestrictedChild, RestrictedToken, spawn_restricted};

/// Vergleicht den von Windows gelieferten tatsächlichen Pfad (`\\?\C:\…`, UTF-16) mit dem
/// angefragten (`C:\…`). `equal_ignore_case` vergleicht zwei UTF-16-Folgen ohne
/// Groß-/Kleinschreibung (unter Windows `CompareStringOrdinal` – wie NTFS, ohne
/// Unicode-Sonderfälle wie „ß“ → „SS“). Netzwerk- und Gerätepfade gelten nie als gleich.
/// Rein (ohne FFI), damit es überall getestet werden kann.
#[must_use]
pub fn final_path_matches_with(
    actual: &[u16],
    requested: &[u16],
    equal_ignore_case: impl Fn(&[u16], &[u16]) -> bool,
) -> bool {
    let units = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
    let Some(rest) = actual.strip_prefix(units(r"\\?\").as_slice()) else {
        return false;
    };
    if rest.starts_with(&units(r"UNC\")) || requested.starts_with(&units(r"\\")) {
        return false;
    }
    equal_ignore_case(trim_backslashes(rest), trim_backslashes(requested))
}

fn trim_backslashes(mut s: &[u16]) -> &[u16] {
    while let [head @ .., last] = s
        && *last == u16::from(b'\\')
    {
        s = head;
    }
    s
}

/// Wie [`final_path_matches_with`] mit einfachem ASCII-Vergleich (Tests, Diagnose).
#[must_use]
pub fn final_path_matches(actual: &str, requested: &str) -> bool {
    let a: Vec<u16> = actual.encode_utf16().collect();
    let r: Vec<u16> = requested.encode_utf16().collect();
    final_path_matches_with(&a, &r, |x, y| {
        x.len() == y.len()
            && x.iter().zip(y).all(|(a, b)| {
                let fold =
                    |c: u16| u8::try_from(c).map_or(c, |b| u16::from(b.to_ascii_uppercase()));
                fold(*a) == fold(*b)
            })
    })
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
        // Keine Unicode-Sonderfaltung: „straße“ ist nicht „STRASSE“.
        assert!(!final_path_matches(r"\\?\C:\strasse", r"C:\straße"));
        assert!(final_path_matches(r"\\?\C:\a\", r"C:\a"));
    }
}
