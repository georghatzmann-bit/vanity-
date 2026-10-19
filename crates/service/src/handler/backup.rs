//! Rückfall-Kopien im Dienst (P5, nur nach Opt-in): Einschalten/Ausschalten per Plan, der
//! Zeitplaner sichert danach regelmäßig die geschützten Ordner des Kontos (gelesen mit dessen
//! Rechten, gespeichert verschlüsselt im AEGIS-Ordner). Zurückholen und Ausdünnen sind eigene
//! Pläne; gelöscht wird nie automatisch.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use aegis_core::audit::{Durable, ExecutionResult};
use aegis_core::consent::{Clock, ExecutionPermit};
use aegis_core::plan::{ActionKind, ActionPlan, Target, UndoHint, param};
use aegis_core::risk::RiskLevel;
use aegis_core::time::{Duration, OffsetDateTime};
use aegis_quarantine::UserAccess;
use aegis_quarantine::backup::{BACKUP_SETTING, BackupStore, BackupVersion, MAX_FILE, Usage};
use serde::Serialize;

use super::Service;
use crate::history::{HistoryKind, NewEntry};
use crate::protocol::Response;

/// Erlaubte Speichergrenzen (MiB).
pub const QUOTAS_MB: [u64; 6] = [1024, 5 * 1024, 10 * 1024, 25 * 1024, 50 * 1024, 100 * 1024];
/// Abstand zwischen zwei Läufen je Konto.
pub const INTERVAL_MINUTES: i64 = 30;
/// Nach einer Ransomware-Warnung pausiert die Sicherung (sonst kämen verschlüsselte Dateien
/// als „neue Versionen“ hinzu; ältere Versionen bleiben ohnehin).
pub const PAUSE_AFTER_ALERT_MINUTES: u64 = 60;
/// Höchstzahl Dateien, die ein Lauf ansieht bzw. sichert.
const MAX_SEEN: usize = 50_000;
const MAX_COPIES: usize = 2_000;
/// Erlaubte Fristen fürs Ausdünnen (Tage).
pub const PRUNE_DAYS: [u32; 4] = [7, 30, 90, 365];

/// Zustand eines Laufs (nur im Speicher).
#[derive(Debug, Clone, Default)]
pub(super) struct BackupRuns {
    last: HashMap<Option<String>, (OffsetDateTime, String)>,
    started: HashMap<Option<String>, OffsetDateTime>,
}

/// Ein fälliger Lauf.
#[derive(Debug, Clone)]
pub struct BackupJob {
    /// Konto.
    pub owner: Option<String>,
    /// Profil (Rechte des angemeldeten Besitzers).
    pub profile: Option<PathBuf>,
    /// Zu sichernde Ordner.
    pub folders: Vec<PathBuf>,
    /// Speichergrenze (Byte).
    pub quota: u64,
}

/// Ergebnis eines Laufs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BackupOutcome {
    /// Neu gesicherte Versionen.
    pub copied: usize,
    /// Nicht lesbare/übersprungene Dateien.
    pub skipped: usize,
    /// Hinweis (z. B. „Speicher voll“).
    pub note: String,
}

/// Zustand für die Oberfläche.
#[derive(Debug, Clone, Serialize)]
pub struct BackupState {
    /// Steht die Funktion zur Verfügung?
    pub available: bool,
    /// Eingeschaltet?
    pub enabled: bool,
    /// Speichergrenze (MiB).
    pub quota_mb: u64,
    /// Belegung.
    pub usage: Usage,
    /// Letzter Lauf (RFC 3339) und Ergebnis.
    pub last_run: Option<String>,
    /// Hinweis zum letzten Lauf.
    pub note: Option<String>,
    /// Gesicherte Ordner.
    pub folders: Vec<PathBuf>,
    /// Neueste Versionen (höchstens 300).
    pub versions: Vec<BackupVersion>,
}

fn rfc3339(t: OffsetDateTime) -> String {
    t.format(&aegis_core::time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// Sammelt die Dateien eines Ordners (ohne Links, ohne laute Ordner und Köder), höchstens
/// `max`. Im Identitätswechsel aufrufen.
fn collect(root: &Path, profile: Option<&Path>, max: usize, out: &mut Vec<(PathBuf, i64, u64)>) {
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if out.len() >= max {
                return;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_symlink() || crate::ransom::is_noisy(&path, profile) {
                continue;
            }
            if kind.is_dir() {
                if depth < 32 {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if !kind.is_file() || aegis_quarantine::bait::BAIT_NAMES.contains(&name.as_str()) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.len() > MAX_FILE {
                continue;
            }
            let modified = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX));
            out.push((path, modified, meta.len()));
        }
    }
}

/// Führt einen Lauf aus (ohne Dienst-Sperre). `access` liefert die Rechte des Besitzers.
pub fn run_job(store: &BackupStore, job: &BackupJob, access: &dyn UserAccess) -> BackupOutcome {
    let mut outcome = BackupOutcome::default();
    let owner = job.owner.as_deref();
    let mut files = Vec::new();
    {
        let Ok(_scope) = access.enter() else {
            outcome.note = "Konto nicht angemeldet – nächster Versuch später".into();
            return outcome;
        };
        for folder in &job.folders {
            collect(folder, job.profile.as_deref(), MAX_SEEN, &mut files);
        }
    }
    let mut used = match store.usage(owner) {
        Ok(u) => u.bytes,
        Err(e) => {
            outcome.note = format!("Speicher nicht lesbar: {e}");
            return outcome;
        }
    };
    for (path, modified, size) in files {
        if outcome.copied >= MAX_COPIES {
            outcome.note = "Viele Änderungen – der Rest folgt im nächsten Lauf".into();
            break;
        }
        match store.needs(owner, &path, modified, size) {
            Ok(true) => {}
            Ok(false) => continue,
            Err(_) => {
                outcome.skipped += 1;
                continue;
            }
        }
        if used.saturating_add(size) > job.quota {
            outcome.note =
                "Speichergrenze erreicht – neue Versionen werden nicht gesichert (bitte alte ausdünnen oder Grenze erhöhen)".into();
            break;
        }
        // Öffnen mit den Rechten des Besitzers (geteilt, ohne Links), schreiben als Dienst in
        // den eigenen Ordner.
        let opened = {
            let Ok(_scope) = access.enter() else {
                outcome.skipped += 1;
                continue;
            };
            aegis_engine::scan::open_regular(&path)
        };
        match opened.map_err(|e| e.to_string()).and_then(|(file, _)| {
            store
                .store(owner, &path, file, modified)
                .map_err(|e| e.to_string())
        }) {
            Ok(v) => {
                used = used.saturating_add(v.size);
                outcome.copied += 1;
            }
            Err(_) => outcome.skipped += 1,
        }
    }
    outcome
}

/// Freier Ort zum Zurückholen: der ursprüngliche, sonst „Name (Rückfallkopie <Zeit>).ext“.
fn free_target(version: &BackupVersion, profile: &Path) -> PathBuf {
    let original = &version.original;
    let parent = original
        .parent()
        .filter(|p| p.is_dir())
        .map_or_else(|| profile.join("Documents"), Path::to_path_buf);
    let name = original
        .file_name()
        .map_or_else(|| "Datei".to_owned(), |n| n.to_string_lossy().into_owned());
    let first = parent.join(&name);
    if std::fs::symlink_metadata(&first).is_err() {
        return first;
    }
    let path = Path::new(&name);
    let stem = path
        .file_stem()
        .map_or_else(|| name.clone(), |s| s.to_string_lossy().into_owned());
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let stamp: String = version
        .stored_at
        .chars()
        .take(16)
        .map(|c| if c == ':' || c == 'T' { '-' } else { c })
        .collect();
    (1..1000)
        .map(|n| {
            let suffix = if n == 1 {
                String::new()
            } else {
                format!(" {n}")
            };
            parent.join(format!("{stem} (Rueckfallkopie {stamp}{suffix}){ext}"))
        })
        .find(|p| std::fs::symlink_metadata(p).is_err())
        .unwrap_or(first)
}

impl<C: Clock, W: Durable> Service<C, W> {
    fn backup_setting(&self, owner: &Option<String>) -> Option<crate::schedule::BackupSetting> {
        self.settings
            .get()
            .backup
            .iter()
            .find(|b| b.owner == *owner)
            .cloned()
    }

    fn backup_folders(&self, owner: &Option<String>, profile: Option<&Path>) -> Vec<PathBuf> {
        let mut folders: Vec<PathBuf> = profile.map_or_else(Vec::new, |p| {
            std::iter::once("Desktop")
                .chain(crate::watch::PROTECTED_FOLDERS)
                .map(|f| p.join(f))
                .collect()
        });
        if let Some(own) = self
            .settings
            .get()
            .protected
            .iter()
            .find(|s| s.owner == *owner)
        {
            folders.extend(own.folders.iter().cloned());
        }
        folders
    }

    /// Zustand der Rückfall-Kopien des Kontos.
    pub fn backup_status(&self, user: &dyn UserAccess) -> Response {
        let owner = user.identity();
        let profile = user.profile().map(crate::watch::long_name);
        let setting = self.backup_setting(&owner);
        let (usage, versions) = match &self.backup {
            Some(store) => (
                store.usage(owner.as_deref()).unwrap_or_default(),
                store.versions(owner.as_deref(), 300).unwrap_or_default(),
            ),
            None => (Usage::default(), Vec::new()),
        };
        let last = self.backup_runs.last.get(&owner).cloned();
        Response::Backup {
            state: Box::new(BackupState {
                available: self.backup.is_some(),
                enabled: setting.is_some(),
                quota_mb: setting.as_ref().map_or(QUOTAS_MB[2], |s| s.quota_mb),
                usage,
                last_run: last.as_ref().map(|(t, _)| rfc3339(*t)),
                note: last.map(|(_, n)| n).filter(|n| !n.is_empty()),
                folders: self.backup_folders(&owner, profile.as_deref()),
                versions,
            }),
        }
    }

    /// Rückfall-Kopien einschalten (`on`, mit Grenze) bzw. ausschalten vorschlagen.
    pub fn propose_backup(&mut self, on: bool, quota_mb: u64, user: &dyn UserAccess) -> Response {
        if self.backup.is_none() {
            return Response::error("backup", "Rückfall-Kopien sind hier nicht verfügbar");
        }
        let owner = user.identity();
        let Some(profile) = user.profile().map(crate::watch::long_name) else {
            return Response::error("backup", "Kein Benutzerprofil – keine Rückfall-Kopien");
        };
        if on && !QUOTAS_MB.contains(&quota_mb) {
            return Response::error("input", "Ungültige Speichergrenze");
        }
        if !on && self.backup_setting(&owner).is_none() {
            return Response::error("backup", "Rückfall-Kopien sind nicht eingeschaltet");
        }
        let folders = self.backup_folders(&owner, Some(&profile));
        let list = folders
            .iter()
            .map(|f| f.display().to_string())
            .collect::<Vec<_>>()
            .join(", ");
        let mut builder = ActionPlan::builder(ActionKind::ChangeSetting)
            .target(Target::setting(BACKUP_SETTING))
            .parameter(
                param::VALUE,
                if on {
                    format!("on:{quota_mb}")
                } else {
                    "off".into()
                },
            );
        for f in &folders {
            builder = builder.target(Target::other(f.display().to_string()));
        }
        let builder = if on {
            builder
                .what(format!(
                    "Rückfall-Kopien einschalten (höchstens {} GiB)",
                    quota_mb / 1024
                ))
                .why("Damit die Wartezeit auf dein „Ja“ bei einem Ransomware-Angriff nicht gefährlich wird: Ältere Versionen deiner Dateien liegen dann geschützt bereit.")
                .consequence(format!(
                    "Alle {INTERVAL_MINUTES} Minuten (solange du angemeldet bist) sichert AEGIS geänderte Dateien aus {list} als neue Version – verschlüsselt im AEGIS-Ordner, auf den nur der Dienst und Administratoren zugreifen. Deine Dateien selbst werden nur gelesen. Ist die Grenze erreicht, kommt nichts mehr hinzu; gelöscht wird nie automatisch. Nach einer Ransomware-Warnung pausiert die Sicherung eine Stunde."
                ))
                .undo(UndoHint::reversible(
                    "„Rückfall-Kopien ausschalten“ beendet das Sichern; vorhandene Versionen bleiben.",
                ))
                .severity(RiskLevel::Info)
        } else {
            builder
                .what("Rückfall-Kopien ausschalten")
                .why("Von dir gewählt.")
                .consequence("Es werden keine neuen Versionen mehr gesichert. Vorhandene Versionen bleiben erhalten (Ausdünnen ist ein eigener Schritt).")
                .undo(UndoHint::reversible("Wieder einschalten."))
                .severity(RiskLevel::Info)
        };
        match builder.build(self.now()) {
            Ok(plan) => self.register(plan, owner, HashMap::new()),
            Err(e) => Response::error("plan", e.to_string()),
        }
    }

    /// Führt „Rückfall-Kopien ein/aus“ aus (nur die Einstellung).
    pub(super) fn apply_backup_setting(
        &mut self,
        permit: ExecutionPermit,
        user: &dyn UserAccess,
    ) -> Response {
        let value = permit
            .plan()
            .parameter(param::VALUE)
            .unwrap_or_default()
            .to_owned();
        let owner = user.identity();
        let profile = user.profile().map(crate::watch::long_name);
        let quota = value
            .strip_prefix("on:")
            .and_then(|q| q.parse::<u64>().ok())
            .filter(|q| QUOTAS_MB.contains(q));
        let since = rfc3339(self.now());
        let saved = self.settings.update(|s| {
            s.backup.retain(|b| b.owner != owner);
            if let Some(quota_mb) = quota {
                s.backup.push(crate::schedule::BackupSetting {
                    owner: owner.clone(),
                    profile: profile.clone(),
                    quota_mb,
                    since,
                });
            }
        });
        // Erster Lauf bald nach dem Einschalten.
        self.backup_runs.started.remove(&owner);
        self.backup_runs.last.remove(&owner);
        let result = match (&saved, quota.is_some() || value == "off") {
            (Ok(()), true) => ExecutionResult::Succeeded,
            (Err(e), _) => ExecutionResult::Failed {
                message: format!("Einstellung nicht gespeichert: {e}"),
            },
            (_, false) => ExecutionResult::Failed {
                message: "Ungültiger Wert".into(),
            },
        };
        self.finish_plan(permit, &result, user, None);
        Response::Executed {
            kind: ActionKind::ChangeSetting,
            result,
            entries: Vec::new(),
            failures: Vec::new(),
        }
    }

    /// Schlägt vor, eine Version zurückzuholen (neu angelegt, nie überschrieben).
    pub fn propose_backup_restore(&mut self, id: &str, user: &dyn UserAccess) -> Response {
        let Some(store) = &self.backup else {
            return Response::error("backup", "Rückfall-Kopien sind hier nicht verfügbar");
        };
        let Some(profile) = user.profile().map(crate::watch::long_name) else {
            return Response::error("backup", "Kein Benutzerprofil");
        };
        let owner = user.identity();
        let version = match store.version(owner.as_deref(), id) {
            Ok(v) => v,
            Err(e) => return Response::error("unknown", e.to_string()),
        };
        let target = {
            let Ok(_scope) = user.enter() else {
                return Response::error("identity", "Rechte des Nutzers nicht übernehmbar");
            };
            free_target(&version, &profile)
        };
        let plan = ActionPlan::builder(ActionKind::RestoreBackup)
            .target(Target::file(&target))
            .parameter(param::BACKUP_ENTRY, &version.id)
            .what(format!(
                "Rückfall-Kopie zurückholen: {} (Stand {})",
                super::quoted(&version.original.display().to_string()),
                version.stored_at
            ))
            .why("Von dir gewählt – z. B. weil die aktuelle Datei verschlüsselt oder beschädigt ist.")
            .consequence(format!(
                "Die Version wird entschlüsselt, geprüft (SHA-256) und neu angelegt: {}. Es wird nichts überschrieben; die Kopie bleibt im Speicher.",
                target.display()
            ))
            .undo(UndoHint::reversible("Die neu angelegte Datei kannst du jederzeit selbst löschen."))
            .severity(RiskLevel::Info)
            .build(self.now());
        match plan {
            Ok(plan) => self.register(plan, owner, HashMap::new()),
            Err(e) => Response::error("plan", e.to_string()),
        }
    }

    /// Führt „Rückfall-Kopie zurückholen“ aus.
    pub(super) fn apply_backup_restore(
        &mut self,
        permit: ExecutionPermit,
        user: &dyn UserAccess,
    ) -> Response {
        let outcome = match &self.backup {
            Some(store) => store.restore(&permit, user),
            None => Err("Rückfall-Kopien sind hier nicht verfügbar".into()),
        };
        let (result, failures) = match &outcome {
            Ok(_) => (ExecutionResult::Succeeded, Vec::new()),
            Err(m) => (
                ExecutionResult::Failed { message: m.clone() },
                permit
                    .plan()
                    .targets()
                    .iter()
                    .filter_map(|t| match t {
                        Target::File { path } => Some((path.clone(), m.clone())),
                        _ => None,
                    })
                    .collect(),
            ),
        };
        self.finish_plan(permit, &result, user, outcome.err());
        Response::Executed {
            kind: ActionKind::RestoreBackup,
            result,
            entries: Vec::new(),
            failures,
        }
    }

    /// Schlägt vor, die neuesten Versionen in einen Ordner zu exportieren (Pfad bereits lang
    /// geschrieben und geprüft).
    pub fn propose_backup_export(&mut self, dest: &Path, user: &dyn UserAccess) -> Response {
        let Some(store) = &self.backup else {
            return Response::error("backup", "Rückfall-Kopien sind hier nicht verfügbar");
        };
        let owner = user.identity();
        let usage = store.usage(owner.as_deref()).unwrap_or_default();
        if usage.files == 0 {
            return Response::error("backup", "Es gibt noch keine Rückfall-Kopien");
        }
        {
            let Ok(_scope) = user.enter() else {
                return Response::error("identity", "Rechte des Nutzers nicht übernehmbar");
            };
            if !std::fs::symlink_metadata(dest).is_ok_and(|m| m.is_dir()) {
                return Response::error("input", "Bitte einen Ordner wählen");
            }
        }
        let plan = ActionPlan::builder(ActionKind::ExportBackup)
            .target(Target::file(dest))
            .what(format!(
                "Rückfall-Kopien exportieren: neueste Version von {} Datei(en)",
                usage.files
            ))
            .why("Von dir gewählt – z. B. als zusätzliche Sicherung auf einem externen Laufwerk.")
            .consequence(format!(
                "In {} entsteht ein neuer Ordner „AEGIS-Rueckfallkopien <Datum>“ mit normalen (unverschlüsselten) Kopien. Es wird nichts überschrieben. Tipp: Laufwerk danach abziehen – dann erreicht es keine Ransomware.",
                dest.display()
            ))
            .undo(UndoHint::reversible("Den neuen Ordner kannst du jederzeit selbst löschen."))
            .severity(RiskLevel::Info)
            .build(self.now());
        match plan {
            Ok(plan) => self.register(plan, owner, HashMap::new()),
            Err(e) => Response::error("plan", e.to_string()),
        }
    }

    /// Führt den Export aus.
    pub(super) fn apply_backup_export(
        &mut self,
        permit: ExecutionPermit,
        user: &dyn UserAccess,
    ) -> Response {
        let outcome = match &self.backup {
            Some(store) => store.export(&permit, user),
            None => Err("Rückfall-Kopien sind hier nicht verfügbar".into()),
        };
        let (result, detail) = match &outcome {
            Ok((folder, written, 0)) => (
                ExecutionResult::Succeeded,
                format!("{written} Datei(en) nach {}", folder.display()),
            ),
            Ok((folder, written, failed)) => (
                if *written > 0 {
                    ExecutionResult::PartiallySucceeded {
                        message: format!("{failed} Datei(en) nicht möglich"),
                    }
                } else {
                    ExecutionResult::Failed {
                        message: format!("{failed} Datei(en) nicht möglich"),
                    }
                },
                format!("{written} Datei(en) nach {}", folder.display()),
            ),
            Err(m) => (ExecutionResult::Failed { message: m.clone() }, m.clone()),
        };
        self.finish_plan(permit, &result, user, Some(detail));
        Response::Executed {
            kind: ActionKind::ExportBackup,
            result,
            entries: Vec::new(),
            failures: Vec::new(),
        }
    }

    /// Schlägt vor, Versionen älter als `days` Tage zu löschen (zweite Bestätigung; die
    /// neueste Version jeder Datei bleibt).
    pub fn propose_backup_prune(&mut self, days: u32, user: &dyn UserAccess) -> Response {
        let Some(store_dir) = self.backup_dir.clone() else {
            return Response::error("backup", "Rückfall-Kopien sind hier nicht verfügbar");
        };
        if !PRUNE_DAYS.contains(&days) {
            return Response::error("input", "Ungültige Frist");
        }
        let before = self.now() - Duration::days(i64::from(days));
        let plan = ActionPlan::builder(ActionKind::DeletePermanently)
            .target(Target::file(&store_dir))
            .parameter(param::BACKUP_BEFORE, rfc3339(before))
            .what(format!("Rückfall-Kopien ausdünnen: Versionen älter als {days} Tage endgültig löschen"))
            .why("Von dir gewählt – z. B. weil die Speichergrenze erreicht ist.")
            .consequence("Ältere Versionen deiner Dateien werden aus dem AEGIS-Speicher gelöscht. Die jeweils neueste Version jeder Datei bleibt immer erhalten. Deine eigentlichen Dateien bleiben unberührt.")
            .undo(UndoHint::irreversible("Gelöschte Versionen lassen sich nicht wiederherstellen."))
            .severity(RiskLevel::Info)
            .build(self.now());
        match plan {
            Ok(plan) => self.register(plan, user.identity(), HashMap::new()),
            Err(e) => Response::error("plan", e.to_string()),
        }
    }

    /// Führt das Ausdünnen nach der zweiten Bestätigung aus.
    pub(super) fn apply_backup_prune(
        &mut self,
        permit: ExecutionPermit,
        user: &dyn UserAccess,
    ) -> Response {
        let owner = user.identity();
        let outcome = match &self.backup {
            Some(store) => store.prune(&permit, owner.as_deref()),
            None => Err("Rückfall-Kopien sind hier nicht verfügbar".into()),
        };
        let result = match &outcome {
            Ok(_) => ExecutionResult::Succeeded,
            Err(m) => ExecutionResult::Failed { message: m.clone() },
        };
        let detail = outcome
            .as_ref()
            .map_or_else(Clone::clone, |n| format!("{n} Versionen gelöscht"));
        self.finish_plan(permit, &result, user, Some(detail));
        Response::Executed {
            kind: ActionKind::DeletePermanently,
            result,
            entries: Vec::new(),
            failures: Vec::new(),
        }
    }

    /// Fällige Läufe (Zeitplaner); markiert sie als gestartet.
    pub fn take_due_backups(&mut self) -> Vec<BackupJob> {
        if self.backup.is_none() {
            return Vec::new();
        }
        let now = self.now();
        let settings: Vec<crate::schedule::BackupSetting> = self.settings.get().backup.clone();
        let mut jobs = Vec::new();
        for s in settings {
            let due = self
                .backup_runs
                .started
                .get(&s.owner)
                .is_none_or(|t| now - *t >= Duration::minutes(INTERVAL_MINUTES));
            let paused = self.watch.ransom_alert_within(
                s.profile.as_deref(),
                std::time::Duration::from_secs(PAUSE_AFTER_ALERT_MINUTES * 60),
            );
            if !due {
                continue;
            }
            self.backup_runs.started.insert(s.owner.clone(), now);
            if paused {
                self.backup_runs.last.insert(
                    s.owner.clone(),
                    (
                        now,
                        "Pausiert nach einer Ransomware-Warnung (eine Stunde)".into(),
                    ),
                );
                continue;
            }
            jobs.push(BackupJob {
                folders: self.backup_folders(&s.owner, s.profile.as_deref()),
                owner: s.owner,
                profile: s.profile,
                quota: s.quota_mb.saturating_mul(1024 * 1024),
            });
        }
        jobs
    }

    /// Ergebnis eines Laufs (Verlauf + Zustand).
    pub fn record_backup(&mut self, job: &BackupJob, outcome: &BackupOutcome) {
        let now = self.now();
        self.backup_runs
            .last
            .insert(job.owner.clone(), (now, outcome.note.clone()));
        if outcome.copied > 0 || !outcome.note.is_empty() {
            self.add_history(NewEntry {
                kind: HistoryKind::Action,
                risk: None,
                title: format!("Rückfall-Kopien: {} Version(en) gesichert", outcome.copied),
                detail: if outcome.note.is_empty() {
                    format!("{} Datei(en) übersprungen", outcome.skipped)
                } else {
                    outcome.note.clone()
                },
                paths: Vec::new(),
                owner: job.owner.clone(),
                scope: job.profile.clone(),
            });
        }
    }

    /// Der Speicher (für den Zeitplaner).
    #[must_use]
    pub fn backup_store(&self) -> Option<std::sync::Arc<BackupStore>> {
        self.backup.clone()
    }

    fn finish_plan(
        &mut self,
        permit: ExecutionPermit,
        result: &ExecutionResult,
        user: &dyn UserAccess,
        detail: Option<String>,
    ) {
        let what = permit.plan().what().to_owned();
        let event = permit.complete(result.clone());
        self.record(event);
        if self.audit.sync().is_err() {
            self.audit_failed = true;
        }
        let state = match result {
            ExecutionResult::Succeeded => "erledigt",
            ExecutionResult::PartiallySucceeded { .. } => "teilweise erledigt",
            _ => "nicht möglich",
        };
        self.add_history(NewEntry {
            kind: HistoryKind::Action,
            risk: None,
            title: format!("{what} – {state}"),
            detail: detail.unwrap_or_default(),
            paths: Vec::new(),
            owner: user.identity(),
            scope: user.profile(),
        });
    }
}
