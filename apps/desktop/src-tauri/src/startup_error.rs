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
//!
//! **Keine Links.** Unterhalb des Ordners des Nutzers (`LOCALAPPDATA` bzw. `XDG_STATE_HOME`)
//! legt AEGIS nur die eigenen Ordner an (`AEGIS\logs` bzw. `aegis/logs`) – einzeln, und keiner
//! davon darf ein Link, eine Abzweigung (Junction) oder ein anderer Analysepunkt sein. Die
//! Datei selbst wird geöffnet, ohne einem Link an ihrer Stelle zu folgen (Unix `O_NOFOLLOW`,
//! Windows `FILE_FLAG_OPEN_REPARSE_POINT`), und erst nach einer Prüfung des tatsächlich
//! geöffneten Handles beschrieben: normale Datei, kein Analysepunkt, unter Unix genau ein Name
//! (kein Hardlink) und dieselbe Datei wie unter dem Pfad. Netz- und Gerätepfade (`\\server\…`,
//! `\\?\…`) als Ordner des Nutzers werden abgelehnt.
//!
//! Grenzen (ehrlich): Den Ordner des Nutzers liest AEGIS aus der Umgebung, die ein Programm
//! mit demselben Konto umlenken kann – unter Windows legt AEGIS ihn deshalb nie selbst an.
//! Gegen ein Programm mit demselben Konto, das die Ordner *während* des Schreibens austauscht,
//! hilft nur handle-relatives Öffnen, und die Zahl der Hardlinks lässt sich unter Windows mit
//! stabilem std nicht abfragen; beides bräuchte eigenen Windows-FFI-Code. Die App läuft
//! bestimmungsgemäß als Nutzer, nicht mit erhöhten Rechten.

use std::any::Any;
use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs::File;
use std::io::{self, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt as _;
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt as _;
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

/// Unix: `O_NOFOLLOW | O_NONBLOCK` – einem Link an der Stelle der Datei nicht folgen (auch
/// nicht beim Anlegen) und an einer Pipe nicht hängen bleiben. Werte aus den Kernel-Headern
/// der jeweiligen Plattform; ohne das Crate `libc`, das als Crate mit verändernden APIs eigene
/// Sperren in `clippy.toml` bräuchte. Der Test `oeffnen_folgt_keinem_link` prüft die Werte auf
/// der laufenden Plattform; unbekannte Plattformen (0) verlassen sich auf die Handle-Prüfung.
#[cfg(unix)]
const NO_FOLLOW_FLAGS: i32 = if cfg!(any(target_os = "linux", target_os = "android")) {
    if cfg!(any(
        target_arch = "aarch64",
        target_arch = "arm",
        target_arch = "powerpc",
        target_arch = "powerpc64"
    )) {
        0o100_000 | 0o4_000
    } else if cfg!(any(
        target_arch = "x86_64",
        target_arch = "x86",
        target_arch = "riscv64",
        target_arch = "loongarch64",
        target_arch = "s390x"
    )) {
        0o400_000 | 0o4_000
    } else {
        0
    }
} else if cfg!(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd",
    target_os = "dragonfly"
)) {
    0x0100 | 0x0004
} else {
    0
};

/// Windows: `FILE_FLAG_OPEN_REPARSE_POINT` – einen Link oder anderen Analysepunkt an der
/// Stelle der Datei selbst öffnen, statt ihm zu folgen (er wird danach erkannt und abgelehnt).
#[cfg(windows)]
const NO_FOLLOW_FLAGS: u32 = 0x0020_0000;

/// Windows: `FILE_ATTRIBUTE_REPARSE_POINT` (Link, Abzweigung, andere Analysepunkte).
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

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

/// Ablageort des Startprotokolls: der Ordner des Nutzers (aus der Umgebung) und darunter die
/// AEGIS-eigenen Ordner, in denen `startup.log` liegt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogLocation {
    /// Ordner des Nutzers (`LOCALAPPDATA`, `XDG_STATE_HOME` bzw. `~/.local/state`).
    base: PathBuf,
    /// AEGIS-eigene Ordner unterhalb von `base` – nie Links.
    own: [&'static str; 2],
    /// Darf AEGIS einen fehlenden Ordner des Nutzers anlegen? (nur Unix, wie XDG es vorsieht)
    create_base: bool,
}

impl LogLocation {
    /// Ordner des Nutzers, unter dem AEGIS seine Ordner anlegt.
    pub fn base(&self) -> &Path {
        &self.base
    }

    /// Ordner des Protokolls.
    pub fn dir(&self) -> PathBuf {
        self.own
            .iter()
            .fold(self.base.clone(), |dir, name| dir.join(name))
    }

    /// Pfad der Protokolldatei.
    pub fn file(&self) -> PathBuf {
        self.dir().join(LOG_FILE_NAME)
    }
}

/// Netz- oder Gerätepfad (`\\server\…`, `\\?\…`, `\\.\…`, auch mit `/` geschrieben)?
fn is_remote_or_device(path: &Path) -> bool {
    let text = path.as_os_str().to_string_lossy();
    let mut start = text.chars().take(2);
    matches!(
        (start.next(), start.next()),
        (Some('\\' | '/'), Some('\\' | '/'))
    )
}

/// Ablageort des Startprotokolls. `env` liefert Umgebungsvariablen; nur absolute Werte zählen
/// (ein relativer Wert würde relativ zum Arbeitsordner schreiben), unter Windows keine Netz-
/// oder Gerätepfade. `None`, wenn kein geeigneter Ordner bekannt ist.
pub fn startup_log_location(
    platform: Platform,
    env: impl Fn(&str) -> Option<OsString>,
) -> Option<LogLocation> {
    let absolute = |name: &str| {
        env(name).map(PathBuf::from).filter(|path| {
            path.is_absolute() && !(platform == Platform::Windows && is_remote_or_device(path))
        })
    };
    let location = match platform {
        Platform::Windows => LogLocation {
            base: absolute("LOCALAPPDATA")?,
            own: ["AEGIS", "logs"],
            create_base: false,
        },
        Platform::Unix => LogLocation {
            base: absolute("XDG_STATE_HOME")
                .or_else(|| absolute("HOME").map(|home| home.join(".local").join("state")))?,
            own: ["aegis", "logs"],
            create_base: true,
        },
    };
    Some(location)
}

/// Unsichtbare Format- und „Default-Ignorable“-Zeichen: Bidi-Steuerung (U+202E …),
/// Nullbreite-Zeichen, BOM, weiches Trennzeichen, Variantenselektoren, Tags. Dieselbe Auswahl
/// wie `INVISIBLE_PATTERN` in `packages/ui/src/utils/text.ts` (`SafeText`), soweit sie sich
/// ohne Unicode-Tabellen bestimmen lässt; Steuer- und Leerzeichen behandelt [`single_line`].
fn is_invisible_format(c: char) -> bool {
    matches!(
        u32::from(c),
        0x00AD
            | 0x034F
            | 0x061C
            | 0x115F
            | 0x1160
            | 0x17B4
            | 0x17B5
            | 0x180B..=0x180F
            | 0x200B..=0x200F
            | 0x202A..=0x202E
            | 0x2060..=0x206F
            | 0x3164
            | 0xFE00..=0xFE0F
            | 0xFEFF
            | 0xFFA0
            | 0xFFF0..=0xFFFB
            | 0x1BCA0..=0x1BCA3
            | 0x1D173..=0x1D17A
            | 0xE0000..=0xE0FFF
    )
}

/// Eine Zeile Text: Steuerzeichen (auch Zeilenumbrüche) und alle Zeilen-, Absatz- und
/// Leerzeichen-Varianten (U+2028, U+2029, NBSP …) werden zu Leerzeichen; unsichtbare
/// Formatzeichen (etwa U+202E, das Text umdreht) erscheinen als sichtbare Marke `⟨U+202E⟩`.
/// Höchstens `max` Zeichen (gekürzt mit „…“). So kann eine Fehlermeldung weder Zeilen
/// vortäuschen noch ihren Text unsichtbar umordnen – im Protokoll wie im Meldungsfenster.
pub fn single_line(text: &str, max: usize) -> String {
    let mut flat = String::with_capacity(text.len());
    for c in text.chars() {
        if c.is_control() || (c.is_whitespace() && c != ' ') {
            flat.push(' ');
        } else if is_invisible_format(c) {
            // In einen String zu schreiben scheitert nie.
            let _ = write!(flat, "⟨U+{:04X}⟩", u32::from(c));
        } else {
            flat.push(c);
        }
    }
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
        Ok(path) => {
            let path = single_line(&path.display().to_string(), MAX_DETAIL_CHARS);
            (
                format!("Die Meldung steht auch in:\n{path}"),
                format!("The message was also saved to:\n{path}"),
            )
        }
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

fn refused(reason: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("{reason} – nicht angefasst"),
    )
}

fn log_full() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "Protokoll hat die Höchstgröße erreicht – nichts angehängt",
    )
}

#[cfg(windows)]
fn is_reparse_point(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_meta: &std::fs::Metadata) -> bool {
    false
}

/// Ein echter Ordner: kein Link, keine Abzweigung, kein anderer Analysepunkt.
fn is_real_dir(meta: &std::fs::Metadata) -> bool {
    meta.file_type().is_dir() && !meta.file_type().is_symlink() && !is_reparse_point(meta)
}

/// Legt genau einen Ordner an. Nicht rekursiv: `create_dir` folgt an letzter Stelle keinem
/// Link (ein Link dort ergibt „existiert bereits“ und wird danach als Link abgelehnt).
fn make_dir(dir: &Path) -> io::Result<()> {
    // AEGIS-eigene Daten: der Protokollordner unter LOCALAPPDATA bzw. XDG_STATE_HOME.
    // aegis-mutation: startup-log-create-dir
    #[allow(clippy::disallowed_methods)]
    let created = std::fs::create_dir(dir);
    match created {
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        other => other,
    }
}

/// Ordner des Nutzers: muss bestehen; nur unter Unix werden fehlende Ordner (wie XDG es
/// vorsieht) von oben nach unten einzeln angelegt.
fn ensure_base(location: &LogLocation) -> io::Result<()> {
    if location.base.is_dir() {
        return Ok(());
    }
    if !location.create_base {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "Ordner des Nutzers für das Protokoll fehlt",
        ));
    }
    let missing: Vec<&Path> = location
        .base
        .ancestors()
        .take_while(|dir| {
            std::fs::symlink_metadata(dir).is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
        })
        .collect();
    for dir in missing.into_iter().rev() {
        make_dir(dir)?;
    }
    if location.base.is_dir() {
        Ok(())
    } else {
        Err(refused("Ordner des Nutzers für das Protokoll ist kein Ordner"))
    }
}

/// AEGIS-eigener Ordner: anlegen, falls er fehlt; danach muss er ein echter Ordner sein.
fn ensure_own_dir(dir: &Path) -> io::Result<()> {
    if let Err(error) = std::fs::symlink_metadata(dir) {
        if error.kind() != io::ErrorKind::NotFound {
            return Err(error);
        }
        make_dir(dir)?;
    }
    if is_real_dir(&std::fs::symlink_metadata(dir)?) {
        Ok(())
    } else {
        Err(refused(
            "ein Ordner des Protokolls ist kein echter Ordner (Link oder Abzweigung?)",
        ))
    }
}

/// Ordner des Nutzers prüfen, eigene Ordner einzeln anlegen; liefert den Protokollordner.
fn prepare_dirs(location: &LogLocation) -> io::Result<PathBuf> {
    if !location.base.is_absolute() {
        // Ein relativer (oder leerer) Ordner läge relativ zum Arbeitsordner.
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Ordner des Nutzers für das Protokoll ist kein absoluter Pfad",
        ));
    }
    ensure_base(location)?;
    let mut dir = location.base.clone();
    for name in location.own {
        dir.push(name);
        ensure_own_dir(&dir)?;
    }
    Ok(dir)
}

/// Öffnet die Protokolldatei zum Anhängen (legt sie an, falls sie fehlt), ohne einem Link an
/// ihrer Stelle zu folgen.
fn open_log(path: &Path) -> io::Result<File> {
    // Nur anhängen (append), nie kürzen; die Datei gehört AEGIS.
    // aegis-mutation: startup-log-append
    #[allow(clippy::disallowed_methods)]
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .custom_flags(NO_FOLLOW_FLAGS)
        .open(path)?;
    Ok(file)
}

/// Was über die geöffnete Datei bekannt ist – aus dem Handle, nicht aus dem Pfad.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct OpenedLog {
    regular_file: bool,
    reparse_point: bool,
    /// Zahl der Namen (Hardlinks); `None`, wo std sie nicht liefert (Windows).
    links: Option<u64>,
    /// Liegt unter dem Pfad (ohne Links aufzulösen) genau diese Datei? `None`: unbekannt.
    same_as_path: Option<bool>,
    len: u64,
}

fn inspect_opened(file: &File, path: &Path) -> io::Result<OpenedLog> {
    let meta = file.metadata()?;
    #[cfg(unix)]
    let (links, same_as_path) = {
        use std::os::unix::fs::MetadataExt as _;
        let at_path = std::fs::symlink_metadata(path)?;
        (
            Some(meta.nlink()),
            Some(at_path.dev() == meta.dev() && at_path.ino() == meta.ino()),
        )
    };
    #[cfg(not(unix))]
    let (links, same_as_path) = {
        let _ = path;
        (None, None)
    };
    Ok(OpenedLog {
        regular_file: meta.file_type().is_file(),
        reparse_point: is_reparse_point(&meta),
        links,
        same_as_path,
        len: meta.len(),
    })
}

/// Darf in die geöffnete Datei geschrieben werden?
fn check_opened(opened: OpenedLog) -> io::Result<()> {
    if !opened.regular_file || opened.reparse_point {
        return Err(refused(
            "an der Stelle des Protokolls liegt keine normale Datei (Link?)",
        ));
    }
    if opened.links.is_some_and(|links| links != 1) {
        return Err(refused(
            "die Protokolldatei hat mehrere Namen (Hardlink)",
        ));
    }
    if opened.same_as_path == Some(false) {
        return Err(refused(
            "unter dem Pfad des Protokolls liegt inzwischen eine andere Datei",
        ));
    }
    if opened.len >= MAX_LOG_BYTES {
        return Err(log_full());
    }
    Ok(())
}

/// Hängt `line` an das Startprotokoll an (legt fehlende AEGIS-Ordner einzeln an) und liefert
/// den Pfad der Datei.
///
/// # Errors
/// Wenn ein Ordner des Protokolls oder die Datei ein Link, eine Abzweigung oder eine
/// Sonderdatei ist, die Datei mehrere Namen hat oder [`MAX_LOG_BYTES`] erreicht hat, der Ordner
/// des Nutzers fehlt oder das Dateisystem den Zugriff verweigert.
pub fn append_line(location: &LogLocation, line: &str) -> io::Result<PathBuf> {
    let path = prepare_dirs(location)?.join(LOG_FILE_NAME);
    // Vorab, ohne zu öffnen: klare Meldung für Ordner, Links und volle Dateien.
    match std::fs::symlink_metadata(&path) {
        Ok(meta) if !meta.file_type().is_file() || is_reparse_point(&meta) => {
            return Err(refused(
                "an der Stelle des Protokolls liegt keine normale Datei (Link?)",
            ));
        }
        Ok(meta) if meta.len() >= MAX_LOG_BYTES => return Err(log_full()),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    // Entscheidend ist das geöffnete Handle: Zwischen Prüfung und Öffnen kann sich der Pfad
    // geändert haben.
    let mut file = open_log(&path)?;
    check_opened(inspect_opened(&file, &path)?)?;
    file.write_all(line.as_bytes())?;
    file.flush()?;
    Ok(path)
}

fn timestamp_now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "Zeit unbekannt".to_owned())
}

fn log_location() -> Option<LogLocation> {
    startup_log_location(Platform::current(), |name| std::env::var_os(name))
}

/// Schreibt einen Eintrag; liefert den Ablageort oder den Grund des Scheiterns.
fn write_entry(
    location: Option<&LogLocation>,
    version: &str,
    kind: LogKind,
    detail: &str,
) -> Result<PathBuf, String> {
    let location = location.ok_or_else(|| "kein Ordner für das Protokoll bekannt".to_owned())?;
    append_line(
        location,
        &format_log_line(&timestamp_now(), version, kind, detail),
    )
    .map_err(|error| error.to_string())
}

/// Meldet einen Startfehler (Protokoll, stderr, unter Windows Meldungsfenster) – höchstens
/// einmal je Prozess. Der Aufrufer beendet danach den Prozess.
pub fn report_failure(version: &str, detail: &str) {
    report_failure_once(
        &REPORTED,
        log_location().as_ref(),
        version,
        detail,
        show_error_dialog,
    );
}

/// [`report_failure`] mit Sperre, Ablageort und Meldungsfenster als Werten. `true`, wenn
/// diesmal gemeldet wurde (`false`: schon zuvor gemeldet – kein zweites Meldungsfenster).
fn report_failure_once(
    reported: &AtomicBool,
    location: Option<&LogLocation>,
    version: &str,
    detail: &str,
    dialog: impl FnOnce(&str, &str),
) -> bool {
    if reported.swap(true, Ordering::SeqCst) {
        return false;
    }
    let detail = single_line(detail, MAX_DETAIL_CHARS);
    eprintln!("AEGIS konnte nicht starten: {detail}");
    let logged = write_entry(location, version, LogKind::Failure, &detail);
    if let Err(reason) = &logged {
        eprintln!("AEGIS: Startprotokoll nicht geschrieben: {reason}");
    }
    let message = failure_message(
        &detail,
        logged.as_deref().map_err(String::as_str),
        Platform::current(),
    );
    dialog(DIALOG_TITLE, &message);
    true
}

/// Protokolliert eine Einschränkung beim Start (ohne Meldungsfenster).
pub fn log_notice(version: &str, detail: &str) {
    // Das Ergebnis meldet `log_notice_at` selbst auf stderr.
    let _ = log_notice_at(log_location().as_ref(), version, detail);
}

/// [`log_notice`] mit Ablageort als Wert; liefert den Ablageort oder den Grund des Scheiterns.
fn log_notice_at(
    location: Option<&LogLocation>,
    version: &str,
    detail: &str,
) -> Result<PathBuf, String> {
    eprintln!("AEGIS: {}", single_line(detail, MAX_DETAIL_CHARS));
    let logged = write_entry(location, version, LogKind::Notice, detail);
    if let Err(reason) = &logged {
        eprintln!("AEGIS: Startprotokoll nicht geschrieben: {reason}");
    }
    logged
}

/// Aktiviert die Meldung für Panics während des Starts (bis [`startup_finished`]).
/// Der bisherige Hook (Ausgabe auf stderr) läuft weiter, und zwar zuerst.
pub fn watch_startup_panics(version: String) {
    STARTING.store(true, Ordering::SeqCst);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        previous(info);
        if is_starting() {
            report_failure(&version, &panic_detail(info.payload(), info.location()));
        }
    }));
}

/// Läuft der Start noch (Panics gelten dann als Startfehler)?
pub fn is_starting() -> bool {
    STARTING.load(Ordering::SeqCst)
}

/// Nur für Tests: Startphase beginnen, ohne den prozessweiten Panic-Hook zu setzen (der
/// träfe sonst auch Panics paralleler Tests).
#[cfg(test)]
pub fn begin_startup_without_hook() {
    STARTING.store(true, Ordering::SeqCst);
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

    fn file_of(platform: Platform, vars: &[(&str, &Path)]) -> Option<PathBuf> {
        startup_log_location(platform, env_of(vars)).map(|location| location.file())
    }

    /// Ablageort wie unter Unix mit `XDG_STATE_HOME = base`.
    fn unix_location(base: &Path) -> LogLocation {
        startup_log_location(Platform::Unix, env_of(&[("XDG_STATE_HOME", base)])).unwrap()
    }

    /// Ablageort wie unter Windows mit `LOCALAPPDATA = base`.
    fn windows_location(base: &Path) -> LogLocation {
        startup_log_location(Platform::Windows, env_of(&[("LOCALAPPDATA", base)])).unwrap()
    }

    #[test]
    fn windows_pfad_unter_localappdata() {
        let base = abs("LocalAppData");
        assert_eq!(
            file_of(Platform::Windows, &[("LOCALAPPDATA", &base)]),
            Some(base.join("AEGIS").join("logs").join("startup.log"))
        );
        let location = windows_location(&base);
        assert_eq!(location.base(), base);
        assert_eq!(location.dir(), base.join("AEGIS").join("logs"));
    }

    #[test]
    fn windows_ohne_oder_mit_relativem_localappdata_kein_pfad() {
        assert_eq!(file_of(Platform::Windows, &[]), None);
        assert_eq!(
            file_of(Platform::Windows, &[("LOCALAPPDATA", Path::new("AppData"))]),
            None
        );
        assert_eq!(
            file_of(Platform::Windows, &[("LOCALAPPDATA", Path::new(""))]),
            None
        );
        // HOME zählt unter Windows nicht.
        assert_eq!(file_of(Platform::Windows, &[("HOME", &abs("home"))]), None);
    }

    #[test]
    fn windows_keine_netz_oder_geraetepfade() {
        for path in [
            r"\\server\share\AppData",
            r"\\?\C:\Users\x\AppData\Local",
            r"\\?\UNC\server\share",
            r"\\.\pipe\x",
            "//server/share",
            r"/\server\share",
        ] {
            assert_eq!(
                file_of(Platform::Windows, &[("LOCALAPPDATA", Path::new(path))]),
                None,
                "{path}"
            );
        }
        assert!(!is_remote_or_device(Path::new(r"C:\Users\x\AppData\Local")));
        assert!(!is_remote_or_device(Path::new("/home/x/.local/state")));
    }

    #[test]
    fn unix_bevorzugt_xdg_state_home() {
        let state = abs("state");
        let home = abs("home");
        assert_eq!(
            file_of(
                Platform::Unix,
                &[("XDG_STATE_HOME", &state), ("HOME", &home)]
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
        assert_eq!(file_of(Platform::Unix, &[("HOME", &home)]), expected);
        // Relatives XDG_STATE_HOME ist laut Spezifikation zu ignorieren.
        assert_eq!(
            file_of(
                Platform::Unix,
                &[("XDG_STATE_HOME", Path::new("state")), ("HOME", &home)]
            ),
            expected
        );
        assert_eq!(file_of(Platform::Unix, &[("HOME", Path::new("rel"))]), None);
        assert_eq!(file_of(Platform::Unix, &[]), None);
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
        // Zeilen- und Absatztrenner (U+2028/U+2029) und NEL brechen in vielen Editoren um.
        let separators = format_log_line(
            "t",
            "v",
            LogKind::Failure,
            "a\u{2028}t AEGIS v Startfehler: b\u{2029}c\u{85}d",
        );
        assert_eq!(separators, "t AEGIS v Startfehler: a t AEGIS v Startfehler: b c d\n");
        assert!(!separators.contains(['\u{2028}', '\u{2029}', '\u{85}']));
    }

    #[test]
    fn unsichtbare_formatzeichen_werden_sichtbar_markiert() {
        // RLO (U+202E) dreht den folgenden Text um: „Rechnung_<RLO>fdp.exe“ erschiene als „Rechnung_exe.pdf“.
        assert_eq!(
            single_line("Rechnung_\u{202E}fdp.exe", 100),
            "Rechnung_⟨U+202E⟩fdp.exe"
        );
        assert_eq!(
            single_line("\u{FEFF}C:\\x\u{200B}y\u{2066}z\u{2069}\u{AD}", 100),
            "⟨U+FEFF⟩C:\\x⟨U+200B⟩y⟨U+2066⟩z⟨U+2069⟩⟨U+00AD⟩"
        );
        assert_eq!(
            single_line("a\u{E0041}b\u{FE0F}c\u{061C}d", 100),
            "a⟨U+E0041⟩b⟨U+FE0F⟩c⟨U+061C⟩d"
        );
        // Ungewöhnliche Leerzeichen werden zu normalen.
        assert_eq!(single_line("a\u{A0}b\u{3000}c\u{202F}d", 100), "a b c d");
        // Normale Schrift bleibt unverändert (auch Umlaute, Gedankenstrich, Hebräisch).
        assert_eq!(
            single_line("Schließen – ÄÖÜ שלום", 100),
            "Schließen – ÄÖÜ שלום"
        );
        for c in [
            '\u{2028}', '\u{2029}', '\u{202A}', '\u{202B}', '\u{202C}', '\u{202D}', '\u{202E}',
            '\u{200B}', '\u{200E}', '\u{200F}', '\u{2066}', '\u{2067}', '\u{2068}', '\u{2069}',
            '\u{FEFF}',
        ] {
            let flat = single_line(&format!("x{c}y"), 100);
            assert!(!flat.contains(c), "U+{:04X} bleibt roh: {flat:?}", u32::from(c));
        }
        // Auch im Meldungsfenster.
        let text = failure_message("a\u{202E}b", Err("c\u{2028}d"), Platform::Windows);
        assert!(text.contains("a⟨U+202E⟩b"));
        assert!(text.contains("(c d)"));
        assert!(!text.contains(['\u{202E}', '\u{2028}']));
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
        let location = unix_location(dir.path());
        let path = append_line(&location, "erste\n").unwrap();
        assert_eq!(path, dir.path().join("aegis").join("logs").join(LOG_FILE_NAME));
        append_line(&location, "zweite\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "erste\nzweite\n");
    }

    #[test]
    fn fehlender_xdg_ordner_wird_angelegt_unter_windows_nie() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("state").join("tief");
        let path = append_line(&unix_location(&base), "x\n").unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), "x\n");

        // Windows: LOCALAPPDATA muss bestehen – AEGIS legt den Ordner des Nutzers nie an.
        let missing = dir.path().join("LocalAppData");
        let error = append_line(&windows_location(&missing), "x\n").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert!(!missing.exists());
        // Besteht er, entstehen darunter nur die eigenen Ordner.
        let base = aegis_core::testing::create_fixture_dir(dir.path(), "Local").unwrap();
        let path = append_line(&windows_location(&base), "y\n").unwrap();
        assert_eq!(path, base.join("AEGIS").join("logs").join(LOG_FILE_NAME));
    }

    #[test]
    fn vorhandener_inhalt_bleibt_erhalten() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_fixture(dir.path(), "aegis/logs/startup.log", b"alt\n").unwrap();
        append_line(&unix_location(dir.path()), "neu\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "alt\nneu\n");
    }

    #[test]
    fn volles_protokoll_bleibt_unveraendert() {
        let dir = tempfile::tempdir().unwrap();
        let full = vec![b'x'; usize::try_from(MAX_LOG_BYTES).unwrap()];
        let path = write_fixture(dir.path(), "aegis/logs/startup.log", &full).unwrap();
        let error = append_line(&unix_location(dir.path()), "neu\n").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(std::fs::read(&path).unwrap(), full);
    }

    #[test]
    fn ordner_an_der_stelle_der_datei_wird_verweigert() {
        let dir = tempfile::tempdir().unwrap();
        let path =
            aegis_core::testing::create_fixture_dir(dir.path(), "aegis/logs/startup.log").unwrap();
        let error = append_line(&unix_location(dir.path()), "neu\n").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(path.is_dir());
    }

    #[test]
    fn datei_an_der_stelle_eines_ordners_wird_verweigert() {
        let dir = tempfile::tempdir().unwrap();
        let logs = write_fixture(dir.path(), "aegis/logs", b"keine Ablage\n").unwrap();
        let error = append_line(&unix_location(dir.path()), "neu\n").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(std::fs::read_to_string(&logs).unwrap(), "keine Ablage\n");
    }

    #[cfg(unix)]
    #[test]
    fn link_an_der_stelle_der_datei_wird_nicht_verfolgt() {
        let dir = tempfile::tempdir().unwrap();
        let target = write_fixture(dir.path(), "fremd.txt", b"fremd\n").unwrap();
        aegis_core::testing::create_fixture_symlink(dir.path(), "aegis/logs/startup.log", &target)
            .unwrap();
        let error = append_line(&unix_location(dir.path()), "neu\n").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "fremd\n");
    }

    /// Ein Link an der Stelle eines AEGIS-eigenen Ordners lenkte das Schreiben sonst in einen
    /// fremden Ordner um (`create_dir_all` und `open` folgen Links in Zwischenordnern).
    #[cfg(unix)]
    #[test]
    fn link_an_der_stelle_eines_ordners_wird_nicht_verfolgt() {
        for linked in ["aegis", "aegis/logs"] {
            let dir = tempfile::tempdir().unwrap();
            let elsewhere = aegis_core::testing::create_fixture_dir(dir.path(), "woanders").unwrap();
            aegis_core::testing::create_fixture_symlink(dir.path(), linked, &elsewhere).unwrap();
            let error = append_line(&unix_location(dir.path()), "neu\n").unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput, "{linked}");
            assert_eq!(
                std::fs::read_dir(&elsewhere).unwrap().count(),
                0,
                "{linked}: im Ziel des Links entstand etwas"
            );
        }
    }

    /// Der Link wird erst nach der Prüfung eingeschoben (Wettlauf): Auch dann folgt das Öffnen
    /// ihm nicht – weder zu einer vorhandenen noch zu einer noch nicht vorhandenen Datei.
    #[cfg(unix)]
    #[test]
    fn oeffnen_folgt_keinem_link() {
        let dir = tempfile::tempdir().unwrap();
        let target = write_fixture(dir.path(), "fremd.txt", b"fremd\n").unwrap();
        let link = aegis_core::testing::create_fixture_symlink(dir.path(), "a.log", &target).unwrap();
        assert!(open_log(&link).is_err(), "Link zu vorhandener Datei verfolgt");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "fremd\n");

        let absent = dir.path().join("gibt-es-nicht.txt");
        let dangling =
            aegis_core::testing::create_fixture_symlink(dir.path(), "b.log", &absent).unwrap();
        assert!(open_log(&dangling).is_err(), "Link zu fehlender Datei verfolgt");
        assert!(!absent.exists(), "über den Link wurde eine Datei angelegt");
    }

    #[cfg(unix)]
    #[test]
    fn geoeffnete_datei_wird_am_handle_geprueft() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_fixture(dir.path(), "startup.log", b"alt\n").unwrap();
        let file = open_log(&path).unwrap();
        let opened = inspect_opened(&file, &path).unwrap();
        assert_eq!(
            opened,
            OpenedLog {
                regular_file: true,
                reparse_point: false,
                links: Some(1),
                same_as_path: Some(true),
                len: 4,
            }
        );
        assert!(check_opened(opened).is_ok());
        // Unter dem Pfad liegt inzwischen eine andere Datei (ausgetauscht nach dem Öffnen).
        let other = write_fixture(dir.path(), "anders.log", b"x\n").unwrap();
        assert_eq!(
            inspect_opened(&file, &other).unwrap().same_as_path,
            Some(false)
        );
    }

    #[test]
    fn handle_pruefung_verweigert_links_hardlinks_tausch_und_volle_datei() {
        let ok = OpenedLog {
            regular_file: true,
            reparse_point: false,
            links: Some(1),
            same_as_path: Some(true),
            len: 10,
        };
        assert!(check_opened(ok).is_ok());
        // Windows: Zahl der Links und Pfad-Vergleich unbekannt – das allein verweigert nicht.
        assert!(
            check_opened(OpenedLog {
                links: None,
                same_as_path: None,
                ..ok
            })
            .is_ok()
        );
        for (name, opened) in [
            (
                "keine Datei",
                OpenedLog {
                    regular_file: false,
                    ..ok
                },
            ),
            (
                "Analysepunkt",
                OpenedLog {
                    reparse_point: true,
                    ..ok
                },
            ),
            (
                "Hardlink",
                OpenedLog {
                    links: Some(2),
                    ..ok
                },
            ),
            (
                "ohne Namen",
                OpenedLog {
                    links: Some(0),
                    ..ok
                },
            ),
            (
                "ausgetauscht",
                OpenedLog {
                    same_as_path: Some(false),
                    ..ok
                },
            ),
            (
                "voll",
                OpenedLog {
                    len: MAX_LOG_BYTES,
                    ..ok
                },
            ),
        ] {
            let error = check_opened(opened).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput, "{name}");
        }
    }

    #[test]
    fn startfehler_wird_genau_einmal_gemeldet() {
        let dir = tempfile::tempdir().unwrap();
        let location = unix_location(dir.path());
        let reported = AtomicBool::new(false);
        let mut dialogs = Vec::new();
        assert!(report_failure_once(
            &reported,
            Some(&location),
            "0.1.0",
            "WebView2\nfehlt",
            |title, message| dialogs.push((title.to_owned(), message.to_owned())),
        ));
        assert!(!report_failure_once(
            &reported,
            Some(&location),
            "0.1.0",
            "zweiter Fehler",
            |title, message| dialogs.push((title.to_owned(), message.to_owned())),
        ));
        let log = std::fs::read_to_string(location.file()).unwrap();
        assert_eq!(log.lines().count(), 1, "{log}");
        assert!(log.contains(" AEGIS 0.1.0 Startfehler: WebView2 fehlt"), "{log}");
        assert_eq!(dialogs.len(), 1, "höchstens ein Meldungsfenster");
        let (title, message) = &dialogs[0];
        assert_eq!(title, DIALOG_TITLE);
        assert!(message.contains(&location.file().display().to_string()));
    }

    #[test]
    fn startfehler_ohne_ablageort_nennt_den_grund() {
        let reported = AtomicBool::new(false);
        let mut message = String::new();
        assert!(report_failure_once(
            &reported,
            None,
            "0.1.0",
            "kaputt",
            |_, text| message = text.to_owned(),
        ));
        assert!(message.contains("kein Ordner für das Protokoll bekannt"), "{message}");
    }

    #[test]
    fn hinweis_wird_protokolliert() {
        let dir = tempfile::tempdir().unwrap();
        let location = unix_location(dir.path());
        let path =
            log_notice_at(Some(&location), "0.1.0", "Symbol im Infobereich fehlt").unwrap();
        let log = std::fs::read_to_string(path).unwrap();
        assert!(log.ends_with(" AEGIS 0.1.0 Hinweis: Symbol im Infobereich fehlt\n"), "{log}");
        assert_eq!(
            log_notice_at(None, "0.1.0", "x").unwrap_err(),
            "kein Ordner für das Protokoll bekannt"
        );
    }

    #[test]
    fn pfad_ohne_ordner_wird_verweigert() {
        for base in ["", "relativ"] {
            let location = LogLocation {
                base: PathBuf::from(base),
                own: ["aegis", "logs"],
                create_base: true,
            };
            let error = append_line(&location, "x\n").unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput, "{base:?}");
        }
        assert!(!Path::new("relativ").exists());
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
