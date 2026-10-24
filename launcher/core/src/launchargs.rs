//! Baut die Startargumente für Fortnite zusammen.
//!
//! Diese alten Builds brauchen feste Platzhalter-Werte, damit sie ohne Epics Server
//! und ohne Easy Anti-Cheat starten – genau wie bei allen OG-Launchern. Easy Anti-Cheat
//! läuft dabei nie; der Build redet ausschließlich mit dem eigenen Backend auf 127.0.0.1.

/// Reinigt einen Spielernamen (nur Buchstaben/Zahlen, 1–16 Zeichen).
pub fn clean_player_name(name: &str, fallback: &str) -> String {
    let cleaned: String = name.chars().filter(|c| c.is_ascii_alphanumeric()).take(16).collect();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

/// Baut die Argumentliste. `host` = Server-Instanz, `headless` = ohne Grafik,
/// `extra` = Zusatzargumente aus dem Profil (z. B. `-d3d11`).
pub fn build(player_name: &str, host: bool, headless: bool, extra: &str) -> Vec<String> {
    let name = clean_player_name(player_name, if host { "Host" } else { "Player" });
    let login = format!("{name}@vanity.local");

    // Reihenfolge und Werte wie bei den OG-Launchern üblich (fester Platzhalter-Token).
    let mut args: Vec<(String, Option<String>)> = vec![
        ("-epicapp".into(), Some("Fortnite".into())),
        ("-epicenv".into(), Some("Prod".into())),
        ("-epiclocale".into(), Some("en-us".into())),
        ("-epicportal".into(), None),
        ("-skippatchcheck".into(), None),
        ("-nobe".into(), None),
        ("-fromfl".into(), Some("eac".into())),
        ("-fltoken".into(), Some("vanitylocaltoken".into())),
        ("-AUTH_LOGIN".into(), Some(login)),
        ("-AUTH_PASSWORD".into(), Some("vanity".into())),
        ("-AUTH_TYPE".into(), Some("epic".into())),
        ("-log".into(), None),
    ];

    if host {
        args.push(("-nosplash".into(), None));
        args.push(("-nosound".into(), None));
        if headless {
            args.push(("-nullrhi".into(), None));
        }
    }

    // Zusatzargumente aus dem Profil; gleiche Schlüssel überschreiben.
    for part in extra.split_whitespace() {
        let (k, v) = match part.split_once('=') {
            Some((k, v)) => (k.to_string(), Some(v.to_string())),
            None => (part.to_string(), None),
        };
        if let Some(slot) = args.iter_mut().find(|(ek, _)| ek.eq_ignore_ascii_case(&k)) {
            slot.1 = v;
        } else {
            args.push((k, v));
        }
    }

    args.into_iter()
        .map(|(k, v)| match v {
            Some(v) => format!("{k}={v}"),
            None => k,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_names() {
        assert_eq!(clean_player_name("georg", "P"), "georg");
        assert_eq!(clean_player_name("gÖrg 99!", "P"), "grg99");
        assert_eq!(clean_player_name("", "Host"), "Host");
        assert_eq!(clean_player_name("verylongname12345678", "P"), "verylongname1234");
    }

    #[test]
    fn host_has_nullrhi_only_when_headless() {
        let a = build("georg", true, true, "");
        assert!(a.contains(&"-nullrhi".to_string()));
        assert!(a.contains(&"-nosound".to_string()));
        let b = build("georg", true, false, "");
        assert!(!b.contains(&"-nullrhi".to_string()));
    }

    #[test]
    fn client_has_no_host_flags() {
        let a = build("georg", false, false, "-d3d11");
        assert!(!a.contains(&"-nullrhi".to_string()));
        assert!(!a.contains(&"-nosplash".to_string()));
        assert!(a.contains(&"-d3d11".to_string()));
        assert!(a.iter().any(|s| s == "-AUTH_LOGIN=georg@vanity.local"));
    }

    #[test]
    fn extra_overrides_duplicate() {
        let a = build("georg", false, false, "-epiclocale=de");
        assert!(a.iter().any(|s| s == "-epiclocale=de"));
        assert_eq!(a.iter().filter(|s| s.starts_with("-epiclocale")).count(), 1);
    }
}
