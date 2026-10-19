//! Firewall-Übersicht (P7.2): Regeln der Windows-Firewall lesen und einordnen (rein). Gelesen
//! wird im Dienst aus der Registrierung (`…\FirewallPolicy\FirewallRules`, nur lesend).
//! Vorschlagen kann AEGIS nur eigene Regeln „Netz für Programm X sperren“ (ausgehend
//! blockieren) – angelegt bzw. entfernt nur per Plan mit „Ja“; fremde Regeln fasst AEGIS nie an.

use serde::{Deserialize, Serialize};

/// Namensanfang aller AEGIS-Regeln (nur diese entfernt AEGIS auch wieder).
pub const AEGIS_PREFIX: &str = "AEGIS-Block-";

/// Eine Firewall-Regel (wie gelesen).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FirewallRule {
    /// Name (kann ein Ressourcen-Verweis `@…` sein).
    pub name: String,
    /// `allow` oder `block`.
    pub action: String,
    /// Aktiv?
    pub active: bool,
    /// `in` oder `out`.
    pub direction: String,
    /// Programm (falls auf eines beschränkt).
    pub program: Option<String>,
    /// Lokale Ports.
    pub local_ports: Option<String>,
    /// Profile (`Domain`, `Private`, `Public`; leer = alle).
    pub profiles: Vec<String>,
    /// Von einer Gruppenrichtlinie?
    pub policy: bool,
}

/// Liest einen Regel-Wert (`v2.30|Action=Allow|Active=TRUE|Dir=In|App=…|Name=…|`).
#[must_use]
pub fn parse_rule(value: &str, policy: bool) -> Option<FirewallRule> {
    if !value.starts_with('v') || value.len() > 16 * 1024 {
        return None;
    }
    let mut rule = FirewallRule {
        name: String::new(),
        action: String::new(),
        active: false,
        direction: String::new(),
        program: None,
        local_ports: None,
        profiles: Vec::new(),
        policy,
    };
    for part in value.split('|').skip(1) {
        let Some((key, val)) = part.split_once('=') else {
            continue;
        };
        let val: String = val.chars().filter(|c| !c.is_control()).take(400).collect();
        match key {
            "Action" => rule.action = val.to_ascii_lowercase(),
            "Active" => rule.active = val.eq_ignore_ascii_case("TRUE"),
            "Dir" => rule.direction = val.to_ascii_lowercase(),
            "App" => rule.program = Some(val),
            "LPort" => {
                rule.local_ports = Some(match rule.local_ports.take() {
                    Some(p) => format!("{p},{val}"),
                    None => val,
                });
            }
            "Profile" => rule.profiles.push(val),
            "Name" => rule.name = val,
            _ => {}
        }
    }
    (!rule.action.is_empty() && !rule.direction.is_empty()).then_some(rule)
}

/// Auffälligkeit einer Regel (Deutsch, Englisch) – oder `None`.
#[must_use]
pub fn notable(rule: &FirewallRule) -> Option<(String, String)> {
    if !rule.active || rule.action != "allow" || rule.direction != "in" {
        return None;
    }
    let program = rule.program.as_deref()?.to_lowercase();
    let writable = [
        "\\appdata\\local\\temp\\",
        "\\downloads\\",
        "\\users\\public\\",
        "\\windows\\temp\\",
        "\\programdata\\",
    ];
    writable.iter().any(|w| program.contains(w)).then(|| {
        (
            "Eingehende Verbindungen sind für ein Programm aus einem Download-/Temp-Ordner erlaubt – ungewöhnlich für normale Software.".to_owned(),
            "Incoming connections are allowed for a program in a download/temp folder – unusual for normal software.".to_owned(),
        )
    })
}

/// FNV-1a (64 Bit) – nur für stabile Namen.
fn fnv(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

/// Name der AEGIS-Regel für ein Programm (ohne Leerzeichen, stabil je Pfad).
#[must_use]
pub fn block_rule_name(program: &str) -> String {
    format!("{AEGIS_PREFIX}{:016x}", fnv(&program.to_lowercase()))
}

/// Ist das ein Name einer AEGIS-Regel (genau das Format)?
#[must_use]
pub fn is_aegis_rule(name: &str) -> bool {
    name.strip_prefix(AEGIS_PREFIX)
        .is_some_and(|h| h.len() == 16 && h.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Programmpfad für eine Regel: absolut (`X:\…`), `.exe`, ohne `"`, `..`, `/`, Steuerzeichen.
#[must_use]
pub fn valid_program(path: &str) -> bool {
    let b = path.as_bytes();
    b.len() >= 7
        && b.len() <= 260
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && b[2] == b'\\'
        && path.to_ascii_lowercase().ends_with(".exe")
        && !path.split('\\').any(|p| p == "..")
        && !path
            .chars()
            .any(|c| c.is_control() || matches!(c, '"' | '/' | '|'))
}

/// Zusammenfassung für die Oberfläche.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Summary {
    /// Alle Regeln.
    pub total: usize,
    /// Aktive Regeln.
    pub active: usize,
    /// Aktiv, eingehend erlaubt.
    pub inbound_allow: usize,
    /// Aktiv, blockierend.
    pub block: usize,
    /// Per Gruppenrichtlinie.
    pub policy: usize,
}

/// Zählt die Regeln.
#[must_use]
pub fn summarize(rules: &[FirewallRule]) -> Summary {
    Summary {
        total: rules.len(),
        active: rules.iter().filter(|r| r.active).count(),
        inbound_allow: rules
            .iter()
            .filter(|r| r.active && r.action == "allow" && r.direction == "in")
            .count(),
        block: rules
            .iter()
            .filter(|r| r.active && r.action == "block")
            .count(),
        policy: rules.iter().filter(|r| r.policy).count(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regeln_lesen() {
        let r = parse_rule(
            r"v2.31|Action=Allow|Active=TRUE|Dir=In|Protocol=6|Profile=Private|Profile=Public|LPort=8080|App=C:\Users\a\Downloads\srv.exe|Name=Mein Server|",
            false,
        )
        .unwrap();
        assert_eq!(r.action, "allow");
        assert!(r.active);
        assert_eq!(r.direction, "in");
        assert_eq!(r.local_ports.as_deref(), Some("8080"));
        assert_eq!(r.profiles, vec!["Private", "Public"]);
        assert_eq!(r.name, "Mein Server");
        assert!(notable(&r).is_some());
        let normal = parse_rule(
            r"v2.31|Action=Allow|Active=TRUE|Dir=In|App=C:\Program Files\X\x.exe|Name=X|",
            true,
        )
        .unwrap();
        assert!(notable(&normal).is_none());
        assert!(parse_rule("Murks", false).is_none());
        assert!(parse_rule("v2.31|Name=nur Name|", false).is_none());
        let s = summarize(&[r, normal]);
        assert_eq!((s.total, s.inbound_allow, s.policy), (2, 2, 1));
    }

    #[test]
    fn aegis_regeln_und_programme() {
        let name = block_rule_name(r"C:\Temp\X.exe");
        assert_eq!(name, block_rule_name(r"c:\temp\x.exe"));
        assert!(is_aegis_rule(&name));
        assert!(!name.contains(' '));
        assert!(!is_aegis_rule("AEGIS-Block-zz"));
        assert!(!is_aegis_rule("Fremde Regel"));
        assert!(valid_program(r"C:\Program Files\App\app.exe"));
        for bad in [
            r"app.exe",
            r"C:\a\..\b.exe",
            r#"C:\a\"b.exe"#,
            r"C:\a\b.dll",
            r"\\server\x.exe",
            r"C:/a/b.exe",
        ] {
            assert!(!valid_program(bad), "{bad}");
        }
    }
}
