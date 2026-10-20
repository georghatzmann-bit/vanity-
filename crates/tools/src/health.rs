//! Systeminfo & Gesundheits-Check (Werkzeug 22) – nur lesend; ehrliche Hinweise statt Noten.

use serde::Serialize;

/// Ein Laufwerk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Drive {
    /// Wurzel (`C:\`).
    pub root: String,
    /// Frei (Byte).
    pub free: u64,
    /// Gesamt (Byte).
    pub total: u64,
}

/// Rohdaten des Systems.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    /// Produkt (z. B. „Windows 11 Pro“).
    pub os: String,
    /// Version (z. B. „24H2“).
    pub version: String,
    /// Build (z. B. „26100.2033“).
    pub build: String,
    /// Prozessor.
    pub cpu: String,
    /// Logische Kerne.
    pub cores: usize,
    /// Arbeitsspeicher gesamt/verfügbar (Byte).
    pub memory: Option<(u64, u64)>,
    /// Laufzeit seit dem Start (Sekunden).
    pub uptime: u64,
    /// Feste Laufwerke.
    pub drives: Vec<Drive>,
    /// Rechnername.
    pub computer: String,
}

/// Hinweis des Gesundheits-Checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Finding {
    /// Ein Laufwerk hat weniger als 10 % frei.
    LowDisk,
    /// Ein Laufwerk hat weniger als 2 GB frei.
    CriticalDisk,
    /// Seit über 14 Tagen nicht neu gestartet (Updates warten oft auf einen Neustart).
    LongUptime,
    /// Arbeitsspeicher fast voll (unter 10 % frei).
    LowMemory,
}

/// Gesundheits-Check.
#[must_use]
pub fn check(info: &SystemInfo) -> Vec<Finding> {
    let mut out = Vec::new();
    if info
        .drives
        .iter()
        .any(|d| d.total > 0 && d.free < 2 * 1024 * 1024 * 1024)
    {
        out.push(Finding::CriticalDisk);
    } else if info
        .drives
        .iter()
        .any(|d| d.total > 0 && d.free.saturating_mul(10) < d.total)
    {
        out.push(Finding::LowDisk);
    }
    if info.uptime > 14 * 86_400 {
        out.push(Finding::LongUptime);
    }
    if let Some((total, avail)) = info.memory
        && total > 0
        && avail.saturating_mul(10) < total
    {
        out.push(Finding::LowMemory);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hinweise() {
        let mut info = SystemInfo {
            drives: vec![Drive {
                root: "C:\\".into(),
                free: 50 * 1024 * 1024 * 1024,
                total: 100 * 1024 * 1024 * 1024,
            }],
            memory: Some((16, 8)),
            uptime: 3600,
            ..SystemInfo::default()
        };
        assert!(check(&info).is_empty());
        info.drives[0].free = 5 * 1024 * 1024 * 1024;
        info.uptime = 20 * 86_400;
        info.memory = Some((100, 5));
        assert_eq!(
            check(&info),
            [Finding::LowDisk, Finding::LongUptime, Finding::LowMemory]
        );
        info.drives[0].free = 1;
        assert_eq!(check(&info)[0], Finding::CriticalDisk);
    }
}
