//! Geräte & Privatsphäre (P6.6): Wer hat Kamera und Mikrofon benutzt (Windows-Protokoll im
//! „ConsentStore“), welche Tastaturen und USB-Speicher sind angeschlossen (BadUSB-Hinweis bei
//! neuen Tastaturen). Hier stehen nur Daten und Bewertung – gelesen wird in [`crate::collect`],
//! verändert wird nichts.

use aegis_core::risk::RiskLevel;
use serde::{Deserialize, Serialize};

use crate::persistence::{Flag, command_flags};

/// Geschützte Geräte-Funktion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    /// Kamera.
    Webcam,
    /// Mikrofon.
    Microphone,
}

impl Capability {
    /// Name im `ConsentStore`.
    #[must_use]
    pub const fn store_key(self) -> &'static str {
        match self {
            Self::Webcam => "webcam",
            Self::Microphone => "microphone",
        }
    }

    /// Bezeichnung (Deutsch, Englisch).
    #[must_use]
    pub const fn label(self) -> (&'static str, &'static str) {
        match self {
            Self::Webcam => ("Kamera", "camera"),
            Self::Microphone => ("Mikrofon", "microphone"),
        }
    }
}

/// Eine Nutzung laut Windows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityUse {
    /// Funktion.
    pub capability: Capability,
    /// App (Paketname) bzw. Programmpfad.
    pub app: String,
    /// Store-App (Paket) oder klassisches Programm?
    pub packaged: bool,
    /// Letzter Beginn (Unix-Sekunden).
    pub last_start: Option<i64>,
    /// Letztes Ende (Unix-Sekunden).
    pub last_stop: Option<i64>,
    /// Gerade in Benutzung?
    pub active: bool,
}

/// FILETIME (100 ns seit 1601) → Unix-Sekunden; 0 = nie.
#[must_use]
pub fn filetime_to_unix(ft: u64) -> Option<i64> {
    const EPOCH_DIFF: i64 = 11_644_473_600;
    if ft == 0 {
        return None;
    }
    i64::try_from(ft / 10_000_000).ok().map(|s| s - EPOCH_DIFF)
}

/// Schlüsselname unter `NonPackaged` (`C:#Program Files#x.exe`) → Pfad.
#[must_use]
pub fn nonpackaged_path(key: &str) -> String {
    key.replace('#', "\\")
}

impl CapabilityUse {
    /// Aus den Rohwerten (`LastUsedTimeStart`/`Stop` als FILETIME).
    #[must_use]
    pub fn new(
        capability: Capability,
        app: String,
        packaged: bool,
        start: Option<u64>,
        stop: Option<u64>,
    ) -> Self {
        let start_raw = start.unwrap_or(0);
        let stop_raw = stop.unwrap_or(0);
        Self {
            capability,
            app: app.chars().take(400).collect(),
            packaged,
            last_start: filetime_to_unix(start_raw),
            last_stop: filetime_to_unix(stop_raw),
            active: start_raw > 0 && (stop_raw == 0 || stop_raw < start_raw),
        }
    }

    /// Bewertung: Programme aus Temp/Downloads/Öffentlich sind auffällig; sonst nur Info.
    #[must_use]
    pub fn assess(&self) -> (RiskLevel, Vec<(String, String)>) {
        let (de, en) = self.capability.label();
        let mut reasons = Vec::new();
        let mut risk = RiskLevel::Clean;
        if !self.packaged && command_flags(&self.app).contains(&Flag::WritableLocation) {
            risk = RiskLevel::Suspicious;
            reasons.push((
                format!("Ein Programm aus einem Download-/Temp-Ordner hat auf {de} zugegriffen – ungewöhnlich für normale Software."),
                format!("A program from a download/temp folder accessed the {en} – unusual for normal software."),
            ));
        }
        if self.active {
            risk = risk.max(RiskLevel::Info);
            reasons.push((
                format!("{de} ist gerade in Benutzung."),
                format!("The {en} is in use right now."),
            ));
        }
        (risk, reasons)
    }
}

/// Art eines angeschlossenen Geräts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceKind {
    /// Tastatur (auch „Tastaturen“, die USB-Sticks vortäuschen: BadUSB).
    Keyboard,
    /// USB-Speicher.
    Storage,
}

/// Ein angeschlossenes Gerät.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Device {
    /// Art.
    pub kind: DeviceKind,
    /// Anzeigename.
    pub name: String,
    /// Geräte-Kennung (PnP).
    pub id: String,
    /// Über USB/HID angeschlossen (nicht eingebaut, z. B. PS/2 oder Laptop-Tastatur)?
    pub external: bool,
}

impl Device {
    /// Neues Gerät (Name und Kennung gekürzt).
    #[must_use]
    pub fn new(kind: DeviceKind, name: &str, id: &str) -> Self {
        let id: String = id.chars().filter(|c| !c.is_control()).take(300).collect();
        let upper = id.to_ascii_uppercase();
        Self {
            kind,
            name: name.chars().filter(|c| !c.is_control()).take(200).collect(),
            external: upper.starts_with("HID\\") || upper.starts_with("USB"),
            id,
        }
    }
}

/// Externe Tastaturen, die nicht in `known` stehen.
#[must_use]
pub fn new_keyboards<'a>(known: &[String], now: &'a [Device]) -> Vec<&'a Device> {
    now.iter()
        .filter(|d| d.kind == DeviceKind::Keyboard && d.external)
        .filter(|d| !known.iter().any(|k| k.eq_ignore_ascii_case(&d.id)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zeiten_und_aktiv() {
        // 2024-01-01T00:00:00Z
        let ft = (1_704_067_200 + 11_644_473_600) * 10_000_000u64;
        assert_eq!(filetime_to_unix(ft), Some(1_704_067_200));
        assert_eq!(filetime_to_unix(0), None);
        let running =
            CapabilityUse::new(Capability::Webcam, "Teams".into(), true, Some(ft), Some(0));
        assert!(running.active);
        let done = CapabilityUse::new(
            Capability::Webcam,
            "Teams".into(),
            true,
            Some(ft),
            Some(ft + 10),
        );
        assert!(!done.active);
        let never = CapabilityUse::new(Capability::Microphone, "x".into(), true, None, None);
        assert!(!never.active);
        assert_eq!(never.last_start, None);
    }

    #[test]
    fn bewertung_nach_ort() {
        let path = nonpackaged_path(r"C:#Users#a#AppData#Local#Temp#spy.exe");
        assert_eq!(path, r"C:\Users\a\AppData\Local\Temp\spy.exe");
        let spy = CapabilityUse::new(Capability::Microphone, path, false, Some(1), Some(0));
        let (risk, reasons) = spy.assess();
        assert_eq!(risk, RiskLevel::Suspicious);
        assert_eq!(reasons.len(), 2);
        let zoom = CapabilityUse::new(
            Capability::Webcam,
            nonpackaged_path(r"C:#Program Files#Zoom#bin#Zoom.exe"),
            false,
            Some(5),
            Some(9),
        );
        assert_eq!(zoom.assess().0, RiskLevel::Clean);
    }

    #[test]
    fn neue_externe_tastaturen() {
        let devices = vec![
            Device::new(
                DeviceKind::Keyboard,
                "HID-Tastatur",
                r"HID\VID_046D&PID_C31C&MI_00\7&1",
            ),
            Device::new(DeviceKind::Keyboard, "PS/2", r"ACPI\PNP0303\4&1"),
            Device::new(DeviceKind::Storage, "Stick", r"USBSTOR\DISK&VEN_X\1"),
        ];
        assert!(devices[0].external);
        assert!(!devices[1].external);
        let fresh = new_keyboards(&[], &devices);
        assert_eq!(fresh.len(), 1);
        assert!(new_keyboards(&[r"hid\vid_046d&pid_c31c&mi_00\7&1".into()], &devices).is_empty());
    }
}
