//! Malware-Merkmale und Cheat-Logik.
//!
//! Projektauftrag: Spiel-Tools (Trainer, Mod-Menüs, Speicher-Editoren, Injektoren) sind
//! „Spiel-Tool“ – **hochgestuft zu „Gefährlich“ nur bei Malware-Merkmalen**: Zugriff auf
//! Passwort-/Cookie-/Token-Dateien, Abschalten des Virenschutzes, versteckter Autostart,
//! Nachladen von Programmen, Verschlüsseln/Löschen von Sicherungen, verdeckte Kanäle.
//!
//! Regeln: ein einzelnes Merkmal ergibt nur Punkte (höchstens „Verdächtig“); mindestens
//! **zwei verschiedene** Merkmale zusammen ergeben „Gefährlich“ mit bewusst geringerer
//! Sicherheit. Ein Spiel-Tool mit einem Merkmal wird „Verdächtig“.

use std::collections::BTreeSet;

use aegis_core::risk::RiskLevel;

use crate::finding::{Reason, Source, Weight};
use crate::yara::YaraHit;

/// Deutsche Kurznamen der Merkmale (für die Erklärung).
fn label(name: &str) -> (&'static str, &'static str) {
    match name {
        "credentials" => (
            "Zugriff auf Passwörter/Cookies",
            "access to passwords/cookies",
        ),
        "av_disable" => ("Abschalten des Virenschutzes", "disabling antivirus"),
        "hidden_autostart" => ("versteckter Autostart", "hidden autostart"),
        "dropper" => ("Nachladen von Programmen", "downloading further programs"),
        "ransomware" => (
            "Löschen von Sicherungen/Erpresser-Text",
            "deleting backups/ransom note",
        ),
        "covert_network" => ("verdeckte Netzwerk-Kanäle", "covert network channels"),
        _ => ("unbekanntes Merkmal", "unknown trait"),
    }
}

/// Bewertet die Kombination der Merkmale aus den YARA-Treffern.
#[must_use]
pub fn combine(hits: &[YaraHit]) -> Option<Reason> {
    let traits: BTreeSet<&str> = hits
        .iter()
        .filter(|h| h.severity == "trait" && !h.trait_name.is_empty())
        .map(|h| h.trait_name.as_str())
        .collect();
    let game = hits.iter().any(|h| h.severity == "game");
    let (de, en): (Vec<&str>, Vec<&str>) = traits.iter().map(|t| label(t)).unzip();
    if traits.len() >= 2 {
        let prefix_de = if game {
            "Spiel-Tool mit Schadfunktionen: "
        } else {
            ""
        };
        let prefix_en = if game {
            "Game tool with malicious functions: "
        } else {
            ""
        };
        Some(Reason::new(
            "traits.combination",
            Source::Traits,
            Weight::Definite(RiskLevel::Dangerous),
            &format!(
                "{prefix_de}Mehrere Schadsoftware-Merkmale zusammen ({}).",
                de.join(", ")
            ),
            &format!(
                "{prefix_en}Several malware traits combined ({}).",
                en.join(", ")
            ),
        ))
    } else if game && traits.len() == 1 {
        Some(Reason::new(
            "traits.game_tool_with_trait",
            Source::Traits,
            Weight::Definite(RiskLevel::Suspicious),
            &format!(
                "Spiel-Tool mit einem Schadsoftware-Merkmal ({}) – nicht nur ein Cheat.",
                de.join(", ")
            ),
            &format!(
                "Game tool with a malware trait ({}) – more than a cheat.",
                en.join(", ")
            ),
        ))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::finding::assess;
    use crate::yara::reason;

    fn hit(severity: &str, trait_name: &str) -> YaraHit {
        YaraHit {
            rule: format!("R_{severity}_{trait_name}"),
            severity: severity.into(),
            de: "de".into(),
            en: "en".into(),
            trait_name: trait_name.into(),
        }
    }

    fn level(hits: &[YaraHit]) -> RiskLevel {
        let mut reasons: Vec<Reason> = hits.iter().map(reason).collect();
        reasons.extend(combine(hits));
        assess(&reasons).0
    }

    #[test]
    fn ein_merkmal_bleibt_unter_gefaehrlich() {
        assert_eq!(level(&[hit("trait", "credentials")]), RiskLevel::Info);
        assert!(combine(&[hit("trait", "credentials")]).is_none());
        // Dasselbe Merkmal doppelt zählt nicht als Kombination.
        assert!(combine(&[hit("trait", "dropper"), hit("trait", "dropper")]).is_none());
    }

    #[test]
    fn spiel_tool_allein_und_mit_merkmalen() {
        assert_eq!(level(&[hit("game", "")]), RiskLevel::GameTool);
        assert_eq!(
            level(&[hit("game", ""), hit("trait", "av_disable")]),
            RiskLevel::Suspicious
        );
        let both = [
            hit("game", ""),
            hit("trait", "credentials"),
            hit("trait", "covert_network"),
        ];
        assert_eq!(level(&both), RiskLevel::Dangerous);
        let r = combine(&both).unwrap();
        assert!(r.de.starts_with("Spiel-Tool mit Schadfunktionen"));
        let (_, conf, _) = assess(&[r]);
        assert!(conf.percent() < 90, "Merkmale sind keine Signatur");
    }

    #[test]
    fn zwei_merkmale_ohne_spiel_tool() {
        let hits = [hit("trait", "ransomware"), hit("trait", "av_disable")];
        assert_eq!(level(&hits), RiskLevel::Dangerous);
        assert!(
            combine(&hits)
                .unwrap()
                .de
                .contains("Abschalten des Virenschutzes")
        );
    }
}
