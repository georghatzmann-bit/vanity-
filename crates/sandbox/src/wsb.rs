//! Stufe 1 – Windows Sandbox: Konfiguration (`.wsb`, XML). Grundsätzlich alles aus, was nach
//! außen führt: Netzwerk aus (simuliertes Netz nur nach Bestätigung), Zwischenablage, Drucker,
//! Audio, Kamera und GPU aus. Der Probe-Ordner ist nur lesbar, ein eigener Ausgabe-Ordner ist
//! beschreibbar (dorthin schreibt die Sonde ihren Bericht).

use std::path::{Path, PathBuf};

/// Netzwerk in der Windows Sandbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Network {
    /// Kein Netzwerk (Standard).
    Off,
    /// Netzwerk an – nur nach ausdrücklicher Bestätigung (die Probe kann dann nach außen
    /// funken; AEGIS zeichnet die Versuche auf).
    Simulated,
}

/// Ordner in der Sandbox, in den der Probe-Ordner eingebunden wird.
pub const SANDBOX_PROBE_DIR: &str = r"C:\AEGIS\Probe";
/// Ordner in der Sandbox für den Bericht.
pub const SANDBOX_OUTPUT_DIR: &str = r"C:\AEGIS\Bericht";
/// Name der Sonde im Probe-Ordner.
pub const PROBE_EXE: &str = "aegis-sandbox-probe.exe";

/// Eine `.wsb`-Konfiguration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WsbConfig {
    /// Ordner auf dem Rechner mit Probe und Sonde (in der Sandbox nur lesbar).
    pub probe_dir: PathBuf,
    /// Ordner auf dem Rechner für den Bericht (in der Sandbox beschreibbar).
    pub output_dir: PathBuf,
    /// Dateiname der Probe im Probe-Ordner.
    pub sample_name: String,
    /// Beobachtungsdauer in Sekunden.
    pub seconds: u32,
    /// Netzwerk.
    pub network: Network,
}

/// Maskiert Text für XML.
#[must_use]
pub fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// Prüft einen Probe-Dateinamen: nur ein einfacher Name (keine Pfade, keine Anführungszeichen,
/// nichts, was die Befehlszeile der Sonde verändern könnte).
///
/// # Errors
/// Text für die Fehler-Antwort.
pub fn check_sample_name(name: &str) -> Result<(), String> {
    let bad = name.is_empty()
        || name.len() > 200
        || name.chars().any(|c| {
            c.is_control()
                || matches!(
                    c,
                    '"' | '\\' | '/' | ':' | '*' | '?' | '<' | '>' | '|' | '%' | '^' | '&'
                )
        })
        || name.starts_with('.')
        || name.trim() != name;
    if bad {
        Err(format!("Ungültiger Dateiname für die Sandbox: {name:?}"))
    } else {
        Ok(())
    }
}

impl WsbConfig {
    /// Befehl, den die Sandbox nach der Anmeldung ausführt: die Sonde startet die Probe,
    /// beobachtet sie und schreibt den Bericht.
    #[must_use]
    pub fn logon_command(&self) -> String {
        format!(
            r#"{SANDBOX_PROBE_DIR}\{PROBE_EXE} --sample "{SANDBOX_PROBE_DIR}\{}" --out "{SANDBOX_OUTPUT_DIR}" --seconds {}"#,
            self.sample_name, self.seconds
        )
    }

    /// Erzeugt das XML.
    ///
    /// # Errors
    /// Ungültiger Probe-Name oder relative Ordner.
    pub fn to_xml(&self) -> Result<String, String> {
        check_sample_name(&self.sample_name)?;
        for dir in [&self.probe_dir, &self.output_dir] {
            if !is_absolute_host_path(dir) {
                return Err(format!("Ordner muss absolut sein: {}", dir.display()));
            }
        }
        let networking = match self.network {
            Network::Off => "Disable",
            Network::Simulated => "Enable",
        };
        Ok(format!(
            r#"<Configuration>
  <VGpu>Disable</VGpu>
  <Networking>{networking}</Networking>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <PrinterRedirection>Disable</PrinterRedirection>
  <ProtectedClient>Enable</ProtectedClient>
  <MemoryInMB>4096</MemoryInMB>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>{probe}</HostFolder>
      <SandboxFolder>{SANDBOX_PROBE_DIR}</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>{output}</HostFolder>
      <SandboxFolder>{SANDBOX_OUTPUT_DIR}</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>{command}</Command>
  </LogonCommand>
</Configuration>
"#,
            probe = xml_escape(&self.probe_dir.to_string_lossy()),
            output = xml_escape(&self.output_dir.to_string_lossy()),
            command = xml_escape(&self.logon_command()),
        ))
    }
}

/// Absoluter Pfad auf dem Rechner (unter Windows mit Laufwerk, sonst `/…` für Tests).
fn is_absolute_host_path(path: &Path) -> bool {
    let text = path.to_string_lossy();
    let drive = text.len() >= 3 && text.as_bytes()[0].is_ascii_alphabetic() && &text[1..3] == ":\\";
    drive || path.is_absolute()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(name: &str) -> WsbConfig {
        WsbConfig {
            probe_dir: PathBuf::from(r"C:\ProgramData\AEGIS\labor\1\probe"),
            output_dir: PathBuf::from(r"C:\ProgramData\AEGIS\labor\1\bericht"),
            sample_name: name.into(),
            seconds: 60,
            network: Network::Off,
        }
    }

    #[test]
    fn alles_nach_aussen_ist_aus_probe_nur_lesbar() {
        let xml = config("setup.exe").to_xml().unwrap();
        for off in [
            "<Networking>Disable</Networking>",
            "<VGpu>Disable</VGpu>",
            "<AudioInput>Disable</AudioInput>",
            "<VideoInput>Disable</VideoInput>",
            "<ClipboardRedirection>Disable</ClipboardRedirection>",
            "<PrinterRedirection>Disable</PrinterRedirection>",
        ] {
            assert!(xml.contains(off), "{off}");
        }
        let probe = xml.find("probe</HostFolder>").unwrap();
        let ro = xml[probe..].find("<ReadOnly>true</ReadOnly>").unwrap();
        let out = xml.find("bericht</HostFolder>").unwrap();
        assert!(probe + ro < out, "Probe-Ordner ist nur lesbar");
        assert!(xml[out..].contains("<ReadOnly>false</ReadOnly>"));
        assert!(
            xml.contains(r#"--sample &quot;C:\AEGIS\Probe\setup.exe&quot;"#),
            "{xml}"
        );
    }

    #[test]
    fn netz_nur_wenn_gewaehlt() {
        let mut c = config("a.exe");
        c.network = Network::Simulated;
        assert!(
            c.to_xml()
                .unwrap()
                .contains("<Networking>Enable</Networking>")
        );
    }

    #[test]
    fn gefaehrliche_namen_und_ordner_werden_abgelehnt() {
        for bad in [
            "",
            "a\"&calc.exe",
            r"..\x.exe",
            "a/b.exe",
            "x.exe & del *",
            "%TEMP%.exe",
            ".hidden",
            " x.exe",
            "a\nb.exe",
        ] {
            assert!(config(bad).to_xml().is_err(), "{bad:?}");
        }
        let mut c = config("a.exe");
        c.output_dir = PathBuf::from("relativ");
        assert!(c.to_xml().is_err());
        assert_eq!(xml_escape("<a&'\">"), "&lt;a&amp;&apos;&quot;&gt;");
    }
}
