//! PDF-Prüfung: JavaScript, Start-Aktionen (`/Launch`), automatische Aktionen beim Öffnen,
//! eingebettete Dateien. Namen werden normalisiert (`/J#61vaScript` → `/JavaScript`), und
//! komprimierte Datenströme (`FlateDecode`) werden – begrenzt – entpackt, weil Objekte darin
//! versteckt sein können. Nur lesen.

use std::io::Read;

use crate::finding::{Reason, Source, Weight};

/// Höchstzahl entpackter Datenströme pro Datei.
const MAX_STREAMS: usize = 256;
/// Höchstgröße eines entpackten Datenstroms.
const MAX_STREAM_OUT: u64 = 4 * 1024 * 1024;
/// Höchstgröße aller entpackten Datenströme zusammen.
const MAX_TOTAL_OUT: u64 = 64 * 1024 * 1024;

/// Beginnt die Datei (innerhalb der ersten 1024 Byte) mit `%PDF-`?
#[must_use]
pub fn is_pdf(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(1024)]
        .windows(5)
        .any(|w| w == b"%PDF-")
}

/// Gefundene Schlüsselwörter.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct PdfKeywords {
    /// `/JavaScript` oder `/JS`.
    pub javascript: bool,
    /// `/Launch` (startet Programme).
    pub launch: bool,
    /// `/OpenAction` oder `/AA` (automatische Aktion).
    pub auto_action: bool,
    /// `/EmbeddedFile`.
    pub embedded_file: bool,
    /// `/XFA` oder `/RichMedia`.
    pub active_content: bool,
}

impl PdfKeywords {
    fn merge(&mut self, other: Self) {
        self.javascript |= other.javascript;
        self.launch |= other.launch;
        self.auto_action |= other.auto_action;
        self.embedded_file |= other.embedded_file;
        self.active_content |= other.active_content;
    }
}

/// Schlüsselwörter in einem Text-Ausschnitt (normalisierte PDF-Namen).
#[must_use]
pub fn keywords(bytes: &[u8]) -> PdfKeywords {
    let mut found = PdfKeywords::default();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'/' {
            i += 1;
            continue;
        }
        let (name, next) = read_name(bytes, i + 1);
        i = next;
        match name.as_slice() {
            b"JavaScript" | b"JS" => found.javascript = true,
            b"Launch" => found.launch = true,
            b"OpenAction" | b"AA" => found.auto_action = true,
            b"EmbeddedFile" | b"EmbeddedFiles" => found.embedded_file = true,
            b"XFA" | b"RichMedia" => found.active_content = true,
            _ => {}
        }
    }
    found
}

/// Liest einen PDF-Namen ab `start` und löst `#xx`-Maskierungen auf.
fn read_name(bytes: &[u8], start: usize) -> (Vec<u8>, usize) {
    let mut out = Vec::new();
    let mut i = start;
    while i < bytes.len() && out.len() < 64 {
        let b = bytes[i];
        if b.is_ascii_whitespace() || b"/<>[]()%{}".contains(&b) {
            break;
        }
        if b == b'#'
            && let Some(h) = bytes.get(i + 1..i + 3)
            && let Ok(s) = std::str::from_utf8(h)
            && let Ok(v) = u8::from_str_radix(s, 16)
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b);
        i += 1;
    }
    (out, i.max(start))
}

/// Alle Schlüsselwörter, auch in komprimierten Datenströmen.
#[must_use]
pub fn scan(bytes: &[u8]) -> (PdfKeywords, bool) {
    let mut found = keywords(bytes);
    let mut total = 0u64;
    let mut streams = 0usize;
    let mut truncated = false;
    let mut pos = 0;
    while let Some(off) = find(&bytes[pos..], b"stream") {
        let start = pos + off + b"stream".len();
        pos = start;
        // „endstream“ selbst enthält „stream“ – überspringen.
        if bytes[..start].ends_with(b"endstream") {
            continue;
        }
        let body_start = match bytes.get(start..start + 2) {
            Some(b"\r\n") => start + 2,
            Some([b'\n', _]) => start + 1,
            _ => continue,
        };
        let Some(len) = find(&bytes[body_start..], b"endstream") else {
            break;
        };
        let body = &bytes[body_start..body_start + len];
        pos = body_start + len;
        if streams >= MAX_STREAMS || total >= MAX_TOTAL_OUT {
            truncated = true;
            break;
        }
        streams += 1;
        let mut out = Vec::new();
        let mut decoder = flate2::read::ZlibDecoder::new(body).take(MAX_STREAM_OUT);
        if decoder.read_to_end(&mut out).is_ok() || !out.is_empty() {
            total += out.len() as u64;
            found.merge(keywords(&out));
        }
    }
    (found, truncated)
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Begründungen für ein PDF.
#[must_use]
pub fn reasons(bytes: &[u8]) -> Vec<Reason> {
    let (k, _) = scan(bytes);
    let mut out = Vec::new();
    if k.javascript {
        out.push(Reason::new(
            "pdf.javascript",
            Source::Content,
            Weight::Score(25),
            "Das PDF enthält JavaScript.",
            "The PDF contains JavaScript.",
        ));
    }
    if k.javascript && k.auto_action {
        out.push(Reason::new(
            "pdf.javascript_on_open",
            Source::Content,
            Weight::Score(15),
            "Das Skript startet automatisch beim Öffnen.",
            "The script runs automatically on open.",
        ));
    }
    if k.launch {
        out.push(Reason::new(
            "pdf.launch",
            Source::Content,
            Weight::Score(40),
            "Das PDF kann ein Programm starten (/Launch).",
            "The PDF can start a program (/Launch).",
        ));
    }
    if k.embedded_file {
        out.push(Reason::new(
            "pdf.embedded_file",
            Source::Content,
            Weight::Score(10),
            "Das PDF enthält eine eingebettete Datei.",
            "The PDF contains an embedded file.",
        ));
    }
    if k.active_content {
        out.push(Reason::new(
            "pdf.active_content",
            Source::Content,
            Weight::Score(10),
            "Das PDF enthält aktive Inhalte (Formulare/Medien).",
            "The PDF contains active content (forms/media).",
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn namen_werden_normalisiert() {
        let k = keywords(b"%PDF-1.7 << /OpenAction 2 0 R /J#61vaScript (x) >>");
        assert!(k.javascript && k.auto_action && !k.launch);
        assert!(is_pdf(b"\x00\x00%PDF-1.4"));
        assert!(!is_pdf(b"hallo"));
    }

    #[test]
    fn versteckt_im_komprimierten_strom() {
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        z.write_all(b"<< /S /Launch /F (cmd.exe) >>").unwrap();
        let packed = z.finish().unwrap();
        let mut pdf = b"%PDF-1.7\n1 0 obj << /Filter /FlateDecode >> stream\n".to_vec();
        pdf.extend_from_slice(&packed);
        pdf.extend_from_slice(b"\nendstream endobj\n%%EOF");
        let codes: Vec<String> = reasons(&pdf).into_iter().map(|r| r.code).collect();
        assert_eq!(codes, ["pdf.launch"]);
        assert!(reasons(b"%PDF-1.7 << /Type /Page >> %%EOF").is_empty());
    }
}
