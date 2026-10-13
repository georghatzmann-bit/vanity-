//! Zentrale Konfiguration (`nova.config.json` im Projektstamm), beim Bauen eingebettet.

use std::sync::OnceLock;

use serde::Deserialize;

const RAW: &str = include_str!("../../../nova.config.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovaConfig {
    #[serde(default = "default_name")]
    pub app_name: String,
    #[serde(default = "default_version")]
    pub version: String,
    #[serde(default)]
    pub manifest_url: String,
}

fn default_name() -> String {
    "Nova Launcher".into()
}

fn default_version() -> String {
    env!("CARGO_PKG_VERSION").into()
}

impl Default for NovaConfig {
    fn default() -> Self {
        Self {
            app_name: default_name(),
            version: default_version(),
            manifest_url: String::new(),
        }
    }
}

/// Eingebettete Konfiguration (fällt bei einem Lesefehler auf sinnvolle Standardwerte zurück).
pub fn config() -> &'static NovaConfig {
    static CFG: OnceLock<NovaConfig> = OnceLock::new();
    CFG.get_or_init(|| serde_json::from_str(RAW).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    #[test]
    fn embedded_config_parses() {
        let c = super::config();
        assert!(!c.version.is_empty());
        assert!(c.manifest_url.starts_with("http"));
        assert_eq!(c.app_name, "Nova Launcher");
    }
}
