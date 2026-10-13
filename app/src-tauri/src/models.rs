//! Rust-Spiegel der TypeScript-Typen aus `app/src/lib/types.ts`.
//! Alle Strukturen werden in camelCase serialisiert; optionale Felder entfallen, wenn leer.

use serde::{Deserialize, Deserializer, Serialize};

// ---------------------------------------------------------------------------------------------
// Hilfen für tolerantes Einlesen (z. B. Steam-AppID als Zahl oder Text)
// ---------------------------------------------------------------------------------------------

/// Akzeptiert einen Text oder eine Zahl und liefert einen Text (leer ⇒ `None`).
pub fn de_opt_string_or_number<'de, D>(d: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let v = Option::<serde_json::Value>::deserialize(d)?;
    Ok(match v {
        Some(serde_json::Value::String(s)) => {
            let t = s.trim().to_string();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        }
        Some(serde_json::Value::Number(n)) => Some(n.to_string()),
        _ => None,
    })
}

// ---------------------------------------------------------------------------------------------
// Grundtypen
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum GameKind {
    #[default]
    Game,
    App,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum GameSource {
    Steam,
    Epic,
    Gog,
    Startmenu,
    Folder,
    Manual,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LaunchType {
    Exe,
    Url,
    Shell,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum ImageKind {
    Cover,
    Hero,
    Logo,
    Icon,
}

impl ImageKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ImageKind::Cover => "cover",
            ImageKind::Hero => "hero",
            ImageKind::Logo => "logo",
            ImageKind::Icon => "icon",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchConfig {
    #[serde(rename = "type")]
    pub kind: LaunchType,
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub as_admin: Option<bool>,
}

impl LaunchConfig {
    pub fn exe(target: impl Into<String>, args: Option<String>, work_dir: Option<String>) -> Self {
        Self {
            kind: LaunchType::Exe,
            target: target.into(),
            args: args.filter(|a| !a.trim().is_empty()),
            work_dir: work_dir.filter(|w| !w.trim().is_empty()),
            as_admin: None,
        }
    }
    pub fn url(target: impl Into<String>) -> Self {
        Self {
            kind: LaunchType::Url,
            target: target.into(),
            args: None,
            work_dir: None,
            as_admin: None,
        }
    }
    pub fn shell(target: impl Into<String>) -> Self {
        Self {
            kind: LaunchType::Shell,
            target: target.into(),
            args: None,
            work_dir: None,
            as_admin: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GameImages {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hero: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

impl GameImages {
    pub fn set(&mut self, kind: ImageKind, path: String) {
        match kind {
            ImageKind::Cover => self.cover = Some(path),
            ImageKind::Hero => self.hero = Some(path),
            ImageKind::Logo => self.logo = Some(path),
            ImageKind::Icon => self.icon = Some(path),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GamePalette {
    pub primary: String,
    pub secondary: String,
    pub dark: String,
}

// ---------------------------------------------------------------------------------------------
// Spielzeit
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlayStats {
    pub game_id: String,
    pub total_seconds: i64,
    pub sessions: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_played_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_session_seconds: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_played_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: i64,
    pub game_id: String,
    pub start: i64,
    pub end: i64,
    pub seconds: i64,
}

// ---------------------------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
    pub cache_dir: String,
    pub platform: String,
    pub started_minimized: bool,
    /// Läuft Pulsar mit Adminrechten?
    pub is_admin: bool,
}

// ---------------------------------------------------------------------------------------------
// Scannen
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScannedEntry {
    pub name: String,
    pub kind: GameKind,
    pub source: GameSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    pub launch: LaunchConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exe_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ScanOptions {
    pub steam: bool,
    pub epic: bool,
    pub gog: bool,
    pub start_menu: bool,
    pub folders: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub entries: Vec<ScannedEntry>,
    pub messages: Vec<String>,
}

// ---------------------------------------------------------------------------------------------
// Starten & Erkennung
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackInfo {
    pub game_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exe_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_names: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunningGame {
    pub game_id: String,
    pub started_at: i64,
    pub pids: Vec<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameStartedEvent {
    pub game_id: String,
    pub started_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameStoppedEvent {
    pub game_id: String,
    pub session: Session,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub done: u64,
    pub total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

// ---------------------------------------------------------------------------------------------
// System & Widgets
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    pub cpu: f32,
    pub ram_used: u64,
    pub ram_total: u64,
    /// Immer vorhanden – `null`, wenn nicht messbar.
    pub gpu: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime_seconds: Option<u64>,
}

// ---------------------------------------------------------------------------------------------
// Bilder
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFetchRequest {
    pub game_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, deserialize_with = "de_opt_string_or_number")]
    pub steam_app_id: Option<String>,
    #[serde(default)]
    pub kinds: Vec<ImageKind>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub force: Option<bool>,
    /// Programmdatei – für das echte Icon
    #[serde(default)]
    pub exe_path: Option<String>,
    /// Installationsordner – dort wird die Haupt-.exe für das Icon gesucht
    #[serde(default)]
    pub install_dir: Option<String>,
    /// Ohne Steam-ID per Name im Steam-Shop suchen (nur für Spiele sinnvoll)
    #[serde(default)]
    pub lookup_by_name: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFetchResult {
    pub images: GameImages,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub palette: Option<GamePalette>,
    /// "steam" | "steamgriddb" | "exe" | "none"
    pub source: String,
    pub messages: Vec<String>,
    /// Steam-ID, die per Namenssuche gefunden wurde
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steam_app_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedImage {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub palette: Option<GamePalette>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SgdbGame {
    pub id: u64,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SgdbImage {
    pub url: String,
    pub thumb: String,
    pub width: u32,
    pub height: u32,
}

// ---------------------------------------------------------------------------------------------
// Screenshots, Spielstände, Backups
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryBackup {
    pub file: String,
    pub path: String,
    pub created_at: i64,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup_sha256: Option<String>,
}

// ---------------------------------------------------------------------------------------------
// Native Integration
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct NativeSettings {
    pub close_to_tray: bool,
    pub overlay_shortcut: String,
    pub minimize_on_launch: bool,
    pub language: String,
}

impl Default for NativeSettings {
    fn default() -> Self {
        Self {
            close_to_tray: true,
            overlay_shortcut: "Alt+Shift+N".into(),
            minimize_on_launch: false,
            language: "de".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrayRecent {
    pub id: String,
    pub name: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_config_camel_case() {
        let json = r#"{"type":"exe","target":"C:\\g.exe","workDir":"C:\\","asAdmin":true}"#;
        let l: LaunchConfig = serde_json::from_str(json).unwrap();
        assert_eq!(l.kind, LaunchType::Exe);
        assert_eq!(l.work_dir.as_deref(), Some("C:\\"));
        assert_eq!(l.as_admin, Some(true));
        let back = serde_json::to_value(&l).unwrap();
        assert_eq!(back["type"], "exe");
        assert!(back.get("args").is_none());
    }

    #[test]
    fn steam_app_id_accepts_number() {
        let r: ImageFetchRequest =
            serde_json::from_str(r#"{"gameId":"g","name":"x","steamAppId":570,"kinds":["cover"]}"#)
                .unwrap();
        assert_eq!(r.steam_app_id.as_deref(), Some("570"));
    }

    #[test]
    fn system_stats_gpu_null() {
        let s = SystemStats {
            cpu: 1.0,
            ram_used: 1,
            ram_total: 2,
            gpu: None,
            cpu_name: None,
            gpu_name: None,
            uptime_seconds: None,
        };
        let v = serde_json::to_value(&s).unwrap();
        assert!(v.get("gpu").unwrap().is_null());
        assert_eq!(v["ramUsed"], 1);
    }
}
