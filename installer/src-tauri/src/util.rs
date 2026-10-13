//! Kleine Helfer: Sprache, Zeit, Zufall, Kommandozeilen-Quoting, Protokoll.

use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// Systemsprache für Meldungen: `de` oder `en`.
pub fn lang() -> &'static str {
    static LANG: OnceLock<&'static str> = OnceLock::new();
    LANG.get_or_init(|| if crate::platform::system_lang_is_german() { "de" } else { "en" })
}

/// Wählt den deutschen oder englischen Text passend zur Systemsprache.
pub fn tr(de: &str, en: &str) -> String {
    if lang() == "de" { de.to_string() } else { en.to_string() }
}

pub fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Tage seit 1970-01-01 -> (Jahr, Monat, Tag). Algorithmus von Howard Hinnant.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Zeitstempel im Format `2026-10-12T12:00:00Z` (UTC).
pub fn rfc3339_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

pub fn now_rfc3339() -> String {
    rfc3339_utc(unix_now())
}

/// Datum im Format `YYYYMMDD` (für `InstallDate`).
pub fn today_yyyymmdd() -> String {
    let (y, m, d) = civil_from_days((unix_now() / 86_400) as i64);
    format!("{y:04}{m:02}{d:02}")
}

/// Kurzer, ausreichend eindeutiger Zufallsanteil für temporäre Dateinamen.
pub fn random_suffix() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut h = RandomState::new().build_hasher();
    h.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    h.write_u32(std::process::id());
    format!("{:012x}", h.finish() & 0xffff_ffff_ffff)
}

/// Quoting eines Arguments nach den Regeln von `CommandLineToArgvW` / MSVC-CRT.
pub fn quote_windows_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.chars().any(|c| matches!(c, ' ' | '\t' | '\n' | '\u{b}' | '"')) {
        return arg.to_string();
    }
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
    out
}

pub fn join_windows_args(args: &[String]) -> String {
    args.iter().map(|a| quote_windows_arg(a)).collect::<Vec<_>>().join(" ")
}

/// Rein lexikalische Normalisierung (`.` und `..` auflösen), ohne das Dateisystem zu fragen.
pub fn lexical_normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                // Nie über die Wurzel hinaus.
                let is_root_only = out.components().all(|c| matches!(c, Component::Prefix(_) | Component::RootDir));
                if !is_root_only {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Kanonische Vergleichsform: unter Windows ohne `\\?\`-Präfix, ohne Groß-/Kleinschreibung.
fn comparable(p: &Path) -> String {
    let c = std::fs::canonicalize(p).unwrap_or_else(|_| lexical_normalize(p));
    let s = c.to_string_lossy().into_owned();
    if cfg!(windows) {
        let s = if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{rest}")
        } else {
            s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
        };
        s.replace('/', "\\").trim_end_matches('\\').to_lowercase()
    } else {
        s
    }
}

/// Vergleicht zwei Pfade (unter Windows ohne Groß-/Kleinschreibung), kanonisch wenn möglich.
pub fn same_path(a: &Path, b: &Path) -> bool {
    comparable(a) == comparable(b)
}

/// Wiederholt eine Dateioperation kurz, wenn Windows die Datei noch sperrt
/// (gerade beendeter Prozess, Virenscanner). Andere Fehler werden sofort gemeldet.
pub fn retry_io<T>(mut op: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    let mut attempt = 0;
    loop {
        match op() {
            Ok(v) => return Ok(v),
            Err(e) => {
                // 5 = ERROR_ACCESS_DENIED, 32 = ERROR_SHARING_VIOLATION, 33 = ERROR_LOCK_VIOLATION
                let transient = cfg!(windows)
                    && (e.kind() == std::io::ErrorKind::PermissionDenied || matches!(e.raw_os_error(), Some(5 | 32 | 33)));
                if !transient || attempt >= 12 {
                    return Err(e);
                }
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
        }
    }
}

/// Liegt `child` innerhalb von `parent` (oder ist gleich)?
pub fn path_starts_with(child: &Path, parent: &Path) -> bool {
    let c = lexical_normalize(child);
    let p = lexical_normalize(parent);
    if cfg!(windows) {
        let cs = c.to_string_lossy().to_lowercase().replace('/', "\\");
        let ps = p.to_string_lossy().to_lowercase().replace('/', "\\");
        let ps = ps.trim_end_matches('\\');
        cs == ps || cs.starts_with(&format!("{ps}\\"))
    } else {
        c.starts_with(&p)
    }
}

/// Anzeigeform eines Pfades.
pub fn display_path(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn log_path() -> PathBuf {
    std::env::temp_dir().join("pulsar-setup.log")
}

/// Schreibt eine Zeile ins Setup-Protokoll (`%TEMP%\pulsar-setup.log`). Fehler werden ignoriert.
pub fn log(msg: impl AsRef<str>) {
    let path = log_path();
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 1024 * 1024 {
            let _ = std::fs::remove_file(&path);
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{} [{}] {}", now_rfc3339(), std::process::id(), msg.as_ref());
    }
}

/// Gibt eine Zeile auf stderr aus, ohne bei fehlender Konsole in Panik zu geraten.
pub fn eprint_line(msg: impl AsRef<str>) {
    let _ = writeln!(std::io::stderr(), "{}", msg.as_ref());
}
