//! Zustands-Schnappschuss für „Nichts ohne Ja“-Tests: erkennt jede Veränderung byte-genau.
// Integrationstest: Auch Hilfsfunktionen außerhalb von #[test] dürfen wie Tests per
// unwrap/expect/panic abbrechen (clippy.toml erlaubt das sonst nur direkt in #[test]).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io;
use std::path::Path;

use aegis_core::testing::{
    DirSnapshot, assert_unchanged, create_fixture_dir, remove_fixture, rename_fixture,
    set_fixture_modified, set_fixture_readonly, write_fixture,
};

fn tree() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    write_fixture(dir.path(), "a.txt", b"Inhalt A").unwrap();
    write_fixture(dir.path(), "sub/b.bin", &[0, 1, 2, 3, 255]).unwrap();
    write_fixture(dir.path(), "sub/deeper/c.txt", b"").unwrap();
    create_fixture_dir(dir.path(), "leer").unwrap();
    dir
}

fn snap(dir: &Path) -> DirSnapshot {
    DirSnapshot::capture(dir).unwrap()
}

#[test]
fn identical_trees_compare_equal() {
    let dir = tree();
    let before = snap(dir.path());
    let after = snap(dir.path());
    assert_eq!(before, after);
    assert!(before.diff(&after).is_empty());
    assert_eq!(before.diff(&after).to_string(), "Keine Veränderung.");
    assert_unchanged(&before, &after);

    let names: Vec<String> = before
        .entries()
        .keys()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .collect();
    assert_eq!(
        names,
        [
            "a.txt",
            "leer",
            "sub",
            "sub/b.bin",
            "sub/deeper",
            "sub/deeper/c.txt"
        ]
    );
    let a = before.get("a.txt").unwrap();
    assert!(!a.is_dir && !a.is_symlink && !a.readonly);
    assert_eq!(a.len, 8);
    assert_eq!(a.sha256_hex().len(), 64);
    let leer = before.get("leer").unwrap();
    assert!(leer.is_dir);
    assert_eq!(leer.sha256, None);
    assert_eq!(leer.sha256_hex(), "-");

    // Zwei getrennt, aber gleich aufgebaute Bäume haben denselben Inhalt …
    let other = snap(tree().path());
    assert_eq!(
        other.entries().keys().collect::<Vec<_>>(),
        before.entries().keys().collect::<Vec<_>>()
    );
    for (path, state) in other.entries() {
        assert!(state.same_content(before.get(path).unwrap()), "{path:?}");
    }
    // … sind aber andere Dateien – auch das erkennt der Schnappschuss (Datei-Identität).
    #[cfg(unix)]
    assert_ne!(other, before);
}

#[test]
fn content_change_with_same_size_is_detected() {
    let dir = tree();
    let before = snap(dir.path());
    write_fixture(dir.path(), "a.txt", b"Inhalt B").unwrap();
    let after = snap(dir.path());
    let diff = before.diff(&after);
    assert_eq!(diff.changed.len(), 1);
    let (path, old, new) = &diff.changed[0];
    assert_eq!(path, Path::new("a.txt"));
    assert_eq!(old.len, new.len);
    assert_ne!(old.sha256, new.sha256);
    assert!(diff.added.is_empty() && diff.removed.is_empty());
    let text = diff.to_string();
    assert!(text.contains("verändert:   a.txt"), "{text}");
}

#[test]
fn single_byte_change_in_nested_file_is_detected() {
    let dir = tree();
    let before = snap(dir.path());
    write_fixture(dir.path(), "sub/b.bin", &[0, 1, 2, 3, 254]).unwrap();
    assert_eq!(before.diff(&snap(dir.path())).changed.len(), 1);
}

#[test]
fn added_file_is_detected() {
    let dir = tree();
    let before = snap(dir.path());
    write_fixture(dir.path(), "leer/neu.txt", b"x").unwrap();
    let diff = before.diff(&snap(dir.path()));
    assert_eq!(diff.added.len(), 1);
    assert!(diff.added[0].0.ends_with("neu.txt"));
    assert!(diff.to_string().contains("+ hinzugefügt"));
}

#[test]
fn deleted_file_and_directory_are_detected() {
    let dir = tree();
    let before = snap(dir.path());
    remove_fixture(dir.path(), "a.txt").unwrap();
    let diff = before.diff(&snap(dir.path()));
    assert_eq!(diff.removed.len(), 1);
    assert!(diff.to_string().contains("- entfernt:     a.txt"));

    remove_fixture(dir.path(), "sub").unwrap();
    let diff = before.diff(&snap(dir.path()));
    assert_eq!(diff.removed.len(), 5);
    assert!(
        diff.to_string().contains("- entfernt:     sub (Ordner)"),
        "{diff}"
    );

    // Was es nicht gibt, kann nicht entfernt werden.
    let err = remove_fixture(dir.path(), "fehlt/datei.txt").unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::NotFound);
    let err = remove_fixture(dir.path(), "fehlt.txt").unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::NotFound);
}

#[test]
fn renamed_file_is_detected() {
    let dir = tree();
    let before = snap(dir.path());
    rename_fixture(dir.path(), "a.txt", "sub/a-umbenannt.txt").unwrap();
    let diff = before.diff(&snap(dir.path()));
    assert_eq!(diff.removed.len(), 1);
    assert_eq!(diff.added.len(), 1);
    assert!(diff.changed.is_empty());
    assert!(diff.to_string().contains("vermutlich umbenannt/verschoben"));
}

#[test]
fn readonly_change_is_detected() {
    let dir = tree();
    let before = snap(dir.path());
    set_fixture_readonly(dir.path(), "a.txt", true).unwrap();
    let after = snap(dir.path());
    let diff = before.diff(&after);
    assert_eq!(diff.changed.len(), 1);
    assert!(diff.changed[0].2.readonly);
    assert!(diff.to_string().contains("schreibgeschützt"));
    set_fixture_readonly(dir.path(), "a.txt", false).unwrap();
    let back = snap(dir.path());
    assert!(
        before
            .get("a.txt")
            .unwrap()
            .same_content(back.get("a.txt").unwrap())
    );
    // Unter Unix macht `set_readonly(false)` die Datei für alle beschreibbar (0666) – das ist
    // nicht der alte Zustand, und der Schnappschuss erkennt es. Unter Windows ist der alte
    // Zustand (Dateiattribute) wiederhergestellt.
    #[cfg(unix)]
    assert_eq!(before.diff(&back).changed.len(), 1);
    #[cfg(not(unix))]
    assert_unchanged(&before, &back);
}

#[test]
#[should_panic(expected = "Der Ordner wurde verändert")]
fn assert_unchanged_fails_with_readable_diff() {
    let dir = tree();
    let before = snap(dir.path());
    write_fixture(dir.path(), "a.txt", b"anders").unwrap();
    assert_unchanged(&before, &snap(dir.path()));
}

#[test]
fn capture_requires_a_directory() {
    let dir = tree();
    let err = DirSnapshot::capture(dir.path().join("a.txt")).unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    let err = DirSnapshot::capture(dir.path().join("fehlt")).unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::NotFound);
}

#[test]
fn fixture_helpers_refuse_names_outside_the_directory() {
    let dir = tree();
    let before = snap(dir.path());
    let absolute = dir.path().join("absolut.txt");
    for bad in [
        "../ausserhalb.txt",
        "sub/../../ausserhalb.txt",
        "",
        "./a.txt",
        absolute.to_str().unwrap(),
    ] {
        let err = write_fixture(dir.path(), bad, b"x").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{bad:?}");
        assert!(remove_fixture(dir.path(), bad).is_err(), "{bad:?}");
        assert!(rename_fixture(dir.path(), "a.txt", bad).is_err(), "{bad:?}");
        assert!(
            set_fixture_readonly(dir.path(), bad, true).is_err(),
            "{bad:?}"
        );
        assert!(create_fixture_dir(dir.path(), bad).is_err(), "{bad:?}");
    }
    // Eine Datei als Zwischenordner wird verweigert.
    let err = write_fixture(dir.path(), "a.txt/x", b"x").unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
    // Nichts wurde verändert.
    assert_unchanged(&before, &snap(dir.path()));
}

#[cfg(unix)]
mod links {
    use std::fs;

    use super::*;
    use aegis_core::testing::create_fixture_symlink;

    #[test]
    fn symlinks_are_recorded_but_not_followed() {
        let outside = tempfile::tempdir().unwrap();
        write_fixture(outside.path(), "geheim.txt", b"draussen").unwrap();
        let dir = tree();
        create_fixture_symlink(dir.path(), "link", &outside.path().join("geheim.txt")).unwrap();
        create_fixture_symlink(dir.path(), "linkdir", outside.path()).unwrap();
        let before = snap(dir.path());
        let link = before.get("link").unwrap();
        assert!(link.is_symlink && !link.is_dir);
        // Der verlinkte Ordner wird nicht betreten.
        assert!(before.get("linkdir/geheim.txt").is_none());

        // Ein anderes Link-Ziel wird erkannt.
        remove_fixture(dir.path(), "link").unwrap();
        create_fixture_symlink(dir.path(), "link", outside.path()).unwrap();
        let diff = before.diff(&snap(dir.path()));
        assert_eq!(diff.changed.len(), 1);
        assert!(diff.to_string().contains("Link, Ziel-Hash"));
    }

    #[test]
    fn fixture_helpers_refuse_to_follow_links() {
        let outside = tempfile::tempdir().unwrap();
        write_fixture(outside.path(), "geheim.txt", b"draussen").unwrap();
        let outside_before = snap(outside.path());
        let dir = tree();
        create_fixture_symlink(dir.path(), "link", &outside.path().join("geheim.txt")).unwrap();
        create_fixture_symlink(dir.path(), "linkdir", outside.path()).unwrap();

        for result in [
            write_fixture(dir.path(), "link", b"x").map(drop),
            write_fixture(dir.path(), "linkdir/geheim.txt", b"x").map(drop),
            write_fixture(dir.path(), "linkdir/neu/datei.txt", b"x").map(drop),
            set_fixture_readonly(dir.path(), "link", true),
            remove_fixture(dir.path(), "linkdir/geheim.txt"),
            rename_fixture(dir.path(), "a.txt", "link").map(drop),
            rename_fixture(dir.path(), "a.txt", "linkdir/a.txt").map(drop),
        ] {
            assert_eq!(result.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
        }
        // Entfernen eines Links entfernt nur den Link.
        remove_fixture(dir.path(), "linkdir").unwrap();
        remove_fixture(dir.path(), "link").unwrap();
        assert_unchanged(&outside_before, &snap(outside.path()));
        assert_eq!(
            fs::read(outside.path().join("geheim.txt")).unwrap(),
            b"draussen"
        );
    }
}

// ---------------------------------------------------------------------------------------
// Regressionen aus dem Security-Review
// ---------------------------------------------------------------------------------------

#[test]
fn timestamp_change_with_same_content_is_detected() {
    let dir = tree();
    let before = snap(dir.path());
    set_fixture_modified(dir.path(), "a.txt", std::time::UNIX_EPOCH).unwrap();
    let diff = before.diff(&snap(dir.path()));
    assert_eq!(diff.changed.len(), 1, "{diff}");
    let (path, old, new) = &diff.changed[0];
    assert_eq!(path, Path::new("a.txt"));
    assert!(old.same_content(new));
    assert_eq!(new.meta.modified, Some(std::time::UNIX_EPOCH));
    assert!(diff.to_string().contains("geändert 0.000000000"), "{diff}");
}

#[cfg(unix)]
#[test]
fn recreated_file_with_same_content_is_detected() {
    // Löschen und mit gleichem Inhalt neu anlegen (z. B. Quarantäne und zurück).
    let dir = tree();
    let before = snap(dir.path());
    rename_fixture(dir.path(), "a.txt", "alt.txt").unwrap();
    write_fixture(dir.path(), "a.txt", b"Inhalt A").unwrap();
    remove_fixture(dir.path(), "alt.txt").unwrap();
    let diff = before.diff(&snap(dir.path()));
    assert_eq!(diff.changed.len(), 1, "{diff}");
    assert!(diff.changed[0].1.same_content(&diff.changed[0].2));
    assert_ne!(
        diff.changed[0].1.meta.file_id,
        diff.changed[0].2.meta.file_id
    );
    assert!(diff.to_string().contains("Kennung"), "{diff}");
}

#[cfg(unix)]
#[test]
fn permission_bits_beyond_readonly_are_recorded() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tree();
    let snapshot = snap(dir.path());
    let a = snapshot.get("a.txt").unwrap();
    let on_disk = std::fs::metadata(dir.path().join("a.txt"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(a.meta.mode, Some(on_disk));
}

#[cfg(unix)]
#[test]
fn special_files_are_recorded_without_being_opened() {
    // Eine Sonderdatei (hier ein Socket; ein FIFO verhielte sich gleich) darf nie geöffnet
    // werden – ein FIFO würde den Schnappschuss sonst für immer blockieren.
    let dir = tree();
    aegis_core::testing::create_fixture_socket(dir.path(), "sub/sock").unwrap();
    let snapshot = snap(dir.path());
    let sock = snapshot.get("sub/sock").unwrap();
    assert!(sock.is_special && !sock.is_dir && !sock.is_symlink);
    assert_eq!(sock.sha256, None);
    assert_eq!(sock.len, 0);
    remove_fixture(dir.path(), "sub/sock").unwrap();
    let diff = snapshot.diff(&snap(dir.path()));
    assert!(diff.to_string().contains("Sonderdatei"), "{diff}");
}

#[test]
fn fixture_helpers_only_work_below_the_temp_dir() {
    // Auch wenn das Feature `testing` in Produktivcode gelangte: kein Zugriff auf
    // Nutzerordner oder auf den temporären Ordner selbst.
    let project = Path::new(env!("CARGO_MANIFEST_DIR"));
    let temp = std::env::temp_dir();
    let before = snap(project);
    for dir in [project, temp.as_path()] {
        for result in [
            write_fixture(dir, "aegis-darf-nicht.txt", b"x").map(drop),
            create_fixture_dir(dir, "aegis-darf-nicht").map(drop),
            remove_fixture(dir, "Cargo.toml"),
            rename_fixture(dir, "Cargo.toml", "x.toml").map(drop),
            set_fixture_readonly(dir, "Cargo.toml", true),
            set_fixture_modified(dir, "Cargo.toml", std::time::UNIX_EPOCH),
        ] {
            assert_eq!(
                result.unwrap_err().kind(),
                io::ErrorKind::PermissionDenied,
                "{dir:?}"
            );
        }
    }
    assert_unchanged(&before, &snap(project));
}

#[cfg(unix)]
#[test]
fn fixture_helpers_refuse_a_temp_link_pointing_outside() {
    let dir = tree();
    let project = Path::new(env!("CARGO_MANIFEST_DIR"));
    aegis_core::testing::create_fixture_symlink(dir.path(), "raus", project).unwrap();
    let before = snap(project);
    let err = write_fixture(&dir.path().join("raus"), "x.txt", b"x").unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
    assert_unchanged(&before, &snap(project));
}

#[test]
fn fixture_names_must_be_portable() {
    let dir = tree();
    let before = snap(dir.path());
    for bad in [
        "NUL",
        "con.txt",
        "sub/COM1",
        "aux .log",
        "a.txt:stream",
        "sub/x:y",
        "punkt.",
        "a\u{202e}b",
        "a\nb",
    ] {
        let err = write_fixture(dir.path(), bad, b"x").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{bad:?}");
        assert!(create_fixture_dir(dir.path(), bad).is_err(), "{bad:?}");
        assert!(rename_fixture(dir.path(), "a.txt", bad).is_err(), "{bad:?}");
    }
    assert_unchanged(&before, &snap(dir.path()));
}
