//! Zugriffslisten (SDDL) der Labor-Ordner – eine Stelle für Betrieb und Tests.
//!
//! Ein AppContainer-Prozess kommt nur an einen Ordner, wenn **beide** Prüfungen bestehen: die
//! für den Nutzer (sein Token) und die für den AppContainer. Deshalb erhalten der Nutzer des
//! Laufs und der AppContainer des Laufs je Lesen/Schreiben/Ausführen.

/// Lesen, Schreiben, Ausführen (ohne Löschen/Rechte ändern): `0x1301bf`.
const MODIFY: &str = "0x1301bf";

fn check_sid(sid: &str) -> Result<&str, String> {
    let ok = sid.starts_with("S-1-")
        && sid.len() <= 184
        && sid[4..]
            .split('-')
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    if ok {
        Ok(sid)
    } else {
        Err(format!("Ungültige SID: {sid:?}"))
    }
}

/// Arbeitsordner der Mini-Sandbox: SYSTEM/Administratoren voll, Nutzer und AppContainer des
/// Laufs ändern.
///
/// # Errors
/// Ungültige SID.
pub fn mini_work_dir(appcontainer_sid: &str, user_sid: &str) -> Result<String, String> {
    let (ac, user) = (check_sid(appcontainer_sid)?, check_sid(user_sid)?);
    Ok(format!(
        "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;{MODIFY};;;{user})(A;OICI;{MODIFY};;;{ac})"
    ))
}

/// Stufe 1, Lauf- und Probe-Ordner: der Nutzer darf nur lesen (die Windows Sandbox bindet den
/// Probe-Ordner nur lesbar ein).
///
/// # Errors
/// Ungültige SID.
pub fn wsb_read_only(user_sid: &str) -> Result<String, String> {
    let user = check_sid(user_sid)?;
    Ok(format!(
        "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FR;;;{user})"
    ))
}

/// Stufe 1, Ausgabe-Ordner: die Sonde schreibt über die Windows Sandbox (als Nutzer) hinein.
///
/// # Errors
/// Ungültige SID.
pub fn wsb_output(user_sid: &str) -> Result<String, String> {
    let user = check_sid(user_sid)?;
    Ok(format!(
        "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;{MODIFY};;;{user})"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nutzer_und_appcontainer_erhalten_rechte() {
        let sddl = mini_work_dir("S-1-15-2-1-2-3", "S-1-5-21-9-8-7-1001").unwrap();
        assert!(sddl.contains("(A;OICI;0x1301bf;;;S-1-5-21-9-8-7-1001)"));
        assert!(sddl.contains("(A;OICI;0x1301bf;;;S-1-15-2-1-2-3)"));
        assert!(sddl.starts_with("D:P"), "geschützt, ohne Vererbung");
        assert!(
            wsb_read_only("S-1-5-21-1")
                .unwrap()
                .ends_with("(A;OICI;FR;;;S-1-5-21-1)")
        );
        assert!(wsb_output("S-1-5-21-1").unwrap().contains("0x1301bf"));
    }

    #[test]
    fn ungueltige_sids_werden_abgelehnt() {
        for bad in [
            "",
            "WD",
            "S-1-5-21-1)(A;;FA;;;WD",
            "S-1-",
            "S-1-5--1",
            "S-1-5-x",
        ] {
            assert!(mini_work_dir("S-1-15-2-1", bad).is_err(), "{bad:?}");
            assert!(wsb_output(bad).is_err(), "{bad:?}");
        }
    }
}
