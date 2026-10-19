//! Risikostufen und Sicherheit (Konfidenz) einer Bewertung.
//!
//! Bezug zur Goldenen Regel: Die Risikostufe beschreibt nur, **wie dringend** AEGIS etwas
//! meldet. Sie berechtigt zu nichts – auch „Gefährlich“ führt nie automatisch zu einer
//! Aktion, sondern höchstens zu einem [`crate::plan::ActionPlan`], den der Nutzer bestätigen muss.

use std::fmt;

use serde::{Deserialize, Serialize};

/// Risikostufe eines Fundes, aufsteigend nach Schwere geordnet
/// (`Clean < Info < GameTool < RiskyTool < Suspicious < Dangerous`).
///
/// Serialisiert in `snake_case` (z. B. `"risky_tool"`), so wie die UI sie erwartet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    /// Sauber – nichts gefunden.
    Clean,
    /// Information – erwähnenswert, aber kein Risiko.
    Info,
    /// Spiel-Tool oder Cheat – meist gewollt, kann aber Kontosperren o. Ä. auslösen.
    GameTool,
    /// Legitimes Werkzeug mit Missbrauchsrisiko (z. B. Fernwartung, Passwort-Tools).
    RiskyTool,
    /// Verdächtig – Heuristik schlägt an, aber kein sicherer Nachweis.
    Suspicious,
    /// Gefährlich – sichere Erkennung von Schadsoftware.
    Dangerous,
}

impl RiskLevel {
    /// Alle Stufen in aufsteigender Schwere.
    pub const ALL: [Self; 6] = [
        Self::Clean,
        Self::Info,
        Self::GameTool,
        Self::RiskyTool,
        Self::Suspicious,
        Self::Dangerous,
    ];

    /// Stabile Kennung (identisch mit der serde-Darstellung).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Clean => "clean",
            Self::Info => "info",
            Self::GameTool => "game_tool",
            Self::RiskyTool => "risky_tool",
            Self::Suspicious => "suspicious",
            Self::Dangerous => "dangerous",
        }
    }

    /// Deutsche Bezeichnung für die UI.
    #[must_use]
    pub const fn label_de(self) -> &'static str {
        match self {
            Self::Clean => "Sauber",
            Self::Info => "Info",
            Self::GameTool => "Spiel-Tool/Cheat",
            Self::RiskyTool => "Tool mit Risiko",
            Self::Suspicious => "Verdächtig",
            Self::Dangerous => "Gefährlich",
        }
    }

    /// Englische Bezeichnung (zweite Sprache).
    #[must_use]
    pub const fn label_en(self) -> &'static str {
        match self {
            Self::Clean => "Clean",
            Self::Info => "Info",
            Self::GameTool => "Game tool/cheat",
            Self::RiskyTool => "Risky tool",
            Self::Suspicious => "Suspicious",
            Self::Dangerous => "Dangerous",
        }
    }
}

impl fmt::Display for RiskLevel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.label_de())
    }
}

/// Fehler bei Risikoangaben.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum RiskError {
    /// Konfidenz außerhalb von 0–100 %.
    #[error("Konfidenz {0} liegt außerhalb von 0–100 %")]
    ConfidenceOutOfRange(u8),
}

/// Wie sicher sich eine Erkennung ist, in Prozent (0–100).
///
/// Wird beim Deserialisieren geprüft – ein Wert über 100 wird abgelehnt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "u8", into = "u8")]
pub struct Confidence(u8);

/// Grobe Einordnung einer [`Confidence`] für die Anzeige.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfidenceBand {
    /// Unter 40 %.
    Low,
    /// 40 % bis unter 75 %.
    Medium,
    /// Ab 75 %.
    High,
}

impl ConfidenceBand {
    /// Deutsche Bezeichnung.
    #[must_use]
    pub const fn label_de(self) -> &'static str {
        match self {
            Self::Low => "gering",
            Self::Medium => "mittel",
            Self::High => "hoch",
        }
    }

    /// Englische Bezeichnung.
    #[must_use]
    pub const fn label_en(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }
}

impl Confidence {
    /// Größter erlaubter Wert (100 %).
    pub const MAX: Self = Self(100);

    /// Erzeugt eine Konfidenz; Werte über 100 sind ein Fehler.
    ///
    /// # Errors
    /// [`RiskError::ConfidenceOutOfRange`], wenn `percent > 100`.
    pub const fn new(percent: u8) -> Result<Self, RiskError> {
        if percent > 100 {
            Err(RiskError::ConfidenceOutOfRange(percent))
        } else {
            Ok(Self(percent))
        }
    }

    /// Wert in Prozent.
    #[must_use]
    pub const fn percent(self) -> u8 {
        self.0
    }

    /// Grobe Einordnung (gering/mittel/hoch).
    #[must_use]
    pub const fn band(self) -> ConfidenceBand {
        match self.0 {
            0..40 => ConfidenceBand::Low,
            40..75 => ConfidenceBand::Medium,
            _ => ConfidenceBand::High,
        }
    }
}

impl TryFrom<u8> for Confidence {
    type Error = RiskError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl From<Confidence> for u8 {
    fn from(value: Confidence) -> Self {
        value.0
    }
}

impl fmt::Display for Confidence {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} %", self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordered_by_severity() {
        let mut sorted = RiskLevel::ALL;
        sorted.sort();
        assert_eq!(sorted, RiskLevel::ALL);
        assert!(RiskLevel::Clean < RiskLevel::Info);
        assert!(RiskLevel::Info < RiskLevel::GameTool);
        assert!(RiskLevel::GameTool < RiskLevel::RiskyTool);
        assert!(RiskLevel::RiskyTool < RiskLevel::Suspicious);
        assert!(RiskLevel::Suspicious < RiskLevel::Dangerous);
    }

    #[test]
    fn labels_and_serde() {
        let expected_de = [
            "Sauber",
            "Info",
            "Spiel-Tool/Cheat",
            "Tool mit Risiko",
            "Verdächtig",
            "Gefährlich",
        ];
        for (level, de) in RiskLevel::ALL.iter().zip(expected_de) {
            assert_eq!(level.label_de(), de);
            assert_eq!(level.to_string(), de);
            assert!(!level.label_en().is_empty());
            let json = serde_json::to_string(level).unwrap();
            assert_eq!(json, format!("\"{}\"", level.as_str()));
            let back: RiskLevel = serde_json::from_str(&json).unwrap();
            assert_eq!(back, *level);
        }
        assert_eq!(RiskLevel::RiskyTool.label_en(), "Risky tool");
        assert!(serde_json::from_str::<RiskLevel>("\"RiskyTool\"").is_err());
    }

    #[test]
    fn confidence_validation() {
        assert_eq!(Confidence::new(0).unwrap().percent(), 0);
        assert_eq!(Confidence::new(100).unwrap(), Confidence::MAX);
        assert_eq!(
            Confidence::new(101),
            Err(RiskError::ConfidenceOutOfRange(101))
        );
        assert_eq!(
            Confidence::try_from(55).unwrap().band(),
            ConfidenceBand::Medium
        );
        assert_eq!(Confidence::new(39).unwrap().band(), ConfidenceBand::Low);
        assert_eq!(Confidence::new(75).unwrap().band(), ConfidenceBand::High);
        assert_eq!(Confidence::new(42).unwrap().to_string(), "42 %");
        assert_eq!(u8::from(Confidence::new(7).unwrap()), 7);
        assert_eq!(ConfidenceBand::High.label_de(), "hoch");
        assert_eq!(ConfidenceBand::Low.label_en(), "low");
        assert_eq!(ConfidenceBand::Medium.label_de(), "mittel");
        assert_eq!(ConfidenceBand::Medium.label_en(), "medium");
        assert_eq!(ConfidenceBand::Low.label_de(), "gering");
        assert_eq!(ConfidenceBand::High.label_en(), "high");
    }

    #[test]
    fn confidence_serde_validates() {
        let c: Confidence = serde_json::from_str("80").unwrap();
        assert_eq!(c.percent(), 80);
        assert_eq!(serde_json::to_string(&c).unwrap(), "80");
        assert!(serde_json::from_str::<Confidence>("101").is_err());
        assert!(
            RiskError::ConfidenceOutOfRange(200)
                .to_string()
                .contains("außerhalb")
        );
    }
}
