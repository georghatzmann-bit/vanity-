//! Datei-Export (`export_file`): schreibt Bytes aus der Oberfläche (PNG-Bildkarte, HTML-/CSV-Bericht)
//! an den Ort aus dem Windows-Speichern-Dialog. Vertrag: `docs/API.md`, „Datei-Export“.
//!
//! Übertragung als Roh-IPC (`InvokeBody::Raw`, Pfad im Header `x-pulsar-path`, URI-kodiert) – kein
//! JSON-Zahlen-Array. Ohne Adminrechte, ohne `plugin-fs`, ohne neue Capability.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::{blocking, io_err, CmdResult};

/// Höchstgröße einer Datei (10 MiB).
pub const MAX_BYTES: usize = 10 * 1024 * 1024;
/// Header mit dem Zielpfad (`encodeURIComponent(path)`).
pub const PATH_HEADER: &str = "x-pulsar-path";
/// Erlaubte Endungen (Groß-/Kleinschreibung egal).
pub const ALLOWED_EXTENSIONS: [&str; 5] = ["png", "html", "csv", "md", "txt"];

/// `backend.fileTooBig`
pub const TOO_BIG: &str = "Datei ist zu groß.";
/// `backend.fileType`
pub const FILE_TYPE: &str = "Dateityp nicht erlaubt.";
/// `backend.badPath`
pub const BAD_PATH: &str = "Ungültiger Speicherort.";

/// `backend.saveFailed` („Datei konnte nicht gespeichert werden: {value}“).
fn save_failed(detail: &str) -> String {
    format!("Datei konnte nicht gespeichert werden: {detail}")
}

/// Reservierte Gerätenamen unter Windows (auch mit Endung, z. B. `CON.txt`).
fn is_reserved_name(file_name: &str) -> bool {
    let stem = file_name.split('.').next().unwrap_or("").trim_end_matches([' ', '.']).to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    let b = stem.as_bytes();
    b.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && (b'1'..=b'9').contains(&b[3])
}

/// Pfadregeln (in dieser Reihenfolge): Endung erlaubt → sonst „Dateityp nicht erlaubt.“; absolut,
/// mit Dateinamen, kein `:` außer an Position 1, kein `\\`-Präfix (Geräte-/Netzwerkpfade), kein
/// reservierter Name, Ordner existiert → sonst „Ungültiger Speicherort.“
pub fn check_path(path: &str) -> Result<PathBuf, &'static str> {
    let p = Path::new(path);
    let ext_ok = p
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| ALLOWED_EXTENSIONS.iter().any(|a| a.eq_ignore_ascii_case(e)));
    if !ext_ok || path.ends_with(['/', '\\']) {
        return Err(FILE_TYPE);
    }
    if path.starts_with(r"\\") || path.starts_with("//") {
        return Err(BAD_PATH);
    }
    if path.char_indices().any(|(i, c)| c == ':' && i != 1) {
        return Err(BAD_PATH);
    }
    if !p.is_absolute() {
        return Err(BAD_PATH);
    }
    let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
        return Err(BAD_PATH);
    };
    if is_reserved_name(name) {
        return Err(BAD_PATH);
    }
    match p.parent() {
        Some(parent) if parent.is_dir() => Ok(p.to_path_buf()),
        _ => Err(BAD_PATH),
    }
}

/// Zufälliger Teil des Namens der temporären Datei.
fn random_tag() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

/// Name der temporären Datei im Zielordner: `.<name>.<zufall>.tmp`.
fn tmp_path(target: &Path) -> Option<PathBuf> {
    let name = target.file_name()?.to_str()?;
    Some(target.with_file_name(format!(".{name}.{}.tmp", random_tag())))
}

/// Atomar schreiben: temporäre Datei (neu angelegt, nie eine vorhandene) im Zielordner,
/// `sync_all`, dann umbenennen. Eine vorhandene Zieldatei wird ersetzt. Legt keine Ordner an.
pub fn write_file(target: &Path, data: &[u8]) -> CmdResult<()> {
    let tmp = tmp_path(target).ok_or_else(|| BAD_PATH.to_string())?;
    let result = (|| -> std::io::Result<()> {
        let mut f = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, target)
    })();
    match result {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(save_failed(&io_err(&e, target)))
        }
    }
}

/// Größe, Endung und Pfad prüfen, dann schreiben (ohne Tauri – auch für den Selbsttest).
pub fn export_bytes(path: &str, data: &[u8]) -> CmdResult<()> {
    if data.len() > MAX_BYTES {
        return Err(TOO_BIG.into());
    }
    let target = check_path(path).map_err(String::from)?;
    write_file(&target, data)
}

/// `%XX`-Folgen dekodieren (`encodeURIComponent`). Ungültige Kodierung → `None`.
pub fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `export_file`: Bytes als Roh-IPC, Zielpfad im Header `x-pulsar-path`.
#[tauri::command]
pub async fn export_file(request: tauri::ipc::Request<'_>) -> CmdResult<()> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err(save_failed("keine Daten erhalten"));
    };
    if body.len() > MAX_BYTES {
        return Err(TOO_BIG.into());
    }
    let path = request
        .headers()
        .get(PATH_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(percent_decode)
        .ok_or_else(|| BAD_PATH.to_string())?;
    let data = body.clone();
    blocking(move || export_bytes(&path, &data)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir_path(dir: &Path, name: &str) -> String {
        dir.join(name).to_string_lossy().into_owned()
    }

    #[test]
    fn rejects_exe_and_no_extension() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(check_path(&dir_path(dir.path(), "x.exe")), Err(FILE_TYPE));
        assert_eq!(check_path(&dir_path(dir.path(), "bericht")), Err(FILE_TYPE));
        assert_eq!(check_path(&dir_path(dir.path(), "bericht.")), Err(FILE_TYPE));
        assert_eq!(check_path(&dir_path(dir.path(), ".png")), Err(FILE_TYPE));
        assert_eq!(check_path(&dir_path(dir.path(), "x.png.exe")), Err(FILE_TYPE));
        assert!(check_path(&dir_path(dir.path(), "x.exe.png")).is_ok());
    }

    #[test]
    fn extension_case_insensitive() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["a.PNG", "b.Html", "c.csv", "d.MD", "e.txt"] {
            let p = check_path(&dir_path(dir.path(), name)).unwrap();
            assert_eq!(p, dir.path().join(name));
        }
    }

    #[test]
    fn rejects_too_large() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir_path(dir.path(), "gross.txt");
        assert_eq!(export_bytes(&path, &vec![0u8; MAX_BYTES + 1]), Err(TOO_BIG.to_string()));
        assert!(!dir.path().join("gross.txt").exists());
        // Größe wird vor der Endung geprüft
        assert_eq!(export_bytes(&dir_path(dir.path(), "x.exe"), &vec![0u8; MAX_BYTES + 1]), Err(TOO_BIG.to_string()));
        assert!(export_bytes(&path, &vec![7u8; MAX_BYTES]).is_ok());
        assert_eq!(fs::metadata(dir.path().join("gross.txt")).unwrap().len(), MAX_BYTES as u64);
    }

    #[test]
    fn rejects_relative_or_missing_dir() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(check_path("bericht.txt"), Err(BAD_PATH));
        assert_eq!(check_path("unter/bericht.txt"), Err(BAD_PATH));
        assert_eq!(check_path(&dir_path(&dir.path().join("fehlt"), "x.txt")), Err(BAD_PATH));
        // Ein Ordner mit erlaubter Endung ist kein Dateiname
        let sub = dir.path().join("ordner.txt");
        fs::create_dir(&sub).unwrap();
        assert_eq!(check_path(&format!("{}/", sub.display())), Err(FILE_TYPE));
        assert_eq!(check_path(&dir_path(&sub, "y.txt")).map(|p| p.parent().map(Path::to_path_buf)), Ok(Some(sub.clone())));
    }

    #[test]
    fn rejects_ads_unc_device_reserved() {
        let dir = tempfile::tempdir().unwrap();
        // NTFS-Datenstrom: „:“ nicht an Position 1
        assert_eq!(check_path(&dir_path(dir.path(), "x.txt:y.png")), Err(BAD_PATH));
        // Geräte- und Netzwerkpfade
        assert_eq!(check_path(r"\\?\C:\temp\x.png"), Err(BAD_PATH));
        assert_eq!(check_path(r"\\.\C:\temp\x.png"), Err(BAD_PATH));
        assert_eq!(check_path(r"\\server\freigabe\x.png"), Err(BAD_PATH));
        // Reservierte Namen, auch mit Endung und in Kleinbuchstaben
        for name in ["CON.txt", "nul.png", "Com1.csv", "LPT9.md", "aux.html", "con.tar.txt"] {
            assert_eq!(check_path(&dir_path(dir.path(), name)), Err(BAD_PATH), "{name}");
        }
        for name in ["CONSOLE.txt", "com10.txt", "lpt0.txt", "Konto.txt"] {
            assert!(check_path(&dir_path(dir.path(), name)).is_ok(), "{name}");
        }
    }

    #[test]
    fn writes_atomically_and_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir_path(dir.path(), "karte.png");
        export_bytes(&path, b"eins").unwrap();
        assert_eq!(fs::read(dir.path().join("karte.png")).unwrap(), b"eins");
        export_bytes(&path, b"zwei-ersetzt").unwrap();
        assert_eq!(fs::read(dir.path().join("karte.png")).unwrap(), b"zwei-ersetzt");
        // Keine temporären Reste
        let names: Vec<String> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["karte.png".to_string()]);
    }

    #[test]
    fn tmp_name_never_hits_user_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("bericht.csv");
        let a = tmp_path(&target).unwrap();
        let b = tmp_path(&target).unwrap();
        assert_ne!(a, b, "zufälliger Teil");
        assert_ne!(a, target);
        assert_eq!(a.parent(), Some(dir.path()), "im Zielordner (gleiches Laufwerk)");
        let name = a.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with(".bericht.csv.") && name.ends_with(".tmp"), "{name}");
        // Liegt zufällig schon eine Datei mit dem Namen der temporären Datei da, wird sie nie
        // überschrieben (create_new) – das Schreiben scheitert sauber.
        fs::write(&a, b"fremd").unwrap();
        let blocked = OpenOptions::new().write(true).create_new(true).open(&a);
        assert!(blocked.is_err());
        assert_eq!(fs::read(&a).unwrap(), b"fremd");
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("C%3A%5CUsers%5Cx%20y%5Cb%C3%A4r.png").as_deref(), Some("C:\\Users\\x y\\bär.png"));
        assert_eq!(percent_decode("/tmp/a.txt").as_deref(), Some("/tmp/a.txt"));
        assert_eq!(percent_decode("%ZZ"), None);
        assert_eq!(percent_decode("%4"), None);
        assert_eq!(percent_decode("%FF"), None, "kein gültiges UTF-8");
    }

    #[test]
    fn write_error_is_german_sentence() {
        let dir = tempfile::tempdir().unwrap();
        // Ziel ist ein Ordner → Umbenennen scheitert
        let target = dir.path().join("ordner.txt");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("inhalt"), b"x").unwrap();
        let err = write_file(&target, b"daten").unwrap_err();
        assert!(err.starts_with("Datei konnte nicht gespeichert werden: "), "{err}");
        let leftovers = fs::read_dir(dir.path()).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".tmp")).count();
        assert_eq!(leftovers, 0, "temporäre Datei entfernt");
    }
}
