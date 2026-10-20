//! Explorer-Tweaks (Werkzeug 16) und Datenschutz-Einstellungen (Werkzeug 19): eine feste Liste
//! von Schaltern unter `HKCU` (nur das eigene Konto, keine Richtlinien, kein `HKLM`). Jeder
//! Schalter kennt seinen Wert für „an“ und „aus“; gesetzt wird nur, was in dieser Liste steht,
//! und „Rückgängig“ stellt den vorigen Wert (oder sein Fehlen) wieder her.

use serde::{Deserialize, Serialize};

/// Gruppe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Group {
    /// Explorer & Taskleiste.
    Explorer,
    /// Datenschutz.
    Privacy,
}

/// Wert eines Schalters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum Value {
    /// `REG_DWORD`.
    Dword(u32),
    /// `REG_SZ`.
    Text(String),
    /// Wert fehlt (wird entfernt).
    Absent,
}

/// Ein Schalter.
#[derive(Debug, Clone, Copy)]
pub struct Tweak {
    /// Kennung (für Oberfläche und Plan).
    pub id: &'static str,
    /// Gruppe.
    pub group: Group,
    /// Schlüssel unter `HKCU`.
    pub key: &'static str,
    /// Wertname (leer = Standardwert).
    pub name: &'static str,
    /// Wert, wenn der Schalter „an“ ist (die empfohlene/gewünschte Einstellung).
    pub on: TweakValue,
    /// Wert für „aus“ (Windows-Standard).
    pub off: TweakValue,
}

/// Feste Werte (`'static`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TweakValue {
    /// `REG_DWORD`.
    Dword(u32),
    /// `REG_SZ`.
    Text(&'static str),
    /// Wert fehlt.
    Absent,
}

impl TweakValue {
    /// Als gespeicherter Wert.
    #[must_use]
    pub fn owned(self) -> Value {
        match self {
            Self::Dword(v) => Value::Dword(v),
            Self::Text(t) => Value::Text(t.to_owned()),
            Self::Absent => Value::Absent,
        }
    }
}

const ADV: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced";
const CDM: &str = r"Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager";

/// Alle Schalter.
pub const TWEAKS: &[Tweak] = &[
    Tweak {
        id: "show_extensions",
        group: Group::Explorer,
        key: ADV,
        name: "HideFileExt",
        on: TweakValue::Dword(0),
        off: TweakValue::Dword(1),
    },
    Tweak {
        id: "show_hidden",
        group: Group::Explorer,
        key: ADV,
        name: "Hidden",
        on: TweakValue::Dword(1),
        off: TweakValue::Dword(2),
    },
    Tweak {
        id: "open_this_pc",
        group: Group::Explorer,
        key: ADV,
        name: "LaunchTo",
        on: TweakValue::Dword(1),
        off: TweakValue::Dword(2),
    },
    Tweak {
        id: "taskbar_left",
        group: Group::Explorer,
        key: ADV,
        name: "TaskbarAl",
        on: TweakValue::Dword(0),
        off: TweakValue::Dword(1),
    },
    Tweak {
        id: "hide_task_view",
        group: Group::Explorer,
        key: ADV,
        name: "ShowTaskViewButton",
        on: TweakValue::Dword(0),
        off: TweakValue::Dword(1),
    },
    Tweak {
        id: "classic_context_menu",
        group: Group::Explorer,
        key: r"Software\Classes\CLSID\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}\InprocServer32",
        name: "",
        on: TweakValue::Text(""),
        off: TweakValue::Absent,
    },
    Tweak {
        id: "no_advertising_id",
        group: Group::Privacy,
        key: r"Software\Microsoft\Windows\CurrentVersion\AdvertisingInfo",
        name: "Enabled",
        on: TweakValue::Dword(0),
        off: TweakValue::Dword(1),
    },
    Tweak {
        id: "no_tailored_experiences",
        group: Group::Privacy,
        key: r"Software\Microsoft\Windows\CurrentVersion\Privacy",
        name: "TailoredExperiencesWithDiagnosticDataEnabled",
        on: TweakValue::Dword(0),
        off: TweakValue::Dword(1),
    },
    Tweak {
        id: "no_launch_tracking",
        group: Group::Privacy,
        key: ADV,
        name: "Start_TrackProgs",
        on: TweakValue::Dword(0),
        off: TweakValue::Dword(1),
    },
    Tweak {
        id: "no_start_suggestions",
        group: Group::Privacy,
        key: CDM,
        name: "SystemPaneSuggestionsEnabled",
        on: TweakValue::Dword(0),
        off: TweakValue::Dword(1),
    },
    Tweak {
        id: "no_settings_suggestions",
        group: Group::Privacy,
        key: CDM,
        name: "SubscribedContent-338393Enabled",
        on: TweakValue::Dword(0),
        off: TweakValue::Dword(1),
    },
    Tweak {
        id: "no_tips",
        group: Group::Privacy,
        key: CDM,
        name: "SoftLandingEnabled",
        on: TweakValue::Dword(0),
        off: TweakValue::Dword(1),
    },
    Tweak {
        id: "no_language_list",
        group: Group::Privacy,
        key: r"Control Panel\International\User Profile",
        name: "HttpAcceptLanguageOptOut",
        on: TweakValue::Dword(1),
        off: TweakValue::Absent,
    },
    Tweak {
        id: "no_ink_collection",
        group: Group::Privacy,
        key: r"Software\Microsoft\InputPersonalization",
        name: "RestrictImplicitInkCollection",
        on: TweakValue::Dword(1),
        off: TweakValue::Dword(0),
    },
    Tweak {
        id: "no_text_collection",
        group: Group::Privacy,
        key: r"Software\Microsoft\InputPersonalization",
        name: "RestrictImplicitTextCollection",
        on: TweakValue::Dword(1),
        off: TweakValue::Dword(0),
    },
    Tweak {
        id: "no_online_speech",
        group: Group::Privacy,
        key: r"Software\Microsoft\Speech_OneCore\Settings\OnlineSpeechPrivacy",
        name: "HasAccepted",
        on: TweakValue::Dword(0),
        off: TweakValue::Dword(1),
    },
    Tweak {
        id: "no_bing_search",
        group: Group::Privacy,
        key: r"Software\Microsoft\Windows\CurrentVersion\Search",
        name: "BingSearchEnabled",
        on: TweakValue::Dword(0),
        off: TweakValue::Absent,
    },
];

/// Schalter nach Kennung.
#[must_use]
pub fn find(id: &str) -> Option<&'static Tweak> {
    TWEAKS.iter().find(|t| t.id == id)
}

/// Gehört (Schlüssel, Name) zu einem bekannten Schalter? Nur solche Werte werden gesetzt.
#[must_use]
pub fn known(key: &str, name: &str) -> bool {
    TWEAKS
        .iter()
        .any(|t| t.key.eq_ignore_ascii_case(key) && t.name.eq_ignore_ascii_case(name))
}

/// Ist der Schalter bei diesem Wert „an“? Ein fehlender Wert gilt als Windows-Standard (aus),
/// außer „an“ ist selbst „fehlt“.
#[must_use]
pub fn is_on(tweak: &Tweak, current: &Value) -> bool {
    current == &tweak.on.owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feste_liste_nur_hkcu_und_eindeutig() {
        let mut ids: Vec<&str> = TWEAKS.iter().map(|t| t.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), TWEAKS.len());
        for t in TWEAKS {
            assert!(!t.key.starts_with("HKEY") && !t.key.to_ascii_lowercase().contains("policies"));
            assert_ne!(t.on, t.off, "{}", t.id);
        }
        let ext = find("show_extensions").unwrap();
        assert!(is_on(ext, &Value::Dword(0)));
        assert!(!is_on(ext, &Value::Absent));
        assert!(known(ADV, "hidefileext"));
        assert!(!known(ADV, "Shell"));
    }
}
