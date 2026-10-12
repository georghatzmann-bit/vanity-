//! Kommandozeile der Setup-Exe und das Base64-Preset für den UAC-Neustart.

use crate::types::InstallOptions;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use std::path::PathBuf;

#[derive(Debug, Clone, Default)]
pub struct CliArgs {
    /// `--manifest <url-oder-pfad>`
    pub manifest: Option<String>,
    /// `--update`
    pub update: bool,
    /// `--uninstall`
    pub uninstall: bool,
    /// `--target <dir>` (Installationsordner für die Deinstallation)
    pub target: Option<PathBuf>,
    /// `--elevated` (nach UAC-Neustart)
    pub elevated: bool,
    /// `--preset <base64-json>`
    pub preset: Option<InstallOptions>,
    /// `--selftest`
    pub selftest: bool,
    /// `--dir <dir>` (Selbsttest)
    pub dir: Option<PathBuf>,
    /// `--report <datei>` (Selbsttest)
    pub report: Option<PathBuf>,
    /// `--quiet` / `--silent` (mit `--uninstall`: ohne Oberfläche, für `QuietUninstallString`)
    pub quiet: bool,
}

/// Entfernt umschließende Anführungszeichen und Leerraum (z. B. `"C:\x\"` aus Verknüpfungen).
fn clean_value(v: &str) -> String {
    v.trim().trim_matches('"').trim().to_string()
}

impl CliArgs {
    pub fn from_env() -> Self {
        Self::parse(std::env::args().skip(1))
    }

    /// Unterstützt `--key value` und `--key=value`; unbekannte Argumente werden ignoriert.
    pub fn parse<I, S>(args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let list: Vec<String> = args.into_iter().map(Into::into).collect();
        let mut out = CliArgs::default();
        let mut i = 0;
        while i < list.len() {
            let raw = list[i].trim();
            let (key, inline) = match raw.split_once('=') {
                Some((k, v)) if k.starts_with("--") => (k.to_ascii_lowercase(), Some(v.to_string())),
                _ => (raw.to_ascii_lowercase(), None),
            };
            let takes_value = matches!(key.as_str(), "--manifest" | "--target" | "--preset" | "--dir" | "--report");
            let mut value = inline;
            if takes_value && value.is_none() {
                if let Some(next) = list.get(i + 1) {
                    if !next.starts_with("--") {
                        value = Some(next.clone());
                        i += 1;
                    }
                }
            }
            let value = value.map(|v| clean_value(&v)).filter(|v| !v.is_empty());
            match key.as_str() {
                "--manifest" => out.manifest = value,
                "--target" => out.target = value.map(PathBuf::from),
                "--preset" => out.preset = value.and_then(|v| decode_preset(&v).ok()),
                "--dir" => out.dir = value.map(PathBuf::from),
                "--report" => out.report = value.map(PathBuf::from),
                "--update" => out.update = true,
                "--uninstall" => out.uninstall = true,
                "--elevated" => out.elevated = true,
                "--selftest" => out.selftest = true,
                "--quiet" | "--silent" => out.quiet = true,
                _ => {}
            }
            i += 1;
        }
        out
    }
}

/// JSON der Optionen als URL-sicheres Base64 ohne Padding (keine Quoting-Probleme in der Kommandozeile).
pub fn encode_preset(options: &InstallOptions) -> String {
    let json = serde_json::to_vec(options).unwrap_or_default();
    URL_SAFE_NO_PAD.encode(json)
}

/// Akzeptiert URL-sicheres und Standard-Base64, mit oder ohne Padding.
pub fn decode_preset(text: &str) -> Result<InstallOptions, String> {
    let text = text.trim();
    let bytes = [&URL_SAFE_NO_PAD, &URL_SAFE, &STANDARD, &STANDARD_NO_PAD]
        .iter()
        .find_map(|engine| engine.decode(text).ok())
        .ok_or_else(|| "preset: invalid base64".to_string())?;
    serde_json::from_slice::<InstallOptions>(&bytes).map_err(|e| format!("preset: invalid json ({e})"))
}
