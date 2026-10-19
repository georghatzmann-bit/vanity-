//! Geräte & Privatsphäre (P6.6, nur lesend): Kamera-/Mikrofon-Nutzung je Konto, angeschlossene
//! Tastaturen und USB-Laufwerke. Ein Hintergrund-Wächter meldet neue externe Tastaturen
//! (BadUSB-Hinweis, an alle Konten) und neu beginnende Kamera-/Mikrofon-Nutzung (nur an das
//! betroffene Konto). Verändert, blockiert oder trennt wird nichts – AEGIS erklärt, was der
//! Nutzer selbst tun kann.

use std::collections::HashSet;
use std::path::PathBuf;

use aegis_core::audit::Durable;
use aegis_core::consent::Clock;
use aegis_core::risk::RiskLevel;
use aegis_engine::Finding;
use aegis_hardening::devices::{Capability, CapabilityUse, Device, new_keyboards};
use aegis_quarantine::UserAccess;
use serde::Serialize;

use super::Service;
use crate::protocol::Response;
use crate::watch::WatchKind;

/// Höchstzahl gemerkter Tastaturen.
const MAX_KNOWN: usize = 200;

/// Eine Nutzung mit Bewertung.
#[derive(Debug, Clone, Serialize)]
pub struct UseView {
    /// Nutzung.
    #[serde(flatten)]
    pub entry: CapabilityUse,
    /// Bewertung.
    pub risk: RiskLevel,
    /// Begründungen.
    pub reasons: Vec<super::persistence::Reason>,
}

/// Zustand für die Oberfläche.
#[derive(Debug, Clone, Serialize)]
pub struct DevicesState {
    /// Unter Windows gelesen?
    pub available: bool,
    /// Kamera-/Mikrofon-Nutzung des Kontos (zuletzt benutzte zuerst).
    pub uses: Vec<UseView>,
    /// Angeschlossene Tastaturen und USB-Laufwerke.
    pub devices: Vec<Device>,
}

/// Bewertet Nutzungen und sortiert (aktiv, dann zuletzt benutzt).
#[must_use]
pub fn views(uses: Vec<CapabilityUse>) -> Vec<UseView> {
    let mut out: Vec<UseView> = uses
        .into_iter()
        .map(|entry| {
            let (risk, reasons) = entry.assess();
            UseView {
                entry,
                risk,
                reasons: reasons
                    .into_iter()
                    .map(|(de, en)| super::persistence::Reason { de, en })
                    .collect(),
            }
        })
        .collect();
    out.sort_by(|a, b| {
        b.entry
            .active
            .cmp(&a.entry.active)
            .then_with(|| b.entry.last_start.cmp(&a.entry.last_start))
    });
    out.truncate(300);
    out
}

/// Ergebnis für die Oberfläche.
#[must_use]
pub fn devices_response(state: DevicesState) -> Response {
    Response::Devices {
        state: Box::new(state),
    }
}

/// Liest den Zustand für ein Konto (ohne Dienst-Sperre aufrufen; WMI dauert etwas).
#[must_use]
pub fn collect(user: &dyn UserAccess) -> DevicesState {
    #[cfg(windows)]
    {
        let uses = user
            .identity()
            .filter(|s| s.starts_with("S-1-"))
            .map(|sid| aegis_hardening::collect::capability_uses(&sid))
            .unwrap_or_default();
        DevicesState {
            available: true,
            uses: views(uses),
            devices: aegis_hardening::collect::devices().unwrap_or_default(),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = user;
        DevicesState {
            available: false,
            uses: Vec::new(),
            devices: Vec::new(),
        }
    }
}

/// Eine Meldung des Geräte-Wächters.
#[derive(Debug, Clone)]
pub struct DeviceAlert {
    /// Art.
    pub kind: WatchKind,
    /// Was (Gerätename bzw. Programm).
    pub path: PathBuf,
    /// Konto (nur bei Kamera/Mikrofon).
    pub owner: Option<String>,
    /// Text und Bewertung.
    pub finding: Finding,
}

/// Zustand des Geräte-Wächters zwischen zwei Abfragen (rein – testbar).
#[derive(Debug, Default)]
pub struct DeviceWatch {
    /// Gerade aktive Nutzungen (Konto, Funktion, Programm, Beginn).
    active: HashSet<(String, Capability, String, Option<i64>)>,
    /// Erste Abfrage nach dem Start: nur merken, nicht melden (laufende Anrufe).
    started: bool,
}

impl DeviceWatch {
    /// Wertet eine Abfrage aus. `devices`: `None`, wenn die Geräte nicht abfragbar waren –
    /// dann bleiben Grundlinie und bekannte Tastaturen unverändert. `known`: bekannte Tastaturen
    /// (`None` = noch keine Grundlinie – dann wird nur gemerkt). Liefert Meldungen und die
    /// (ggf. unveränderte) Liste bekannter Tastaturen (`None` = weiterhin keine Grundlinie).
    pub fn poll(
        &mut self,
        devices: Option<&[Device]>,
        uses: &[(String, Vec<CapabilityUse>)],
        known: Option<Vec<String>>,
    ) -> (Vec<DeviceAlert>, Option<Vec<String>>) {
        let mut alerts = Vec::new();
        let known = match devices {
            None => known,
            Some(devices) => {
                let baseline = known.is_none();
                let mut known = known.unwrap_or_default();
                for device in new_keyboards(&known, devices) {
                    if !baseline {
                        alerts.push(keyboard_alert(device));
                    }
                    known.push(device.id.clone());
                }
                let excess = known.len().saturating_sub(MAX_KNOWN);
                known.drain(..excess);
                Some(known)
            }
        };

        let mut now = HashSet::new();
        for (sid, list) in uses {
            for u in list.iter().filter(|u| u.active) {
                let key = (sid.clone(), u.capability, u.app.clone(), u.last_start);
                if self.started && !self.active.contains(&key) {
                    alerts.push(use_alert(sid, u));
                }
                now.insert(key);
            }
        }
        self.active = now;
        self.started = true;
        (alerts, known)
    }
}

fn keyboard_alert(device: &Device) -> DeviceAlert {
    let name = if device.name.is_empty() {
        device.id.clone()
    } else {
        device.name.clone()
    };
    DeviceAlert {
        kind: WatchKind::Device,
        path: PathBuf::from(&name),
        owner: None,
        finding: Finding::behavior_alert(
            PathBuf::from(&name),
            RiskLevel::Suspicious,
            format!(
                "Neue Tastatur angeschlossen: {name}. Wenn du gerade keine Tastatur angesteckt hast (z. B. nur einen USB-Stick): Gerät sofort abziehen – manipulierte Sticks („BadUSB“) tippen in Sekunden Befehle. AEGIS hat nichts verändert."
            ),
            format!(
                "New keyboard connected: {name}. If you did not just plug in a keyboard (e.g. only a USB stick): unplug the device right away – manipulated sticks (“BadUSB”) type commands within seconds. AEGIS changed nothing."
            ),
            vec![(
                "device.keyboard".into(),
                format!("Geräte-Kennung: {}", device.id),
                format!("Device ID: {}", device.id),
            )],
        ),
    }
}

fn use_alert(sid: &str, u: &CapabilityUse) -> DeviceAlert {
    let (risk, reasons) = u.assess();
    let (de, en) = u.capability.label();
    DeviceAlert {
        kind: WatchKind::Privacy,
        path: PathBuf::from(&u.app),
        owner: Some(sid.to_owned()),
        finding: Finding::behavior_alert(
            PathBuf::from(&u.app),
            risk.max(RiskLevel::Info),
            format!("{de} wird benutzt von: {}", u.app),
            format!("The {en} is being used by: {}", u.app),
            reasons
                .into_iter()
                .map(|(d, e)| ("privacy.use".to_owned(), d, e))
                .collect(),
        ),
    }
}

impl<C: Clock, W: Durable> Service<C, W> {
    /// Bekannte Tastaturen (`None` = noch keine Grundlinie).
    #[must_use]
    pub fn known_keyboards(&self) -> Option<Vec<String>> {
        self.settings.get().known_keyboards.clone()
    }

    /// Bekannte Tastaturen merken (nur bei Änderung; `None` ändert nichts).
    pub fn remember_keyboards(&mut self, known: Option<Vec<String>>) {
        if let Some(known) = known
            && self.settings.get().known_keyboards.as_ref() != Some(&known)
        {
            let _ = self.settings.update(|s| s.known_keyboards = Some(known));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aegis_hardening::devices::DeviceKind;

    fn keyboard(id: &str) -> Device {
        Device::new(DeviceKind::Keyboard, "USB-Tastatur", id)
    }

    fn cam(app: &str, start: u64, stop: u64) -> CapabilityUse {
        CapabilityUse::new(
            Capability::Webcam,
            app.into(),
            false,
            Some(start),
            Some(stop),
        )
    }

    #[test]
    fn tastaturen_erst_grundlinie_dann_neue_melden() {
        let mut w = DeviceWatch::default();
        // WMI noch nicht bereit: keine Grundlinie, nichts gemerkt.
        let (alerts, known) = w.poll(None, &[], None);
        assert!(alerts.is_empty());
        assert_eq!(known, None);
        let (alerts, known) = w.poll(Some(&[keyboard(r"HID\VID_1\1")]), &[], None);
        assert!(alerts.is_empty(), "Grundlinie meldet nichts");
        assert_eq!(known.as_ref().map(Vec::len), Some(1));
        // Fehler später: Liste bleibt, keine Meldung.
        let (alerts, kept) = w.poll(None, &[], known.clone());
        assert!(alerts.is_empty());
        assert_eq!(kept, known);
        let (alerts, known) = w.poll(
            Some(&[keyboard(r"HID\VID_1\1"), keyboard(r"HID\VID_2\1")]),
            &[],
            known,
        );
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].kind, WatchKind::Device);
        assert!(alerts[0].owner.is_none(), "an alle Konten");
        assert!(alerts[0].finding.summary_de.contains("BadUSB"));
        assert_eq!(known.as_ref().map(Vec::len), Some(2));
        let (alerts, _) = w.poll(Some(&[keyboard(r"HID\VID_2\1")]), &[], known);
        assert!(alerts.is_empty(), "bekannt bleibt bekannt");
    }

    #[test]
    fn kamera_beginn_nur_einmal_und_nur_dem_konto() {
        let mut w = DeviceWatch::default();
        let sid = "S-1-5-21-1-2-3-1001".to_owned();
        // Beim Start schon laufend: nicht melden.
        let (alerts, _) = w.poll(
            Some(&[]),
            &[(sid.clone(), vec![cam("Teams", 10, 0)])],
            Some(vec![]),
        );
        assert!(alerts.is_empty());
        let (alerts, _) = w.poll(
            Some(&[]),
            &[(
                sid.clone(),
                vec![
                    cam("Teams", 10, 0),
                    cam(r"C:\Users\a\Downloads\x.exe", 20, 0),
                ],
            )],
            Some(vec![]),
        );
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].owner.as_deref(), Some(sid.as_str()));
        assert_eq!(alerts[0].finding.risk, RiskLevel::Suspicious);
        // Beendet und neu begonnen: wieder melden.
        let (alerts, _) = w.poll(
            Some(&[]),
            &[(sid.clone(), vec![cam("Teams", 10, 15)])],
            Some(vec![]),
        );
        assert!(alerts.is_empty());
        let (alerts, _) = w.poll(Some(&[]), &[(sid, vec![cam("Teams", 30, 0)])], Some(vec![]));
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].finding.risk, RiskLevel::Info);
    }
}
