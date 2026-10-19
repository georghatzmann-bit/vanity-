//! Bewertung: aus einzelnen Begründungen wird eine Risikostufe mit Erklärung.
//!
//! Grundsatz (aus dem Projektauftrag): **„Gefährlich“ nur bei Malware-Merkmalen** –
//! also bei eindeutigen Treffern (EICAR, Hash-Liste, ClamAV-Signatur, YARA-Regel mit
//! Schweregrad „dangerous“). Heuristiken allein ergeben höchstens „Verdächtig“.

use std::path::PathBuf;

use aegis_core::risk::{Confidence, RiskLevel};
use serde::{Deserialize, Serialize};

/// Woher eine Begründung stammt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum Source {
    /// EICAR-Testdatei.
    Eicar,
    /// Treffer in einer Hash-Liste.
    HashList { list: String },
    /// YARA-X-Regel.
    Yara { rule: String },
    /// ClamAV-Signatur (getrennter Prozess).
    ClamAv { signature: String },
    /// Statische Analyse (PE).
    Static,
    /// Heuristik (Name, Ort, Herkunft).
    Heuristic,
    /// Dokument- oder Skript-Prüfung (Makros, PDF, Verknüpfung, Skript).
    Content,
    /// Inhalt eines Archivs oder Abbilds.
    Container,
    /// Kombination von Malware-Merkmalen.
    Traits,
}

/// Grobe Einordnung des Fundes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    /// Nichts Auffälliges.
    Clean,
    /// EICAR oder andere harmlose Prüfdatei.
    TestFile,
    /// Bekannte Schadsoftware (Signatur/Hash).
    Malware,
    /// Potenziell unerwünschtes Programm / Tool mit Risiko.
    RiskyTool,
    /// Spiel-Tool (Trainer, Mod-Menü …) – ab P3 genauer.
    GameTool,
    /// Auffällig, aber nicht eindeutig.
    Suspicious,
    /// Nur Hinweise (z. B. gepackt, unsigniert).
    Info,
}

/// Empfohlene Aktion – nur eine Empfehlung, ausgeführt wird nichts ohne Freigabe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Recommendation {
    /// Nichts zu tun.
    None,
    /// Ansehen und selbst entscheiden.
    Review,
    /// In Quarantäne verschieben (nach Bestätigung).
    Quarantine,
}

/// Wie stark eine Begründung wirkt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Weight {
    /// Eindeutig: Stufe steht fest (z. B. Signatur-Treffer).
    Definite(RiskLevel),
    /// Punkte für die Heuristik (0–100).
    Score(u8),
    /// Entlastung: zieht Punkte der Heuristik ab (z. B. gültige Signatur). Wirkt nie auf
    /// eindeutige Treffer.
    Relief(u8),
}

/// Eine einzelne Begründung („Warum?“-Ansicht).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reason {
    /// Stabiler Code, z. B. `pe.packed.upx`.
    pub code: String,
    /// Quelle.
    pub source: Source,
    /// Wirkung.
    pub weight: Weight,
    /// Kurztext Deutsch.
    pub de: String,
    /// Kurztext Englisch.
    pub en: String,
}

impl Reason {
    /// Neue Begründung.
    #[must_use]
    pub fn new(code: &str, source: Source, weight: Weight, de: &str, en: &str) -> Self {
        Self {
            code: code.to_owned(),
            source,
            weight,
            de: de.to_owned(),
            en: en.to_owned(),
        }
    }
}

/// Ergebnis für eine Datei.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Finding {
    /// Geprüfter Pfad.
    pub path: PathBuf,
    /// SHA-256 (Hex), falls lesbar.
    pub sha256: Option<String>,
    /// Größe in Byte.
    pub size: u64,
    /// Risikostufe.
    pub risk: RiskLevel,
    /// Sicherheit der Einschätzung (0–100).
    pub confidence: Confidence,
    /// Einordnung.
    pub category: Category,
    /// 2–3 Sätze, Deutsch.
    pub summary_de: String,
    /// 2–3 Sätze, Englisch.
    pub summary_en: String,
    /// Empfehlung.
    pub recommendation: Recommendation,
    /// Alle Begründungen.
    pub reasons: Vec<Reason>,
    /// Gesetzt, wenn die Datei (teilweise) nicht prüfbar war – mit Grund.
    pub not_scannable: Option<String>,
    /// Auffällige Inhalte von Archiven/Abbildern/Dokumenten (höchstens [`MAX_CONTAINED`]).
    pub contained: Vec<Contained>,
    /// Gesetzt, wenn der Nutzer genau dieser Datei (Hash + Pfad) vertraut – der Dienst trägt
    /// es aus der Vertrauensliste ein. Die Risikostufe bleibt ehrlich stehen.
    #[serde(default)]
    pub trusted: Option<TrustMark>,
}

/// Hinweis „Vertraut“ an einem Fund.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrustMark {
    /// Kennung des Eintrags in der Vertrauensliste.
    pub id: String,
    /// Grund.
    pub reason: String,
    /// Seit (RFC 3339).
    pub since: String,
}

impl Finding {
    /// Warnung aus beobachtetem Verhalten (z. B. Ransomware-Verdacht des Wächters) – kein
    /// Dateiinhalt, nur Beobachtung; Empfehlung „ansehen“.
    #[must_use]
    pub fn behavior_alert(
        path: PathBuf,
        risk: RiskLevel,
        summary_de: String,
        summary_en: String,
        reasons: Vec<(String, String, String)>,
    ) -> Self {
        Self {
            path,
            sha256: None,
            size: 0,
            risk,
            confidence: confidence(70),
            category: Category::Suspicious,
            summary_de,
            summary_en,
            recommendation: Recommendation::Review,
            reasons: reasons
                .into_iter()
                .map(|(code, de, en)| Reason {
                    code,
                    source: Source::Heuristic,
                    weight: Weight::Definite(risk),
                    de,
                    en,
                })
                .collect(),
            not_scannable: None,
            contained: Vec::new(),
            trusted: None,
        }
    }

    /// Ergebnis für eine Datei, die nicht geprüft werden konnte (z. B. Prüfprozess
    /// abgestürzt). Stufe „Info“ mit Empfehlung „ansehen“ – nie „sauber“.
    #[must_use]
    pub fn unscannable(path: PathBuf, why: &str) -> Self {
        Self {
            path,
            sha256: None,
            size: 0,
            risk: RiskLevel::Info,
            confidence: confidence(0),
            category: Category::Info,
            summary_de: "Diese Datei konnte nicht geprüft werden.".into(),
            summary_en: "This file could not be checked.".into(),
            recommendation: Recommendation::Review,
            reasons: Vec::new(),
            not_scannable: Some(why.to_owned()),
            contained: Vec::new(),
            trusted: None,
        }
    }
}

/// Auffälliger Inhalt eines Containers (Archiv, Abbild, Office-Datei).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Contained {
    /// Pfad im Container, verschachtelt mit `/` (z. B. `a.zip/b.7z/c.exe`).
    pub name: String,
    /// Risikostufe des Inhalts.
    pub risk: RiskLevel,
    /// Einordnung.
    pub category: Category,
    /// Kurztext Deutsch.
    pub summary_de: String,
    /// Kurztext Englisch.
    pub summary_en: String,
    /// Begründungen.
    pub reasons: Vec<Reason>,
}

/// Höchstzahl gemeldeter Inhalte je Datei.
pub const MAX_CONTAINED: usize = 200;

/// Ab dieser Punktzahl gilt eine Datei heuristisch als „Verdächtig“.
pub const SUSPICIOUS_SCORE: u32 = 60;
/// Ab dieser Punktzahl gibt es einen „Info“-Hinweis.
pub const INFO_SCORE: u32 = 20;

/// Bewertet die Begründungen: höchste eindeutige Stufe gewinnt, sonst Punkte-Summe.
#[must_use]
pub fn assess(reasons: &[Reason]) -> (RiskLevel, Confidence, Category) {
    let definite = reasons
        .iter()
        .filter_map(|r| match r.weight {
            Weight::Definite(level) => Some((level, r)),
            Weight::Score(_) | Weight::Relief(_) => None,
        })
        .max_by_key(|(level, _)| *level);
    let (plus, minus) = reasons
        .iter()
        .fold((0u32, 0u32), |(plus, minus), r| match r.weight {
            Weight::Score(s) => (plus + u32::from(s), minus),
            Weight::Relief(s) => (plus, minus + u32::from(s)),
            Weight::Definite(_) => (plus, minus),
        });
    let score = plus.saturating_sub(minus);
    let heuristic_level = if score >= SUSPICIOUS_SCORE {
        RiskLevel::Suspicious
    } else if score >= INFO_SCORE {
        RiskLevel::Info
    } else {
        RiskLevel::Clean
    };
    match definite {
        Some((level, reason)) if level >= heuristic_level => {
            let category = match (&reason.source, level) {
                (Source::Eicar, _) => Category::TestFile,
                (_, RiskLevel::Dangerous) => Category::Malware,
                (_, RiskLevel::GameTool) => Category::GameTool,
                (_, RiskLevel::RiskyTool) => Category::RiskyTool,
                (_, RiskLevel::Suspicious) => Category::Suspicious,
                (_, RiskLevel::Info) => Category::Info,
                (_, RiskLevel::Clean) => Category::Clean,
            };
            // Merkmals-Kombinationen sind keine Signatur: Sicherheit bewusst niedriger.
            let conf = if reason.source == Source::Traits {
                70
            } else {
                95
            };
            (level, confidence(conf), category)
        }
        _ => {
            let category = match heuristic_level {
                RiskLevel::Suspicious => Category::Suspicious,
                RiskLevel::Info => Category::Info,
                _ => Category::Clean,
            };
            // Heuristik: Sicherheit wächst mit der Punktzahl, bleibt aber bescheiden.
            let conf = match heuristic_level {
                RiskLevel::Clean => 70,
                _ => u8::try_from((40 + score / 2).min(80)).unwrap_or(80),
            };
            (heuristic_level, confidence(conf), category)
        }
    }
}

fn confidence(value: u8) -> Confidence {
    // Werte ≤ 100 sind immer gültig.
    Confidence::new(value.min(100)).unwrap_or(Confidence::MAX)
}

/// Empfehlung zur Stufe.
#[must_use]
pub fn recommend(risk: RiskLevel) -> Recommendation {
    match risk {
        RiskLevel::Dangerous => Recommendation::Quarantine,
        RiskLevel::Suspicious | RiskLevel::RiskyTool | RiskLevel::GameTool => {
            Recommendation::Review
        }
        RiskLevel::Info | RiskLevel::Clean => Recommendation::None,
    }
}

/// Kurze, verständliche Erklärung (2–3 Sätze) auf Deutsch und Englisch.
#[must_use]
pub fn summarize(risk: RiskLevel, category: Category, reasons: &[Reason]) -> (String, String) {
    let top: Vec<&Reason> = {
        let mut r: Vec<&Reason> = reasons.iter().collect();
        r.sort_by_key(|r| std::cmp::Reverse(rank(r)));
        r.into_iter().take(2).collect()
    };
    let because_de = top
        .iter()
        .map(|r| r.de.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let because_en = top
        .iter()
        .map(|r| r.en.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let (head_de, head_en, tail_de, tail_en) = match (risk, category) {
        (_, Category::TestFile) => (
            "Das ist die EICAR-Testdatei – harmlos, aber jeder Virenscanner soll sie melden.",
            "This is the EICAR test file – harmless, but every antivirus is expected to report it.",
            "Du kannst sie gefahrlos isolieren oder löschen.",
            "You can safely isolate or delete it.",
        ),
        (RiskLevel::Dangerous, _) => {
            let (de, en) = match dangerous_basis(reasons) {
                Basis::Known => (
                    "Diese Datei ist als Schadsoftware bekannt.",
                    "This file is known malware.",
                ),
                Basis::Contains => (
                    "Diese Datei enthält eine als Schadsoftware bekannte Datei.",
                    "This file contains a file known as malware.",
                ),
                Basis::Traits => (
                    "Diese Datei zeigt mehrere typische Merkmale von Schadsoftware.",
                    "This file shows several typical traits of malware.",
                ),
            };
            (
                de,
                en,
                "Empfehlung: in die Quarantäne verschieben – erst nach deiner Bestätigung.",
                "Recommendation: move it to quarantine – only after you confirm.",
            )
        }
        (RiskLevel::Suspicious, _) => (
            "Diese Datei zeigt mehrere auffällige Merkmale, ist aber nicht eindeutig schädlich.",
            "This file shows several suspicious traits but is not clearly malicious.",
            "Prüfe Herkunft und Zweck, bevor du sie öffnest.",
            "Check where it came from and what it is for before opening it.",
        ),
        (RiskLevel::RiskyTool, _) => (
            "Ein Werkzeug, das missbraucht werden kann oder unerwünscht sein könnte.",
            "A tool that can be misused or may be unwanted.",
            "Behalte es nur, wenn du es bewusst installiert hast.",
            "Keep it only if you installed it on purpose.",
        ),
        (RiskLevel::GameTool, _) => (
            "Ein Spiel-Tool (z. B. Trainer oder Mod-Menü).",
            "A game tool (e.g. trainer or mod menu).",
            "Achtung: Anti-Cheat-Systeme können dafür sperren.",
            "Note: anti-cheat systems may ban you for it.",
        ),
        (RiskLevel::Info, _) => (
            "Keine Bedrohung erkannt, aber es gibt Hinweise.",
            "No threat detected, but there are notes.",
            "Kein Handlungsbedarf.",
            "No action needed.",
        ),
        (RiskLevel::Clean, _) => (
            "Nichts Auffälliges gefunden.",
            "Nothing suspicious found.",
            "",
            "",
        ),
    };
    let join = |parts: [&str; 3]| {
        parts
            .iter()
            .filter(|p| !p.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(" ")
    };
    (
        join([head_de, &because_de, tail_de]),
        join([head_en, &because_en, tail_en]),
    )
}

enum Basis {
    Known,
    Contains,
    Traits,
}

/// Worauf beruht „Gefährlich“? Eigene Signatur schlägt Inhalt schlägt Merkmale.
fn dangerous_basis(reasons: &[Reason]) -> Basis {
    let dangerous = |r: &&Reason| r.weight == Weight::Definite(RiskLevel::Dangerous);
    if reasons
        .iter()
        .filter(dangerous)
        .any(|r| !matches!(r.source, Source::Traits | Source::Container))
    {
        Basis::Known
    } else if reasons
        .iter()
        .filter(dangerous)
        .any(|r| r.source == Source::Container)
    {
        Basis::Contains
    } else {
        Basis::Traits
    }
}

fn rank(reason: &Reason) -> u32 {
    match reason.weight {
        Weight::Definite(level) => 1000 + level as u32,
        Weight::Score(s) => u32::from(s),
        Weight::Relief(_) => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn score(code: &str, s: u8) -> Reason {
        Reason::new(code, Source::Heuristic, Weight::Score(s), "de", "en")
    }

    #[test]
    fn heuristik_allein_nie_gefaehrlich() {
        let reasons: Vec<Reason> = (0..10).map(|i| score(&format!("h{i}"), 100)).collect();
        let (risk, _, cat) = assess(&reasons);
        assert_eq!(risk, RiskLevel::Suspicious);
        assert_eq!(cat, Category::Suspicious);
    }

    #[test]
    fn stufen_nach_punkten() {
        assert_eq!(assess(&[]).0, RiskLevel::Clean);
        assert_eq!(assess(&[score("a", 19)]).0, RiskLevel::Clean);
        assert_eq!(assess(&[score("a", 20)]).0, RiskLevel::Info);
        assert_eq!(
            assess(&[score("a", 30), score("b", 30)]).0,
            RiskLevel::Suspicious
        );
    }

    #[test]
    fn eindeutiger_treffer_gewinnt() {
        let eicar = Reason::new(
            "eicar",
            Source::Eicar,
            Weight::Definite(RiskLevel::Dangerous),
            "EICAR.",
            "EICAR.",
        );
        let (risk, conf, cat) = assess(&[score("x", 10), eicar.clone()]);
        assert_eq!((risk, cat), (RiskLevel::Dangerous, Category::TestFile));
        assert!(conf.percent() >= 90);
        let (de, en) = summarize(risk, cat, &[eicar]);
        assert!(de.contains("EICAR-Testdatei"));
        assert!(en.contains("EICAR test file"));
        assert_eq!(recommend(risk), Recommendation::Quarantine);
    }

    #[test]
    fn spiel_tool_unter_verdaechtiger_heuristik() {
        let game = Reason::new(
            "yara.game",
            Source::Yara {
                rule: "Trainer".into(),
            },
            Weight::Definite(RiskLevel::GameTool),
            "Trainer.",
            "Trainer.",
        );
        // Heuristik „Verdächtig“ ist schwerer als Spiel-Tool → Verdächtig.
        let (risk, _, _) = assess(&[game.clone(), score("a", 70)]);
        assert_eq!(risk, RiskLevel::Suspicious);
        let (risk, _, cat) = assess(&[game]);
        assert_eq!((risk, cat), (RiskLevel::GameTool, Category::GameTool));
        assert_eq!(recommend(risk), Recommendation::Review);
    }
}
