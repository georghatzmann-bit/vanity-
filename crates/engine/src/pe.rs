//! Statische Analyse von Windows-Programmen (PE): nur lesen, nichts ausführen.
//!
//! Die Ergebnisse sind **Hinweise**, keine Urteile: Viele harmlose Programme sind gepackt
//! oder unsigniert. Deshalb liefern sie nur Punkte für die Heuristik.

use goblin::pe::PE;
use goblin::pe::section_table::{IMAGE_SCN_MEM_EXECUTE, IMAGE_SCN_MEM_WRITE};
use serde::Serialize;

use crate::entropy::shannon;
use crate::finding::{Reason, Source, Weight};

/// Abschnitt (Section) eines PE.
#[derive(Debug, Clone, Serialize)]
pub struct SectionInfo {
    /// Name (max. 8 Zeichen).
    pub name: String,
    /// Entropie der Rohdaten.
    pub entropy: f64,
    /// Größe der Rohdaten.
    pub raw_size: u32,
    /// Ausführbar?
    pub executable: bool,
    /// Beschreibbar?
    pub writable: bool,
}

/// Ergebnis der PE-Analyse.
#[derive(Debug, Clone, Serialize)]
pub struct PeInfo {
    /// 64-Bit?
    pub is_64: bool,
    /// DLL?
    pub is_dll: bool,
    /// Enthält ein Authenticode-Zertifikat (ob gültig, prüft Windows – ab P3).
    pub has_signature: bool,
    /// Abschnitte.
    pub sections: Vec<SectionInfo>,
    /// Anzahl importierter Funktionen.
    pub import_count: usize,
    /// Auffällige Importe (Prozess-Manipulation u. Ä.).
    pub notable_imports: Vec<String>,
}

/// Importe, die Programme zum Eingreifen in **andere** Prozesse nutzen. Auch Debugger,
/// Trainer und Sicherheitssoftware tun das – daher nur ein Hinweis.
const PROCESS_TAMPERING: [&str; 7] = [
    "WriteProcessMemory",
    "CreateRemoteThread",
    "CreateRemoteThreadEx",
    "VirtualAllocEx",
    "NtUnmapViewOfSection",
    "QueueUserAPC",
    "SetWindowsHookExA",
];

/// Bekannte Packer-Abschnittsnamen.
const PACKER_SECTIONS: [(&str, &str); 6] = [
    ("UPX0", "UPX"),
    ("UPX1", "UPX"),
    (".aspack", "ASPack"),
    (".MPRESS1", "MPRESS"),
    (".petite", "Petite"),
    (".themida", "Themida"),
];

/// Ist das ein PE (beginnt mit „MZ“)?
#[must_use]
pub fn looks_like_pe(bytes: &[u8]) -> bool {
    bytes.starts_with(b"MZ")
}

/// Analysiert ein PE. `Err` mit Text, wenn die Datei mit „MZ“ beginnt, aber kaputt ist.
///
/// # Errors
/// Fehlerhafte PE-Struktur.
pub fn analyze(bytes: &[u8]) -> Result<PeInfo, String> {
    let pe = PE::parse(bytes).map_err(|e| e.to_string())?;
    let sections = pe
        .sections
        .iter()
        .map(|s| {
            let start = usize::try_from(s.pointer_to_raw_data).unwrap_or(usize::MAX);
            let len = usize::try_from(s.size_of_raw_data).unwrap_or(0);
            let data = bytes
                .get(start..start.saturating_add(len).min(bytes.len()))
                .unwrap_or(&[]);
            SectionInfo {
                name: String::from_utf8_lossy(&s.name)
                    .trim_end_matches('\0')
                    .to_owned(),
                entropy: shannon(data),
                raw_size: s.size_of_raw_data,
                executable: s.characteristics & IMAGE_SCN_MEM_EXECUTE != 0,
                writable: s.characteristics & IMAGE_SCN_MEM_WRITE != 0,
            }
        })
        .collect();
    let mut notable: Vec<String> = pe
        .imports
        .iter()
        .map(|i| i.name.to_string())
        .filter(|n| PROCESS_TAMPERING.contains(&n.as_str()))
        .collect();
    notable.sort();
    notable.dedup();
    Ok(PeInfo {
        is_64: pe.is_64,
        is_dll: pe.is_lib,
        has_signature: !pe.certificates.is_empty(),
        sections,
        import_count: pe.imports.len(),
        notable_imports: notable,
    })
}

/// Begründungen aus der PE-Analyse.
#[must_use]
pub fn reasons(info: &PeInfo) -> Vec<Reason> {
    let mut out = Vec::new();
    let packer = info.sections.iter().find_map(|s| {
        PACKER_SECTIONS
            .iter()
            .find(|(n, _)| *n == s.name)
            .map(|(_, p)| *p)
    });
    if let Some(packer) = packer {
        out.push(Reason::new(
            "pe.packed.known",
            Source::Static,
            Weight::Score(20),
            &format!(
                "Mit {packer} gepackt – verbirgt den eigentlichen Code vor einfacher Prüfung."
            ),
            &format!("Packed with {packer} – hides the actual code from simple inspection."),
        ));
    }
    let high_entropy_exec = info
        .sections
        .iter()
        .any(|s| s.executable && s.entropy > 7.2 && s.raw_size > 4096);
    if high_entropy_exec && packer.is_none() {
        out.push(Reason::new(
            "pe.entropy.high",
            Source::Static,
            Weight::Score(25),
            "Ausführbarer Teil ist stark verdichtet oder verschlüsselt (hohe Entropie).",
            "Executable part is heavily compressed or encrypted (high entropy).",
        ));
    }
    if info.sections.iter().any(|s| s.executable && s.writable) {
        out.push(Reason::new(
            "pe.section.wx",
            Source::Static,
            Weight::Score(15),
            "Ein Abschnitt ist gleichzeitig beschreibbar und ausführbar – typisch für Packer oder Code-Nachladen.",
            "A section is both writable and executable – typical for packers or code loading.",
        ));
    }
    if info.import_count < 5 && !info.is_dll {
        out.push(Reason::new(
            "pe.imports.few",
            Source::Static,
            Weight::Score(15),
            "Kaum sichtbare Importe – Funktionen werden vermutlich erst zur Laufzeit geladen.",
            "Hardly any visible imports – functions are probably resolved at runtime.",
        ));
    }
    if !info.notable_imports.is_empty() {
        out.push(Reason::new(
            "pe.imports.process_tampering",
            Source::Static,
            Weight::Score(20),
            &format!(
                "Kann in andere Prozesse eingreifen ({}). Das tun auch Debugger und Spiel-Trainer.",
                info.notable_imports.join(", ")
            ),
            &format!(
                "Can tamper with other processes ({}). Debuggers and game trainers do this too.",
                info.notable_imports.join(", ")
            ),
        ));
    }
    if !info.has_signature {
        out.push(Reason::new(
            "pe.unsigned",
            Source::Static,
            Weight::Score(10),
            "Ohne digitale Signatur – der Hersteller ist nicht nachweisbar.",
            "Not digitally signed – the publisher cannot be verified.",
        ));
    }
    out
}

/// Begründung für ein beschädigtes PE.
#[must_use]
pub fn malformed_reason(error: &str) -> Reason {
    Reason::new(
        "pe.malformed",
        Source::Static,
        Weight::Score(25),
        &format!("Sieht wie ein Programm aus, ist aber fehlerhaft aufgebaut ({error})."),
        &format!("Looks like a program but is malformed ({error})."),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kein_pe_und_kaputtes_pe() {
        assert!(!looks_like_pe(b"hello"));
        assert!(looks_like_pe(b"MZ\x90\x00"));
        assert!(analyze(b"MZ\x90\x00 kaputt").is_err());
        let r = malformed_reason("zu kurz");
        assert_eq!(r.code, "pe.malformed");
    }

    #[test]
    fn begruendungen_aus_merkmalen() {
        let info = PeInfo {
            is_64: true,
            is_dll: false,
            has_signature: false,
            sections: vec![SectionInfo {
                name: "UPX1".into(),
                entropy: 7.9,
                raw_size: 100_000,
                executable: true,
                writable: true,
            }],
            import_count: 2,
            notable_imports: vec!["WriteProcessMemory".into()],
        };
        let codes: Vec<String> = reasons(&info).into_iter().map(|r| r.code).collect();
        assert_eq!(
            codes,
            [
                "pe.packed.known",
                "pe.section.wx",
                "pe.imports.few",
                "pe.imports.process_tampering",
                "pe.unsigned"
            ]
        );
        let signed = PeInfo {
            has_signature: true,
            sections: vec![],
            import_count: 50,
            notable_imports: vec![],
            ..info
        };
        assert!(reasons(&signed).is_empty());
    }
}
