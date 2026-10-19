//! Notfall-Scan („PANIC-BUTTON“, P5): prüft sofort die Orte, an denen sich Schadsoftware
//! meist festsetzt – Autostarts, Downloads, Desktop, `%TEMP%`, AppData und die laufenden
//! eigenen Programme samt Speicher – und stößt ein Signatur-Update an.
//!
//! **Nur lesend.** Isolieren ist danach ein eigener Vorschlag (alle gewählten Funde in einem
//! Plan), „Alles rückgängig machen“ ebenfalls. Gelesen wird ausschließlich mit den Rechten des
//! anfragenden Nutzers; geprüft wird im eingeschränkten Prüfprozess.

use std::path::{Path, PathBuf};

use aegis_core::risk::RiskLevel;
use aegis_engine::Finding;
use aegis_quarantine::UserAccess;
use serde::Serialize;

use crate::protocol::Response;
use crate::worker::Scanner;

/// Höchstzahl Dateien, die aus AppData gesammelt werden.
pub const MAX_APPDATA_FILES: usize = 20_000;
/// Höchste Ordnertiefe in AppData.
pub const MAX_APPDATA_DEPTH: usize = 12;
/// Höchstzahl Funde je Bereich in der Antwort.
const MAX_FINDINGS_PER_AREA: usize = 500;

/// Endungen, die in AppData geprüft werden (ausführbare Dateien, Skripte, Verknüpfungen).
pub const RISKY_EXTENSIONS: [&str; 22] = [
    "exe", "dll", "scr", "com", "pif", "cpl", "ocx", "sys", "bat", "cmd", "ps1", "psm1", "vbs",
    "vbe", "js", "jse", "wsf", "hta", "lnk", "msi", "jar", "url",
];

/// Ordner in AppData, die nur Zwischenspeicher von Browsern/Apps enthalten.
const NOISY_DIRS: [&str; 8] = [
    "cache",
    "code cache",
    "gpucache",
    "cachestorage",
    "service worker",
    "indexeddb",
    "crashpad",
    "webcache",
];

/// Ein geprüfter Bereich.
#[derive(Debug, Clone, Serialize)]
pub struct EmergencyArea {
    /// `autostart` | `downloads` | `desktop` | `temp` | `appdata` | `processes` | `memory`.
    pub id: &'static str,
    /// Geprüfte Dateien bzw. Speicherbereiche.
    pub checked: usize,
    /// Auffällige Funde (über „Info“ oder nicht prüfbar), höchstens 500.
    pub findings: Vec<Finding>,
    /// Übersprungen (Links, Grenzen, Lesefehler).
    pub skipped: usize,
    /// Hinweis (z. B. „Ordner fehlt“, „Grenze erreicht“).
    pub note: Option<String>,
}

/// Fund im Arbeitsspeicher mit dem Programm, zu dem er gehört (zum Beenden).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MemoryHit {
    /// Prozess-ID.
    pub pid: u32,
    /// Programmdatei (falls noch lesbar).
    pub program: Option<PathBuf>,
}

/// Prozess-ID aus einer Speicher-Bezeichnung „Speicher von … (PID 7) @ 0x…“.
#[must_use]
pub fn pid_of_label(label: &str) -> Option<u32> {
    let start = label.rfind("(PID ")? + 5;
    let rest = label.get(start..)?;
    let end = rest.find(')')?;
    rest.get(..end)?.parse().ok()
}

/// Umgebung zum Auflösen von `%VAR%` in Autostart-Befehlen: Systemorte aus dem Dienst,
/// Nutzerorte aus dem Profil des anfragenden Kontos.
#[derive(Debug, Clone, Default)]
pub struct PathEnv {
    /// `(Name in Großbuchstaben, Wert)`.
    pub vars: Vec<(String, PathBuf)>,
}

impl PathEnv {
    /// Umgebung für ein Profil (Windows: System-Variablen des Dienstes).
    #[must_use]
    pub fn for_profile(profile: Option<&Path>) -> Self {
        let mut vars = Vec::new();
        for name in [
            "SYSTEMROOT",
            "WINDIR",
            "PROGRAMFILES",
            "PROGRAMFILES(X86)",
            "PROGRAMW6432",
            "COMMONPROGRAMFILES",
            "PROGRAMDATA",
            "ALLUSERSPROFILE",
            "SYSTEMDRIVE",
        ] {
            if let Some(v) = std::env::var_os(name) {
                vars.push((name.to_owned(), PathBuf::from(v)));
            }
        }
        if let Some(p) = profile {
            vars.push(("USERPROFILE".into(), p.to_path_buf()));
            vars.push(("APPDATA".into(), p.join("AppData").join("Roaming")));
            vars.push(("LOCALAPPDATA".into(), p.join("AppData").join("Local")));
            let temp = p.join("AppData").join("Local").join("Temp");
            vars.push(("TEMP".into(), temp.clone()));
            vars.push(("TMP".into(), temp));
        }
        Self { vars }
    }

    fn expand(&self, text: &str) -> Option<String> {
        let mut out = String::new();
        let mut rest = text;
        while let Some(start) = rest.find('%') {
            out.push_str(&rest[..start]);
            let after = &rest[start + 1..];
            let end = after.find('%')?;
            let name = after[..end].to_ascii_uppercase();
            let value = self.vars.iter().find(|(n, _)| *n == name)?;
            out.push_str(&value.1.to_string_lossy());
            rest = &after[end + 1..];
        }
        out.push_str(rest);
        Some(out)
    }
}

fn is_absolute_windows_or_native(path: &str) -> bool {
    let b = path.as_bytes();
    Path::new(path).is_absolute()
        || (b.len() > 2
            && b[0].is_ascii_alphabetic()
            && b[1] == b':'
            && matches!(b[2], b'\\' | b'/'))
}

/// Programmdateien aus einem Autostart-Befehl (z. B. `"C:\x\a.exe" /min`,
/// `%APPDATA%\b.exe`, `rundll32.exe C:\y\c.dll,Start`). Nur absolute Pfade nach dem Auflösen;
/// unbekannte Variablen oder relative Namen ergeben nichts.
#[must_use]
pub fn command_paths(command: &str, env: &PathEnv) -> Vec<PathBuf> {
    let Some(expanded) = env.expand(command.trim()) else {
        return Vec::new();
    };
    let text = expanded.trim();
    let (program, args) = if let Some(quoted) = text.strip_prefix('"') {
        match quoted.find('"') {
            Some(end) => (&quoted[..end], quoted[end + 1..].trim()),
            None => (quoted, ""),
        }
    } else {
        let lower = text.to_ascii_lowercase();
        let cut = [".exe", ".com", ".bat", ".cmd", ".scr"]
            .iter()
            .filter_map(|ext| lower.find(ext).map(|i| i + ext.len()))
            .min()
            .filter(|i| text.as_bytes().get(*i).is_none_or(|b| *b == b' '));
        match cut {
            Some(i) => (&text[..i], text[i..].trim()),
            None => match text.split_once(' ') {
                Some((p, a)) => (p, a.trim()),
                None => (text, ""),
            },
        }
    };
    let mut out = Vec::new();
    if is_absolute_windows_or_native(program) {
        out.push(PathBuf::from(program));
    }
    // rundll32/regsvr32: Die eigentliche Bibliothek steht im Argument.
    let name = program
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(program)
        .to_ascii_lowercase();
    if matches!(
        name.as_str(),
        "rundll32.exe" | "rundll32" | "regsvr32.exe" | "regsvr32"
    ) {
        let arg = args
            .split_whitespace()
            .find(|a| !a.starts_with('/') && !a.starts_with('-'))
            .unwrap_or("")
            .trim_matches('"');
        let lib = arg.split(',').next().unwrap_or("");
        if is_absolute_windows_or_native(lib) {
            out.push(PathBuf::from(lib));
        }
    }
    out
}

/// Sammelt riskante Dateien unter `root` (ohne Links zu folgen, laute Zwischenspeicher
/// ausgelassen). Im Identitätswechsel aufrufen. Liefert `(Dateien, Grenze erreicht)`.
#[must_use]
pub fn collect_risky(root: &Path, max: usize) -> (Vec<PathBuf>, bool) {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                if depth < MAX_APPDATA_DEPTH && !NOISY_DIRS.contains(&name.as_str()) {
                    stack.push((path, depth + 1));
                }
            } else if kind.is_file()
                && path
                    .extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| RISKY_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
            {
                if out.len() >= max {
                    return (out, true);
                }
                out.push(path);
            }
        }
    }
    (out, false)
}

fn notable(findings: Vec<Finding>) -> Vec<Finding> {
    let mut out: Vec<Finding> = findings
        .into_iter()
        .filter(|f| f.risk > RiskLevel::Info || f.not_scannable.is_some())
        .collect();
    out.sort_by_key(|f| std::cmp::Reverse(f.risk));
    out.truncate(MAX_FINDINGS_PER_AREA);
    out
}

fn folder_area(
    id: &'static str,
    folders: &[PathBuf],
    scanner: &Scanner,
    user: &dyn UserAccess,
) -> EmergencyArea {
    let existing: Vec<PathBuf> = {
        let Ok(_scope) = user.enter() else {
            return missing(id, "Rechte des Nutzers nicht übernehmbar");
        };
        folders.iter().filter(|f| f.is_dir()).cloned().collect()
    };
    if existing.is_empty() {
        return missing(id, "Ordner nicht vorhanden");
    }
    match scanner.scan(&existing, user) {
        Ok(report) => EmergencyArea {
            id,
            checked: report.findings.len(),
            skipped: report.skipped.len(),
            note: report
                .truncated
                .then(|| "Grenze erreicht – nicht alles geprüft".to_owned()),
            findings: notable(report.findings),
        },
        Err(e) => missing(id, &e),
    }
}

fn files_area(
    id: &'static str,
    files: &[PathBuf],
    scanner: &Scanner,
    user: &dyn UserAccess,
    note: Option<String>,
) -> EmergencyArea {
    let mut findings = Vec::new();
    let mut skipped = 0;
    for chunk in files.chunks(200) {
        match scanner.examine(chunk, user) {
            Ok(found) => findings.extend(found),
            Err(_) => skipped += chunk.len(),
        }
    }
    EmergencyArea {
        id,
        checked: files.len() - skipped,
        skipped,
        note,
        findings: notable(findings),
    }
}

fn missing(id: &'static str, why: &str) -> EmergencyArea {
    EmergencyArea {
        id,
        checked: 0,
        findings: Vec::new(),
        skipped: 0,
        note: Some(why.to_owned()),
    }
}

/// Autostart-Befehle des Kontos und des Rechners (nur lesen).
#[cfg(windows)]
fn autostart_commands(user: &dyn UserAccess) -> Vec<String> {
    use aegis_winffi::inspect::{AUTOSTART_KEYS, Hive, read_values};
    let mut hives = vec![Hive::LocalMachine];
    if let Some(sid) = user.identity() {
        hives.push(Hive::User(sid));
    }
    let mut out = Vec::new();
    for hive in &hives {
        // Nur die Run-Schlüssel (Befehle); Winlogon/Active Setup prüft P6 im Einzelnen.
        for key in AUTOSTART_KEYS.iter().take(4) {
            out.extend(read_values(hive, key).into_iter().map(|v| v.data));
        }
    }
    out
}

#[cfg(not(windows))]
fn autostart_commands(_user: &dyn UserAccess) -> Vec<String> {
    Vec::new()
}

/// Der Notfall-Scan. Ohne Dienst-Sperre aufrufen (dauert). `update_note` beschreibt, ob ein
/// Signatur-Update angestoßen wurde.
pub fn emergency_scan(scanner: &Scanner, user: &dyn UserAccess, update_note: String) -> Response {
    let Some(profile) = user.profile().map(crate::watch::long_name) else {
        return Response::error("scan", "Kein Benutzerprofil – Notfall-Scan nicht möglich");
    };
    let env = PathEnv::for_profile(Some(&profile));
    let mut areas = Vec::new();

    // 1. Autostarts: Programme aus den Run-Schlüsseln + Autostart-Ordner.
    let mut files: Vec<PathBuf> = Vec::new();
    for cmd in autostart_commands(user) {
        for p in command_paths(&cmd, &env) {
            if !files.iter().any(|f| crate::paths::same_path(f, &p)) {
                files.push(p);
            }
        }
    }
    let startup_dirs = [
        profile.join(r"AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup"),
        env.vars
            .iter()
            .find(|(n, _)| n == "PROGRAMDATA")
            .map(|(_, p)| p.join(r"Microsoft\Windows\Start Menu\Programs\StartUp"))
            .unwrap_or_default(),
    ];
    {
        if let Ok(_scope) = user.enter() {
            for dir in startup_dirs.iter().filter(|d| d.is_dir()) {
                if let Ok(entries) = std::fs::read_dir(dir) {
                    for e in entries.flatten().take(500) {
                        if e.file_type().is_ok_and(|t| t.is_file()) {
                            files.push(e.path());
                        }
                    }
                }
            }
            files.retain(|f| f.is_file());
        }
    }
    files.truncate(2000);
    areas.push(files_area("autostart", &files, scanner, user, None));

    // 2. Downloads, Desktop, %TEMP% vollständig.
    areas.push(folder_area(
        "downloads",
        &[profile.join("Downloads")],
        scanner,
        user,
    ));
    areas.push(folder_area(
        "desktop",
        &[profile.join("Desktop")],
        scanner,
        user,
    ));
    let temp = profile.join("AppData").join("Local").join("Temp");
    areas.push(folder_area(
        "temp",
        std::slice::from_ref(&temp),
        scanner,
        user,
    ));

    // 3. AppData: nur ausführbare Dateien, Skripte, Verknüpfungen (ohne Temp, ohne Caches).
    let (appdata, truncated) = match user.enter() {
        Ok(_scope) => {
            let mut all = Vec::new();
            let mut cut = false;
            for root in [
                profile.join("AppData").join("Roaming"),
                profile.join("AppData").join("Local"),
                profile.join("AppData").join("LocalLow"),
            ] {
                let (found, limit) = collect_risky(&root, MAX_APPDATA_FILES - all.len());
                all.extend(found.into_iter().filter(|p| !p.starts_with(&temp)));
                cut |= limit;
            }
            (all, cut)
        }
        Err(_) => (Vec::new(), false),
    };
    areas.push(files_area(
        "appdata",
        &appdata,
        scanner,
        user,
        truncated.then(|| format!("Mehr als {MAX_APPDATA_FILES} Dateien – Rest nicht geprüft")),
    ));

    // 4. Laufende eigene Programme samt Speicher (wie der Speicher-Scan).
    let mut memory_hits = Vec::new();
    match crate::handler::memory_scan(scanner, user) {
        Response::MemoryScan {
            report,
            processes,
            modules,
            regions,
        } => {
            let (in_memory, on_disk): (Vec<Finding>, Vec<Finding>) =
                report.findings.into_iter().partition(|f| {
                    f.sha256.is_none() && pid_of_label(&f.path.to_string_lossy()).is_some()
                });
            for f in &in_memory {
                let pid = pid_of_label(&f.path.to_string_lossy()).unwrap_or(0);
                memory_hits.push(MemoryHit {
                    pid,
                    program: program_of(pid, user),
                });
            }
            areas.push(EmergencyArea {
                id: "processes",
                checked: modules,
                skipped: report.skipped.len(),
                note: Some(format!("{processes} eigene Programme")),
                findings: notable(on_disk),
            });
            areas.push(EmergencyArea {
                id: "memory",
                checked: regions,
                skipped: 0,
                note: None,
                findings: in_memory,
            });
        }
        Response::Error { message, .. } => areas.push(missing("processes", &message)),
        _ => areas.push(missing("processes", "unerwartete Antwort")),
    }

    Response::EmergencyScan {
        areas,
        memory: memory_hits,
        update: update_note,
    }
}

#[cfg(windows)]
fn program_of(pid: u32, user: &dyn UserAccess) -> Option<PathBuf> {
    let _scope = user.enter().ok()?;
    aegis_winffi::system::process_image_path(pid).ok()
}

#[cfg(not(windows))]
fn program_of(_pid: u32, _user: &dyn UserAccess) -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> PathEnv {
        PathEnv {
            vars: vec![
                (
                    "APPDATA".into(),
                    PathBuf::from(r"C:\Users\a\AppData\Roaming"),
                ),
                ("SYSTEMROOT".into(), PathBuf::from(r"C:\Windows")),
            ],
        }
    }

    #[test]
    fn befehle_werden_zu_programmen() {
        let e = env();
        assert_eq!(
            command_paths(r#""C:\Program Files\X\x.exe" /min"#, &e),
            vec![PathBuf::from(r"C:\Program Files\X\x.exe")]
        );
        assert_eq!(
            command_paths(r"%APPDATA%\upd\svc.exe -k", &e),
            vec![PathBuf::from(r"C:\Users\a\AppData\Roaming\upd\svc.exe")]
        );
        assert_eq!(
            command_paths(r"C:\Program Files\Y App\y.exe --tray", &e),
            vec![PathBuf::from(r"C:\Program Files\Y App\y.exe")]
        );
        assert_eq!(
            command_paths(
                r"%SystemRoot%\system32\rundll32.exe C:\Users\a\x.dll,Start",
                &e
            ),
            vec![
                PathBuf::from(r"C:\Windows\system32\rundll32.exe"),
                PathBuf::from(r"C:\Users\a\x.dll"),
            ]
        );
        assert!(command_paths("ctfmon.exe", &e).is_empty(), "relativ");
        assert!(command_paths(r"%UNBEKANNT%\x.exe", &e).is_empty());
        assert!(command_paths(r"%APPDATA", &e).is_empty());
    }

    #[test]
    fn pid_aus_der_bezeichnung() {
        assert_eq!(
            pid_of_label(r"Speicher von C:\x\t.exe (PID 7) @ 0x1000"),
            Some(7)
        );
        assert_eq!(pid_of_label("Speicher von x (PID abc) @ 0x1"), None);
        assert_eq!(pid_of_label(r"C:\x\t.exe"), None);
    }

    #[test]
    fn sammelt_nur_riskante_dateien_ohne_caches() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        aegis_core::testing::write_fixture(root, "App/run.exe", b"x").unwrap();
        aegis_core::testing::write_fixture(root, "App/readme.txt", b"x").unwrap();
        aegis_core::testing::write_fixture(root, "App/Cache/evil.js", b"x").unwrap();
        aegis_core::testing::write_fixture(root, "App/deep/s.PS1", b"x").unwrap();
        let (mut files, cut) = collect_risky(root, 100);
        files.sort();
        assert!(!cut);
        assert_eq!(
            files,
            vec![root.join("App/deep/s.PS1"), root.join("App/run.exe")]
        );
        let (files, cut) = collect_risky(root, 1);
        assert_eq!(files.len(), 1);
        assert!(cut);
    }
}
