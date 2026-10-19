//! Panic-Button (P5): trennt den Rechner vom Netz, z. B. bei einem Ransomware-Verdacht –
//! **nur** mit der Erlaubnis des Plans „Netz trennen“ (Einstellung [`PANIC_SETTING`], Wert
//! `on`); „Wieder verbinden“ ist ein eigener Plan (Wert `off`).
//!
//! Umsetzung: zwei Sperrregeln der Windows-Firewall (ein- und ausgehend, alle Profile). In der
//! Windows-Firewall haben Sperrregeln Vorrang vor Erlaubnisregeln; ist die Firewall aus, wird
//! sie eingeschaltet (und bleibt an – das steht im Plan). Lokale Verbindungen auf dem Rechner
//! selbst (Loopback) sind nicht betroffen; AEGIS selbst arbeitet ohne Netz weiter.

use std::path::PathBuf;
#[cfg(windows)]
use std::time::{Duration, Instant};

/// Kennung der Einstellung im Plan.
pub const PANIC_SETTING: &str = "panic.network";

/// Namen der Sperrregeln (eindeutig, damit „Wieder verbinden“ genau diese löscht).
pub const RULE_OUT: &str = "AEGIS Panic-Button – ausgehend gesperrt";
/// Eingehende Sperrregel.
pub const RULE_IN: &str = "AEGIS Panic-Button – eingehend gesperrt";

/// Befehle für „Netz trennen“ (fest, ohne Eingaben).
#[must_use]
pub fn block_commands() -> Vec<Vec<String>> {
    let rule = |name: &str, dir: &str| {
        vec![
            "advfirewall".into(),
            "firewall".into(),
            "add".into(),
            "rule".into(),
            format!("name={name}"),
            format!("dir={dir}"),
            "action=block".into(),
            "enable=yes".into(),
            "profile=any".into(),
        ]
    };
    vec![
        ["advfirewall", "set", "allprofiles", "state", "on"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect(),
        rule(RULE_OUT, "out"),
        rule(RULE_IN, "in"),
    ]
}

/// Befehle für „Wieder verbinden“ (löscht genau die AEGIS-Regeln).
#[must_use]
pub fn restore_commands() -> Vec<Vec<String>> {
    [RULE_OUT, RULE_IN]
        .iter()
        .map(|name| {
            vec![
                "advfirewall".into(),
                "firewall".into(),
                "delete".into(),
                "rule".into(),
                format!("name={name}"),
            ]
        })
        .collect()
}

/// `netsh.exe` am festen Systemort.
#[cfg_attr(not(windows), allow(dead_code))]
fn netsh() -> Option<PathBuf> {
    let root = std::env::var_os("SystemRoot").map(PathBuf::from)?;
    Some(root.join(r"System32\netsh.exe"))
}

/// Führt die Befehle aus (je höchstens 30 s). Nur mit der Erlaubnis des Panic-Plans aufrufen.
///
/// # Errors
/// `netsh` fehlt, startet nicht, braucht zu lange oder meldet einen Fehler.
#[cfg(windows)]
pub(crate) fn run(
    permit: &aegis_core::consent::ExecutionPermit,
    commands: &[Vec<String>],
) -> Result<(), String> {
    let _ = permit.plan();
    let exe = netsh().ok_or("SystemRoot unbekannt")?;
    for args in commands {
        // Ändert nur die Windows-Firewall nach Freigabe des Plans „Netz trennen“ bzw.
        // „Wieder verbinden“ – fester Systempfad, feste Argumente.
        // aegis-mutation: service-panic-netsh
        #[allow(clippy::disallowed_methods)]
        let child = std::process::Command::new(&exe)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        let mut child = child.map_err(|e| format!("netsh startet nicht: {e}"))?;
        let deadline = Instant::now() + Duration::from_secs(30);
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                break status;
            }
            if Instant::now() >= deadline {
                // Beendet nur das selbst gestartete netsh nach Ablauf der Frist.
                // aegis-mutation: service-panic-netsh-timeout
                #[allow(clippy::disallowed_methods)]
                let _ = child.kill();
                return Err("netsh hat zu lange gebraucht".into());
            }
            std::thread::sleep(Duration::from_millis(200));
        };
        // Beim Löschen ist „Regel nicht gefunden“ (Code 1) kein Fehler.
        let delete = args.iter().any(|a| a == "delete");
        if !status.success() && !(delete && status.code() == Some(1)) {
            return Err(format!(
                "netsh meldet Code {} ({})",
                status.code().unwrap_or(-1),
                args.join(" ")
            ));
        }
    }
    Ok(())
}

/// Nicht-Windows: kein Panic-Button.
///
/// # Errors
/// Immer.
#[cfg(not(windows))]
pub(crate) fn run(
    permit: &aegis_core::consent::ExecutionPermit,
    commands: &[Vec<String>],
) -> Result<(), String> {
    let _ = (permit.plan(), commands);
    Err("Den Panic-Button gibt es nur unter Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn befehle_sind_fest_und_loeschen_nur_aegis_regeln() {
        let block = block_commands();
        assert_eq!(block.len(), 3);
        assert!(block[1].contains(&"action=block".to_owned()));
        assert!(block[1].contains(&"dir=out".to_owned()));
        assert!(block[2].contains(&"dir=in".to_owned()));
        for cmd in restore_commands() {
            assert!(cmd.contains(&"delete".to_owned()));
            let name = cmd.last().unwrap();
            assert!(name.starts_with("name=AEGIS Panic-Button"), "{name}");
        }
    }
}
