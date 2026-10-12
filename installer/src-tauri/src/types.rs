//! Datentypen des Vertrags zwischen Oberfläche und Backend (siehe docs/INSTALLER.md).
//! Alle Felder werden für die Oberfläche in camelCase serialisiert.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SetupMode {
    Install,
    Maintenance,
    Update,
    Uninstall,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InstallOptions {
    pub dir: String,
    pub desktop_shortcut: bool,
    pub start_menu: bool,
    pub autostart: bool,
    pub launch_after: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledInfo {
    pub dir: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupInfo {
    pub mode: SetupMode,
    pub setup_version: String,
    pub app_name: String,
    pub default_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed: Option<InstalledInfo>,
    pub elevated: bool,
    pub system_lang: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset: Option<InstallOptions>,
    pub manifest_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFile {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pub_date: Option<String>,
    pub app: ManifestFile,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub path: String,
    pub free: u64,
    pub total: u64,
    pub required: u64,
    pub exists: bool,
    pub writable: bool,
    pub needs_admin: bool,
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Payload von `install://progress`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// `connect | download | verify | install | shortcuts | register | done`
    pub phase: &'static str,
    pub downloaded: u64,
    pub total: u64,
    /// Bytes pro Sekunde (geglättet)
    pub speed: f64,
    /// Restzeit in Sekunden
    pub eta: u64,
    /// Gesamtfortschritt 0..100
    pub percent: f64,
}

impl Progress {
    pub fn step(phase: &'static str, percent: f64) -> Self {
        Self { phase, downloaded: 0, total: 0, speed: 0.0, eta: 0, percent }
    }
}

/// Payload von `install://error`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallError {
    pub phase: &'static str,
    /// `network | checksum | disk | permission | manifest | running | cancelled | unknown`
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl InstallError {
    pub fn new(phase: &'static str, code: &'static str, message: impl Into<String>, retryable: bool) -> Self {
        Self { phase, code, message: message.into(), retryable }
    }
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}/{}] {}", self.phase, self.code, self.message)
    }
}

/// Payload von `install://done`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallDone {
    pub dir: String,
    pub exe_path: String,
    pub version: String,
    pub verified: bool,
}

/// Payload von `uninstall://progress`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallProgress {
    /// `stop | shortcuts | registry | files | data | done`
    pub step: &'static str,
    pub percent: f64,
}

/// Payload von `uninstall://error`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallErrorPayload {
    pub message: String,
}

/// Inhalt von `<dir>\install.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRecord {
    pub version: String,
    pub installed_at: String,
    pub options: InstallOptions,
    #[serde(default)]
    pub verified: bool,
    /// `user` oder `machine` (Eintrag in HKCU bzw. HKLM)
    #[serde(default)]
    pub scope: String,
}
