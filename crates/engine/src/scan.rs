//! Scanner: prüft Dateien und Ordner **nur lesend** und bewertet sie.

use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::clamav::ClamAv;
use crate::finding::{self, Finding, Reason, Source, Weight};
use crate::hashlist::HashList;
use crate::yara::YaraRules;
use crate::{clamav, eicar, hash, heuristics, pe, yara};

/// Grenzen gegen Überlastung (riesige Dateien, tiefe Ordner).
#[derive(Debug, Clone, Copy)]
pub struct ScanLimits {
    /// Bis zu dieser Größe wird der Inhalt analysiert (YARA, PE); größere Dateien werden nur
    /// gehasht und als „teilweise geprüft“ markiert.
    pub max_analyze_bytes: u64,
    /// Maximale Ordnertiefe.
    pub max_depth: usize,
    /// Maximale Anzahl Dateien pro Lauf.
    pub max_files: u64,
}

impl Default for ScanLimits {
    fn default() -> Self {
        Self {
            max_analyze_bytes: 128 * 1024 * 1024,
            max_depth: 32,
            max_files: 1_000_000,
        }
    }
}

/// Konfiguration der Engine.
#[derive(Debug, Default)]
pub struct EngineConfig {
    /// Hash-Listen.
    pub hash_lists: Vec<HashList>,
    /// YARA-Regeln (eingebaut + lizenzierte).
    pub yara: Option<YaraRules>,
    /// ClamAV, falls installiert und aktiviert.
    pub clamav: Option<ClamAv>,
    /// Grenzen.
    pub limits: ScanLimits,
}

/// Die Engine.
#[derive(Debug)]
pub struct Engine {
    config: EngineConfig,
}

/// Übersprungener Pfad mit Grund.
#[derive(Debug, Clone, Serialize)]
pub struct Skipped {
    /// Pfad.
    pub path: PathBuf,
    /// Grund.
    pub reason: String,
}

/// Ergebnis eines Laufs.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ScanReport {
    /// Alle geprüften Dateien.
    pub findings: Vec<Finding>,
    /// Übersprungen (Links, Sonderdateien, Grenzen, Lesefehler).
    pub skipped: Vec<Skipped>,
    /// Abgebrochen wegen `max_files`?
    pub truncated: bool,
}

impl ScanReport {
    /// Nur Funde oberhalb von „Sauber“.
    pub fn notable(&self) -> impl Iterator<Item = &Finding> {
        self.findings
            .iter()
            .filter(|f| f.risk > aegis_core::risk::RiskLevel::Clean)
    }
}

impl Engine {
    /// Neue Engine.
    #[must_use]
    pub fn new(config: EngineConfig) -> Self {
        Self { config }
    }

    /// Engine mit den eingebauten YARA-Regeln und ohne ClamAV/Hash-Listen.
    ///
    /// # Errors
    /// Die eingebauten Regeln lassen sich nicht kompilieren.
    pub fn with_builtin_rules() -> Result<Self, String> {
        Ok(Self::new(EngineConfig {
            yara: Some(YaraRules::builtin()?),
            ..EngineConfig::default()
        }))
    }

    /// Prüft eine Datei. Liest nur; folgt keinen Links.
    #[must_use]
    pub fn scan_file(&self, path: &Path) -> Finding {
        let mut reasons: Vec<Reason> = heuristics::reasons(path);
        let mut not_scannable = None;
        let (sha256, size) = match read_and_hash(path, self.config.limits.max_analyze_bytes) {
            Ok(read) => {
                if read.truncated {
                    not_scannable = Some(format!(
                        "Nur teilweise geprüft: größer als {} MiB (Inhalt nicht analysiert, Prüfsumme vollständig).",
                        self.config.limits.max_analyze_bytes / (1024 * 1024)
                    ));
                } else {
                    reasons.extend(self.content_reasons(&read.head, &mut not_scannable));
                }
                for list in &self.config.hash_lists {
                    if let Some(label) = list.lookup(&read.sha256) {
                        let label = if label.is_empty() {
                            "ohne Bezeichnung"
                        } else {
                            label
                        };
                        reasons.push(Reason::new(
                            "hashlist.match",
                            Source::HashList {
                                list: list.name().to_owned(),
                            },
                            Weight::Definite(aegis_core::risk::RiskLevel::Dangerous),
                            &format!("Prüfsumme steht in der Liste „{}“ ({label}).", list.name()),
                            &format!("Checksum is listed in \"{}\" ({label}).", list.name()),
                        ));
                    }
                }
                (Some(hash::to_hex(&read.sha256)), read.size)
            }
            Err(e) => {
                not_scannable = Some(format!("Nicht lesbar: {e}"));
                (None, 0)
            }
        };
        if let Some(clam) = &self.config.clamav {
            let result = clam.scan(path);
            if let clamav::ClamResult::Error(e) = &result {
                not_scannable.get_or_insert_with(|| format!("ClamAV: {e}"));
            }
            reasons.extend(clamav::reasons(&result));
        }
        let (risk, confidence, category) = finding::assess(&reasons);
        let (summary_de, summary_en) = finding::summarize(risk, category, &reasons);
        Finding {
            path: path.to_owned(),
            sha256,
            size,
            risk,
            confidence,
            category,
            summary_de,
            summary_en,
            recommendation: finding::recommend(risk),
            reasons,
            not_scannable,
        }
    }

    fn content_reasons(&self, bytes: &[u8], not_scannable: &mut Option<String>) -> Vec<Reason> {
        let mut out = Vec::new();
        if eicar::is_eicar(bytes) {
            out.push(Reason::new(
                "eicar",
                Source::Eicar,
                Weight::Definite(aegis_core::risk::RiskLevel::Dangerous),
                "Enthält die EICAR-Prüfzeichenkette.",
                "Contains the EICAR test string.",
            ));
        }
        if pe::looks_like_pe(bytes) {
            match pe::analyze(bytes) {
                Ok(info) => out.extend(pe::reasons(&info)),
                Err(e) => out.push(pe::malformed_reason(&e)),
            }
        }
        if let Some(rules) = &self.config.yara {
            match rules.scan(bytes) {
                Ok(hits) => out.extend(hits.iter().map(yara::reason)),
                Err(e) => {
                    not_scannable.get_or_insert_with(|| format!("YARA: {e}"));
                }
            }
        }
        out
    }

    /// Prüft Dateien und Ordner (rekursiv, ohne Links zu folgen).
    #[must_use]
    pub fn scan_paths(&self, roots: &[PathBuf]) -> ScanReport {
        let mut report = ScanReport::default();
        let mut count = 0u64;
        let mut stack: Vec<(PathBuf, usize)> = roots.iter().map(|p| (p.clone(), 0)).collect();
        while let Some((path, depth)) = stack.pop() {
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(e) => {
                    report.skipped.push(Skipped {
                        path,
                        reason: format!("Nicht lesbar: {e}"),
                    });
                    continue;
                }
            };
            if meta.file_type().is_symlink() || is_reparse_point(&meta) {
                report.skipped.push(Skipped {
                    path,
                    reason: "Verknüpfung (Link) – nicht verfolgt".into(),
                });
            } else if meta.is_dir() {
                if depth >= self.config.limits.max_depth {
                    report.skipped.push(Skipped {
                        path,
                        reason: "Zu tief verschachtelt".into(),
                    });
                    continue;
                }
                match std::fs::read_dir(&path) {
                    Ok(entries) => {
                        let mut children: Vec<PathBuf> =
                            entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
                        children.sort();
                        stack.extend(children.into_iter().rev().map(|c| (c, depth + 1)));
                    }
                    Err(e) => report.skipped.push(Skipped {
                        path,
                        reason: format!("Ordner nicht lesbar: {e}"),
                    }),
                }
            } else if meta.is_file() {
                if count >= self.config.limits.max_files {
                    report.truncated = true;
                    break;
                }
                count += 1;
                report.findings.push(self.scan_file(&path));
            } else {
                report.skipped.push(Skipped {
                    path,
                    reason: "Sonderdatei (Gerät, Pipe, Socket)".into(),
                });
            }
        }
        report
    }
}

#[cfg(windows)]
fn is_reparse_point(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_meta: &std::fs::Metadata) -> bool {
    false
}

struct ReadResult {
    head: Vec<u8>,
    sha256: [u8; 32],
    size: u64,
    truncated: bool,
}

/// Liest bis `limit` Byte in den Speicher und hasht die ganze Datei in einem Durchgang.
fn read_and_hash(path: &Path, limit: u64) -> io::Result<ReadResult> {
    let meta = std::fs::symlink_metadata(path)?;
    if !meta.is_file() {
        return Err(io::Error::other("keine reguläre Datei"));
    }
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut head = Vec::with_capacity(usize::try_from(meta.len().min(limit)).unwrap_or(0));
    let mut buf = vec![0u8; 64 * 1024];
    let mut size = 0u64;
    loop {
        let n = match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        hasher.update(&buf[..n]);
        let room = limit.saturating_sub(size);
        let take = usize::try_from(room.min(n as u64)).unwrap_or(0);
        head.extend_from_slice(&buf[..take]);
        size = size.saturating_add(n as u64);
    }
    Ok(ReadResult {
        head,
        sha256: hasher.finalize().into(),
        size,
        truncated: size > limit,
    })
}
