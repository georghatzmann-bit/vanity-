//! ClamAV-Anbindung – **nur als getrennter Prozess** (ClamAV steht unter GPL und wird nie
//! eingelinkt). AEGIS ruft `clamdscan` (schnell, mit laufendem clamd) oder `clamscan` auf und
//! wertet nur die Ausgabe aus. Der Aufruf verändert nichts: ohne `--remove`/`--move`.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use aegis_core::risk::RiskLevel;

use crate::finding::{Reason, Source, Weight};

/// Ergebnis eines ClamAV-Laufs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClamResult {
    /// Keine Signatur gefunden.
    Clean,
    /// Gefundene Signaturnamen.
    Found(Vec<String>),
    /// ClamAV meldete einen Fehler (Datei nicht lesbar, Datenbank fehlt …).
    Error(String),
}

/// Standard-Zeitlimit für einen ClamAV-Lauf.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
/// Höchstens so viel Ausgabe wird gelesen.
const MAX_OUTPUT: u64 = 1024 * 1024;

/// Ein gefundenes ClamAV-Programm.
#[derive(Debug, Clone)]
pub struct ClamAv {
    program: PathBuf,
    timeout: Duration,
}

impl ClamAv {
    /// Programm mit festem, absolutem Pfad (z. B. aus den Einstellungen); relative Pfade
    /// werden abgelehnt (`None`).
    #[must_use]
    pub fn with_program(program: PathBuf) -> Option<Self> {
        program.is_absolute().then_some(Self {
            program,
            timeout: DEFAULT_TIMEOUT,
        })
    }

    /// Anderes Zeitlimit.
    #[must_use]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Pfad des Programms.
    #[must_use]
    pub fn program(&self) -> &Path {
        &self.program
    }

    /// Feste Installationsorte – **nicht** der Suchpfad (`PATH`): Der Dienst läuft als
    /// SYSTEM, ein beschreibbarer Ordner im Suchpfad würde sonst fremden Code mit
    /// SYSTEM-Rechten starten. Windows: `%ProgramFiles%\ClamAV` (nur Administratoren
    /// schreibbar). Unix (Entwicklung): `/usr/bin`, `/usr/local/bin`.
    #[must_use]
    pub fn locate() -> Option<Self> {
        let dirs: Vec<PathBuf> = if cfg!(windows) {
            std::env::var_os("ProgramFiles")
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
                .map(|pf| vec![pf.join("ClamAV")])
                .unwrap_or_default()
        } else {
            vec![PathBuf::from("/usr/bin"), PathBuf::from("/usr/local/bin")]
        };
        Self::locate_in(&dirs)
    }

    /// Sucht `clamdscan`/`clamscan` in den angegebenen (absoluten) Ordnern.
    #[must_use]
    pub fn locate_in(dirs: &[PathBuf]) -> Option<Self> {
        let exe = if cfg!(windows) { ".exe" } else { "" };
        for name in ["clamdscan", "clamscan"] {
            for dir in dirs.iter().filter(|d| d.is_absolute()) {
                let candidate = dir.join(format!("{name}{exe}"));
                if candidate.is_file() {
                    return Self::with_program(candidate);
                }
            }
        }
        None
    }

    /// Argumente: Inhalt kommt über die Standardeingabe (`-`). ClamAV liest so keine Pfade
    /// selbst – es sieht nur, was AEGIS mit den Rechten des Nutzers lesen durfte.
    #[must_use]
    pub fn arguments() -> Vec<std::ffi::OsString> {
        vec!["--no-summary".into(), "--stdout".into(), "-".into()]
    }

    /// Prüft eine Datei: öffnet sie selbst (mit den aktuellen Rechten) und reicht den Inhalt
    /// an ClamAV weiter. Bricht nach dem Zeitlimit ab.
    #[must_use]
    pub fn scan(&self, target: &Path) -> ClamResult {
        match File::open(target) {
            Ok(file) => self.scan_reader(file),
            Err(e) => ClamResult::Error(format!("Datei nicht lesbar: {e}")),
        }
    }

    /// Prüft Daten aus einem Leser.
    #[must_use]
    pub fn scan_reader<R: Read + Send + 'static>(&self, mut input: R) -> ClamResult {
        // Startet ClamAV als getrennten Prozess, nur lesend (kein --remove/--move); der
        // Inhalt kommt über die Standardeingabe.
        // aegis-mutation: engine-clamav-scan
        #[allow(clippy::disallowed_methods)]
        let spawned = Command::new(&self.program)
            .args(Self::arguments())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => {
                return ClamResult::Error(format!("ClamAV konnte nicht gestartet werden: {e}"));
            }
        };
        let stdin = child.stdin.take();
        let feeder = std::thread::spawn(move || {
            if let Some(mut stdin) = stdin {
                // Abbruch durch ClamAV (z. B. Fund vor Dateiende) ist kein Fehler.
                let _ = std::io::copy(&mut input, &mut stdin);
            }
        });
        let stdout = child.stdout.take();
        let collector = std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(out) = stdout {
                let _ = out.take(MAX_OUTPUT).read_to_string(&mut text);
            }
            text
        });
        let deadline = Instant::now() + self.timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Ok(None) | Err(_) => {
                    // Eigenen, hängenden ClamAV-Prozess beenden (Zeitlimit) – kein Nutzerprozess.
                    // aegis-mutation: engine-clamav-timeout
                    #[allow(clippy::disallowed_methods)]
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
            }
        };
        match status {
            Some(status) => {
                let _ = feeder.join();
                parse_output(&collector.join().unwrap_or_default(), status.code())
            }
            // Nicht auf die Hilfs-Threads warten: Ein Enkelprozess könnte die Pipes noch
            // offen halten. Sie enden, sobald die Pipes schließen.
            None => ClamResult::Error(format!(
                "ClamAV hat das Zeitlimit von {} s überschritten",
                self.timeout.as_secs()
            )),
        }
    }
}

/// Wertet die Ausgabe aus. Exit-Code 0 = sauber, 1 = Fund, sonst Fehler.
#[must_use]
pub fn parse_output(stdout: &str, exit_code: Option<i32>) -> ClamResult {
    let found: Vec<String> = stdout
        .lines()
        .filter_map(|l| l.trim_end().strip_suffix(" FOUND"))
        .filter_map(|l| l.rsplit_once(": ").map(|(_, sig)| sig.trim().to_owned()))
        .filter(|s| !s.is_empty())
        .collect();
    match exit_code {
        Some(0) => ClamResult::Clean,
        Some(1) if !found.is_empty() => ClamResult::Found(found),
        Some(code) => ClamResult::Error(format!(
            "ClamAV meldet Code {code}: {}",
            stdout.lines().last().unwrap_or("").trim()
        )),
        None => ClamResult::Error("ClamAV wurde abgebrochen.".to_owned()),
    }
}

/// Begründungen zu einem Fund. „PUA“-Signaturen gelten als Tool mit Risiko.
#[must_use]
pub fn reasons(result: &ClamResult) -> Vec<Reason> {
    match result {
        ClamResult::Found(sigs) => sigs
            .iter()
            .map(|sig| {
                let pua = sig.starts_with("PUA.");
                let level = if pua {
                    RiskLevel::RiskyTool
                } else {
                    RiskLevel::Dangerous
                };
                Reason::new(
                    &format!("clamav.{}", if pua { "pua" } else { "signature" }),
                    Source::ClamAv {
                        signature: sig.clone(),
                    },
                    Weight::Definite(level),
                    &format!("ClamAV erkennt die Signatur „{sig}“."),
                    &format!("ClamAV detects the signature \"{sig}\"."),
                )
            })
            .collect(),
        ClamResult::Clean | ClamResult::Error(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ausgabe_auswerten() {
        assert_eq!(parse_output("", Some(0)), ClamResult::Clean);
        let out = "/tmp/a b/eicar.com: Win.Test.EICAR_HDB-1 FOUND\n";
        assert_eq!(
            parse_output(out, Some(1)),
            ClamResult::Found(vec!["Win.Test.EICAR_HDB-1".into()])
        );
        assert!(matches!(
            parse_output("LibClamAV Error: x", Some(2)),
            ClamResult::Error(_)
        ));
        assert!(matches!(parse_output("", None), ClamResult::Error(_)));
        assert!(matches!(parse_output("", Some(1)), ClamResult::Error(_)));
    }

    #[test]
    fn pua_ist_tool_mit_risiko() {
        let r = reasons(&ClamResult::Found(vec![
            "PUA.Win.Tool.X".into(),
            "Win.Trojan.Y".into(),
        ]));
        assert_eq!(r[0].weight, Weight::Definite(RiskLevel::RiskyTool));
        assert_eq!(r[1].weight, Weight::Definite(RiskLevel::Dangerous));
        assert!(reasons(&ClamResult::Clean).is_empty());
    }

    #[test]
    fn argumente_ohne_pfad_und_ohne_veraenderung() {
        let args = ClamAv::arguments();
        assert_eq!(args, ["--no-summary", "--stdout", "-"]);
        assert!(!args.iter().any(|a| a.to_string_lossy().contains("remove")));
    }

    #[test]
    fn nur_absolute_feste_orte() {
        assert!(ClamAv::with_program(PathBuf::from("clamscan")).is_none());
        assert!(ClamAv::locate_in(&[PathBuf::from("relativ")]).is_none());
    }

    /// Harmloser Ersatz für ClamAV (Shell-Skript): meldet „FOUND“ für jede Eingabe bzw.
    /// hängt – prüft Auswertung, Standardeingabe und Zeitlimit ohne echtes ClamAV.
    #[cfg(unix)]
    #[test]
    fn ersatzprogramm_fund_und_zeitlimit() {
        use aegis_core::testing::write_fixture;
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let found = write_fixture(
            dir.path(),
            "clamscan",
            b"#!/bin/sh\ncat > /dev/null\necho 'stdin: Test.Sig FOUND'\nexit 1\n",
        )
        .unwrap();
        let hang = write_fixture(dir.path(), "hang", b"#!/bin/sh\nsleep 30\n").unwrap();
        for p in [&found, &hang] {
            aegis_core::testing::set_fixture_mode(
                dir.path(),
                p.file_name().unwrap().to_str().unwrap(),
                0o700,
            )
            .unwrap();
            assert_eq!(
                std::fs::metadata(p).unwrap().permissions().mode() & 0o700,
                0o700
            );
        }
        let clam = ClamAv::locate_in(&[dir.path().to_path_buf()]).unwrap();
        assert_eq!(
            clam.scan_reader(std::io::Cursor::new(b"abc".to_vec())),
            ClamResult::Found(vec!["Test.Sig".into()])
        );
        let slow = ClamAv::with_program(hang)
            .unwrap()
            .with_timeout(Duration::from_millis(200));
        let started = Instant::now();
        assert!(
            matches!(slow.scan_reader(std::io::empty()), ClamResult::Error(e) if e.contains("Zeitlimit"))
        );
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
