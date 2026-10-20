//! Regeln des Nutzers (Werkzeuge 2 und 3): „Dateien, die … erfüllen, nach Unterordner … in
//! diesem Ordner verschieben“. Eine Regel handelt nur, wenn der Nutzer sie angelegt und
//! eingeschaltet hat; die Hintergrund-Überwachung zusätzlich nur, wenn `watch` an ist.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::category::{Category, category_of, extension, is_partial};
use crate::plan::{Op, Plan, Tool};
use crate::walk::{FileInfo, Limits, files};

/// Bedingung (alle gesetzten Teile müssen passen; eine leere Bedingung passt auf nichts).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Condition {
    /// Kategorien (eine davon).
    pub categories: Vec<Category>,
    /// Endungen ohne Punkt (eine davon).
    pub extensions: Vec<String>,
    /// Name enthält (Groß/klein egal).
    pub name_contains: String,
    /// Herkunft (Mark-of-the-Web) endet auf diesen Host, z. B. `claude.ai`.
    pub source_host: String,
}

impl Condition {
    fn empty(&self) -> bool {
        self.categories.is_empty()
            && self.extensions.is_empty()
            && self.name_contains.is_empty()
            && self.source_host.is_empty()
    }

    /// Passt die Datei (`origin`: Host aus `Zone.Identifier`)?
    #[must_use]
    pub fn matches(&self, path: &Path, origin: Option<&str>) -> bool {
        if self.empty() {
            return false;
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        (self.categories.is_empty() || self.categories.contains(&category_of(path)))
            && (self.extensions.is_empty() || self.extensions.contains(&extension(path)))
            && (self.name_contains.is_empty() || name.contains(&self.name_contains.to_lowercase()))
            && (self.source_host.is_empty()
                || origin.is_some_and(|o| host_matches(o, &self.source_host)))
    }
}

/// `o` ist `host` oder eine Unteradresse davon.
#[must_use]
pub fn host_matches(o: &str, host: &str) -> bool {
    let (o, host) = (o.to_ascii_lowercase(), host.to_ascii_lowercase());
    o == host || o.ends_with(&format!(".{host}"))
}

/// Eine Regel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    /// Kennung.
    pub id: String,
    /// Name.
    pub name: String,
    /// Eingeschaltet?
    pub enabled: bool,
    /// Im Hintergrund auf neue Dateien anwenden?
    pub watch: bool,
    /// Ordner, in dem die Regel gilt (nur Dateien direkt darin).
    pub folder: PathBuf,
    /// Bedingung.
    pub condition: Condition,
    /// Name des Unterordners im Regel-Ordner.
    pub target: String,
    /// Seit wann „im Hintergrund“ gilt (Unix-Sekunden; setzt die App beim Speichern). Die
    /// Überwachung fasst nur Dateien an, die danach angekommen sind – den Bestand nie ohne
    /// Vorschau.
    #[serde(default)]
    pub watch_since: Option<i64>,
}

/// Höchstzahl Regeln.
pub const MAX_RULES: usize = 100;

/// Gültiger Ordnername (ein Teil, keine Sonder- oder reservierten Namen)?
#[must_use]
pub fn valid_folder_name(name: &str) -> bool {
    // Reservierte Gerätenamen, auch mit Endung (`CON.txt`) und hochgestellten Ziffern.
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_lowercase();
    let device = ["con", "prn", "aux", "nul", "conin$", "conout$", "clock$"]
        .contains(&stem.as_str())
        || ["com", "lpt"].iter().any(|p| {
            stem.strip_prefix(p).is_some_and(|n| {
                ["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"].contains(&n)
            })
        });
    !device
        && !name.trim().is_empty()
        && name.len() <= 120
        && name == name.trim()
        && !name.ends_with('.')
        && !name.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|'])
        && !name.chars().any(char::is_control)
        && name != "."
        && name != ".."
}

impl Rule {
    /// Prüft und bereinigt eine Regel aus der Oberfläche.
    ///
    /// # Errors
    /// Ungültig (Text für die Oberfläche).
    pub fn validated(mut self) -> Result<Self, String> {
        self.name = self
            .name
            .trim()
            .chars()
            .filter(|c| !c.is_control())
            .take(80)
            .collect();
        if self.name.is_empty() {
            return Err("Bitte der Regel einen Namen geben.".into());
        }
        if !crate::guard::allowed(&self.folder) {
            return Err("Diesen Ordner fasst AEGIS nicht an (Systemort).".into());
        }
        if !valid_folder_name(&self.target) {
            return Err("Der Zielordner muss ein einfacher Ordnername sein.".into());
        }
        let c = &mut self.condition;
        c.extensions = c
            .extensions
            .iter()
            .map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase())
            .filter(|e| {
                !e.is_empty() && e.len() <= 16 && e.chars().all(|ch| ch.is_ascii_alphanumeric())
            })
            .take(32)
            .collect();
        c.name_contains = c.name_contains.trim().chars().take(80).collect();
        c.source_host = c.source_host.trim().trim_matches('.').to_ascii_lowercase();
        if !c.source_host.is_empty()
            && !c
                .source_host
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '-')
        {
            return Err("Die Herkunft muss ein Host sein, z. B. claude.ai.".into());
        }
        if c.empty() {
            return Err("Bitte mindestens eine Bedingung angeben.".into());
        }
        if self.id.is_empty() {
            self.id = uuid::Uuid::new_v4().hyphenated().to_string();
        }
        Ok(self)
    }
}

/// Herkunft einer Datei (Host aus `Zone.Identifier`, nur Windows).
#[must_use]
pub fn origin_host(path: &Path) -> Option<String> {
    #[cfg(windows)]
    {
        let mut stream = path.as_os_str().to_owned();
        stream.push(":Zone.Identifier");
        // Höchstens 64 KiB lesen (ein Datenstrom kann beliebig groß sein).
        let mut text = Vec::new();
        std::io::Read::read_to_end(
            &mut std::io::Read::take(std::fs::File::open(stream).ok()?, 64 * 1024 + 1),
            &mut text,
        )
        .ok()?;
        if text.len() > 64 * 1024 {
            return None;
        }
        zone_host(&String::from_utf8_lossy(&text))
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        None
    }
}

/// Host aus dem Inhalt von `Zone.Identifier` (`HostUrl`, sonst `ReferrerUrl`).
#[must_use]
pub fn zone_host(text: &str) -> Option<String> {
    let value = |key: &str| {
        text.lines()
            .find_map(|l| l.trim().strip_prefix(key).map(str::trim).map(str::to_owned))
    };
    let url = value("HostUrl=").or_else(|| value("ReferrerUrl="))?;
    let rest = url.split_once("://")?.1;
    let host = rest
        .split(['/', '?', '#', ':'])
        .next()?
        .rsplit('@')
        .next()?;
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    (!host.is_empty()).then_some(host)
}

/// Dateien direkt im Ordner, die ein Werkzeug anfassen darf (keine halben Downloads, nicht
/// jünger als `settle` Sekunden).
#[must_use]
pub fn movable_files(folder: &Path, now: i64, settle: i64) -> Vec<FileInfo> {
    files(
        folder,
        Limits {
            depth: 0,
            files: 50_000,
        },
    )
    .into_iter()
    .filter(|f| !is_partial(&f.path) && now - f.modified >= settle)
    .collect()
}

/// Vorschau für Regeln eines Ordners (erste passende eingeschaltete Regel gewinnt).
#[must_use]
pub fn plan(rules: &[Rule], folder: &Path, now: i64, settle: i64) -> Plan {
    plan_since(rules, folder, now, settle, None)
}

fn plan_since(rules: &[Rule], folder: &Path, now: i64, settle: i64, since: Option<i64>) -> Plan {
    let active: Vec<&Rule> = rules
        .iter()
        .filter(|r| r.enabled && r.folder == folder)
        .collect();
    let mut ops = Vec::new();
    if crate::guard::allowed(folder) {
        for f in movable_files(folder, now, settle)
            .into_iter()
            .filter(|f| since.is_none_or(|s| f.created.max(f.modified) >= s))
        {
            let needs_origin = active.iter().any(|r| !r.condition.source_host.is_empty());
            let origin = if needs_origin {
                origin_host(&f.path)
            } else {
                None
            };
            if let Some(rule) = active
                .iter()
                .find(|r| r.condition.matches(&f.path, origin.as_deref()))
                && let Some(name) = f.path.file_name()
            {
                ops.push(Op::Move {
                    to: folder.join(&rule.target).join(name),
                    from: f.path.clone(),
                    size: f.size,
                    modified: f.modified,
                });
            }
        }
    }
    Plan::new(Tool::Rules, ops, now)
}

/// Vorschau für genau eine Regel (trägt die Regel-Kennung, damit nur diese Regel sie
/// freigeben kann). Mit `watch_since` (Hintergrund-Überwachung) nur Dateien, die seitdem
/// angekommen sind.
#[must_use]
pub fn plan_for_rule(rule: &Rule, now: i64, settle: i64) -> Plan {
    let since = if rule.watch {
        Some(rule.watch_since.unwrap_or(now))
    } else {
        None
    };
    let mut p = plan_since(std::slice::from_ref(rule), &rule.folder, now, settle, since);
    p.rule = Some(rule.id.clone());
    p
}

/// Vorschau einer Regel für „jetzt anwenden“ von Hand: der ganze Bestand im Ordner.
#[must_use]
pub fn plan_now(rule: &Rule, now: i64, settle: i64) -> Plan {
    let mut once = rule.clone();
    once.enabled = true;
    plan(std::slice::from_ref(&once), &once.folder, now, settle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bedingungen_und_herkunft() {
        let c = Condition {
            source_host: "claude.ai".into(),
            ..Condition::default()
        };
        assert!(c.matches(Path::new("/d/tool.zip"), Some("files.claude.ai")));
        assert!(!c.matches(Path::new("/d/tool.zip"), Some("notclaude.ai")));
        assert!(!c.matches(Path::new("/d/tool.zip"), None));
        assert!(!Condition::default().matches(Path::new("/d/x"), None));
        let c = Condition {
            categories: vec![Category::Images],
            name_contains: "Urlaub".into(),
            ..Condition::default()
        };
        assert!(c.matches(Path::new("/d/urlaub-2026.jpg"), None));
        assert!(!c.matches(Path::new("/d/urlaub.pdf"), None));
        assert_eq!(
            zone_host(
                "[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://claude.ai/chat\r\nHostUrl=https://Files.Claude.ai:443/x?y\r\n"
            ),
            Some("files.claude.ai".into())
        );
        assert_eq!(zone_host("[ZoneTransfer]\nZoneId=3\n"), None);
    }

    #[test]
    fn regeln_werden_geprueft() {
        let rule = Rule {
            id: String::new(),
            name: " Claude ".into(),
            enabled: true,
            watch: false,
            folder: PathBuf::from("/home/anna/Downloads"),
            condition: Condition {
                extensions: vec![".ZIP".into(), "x/y".into()],
                ..Condition::default()
            },
            target: "Claude-Tools".into(),
            watch_since: None,
        };
        let ok = rule.clone().validated().unwrap();
        assert_eq!(ok.name, "Claude");
        assert_eq!(ok.condition.extensions, vec!["zip"]);
        assert!(!ok.id.is_empty());
        for bad in [
            "..", "a/b", "CON", "x:", "", "nul.zip", "COM9", "LPT¹", "conout$",
        ] {
            let mut r = rule.clone();
            r.target = bad.into();
            assert!(r.validated().is_err(), "{bad}");
        }
        let mut r = rule.clone();
        r.condition = Condition::default();
        assert!(r.validated().is_err());
        let mut r = rule;
        r.folder = PathBuf::from("/");
        assert!(r.validated().is_err());
    }
}
