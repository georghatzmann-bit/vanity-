//! Vorschau eines Werkzeugs: eine feste Liste von Schritten mit Prüfsumme. Ausgeführt wird nur
//! genau diese Vorschau – nach „Ausführen“ des Nutzers ([`Approved::by_user`]) oder durch eine
//! vom Nutzer angelegte und aktivierte Regel ([`Approved::by_rule`]).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Werkzeug, das die Vorschau erstellt hat.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tool {
    /// 1 Downloads-Sortierer.
    SortDownloads,
    /// 2 Quellen-Ordner.
    SourceFolders,
    /// 3 Regeln (Regel-Editor, Hintergrund-Überwachung).
    Rules,
    /// 4 Desktop-Symbole.
    DesktopLayout,
    /// 5 Hintergrundbild.
    Wallpaper,
    /// 6 Duplikate.
    Duplicates,
    /// 8 Große & alte Dateien.
    LargeOld,
    /// 9 Leere Ordner.
    EmptyFolders,
    /// 10 Cleaner.
    Cleaner,
    /// 11 Autostart.
    Autostart,
}

/// Ein Schritt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    /// Datei verschieben (nie überschreiben; Ziel bekommt bei Bedarf „ (2)“).
    Move {
        /// Quelle.
        from: PathBuf,
        /// Ziel.
        to: PathBuf,
        /// Größe bei der Vorschau.
        size: u64,
        /// Änderungszeit bei der Vorschau.
        modified: i64,
    },
    /// Datei in den Papierkorb.
    Recycle {
        /// Datei.
        path: PathBuf,
        /// Größe bei der Vorschau.
        size: u64,
        /// Änderungszeit bei der Vorschau.
        modified: i64,
    },
    /// Leeren Ordner entfernen.
    RemoveEmptyDir {
        /// Ordner.
        path: PathBuf,
    },
    /// Hintergrundbild setzen.
    SetWallpaper {
        /// Neues Bild.
        path: PathBuf,
    },
    /// Autostart-Eintrag aus- oder einschalten (wie im Task-Manager, nichts wird gelöscht).
    Autostart {
        /// Eintrag.
        entry: crate::autostart::EntryRef,
        /// Einschalten?
        enable: bool,
    },
    /// Desktop-Symbole an gespeicherte Stellen setzen.
    DesktopLayout {
        /// Gespeichertes Layout.
        layout: crate::desktop::Layout,
    },
}

impl Op {
    /// Kurzer Text für Vorschau und Protokoll.
    #[must_use]
    pub fn label(&self) -> String {
        match self {
            Self::Move { from, to, .. } => format!("{} → {}", from.display(), to.display()),
            Self::Recycle { path, .. } => format!("Papierkorb: {}", path.display()),
            Self::RemoveEmptyDir { path } => format!("Leerer Ordner: {}", path.display()),
            Self::SetWallpaper { path } => format!("Hintergrundbild: {}", path.display()),
            Self::Autostart { entry, enable } => format!(
                "Autostart {}: {}",
                if *enable { "an" } else { "aus" },
                entry.name
            ),
            Self::DesktopLayout { layout } => format!(
                "Desktop-Layout „{}“ ({} Symbole)",
                layout.name,
                layout.icons.len()
            ),
        }
    }
}

/// Vorschau.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    /// Kennung.
    pub id: String,
    /// Werkzeug.
    pub tool: Tool,
    /// Regel, aus der die Vorschau stammt (Hintergrund-Überwachung).
    pub rule: Option<String>,
    /// Erstellt (Unix-Sekunden).
    pub created: i64,
    /// Schritte.
    pub ops: Vec<Op>,
}

impl Plan {
    /// Neue Vorschau.
    #[must_use]
    pub fn new(tool: Tool, ops: Vec<Op>, created: i64) -> Self {
        Self {
            id: uuid::Uuid::new_v4().hyphenated().to_string(),
            tool,
            rule: None,
            created,
            ops,
        }
    }

    /// Prüfsumme über Kennung, Werkzeug, Regel und alle Schritte.
    #[must_use]
    pub fn digest(&self) -> String {
        let body = serde_json::to_vec(self).unwrap_or_default();
        Sha256::digest(&body)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }
}

/// Freigabe genau einer Vorschau (als Wert an die Ausführung übergeben).
#[derive(Debug)]
pub struct Approved<'a> {
    pub(crate) plan: &'a Plan,
    pub(crate) skip: Vec<usize>,
}

/// Freigabe abgelehnt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    /// Prüfsumme passt nicht (andere oder veränderte Vorschau).
    Digest,
    /// Regel aus oder passt nicht zur Vorschau.
    Rule,
    /// Vorschau zu alt.
    Expired,
}

/// Wie lange eine Vorschau gilt (Sekunden).
pub const PLAN_TTL: i64 = 30 * 60;

impl<'a> Approved<'a> {
    /// Der Nutzer hat „Ausführen“ für genau diese Vorschau gewählt (`digest` aus der Vorschau,
    /// `skip`: abgewählte Schritte).
    ///
    /// # Errors
    /// Prüfsumme falsch oder Vorschau abgelaufen.
    pub fn by_user(
        plan: &'a Plan,
        digest: &str,
        skip: Vec<usize>,
        now: i64,
    ) -> Result<Self, Refused> {
        if plan.digest() != digest {
            return Err(Refused::Digest);
        }
        if now - plan.created > PLAN_TTL {
            return Err(Refused::Expired);
        }
        Ok(Self { plan, skip })
    }

    /// Eine vom Nutzer angelegte und aktivierte Regel trägt die Vorschau.
    ///
    /// # Errors
    /// Regel aus oder fremd.
    pub fn by_rule(plan: &'a Plan, rule: &crate::rules::Rule) -> Result<Self, Refused> {
        if !rule.enabled || plan.rule.as_deref() != Some(rule.id.as_str()) {
            return Err(Refused::Rule);
        }
        Ok(Self {
            plan,
            skip: Vec::new(),
        })
    }
}
