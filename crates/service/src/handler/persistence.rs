//! Persistenz-Check (P6.3): Autostart-Einträge lesen, bewerten (Text-Merkmale + Prüfung der
//! Programmdateien im Prüfprozess mit den Rechten des Nutzers) und – nur per Plan mit „Ja“ –
//! deaktivieren. Deaktivieren merkt den alten Stand („Rückgängig“ wie bei der Härtung).
//!
//! - Gelesen werden Systemorte als Dienst (nur lesend), Nutzerordner (Autostart-Ordner,
//!   Browser-Erweiterungen) mit den Rechten des Kontos.
//! - Deaktivieren: Run-Werte entfernen, geplante Aufgaben abschalten, Dienste auf „Deaktiviert“,
//!   IFEO-`Debugger` entfernen, `AppInit_DLLs` nicht mehr laden. Dateien im Autostart-Ordner
//!   werden über die Quarantäne isoliert (eigener Plan). Winlogon, WMI-Abos, COM-Einträge und
//!   Browser-Erweiterungen werden nur erklärt.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use aegis_core::audit::Durable;
use aegis_core::consent::Clock;
use aegis_core::plan::{ActionKind, ActionPlan, Target, UndoHint, param};
use aegis_core::risk::RiskLevel;
use aegis_engine::Finding;
use aegis_hardening::persistence::{Autorun, AutorunKind, Flag, assess};
use aegis_quarantine::UserAccess;
use serde::Serialize;

use super::Service;
use super::harden::{Place, Raw, Step};
use crate::emergency::{PathEnv, command_paths};
use crate::protocol::Response;
use crate::worker::Scanner;

/// Einstellung „Autostart-Eintrag deaktivieren“ (Wert: `<Art>:<Kennung>`).
pub const AUTORUN_SETTING: &str = "hardening.autorun";
/// Höchstzahl geprüfter Programmdateien je Durchlauf.
const MAX_FILES: usize = 400;
/// Höchstzahl Browser-Erweiterungen.
const MAX_EXTENSIONS: usize = 300;

/// Begründung (Deutsch, Englisch).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Reason {
    /// Deutsch.
    pub de: String,
    /// Englisch.
    pub en: String,
}

/// Ein bewerteter Autostart-Eintrag.
#[derive(Debug, Clone, Serialize)]
pub struct AutorunView {
    /// Eintrag.
    #[serde(flatten)]
    pub entry: Autorun,
    /// Gesamtrisiko.
    pub risk: RiskLevel,
    /// Begründungen.
    pub reasons: Vec<Reason>,
    /// Programmdatei (falls auflösbar).
    pub file: Option<PathBuf>,
    /// Programmdatei fehlt (Überbleibsel).
    pub missing: bool,
    /// Ergebnis der Prüfung der Programmdatei (wenn auffällig).
    pub finding: Option<Finding>,
    /// Möglicher Schritt: `disable` (Plan) oder `quarantine` (Datei im Autostart-Ordner).
    pub action: Option<&'static str>,
}

/// Zustand für die Oberfläche.
#[derive(Debug, Clone, Serialize)]
pub struct PersistenceState {
    /// Unter Windows gelesen?
    pub available: bool,
    /// Einträge (auffälligste zuerst).
    pub entries: Vec<AutorunView>,
    /// Geprüfte Programmdateien.
    pub files_checked: usize,
    /// Darf das Konto rechnerweite Einträge deaktivieren?
    pub admin: bool,
}

fn kind_name(kind: AutorunKind) -> String {
    serde_json::to_value(kind)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn kind_from(name: &str) -> Option<AutorunKind> {
    serde_json::from_value(serde_json::Value::String(name.to_owned())).ok()
}

/// Programmdateien eines Eintrags.
fn files_of(entry: &Autorun, env: &PathEnv) -> Vec<PathBuf> {
    match entry.kind {
        AutorunKind::BrowserExtension => Vec::new(),
        AutorunKind::StartupFolder => vec![PathBuf::from(&entry.command)],
        AutorunKind::AppInit => entry
            .command
            .split([',', ' '])
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .flat_map(|p| command_paths(p, env))
            .collect(),
        _ => entry
            .command
            .split(" | ")
            .flat_map(|part| command_paths(part, env))
            .collect(),
    }
}

fn reason(flag: Flag) -> Reason {
    let (de, en) = flag.explain();
    Reason {
        de: de.to_owned(),
        en: en.to_owned(),
    }
}

/// Bewertung ohne Dateizugriff plus Dateiprüfung (`checked`: Pfad → (fehlt?, Fund)).
fn view(
    entry: Autorun,
    file: Option<PathBuf>,
    checked: &HashMap<PathBuf, (bool, Option<Finding>)>,
) -> AutorunView {
    let (mut risk, flags) = assess(&entry);
    let mut reasons: Vec<Reason> = flags.into_iter().map(reason).collect();
    match entry.kind {
        AutorunKind::Winlogon if risk == RiskLevel::Dangerous => reasons.push(Reason {
            de: "Der Windows-Anmeldestart (Winlogon) wurde verändert – ein klassischer Platz für Schadsoftware.".into(),
            en: "The Windows logon start (Winlogon) was changed – a classic place for malware.".into(),
        }),
        AutorunKind::Ifeo => reasons.push(Reason {
            de: "Ein „Debugger“ für ein Programm ist eingetragen – startet statt des Programms etwas anderes.".into(),
            en: "A “debugger” is set for a program – something else starts instead of it.".into(),
        }),
        AutorunKind::AppInit => reasons.push(Reason {
            de: "AppInit_DLLs lädt Bibliotheken in fast jedes Programm.".into(),
            en: "AppInit_DLLs loads libraries into almost every program.".into(),
        }),
        AutorunKind::WmiConsumer => reasons.push(Reason {
            de: "Ein WMI-Abo startet Befehle bei Ereignissen – selten legitim, beliebt bei Angreifern.".into(),
            en: "A WMI subscription runs commands on events – rarely legitimate, popular with attackers.".into(),
        }),
        _ => {}
    }
    let (missing, finding) = file
        .as_ref()
        .and_then(|f| checked.get(f))
        .cloned()
        .unwrap_or((false, None));
    if missing {
        risk = risk.max(RiskLevel::Info);
        reasons.push(Reason {
            de: "Die Programmdatei fehlt – vermutlich ein Überbleibsel.".into(),
            en: "The program file is missing – probably a leftover.".into(),
        });
    }
    let finding = finding.filter(|f| f.risk > RiskLevel::Info);
    if let Some(f) = &finding {
        risk = risk.max(f.risk);
        reasons.push(Reason {
            de: format!("Prüfung der Datei: {}", f.summary_de),
            en: format!("File check: {}", f.summary_en),
        });
    }
    let action = match entry.kind {
        AutorunKind::Run
        | AutorunKind::RunOnce
        | AutorunKind::PolicyRun
        | AutorunKind::Service
        | AutorunKind::Ifeo => Some("disable"),
        AutorunKind::ScheduledTask | AutorunKind::AppInit if entry.enabled => Some("disable"),
        AutorunKind::StartupFolder if !missing => Some("quarantine"),
        _ => None,
    };
    AutorunView {
        entry,
        risk,
        reasons,
        file,
        missing,
        finding,
        action,
    }
}

/// Browser-Erweiterungen (Chrome, Edge, Brave) im Profil – im Identitätswechsel aufrufen.
fn browser_extensions(profile: &Path, out: &mut Vec<Autorun>) {
    let local = profile.join("AppData").join("Local");
    for (browser, dir) in [
        ("Chrome", r"Google\Chrome\User Data"),
        ("Edge", r"Microsoft\Edge\User Data"),
        ("Brave", r"BraveSoftware\Brave-Browser\User Data"),
    ] {
        let data = local.join(dir);
        let Ok(profiles) = std::fs::read_dir(&data) else {
            continue;
        };
        for p in profiles.flatten() {
            let name = p.file_name().to_string_lossy().into_owned();
            if name != "Default" && !name.starts_with("Profile ") {
                continue;
            }
            let ext_dir = p.path().join("Extensions");
            let Ok(exts) = std::fs::read_dir(&ext_dir) else {
                continue;
            };
            for e in exts.flatten() {
                if out.len() >= MAX_EXTENSIONS {
                    return;
                }
                let id = e.file_name().to_string_lossy().into_owned();
                if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_lowercase()) {
                    continue;
                }
                let title = std::fs::read_dir(e.path())
                    .ok()
                    .and_then(|mut versions| versions.next())
                    .and_then(Result::ok)
                    .and_then(|v| {
                        let file = std::fs::File::open(v.path().join("manifest.json")).ok()?;
                        let mut bytes = Vec::new();
                        std::io::Read::read_to_end(
                            &mut std::io::Read::take(file, 256 * 1024),
                            &mut bytes,
                        )
                        .ok()?;
                        let json: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
                        json.get("name")?.as_str().map(str::to_owned)
                    })
                    .filter(|n| !n.starts_with("__MSG_"))
                    .unwrap_or_else(|| id.clone());
                out.push(Autorun::new(
                    AutorunKind::BrowserExtension,
                    false,
                    format!("{browser} ({name})"),
                    title.chars().take(120).collect::<String>(),
                    format!("{browser}: {id}"),
                    true,
                ));
            }
        }
    }
}

/// Liest alle Autostarts (ohne Dienst-Sperre aufrufen) und bewertet sie.
#[must_use]
pub fn collect(scanner: &Scanner, user: &dyn UserAccess) -> PersistenceState {
    let profile = user.profile();
    let mut entries: Vec<Autorun> = Vec::new();
    #[cfg(windows)]
    {
        entries.extend(aegis_hardening::collect::machine_autoruns());
        if let Some(sid) = user.identity().filter(|s| s.starts_with("S-1-")) {
            entries.extend(aegis_hardening::collect::user_registry_autoruns(&sid));
        }
    }
    let env = PathEnv::for_profile(profile.as_deref());
    // Nutzerordner und Dateien nur mit den Rechten des Kontos.
    let mut checked: HashMap<PathBuf, (bool, Option<Finding>)> = HashMap::new();
    let mut files: BTreeMap<String, Option<PathBuf>> = BTreeMap::new();
    if let Ok(_scope) = user.enter() {
        if let Some(p) = &profile {
            let startup = p.join(r"AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup");
            if let Ok(list) = std::fs::read_dir(&startup) {
                for e in list.flatten().take(500) {
                    let name = e.file_name().to_string_lossy().into_owned();
                    if e.file_type().is_ok_and(|t| t.is_file())
                        && !name.eq_ignore_ascii_case("desktop.ini")
                    {
                        entries.push(Autorun::new(
                            AutorunKind::StartupFolder,
                            false,
                            startup.display().to_string(),
                            name,
                            e.path().display().to_string(),
                            true,
                        ));
                    }
                }
            }
            browser_extensions(p, &mut entries);
        }
        for entry in &entries {
            let file = files_of(entry, &env).into_iter().next();
            if let Some(f) = &file
                && !checked.contains_key(f)
            {
                let missing = std::fs::symlink_metadata(f).is_err();
                checked.insert(f.clone(), (missing, None));
            }
            files.insert(entry.id.clone(), file);
        }
    }
    let to_scan: Vec<PathBuf> = checked
        .iter()
        .filter(|(_, (missing, _))| !missing)
        .map(|(p, _)| p.clone())
        .take(MAX_FILES)
        .collect();
    let files_checked = to_scan.len();
    if !to_scan.is_empty() {
        for finding in super::examine_as_user(scanner, &to_scan, user) {
            if let Some(slot) = checked.get_mut(&finding.path) {
                slot.1 = Some(finding);
            }
        }
    }
    let mut views: Vec<AutorunView> = entries
        .into_iter()
        .map(|e| {
            let file = files.get(&e.id).cloned().flatten();
            view(e, file, &checked)
        })
        .collect();
    views.sort_by(|a, b| {
        b.risk
            .cmp(&a.risk)
            .then_with(|| a.entry.kind.cmp_key().cmp(&b.entry.kind.cmp_key()))
            .then_with(|| a.entry.name.cmp(&b.entry.name))
    });
    PersistenceState {
        available: cfg!(windows),
        entries: views,
        files_checked,
        admin: user.is_admin(),
    }
}

trait KindOrder {
    fn cmp_key(self) -> u8;
}

impl KindOrder for AutorunKind {
    fn cmp_key(self) -> u8 {
        match self {
            Self::Winlogon => 0,
            Self::Ifeo => 1,
            Self::AppInit => 2,
            Self::WmiConsumer => 3,
            Self::Run => 4,
            Self::RunOnce => 5,
            Self::PolicyRun => 6,
            Self::StartupFolder => 7,
            Self::ScheduledTask => 8,
            Self::Service => 9,
            Self::ComObject => 10,
            Self::BrowserExtension => 11,
        }
    }
}

/// Ort eines Registrierungseintrags (`HKLM\…` bzw. `HKU\<SID>\…` des Kontos).
fn registry_place(location: &str, sid: Option<&str>) -> Result<(Place, String), String> {
    if let Some(key) = location.strip_prefix(r"HKLM\") {
        return Ok((Place::Machine, key.to_owned()));
    }
    let rest = location.strip_prefix(r"HKU\").ok_or("Unbekannter Ort")?;
    let (owner, key) = rest.split_once('\\').ok_or("Unbekannter Ort")?;
    match sid {
        Some(sid) if sid.eq_ignore_ascii_case(owner) => {
            Ok((Place::User(owner.to_owned()), key.to_owned()))
        }
        _ => Err("Dieser Eintrag gehört einem anderen Konto.".into()),
    }
}

/// Geplante Aufgabe: Pfad wie `\Ordner\Name` (für `schtasks /TN`).
fn plausible_task(path: &str) -> bool {
    path.starts_with('\\')
        && path.chars().count() <= 260
        && !path.contains("..")
        && !path.chars().any(|c| c.is_control() || c == '"')
}

/// Die Schritte zum Deaktivieren (rein – testbar).
///
/// # Errors
/// Nicht deaktivierbar (Art, fremdes Konto, schon aus …).
pub fn disable_steps(entry: &Autorun, sid: Option<&str>) -> Result<Vec<Step>, String> {
    match entry.kind {
        AutorunKind::Run | AutorunKind::RunOnce | AutorunKind::PolicyRun => {
            let (place, key) = registry_place(&entry.location, sid)?;
            Ok(vec![Step::Registry {
                place,
                key,
                name: entry.name.clone(),
                value: None,
            }])
        }
        AutorunKind::ScheduledTask if !entry.enabled => {
            Err("Die Aufgabe ist bereits deaktiviert.".into())
        }
        AutorunKind::ScheduledTask if plausible_task(&entry.name) => Ok(vec![Step::Task {
            path: entry.name.clone(),
            enabled: false,
        }]),
        AutorunKind::Service => Ok(vec![Step::Registry {
            place: Place::Machine,
            key: format!(r"SYSTEM\CurrentControlSet\Services\{}", entry.name),
            name: "Start".into(),
            value: Some(Raw {
                kind: 4,
                bytes: 4u32.to_le_bytes().to_vec(),
            }),
        }]),
        AutorunKind::Ifeo => {
            let (place, key) = registry_place(&entry.location, sid)?;
            Ok(vec![Step::Registry {
                place,
                key: format!(r"{key}\{}", entry.name),
                name: "Debugger".into(),
                value: None,
            }])
        }
        AutorunKind::AppInit if entry.enabled => {
            let (place, key) = registry_place(&entry.location, sid)?;
            Ok(vec![Step::Registry {
                place,
                key,
                name: "LoadAppInit_DLLs".into(),
                value: Some(Raw {
                    kind: 4,
                    bytes: 0u32.to_le_bytes().to_vec(),
                }),
            }])
        }
        _ => Err(
            "Diesen Eintrag deaktiviert AEGIS nicht selbst – die Erklärung zeigt, wo er steht."
                .into(),
        ),
    }
}

/// Liest den Eintrag erneut (vor dem Ausführen eines Plans).
pub(super) fn reload(kind: AutorunKind, id: &str, sid: Option<&str>) -> Option<Autorun> {
    #[cfg(windows)]
    {
        let mut list = aegis_hardening::collect::machine_autoruns_of(kind);
        if let Some(sid) = sid.filter(|s| s.starts_with("S-1-")) {
            list.extend(aegis_hardening::collect::user_registry_autoruns(sid));
        }
        list.into_iter().find(|a| a.id == id && a.kind == kind)
    }
    #[cfg(not(windows))]
    {
        let _ = (kind, id, sid);
        None
    }
}

/// Wert `<Art>:<Kennung>` eines Plans zerlegen.
pub(super) fn parse_value(value: &str) -> Option<(AutorunKind, &str)> {
    let (kind, id) = value.split_once(':')?;
    let ok = id.len() == 16 && id.bytes().all(|b| b.is_ascii_hexdigit());
    let kind = kind_from(kind)?;
    ok.then_some((kind, id))
}

impl<C: Clock, W: Durable> Service<C, W> {
    /// Ergebnis des Persistenz-Checks merken (für Vorschläge) und antworten.
    pub fn persistence_finish(
        &mut self,
        state: PersistenceState,
        user: &dyn UserAccess,
    ) -> Response {
        if self.persistence_cache.len() >= 32 {
            self.persistence_cache.clear();
        }
        self.persistence_cache
            .insert(user.identity(), state.entries.clone());
        Response::Persistence {
            state: Box::new(state),
            undo: self.fix_undo_list(user),
        }
    }

    /// Schlägt vor, einen Autostart-Eintrag zu deaktivieren (aus dem letzten Check des Kontos).
    pub fn propose_autorun_disable(&mut self, id: &str, user: &dyn UserAccess) -> Response {
        let owner = user.identity();
        let Some(view) = self
            .persistence_cache
            .get(&owner)
            .and_then(|list| list.iter().find(|v| v.entry.id == id))
            .cloned()
        else {
            return Response::error("unknown", "Eintrag nicht gefunden – bitte neu prüfen");
        };
        let steps = match disable_steps(&view.entry, owner.as_deref()) {
            Ok(s) => s,
            Err(e) => return Response::error("hardening", e),
        };
        if steps.iter().any(Step::machine_wide) && !user.is_admin() {
            return Response::error(
                "admin",
                "Dieser Eintrag gilt für alle Konten – nur ein Administrator kann ihn deaktivieren.",
            );
        }
        let mut builder = ActionPlan::builder(ActionKind::ChangeSetting)
            .target(Target::setting(AUTORUN_SETTING))
            .parameter(
                param::VALUE,
                format!(
                    "{}:{}#{}",
                    kind_name(view.entry.kind),
                    view.entry.id,
                    super::harden::steps_digest(&steps)
                ),
            );
        for step in &steps {
            builder = builder.target(Target::other(step.describe()));
        }
        let plan = builder
            .what(format!(
                "Autostart-Eintrag deaktivieren: {}",
                super::quoted(&view.entry.name)
            ))
            .why(if view.risk >= RiskLevel::Suspicious {
                "Der Eintrag ist auffällig (siehe Begründung auf der Seite „Härtung“)."
            } else {
                "Von dir gewählt – z. B. weil du das Programm beim Start nicht brauchst."
            })
            .consequence(format!(
                "Das Programm startet nicht mehr automatisch ({}). Die Programmdatei selbst bleibt unverändert. Geändert wird genau: {}.",
                super::quoted(&view.entry.command),
                steps
                    .iter()
                    .map(Step::describe)
                    .collect::<Vec<_>>()
                    .join("; ")
            ))
            .undo(UndoHint::reversible(
                "AEGIS merkt sich den alten Stand – „Rückgängig“ auf der Seite „Härtung“ stellt ihn wieder her.",
            ))
            .severity(view.risk.max(RiskLevel::Info))
            .build(self.now());
        match plan {
            Ok(plan) => self.register(plan, owner, HashMap::new()),
            Err(e) => Response::error("plan", e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "S-1-5-21-1-2-3-1001";

    #[test]
    fn deaktivieren_nur_eigene_oder_rechnerweite_eintraege() {
        let own = Autorun::new(
            AutorunKind::Run,
            false,
            format!(r"HKU\{SID}\Software\Microsoft\Windows\CurrentVersion\Run"),
            "Updater",
            r"C:\Users\a\AppData\Local\Temp\u.exe",
            true,
        );
        let steps = disable_steps(&own, Some(SID)).unwrap();
        assert!(!steps.iter().any(Step::machine_wide));
        assert!(steps[0].describe().ends_with(r"\Run\Updater entfernen"));
        assert!(disable_steps(&own, Some("S-1-5-21-9-9-9-1002")).is_err());
        assert!(disable_steps(&own, None).is_err());
        let machine = Autorun::new(
            AutorunKind::Run,
            true,
            r"HKLM\Software\Microsoft\Windows\CurrentVersion\Run",
            "Tool",
            "tool.exe",
            true,
        );
        assert!(disable_steps(&machine, Some(SID)).unwrap()[0].machine_wide());
    }

    #[test]
    fn aufgaben_dienste_und_erklaerte_arten() {
        let task = Autorun::new(
            AutorunKind::ScheduledTask,
            true,
            "Aufgabenplanung",
            r"\Upd\Job",
            "x.exe",
            true,
        );
        assert_eq!(
            disable_steps(&task, None).unwrap()[0].describe(),
            r"Geplante Aufgabe „\Upd\Job“: deaktivieren"
        );
        let bad = Autorun::new(
            AutorunKind::ScheduledTask,
            true,
            "Aufgabenplanung",
            "\\a\" /x",
            "x",
            true,
        );
        assert!(disable_steps(&bad, None).is_err());
        let off = Autorun::new(
            AutorunKind::ScheduledTask,
            true,
            "Aufgabenplanung",
            r"\a",
            "x",
            false,
        );
        assert!(disable_steps(&off, None).is_err());
        let svc = Autorun::new(
            AutorunKind::Service,
            true,
            r"HKLM\SYSTEM\CurrentControlSet\Services",
            "Evil",
            "x.exe",
            true,
        );
        assert!(
            disable_steps(&svc, None).unwrap()[0]
                .describe()
                .ends_with(r"\Services\Evil\Start = 4 (DWORD)")
        );
        for kind in [
            AutorunKind::Winlogon,
            AutorunKind::WmiConsumer,
            AutorunKind::ComObject,
            AutorunKind::BrowserExtension,
        ] {
            let e = Autorun::new(kind, true, "x", "y", "z", true);
            assert!(disable_steps(&e, None).is_err(), "{kind:?}");
        }
    }

    #[test]
    fn bewertung_mit_datei_und_fund() {
        let env = PathEnv::for_profile(Some(Path::new(r"C:\Users\a")));
        let e = Autorun::new(
            AutorunKind::Run,
            false,
            "HKU\\S\\Run",
            "x",
            r"%LOCALAPPDATA%\Temp\x.exe -q",
            true,
        );
        let files = files_of(&e, &env);
        assert_eq!(files.len(), 1);
        let mut checked = HashMap::new();
        checked.insert(files[0].clone(), (true, None));
        let v = view(e, files.first().cloned(), &checked);
        assert!(v.missing);
        assert_eq!(v.risk, RiskLevel::Suspicious);
        assert_eq!(v.action, Some("disable"));
        assert!(v.reasons.iter().any(|r| r.de.contains("fehlt")));
    }

    #[test]
    fn planwert_zerlegen() {
        assert_eq!(
            parse_value("run:0123456789abcdef"),
            Some((AutorunKind::Run, "0123456789abcdef"))
        );
        assert_eq!(parse_value("run:../x"), None);
        assert_eq!(parse_value("format:0123456789abcdef"), None);
    }
}
