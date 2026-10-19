//! Zeitpläne und Dienst-Einstellungen: geplante Scans je Konto (nur prüfen und melden) und
//! das ClamAV-Signatur-Update (`freshclam`, abschaltbar). Gespeichert als JSON im Datenordner.

use std::io;
use std::path::{Path, PathBuf};

use aegis_core::time::{Duration, OffsetDateTime};
use serde::{Deserialize, Serialize};

/// Erlaubte Abstände geplanter Scans (Tage).
pub const INTERVALS: [u16; 3] = [1, 7, 30];
/// Abstand der Signatur-Updates.
pub const UPDATE_EVERY: Duration = Duration::hours(24);
/// Erneuter Versuch nach einem fehlgeschlagenen Update.
pub const UPDATE_RETRY: Duration = Duration::hours(1);
/// Ordner im Profil, die ein geplanter Scan prüft.
pub const SCHEDULED_FOLDERS: [&str; 3] = ["Downloads", "Desktop", "Documents"];

/// Geplanter Scan eines Kontos.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Schedule {
    /// Konto (SID); `None` = ohne Kontotrennung (Entwicklung).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// Profilordner des Kontos.
    pub profile: PathBuf,
    /// Aktiv?
    pub enabled: bool,
    /// Abstand in Tagen (1, 7 oder 30).
    pub every_days: u16,
    /// Stunde (UTC, 0–23) – die App rechnet aus der Ortszeit um.
    pub hour_utc: u8,
    /// Letzter Lauf.
    #[serde(
        default,
        with = "aegis_core::time::serde::rfc3339::option",
        skip_serializing_if = "Option::is_none"
    )]
    pub last_run: Option<OffsetDateTime>,
}

impl Schedule {
    /// Ist ein Lauf fällig? Erst ab der eingestellten Stunde; war der Rechner aus, wird der
    /// Lauf später am Tag nachgeholt.
    #[must_use]
    pub fn due(&self, now: OffsetDateTime) -> bool {
        if !self.enabled {
            return false;
        }
        match self.last_run {
            // Erster Lauf: ab der eingestellten Stunde.
            None => now.hour() >= self.hour_utc,
            // Uhr zurückgestellt: nicht für immer blockieren.
            Some(last) if last > now => true,
            Some(last) => now >= self.next_after(last),
        }
    }

    /// Nächster Termin nach `last`: `every_days` Tage später zur eingestellten Stunde. War der
    /// Rechner zu dieser Zeit aus, wird beim nächsten Mal nachgeholt.
    #[must_use]
    pub fn next_after(&self, last: OffsetDateTime) -> OffsetDateTime {
        let day = last.date() + Duration::days(i64::from(self.every_days));
        let at = day
            .with_hms(self.hour_utc.min(23), 0, 0)
            .map_or(last + Duration::days(i64::from(self.every_days)), |t| {
                t.assume_utc()
            });
        // Ein früher Lauf am Vortag soll nicht am Folgetag schon wieder kommen (bei 1 Tag).
        at.max(last + Duration::hours(12))
    }
}

/// Einstellungen des Dienstes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceSettings {
    /// Geplante Scans (je Konto höchstens einer).
    #[serde(default)]
    pub schedules: Vec<Schedule>,
    /// ClamAV-Signaturen täglich aktualisieren (Netzwerk; abschaltbar).
    #[serde(default = "yes")]
    pub clamav_update: bool,
    /// Letztes Signatur-Update (Zeit, Erfolg, Meldung).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_update: Option<UpdateRecord>,
    /// Angelegte Köderdateien des Ransomware-Schutzes (je Konto).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub baits: Vec<BaitSet>,
    /// Panic-Button aktiv seit (RFC 3339); `None` = Netz normal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panic_since: Option<String>,
    /// Konto, das das Netz getrennt hat (darf es – neben Administratoren – wieder verbinden).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panic_by: Option<String>,
}

/// Köderdateien eines Kontos.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BaitSet {
    /// Konto (SID).
    pub owner: Option<String>,
    /// Angelegte Dateien.
    pub files: Vec<PathBuf>,
}

fn yes() -> bool {
    true
}

impl Default for ServiceSettings {
    fn default() -> Self {
        Self {
            schedules: Vec::new(),
            clamav_update: true,
            last_update: None,
            baits: Vec::new(),
            panic_since: None,
            panic_by: None,
        }
    }
}

/// Ergebnis des letzten Signatur-Updates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateRecord {
    /// Zeitpunkt.
    #[serde(with = "aegis_core::time::serde::rfc3339")]
    pub at: OffsetDateTime,
    /// Erfolgreich?
    pub ok: bool,
    /// Meldung von freshclam.
    pub message: String,
}

impl ServiceSettings {
    /// Ist ein Signatur-Update fällig?
    #[must_use]
    pub fn update_due(&self, now: OffsetDateTime) -> bool {
        self.clamav_update
            && self.last_update.as_ref().is_none_or(|u| {
                u.at > now || now - u.at >= if u.ok { UPDATE_EVERY } else { UPDATE_RETRY }
            })
    }

    /// Zeitplan eines Kontos.
    #[must_use]
    pub fn schedule_of(&self, owner: Option<&str>) -> Option<&Schedule> {
        self.schedules.iter().find(|s| s.owner.as_deref() == owner)
    }
}

/// Gespeicherte Einstellungen.
#[derive(Debug)]
pub struct SettingsStore {
    path: Option<PathBuf>,
    data: ServiceSettings,
}

impl SettingsStore {
    /// Öffnet die Einstellungen (fehlt die Datei: Standard).
    ///
    /// # Errors
    /// Datei beschädigt oder nicht lesbar.
    pub fn open(path: &Path) -> io::Result<Self> {
        Ok(Self {
            path: Some(path.to_owned()),
            data: crate::store::load_or_set_aside(path, "Dienst-Einstellungen")?
                .0
                .unwrap_or_default(),
        })
    }

    /// Nur im Speicher (Tests).
    #[must_use]
    pub fn in_memory() -> Self {
        Self {
            path: None,
            data: ServiceSettings::default(),
        }
    }

    /// Aktuelle Einstellungen.
    #[must_use]
    pub fn get(&self) -> &ServiceSettings {
        &self.data
    }

    /// Ändert die Einstellungen und speichert; schlägt das Speichern fehl, bleibt alles beim
    /// Alten.
    ///
    /// # Errors
    /// Speichern fehlgeschlagen.
    pub fn update(&mut self, change: impl FnOnce(&mut ServiceSettings)) -> io::Result<()> {
        let mut next = self.data.clone();
        change(&mut next);
        if let Some(path) = &self.path {
            crate::store::save(path, &next)?;
        }
        self.data = next;
        Ok(())
    }
}

/// Prüft eine Eingabe für einen Zeitplan.
///
/// # Errors
/// Text für die Fehler-Antwort.
pub fn check_schedule_input(every_days: u16, hour_utc: u8) -> Result<(), String> {
    if !INTERVALS.contains(&every_days) {
        return Err("Abstand muss 1, 7 oder 30 Tage sein".into());
    }
    if hour_utc > 23 {
        return Err("Stunde muss zwischen 0 und 23 liegen".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Zeitpunkt im Oktober 2026 (UTC).
    fn at(day: u8, hour: u8, minute: u8) -> OffsetDateTime {
        aegis_core::time::Date::from_calendar_date(2026, aegis_core::time::Month::October, day)
            .unwrap()
            .with_hms(hour, minute, 0)
            .unwrap()
            .assume_utc()
    }

    fn schedule(last: Option<OffsetDateTime>) -> Schedule {
        Schedule {
            owner: Some("S-A".into()),
            profile: PathBuf::from("/u/a"),
            enabled: true,
            every_days: 7,
            hour_utc: 9,
            last_run: last,
        }
    }

    #[test]
    fn faelligkeit() {
        let mon_8 = at(19, 8, 0);
        let mon_10 = at(19, 10, 0);
        assert!(!schedule(None).due(mon_8), "erster Lauf erst ab der Stunde");
        assert!(schedule(None).due(mon_10));
        let ran = Some(at(19, 9, 5));
        assert!(!schedule(ran).due(at(20, 10, 0)));
        assert!(
            !schedule(ran).due(at(26, 8, 59)),
            "erst ab der Stunde des Termins"
        );
        assert!(schedule(ran).due(at(26, 9, 0)));
        assert!(
            schedule(ran).due(at(27, 3, 0)),
            "verpasster Termin wird nachgeholt, auch früh"
        );
        assert!(
            schedule(Some(at(28, 0, 0))).due(at(20, 0, 0)),
            "Uhr zurückgestellt"
        );
        let mut off = schedule(None);
        off.enabled = false;
        assert!(!off.due(mon_10));
    }

    #[test]
    fn update_faellig_und_abschaltbar() {
        let now = at(19, 10, 0);
        let mut s = ServiceSettings::default();
        assert!(s.update_due(now));
        s.last_update = Some(UpdateRecord {
            at: now,
            ok: true,
            message: String::new(),
        });
        assert!(!s.update_due(now + Duration::hours(23)));
        assert!(s.update_due(now + Duration::hours(24)));
        s.last_update = Some(UpdateRecord {
            at: now,
            ok: false,
            message: "kein Netz".into(),
        });
        assert!(!s.update_due(now + Duration::minutes(30)));
        assert!(
            s.update_due(now + Duration::hours(1)),
            "Fehlschlag: nach einer Stunde erneut"
        );
        s.clamav_update = false;
        assert!(!s.update_due(now + Duration::hours(48)));
    }

    #[test]
    fn eingaben_und_dauerhaft() {
        assert!(check_schedule_input(7, 9).is_ok());
        assert!(check_schedule_input(2, 9).is_err());
        assert!(check_schedule_input(1, 24).is_err());
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        let mut store = SettingsStore::open(&file).unwrap();
        store.update(|s| s.schedules.push(schedule(None))).unwrap();
        let reopened = SettingsStore::open(&file).unwrap();
        assert_eq!(
            reopened.get().schedule_of(Some("S-A")),
            Some(&schedule(None))
        );
        assert!(reopened.get().schedule_of(Some("S-B")).is_none());
    }
}
