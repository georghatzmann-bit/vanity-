//! Befehl `app_info`: Version, Build-Profil und Plattform für „Über AEGIS“.
//!
//! Nur lesend und ohne Netz. Die Angaben werden einmal beim Start erhoben (Version der
//! App aus `tauri.conf.json`, Rest aus Compiler-Konstanten bzw. dem Betriebssystem) und
//! danach unverändert geliefert – der Befehl selbst macht kein I/O.

use serde::Serialize;

/// Build-Profil der laufenden App.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BuildProfile {
    Debug,
    Release,
}

impl BuildProfile {
    /// Profil dieses Builds (`debug_assertions` an = Entwicklungs-Build).
    pub const fn current() -> Self {
        if cfg!(debug_assertions) {
            Self::Debug
        } else {
            Self::Release
        }
    }
}

/// Antwort von `app_info` (JSON-Schlüssel in camelCase, `osVersion` ggf. `null`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// Version der App (`tauri.conf.json` → `version`).
    pub version: String,
    pub build_profile: BuildProfile,
    /// `windows`, `linux`, `macos` … (`std::env::consts::OS`).
    pub os: String,
    /// Windows: `10.0.<Build>.<UBR>` (Windows 11 meldet ebenfalls 10.0, Build ≥ 22000);
    /// Linux: `PRETTY_NAME` aus `os-release`; sonst bzw. wenn unbekannt: `null`.
    pub os_version: Option<String>,
    /// `x86_64`, `aarch64` … (`std::env::consts::ARCH`).
    pub arch: String,
    /// Version des Tauri-Crates.
    pub tauri_version: String,
}

impl AppInfo {
    /// Setzt die Angaben aus App-Version, Betriebssystem-Version und Compiler-Konstanten zusammen.
    pub fn new(version: impl Into<String>, os_version: Option<String>) -> Self {
        Self {
            version: version.into(),
            build_profile: BuildProfile::current(),
            os: std::env::consts::OS.to_owned(),
            os_version,
            arch: std::env::consts::ARCH.to_owned(),
            tauri_version: tauri::VERSION.to_owned(),
        }
    }

    /// Erhebt die Angaben für die laufende App (liest nur, verändert nichts).
    pub fn detect(version: impl Into<String>) -> Self {
        Self::new(version, os_version())
    }
}

/// Liefert die beim Start erhobenen Angaben.
#[tauri::command]
pub fn app_info(info: tauri::State<'_, AppInfo>) -> AppInfo {
    info.inner().clone()
}

/// Höchstlänge der Betriebssystem-Version (Schutz vor überlangen `os-release`-Einträgen).
#[cfg(any(target_os = "linux", test))]
const MAX_OS_VERSION_CHARS: usize = 128;

/// `10.0.22631` bzw. mit Update-Stand (UBR) `10.0.22631.4317`.
#[cfg(any(windows, test))]
pub fn format_windows_version(major: u32, minor: u32, build: u32, revision: u32) -> String {
    if revision == 0 {
        format!("{major}.{minor}.{build}")
    } else {
        format!("{major}.{minor}.{build}.{revision}")
    }
}

/// Liest aus einer `os-release`-Datei `PRETTY_NAME`, sonst `NAME VERSION_ID`, sonst `NAME`.
/// Werte dürfen in `"…"`/`'…'` stehen (mit `\`-Escapes wie in der Spezifikation).
/// Steuerzeichen werden entfernt, die Länge begrenzt; leere Werte zählen nicht.
#[cfg(any(target_os = "linux", test))]
pub fn parse_os_release(text: &str) -> Option<String> {
    let mut pretty = None;
    let mut name = None;
    let mut version_id = None;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let Some((key, raw)) = line.split_once('=') else {
            continue;
        };
        let value = clean(&unquote(raw.trim()));
        if value.is_empty() {
            continue;
        }
        match key.trim() {
            "PRETTY_NAME" => pretty = Some(value),
            "NAME" => name = Some(value),
            "VERSION_ID" => version_id = Some(value),
            _ => {}
        }
    }
    pretty.or_else(|| match (name, version_id) {
        (Some(name), Some(version)) => Some(clean(&format!("{name} {version}"))),
        (name, _) => name,
    })
}

/// Entfernt umschließende Anführungszeichen und löst `\"`, `\\`, `\$`, `` \` `` auf.
#[cfg(any(target_os = "linux", test))]
fn unquote(raw: &str) -> String {
    let inner = match raw.as_bytes() {
        [b'"', .., b'"'] | [b'\'', .., b'\''] => &raw[1..raw.len() - 1],
        _ => raw,
    };
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\'
            && let Some(next) = chars.next()
        {
            out.push(next);
        } else {
            out.push(c);
        }
    }
    out
}

/// Ohne Steuerzeichen, getrimmt, höchstens [`MAX_OS_VERSION_CHARS`] Zeichen.
#[cfg(any(target_os = "linux", test))]
fn clean(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_OS_VERSION_CHARS)
        .collect::<String>()
        .trim()
        .to_owned()
}

#[cfg(windows)]
fn os_version() -> Option<String> {
    let version = windows_version::OsVersion::current();
    if version.major == 0 {
        return None;
    }
    Some(format_windows_version(
        version.major,
        version.minor,
        version.build,
        windows_version::revision(),
    ))
}

#[cfg(target_os = "linux")]
fn os_version() -> Option<String> {
    ["/etc/os-release", "/usr/lib/os-release"]
        .into_iter()
        .find_map(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| parse_os_release(&text))
}

#[cfg(not(any(windows, target_os = "linux")))]
fn os_version() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_schluessel_genau_wie_vereinbart() {
        let value = serde_json::to_value(AppInfo::new("0.1.0", Some("10.0.22631".into()))).unwrap();
        let object = value.as_object().unwrap();
        let mut keys: Vec<_> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "arch",
                "buildProfile",
                "os",
                "osVersion",
                "tauriVersion",
                "version"
            ]
        );
        assert_eq!(value["version"], "0.1.0");
        assert_eq!(value["osVersion"], "10.0.22631");
        for key in [
            "version",
            "buildProfile",
            "os",
            "osVersion",
            "arch",
            "tauriVersion",
        ] {
            assert!(value[key].is_string(), "{key} ist kein String");
        }
    }

    #[test]
    fn unbekannte_os_version_ist_null_und_nicht_weggelassen() {
        let value = serde_json::to_value(AppInfo::new("0.1.0", None)).unwrap();
        assert!(value.as_object().unwrap().contains_key("osVersion"));
        assert!(value["osVersion"].is_null());
    }

    #[test]
    fn build_profil_und_plattform_aus_dem_compiler() {
        let value = serde_json::to_value(AppInfo::new("1.2.3", None)).unwrap();
        let expected = if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        };
        assert_eq!(value["buildProfile"], expected);
        assert_eq!(value["os"], std::env::consts::OS);
        assert_eq!(value["arch"], std::env::consts::ARCH);
        assert_eq!(value["tauriVersion"], tauri::VERSION);
        assert!(tauri::VERSION.starts_with("2."));
        if cfg!(windows) {
            assert_eq!(value["os"], "windows");
        }
    }

    #[test]
    fn build_profil_serialisiert_klein() {
        assert_eq!(serde_json::to_value(BuildProfile::Debug).unwrap(), "debug");
        assert_eq!(
            serde_json::to_value(BuildProfile::Release).unwrap(),
            "release"
        );
    }

    #[test]
    fn windows_version_mit_und_ohne_update_stand() {
        assert_eq!(format_windows_version(10, 0, 22631, 0), "10.0.22631");
        assert_eq!(
            format_windows_version(10, 0, 26100, 4351),
            "10.0.26100.4351"
        );
    }

    #[test]
    fn os_release_pretty_name_mit_anfuehrungszeichen() {
        let text = "NAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\nPRETTY_NAME=\"Ubuntu 24.04.3 LTS\"\nID=ubuntu\n";
        assert_eq!(
            parse_os_release(text).as_deref(),
            Some("Ubuntu 24.04.3 LTS")
        );
    }

    #[test]
    fn os_release_ohne_pretty_name() {
        assert_eq!(
            parse_os_release("NAME=Fedora\nVERSION_ID=42\n").as_deref(),
            Some("Fedora 42")
        );
        assert_eq!(
            parse_os_release("NAME='Arch Linux'\n").as_deref(),
            Some("Arch Linux")
        );
        assert_eq!(parse_os_release("VERSION_ID=1\n"), None);
        assert_eq!(parse_os_release(""), None);
        assert_eq!(
            parse_os_release("# PRETTY_NAME=x\nPRETTY_NAME=\"\"\n"),
            None
        );
    }

    #[test]
    fn os_release_escapes_steuerzeichen_und_laenge() {
        assert_eq!(
            parse_os_release("PRETTY_NAME=\"A \\\"B\\\" \\$C\"\n").as_deref(),
            Some("A \"B\" $C")
        );
        assert_eq!(
            parse_os_release("PRETTY_NAME=\"X\u{1b}[31mY\u{7}\"\n").as_deref(),
            Some("X[31mY")
        );
        let long = format!("PRETTY_NAME={}\n", "z".repeat(1000));
        assert_eq!(
            parse_os_release(&long).map(|v| v.chars().count()),
            Some(MAX_OS_VERSION_CHARS)
        );
        // Ein einzelnes Anführungszeichen ist kein umschließendes Paar.
        assert_eq!(parse_os_release("NAME=\"\n").as_deref(), Some("\""));
    }

    #[test]
    fn erkennung_liefert_plausible_werte() {
        let info = AppInfo::detect("0.1.0");
        if let Some(version) = &info.os_version {
            assert!(!version.is_empty());
            assert!(version.chars().count() <= MAX_OS_VERSION_CHARS);
            assert!(!version.chars().any(char::is_control));
        }
        if cfg!(windows) {
            let version = info.os_version.unwrap();
            assert!(
                version.starts_with("10.") || version.starts_with("6."),
                "{version}"
            );
        }
    }
}
