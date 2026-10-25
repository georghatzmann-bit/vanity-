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

/// Ab dieser Version gibt es in Fortnite kein DirectX 11 mehr (Chapter 6, Dezember 2024).
/// `-d3d11` würde den Start verhindern und wird deshalb weggelassen.
pub const DX11_REMOVED: (u32, u32) = (33, 0);

/// Platzhalter-Token, wie sie OG-Launcher seit 2021 bei jeder Version mitgeben (öffentlich bekannt,
/// kein Geheimnis). Der Build prüft sie nicht gegen Epic – er braucht nur das Format, weil Anti-Cheat
/// nie läuft und alle Anfragen beim eigenen Backend landen. Über die Profil-Argumente überschreibbar.
pub const FLTOKEN: &str = "3db3ba5dcbd2e16703f3978d";
pub const CALDERA: &str = "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2NvdW50X2lkIjoiYmU5ZGE1YzJmYmVhNDQwN2IyZjQwZWJhYWQ4NTlhZDQiLCJnZW5lcmF0ZWQiOjE2Mzg3MTcyNzgsImNhbGRlcmFHdWlkIjoiMzgxMGI4NjMtMmE2NS00NDU3LTliNTgtNGRhYjNiNDgyYTg2IiwiYWNQcm92aWRlciI6IkVhc3lBbnRpQ2hlYXQiLCJub3RlcyI6IiIsImZhbGxiYWNrIjpmYWxzZX0.VAWQB67RTxhiWOxx7DBjnzDnXyyEnX7OljJm-j2d88G_WgwQ9wrE6lwMEHZHjBd1ISJdUO1UVUqkfLdU5nofBQ";

/// Regeln, die von der Fortnite-Version abhängen. Aus der Versionsnummer berechnet,
/// damit jede Version startbar ist – auch solche, die noch niemand mit Vanity getestet hat.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VersionRules {
    pub major: u32,
    pub minor: u32,
    /// `-d3d11` ist erlaubt (bis Chapter 5)
    pub allows_dx11: bool,
    /// Speicherleck-Fix der Umleitung nur für Chapter 1 (Reboot macht es für < 10; wir bis 10.40).
    /// Die Umleitungs-DLL liest dafür `-vanityversion=` aus der Kommandozeile.
    pub memleak_fix: bool,
    /// Sekunden nach der Anmeldung, bis die Server-DLL geladen wird. Builds auf Unreal 4.21
    /// (Fortnite 5.x/6.x) stürzen ohne Fenster ab, wenn die DLL zu spät kommt – dort sofort.
    pub server_inject_delay_secs: u64,
    /// Sekunden nach der Anmeldung, bis das Ingame-Menü geladen wird. Unreal-5-Builds (ab 20.00)
    /// brauchen etwas länger, bis die Engine-Objekte stehen.
    pub client_inject_delay_secs: u64,
}

impl VersionRules {
    pub fn for_version(version: &str) -> VersionRules {
        let v = crate::version::parse_major_minor(version).unwrap_or((0, 0));
        let (major, minor) = v;
        VersionRules {
            major,
            minor,
            allows_dx11: v < DX11_REMOVED,
            memleak_fix: (1, 0) <= v && v <= (10, 40),
            server_inject_delay_secs: if (5, 0) <= v && v < (7, 0) { 0 } else { 3 },
            client_inject_delay_secs: if major >= 20 { 8 } else { 6 },
        }
    }
}

/// Baut die Argumentliste. `host` = Server-Instanz, `headless` = ohne Grafik,
/// `extra` = Zusatzargumente aus dem Profil (z. B. `-d3d11`). `version` = z. B. „19.10“;
/// davon hängen einzelne Argumente ab (siehe `VersionRules`).
pub fn build(player_name: &str, host: bool, headless: bool, extra: &str, version: &str) -> Vec<String> {
    let rules = VersionRules::for_version(version);
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
        ("-fltoken".into(), Some(FLTOKEN.into())),
        ("-caldera".into(), Some(CALDERA.into())),
        ("-AUTH_LOGIN".into(), Some(login)),
        ("-AUTH_PASSWORD".into(), Some("vanity".into())),
        ("-AUTH_TYPE".into(), Some("epic".into())),
        ("-log".into(), None),
        // eigener Hinweis für die Umleitungs-DLL (Unreal ignoriert unbekannte Argumente)
        ("-vanityversion".into(), Some(if version.is_empty() { "0".to_string() } else { version.to_string() })),
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
        // Kein DirectX 11 mehr ab Chapter 6 – das Argument würde den Start verhindern.
        if !rules.allows_dx11 && (k.eq_ignore_ascii_case("-d3d11") || k.eq_ignore_ascii_case("-dx11")) {
            continue;
        }
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
        let a = build("georg", true, true, "", "19.10");
        assert!(a.contains(&"-nullrhi".to_string()));
        assert!(a.contains(&"-nosound".to_string()));
        let b = build("georg", true, false, "", "19.10");
        assert!(!b.contains(&"-nullrhi".to_string()));
    }

    #[test]
    fn tokens_and_version_hint_present() {
        let a = build("georg", false, false, "", "19.10");
        assert!(a.iter().any(|s| s == &format!("-fltoken={FLTOKEN}")));
        assert!(a.iter().any(|s| s.starts_with("-caldera=eyJ")));
        assert!(a.iter().any(|s| s == "-vanityversion=19.10"));
        // Profil darf die Token überschreiben
        let b = build("georg", false, false, "-fltoken=abc", "19.10");
        assert!(b.iter().any(|s| s == "-fltoken=abc"));
        assert_eq!(b.iter().filter(|s| s.starts_with("-fltoken")).count(), 1);
    }

    #[test]
    fn version_rules() {
        let r = VersionRules::for_version("5.41");
        assert!(r.memleak_fix && r.server_inject_delay_secs == 0 && r.client_inject_delay_secs == 6);
        let r = VersionRules::for_version("10.40");
        assert!(r.memleak_fix && r.server_inject_delay_secs == 3);
        let r = VersionRules::for_version("11.00");
        assert!(!r.memleak_fix);
        let r = VersionRules::for_version("28.01");
        assert!(!r.memleak_fix && r.client_inject_delay_secs == 8 && r.allows_dx11);
        assert!(!VersionRules::for_version("33.00").allows_dx11);
    }

    #[test]
    fn dx11_dropped_from_chapter_6() {
        let old = build("georg", false, false, "-d3d11", "32.11");
        assert!(old.contains(&"-d3d11".to_string()));
        let new = build("georg", false, false, "-d3d11 -nosplash", "33.00");
        assert!(!new.contains(&"-d3d11".to_string()));
        assert!(new.contains(&"-nosplash".to_string()));
        assert!(VersionRules::for_version("33.20").major == 33);
        // unlesbare Version → (0, 0) → DX11 erlaubt, damit alte Profile weiterlaufen
        assert!(VersionRules::for_version("unbekannt").allows_dx11);
    }

    #[test]
    fn client_has_no_host_flags() {
        let a = build("georg", false, false, "-d3d11", "19.10");
        assert!(!a.contains(&"-nullrhi".to_string()));
        assert!(!a.contains(&"-nosplash".to_string()));
        assert!(a.contains(&"-d3d11".to_string()));
        assert!(a.iter().any(|s| s == "-AUTH_LOGIN=georg@vanity.local"));
    }

    #[test]
    fn extra_overrides_duplicate() {
        let a = build("georg", false, false, "-epiclocale=de", "19.10");
        assert!(a.iter().any(|s| s == "-epiclocale=de"));
        assert_eq!(a.iter().filter(|s| s.starts_with("-epiclocale")).count(), 1);
    }
}
