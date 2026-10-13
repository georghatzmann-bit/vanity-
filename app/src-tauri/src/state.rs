//! Gemeinsamer App-Zustand und Ablageorte.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::db::DbHandle;
use crate::models::{NativeSettings, TrayRecent};
use crate::system::SystemMonitor;
use crate::tracker::Tracker;

/// Alle Ablageorte der App.
#[derive(Debug, Clone)]
pub struct Paths {
    /// `%APPDATA%\com.pulsar.booster`
    pub data_dir: PathBuf,
    /// `%LOCALAPPDATA%\com.pulsar.booster\cache`
    pub cache_dir: PathBuf,
}

impl Paths {
    pub fn new(data_dir: PathBuf, local_dir: PathBuf) -> Self {
        Self {
            data_dir,
            cache_dir: local_dir.join("cache"),
        }
    }

    pub fn profile_dir(&self, id: &str) -> PathBuf {
        self.data_dir
            .join("profiles")
            .join(crate::util::safe_segment(id))
    }
    pub fn db_path(&self, id: &str) -> PathBuf {
        self.profile_dir(id).join("pulsar.db")
    }
    pub fn backups_dir(&self, id: &str) -> PathBuf {
        self.profile_dir(id).join("backups")
    }
    pub fn images_dir(&self) -> PathBuf {
        self.cache_dir.join("images")
    }
    pub fn game_images_dir(&self, game_id: &str) -> PathBuf {
        self.images_dir().join(crate::util::safe_segment(game_id))
    }
    pub fn thumbs_dir(&self) -> PathBuf {
        self.cache_dir.join("thumbs")
    }
}

/// Einstellungen und Daten für Tray, Overlay und Fenster.
#[derive(Debug, Clone, Default)]
pub struct NativeState {
    pub settings: NativeSettings,
    /// Aktuell registriertes Overlay-Kürzel (normalisierter Text, leer = keins)
    pub registered_shortcut: Option<String>,
    pub recent: Vec<TrayRecent>,
    /// Wird beim echten Beenden gesetzt, damit „Schließen → Tray“ nicht greift.
    pub quitting: bool,
}

/// Der gemeinsame Zustand (als `Arc<Core>` in Tauri registriert).
pub struct Core {
    pub paths: Paths,
    pub db: DbHandle,
    pub tracker: Tracker,
    pub sys: Mutex<SystemMonitor>,
    pub native: Mutex<NativeState>,
    pub http: reqwest::Client,
    pub net: crate::net::NetState,
    pub opt: crate::opt::OptState,
    pub started_minimized: bool,
}

pub type Shared = Arc<Core>;

pub const DEFAULT_PROFILE: &str = "default";

impl Core {
    pub fn new(paths: Paths, started_minimized: bool) -> Self {
        Self {
            paths,
            db: DbHandle::new(),
            tracker: Tracker::new(),
            sys: Mutex::new(SystemMonitor::new()),
            native: Mutex::new(NativeState::default()),
            http: build_http_client(),
            net: crate::net::NetState::default(),
            opt: crate::opt::OptState::default(),
            started_minimized,
        }
    }

    /// Pulsar hat nur ein Profil; der feste Name hält die Ablage einfach.
    pub fn active_profile_id(&self) -> String {
        DEFAULT_PROFILE.into()
    }
}

/// HTTP-Client mit Zeitlimit und eigenem User-Agent.
pub fn build_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(10))
        .user_agent(concat!("Pulsar/", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Hilfsfunktion für Tests: Pfade in einem temporären Ordner.
#[allow(dead_code)]
pub fn test_paths(root: &Path) -> Paths {
    Paths::new(root.join("data"), root.join("local"))
}
