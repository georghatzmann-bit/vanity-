//! Verhaltensbericht eines Labor-Laufs und die daraus abgeleitete, verständliche Einschätzung
//! („Dieses Programm versucht, sich im Autostart einzutragen und fremde Server zu
//! kontaktieren“). Der Bericht beschreibt nur Beobachtungen – er verändert nichts.

use aegis_core::risk::RiskLevel;
use serde::{Deserialize, Serialize};

use crate::entropy::HIGH;

/// Höchstzahl Einträge je Liste (eine Probe kann nicht beliebig viel Speicher belegen).
pub const MAX_ITEMS: usize = 5000;

/// In welcher Stufe beobachtet wurde.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    /// Windows Sandbox (eigene, wegwerfbare VM).
    WindowsSandbox,
    /// Mini-Sandbox (AppContainer, niedrige Integrität, Job-Objekt) – schwächer als eine VM.
    MiniSandbox,
}

/// Wie der Lauf endete.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RunEnd {
    /// Programm hat sich selbst beendet.
    Exited {
        /// Rückgabewert.
        code: i64,
    },
    /// Beobachtungszeit abgelaufen – alle Prozesse des Laufs wurden beendet.
    TimedOut,
    /// Start nicht möglich.
    Failed {
        /// Grund.
        message: String,
    },
}

/// Gestarteter Prozess.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessRecord {
    /// Prozess-ID.
    pub pid: u32,
    /// Elternprozess.
    pub parent: u32,
    /// Programm.
    pub image: String,
    /// Befehlszeile (falls bekannt).
    #[serde(default)]
    pub command_line: Option<String>,
}

/// Art einer Änderung.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Change {
    /// Neu angelegt.
    Created,
    /// Geändert.
    Modified,
    /// Gelöscht.
    Deleted,
}

/// Datei-Änderung.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileChange {
    /// Pfad (in der Sandbox).
    pub path: String,
    /// Art.
    pub change: Change,
    /// Größe danach.
    #[serde(default)]
    pub size: u64,
    /// Entropie des Inhalts (Bit/Byte), falls lesbar.
    #[serde(default)]
    pub entropy: Option<f64>,
}

/// Registry-Änderung.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistryChange {
    /// Schlüssel.
    pub key: String,
    /// Wert (leer = Standardwert bzw. Schlüssel selbst).
    #[serde(default)]
    pub value: String,
    /// Art.
    pub change: Change,
    /// Neue Daten (gekürzt).
    #[serde(default)]
    pub data: Option<String>,
}

/// Netzwerkversuch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetworkAttempt {
    /// Ziel (Adresse oder Name).
    pub remote: String,
    /// Port.
    pub port: u16,
    /// Gesperrt (Netz in der Sandbox aus)?
    pub blocked: bool,
}

/// Der Bericht.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BehaviorReport {
    /// Stufe.
    pub stage: Stage,
    /// Name der Probe.
    pub sample: String,
    /// SHA-256 der Probe.
    #[serde(default)]
    pub sha256: Option<String>,
    /// Beobachtungszeit (s).
    pub seconds: u32,
    /// Ende.
    pub end: RunEnd,
    /// Prozesse.
    #[serde(default)]
    pub processes: Vec<ProcessRecord>,
    /// Dateien.
    #[serde(default)]
    pub files: Vec<FileChange>,
    /// Registry.
    #[serde(default)]
    pub registry: Vec<RegistryChange>,
    /// Netzwerk.
    #[serde(default)]
    pub network: Vec<NetworkAttempt>,
    /// Bildschirmfotos (Dateinamen im Ausgabe-Ordner, in zeitlicher Reihenfolge).
    #[serde(default)]
    pub screenshots: Vec<String>,
    /// Ehrliche Hinweise zu Grenzen der Beobachtung.
    #[serde(default)]
    pub notes: Vec<String>,
}

/// Ein beobachtetes Verhalten.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Behavior {
    /// Trägt sich in den Autostart ein.
    Autostart,
    /// Versucht, Server zu kontaktieren.
    Network,
    /// Schreibt viele Dateien, die wie verschlüsselt aussehen.
    EncryptsFiles,
    /// Löscht Schattenkopien bzw. Wiederherstellung.
    DeletesBackups,
    /// Legt ausführbare Dateien oder Skripte ab.
    DropsExecutables,
    /// Startet Kommandozeilen/Skript-Interpreter.
    SpawnsInterpreters,
    /// Löscht viele Dateien.
    DeletesFiles,
}

impl Behavior {
    /// Teilsatz (deutsch) für die Einschätzung.
    #[must_use]
    pub fn phrase_de(self) -> &'static str {
        match self {
            Self::Autostart => "sich im Autostart einzutragen",
            Self::Network => "fremde Server zu kontaktieren",
            Self::EncryptsFiles => "viele Dateien zu verschlüsseln",
            Self::DeletesBackups => "Sicherungen (Schattenkopien) zu löschen",
            Self::DropsExecutables => "weitere Programme oder Skripte abzulegen",
            Self::SpawnsInterpreters => "Kommandozeile oder Skript-Interpreter zu starten",
            Self::DeletesFiles => "viele Dateien zu löschen",
        }
    }

    /// Teilsatz (englisch).
    #[must_use]
    pub fn phrase_en(self) -> &'static str {
        match self {
            Self::Autostart => "add itself to autostart",
            Self::Network => "contact external servers",
            Self::EncryptsFiles => "encrypt many files",
            Self::DeletesBackups => "delete backups (shadow copies)",
            Self::DropsExecutables => "drop further programs or scripts",
            Self::SpawnsInterpreters => "start a command line or script interpreter",
            Self::DeletesFiles => "delete many files",
        }
    }

    /// Stark belastend (zählt für „Gefährlich“)?
    #[must_use]
    pub fn strong(self) -> bool {
        matches!(
            self,
            Self::Autostart | Self::EncryptsFiles | Self::DeletesBackups | Self::Network
        )
    }
}

/// Einschätzung.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Assessment {
    /// Stufe.
    pub risk: RiskLevel,
    /// Beobachtete Verhaltensweisen (sortiert).
    pub behaviors: Vec<Behavior>,
    /// Zusammenfassung (deutsch).
    pub summary_de: String,
    /// Zusammenfassung (englisch).
    pub summary_en: String,
}

const AUTOSTART_KEYS: [&str; 8] = [
    r"\software\microsoft\windows\currentversion\run",
    r"\software\microsoft\windows\currentversion\runonce",
    r"\software\microsoft\windows\currentversion\policies\explorer\run",
    r"\software\microsoft\windows nt\currentversion\winlogon",
    r"\software\wow6432node\microsoft\windows\currentversion\run",
    r"\system\currentcontrolset\services\",
    r"\software\microsoft\windows nt\currentversion\image file execution options",
    r"\software\microsoft\active setup\installed components",
];
const AUTOSTART_DIRS: [&str; 2] = [
    r"\start menu\programs\startup\",
    r"\windows\system32\tasks\",
];
const EXECUTABLE_EXT: [&str; 14] = [
    "exe", "dll", "scr", "com", "sys", "ps1", "vbs", "vbe", "js", "jse", "bat", "cmd", "hta", "msi",
];
const INTERPRETERS: [&str; 9] = [
    "cmd.exe",
    "powershell.exe",
    "pwsh.exe",
    "wscript.exe",
    "cscript.exe",
    "mshta.exe",
    "rundll32.exe",
    "regsvr32.exe",
    "bitsadmin.exe",
];
const BACKUP_DELETION: [&str; 5] = [
    "delete shadows",
    "shadowcopy delete",
    "recoveryenabled no",
    "delete catalog",
    "resize shadowstorage",
];

/// Ab so vielen verschlüsselt aussehenden neuen/geänderten Dateien: „verschlüsselt Dateien“.
pub const ENCRYPTED_FILES: usize = 10;
/// Ab so vielen gelöschten Dateien: „löscht viele Dateien“.
pub const DELETED_FILES: usize = 20;

fn file_name(path: &str) -> String {
    path.rsplit(['\\', '/'])
        .next()
        .unwrap_or(path)
        .to_lowercase()
}

impl BehaviorReport {
    /// Kürzt alle Listen auf [`MAX_ITEMS`] (nach dem Einlesen fremder Berichte).
    pub fn truncate(&mut self) {
        self.processes.truncate(MAX_ITEMS);
        self.files.truncate(MAX_ITEMS);
        self.registry.truncate(MAX_ITEMS);
        self.network.truncate(MAX_ITEMS);
        self.screenshots.truncate(MAX_ITEMS);
        self.notes.truncate(64);
    }

    /// Leitet die Einschätzung ab.
    #[must_use]
    pub fn assess(&self) -> Assessment {
        let mut behaviors = Vec::new();
        let autostart_reg = self.registry.iter().any(|r| {
            r.change != Change::Deleted && {
                let key = r.key.to_lowercase();
                AUTOSTART_KEYS.iter().any(|k| key.contains(k))
            }
        });
        let autostart_file = self.files.iter().any(|f| {
            f.change != Change::Deleted && {
                let p = f.path.to_lowercase().replace('/', "\\");
                AUTOSTART_DIRS.iter().any(|d| p.contains(d))
            }
        });
        if autostart_reg || autostart_file {
            behaviors.push(Behavior::Autostart);
        }
        if !self.network.is_empty() {
            behaviors.push(Behavior::Network);
        }
        let encrypted = self
            .files
            .iter()
            .filter(|f| f.change != Change::Deleted && f.entropy.is_some_and(|e| e >= HIGH))
            .count();
        if encrypted >= ENCRYPTED_FILES {
            behaviors.push(Behavior::EncryptsFiles);
        }
        let commands: Vec<String> = self
            .processes
            .iter()
            .filter_map(|p| p.command_line.as_deref())
            .map(str::to_lowercase)
            .collect();
        if commands
            .iter()
            .any(|c| BACKUP_DELETION.iter().any(|b| c.contains(b)))
        {
            behaviors.push(Behavior::DeletesBackups);
        }
        let sample = self.sample.to_lowercase();
        if self.files.iter().any(|f| {
            f.change != Change::Deleted && {
                let name = file_name(&f.path);
                name != sample
                    && name
                        .rsplit_once('.')
                        .is_some_and(|(_, ext)| EXECUTABLE_EXT.contains(&ext))
            }
        }) {
            behaviors.push(Behavior::DropsExecutables);
        }
        if self
            .processes
            .iter()
            .any(|p| INTERPRETERS.contains(&file_name(&p.image).as_str()))
        {
            behaviors.push(Behavior::SpawnsInterpreters);
        }
        if self
            .files
            .iter()
            .filter(|f| f.change == Change::Deleted)
            .count()
            >= DELETED_FILES
        {
            behaviors.push(Behavior::DeletesFiles);
        }
        behaviors.sort();
        let strong = behaviors.iter().filter(|b| b.strong()).count();
        let risk = if strong >= 2 || behaviors.contains(&Behavior::EncryptsFiles) {
            RiskLevel::Dangerous
        } else if behaviors.is_empty() {
            RiskLevel::Clean
        } else {
            RiskLevel::Suspicious
        };
        let (summary_de, summary_en) = if behaviors.is_empty() {
            (
                "In der Beobachtungszeit hat dieses Programm nichts Auffälliges getan. Das ist kein Beweis, dass es harmlos ist – manche Schadsoftware wartet oder erkennt Sandboxen.".to_owned(),
                "During the observation time this program did nothing suspicious. That is no proof it is harmless – some malware waits or detects sandboxes.".to_owned(),
            )
        } else {
            (
                format!(
                    "Dieses Programm versucht, {}.",
                    join(
                        &behaviors.iter().map(|b| b.phrase_de()).collect::<Vec<_>>(),
                        "und"
                    )
                ),
                format!(
                    "This program tries to {}.",
                    join(
                        &behaviors.iter().map(|b| b.phrase_en()).collect::<Vec<_>>(),
                        "and"
                    )
                ),
            )
        };
        Assessment {
            risk,
            behaviors,
            summary_de,
            summary_en,
        }
    }
}

/// „a, b und c“.
fn join(parts: &[&str], and: &str) -> String {
    match parts {
        [] => String::new(),
        [one] => (*one).to_owned(),
        [init @ .., last] => format!("{} {and} {last}", init.join(", ")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report() -> BehaviorReport {
        BehaviorReport {
            stage: Stage::MiniSandbox,
            sample: "probe.exe".into(),
            sha256: None,
            seconds: 30,
            end: RunEnd::Exited { code: 0 },
            processes: vec![ProcessRecord {
                pid: 10,
                parent: 1,
                image: r"C:\AEGIS\Probe\probe.exe".into(),
                command_line: None,
            }],
            files: Vec::new(),
            registry: Vec::new(),
            network: Vec::new(),
            screenshots: Vec::new(),
            notes: Vec::new(),
        }
    }

    #[test]
    fn unauffaellig_ist_ehrlich_kein_freispruch() {
        let a = report().assess();
        assert_eq!(a.risk, RiskLevel::Clean);
        assert!(a.summary_de.contains("kein Beweis"));
    }

    #[test]
    fn autostart_und_netz_ist_gefaehrlich_mit_satz() {
        let mut r = report();
        r.registry.push(RegistryChange {
            key: r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run".into(),
            value: "Updater".into(),
            change: Change::Created,
            data: Some(r"C:\Users\x\AppData\u.exe".into()),
        });
        r.network.push(NetworkAttempt {
            remote: "203.0.113.5".into(),
            port: 443,
            blocked: true,
        });
        let a = r.assess();
        assert_eq!(a.risk, RiskLevel::Dangerous);
        assert_eq!(a.behaviors, [Behavior::Autostart, Behavior::Network]);
        assert_eq!(
            a.summary_de,
            "Dieses Programm versucht, sich im Autostart einzutragen und fremde Server zu kontaktieren."
        );
        assert!(
            a.summary_en
                .starts_with("This program tries to add itself to autostart and")
        );
    }

    #[test]
    fn einzelnes_verhalten_ist_verdaechtig() {
        let mut r = report();
        r.files.push(FileChange {
            path: r"C:\Users\x\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\a.lnk"
                .into(),
            change: Change::Created,
            size: 10,
            entropy: Some(3.0),
        });
        let a = r.assess();
        assert_eq!(a.behaviors, [Behavior::Autostart]);
        assert_eq!(a.risk, RiskLevel::Suspicious);
    }

    #[test]
    fn ransomware_muster() {
        let mut r = report();
        for i in 0..ENCRYPTED_FILES {
            r.files.push(FileChange {
                path: format!(r"C:\Users\x\Documents\{i}.docx.locked"),
                change: Change::Modified,
                size: 4096,
                entropy: Some(7.99),
            });
        }
        r.processes.push(ProcessRecord {
            pid: 11,
            parent: 10,
            image: r"C:\Windows\System32\vssadmin.exe".into(),
            command_line: Some("vssadmin Delete Shadows /all /quiet".into()),
        });
        for i in 0..DELETED_FILES {
            r.files.push(FileChange {
                path: format!(r"C:\Users\x\Pictures\{i}.jpg"),
                change: Change::Deleted,
                size: 0,
                entropy: None,
            });
        }
        let a = r.assess();
        assert_eq!(a.risk, RiskLevel::Dangerous);
        assert!(a.behaviors.contains(&Behavior::EncryptsFiles));
        assert!(a.behaviors.contains(&Behavior::DeletesBackups));
        assert!(a.behaviors.contains(&Behavior::DeletesFiles));
    }

    #[test]
    fn abgelegte_programme_und_interpreter() {
        let mut r = report();
        r.files.push(FileChange {
            path: r"C:\Users\x\AppData\Local\Temp\stage2.ps1".into(),
            change: Change::Created,
            size: 100,
            entropy: Some(4.0),
        });
        r.processes.push(ProcessRecord {
            pid: 12,
            parent: 10,
            image: r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe".into(),
            command_line: None,
        });
        let a = r.assess();
        assert_eq!(
            a.behaviors,
            [Behavior::DropsExecutables, Behavior::SpawnsInterpreters]
        );
        assert_eq!(a.risk, RiskLevel::Suspicious);
        assert!(a.summary_de.contains(", ") || a.summary_de.contains(" und "));
    }

    #[test]
    fn json_rundweg_und_grenzen() {
        let mut r = report();
        r.notes = vec!["x".into(); 100];
        r.truncate();
        assert_eq!(r.notes.len(), 64);
        let json = serde_json::to_string(&r).unwrap();
        let back: BehaviorReport = serde_json::from_str(&json).unwrap();
        assert_eq!(back, r);
        assert_eq!(join(&["a", "b", "c"], "und"), "a, b und c");
    }
}
