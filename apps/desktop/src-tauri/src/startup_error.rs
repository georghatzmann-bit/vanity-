//! Sichtbare Startfehler.
//!
//! Der Release-Build unter Windows hat kein Konsolenfenster – eine Meldung auf stderr sieht
//! dort niemand. Kann AEGIS nicht starten, passiert deshalb dreierlei:
//!
//! 1. eine Zeile in `startup.log` (AEGIS-eigene Daten): unter Windows
//!    `%LOCALAPPDATA%\AEGIS\logs\startup.log`, sonst `$XDG_STATE_HOME/aegis/logs/startup.log`
//!    bzw. `~/.local/state/aegis/logs/startup.log`;
//! 2. unter Windows ein natives Meldungsfenster (deutsch, dann englisch);
//! 3. wie bisher eine Zeile auf stderr.
//!
//! Erfasst werden Fehler aus `Builder::build` und – über einen Panic-Hook, der nur bis zum
//! Ende des Starts aktiv ist – Fehler beim Anlegen des Fensters (Tauri meldet die im
//! Setup-Schritt als Panic, etwa wenn die WebView2-Laufzeit fehlt).
//!
//! Die Protokolldatei wird nur angehängt, nie gekürzt oder gelöscht; ab
//! [`MAX_LOG_BYTES`] schreibt AEGIS nichts mehr hinein (die Meldung erscheint trotzdem).
//! Links und Sonderdateien an ihrer Stelle werden verweigert.

use std::any::Any;
use std::ffi::OsString;
use std::io::{self, Write};
use std::panic::Location;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// Dateiname des Startprotokolls.
pub const LOG_FILE_NAME: &str = "startup.log";
/// Ab dieser Größe wird nichts mehr angehängt (kein Kürzen, kein Rotieren – das wäre Löschen).
pub const MAX_LOG_BYTES: u64 = 1024 * 1024;
/// Höchstlänge der technischen Meldung (Protokoll und Meldungsfenster).
pub const MAX_DETAIL_CHARS: usize = 2000;
/// Titel des Meldungsfensters.
pub const DIALOG_TITLE: &str = "AEGIS Suite – Startfehler / Startup error";

/// Läuft der Start noch? Nur dann meldet der Panic-Hook.
static STARTING: AtomicBool = AtomicBool::new(false);
/// Wurde bereits ein Startfehler gemeldet? (höchstens ein Meldungsfenster je Prozess)
static REPORTED: AtomicBool = AtomicBool::new(false);

/// Plattform für den Ablageort (als Wert, damit beide Zweige überall testbar sind).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Unix,
}

impl Platform {
    pub const fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Unix
        }
    }
}

/// Art eines Protokolleintrags.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogKind {
    /// AEGIS konnte nicht starten.
    Failure,
    /// Start gelungen, aber eingeschränkt (z. B. kein Tray-Symbol).
    Notice,
}

impl LogKind {
    const fn label(self) -> &'static str {
        match self {
            Self::Failure => "Startfehler",
            Self::Notice => "Hinweis",
        }
    }
}

/// Pfad des Startprotokolls. `env` liefert Umgebungsvariablen; nur absolute Werte zählen
/// (ein relativer Wert würde relativ zum Arbeitsordner schreiben). `None`, wenn kein
/// geeigneter Ordner bekannt ist.
pub fn startup_log_path(
    platform: Platform,
    env: impl Fn(&str) -> Option<OsString>,
) -> Option<PathBuf> {
    let absolute = |name: &str| {
        env(name)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    };
    let logs = match platform {
        Platform::Windows => absolute("LOCALAPPDATA")?.join("AEGIS").join("logs"),
        Platform::Unix => absolute("XDG_STATE_HOME")
            .or_else(|| absolute("HOME").map(|home| home.join(".local").join("state")))?
            .join("aegis")
            .join("logs"),
    };
    Some(logs.join(LOG_FILE_NAME))
}

/// Eine Zeile Text: Steuerzeichen (auch Zeilenumbrüche) werden zu Leerzeichen, höchstens
/// `max` Zeichen (gekürzt mit „…“). So kann eine Fehlermeldung keine Zeilen vortäuschen.
pub fn single_line(text: &str, max: usize) -> String {
    let flat: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let flat = flat.trim();
    if flat.chars().count() <= max {
        flat.to_owned()
    } else {
        let mut cut: String = flat.chars().take(max.saturating_sub(1)).collect();
        cut.push('…');
        cut
    }
}

/// Protokollzeile: `<Zeit> AEGIS <Version> <Art>: <Meldung>\n`.
pub fn format_log_line(timestamp: &str, version: &str, kind: LogKind, detail: &str) -> String {
    format!(
        "{} AEGIS {} {}: {}\n",
        single_line(timestamp, 64),
        single_line(version, 64),
        kind.label(),
        single_line(detail, MAX_DETAIL_CHARS)
    )
}

/// Text des Meldungsfensters (deutsch, dann englisch). `log` ist der Ablageort der Zeile
/// oder der Grund, warum sie nicht gespeichert werden konnte.
pub fn failure_message(detail: &str, log: Result<&Path, &str>, platform: Platform) -> String {
    let detail = single_line(detail, MAX_DETAIL_CHARS);
    let (saved_de, saved_en) = match log {
        Ok(path) => (
            format!("Die Meldung steht auch in:\n{}", path.display()),
            format!("The message was also saved to:\n{}", path.display()),
        ),
        Err(reason) => {
            let reason = single_line(reason, 200);
            (
                format!("Die Meldung konnte nicht gespeichert werden ({reason})."),
                format!("The message could not be saved ({reason})."),
            )
        }
    };
    let (hint_de, hint_en) = match platform {
        Platform::Windows => (
            "AEGIS bitte erneut starten. Tritt der Fehler wieder auf, hilft oft eine \
             Neuinstallation – der Installer richtet dabei auch die WebView2-Laufzeit ein, \
             falls sie fehlt.",
            "Please start AEGIS again. If the error persists, reinstalling often helps – the \
             installer also sets up the WebView2 runtime if it is missing.",
        ),
        Platform::Unix => ("AEGIS bitte erneut starten.", "Please start AEGIS again."),
    };
    format!(
        "AEGIS konnte nicht starten.\n\nTechnische Meldung:\n{detail}\n\n{saved_de}\n\n{hint_de}\n\n\
         ———\n\n\
         AEGIS could not start.\n\nTechnical message:\n{detail}\n\n{saved_en}\n\n{hint_en}"
    )
}

/// Meldung aus einer Panic (`&str`/`String`, sonst „unbekannte Ursache“) samt Ort.
pub fn panic_detail(payload: &(dyn Any + Send), location: Option<&Location<'_>>) -> String {
    let message = payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("unbekannte Ursache / unknown cause");
    match location {
        Some(at) => format!("{message} ({}:{})", at.file(), at.line()),
        None => message.to_owned(),
    }
}

/// Hängt `line` an das Startprotokoll `path` an (legt fehlende Ordner an).
///
/// # Errors
/// Wenn an der Stelle ein Link oder eine Sonderdatei liegt, die Datei
/// [`MAX_LOG_BYTES`] erreicht hat oder das Dateisystem den Zugriff verweigert.
pub fn append_line(path: &Path, line: &str) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Protokollpfad ohne Ordner"))?;
    // AEGIS-eigene Daten: der Protokollordner unter LOCALAPPDATA bzw. XDG_STATE_HOME.
    // aegis-mutation: startup-log-create-dir
    #[allow(clippy::disallowed_methods)]
    std::fs::create_dir_all(dir)?;
    match std::fs::symlink_metadata(path) {
        Ok(meta) if !meta.file_type().is_file() => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "an der Stelle des Protokolls liegt keine normale Datei (Link?) – nicht angefasst",
            ));
        }
        Ok(meta) if meta.len() >= MAX_LOG_BYTES => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Protokoll hat die Höchstgröße erreicht – nichts angehängt",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    // Nur anhängen (append), nie kürzen; die Datei gehört AEGIS.
    // aegis-mutation: startup-log-append
    #[allow(clippy::disallowed_methods)]
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    file.write_all(line.as_bytes())?;
    file.flush()
}

fn timestamp_now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "Zeit unbekannt".to_owned())
}

fn log_path() -> Option<PathBuf> {
    startup_log_path(Platform::current(), |name| std::env::var_os(name))
}

/// Schreibt einen Eintrag; liefert den Ablageort oder den Grund des Scheiterns.
fn write_entry(version: &str, kind: LogKind, detail: &str) -> Result<PathBuf, String> {
    let path = log_path().ok_or_else(|| "kein Ordner für das Protokoll bekannt".to_owned())?;
    append_line(
        &path,
        &format_log_line(&timestamp_now(), version, kind, detail),
    )
    .map(|()| path)
    .map_err(|error| error.to_string())
}

/// Meldet einen Startfehler (Protokoll, stderr, unter Windows Meldungsfenster) – höchstens
/// einmal je Prozess. Der Aufrufer beendet danach den Prozess.
pub fn report_failure(version: &str, detail: &str) {
    if REPORTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let detail = single_line(detail, MAX_DETAIL_CHARS);
    eprintln!("AEGIS konnte nicht starten: {detail}");
    let logged = write_entry(version, LogKind::Failure, &detail);
    if let Err(reason) = &logged {
        eprintln!("AEGIS: Startprotokoll nicht geschrieben: {reason}");
    }
    let message = failure_message(
        &detail,
        logged.as_deref().map_err(String::as_str),
        Platform::current(),
    );
    show_error_dialog(DIALOG_TITLE, &message);
}

/// Protokolliert eine Einschränkung beim Start (ohne Meldungsfenster).
pub fn log_notice(version: &str, detail: &str) {
    eprintln!("AEGIS: {}", single_line(detail, MAX_DETAIL_CHARS));
    if let Err(reason) = write_entry(version, LogKind::Notice, detail) {
        eprintln!("AEGIS: Startprotokoll nicht geschrieben: {reason}");
    }
}

/// Aktiviert die Meldung für Panics während des Starts (bis [`startup_finished`]).
/// Der bisherige Hook (Ausgabe auf stderr) läuft weiter, und zwar zuerst.
pub fn watch_startup_panics(version: String) {
    STARTING.store(true, Ordering::SeqCst);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        previous(info);
        if STARTING.load(Ordering::SeqCst) {
            report_failure(&version, &panic_detail(info.payload(), info.location()));
        }
    }));
}

/// Start abgeschlossen (Fenster steht): Spätere Panics meldet der Hook nicht mehr als Startfehler.
pub fn startup_finished() {
    STARTING.store(false, Ordering::SeqCst);
}

/// Natives Meldungsfenster (Windows, `MessageBoxW` über `rfd`). Läuft in einem eigenen
/// Thread: Bei einer Panic im Setup läuft die Ereignisschleife des Hauptthreads noch, ein
/// Meldungsfenster dort würde deren Fensternachrichten verschachtelt verarbeiten.
#[cfg(windows)]
fn show_error_dialog(title: &str, message: &str) {
    let title = title.to_owned();
    let message = message.to_owned();
    let dialog = std::thread::Builder::new()
        .name("aegis-startup-error".to_owned())
        .spawn(move || {
            rfd::MessageDialog::new()
                .set_level(rfd::MessageLevel::Error)
                .set_title(title)
                .set_description(message)
                .set_buttons(rfd::MessageButtons::Ok)
                .show();
        });
    match dialog {
        Ok(handle) => {
            if handle.join().is_err() {
                eprintln!("AEGIS: Meldungsfenster ist abgestürzt");
            }
        }
        Err(error) => eprintln!("AEGIS: Meldungsfenster nicht verfügbar: {error}"),
    }
}

/// Außerhalb von Windows genügt stderr (dort gibt es eine Konsole bzw. ein Terminal).
#[cfg(not(windows))]
fn show_error_dialog(_title: &str, _message: &str) {}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use aegis_core::testing::write_fixture;

    use super::*;

    fn env_of(vars: &[(&str, &Path)]) -> impl Fn(&str) -> Option<OsString> {
        let map: BTreeMap<String, OsString> = vars
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.as_os_str().to_owned()))
            .collect();
        move |name| map.get(name).cloned()
    }

    /// Absoluter Pfad auf dem Testrechner (unter Windows `C:\…`, sonst `/…`).
    fn abs(name: &str) -> PathBuf {
        std::env::temp_dir().join(name)
    }

    #[test]
    fn windows_pfad_unter_localappdata() {
        let base = abs("LocalAppData");
        let path = startup_log_path(Platform::Windows, env_of(&[("LOCALAPPDATA", &base)]));
        assert_eq!(
            path,
            Some(base.join("AEGIS").join("logs").join("startup.log"))
        );
    }

    #[test]
    fn windows_ohne_oder_mit_relativem_localappdata_kein_pfad() {
        assert_eq!(startup_log_path(Platform::Windows, env_of(&[])), None);
        let relative = Path::new("AppData");
        assert_eq!(
            startup_log_path(Platform::Windows, env_of(&[("LOCALAPPDATA", relative)])),
            None
        );
        assert_eq!(
            startup_log_path(
                Platform::Windows,
                env_of(&[("LOCALAPPDATA", Path::new(""))])
            ),
            None
        );
        // HOME zählt unter Windows nicht.
        assert_eq!(
            startup_log_path(Platform::Windows, env_of(&[("HOME", &abs("home"))])),
            None
        );
    }

    #[test]
    fn unix_bevorzugt_xdg_state_home() {
        let state = abs("state");
        let home = abs("home");
        assert_eq!(
            startup_log_path(
                Platform::Unix,
                env_of(&[("XDG_STATE_HOME", &state), ("HOME", &home)])
            ),
            Some(state.join("aegis").join("logs").join("startup.log"))
        );
    }

    #[test]
    fn unix_faellt_auf_home_zurueck() {
        let home = abs("home");
        let expected = Some(
            home.join(".local")
                .join("state")
                .join("aegis")
                .join("logs")
                .join("startup.log"),
        );
        assert_eq!(
            startup_log_path(Platform::Unix, env_of(&[("HOME", &home)])),
            expected
        );
        // Relatives XDG_STATE_HOME ist laut Spezifikation zu ignorieren.
        assert_eq!(
            startup_log_path(
                Platform::Unix,
                env_of(&[("XDG_STATE_HOME", Path::new("state")), ("HOME", &home)])
            ),
            expected
        );
        assert_eq!(
            startup_log_path(Platform::Unix, env_of(&[("HOME", Path::new("rel"))])),
            None
        );
        assert_eq!(startup_log_path(Platform::Unix, env_of(&[])), None);
    }

    #[test]
    fn protokollzeile_ist_genau_eine_zeile() {
        let line = format_log_line(
            "2026-10-19T08:00:00Z",
            "0.1.0",
            LogKind::Failure,
            "Fehler\nZeile 2\r\n2026-10-19T08:00:01Z AEGIS 0.1.0 Startfehler: gefälscht\t",
        );
        assert_eq!(
            line,
            "2026-10-19T08:00:00Z AEGIS 0.1.0 Startfehler: Fehler Zeile 2  2026-10-19T08:00:01Z AEGIS 0.1.0 Startfehler: gefälscht\n"
        );
        assert_eq!(line.matches('\n').count(), 1);
        assert!(
            format_log_line("t", "v", LogKind::Notice, "x").starts_with("t AEGIS v Hinweis: x")
        );
    }

    #[test]
    fn lange_meldungen_werden_gekuerzt() {
        let long = "ä".repeat(MAX_DETAIL_CHARS * 2);
        let short = single_line(&long, MAX_DETAIL_CHARS);
        assert_eq!(short.chars().count(), MAX_DETAIL_CHARS);
        assert!(short.ends_with('…'));
        assert_eq!(single_line("  kurz  ", 10), "kurz");
        assert_eq!(single_line("genau", 5), "genau");
        assert_eq!(single_line("", 5), "");
    }

    #[test]
    fn meldung_deutsch_zuerst_mit_ablageort() {
        let path = abs("x").join("startup.log");
        let text = failure_message("WebView2 fehlt", Ok(&path), Platform::Windows);
        let de = text.find("AEGIS konnte nicht starten.").unwrap();
        let en = text.find("AEGIS could not start.").unwrap();
        assert!(de < en, "Deutsch vor Englisch");
        assert_eq!(text.matches("WebView2 fehlt").count(), 2);
        assert_eq!(text.matches(&path.display().to_string()).count(), 2);
        assert!(text.contains("WebView2-Laufzeit"));
    }

    #[test]
    fn meldung_nennt_den_grund_wenn_nicht_gespeichert() {
        let text = failure_message("x", Err("Zugriff verweigert"), Platform::Unix);
        assert!(text.contains("konnte nicht gespeichert werden (Zugriff verweigert)"));
        assert!(text.contains("could not be saved (Zugriff verweigert)"));
        assert!(!text.contains("WebView2"), "Hinweis nur unter Windows");
    }

    #[test]
    fn meldung_bleibt_eine_meldung() {
        let text = failure_message("a\nb", Err("c\nd"), Platform::Unix);
        assert!(text.contains("a b"));
        assert!(text.contains("(c d)"));
    }

    #[test]
    fn panic_meldung_aus_str_string_und_unbekannt() {
        let at = Location::caller();
        let text: Box<dyn Any + Send> = Box::new("Failed to setup app: kaputt");
        assert_eq!(
            panic_detail(text.as_ref(), Some(at)),
            format!("Failed to setup app: kaputt ({}:{})", at.file(), at.line())
        );
        let owned: Box<dyn Any + Send> = Box::new(String::from("eigene Meldung"));
        assert_eq!(panic_detail(owned.as_ref(), None), "eigene Meldung");
        let other: Box<dyn Any + Send> = Box::new(42_u8);
        assert_eq!(
            panic_detail(other.as_ref(), None),
            "unbekannte Ursache / unknown cause"
        );
    }

    #[test]
    fn protokoll_wird_angelegt_und_nur_angehaengt() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("AEGIS").join("logs").join(LOG_FILE_NAME);
        append_line(&path, "erste\n").unwrap();
        append_line(&path, "zweite\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "erste\nzweite\n");
    }

    #[test]
    fn vorhandener_inhalt_bleibt_erhalten() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_fixture(dir.path(), "logs/startup.log", b"alt\n").unwrap();
        append_line(&path, "neu\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "alt\nneu\n");
    }

    #[test]
    fn volles_protokoll_bleibt_unveraendert() {
        let dir = tempfile::tempdir().unwrap();
        let full = vec![b'x'; usize::try_from(MAX_LOG_BYTES).unwrap()];
        let path = write_fixture(dir.path(), "logs/startup.log", &full).unwrap();
        let error = append_line(&path, "neu\n").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(std::fs::read(&path).unwrap(), full);
    }

    #[test]
    fn ordner_an_der_stelle_der_datei_wird_verweigert() {
        let dir = tempfile::tempdir().unwrap();
        let path = aegis_core::testing::create_fixture_dir(dir.path(), "startup.log").unwrap();
        let error = append_line(&path, "neu\n").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(path.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn link_an_der_stelle_der_datei_wird_nicht_verfolgt() {
        let dir = tempfile::tempdir().unwrap();
        let target = write_fixture(dir.path(), "fremd.txt", b"fremd\n").unwrap();
        let link = aegis_core::testing::create_fixture_symlink(dir.path(), "startup.log", &target)
            .unwrap();
        let error = append_line(&link, "neu\n").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "fremd\n");
    }

    #[test]
    fn pfad_ohne_ordner_wird_verweigert() {
        let error = append_line(Path::new(""), "x\n").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn zeitstempel_ist_rfc3339() {
        let now = timestamp_now();
        assert!(
            time::OffsetDateTime::parse(&now, &time::format_description::well_known::Rfc3339)
                .is_ok(),
            "{now}"
        );
    }
}
