//! Fehlerbehandlung: alle Befehle liefern `Result<T, String>` mit kurzen, deutschen Texten,
//! die die Oberfläche direkt anzeigen kann.

use std::io;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

/// Ergebnis-Typ aller Tauri-Befehle.
pub type CmdResult<T> = Result<T, String>;

/// Verständlicher Text für einen Dateisystem-Fehler.
pub fn io_err(e: &io::Error, path: &Path) -> String {
    let p = path.display();
    // Windows-spezifische Fehlercodes zuerst (Datei gesperrt, Datenträger voll)
    match e.raw_os_error() {
        Some(32) | Some(33) => {
            return format!("Die Datei wird gerade von einem anderen Programm verwendet: {p}")
        }
        Some(112) | Some(39) => return "Auf dem Datenträger ist nicht genug Speicherplatz frei.".into(),
        Some(28) if cfg!(unix) => return "Auf dem Datenträger ist nicht genug Speicherplatz frei.".into(),
        _ => {}
    }
    match e.kind() {
        io::ErrorKind::NotFound => format!("Die Datei wurde nicht gefunden: {p}"),
        io::ErrorKind::PermissionDenied => {
            format!("Zugriff verweigert: {p}. Bitte prüfe die Berechtigungen.")
        }
        io::ErrorKind::AlreadyExists => format!("Die Datei existiert bereits: {p}"),
        io::ErrorKind::InvalidData | io::ErrorKind::UnexpectedEof => {
            format!("Die Datei ist beschädigt oder unvollständig: {p}")
        }
        _ => format!("Fehler beim Zugriff auf {p}: {e}"),
    }
}

/// Datenbank-Fehler in einen verständlichen Text übersetzen.
pub fn db_err(e: rusqlite::Error) -> String {
    use rusqlite::ErrorCode;
    if let rusqlite::Error::SqliteFailure(f, _) = &e {
        match f.code {
            ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => {
                return "Die Datenbank ist gerade belegt – bitte gleich noch einmal versuchen.".into()
            }
            ErrorCode::DiskFull => {
                return "Auf dem Datenträger ist nicht genug Speicherplatz frei.".into()
            }
            ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase => {
                return "Die Datenbank ist beschädigt. Bitte stelle ein Backup wieder her.".into()
            }
            ErrorCode::ReadOnly | ErrorCode::PermissionDenied | ErrorCode::CannotOpen => {
                return "Die Datenbank kann nicht geöffnet oder beschrieben werden (keine Berechtigung?)."
                    .into()
            }
            _ => {}
        }
    }
    format!("Datenbankfehler: {e}")
}

/// Netzwerk-Fehler in einen verständlichen Text übersetzen.
pub fn net_err(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        return "Zeitüberschreitung – der Server antwortet nicht. Bitte später erneut versuchen.".into();
    }
    if e.is_connect() {
        return "Keine Verbindung zum Internet".into();
    }
    if let Some(status) = e.status() {
        return http_status_err(status.as_u16());
    }
    if e.is_decode() {
        return "Die Antwort des Servers konnte nicht gelesen werden.".into();
    }
    if e.is_request() || e.is_body() {
        return "Keine Verbindung zum Internet".into();
    }
    format!("Netzwerkfehler: {e}")
}

/// Text für einen HTTP-Statuscode.
pub fn http_status_err(code: u16) -> String {
    match code {
        401 | 403 => "Zugriff verweigert (HTTP 401/403).".into(),
        404 => "Nicht gefunden (HTTP 404).".into(),
        429 => "Zu viele Anfragen – bitte kurz warten und erneut versuchen.".into(),
        500..=599 => format!("Der Server hat ein Problem (HTTP {code}). Bitte später erneut versuchen."),
        _ => format!("Unerwartete Antwort vom Server (HTTP {code})."),
    }
}

/// Vergifteten Mutex tolerieren: nach einer Panik in einem anderen Thread trotzdem weiterarbeiten.
pub trait LockExt<T> {
    fn lock_safe(&self) -> MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    fn lock_safe(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Blockierende Arbeit (Dateien, SQLite, Bilder, Scans) außerhalb des Haupt-/Async-Threads ausführen.
/// Eine Panik im Arbeits-Thread wird zu einer freundlichen Fehlermeldung.
pub async fn blocking<T, F>(f: F) -> CmdResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> CmdResult<T> + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(f).await {
        Ok(r) => r,
        Err(_) => Err("Interner Fehler – bitte erneut versuchen.".into()),
    }
}
