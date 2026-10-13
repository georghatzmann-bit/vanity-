//! Eingebettete Projekt-Konfiguration (`pulsar.config.json` in der Projektwurzel) und feste Namen.

use serde::Deserialize;
use std::sync::OnceLock;

/// Wird beim Bauen eingebettet. Pfad relativ zu dieser Datei: installer/src-tauri/src -> Projektwurzel.
const EMBEDDED_CONFIG: &str = include_str!("../../../pulsar.config.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PulsarConfig {
    pub app_name: String,
    pub publisher: String,
    pub version: String,
    pub app_exe_name: String,
    pub setup_exe_name: String,
    pub manifest_url: String,
    pub website_url: String,
}

impl Default for PulsarConfig {
    fn default() -> Self {
        Self {
            app_name: "Pulsar".into(),
            publisher: "Pulsar".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            app_exe_name: "Pulsar.exe".into(),
            setup_exe_name: "Pulsar-Setup.exe".into(),
            manifest_url: String::new(),
            website_url: String::new(),
        }
    }
}

/// Die eingebettete Konfiguration. Fällt bei einem (eigentlich unmöglichen) Parse-Fehler auf
/// Standardwerte zurück, damit das Setup nie in Panik gerät.
pub fn config() -> &'static PulsarConfig {
    static CONFIG: OnceLock<PulsarConfig> = OnceLock::new();
    CONFIG.get_or_init(|| parse_config(EMBEDDED_CONFIG).unwrap_or_default())
}

pub fn parse_config(text: &str) -> Option<PulsarConfig> {
    let mut cfg: PulsarConfig = serde_json::from_str(text).ok()?;
    let defaults = PulsarConfig::default();
    if cfg.app_name.trim().is_empty() {
        cfg.app_name = defaults.app_name;
    }
    if cfg.app_exe_name.trim().is_empty() {
        cfg.app_exe_name = defaults.app_exe_name;
    }
    if cfg.version.trim().is_empty() {
        cfg.version = defaults.version;
    }
    if cfg.publisher.trim().is_empty() {
        cfg.publisher = defaults.publisher;
    }
    Some(cfg)
}

/// Bezeichner der Haupt-App (Tauri `identifier`) – deren Datenordner heißen so.
pub const APP_DATA_ID: &str = "com.pulsar.booster";
/// Bezeichner der Setup-App (WebView2-Daten unter `%LOCALAPPDATA%\com.pulsar.setup`).
pub const SETUP_DATA_ID: &str = "com.pulsar.setup";
/// Name des Schlüssels unter `...\CurrentVersion\Uninstall`.
pub const UNINSTALL_KEY_NAME: &str = "Pulsar";
/// Wertname unter `HKCU\...\CurrentVersion\Run`.
pub const RUN_VALUE_NAME: &str = "Pulsar";
/// Hier merkt sich das Setup den Installationsort.
pub const STATE_KEY: &str = r"Software\Pulsar\Booster";
pub const STATE_PARENT_KEY: &str = r"Software\Pulsar";
/// Dateiname des Deinstallers im Installationsordner.
pub const UNINSTALLER_NAME: &str = "Uninstall Pulsar.exe";
/// Infodatei im Installationsordner.
pub const INSTALL_INFO_NAME: &str = "install.json";
/// Arbeitsordner für den (fortsetzbaren) Download im Installationsordner.
pub const DOWNLOAD_DIR_NAME: &str = ".pulsar-download";
/// Datei neben der Setup-Exe, die die Manifest-Adresse überschreiben kann.
pub const SETUP_OVERRIDE_FILE: &str = "pulsar-setup.json";
/// Umgebungsvariable, die die Manifest-Adresse überschreiben kann.
pub const MANIFEST_ENV: &str = "PULSAR_MANIFEST_URL";
/// Präfix der temporären Deinstaller-Kopie.
pub const TEMP_UNINSTALL_PREFIX: &str = "pulsar-uninstall-";
/// Standard-Platzbedarf, wenn das Manifest keine Größe nennt.
pub const DEFAULT_REQUIRED_BYTES: u64 = 40 * 1024 * 1024;

/// Version der Setup-Exe.
pub fn setup_version() -> String {
    config().version.clone()
}

/// Dateiname der Verknüpfungen: `Pulsar.lnk`.
pub fn shortcut_file_name() -> String {
    format!("{}.lnk", config().app_name)
}
