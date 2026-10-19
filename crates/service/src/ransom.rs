//! Ransomware-Schutz (P5): erkennt typische Muster und **warnt** – er beendet, verschiebt und
//! löscht nichts. Gegenmaßnahmen (Panic-Button, Prozess beenden) gibt es nur als Vorschlag mit
//! Freigabe.
//!
//! - **Köderdateien:** Auf Wunsch (eigener Plan) legt AEGIS in Dokumente/Desktop/Bilder je eine
//!   harmlose Datei an. Wird eine davon verändert, umbenannt oder gelöscht, ist das ein starkes
//!   Zeichen (niemand sonst hat einen Grund, sie anzufassen).
//! - **Massenänderungen:** Viele Änderungen, Umbenennungen auf neue Endungen oder Löschungen in
//!   kurzer Zeit innerhalb eines Profils (Temp und App-Daten ausgenommen).
//! - **Hohe Entropie:** Werden viele Dateien, die normalerweise „lesbar“ sind (Text, CSV, alte
//!   Office-Formate, BMP …), plötzlich zu zufällig wirkenden Daten, ist das typisch für
//!   Verschlüsselung. Gemessen wird stichprobenartig im eingeschränkten Prüfprozess.
//!
//! Ehrlich: Das ist eine Heuristik ohne Kernel-Treiber. Sie kann Fehlalarme geben (z. B. große
//! Kopier- oder Synchronisationsvorgänge) und erkennt Angriffe erst, wenn sie schon laufen.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Art einer Dateiänderung (aus der Dateiüberwachung).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileChange {
    /// Neu angelegt.
    Created,
    /// Inhalt geändert.
    Modified,
    /// Umbenannt (neuer Name).
    Renamed,
    /// Umbenannt (alter Name) – zählt nur für Köderdateien.
    RenamedFrom,
    /// Gelöscht.
    Removed,
}

/// Erkanntes Muster.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Signal {
    /// Eine Köderdatei wurde angefasst.
    Canary {
        /// Die Köderdatei.
        path: PathBuf,
    },
    /// Viele normalerweise lesbare Dateien wurden zu zufällig wirkenden Daten.
    Encrypting {
        /// Ein Beispiel-Pfad.
        example: PathBuf,
        /// Betroffene Dateien im Zeitfenster.
        count: usize,
    },
    /// Viele Änderungen in kurzer Zeit.
    Burst {
        /// Ein Beispiel-Pfad.
        example: PathBuf,
        /// Geänderte Dateien im Zeitfenster.
        changed: usize,
        /// Umbenennungen auf eine neue Endung.
        renamed: usize,
        /// Gelöschte Dateien.
        removed: usize,
    },
}

impl Signal {
    /// Dasselbe Muster, als Ort aber nur `root` (z. B. der geschützte Ordner).
    #[must_use]
    pub fn shown_as(self, root: &Path) -> Self {
        let root = root.to_path_buf();
        match self {
            Self::Canary { .. } => Self::Canary { path: root },
            Self::Encrypting { count, .. } => Self::Encrypting {
                example: root,
                count,
            },
            Self::Burst {
                changed,
                renamed,
                removed,
                ..
            } => Self::Burst {
                example: root,
                changed,
                renamed,
                removed,
            },
        }
    }
}

/// Zeitfenster für Massenänderungen.
pub const WINDOW: Duration = Duration::from_secs(20);
/// Schwellen im Zeitfenster.
pub const CHANGED_LIMIT: usize = 80;
/// Umbenennungen auf neue (gleiche) Endung.
pub const RENAMED_LIMIT: usize = 20;
/// Löschungen.
pub const REMOVED_LIMIT: usize = 80;
/// Pause zwischen zwei Warnungen derselben Art: Massenänderungen je Profil, Köder je Datei.
/// Ein anderer Köder warnt auch während der Pause sofort.
pub const ALERT_PAUSE: Duration = Duration::from_secs(10 * 60);

/// Ab dieser Entropie (Bit/Byte) gilt eine Stichprobe als „wie verschlüsselt“.
pub const ENTROPY_HIGH: f64 = 7.5;
/// So viele „wie verschlüsselt“ gewordene Dateien im Zeitfenster lösen eine Warnung aus.
pub const ENCRYPTED_LIMIT: usize = 8;
/// Zeitfenster für die Entropie-Warnung (Messung kommt mit Verzögerung).
pub const ENTROPY_WINDOW: Duration = Duration::from_secs(120);

/// Formate, die normalerweise **keine** hohe Entropie haben (nicht komprimiert).
const LOW_ENTROPY_EXTENSIONS: &[&str] = &[
    "txt", "csv", "tsv", "log", "md", "rtf", "doc", "xls", "ppt", "html", "htm", "xml", "json",
    "yaml", "yml", "svg", "bmp", "wav", "sql", "ini", "cfg", "eml", "tex", "ps", "eps", "vcf",
    "ics",
];

/// Lohnt sich eine Entropie-Stichprobe für diese Änderung? Geänderte Dateien in sonst
/// „lesbaren“ Formaten und Umbenennungen auf ungewöhnliche Endungen.
#[must_use]
pub fn wants_entropy(change: FileChange, path: &Path, scope: Option<&Path>) -> bool {
    if is_noisy(path, scope) {
        return false;
    }
    match change {
        FileChange::Modified => {
            extension(path).is_some_and(|e| LOW_ENTROPY_EXTENSIONS.contains(&e.as_str()))
        }
        FileChange::Renamed => extension(path).is_some() && !is_common_extension(path),
        _ => false,
    }
}

#[derive(Debug, Default)]
struct Window {
    events: VecDeque<(Instant, FileChange, Option<String>)>,
    last_burst: Option<Instant>,
    canary_alerts: HashMap<PathBuf, Instant>,
    high_entropy: VecDeque<Instant>,
    last_encrypting: Option<Instant>,
}

/// Zustand des Ransomware-Wächters.
#[derive(Debug, Default)]
pub struct RansomGuard {
    windows: Mutex<HashMap<Option<PathBuf>, Window>>,
    /// Köderdateien und ab wann sie melden (eigenes Anlegen löst nichts aus).
    canaries: Mutex<HashMap<PathBuf, Instant>>,
}

/// Nach dem Setzen der Köder: so lange zählen ihre Ereignisse nicht (eigenes Anlegen).
pub const ARM_DELAY: Duration = Duration::from_secs(5);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Orte mit viel normaler Bewegung (Temp, App-Daten) zählen nicht für Massenänderungen.
/// Geprüft wird nur der Teil unterhalb des Profils (ein Profil namens „temp“ zählt also).
#[must_use]
pub fn is_noisy(path: &Path, scope: Option<&Path>) -> bool {
    let relative = scope
        .and_then(|s| path.strip_prefix(s).ok())
        .unwrap_or(path);
    relative.components().any(|c| {
        let s = c.as_os_str().to_string_lossy().to_ascii_lowercase();
        matches!(
            s.as_str(),
            "appdata" | "temp" | "tmp" | ".git" | "node_modules" | "target" | "$recycle.bin"
        )
    })
}

/// Gängige Endungen: Umbenennungen darauf gelten als normal.
const COMMON_EXTENSIONS: &[&str] = &[
    "txt",
    "pdf",
    "doc",
    "docx",
    "xls",
    "xlsx",
    "ppt",
    "pptx",
    "odt",
    "ods",
    "odp",
    "rtf",
    "csv",
    "jpg",
    "jpeg",
    "png",
    "gif",
    "bmp",
    "heic",
    "webp",
    "tif",
    "tiff",
    "raw",
    "mp3",
    "wav",
    "flac",
    "m4a",
    "mp4",
    "mov",
    "avi",
    "mkv",
    "zip",
    "7z",
    "rar",
    "html",
    "htm",
    "json",
    "xml",
    "md",
    "log",
    "ini",
    "tmp",
    "bak",
    "part",
    "crdownload",
];

fn is_common_extension(path: &Path) -> bool {
    extension(path).is_some_and(|e| COMMON_EXTENSIONS.contains(&e.as_str()))
}

fn extension(path: &Path) -> Option<String> {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
}

impl RansomGuard {
    /// Neuer, leerer Wächter.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Köderdateien (alle Konten), die der Wächter kennt. Nur **neue** Köder warten
    /// [`ARM_DELAY`]; bekannte bleiben scharf.
    pub fn set_canaries(&self, paths: impl IntoIterator<Item = PathBuf>) {
        let armed = Instant::now() + ARM_DELAY;
        let mut canaries = lock(&self.canaries);
        let next: HashMap<PathBuf, Instant> = paths
            .into_iter()
            .map(|p| {
                let since = canaries.get(&p).copied().unwrap_or(armed);
                (p, since)
            })
            .collect();
        *canaries = next;
    }

    /// Ist das eine Köderdatei?
    #[must_use]
    pub fn is_canary(&self, path: &Path) -> bool {
        lock(&self.canaries)
            .keys()
            .any(|c| crate::paths::same_path(c, path))
    }

    fn armed_canary(&self, path: &Path, now: Instant) -> bool {
        lock(&self.canaries)
            .iter()
            .any(|(c, since)| now >= *since && crate::paths::same_path(c, path))
    }

    /// Verarbeitet eine Dateiänderung; liefert ein Muster, wenn eines erkannt wurde (höchstens
    /// eine Warnung je Profil in [`ALERT_PAUSE`]).
    pub fn observe(
        &self,
        change: FileChange,
        path: &Path,
        scope: Option<&Path>,
        now: Instant,
    ) -> Option<Signal> {
        let canary = self.armed_canary(path, now);
        let counts = match change {
            FileChange::Created | FileChange::RenamedFrom => false,
            // Umbenennen auf gängige Endungen (Fotos sortieren …) ist normal.
            FileChange::Renamed => !is_common_extension(path),
            FileChange::Modified | FileChange::Removed => true,
        };
        if !canary && (!counts || is_noisy(path, scope)) {
            return None;
        }
        let mut windows = lock(&self.windows);
        if windows.len() > 1000 {
            windows.clear();
        }
        let window = windows.entry(scope.map(Path::to_path_buf)).or_default();
        if canary {
            // Je Köder eine Warnung pro Pause – ein anderer Köder warnt sofort.
            let key = path.to_path_buf();
            if window
                .canary_alerts
                .get(&key)
                .is_some_and(|t| now.duration_since(*t) < ALERT_PAUSE)
            {
                return None;
            }
            if window.canary_alerts.len() > 1000 {
                window.canary_alerts.clear();
            }
            window.canary_alerts.insert(key, now);
            return Some(Signal::Canary {
                path: path.to_path_buf(),
            });
        }
        let paused = window
            .last_burst
            .is_some_and(|t| now.duration_since(t) < ALERT_PAUSE);
        window.events.push_back((now, change, extension(path)));
        while window
            .events
            .front()
            .is_some_and(|(t, ..)| now.duration_since(*t) > WINDOW)
        {
            window.events.pop_front();
        }
        while window.events.len() > 10_000 {
            window.events.pop_front();
        }
        if paused {
            return None;
        }
        let changed = window
            .events
            .iter()
            .filter(|(_, c, _)| *c == FileChange::Modified)
            .count();
        let removed = window
            .events
            .iter()
            .filter(|(_, c, _)| *c == FileChange::Removed)
            .count();
        // Umbenennungen: wie viele auf dieselbe Endung (typisch: „.locked“, „.crypt“ …).
        let mut by_ext: HashMap<&str, usize> = HashMap::new();
        for (_, c, ext) in &window.events {
            if *c == FileChange::Renamed {
                *by_ext.entry(ext.as_deref().unwrap_or("")).or_default() += 1;
            }
        }
        let renamed = by_ext.values().copied().max().unwrap_or(0);
        if changed >= CHANGED_LIMIT || renamed >= RENAMED_LIMIT || removed >= REMOVED_LIMIT {
            window.last_burst = Some(now);
            window.events.clear();
            return Some(Signal::Burst {
                example: path.to_path_buf(),
                changed,
                renamed,
                removed,
            });
        }
        None
    }
}

impl RansomGuard {
    /// Ergebnis einer Entropie-Stichprobe; liefert eine Warnung, wenn genug Dateien im
    /// Zeitfenster „wie verschlüsselt“ wirken (höchstens eine je Profil in [`ALERT_PAUSE`]).
    pub fn observe_entropy(
        &self,
        path: &Path,
        scope: Option<&Path>,
        entropy: f64,
        now: Instant,
    ) -> Option<Signal> {
        if entropy < ENTROPY_HIGH {
            return None;
        }
        let mut windows = lock(&self.windows);
        if windows.len() > 1000 {
            windows.clear();
        }
        let window = windows.entry(scope.map(Path::to_path_buf)).or_default();
        window.high_entropy.push_back(now);
        while window
            .high_entropy
            .front()
            .is_some_and(|t| now.duration_since(*t) > ENTROPY_WINDOW)
        {
            window.high_entropy.pop_front();
        }
        let paused = window
            .last_encrypting
            .is_some_and(|t| now.duration_since(t) < ALERT_PAUSE);
        if paused || window.high_entropy.len() < ENCRYPTED_LIMIT {
            return None;
        }
        let count = window.high_entropy.len();
        window.last_encrypting = Some(now);
        window.high_entropy.clear();
        Some(Signal::Encrypting {
            example: path.to_path_buf(),
            count,
        })
    }
}

impl Signal {
    /// Warnung für den Wächter (nur Beobachtung, keine Aktion).
    #[must_use]
    pub fn finding(&self) -> aegis_engine::Finding {
        use aegis_core::risk::RiskLevel;
        let advice_de = "AEGIS hat nichts verändert. Wenn du das nicht selbst warst: kürzlich gestartete Programme einfrieren (anhalten), Netz trennen und das verdächtige Programm beenden – alles nach deiner Bestätigung.";
        let advice_en = "AEGIS changed nothing. If this was not you: freeze (suspend) recently started programs, disconnect the network and terminate the suspicious program – all after your confirmation.";
        match self {
            Self::Canary { path } => aegis_engine::Finding::behavior_alert(
                path.clone(),
                RiskLevel::Dangerous,
                format!("Ransomware-Verdacht: Eine AEGIS-Köderdatei wurde verändert, umbenannt oder gelöscht. {advice_de}"),
                format!("Ransomware suspected: an AEGIS bait file was changed, renamed or deleted. {advice_en}"),
                vec![(
                    "ransom.canary".into(),
                    "Köderdatei angefasst – normale Programme haben dafür keinen Grund.".into(),
                    "Bait file touched – normal programs have no reason to do that.".into(),
                )],
            ),
            Self::Encrypting { example, count } => aegis_engine::Finding::behavior_alert(
                example.clone(),
                RiskLevel::Dangerous,
                format!(
                    "Ransomware-Verdacht: {count} normalerweise lesbare Dateien wirken in kurzer Zeit wie verschlüsselt (sehr hohe Entropie). {advice_de}"
                ),
                format!(
                    "Ransomware suspected: {count} normally readable files suddenly look encrypted (very high entropy). {advice_en}"
                ),
                vec![(
                    "ransom.entropy".into(),
                    "Viele Text-/Office-/Bilddateien wurden zu zufällig wirkenden Daten.".into(),
                    "Many text/office/image files turned into random-looking data.".into(),
                )],
            ),
            Self::Burst {
                example,
                changed,
                renamed,
                removed,
            } => aegis_engine::Finding::behavior_alert(
                example.clone(),
                RiskLevel::Suspicious,
                format!(
                    "Möglicher Ransomware-Angriff: In {} Sekunden {changed} Dateien geändert, {renamed} auf dieselbe neue Endung umbenannt, {removed} gelöscht. {advice_de}",
                    WINDOW.as_secs()
                ),
                format!(
                    "Possible ransomware attack: within {} seconds {changed} files changed, {renamed} renamed to the same new extension, {removed} deleted. {advice_en}",
                    WINDOW.as_secs()
                ),
                vec![(
                    "ransom.burst".into(),
                    "Ungewöhnlich viele Änderungen in kurzer Zeit (kann auch ein großer Kopiervorgang sein).".into(),
                    "Unusually many changes in a short time (could also be a large copy job).".into(),
                )],
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn koeder_loest_sofort_aus_einmal_je_pause() {
        let g = RansomGuard::new();
        let bait = PathBuf::from("/home/a/Dokumente/AEGIS-Koeder.docx");
        g.set_canaries([bait.clone()]);
        // Eigenes Anlegen direkt danach zählt nicht.
        assert_eq!(
            g.observe(
                FileChange::Modified,
                &bait,
                Some(Path::new("/home/a")),
                Instant::now()
            ),
            None
        );
        let t = Instant::now() + ARM_DELAY;
        let scope = Path::new("/home/a");
        assert_eq!(
            g.observe(FileChange::Modified, &bait, Some(scope), t),
            Some(Signal::Canary { path: bait.clone() })
        );
        assert_eq!(
            g.observe(FileChange::Removed, &bait, Some(scope), t),
            None,
            "Pause"
        );
        // Ein zweiter Köder warnt auch in der Pause; neue Köder machen alte nicht unscharf.
        let second = PathBuf::from("/home/a/Bilder/AEGIS-Koeder.xlsx");
        g.set_canaries([bait.clone(), second.clone()]);
        assert_eq!(
            g.observe(FileChange::Modified, &second, Some(scope), t),
            None,
            "neu, noch nicht scharf"
        );
        let later = t + ARM_DELAY;
        assert_eq!(
            g.observe(FileChange::Modified, &second, Some(scope), later),
            Some(Signal::Canary {
                path: second.clone()
            })
        );
        assert!(
            g.observe(
                FileChange::Removed,
                &bait,
                Some(scope),
                t + ALERT_PAUSE + Duration::from_secs(1)
            )
            .is_some()
        );
    }

    #[test]
    fn massenumbenennung_auf_neue_endung() {
        let g = RansomGuard::new();
        let t = Instant::now();
        let scope = Path::new("/home/a");
        let mut signal = None;
        for i in 0..RENAMED_LIMIT {
            let old = PathBuf::from(format!("/home/a/Dokumente/datei{i}.docx"));
            assert_eq!(
                g.observe(FileChange::RenamedFrom, &old, Some(scope), t),
                None
            );
            let p = PathBuf::from(format!("/home/a/Dokumente/datei{i}.docx.locked"));
            signal = g.observe(FileChange::Renamed, &p, Some(scope), t);
        }
        assert!(matches!(signal, Some(Signal::Burst { renamed, .. }) if renamed == RENAMED_LIMIT));
        assert_eq!(
            signal.unwrap().finding().risk,
            aegis_core::risk::RiskLevel::Suspicious
        );
    }

    #[test]
    fn normale_arbeit_und_laute_orte_bleiben_still() {
        let g = RansomGuard::new();
        let t = Instant::now();
        let scope = Path::new("/home/a");
        // Viele neue Dateien (Entpacken) zählen nicht.
        for i in 0..500 {
            let p = PathBuf::from(format!("/home/a/Downloads/x/{i}.txt"));
            assert_eq!(g.observe(FileChange::Created, &p, Some(scope), t), None);
        }
        // Temp / App-Daten zählen nicht.
        for i in 0..500 {
            let p = PathBuf::from(format!("/home/a/AppData/Local/Temp/{i}.tmp"));
            assert_eq!(g.observe(FileChange::Modified, &p, Some(scope), t), None);
        }
        // Wenige Änderungen, über die Zeit verteilt.
        for i in 0..200u64 {
            let p = PathBuf::from(format!("/home/a/Dokumente/{i}.docx"));
            let at = t + Duration::from_secs(i);
            assert_eq!(g.observe(FileChange::Modified, &p, Some(scope), at), None);
        }
        // Fotos umbenennen (gleiche, gängige Endung) ist normal.
        for i in 0..100 {
            let p = PathBuf::from(format!("/home/a/Bilder/Urlaub_{i}.jpg"));
            assert_eq!(g.observe(FileChange::Renamed, &p, Some(scope), t), None);
        }
        // Umbenennungen auf verschiedene Endungen sind normal.
        for i in 0..100 {
            let p = PathBuf::from(format!("/home/a/Bilder/{i}.e{i}"));
            assert_eq!(g.observe(FileChange::Renamed, &p, Some(scope), t), None);
        }
    }

    #[test]
    fn hohe_entropie_vieler_lesbarer_dateien() {
        let g = RansomGuard::new();
        let t = Instant::now();
        let scope = Path::new("/home/a");
        assert!(wants_entropy(
            FileChange::Modified,
            Path::new("/home/a/Dokumente/a.txt"),
            Some(scope)
        ));
        assert!(!wants_entropy(
            FileChange::Modified,
            Path::new("/home/a/Bilder/a.jpg"),
            Some(scope)
        ));
        assert!(wants_entropy(
            FileChange::Renamed,
            Path::new("/home/a/Dokumente/a.txt.locked"),
            Some(scope)
        ));
        assert!(!wants_entropy(
            FileChange::Modified,
            Path::new("/home/a/AppData/x.txt"),
            Some(scope)
        ));
        // Niedrige Werte zählen nicht.
        for i in 0..50 {
            let p = PathBuf::from(format!("/home/a/Dokumente/{i}.txt"));
            assert_eq!(g.observe_entropy(&p, Some(scope), 4.2, t), None);
        }
        let mut signal = None;
        for i in 0..ENCRYPTED_LIMIT {
            let p = PathBuf::from(format!("/home/a/Dokumente/{i}.txt"));
            signal = g.observe_entropy(&p, Some(scope), 7.98, t);
        }
        assert!(
            matches!(signal, Some(Signal::Encrypting { count, .. }) if count == ENCRYPTED_LIMIT)
        );
        assert_eq!(
            signal.unwrap().finding().risk,
            aegis_core::risk::RiskLevel::Dangerous
        );
        // Danach Pause; über das Zeitfenster verteilt löst es nicht aus.
        let p = PathBuf::from("/home/a/Dokumente/x.txt");
        assert_eq!(g.observe_entropy(&p, Some(scope), 7.99, t), None);
        let other = RansomGuard::new();
        for i in 0..ENCRYPTED_LIMIT as u64 {
            let at = t + ENTROPY_WINDOW * u32::try_from(i).unwrap();
            assert_eq!(other.observe_entropy(&p, Some(scope), 7.99, at), None);
        }
    }

    #[test]
    fn profilname_temp_schaltet_erkennung_nicht_ab() {
        let g = RansomGuard::new();
        let t = Instant::now();
        let scope = Path::new("/home/temp");
        let mut signal = None;
        for i in 0..CHANGED_LIMIT {
            let p = PathBuf::from(format!("/home/temp/Dokumente/{i}.docx"));
            signal = g.observe(FileChange::Modified, &p, Some(scope), t);
        }
        assert!(matches!(signal, Some(Signal::Burst { .. })));
    }

    #[test]
    fn profile_getrennt() {
        let g = RansomGuard::new();
        let t = Instant::now();
        for i in 0..CHANGED_LIMIT - 1 {
            let a = PathBuf::from(format!("/home/a/Dokumente/{i}"));
            let b = PathBuf::from(format!("/home/b/Dokumente/{i}"));
            assert_eq!(
                g.observe(FileChange::Modified, &a, Some(Path::new("/home/a")), t),
                None
            );
            assert_eq!(
                g.observe(FileChange::Modified, &b, Some(Path::new("/home/b")), t),
                None
            );
        }
    }
}
