//! Datei-Safe im Dienst (P5): Anlegen, Entsperren, Hineinlegen und Herausholen.
//!
//! - Das Passwort kommt nur über die Pipe, wird sofort zu einem Schlüssel abgeleitet und nie
//!   gespeichert – weder im Plan noch im Prüfprotokoll oder Verlauf.
//! - Der entsperrte Schlüssel liegt nur im Speicher des Dienstes, je Konto, und verfällt nach
//!   [`IDLE_MINUTES`] ohne Nutzung (oder bei „Sperren“, Neustart des Dienstes).
//! - Anlegen, Hineinlegen und Herausholen sind Pläne mit „Ja, ausführen“; der Dienst
//!   formuliert sie selbst. Ist der Safe bei der Ausführung gesperrt, passiert nichts.
//! - Falsche Passwörter: nach [`MAX_FAILURES`] Fehlversuchen wartet der Dienst
//!   [`LOCKOUT_SECONDS`] Sekunden, bevor er wieder prüft.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use aegis_core::audit::{AuditEvent, Durable, ExecutionResult};
use aegis_core::consent::{Clock, ExecutionPermit};
use aegis_core::plan::{ActionKind, ActionPlan, PlanId, Target, UndoHint, param};
use aegis_core::risk::RiskLevel;
use aegis_core::time::{Duration, OffsetDateTime};
use aegis_quarantine::UserAccess;
use aegis_quarantine::crypto::Key;
use aegis_quarantine::safe::{self, MIN_PASSWORD, Prepared, SAFE_SETTING};

use super::Service;
use crate::history::{HistoryKind, NewEntry};
use crate::protocol::{Password, Response};

/// Nach so vielen Minuten ohne Nutzung wird der Safe gesperrt.
pub const IDLE_MINUTES: u32 = 10;
/// Fehlversuche, bevor der Dienst eine Pause einlegt.
pub const MAX_FAILURES: u32 = 5;
/// Pause nach zu vielen Fehlversuchen.
pub const LOCKOUT_SECONDS: i64 = 60;

struct Unlocked {
    key: Key,
    last_used: OffsetDateTime,
}

/// Zustand des Safes im Dienst (nur im Speicher).
#[derive(Default)]
pub(super) struct SafeState {
    keys: HashMap<Option<String>, Unlocked>,
    /// Vorbereitete Safes je Vorschlag („Datei-Safe anlegen“) – nie im Plan.
    pending: HashMap<PlanId, (Option<String>, Prepared)>,
    failures: HashMap<Option<String>, (u32, OffsetDateTime)>,
    /// Konten, für die gerade eine Schlüssel-Ableitung läuft.
    deriving: HashMap<Option<String>, OffsetDateTime>,
}

impl SafeState {
    /// Abgelaufene Schlüssel und Vorbereitungen verwerfen.
    pub(super) fn expire(&mut self, now: OffsetDateTime, open: &dyn Fn(&PlanId) -> bool) {
        self.keys
            .retain(|_, u| now - u.last_used < Duration::minutes(i64::from(IDLE_MINUTES)));
        self.pending.retain(|id, _| open(id));
        self.failures
            .retain(|_, (_, at)| now - *at < Duration::seconds(LOCKOUT_SECONDS * 10));
        // Eine abgebrochene Verbindung darf das Konto nicht dauerhaft sperren.
        self.deriving
            .retain(|_, started| now - *started < Duration::minutes(2));
    }

    fn key(&mut self, owner: &Option<String>, now: OffsetDateTime) -> Option<Key> {
        let unlocked = self.keys.get_mut(owner)?;
        unlocked.last_used = now;
        Some(unlocked.key.clone())
    }
}

fn safe_dir_of(user: &dyn UserAccess) -> Result<PathBuf, Response> {
    user.profile()
        .map(|p| safe::safe_dir(&crate::watch::long_name(p)))
        .ok_or_else(|| Response::error("safe", "Kein Benutzerprofil – kein Datei-Safe möglich"))
}

fn exists_as_user(user: &dyn UserAccess, dir: &Path) -> Result<bool, Response> {
    let _scope = user
        .enter()
        .map_err(|e| Response::error("identity", format!("Rechte des Nutzers: {e}")))?;
    Ok(safe::exists(dir))
}

fn locked() -> Response {
    Response::error(
        "locked",
        "Der Datei-Safe ist gesperrt – bitte zuerst mit dem Passwort entsperren",
    )
}

/// Freies Ziel zum Herausholen: der ursprüngliche Ort, sonst „Name (aus dem Safe N).ext“ im
/// selben Ordner; fehlt der Ordner, in „Dokumente“ des Profils.
fn free_target(entry: &safe::SafeEntry, profile: &Path) -> PathBuf {
    let original = &entry.original_path;
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
    (1..1000)
        .map(|n| {
            let suffix = if n == 1 {
                String::new()
            } else {
                format!(" {n}")
            };
            parent.join(format!("{stem} (aus dem Safe{suffix}){ext}"))
        })
        .find(|p| std::fs::symlink_metadata(p).is_err())
        .unwrap_or(first)
}

impl<C: Clock, W: Durable> Service<C, W> {
    fn now(&self) -> OffsetDateTime {
        self.gate.clock().now()
    }

    /// Zustand des eigenen Safes (Einträge nur, wenn entsperrt).
    pub fn safe_status(&mut self, user: &dyn UserAccess) -> Response {
        let dir = match safe_dir_of(user) {
            Ok(d) => d,
            Err(e) => return e,
        };
        let exists = match exists_as_user(user, &dir) {
            Ok(e) => e,
            Err(e) => return e,
        };
        let owner = user.identity();
        let now = self.now();
        let key = if exists {
            self.safe.key(&owner, now)
        } else {
            None
        };
        let entries = match &key {
            Some(key) => match safe::list(user, &dir, key) {
                Ok(e) => e,
                Err(e) => return Response::error("safe", e),
            },
            None => Vec::new(),
        };
        Response::Safe {
            exists,
            unlocked: key.is_some(),
            entries,
            min_password: MIN_PASSWORD,
            idle_minutes: IDLE_MINUTES,
        }
    }

    /// Schritt 1 von „Datei-Safe anlegen“ (unter der Dienst-Sperre, schnell): Ort, „gibt es
    /// schon“, Grenzen für Vorschläge, keine zweite Ableitung desselben Kontos gleichzeitig.
    /// Die teure Schlüssel-Ableitung läuft danach **ohne** Sperre ([`safe::prepare`]).
    ///
    /// # Errors
    /// Antwort an die Oberfläche, wenn nichts abzuleiten ist.
    pub fn safe_setup_begin(&mut self, user: &dyn UserAccess) -> Result<PathBuf, Response> {
        let dir = safe_dir_of(user)?;
        if exists_as_user(user, &dir)? {
            return Err(Response::error("safe", "Es gibt schon einen Datei-Safe"));
        }
        if let Some(busy) = self.proposal_limit(&user.identity()) {
            return Err(busy);
        }
        self.safe_kdf_begin(user)?;
        Ok(dir)
    }

    /// Schritt 2 von „Datei-Safe anlegen“: Plan vorschlagen; der vorbereitete Schlüssel
    /// bleibt bis zur Antwort nur im Speicher.
    pub fn safe_setup_finish(
        &mut self,
        user: &dyn UserAccess,
        dir: &Path,
        prepared: safe::SafeResult<Prepared>,
    ) -> Response {
        self.safe.deriving.remove(&user.identity());
        let prepared = match prepared {
            Ok(p) => p,
            Err(e) => return Response::error("password", e),
        };
        let plan = ActionPlan::builder(ActionKind::ChangeSetting)
            .target(Target::setting(SAFE_SETTING))
            .target(Target::other(dir.display().to_string()))
            .parameter(param::VALUE, "on")
            .what("Datei-Safe anlegen")
            .why("Von dir gewählt: Dateien sollen nur mit deinem Passwort lesbar sein.")
            .consequence(format!(
                "Ein neuer Ordner entsteht: {}. Darin liegt nur der verschlüsselte Schlüssel (Argon2id + AES-256-GCM). Das Passwort wird nirgends gespeichert – vergisst du es, kann niemand die Dateien im Safe zurückholen, auch AEGIS nicht.",
                dir.display()
            ))
            .undo(UndoHint::reversible(
                "Der leere Safe-Ordner kann gelöscht werden; Dateien im Safe vorher herausholen.",
            ))
            .severity(RiskLevel::Info)
            .build(self.now());
        let plan = match plan {
            Ok(p) => p,
            Err(e) => return Response::error("plan", e.to_string()),
        };
        let owner = user.identity();
        let id = plan.id();
        let response = self.register(plan, owner.clone(), HashMap::new());
        if matches!(response, Response::Proposal { .. }) {
            self.safe.pending.insert(id, (owner, prepared));
        }
        response
    }

    /// Schlägt vor, den Safe anzulegen (alle Schritte nacheinander – ohne Pipe, z. B. Tests).
    pub fn propose_safe_create(&mut self, password: &Password, user: &dyn UserAccess) -> Response {
        match self.safe_setup_begin(user) {
            Ok(dir) => {
                let prepared = safe::prepare(password.expose());
                self.safe_setup_finish(user, &dir, prepared)
            }
            Err(e) => e,
        }
    }

    /// Je Konto höchstens eine Ableitung gleichzeitig (sonst umgingen parallele Versuche die
    /// Pause nach Fehlversuchen).
    fn safe_kdf_begin(&mut self, user: &dyn UserAccess) -> Result<(), Response> {
        let now = self.now();
        if let std::collections::hash_map::Entry::Vacant(slot) =
            self.safe.deriving.entry(user.identity())
        {
            slot.insert(now);
            Ok(())
        } else {
            Err(Response::error(
                "wait",
                "Es läuft schon eine Prüfung des Passworts – bitte kurz warten",
            ))
        }
    }

    /// Schritt 1 von „Entsperren“ (unter der Sperre, schnell): Pause nach Fehlversuchen,
    /// Safe vorhanden. Die Ableitung läuft danach ohne Sperre ([`safe::unlock`]).
    ///
    /// # Errors
    /// Antwort an die Oberfläche, wenn nichts abzuleiten ist.
    pub fn safe_unlock_begin(&mut self, user: &dyn UserAccess) -> Result<PathBuf, Response> {
        let owner = user.identity();
        let now = self.now();
        if let Some((count, at)) = self.safe.failures.get(&owner) {
            let wait = Duration::seconds(LOCKOUT_SECONDS) - (now - *at);
            if *count >= MAX_FAILURES && wait > Duration::ZERO {
                return Err(Response::error(
                    "wait",
                    format!(
                        "Zu viele Fehlversuche – bitte {} s warten",
                        wait.whole_seconds().max(1)
                    ),
                ));
            }
        }
        let dir = safe_dir_of(user)?;
        if !exists_as_user(user, &dir)? {
            return Err(Response::error("safe", "Es gibt noch keinen Datei-Safe"));
        }
        self.safe_kdf_begin(user)?;
        Ok(dir)
    }

    /// Schritt 2 von „Entsperren“: Schlüssel merken bzw. Fehlversuch zählen (nur ein falsches
    /// Passwort zählt).
    pub fn safe_unlock_finish(
        &mut self,
        user: &dyn UserAccess,
        result: safe::SafeResult<Key>,
    ) -> Response {
        let owner = user.identity();
        let now = self.now();
        self.safe.deriving.remove(&owner);
        match result {
            Ok(key) => {
                self.safe.failures.remove(&owner);
                self.safe.keys.insert(
                    owner,
                    Unlocked {
                        key,
                        last_used: now,
                    },
                );
                self.safe_status(user)
            }
            Err(e) if e == safe::WRONG_PASSWORD => {
                let entry = self.safe.failures.entry(owner).or_insert((0, now));
                entry.0 = if entry.0 >= MAX_FAILURES {
                    1
                } else {
                    entry.0 + 1
                };
                entry.1 = now;
                Response::error("password", e)
            }
            Err(e) => Response::error("safe", e),
        }
    }

    /// Entsperrt den eigenen Safe (alle Schritte nacheinander – ohne Pipe, z. B. Tests).
    pub fn safe_unlock(&mut self, password: &Password, user: &dyn UserAccess) -> Response {
        match self.safe_unlock_begin(user) {
            Ok(dir) => {
                let result = safe::unlock(user, &dir, password.expose());
                self.safe_unlock_finish(user, result)
            }
            Err(e) => e,
        }
    }

    /// Sperrt den eigenen Safe (Schlüssel verworfen).
    pub fn safe_lock(&mut self, user: &dyn UserAccess) -> Response {
        self.safe.keys.remove(&user.identity());
        self.safe_status(user)
    }

    /// Schlägt vor, Dateien in den Safe zu legen (Pfade bereits lang geschrieben).
    pub fn propose_safe_store(&mut self, paths: &[PathBuf], user: &dyn UserAccess) -> Response {
        if paths.is_empty() {
            return Response::error("input", "Keine Datei ausgewählt");
        }
        if let Err(e) = self.check_paths(paths) {
            return Response::error("input", e);
        }
        let dir = match safe_dir_of(user) {
            Ok(d) => d,
            Err(e) => return e,
        };
        if paths.iter().any(|p| crate::paths::is_within(p, &dir)) {
            return Response::error("input", "Diese Datei liegt schon im Datei-Safe");
        }
        let owner = user.identity();
        let now = self.now();
        if self.safe.key(&owner, now).is_none() {
            return locked();
        }
        let names = paths
            .iter()
            .take(5)
            .map(|p| {
                super::quoted(&p.file_name().map_or_else(
                    || p.display().to_string(),
                    |n| n.to_string_lossy().into_owned(),
                ))
            })
            .collect::<Vec<_>>()
            .join(", ");
        let more = if paths.len() > 5 {
            format!(" und {} weitere", paths.len() - 5)
        } else {
            String::new()
        };
        let mut builder = ActionPlan::builder(ActionKind::SafeStore)
            .what(format!("{} Datei(en) in den Datei-Safe legen: {names}{more}", paths.len()))
            .why("Von dir gewählt: Diese Dateien sollen nur mit deinem Passwort lesbar sein.")
            .consequence("Jede Datei wird verschlüsselt in den Safe kopiert und die Kopie geprüft; erst dann wird das Original entfernt. Danach ist sie nur über AEGIS mit deinem Passwort lesbar.")
            .undo(UndoHint::reversible(
                "„Herausholen“ legt jede Datei wieder an ihren ursprünglichen Ort (überschreibt nichts).",
            ))
            .severity(RiskLevel::Info);
        for p in paths {
            builder = builder.target(Target::file(p));
        }
        match builder.build(now) {
            Ok(plan) => self.register(plan, owner, HashMap::new()),
            Err(e) => Response::error("plan", e.to_string()),
        }
    }

    /// Schlägt vor, einen Eintrag aus dem Safe zu holen.
    pub fn propose_safe_retrieve(&mut self, id: &str, user: &dyn UserAccess) -> Response {
        let (dir, profile) = match (safe_dir_of(user), user.profile()) {
            (Ok(d), Some(p)) => (d, crate::watch::long_name(p)),
            (Err(e), _) => return e,
            (_, None) => {
                return Response::error("safe", "Kein Benutzerprofil – kein Datei-Safe möglich");
            }
        };
        let owner = user.identity();
        let now = self.now();
        let Some(key) = self.safe.key(&owner, now) else {
            return locked();
        };
        let entries = match safe::list(user, &dir, &key) {
            Ok(e) => e,
            Err(e) => return Response::error("safe", e),
        };
        let Some(entry) = entries.into_iter().find(|e| e.id == id) else {
            return Response::error("unknown", "Eintrag nicht im Datei-Safe");
        };
        let target = {
            let _scope = match user.enter() {
                Ok(s) => s,
                Err(e) => {
                    return Response::error("identity", format!("Rechte des Nutzers: {e}"));
                }
            };
            free_target(&entry, &profile)
        };
        let moved = if target == entry.original_path {
            String::new()
        } else {
            " Am ursprünglichen Ort liegt inzwischen etwas anderes – es wird nichts überschrieben, daher ein neuer Name.".to_owned()
        };
        let plan = ActionPlan::builder(ActionKind::SafeRetrieve)
            .target(Target::file(&target))
            .parameter(param::SAFE_ENTRY, &entry.id)
            .what(format!(
                "Aus dem Datei-Safe holen: {}",
                super::quoted(&entry.original_path.display().to_string())
            ))
            .why("Von dir gewählt.")
            .consequence(format!(
                "Die Datei wird entschlüsselt, geprüft (SHA-256) und neu angelegt: {}.{moved} Danach wird sie aus dem Safe entfernt.",
                target.display()
            ))
            .undo(UndoHint::reversible(
                "Die Datei kann jederzeit wieder in den Safe gelegt werden.",
            ))
            .severity(RiskLevel::Info)
            .build(now);
        match plan {
            Ok(plan) => self.register(plan, owner, HashMap::new()),
            Err(e) => Response::error("plan", e.to_string()),
        }
    }

    /// Führt „Datei-Safe anlegen“ aus.
    pub(super) fn apply_safe_create(
        &mut self,
        permit: ExecutionPermit,
        user: &dyn UserAccess,
    ) -> Response {
        let plan = permit.plan().clone();
        let owner = user.identity();
        let prepared = self
            .safe
            .pending
            .remove(&plan.id())
            .filter(|(o, _)| *o == owner)
            .map(|(_, p)| p);
        let outcome = match &prepared {
            Some(p) => safe::create(&permit, user, p),
            None => Err("Vorbereitung abgelaufen – bitte neu anlegen".to_owned()),
        };
        if let (Ok(()), Some(p)) = (&outcome, prepared) {
            self.safe.keys.insert(
                owner.clone(),
                Unlocked {
                    key: p.key(),
                    last_used: self.now(),
                },
            );
        }
        let result = match &outcome {
            Ok(()) => ExecutionResult::Succeeded,
            Err(message) => ExecutionResult::Failed {
                message: message.clone(),
            },
        };
        self.finish(permit, &result, owner, user, Vec::new(), outcome.err());
        Response::Executed {
            kind: ActionKind::ChangeSetting,
            result,
            entries: Vec::new(),
            failures: Vec::new(),
        }
    }

    /// Führt „In den Datei-Safe legen“ aus.
    pub(super) fn apply_safe_store(
        &mut self,
        permit: ExecutionPermit,
        user: &dyn UserAccess,
    ) -> Response {
        let owner = user.identity();
        let now = self.now();
        let (dir, key) = match (safe_dir_of(user), self.safe.key(&owner, now)) {
            (Ok(dir), Some(key)) => (dir, key),
            (Err(e), _) => {
                self.fail(permit, "Kein Benutzerprofil");
                return e;
            }
            (_, None) => {
                self.fail(permit, "Datei-Safe gesperrt");
                return locked();
            }
        };
        let results = match safe::store(&permit, user, &dir, &key) {
            Ok(r) => r,
            Err(message) => {
                self.fail(permit, &message);
                return Response::error("safe", format!("{message} – nichts verändert"));
            }
        };
        let ok: Vec<PathBuf> = results
            .iter()
            .filter(|(_, r)| r.is_ok())
            .map(|(p, _)| p.clone())
            .collect();
        let failures: Vec<(PathBuf, String)> = results
            .into_iter()
            .filter_map(|(p, r)| r.err().map(|e| (p, e)))
            .collect();
        let result = summarize(ok.len(), &failures);
        // Im Verlauf nur Anzahlen – Namen gehören in den Safe (das Prüfprotokoll enthält den
        // Plan, siehe SECURITY.md).
        let detail = format!(
            "{} hineingelegt, {} nicht möglich",
            ok.len(),
            failures.len()
        );
        self.finish(permit, &result, owner, user, Vec::new(), Some(detail));
        Response::Executed {
            kind: ActionKind::SafeStore,
            result,
            entries: Vec::new(),
            failures,
        }
    }

    /// Führt „Aus dem Datei-Safe holen“ aus.
    pub(super) fn apply_safe_retrieve(
        &mut self,
        permit: ExecutionPermit,
        user: &dyn UserAccess,
    ) -> Response {
        let owner = user.identity();
        let now = self.now();
        let (dir, key) = match (safe_dir_of(user), self.safe.key(&owner, now)) {
            (Ok(dir), Some(key)) => (dir, key),
            (Err(e), _) => {
                self.fail(permit, "Kein Benutzerprofil");
                return e;
            }
            (_, None) => {
                self.fail(permit, "Datei-Safe gesperrt");
                return locked();
            }
        };
        let outcome = safe::retrieve(&permit, user, &dir, &key);
        let target = permit.plan().targets().iter().find_map(|t| match t {
            Target::File { path } => Some(path.clone()),
            _ => None,
        });
        let (result, failures) = match &outcome {
            Ok(_) => (ExecutionResult::Succeeded, Vec::new()),
            Err(message) => (
                ExecutionResult::Failed {
                    message: message.clone(),
                },
                target
                    .iter()
                    .map(|p| (p.clone(), message.clone()))
                    .collect(),
            ),
        };
        self.finish(permit, &result, owner, user, Vec::new(), outcome.err());
        Response::Executed {
            kind: ActionKind::SafeRetrieve,
            result,
            entries: Vec::new(),
            failures,
        }
    }

    fn fail(&mut self, permit: ExecutionPermit, message: &str) {
        let event = permit.complete(ExecutionResult::Failed {
            message: message.to_owned(),
        });
        self.record_synced(event);
    }

    fn record_synced(&mut self, event: AuditEvent) {
        self.record(event);
        if self.audit.sync().is_err() {
            self.audit_failed = true;
        }
    }

    fn finish(
        &mut self,
        permit: ExecutionPermit,
        result: &ExecutionResult,
        owner: Option<String>,
        user: &dyn UserAccess,
        paths: Vec<PathBuf>,
        detail: Option<String>,
    ) {
        let what = permit.plan().what().to_owned();
        let event = permit.complete(result.clone());
        self.record_synced(event);
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
            paths,
            owner,
            scope: user.profile(),
        });
    }
}

fn summarize(ok: usize, failures: &[(PathBuf, String)]) -> ExecutionResult {
    if failures.is_empty() {
        ExecutionResult::Succeeded
    } else if ok > 0 {
        ExecutionResult::PartiallySucceeded {
            message: format!("{} Datei(en) nicht möglich", failures.len()),
        }
    } else {
        ExecutionResult::Failed {
            message: failures
                .first()
                .map_or_else(String::new, |(_, e)| e.clone()),
        }
    }
}
