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
    /// 12 Datei-Shredder.
    Shredder,
    /// 15 Batch-Umbenenner.
    Rename,
    /// 16 Explorer-Tweaks.
    ExplorerTweaks,
    /// 19 Datenschutz-Einstellungen.
    Privacy,
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
    /// Registrierungswert unter `HKCU` setzen (nur Schalter aus [`crate::tweaks::TWEAKS`]).
    Registry {
        /// Schlüssel unter `HKCU`.
        key: String,
        /// Wertname.
        name: String,
        /// Neuer Wert.
        value: crate::tweaks::Value,
    },
    /// Datei überschreiben und löschen (endgültig – nur mit zweiter Bestätigung).
    Shred {
        /// Datei.
        path: PathBuf,
        /// Größe bei der Vorschau.
        size: u64,
        /// Änderungszeit bei der Vorschau.
        modified: i64,
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
            Self::Registry { key, name, value } => format!(
                "HKCU\\{key}\\{} = {}",
                if name.is_empty() { "(Standard)" } else { name },
                match value {
                    crate::tweaks::Value::Dword(v) => v.to_string(),
                    crate::tweaks::Value::Text(t) => format!("„{t}“"),
                    crate::tweaks::Value::Absent => "(entfernt)".to_owned(),
                }
            ),
            Self::Shred { path, .. } => format!("Endgültig löschen: {}", path.display()),
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

    /// Enthält die Vorschau endgültiges Löschen (zweite Bestätigung nötig)?
    #[must_use]
    pub fn needs_final(&self) -> bool {
        self.ops.iter().any(|o| matches!(o, Op::Shred { .. }))
    }

    /// Prüfsumme über Kennung, Werkzeug, Regel und alle Schritte. Lässt sich die Vorschau
    /// nicht darstellen (z. B. ein Name ohne gültigen Text), ist sie leer – und keine
    /// Freigabe passt (schließt sicher).
    #[must_use]
    pub fn digest(&self) -> String {
        let Ok(body) = serde_json::to_vec(self) else {
            return String::new();
        };
        Sha256::digest(&body)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// Passt `digest` zu dieser Vorschau (nie bei leerer Prüfsumme)?
    fn digest_ok(&self, digest: &str) -> bool {
        let own = self.digest();
        !own.is_empty() && own == digest
    }
}

/// Freigabe genau einer Vorschau (als Wert an die Ausführung übergeben).
#[derive(Debug)]
pub struct Approved<'a> {
    pub(crate) plan: &'a Plan,
    pub(crate) skip: Vec<usize>,
    /// Zweite Bestätigung für endgültiges Löschen liegt vor.
    pub(crate) final_ok: bool,
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
    /// Endgültiges Löschen braucht die zweite, getrennte Bestätigung.
    NeedsFinal,
}

/// Wie lange eine Vorschau gilt (Sekunden).
pub const PLAN_TTL: i64 = 30 * 60;

/// Zufällige Kennung (32 Hex-Zeichen), z. B. für die zweite Bestätigung.
#[must_use]
pub fn token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

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
        if !plan.digest_ok(digest) {
            return Err(Refused::Digest);
        }
        if now - plan.created > PLAN_TTL {
            return Err(Refused::Expired);
        }
        if plan.needs_final() {
            return Err(Refused::NeedsFinal);
        }
        Ok(Self {
            plan,
            skip,
            final_ok: false,
        })
    }

    /// Wie [`Approved::by_user`], dazu die zweite, getrennte Bestätigung für endgültiges
    /// Löschen: `answer` muss die Kennung sein, die die App nur im zweiten Dialog zeigt.
    ///
    /// # Errors
    /// Prüfsumme falsch, abgelaufen oder zweite Bestätigung fehlt/falsch.
    pub fn by_user_final(
        plan: &'a Plan,
        digest: &str,
        skip: Vec<usize>,
        now: i64,
        expected: &str,
        answer: &str,
    ) -> Result<Self, Refused> {
        if !plan.digest_ok(digest) {
            return Err(Refused::Digest);
        }
        if now - plan.created > PLAN_TTL {
            return Err(Refused::Expired);
        }
        if expected.len() < 16 || expected != answer {
            return Err(Refused::NeedsFinal);
        }
        Ok(Self {
            plan,
            skip,
            final_ok: true,
        })
    }

    /// Eine vom Nutzer angelegte, eingeschaltete Regel mit „im Hintergrund“ trägt die
    /// Vorschau (`rule` frisch geladen, unmittelbar vor dem Ausführen).
    ///
    /// # Errors
    /// Regel aus, nicht im Hintergrund, fremd oder Vorschau nicht darstellbar.
    pub fn by_rule(plan: &'a Plan, rule: &crate::rules::Rule) -> Result<Self, Refused> {
        if !rule.enabled
            || !rule.watch
            || plan.rule.as_deref() != Some(rule.id.as_str())
            || plan.digest().is_empty()
        {
            return Err(Refused::Rule);
        }
        if plan.needs_final() {
            return Err(Refused::NeedsFinal);
        }
        Ok(Self {
            plan,
            skip: Vec::new(),
            final_ok: false,
        })
    }
}
