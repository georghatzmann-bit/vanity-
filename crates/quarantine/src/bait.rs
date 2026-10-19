//! Köderdateien des Ransomware-Schutzes: harmlose Dateien in Nutzerordnern, die niemand außer
//! einer Verschlüsselungs-Schadsoftware anfassen sollte. Anlegen und Entfernen nur mit der
//! Erlaubnis des Plans „Köderdateien anlegen/entfernen“ (`ChangeSetting`, Einstellung
//! [`BAIT_SETTING`]); die Dateien stehen als Ziele im Plan. Nutzerdateien werden nur mit den
//! Rechten des Nutzers und ohne Links angefasst; entfernt wird nur, was noch genau den
//! AEGIS-Inhalt hat.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use aegis_core::consent::ExecutionPermit;
use aegis_core::plan::{ActionKind, Target, param};

use crate::userfs::{self, UserAccess};

/// Kennung der Einstellung im Plan.
pub const BAIT_SETTING: &str = "ransomware.baits";

/// Name der Köderdateien.
pub const BAIT_NAMES: [&str; 2] = [
    "AEGIS-Koeder - bitte nicht aendern.docx",
    "AEGIS-Koeder - bitte nicht aendern.xlsx",
];

/// Ordner im Profil, in die Köder gelegt werden.
pub const BAIT_DIRS: [&str; 3] = ["Documents", "Desktop", "Pictures"];

/// Inhalt (harmloser Text; Endung nur als Lockmittel).
pub const BAIT_CONTENT: &[u8] = b"AEGIS Suite - Koederdatei des Ransomware-Schutzes.\r\n\
Diese Datei ist harmlos. Bitte nicht aendern, umbenennen oder loeschen:\r\n\
AEGIS meldet jede Aenderung als moeglichen Ransomware-Angriff.\r\n\
Entfernen: AEGIS > Echtzeit-Waechter > Ransomware-Schutz > Koeder entfernen.\r\n";

/// Köderdateien für ein Profil (nur vorhandene Ordner).
#[must_use]
pub fn bait_paths(profile: &Path) -> Vec<PathBuf> {
    BAIT_DIRS
        .iter()
        .map(|d| profile.join(d))
        .filter(|d| d.is_dir())
        .flat_map(|d| BAIT_NAMES.iter().map(move |n| d.join(n)))
        .collect()
}

/// Ergebnis je Datei.
pub type BaitResults = Vec<(PathBuf, Result<(), String>)>;

fn plan_paths(permit: &ExecutionPermit, value: &str) -> Result<Vec<PathBuf>, String> {
    let plan = permit
        .ensure_kind(ActionKind::ChangeSetting)
        .map_err(|e| e.to_string())?;
    let is_bait = plan
        .targets()
        .iter()
        .any(|t| matches!(t, Target::Setting { id } if id == BAIT_SETTING));
    if !is_bait || plan.parameter(param::VALUE) != Some(value) {
        return Err("Plan passt nicht zu den Köderdateien".into());
    }
    Ok(plan
        .targets()
        .iter()
        .filter_map(|t| match t {
            Target::Other { description } => Some(PathBuf::from(description)),
            _ => None,
        })
        .filter(|p| {
            p.is_absolute()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| BAIT_NAMES.contains(&n))
        })
        .collect())
}

/// Legt die Köderdateien aus dem Plan an (nie überschreiben, ohne Links, mit Nutzerrechten).
///
/// # Errors
/// Plan passt nicht.
pub fn create_baits(
    permit: &ExecutionPermit,
    user: &dyn UserAccess,
) -> Result<BaitResults, String> {
    let paths = plan_paths(permit, "on")?;
    let _scope = user
        .enter()
        .map_err(|e| format!("Rechte des Nutzers: {e}"))?;
    Ok(paths
        .into_iter()
        .map(|path| {
            let result = (|| {
                let mut created = userfs::create_restored(&path).map_err(|e| e.to_string())?;
                let written = created
                    .file
                    .write_all(BAIT_CONTENT)
                    .and_then(|()| created.file.sync_all());
                if let Err(e) = written {
                    let _ = userfs::discard_restored(created);
                    return Err(e.to_string());
                }
                Ok(())
            })();
            (path, result)
        })
        .collect())
}

/// Entfernt die Köderdateien aus dem Plan – nur solche, die noch genau den AEGIS-Inhalt
/// haben (eine veränderte Datei bleibt liegen und wird gemeldet).
///
/// # Errors
/// Plan passt nicht.
pub fn remove_baits(
    permit: &ExecutionPermit,
    user: &dyn UserAccess,
) -> Result<BaitResults, String> {
    let paths = plan_paths(permit, "off")?;
    let _scope = user
        .enter()
        .map_err(|e| format!("Rechte des Nutzers: {e}"))?;
    Ok(paths
        .into_iter()
        .map(|path| {
            let result = (|| {
                let mut original = userfs::open_original(&path).map_err(|e| e.to_string())?;
                let mut data = Vec::new();
                (&original.file)
                    .take(BAIT_CONTENT.len() as u64 + 1)
                    .read_to_end(&mut data)
                    .map_err(|e| e.to_string())?;
                if data != BAIT_CONTENT {
                    return Err(
                        "Inhalt wurde verändert – Datei bleibt liegen (bitte prüfen)".to_owned(),
                    );
                }
                let _ = &mut original;
                userfs::remove_original(original).map_err(|e| e.to_string())
            })();
            (path, result)
        })
        .collect())
}
