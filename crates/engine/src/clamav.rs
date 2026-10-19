//! ClamAV-Anbindung – **nur als getrennter Prozess** (ClamAV steht unter GPL und wird nie
//! eingelinkt). AEGIS ruft `clamdscan` (schnell, mit laufendem clamd) oder `clamscan` auf und
//! wertet nur die Ausgabe aus. Der Aufruf verändert nichts: ohne `--remove`/`--move`.

use std::path::{Path, PathBuf};

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

/// Ein gefundenes ClamAV-Programm.
#[derive(Debug, Clone)]
pub struct ClamAv {
    program: PathBuf,
}

impl ClamAv {
    /// Programm mit festem Pfad (z. B. aus den Einstellungen).
    #[must_use]
    pub fn with_program(program: PathBuf) -> Self {
        Self { program }
    }

    /// Pfad des Programms.
    #[must_use]
    pub fn program(&self) -> &Path {
        &self.program
    }

    /// Sucht `clamdscan`/`clamscan` im PATH und im üblichen Windows-Installationsordner.
    #[must_use]
    pub fn locate() -> Option<Self> {
        let exe = if cfg!(windows) { ".exe" } else { "" };
        let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect())
            .unwrap_or_default();
        if cfg!(windows)
            && let Some(pf) = std::env::var_os("ProgramFiles")
        {
            dirs.push(PathBuf::from(pf).join("ClamAV"));
        }
        for name in ["clamdscan", "clamscan"] {
            for dir in &dirs {
                // Nur absolute Ordner: ein relativer PATH-Eintrag würde aus dem
                // Arbeitsordner laden.
                if !dir.is_absolute() {
                    continue;
                }
                let candidate = dir.join(format!("{name}{exe}"));
                if candidate.is_file() {
                    return Some(Self { program: candidate });
                }
            }
        }
        None
    }

    /// Argumente für einen Lauf (ohne Programm). `--` verhindert, dass ein Dateiname
    /// als Option gelesen wird.
    #[must_use]
    pub fn arguments(target: &Path) -> Vec<std::ffi::OsString> {
        vec![
            "--no-summary".into(),
            "--stdout".into(),
            "--".into(),
            target.as_os_str().to_owned(),
        ]
    }

    /// Prüft eine Datei oder einen Ordner.
    #[must_use]
    pub fn scan(&self, target: &Path) -> ClamResult {
        // Startet ClamAV als getrennten Prozess, nur lesend (kein --remove/--move).
        // aegis-mutation: engine-clamav-scan
        #[allow(clippy::disallowed_methods)]
        let output = std::process::Command::new(&self.program)
            .args(Self::arguments(target))
            .stdin(std::process::Stdio::null())
            .output();
        match output {
            Ok(out) => parse_output(&String::from_utf8_lossy(&out.stdout), out.status.code()),
            Err(e) => ClamResult::Error(format!("ClamAV konnte nicht gestartet werden: {e}")),
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
    fn argumente_schuetzen_vor_optionen_im_namen() {
        let args = ClamAv::arguments(Path::new("--remove"));
        assert_eq!(args[2], "--");
        assert_eq!(args[3], "--remove");
        assert!(!args.iter().any(|a| a == "--move" || a == "--remove=yes"));
    }
}
