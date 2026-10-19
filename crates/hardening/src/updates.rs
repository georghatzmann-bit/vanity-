//! Software-Updates (P6.5): liest die Tabelle von `winget upgrade` (nur lesend). Installiert
//! wird nur im Dienst nach einem „Ja“ – genau die Paket-Kennung und Zielversion aus dem Plan.
//!
//! winget gibt die Liste nur als Tabelle aus (Spalten am Kopf ausgerichtet, Überschriften
//! je Sprache). Gelesen wird deshalb über die Spaltenanfänge der Kopfzeile; Zeilen, deren
//! Kennung oder Version danach nicht plausibel ist, werden verworfen statt geraten.

use aegis_core::plan::{valid_package_id, valid_package_version};
use serde::{Deserialize, Serialize};

/// Ein Paket mit verfügbarer neuer Version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Upgrade {
    /// Anzeigename (höchstens 120 Zeichen).
    pub name: String,
    /// winget-Kennung.
    pub id: String,
    /// Installierte Version.
    pub version: String,
    /// Verfügbare Version.
    pub available: String,
    /// Paketquelle (z. B. `winget`).
    pub source: String,
    /// Hat winget Name oder Kennung gekürzt („…“)? Dann bietet AEGIS kein Aktualisieren an.
    pub truncated: bool,
}

/// Höchstzahl Pakete.
const MAX_PACKAGES: usize = 500;

/// Sichtbarer Inhalt einer Zeile (Fortschrittsanzeigen mit `\r` werden übersprungen).
fn visible(line: &str) -> &str {
    line.rsplit('\r').next().unwrap_or(line).trim_end()
}

/// Anfänge der Spalten (Zeichenpositionen) aus der Kopfzeile.
fn columns(header: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut previous_space = true;
    for (i, c) in header.chars().enumerate() {
        if !c.is_whitespace() && previous_space {
            out.push(i);
        }
        previous_space = c.is_whitespace();
    }
    out
}

fn field(chars: &[char], start: usize, end: Option<usize>) -> String {
    let end = end.unwrap_or(chars.len()).min(chars.len());
    chars
        .get(start..end)
        .map(|s| s.iter().collect::<String>().trim().to_owned())
        .unwrap_or_default()
}

/// Liest alle Tabellen aus der Ausgabe von `winget upgrade`.
#[must_use]
pub fn parse_upgrades(output: &str) -> Vec<Upgrade> {
    let lines: Vec<&str> = output.lines().map(visible).collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < lines.len() && out.len() < MAX_PACKAGES {
        let rule = lines[i + 1].trim();
        let header_ok = rule.len() >= 10 && rule.chars().all(|c| c == '-');
        let cols = columns(lines[i]);
        if !header_ok || !(4..=6).contains(&cols.len()) {
            i += 1;
            continue;
        }
        i += 2;
        while i < lines.len() && out.len() < MAX_PACKAGES {
            let chars: Vec<char> = lines[i].chars().collect();
            // Fußzeile („2 Aktualisierungen verfügbar.“) oder Leerzeile beendet die Tabelle.
            if chars.len() <= cols[2] || chars.iter().all(|c| c.is_whitespace()) {
                break;
            }
            let get = |k: usize| field(&chars, cols[k], cols.get(k + 1).copied());
            let name = get(0);
            let id = get(1);
            let version = get(2);
            let available = get(3);
            let source = if cols.len() >= 5 {
                get(4)
            } else {
                String::new()
            };
            i += 1;
            let truncated = name.ends_with('…') || id.ends_with('…');
            let id_ok = valid_package_id(&id) || (truncated && id.ends_with('…'));
            if !id_ok || !valid_package_version(&available) || version.is_empty() {
                continue;
            }
            out.push(Upgrade {
                name: name.chars().take(120).collect(),
                id,
                version: version.chars().take(64).collect(),
                available,
                source: source.chars().take(32).collect(),
                truncated,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const EN: &str = "\r   - \r   \\ \rName                       Id                     Version   Available Source\n\
------------------------------------------------------------------------------------\n\
Mozilla Firefox (x64 de)   Mozilla.Firefox.de     130.0     131.0.2   winget\n\
7-Zip 23.01 (x64)          7zip.7zip              23.01     24.08     winget\n\
Microsoft Visual C++ 2015… Microsoft.VCRedist.20… 14.38     14.40.1   winget\n\
Tool mit Schalter          --override             1.0       2.0       winget\n\
Komisch                    Odd.App                1.0       < 2.0     winget\n\
5 upgrades available.\n";

    #[test]
    fn tabelle_lesen() {
        let list = parse_upgrades(EN);
        assert_eq!(list.len(), 3, "{list:#?}");
        assert_eq!(list[0].id, "Mozilla.Firefox.de");
        assert_eq!(list[0].version, "130.0");
        assert_eq!(list[0].available, "131.0.2");
        assert_eq!(list[0].source, "winget");
        assert!(!list[0].truncated);
        assert_eq!(list[1].name, "7-Zip 23.01 (x64)");
        assert!(list[2].truncated, "gekürzte Kennung wird markiert");
    }

    #[test]
    fn deutsche_ueberschriften_und_zweite_tabelle() {
        let de = "Name        ID           Version Verfügbar Quelle\n\
--------------------------------------------------\n\
Git         Git.Git      2.46.0  2.47.0    winget\n\
\n\
Die folgenden Pakete haben ein Upgrade, das explizit angegeben werden muss:\n\
Name        ID           Version Verfügbar Quelle\n\
--------------------------------------------------\n\
Node.js     OpenJS.NodeJS 20.1.0 22.11.0   winget\n";
        let list = parse_upgrades(de);
        assert_eq!(list.len(), 2, "{list:#?}");
        assert_eq!(list[0].id, "Git.Git");
        assert_eq!(list[1].name, "Node.js");
    }

    #[test]
    fn nichts_oder_unbekanntes() {
        assert!(parse_upgrades("").is_empty());
        assert!(parse_upgrades("No installed package found matching input criteria.").is_empty());
        assert!(parse_upgrades("a b c\n----------\n").is_empty());
    }
}
