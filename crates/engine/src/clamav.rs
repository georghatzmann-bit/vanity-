//! ClamAV-Anbindung – **nur als getrennter Prozess** (ClamAV steht unter GPL und wird nie
//! eingelinkt). AEGIS ruft `clamdscan` (schnell, mit laufendem clamd) oder `clamscan` auf und
//! wertet nur die Ausgabe aus. Der Aufruf verändert nichts: ohne `--remove`/`--move`.

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
        match crate::scan::open_regular(target) {
            Ok((file, _)) => self.scan_reader(file),
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
        let output = drain_capped(child.stdout.take());
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
                let text = output
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap_or_default();
                parse_output(&text, status.code())
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

/// Liest die ganze Ausgabe (damit der Prozess nie am vollen Puffer hängt), behält aber
/// höchstens [`MAX_OUTPUT`] Byte; das Ergebnis kommt über einen Kanal.
fn drain_capped<R: Read + Send + 'static>(out: Option<R>) -> std::sync::mpsc::Receiver<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        if let Some(mut out) = out {
            let mut buf = [0u8; 8192];
            while let Ok(n) = out.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let room = usize::try_from(MAX_OUTPUT)
                    .unwrap_or(0)
                    .saturating_sub(kept.len());
                kept.extend_from_slice(&buf[..n.min(room)]);
            }
        }
        let _ = tx.send(String::from_utf8_lossy(&kept).into_owned());
    });
    rx
}

/// Zeitlimit für ein Signatur-Update.
pub const UPDATE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

impl ClamAv {
    /// `freshclam` neben dem gefundenen Scanner (gleicher fester Installationsort).
    #[must_use]
    pub fn updater(&self) -> Option<PathBuf> {
        let exe = if cfg!(windows) { ".exe" } else { "" };
        let candidate = self.program.with_file_name(format!("freshclam{exe}"));
        candidate.is_file().then_some(candidate)
    }

    /// Lädt neue ClamAV-Signaturen (`freshclam`, eigener Prozess). Verändert nur die
    /// Signatur-Datenbank von ClamAV, keine Nutzerdateien. Liefert die letzte Ausgabezeile.
    ///
    /// # Errors
    /// `freshclam` fehlt, startet nicht, Zeitlimit oder Fehlercode (Text für den Verlauf).
    pub fn update_signatures(&self, timeout: Duration) -> Result<String, String> {
        let program = self
            .updater()
            .ok_or_else(|| "freshclam ist nicht installiert".to_owned())?;
        let dir = program
            .parent()
            .map(Path::to_path_buf)
            .ok_or("freshclam ohne Ordner")?;
        let config = dir.join("freshclam.conf");
        let database = dir.join("database");
        // Läuft als SYSTEM: nur, wenn Programm, Ordner, Konfiguration und Datenbank SYSTEM bzw.
        // den Administratoren gehören (sonst könnte ein Nutzer Befehle unterschieben).
        #[cfg(windows)]
        for path in [&dir, &program, &config, &database] {
            if path.exists() && !aegis_winffi::owner_is_trusted(path).unwrap_or(false) {
                return Err(format!(
                    "{} gehört weder SYSTEM noch den Administratoren – Update nicht gestartet",
                    path.display()
                ));
            }
        }
        let mut args = vec!["--stdout".to_owned(), "--no-warnings".to_owned()];
        if config.is_file() {
            args.push(format!("--config-file={}", config.display()));
        }
        if database.is_dir() {
            args.push(format!("--datadir={}", database.display()));
        }
        // Startet das Signatur-Update von ClamAV (fester Installationsort, abschaltbar in den
        // Einstellungen); ändert nur die ClamAV-Datenbank.
        // aegis-mutation: engine-clamav-update
        #[allow(clippy::disallowed_methods)]
        let spawned = Command::new(&program)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        let mut child = spawned.map_err(|e| format!("freshclam startet nicht: {e}"))?;
        // Job: endet beim Zeitlimit samt Kindprozessen; Grenzen für Speicher und Prozesse.
        #[cfg(windows)]
        let _job = aegis_winffi::kill_on_close_job(
            &child,
            aegis_winffi::JobLimits {
                memory_bytes: 1024 * 1024 * 1024,
                processes: 4,
            },
        )
        .map_err(|e| format!("freshclam nicht begrenzbar: {e}"))?;
        let output = drain_capped(child.stdout.take());
        let deadline = Instant::now() + timeout;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    // Nicht unbegrenzt warten: Ein Enkelprozess könnte die Ausgabe offen halten.
                    let text = output
                        .recv_timeout(Duration::from_secs(5))
                        .unwrap_or_default();
                    let last = text
                        .lines()
                        .rev()
                        .find(|l| !l.trim().is_empty())
                        .unwrap_or("")
                        .trim()
                        .chars()
                        .take(300)
                        .collect::<String>();
                    return if status.success() {
                        Ok(last)
                    } else {
                        Err(format!(
                            "freshclam meldet Fehler (Code {}): {last}",
                            status.code().unwrap_or(-1)
                        ))
                    };
                }
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(200));
                }
                Ok(None) | Err(_) => {
                    // Eigenen, hängenden freshclam-Prozess beenden (Zeitlimit).
                    // aegis-mutation: engine-clamav-update-timeout
                    #[allow(clippy::disallowed_methods)]
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "freshclam hat das Zeitlimit von {} min überschritten",
                        timeout.as_secs() / 60
                    ));
                }
            }
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

    #[cfg(unix)]
    #[test]
    fn signatur_update_ersatzprogramm() {
        use aegis_core::testing::{set_fixture_mode, write_fixture};
        let dir = tempfile::tempdir().unwrap();
        write_fixture(dir.path(), "clamscan", b"#!/bin/sh\nexit 0\n").unwrap();
        let clam = ClamAv::locate_in(&[dir.path().to_path_buf()]).unwrap();
        assert!(clam.updater().is_none());
        assert!(
            clam.update_signatures(UPDATE_TIMEOUT)
                .unwrap_err()
                .contains("nicht installiert")
        );
        write_fixture(
            dir.path(),
            "freshclam",
            b"#!/bin/sh\necho 'daily.cvd updated (version: 1)'\nexit 0\n",
        )
        .unwrap();
        set_fixture_mode(dir.path(), "freshclam", 0o700).unwrap();
        assert_eq!(
            clam.update_signatures(UPDATE_TIMEOUT).unwrap(),
            "daily.cvd updated (version: 1)"
        );
        write_fixture(
            dir.path(),
            "freshclam",
            b"#!/bin/sh\necho 'kein Netz'\nexit 1\n",
        )
        .unwrap();
        let err = clam.update_signatures(UPDATE_TIMEOUT).unwrap_err();
        assert!(err.contains("Code 1") && err.contains("kein Netz"), "{err}");
        write_fixture(dir.path(), "freshclam", b"#!/bin/sh\nsleep 30\n").unwrap();
        let err = clam
            .update_signatures(Duration::from_millis(300))
            .unwrap_err();
        assert!(err.contains("Zeitlimit"), "{err}");
    }
}
