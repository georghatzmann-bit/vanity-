//! Windows-Werkzeuge (`powercfg`, `ipconfig`) ohne sichtbares Konsolenfenster ausführen und ihre
//! Ausgabe lesbar machen.
#![cfg_attr(not(windows), allow(dead_code))]

use std::io;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use crate::error::CmdResult;

/// Ergebnis eines Aufrufs (Ausgaben bereits als Text).
#[derive(Debug, Clone, Default)]
pub struct Output {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

impl Output {
    /// Erste aussagekräftige Zeile von Fehler- oder Normalausgabe (für Fehlermeldungen).
    pub fn message(&self) -> String {
        first_line(&self.stderr)
            .or_else(|| first_line(&self.stdout))
            .unwrap_or_else(|| "keine Ausgabe".into())
    }
}

/// Erste nicht leere Zeile eines Textes.
pub fn first_line(s: &str) -> Option<String> {
    s.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.to_string())
}

/// Fester Pfad eines Windows-Programms in `System32`, damit kein gleichnamiges Programm aus dem
/// `PATH` dazwischenfunkt. Ohne `SystemRoot` bleibt es beim bloßen Namen.
fn system_exe(name: &str) -> PathBuf {
    let root = std::env::var_os("SystemRoot").or_else(|| std::env::var_os("WINDIR"));
    match root {
        Some(r) if !r.is_empty() => PathBuf::from(r).join("System32").join(name),
        _ => PathBuf::from(name),
    }
}

/// Führt `name` (z. B. `powercfg.exe`) mit `args` aus und wartet auf das Ende. Unter Windows
/// bleibt das Konsolenfenster verborgen.
pub fn run_hidden(name: &str, args: &[&str]) -> CmdResult<Output> {
    let exe = system_exe(name);
    let label = name.trim_end_matches(".exe");
    let mut cmd = Command::new(&exe);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => format!("Das Windows-Programm „{label}“ wurde nicht gefunden."),
        io::ErrorKind::PermissionDenied => format!("„{label}“ darf nicht ausgeführt werden (Zugriff verweigert)."),
        _ => format!("„{label}“ konnte nicht gestartet werden: {e}"),
    })?;
    Ok(Output {
        success: out.status.success(),
        stdout: decode_console(&out.stdout),
        stderr: decode_console(&out.stderr),
    })
}

/// Konsolenausgabe dekodieren: UTF-8, wenn möglich; sonst der OEM-Zeichensatz der Konsole
/// (z. B. CP850 auf deutschen Systemen, in dem `powercfg` „Höchstleistung“ schreibt).
pub fn decode_console(bytes: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    #[cfg(windows)]
    if let Some(s) = oem_decode(bytes) {
        return s;
    }
    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(windows)]
fn oem_decode(bytes: &[u8]) -> Option<String> {
    use windows::core::PCSTR;
    use windows::Win32::UI::WindowsAndMessaging::OemToCharBuffW;
    if bytes.is_empty() {
        return Some(String::new());
    }
    let mut wide = vec![0u16; bytes.len()];
    // Länge wird explizit übergeben, der Puffer braucht kein Nullzeichen am Ende
    unsafe { OemToCharBuffW(PCSTR(bytes.as_ptr()), &mut wide) }.ok()?;
    Some(String::from_utf16_lossy(&wide))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_prefers_utf8() {
        assert_eq!(decode_console("Höchstleistung".as_bytes()), "Höchstleistung");
        assert_eq!(decode_console(b""), "");
        // Ungültiges UTF-8 (CP850 „ö“ = 0x94) darf nicht zum Fehler führen
        let s = decode_console(b"H\x94chstleistung");
        assert!(s.starts_with('H') && s.ends_with("chstleistung"), "{s}");
    }

    #[test]
    fn first_line_skips_blank_lines() {
        assert_eq!(first_line("\r\n\n  Fehler 1  \nZeile 2"), Some("Fehler 1".into()));
        assert_eq!(first_line("  \n"), None);
        let out = Output { success: false, stdout: "nur stdout".into(), stderr: String::new() };
        assert_eq!(out.message(), "nur stdout");
        assert_eq!(Output::default().message(), "keine Ausgabe");
    }

    #[test]
    fn missing_program_has_friendly_error() {
        let err = run_hidden("pulsar-gibt-es-nicht.exe", &[]).unwrap_err();
        assert!(err.contains("pulsar-gibt-es-nicht"), "{err}");
        assert!(!err.contains(".exe“"), "Endung in der Meldung weglassen: {err}");
    }
}
