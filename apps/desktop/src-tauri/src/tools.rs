//! Windows-Tools (P10) in der App: Die Werkzeuge laufen mit den Rechten des angemeldeten
//! Nutzers (nicht im SYSTEM-Dienst). Jede Änderung beginnt als Vorschau; ausgeführt wird nur
//! genau diese Vorschau nach „Ausführen“ (Prüfsumme aus der Vorschau) oder durch eine vom
//! Nutzer angelegte und eingeschaltete Regel. Jeder Lauf steht im Protokoll und lässt sich
//! zurücknehmen; gelöscht wird nichts endgültig (Papierkorb).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use aegis_tools::autostart::{Entry as AutostartEntry, EntryRef};
use aegis_tools::category::Category;
use aegis_tools::desktop::Layout;
use aegis_tools::exec::{Item, Run, Status, execute, undo};
use aegis_tools::journal::Journal;
use aegis_tools::plan::{Approved, Op, Plan, Refused, Tool};
use aegis_tools::platform::Platform;
use aegis_tools::rules::{MAX_RULES, Rule, plan_for_rule};
use aegis_tools::tools::{
    DuplicateGroup, SETTLE, SourceMapping, Space, cleaner, cleaner_locations, duplicates,
    empty_folders, large_old, sort_downloads, source_folders, space,
};
use serde::{Deserialize, Serialize};
use tauri::Manager;

/// Offene Vorschauen (höchstens so viele).
const MAX_PREVIEWS: usize = 16;
/// Takt der Hintergrund-Überwachung (Sekunden).
const WATCH_SECONDS: u64 = 30;

#[derive(Default)]
struct State {
    previews: HashMap<String, Plan>,
    order: Vec<String>,
    /// Kennung der zweiten Bestätigung je Vorschau (nur im zweiten Dialog gezeigt).
    finals: HashMap<String, String>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(|| Mutex::new(State::default()));
static WATCHING: AtomicBool = AtomicBool::new(false);

fn state() -> MutexGuard<'static, State> {
    STATE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn now() -> i64 {
    aegis_tools::walk::unix(Ok(std::time::SystemTime::now()))
}

fn data_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|e| format!("Datenordner unbekannt: {e}"))
}

fn journal<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Journal, String> {
    Ok(Journal::new(data_dir(app)?.join("tools-journal.json")))
}

fn platform<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Box<dyn Platform>, String> {
    #[cfg(windows)]
    {
        let _ = app;
        Ok(Box::new(aegis_tools::win::WindowsPlatform))
    }
    #[cfg(not(windows))]
    {
        Ok(Box::new(aegis_tools::platform::LocalPlatform {
            trash: data_dir(app)?.join("tools-trash"),
        }))
    }
}

/// Anfrage für eine Vorschau.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "tool",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PreviewRequest {
    /// 1 Downloads-Sortierer.
    SortDownloads {
        /// Ordner.
        folder: PathBuf,
        /// Kategorien (leer = alle).
        #[serde(default)]
        categories: Vec<Category>,
    },
    /// 2 Quellen-Ordner.
    SourceFolders {
        /// Ordner.
        folder: PathBuf,
        /// Zuordnungen.
        mappings: Vec<SourceMapping>,
    },
    /// 3 Regeln eines Ordners jetzt anwenden.
    Rules {
        /// Regel.
        id: String,
    },
    /// 5 Hintergrundbild.
    Wallpaper {
        /// Bild.
        path: PathBuf,
    },
    /// 6 Duplikate.
    Duplicates {
        /// Ordner.
        roots: Vec<PathBuf>,
        /// Mindestgröße (Byte).
        min_size: u64,
    },
    /// 8 Große & alte Dateien.
    LargeOld {
        /// Ordner.
        roots: Vec<PathBuf>,
        /// Mindestgröße (Byte).
        min_size: u64,
        /// Unverändert seit Tagen.
        days: u32,
    },
    /// 9 Leere Ordner.
    EmptyFolders {
        /// Ordner.
        root: PathBuf,
    },
    /// 10 Cleaner.
    Cleaner {
        /// Älter als Tage.
        days: u32,
    },
    /// 11 Autostart.
    Autostart {
        /// Gewünschte Schalter.
        changes: Vec<AutostartChange>,
    },
    /// 4 Desktop-Layout wiederherstellen.
    DesktopLayout {
        /// Name des gespeicherten Layouts.
        name: String,
    },
    /// 12 Datei-Shredder (endgültig; zweite Bestätigung).
    Shredder {
        /// Dateien.
        paths: Vec<PathBuf>,
    },
    /// 15 Batch-Umbenenner.
    Rename {
        /// Ordner.
        folder: PathBuf,
        /// Einstellungen.
        options: aegis_tools::rename::Options,
    },
    /// 16/19 Explorer- und Datenschutz-Schalter.
    Tweaks {
        /// Gewünschte Schalter (`id` aus der festen Liste).
        changes: Vec<TweakChange>,
    },
}

/// Gewünschter Schalter.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TweakChange {
    /// Kennung aus `aegis_tools::tweaks::TWEAKS`.
    pub id: String,
    /// An?
    pub on: bool,
}

/// Gewünschter Autostart-Schalter.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AutostartChange {
    /// Eintrag.
    pub entry: EntryRef,
    /// Einschalten?
    pub enable: bool,
}

/// Ein Schritt der Vorschau für die Oberfläche.
#[derive(Debug, Serialize)]
pub struct PreviewItem {
    /// Beschreibung.
    pub label: String,
    /// Art (`move`, `recycle`, `remove_empty_dir`, …).
    pub kind: &'static str,
    /// Größe (bei Dateien).
    pub size: u64,
}

/// Vorschau für die Oberfläche.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewView {
    /// Endgültiges Löschen dabei (zweite Bestätigung nötig)?
    pub needs_final: bool,
    /// Kennung.
    pub id: String,
    /// Prüfsumme (kommt mit „Ausführen“ zurück).
    pub digest: String,
    /// Werkzeug.
    pub tool: Tool,
    /// Schritte.
    pub items: Vec<PreviewItem>,
    /// Summe der Dateigrößen.
    pub total_size: u64,
    /// Duplikat-Gruppen (nur Werkzeug 6).
    pub groups: Vec<DuplicateGroup>,
}

fn item(op: &Op) -> PreviewItem {
    let (kind, size) = match op {
        Op::Move { size, .. } => ("move", *size),
        Op::Recycle { size, .. } => ("recycle", *size),
        Op::RemoveEmptyDir { .. } => ("remove_empty_dir", 0),
        Op::SetWallpaper { .. } => ("set_wallpaper", 0),
        Op::Autostart { .. } => ("autostart", 0),
        Op::DesktopLayout { .. } => ("desktop_layout", 0),
        Op::Registry { .. } => ("registry", 0),
        Op::Shred { size, .. } => ("shred", *size),
    };
    PreviewItem {
        label: op.label(),
        kind,
        size,
    }
}

fn remember(plan: Plan, groups: Vec<DuplicateGroup>) -> PreviewView {
    let view = PreviewView {
        needs_final: plan.needs_final(),
        id: plan.id.clone(),
        digest: plan.digest(),
        tool: plan.tool,
        total_size: plan.ops.iter().map(|o| item(o).size).sum(),
        items: plan.ops.iter().map(item).collect(),
        groups,
    };
    let mut s = state();
    s.order.push(plan.id.clone());
    s.previews.insert(plan.id.clone(), plan);
    while s.order.len() > MAX_PREVIEWS {
        let old = s.order.remove(0);
        s.previews.remove(&old);
    }
    view
}

fn checked(path: &std::path::Path) -> Result<(), String> {
    if aegis_tools::guard::allowed(path) && path.is_dir() {
        Ok(())
    } else {
        Err("Diesen Ordner fasst AEGIS nicht an (Systemort oder nicht vorhanden).".into())
    }
}

fn build<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request: PreviewRequest,
) -> Result<PreviewView, String> {
    let t = now();
    let (plan, groups) = match request {
        PreviewRequest::SortDownloads { folder, categories } => {
            checked(&folder)?;
            (sort_downloads(&folder, &categories, t), Vec::new())
        }
        PreviewRequest::SourceFolders { folder, mappings } => {
            checked(&folder)?;
            (source_folders(&folder, &mappings, t), Vec::new())
        }
        PreviewRequest::Rules { id } => {
            let rules = load_rules(app)?;
            let rule = rules
                .iter()
                .find(|r| r.id == id)
                .ok_or("Regel nicht gefunden.")?;
            let mut once = rule.clone();
            // Von Hand „jetzt anwenden“: auch eine ausgeschaltete Regel darf eine Vorschau
            // zeigen; ausgeführt wird sie nur nach „Ausführen“.
            once.enabled = true;
            let mut plan = plan_for_rule(&once, t, SETTLE);
            plan.rule = None;
            (plan, Vec::new())
        }
        PreviewRequest::Wallpaper { path } => {
            let ok = matches!(aegis_tools::category::category_of(&path), Category::Images)
                && path.is_file()
                && aegis_tools::guard::allowed(&path);
            if !ok {
                return Err("Bitte ein Bild (JPG, PNG, BMP …) wählen.".into());
            }
            (
                Plan::new(Tool::Wallpaper, vec![Op::SetWallpaper { path }], t),
                Vec::new(),
            )
        }
        PreviewRequest::Duplicates { roots, min_size } => {
            for r in &roots {
                checked(r)?;
            }
            let (groups, plan) = duplicates(&roots, min_size, t);
            (plan, groups)
        }
        PreviewRequest::LargeOld {
            roots,
            min_size,
            days,
        } => {
            for r in &roots {
                checked(r)?;
            }
            (large_old(&roots, min_size, days, t), Vec::new())
        }
        PreviewRequest::EmptyFolders { root } => {
            checked(&root)?;
            (empty_folders(&root, t), Vec::new())
        }
        PreviewRequest::Cleaner { days } => (cleaner(&cleaner_locations(), days, t), Vec::new()),
        PreviewRequest::Autostart { changes } => {
            let ops = changes
                .into_iter()
                .filter(|c| c.entry.location.editable())
                .filter(|c| aegis_tools::autostart::valid_name(&c.entry.name))
                .map(|c| Op::Autostart {
                    entry: c.entry,
                    enable: c.enable,
                })
                .collect();
            (Plan::new(Tool::Autostart, ops, t), Vec::new())
        }
        PreviewRequest::Shredder { paths } => {
            let mut ops = Vec::new();
            for path in paths.into_iter().take(500) {
                let Some((size, modified)) = aegis_tools::walk::file_state(&path) else {
                    return Err("Nur einzelne Dateien (keine Ordner oder Verknüpfungen).".into());
                };
                if !aegis_tools::guard::allowed(&path) {
                    return Err("Diese Datei fasst AEGIS nicht an (Systemort).".into());
                }
                ops.push(Op::Shred {
                    path,
                    size,
                    modified,
                });
            }
            (Plan::new(Tool::Shredder, ops, t), Vec::new())
        }
        PreviewRequest::Rename { folder, options } => {
            checked(&folder)?;
            (aegis_tools::rename::plan(&folder, &options, t), Vec::new())
        }
        PreviewRequest::Tweaks { changes } => {
            let platform = platform(app)?;
            let mut ops = Vec::new();
            let mut tool = Tool::ExplorerTweaks;
            for c in changes {
                let tweak = aegis_tools::tweaks::find(&c.id).ok_or("Unbekannter Schalter.")?;
                if tweak.group == aegis_tools::tweaks::Group::Privacy {
                    tool = Tool::Privacy;
                }
                let value = if c.on { tweak.on } else { tweak.off }.owned();
                if platform.registry_get(tweak.key, tweak.name).ok().as_ref() == Some(&value) {
                    continue;
                }
                ops.push(Op::Registry {
                    key: tweak.key.to_owned(),
                    name: tweak.name.to_owned(),
                    value,
                });
            }
            (Plan::new(tool, ops, t), Vec::new())
        }
        PreviewRequest::DesktopLayout { name } => {
            let layout = load_layouts(app)?
                .into_iter()
                .find(|l| l.name == name)
                .ok_or("Layout nicht gefunden.")?;
            (
                Plan::new(Tool::DesktopLayout, vec![Op::DesktopLayout { layout }], t),
                Vec::new(),
            )
        }
    };
    Ok(remember(plan, groups))
}

/// Erstellt eine Vorschau (nur lesend).
#[tauri::command]
pub async fn tools_preview<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: PreviewRequest,
) -> Result<PreviewView, String> {
    tauri::async_runtime::spawn_blocking(move || build(&app, request))
        .await
        .map_err(|e| e.to_string())?
}

/// Ein Lauf für die Oberfläche.
#[derive(Debug, Serialize)]
pub struct RunView {
    /// Kennung.
    pub id: String,
    /// Werkzeug.
    pub tool: Tool,
    /// Aus einer Regel?
    pub rule: Option<String>,
    /// Zeitpunkt.
    pub at: i64,
    /// Zurückgenommen am.
    pub undone: Option<i64>,
    /// Ausgeführt.
    pub done: usize,
    /// Übersprungen.
    pub skipped: usize,
    /// Fehlgeschlagen.
    pub failed: usize,
    /// Schritte (Text, Ergebnis, Grund).
    pub items: Vec<RunItemView>,
}

/// Schritt eines Laufs.
#[derive(Debug, Serialize)]
pub struct RunItemView {
    /// Beschreibung.
    pub label: String,
    /// Ergebnis.
    pub status: Status,
    /// Grund.
    pub reason: Option<String>,
}

fn run_view(run: &Run) -> RunView {
    let count = |s: Status| run.items.iter().filter(|i| i.status == s).count();
    RunView {
        id: run.id.clone(),
        tool: run.tool,
        rule: run.rule.clone(),
        at: run.at,
        undone: run.undone,
        done: count(Status::Done) + count(Status::Undone),
        skipped: count(Status::Skipped),
        failed: count(Status::Failed),
        items: run
            .items
            .iter()
            .map(|i: &Item| RunItemView {
                label: i.label.clone(),
                status: i.status,
                reason: i.reason.clone(),
            })
            .collect(),
    }
}

/// Führt genau die Vorschau `id` aus (der Nutzer hat „Ausführen“ gewählt).
#[tauri::command]
pub async fn tools_execute<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    id: String,
    digest: String,
    skip: Vec<usize>,
    confirm: Option<String>,
) -> Result<RunView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let refused = |e: Refused| match e {
            Refused::Digest => "Vorschau passt nicht – bitte neu erstellen.".to_owned(),
            Refused::Expired => "Vorschau abgelaufen – bitte neu erstellen.".to_owned(),
            Refused::Rule => "Regel nicht aktiv.".to_owned(),
            Refused::NeedsFinal => "Zweite Bestätigung fehlt.".to_owned(),
        };
        let mut s = state();
        let needs_final = s.previews.get(&id).is_some_and(Plan::needs_final);
        if needs_final && confirm.is_none() {
            // Erstes „Ausführen“: noch nichts tun, sondern die zweite, getrennte Bestätigung
            // anfordern (die Oberfläche zeigt dafür einen eigenen Dialog).
            let challenge = aegis_tools::plan::token();
            s.finals.insert(id.clone(), challenge.clone());
            return Err(format!("confirm_final:{challenge}"));
        }
        // Die Vorschau wird verbraucht: Ein zweites „Ausführen“ derselben Vorschau gibt es nicht.
        let plan = s
            .previews
            .remove(&id)
            .ok_or("Vorschau abgelaufen – bitte neu erstellen.")?;
        let expected = s.finals.remove(&id).unwrap_or_default();
        drop(s);
        let approved = if needs_final {
            Approved::by_user_final(
                &plan,
                &digest,
                skip,
                now(),
                &expected,
                confirm.as_deref().unwrap_or_default(),
            )
        } else {
            Approved::by_user(&plan, &digest, skip, now())
        }
        .map_err(refused)?;
        let platform = platform(&app)?;
        let run = execute(approved, platform.as_ref(), now());
        journal(&app)?
            .append(run.clone())
            .map_err(|e| format!("Ausgeführt, aber Protokoll nicht gespeichert: {e}"))?;
        Ok(run_view(&run))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Letzte Läufe (neueste zuerst).
#[tauri::command]
pub fn tools_runs<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<Vec<RunView>, String> {
    Ok(journal(&app)?
        .load()
        .iter()
        .rev()
        .take(50)
        .map(run_view)
        .collect())
}

/// Nimmt einen Lauf zurück; liefert Hinweise zu Schritten, die nicht zurückgingen.
#[tauri::command]
pub async fn tools_undo<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    id: String,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let journal = journal(&app)?;
        let mut run = journal
            .load()
            .into_iter()
            .find(|r| r.id == id)
            .ok_or("Lauf nicht gefunden.")?;
        if run.undone.is_some() {
            return Err("Schon zurückgenommen.".into());
        }
        let platform = platform(&app)?;
        let errors = undo(&mut run, platform.as_ref(), now());
        journal.replace(&run).map_err(|e| e.to_string())?;
        Ok(errors)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Nur lesende Abfragen.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ScanRequest {
    /// 7 Speicherplatz eines Ordners.
    Space {
        /// Ordner.
        root: PathBuf,
    },
    /// 11 Autostart-Einträge.
    Autostart {},
    /// Standardordner (Downloads, Bilder, Desktop) und Cleaner-Orte.
    Defaults {},
    /// 16/19 Stand der Explorer- und Datenschutz-Schalter.
    Tweaks {},
    /// 18 Hosts-Datei.
    Hosts {},
    /// 22 Systeminfo & Gesundheits-Check.
    System {},
}

/// Stand eines Schalters.
#[derive(Debug, Serialize)]
pub struct TweakState {
    /// Kennung.
    pub id: &'static str,
    /// Gruppe.
    pub group: aegis_tools::tweaks::Group,
    /// An?
    pub on: bool,
}

/// Hosts-Datei.
#[derive(Debug, Serialize)]
pub struct HostsView {
    /// Pfad.
    pub path: PathBuf,
    /// Einträge.
    pub entries: Vec<aegis_tools::hosts::HostEntry>,
}

/// Systeminfo samt Hinweisen.
#[derive(Debug, Serialize)]
pub struct SystemView {
    /// Daten.
    pub info: aegis_tools::health::SystemInfo,
    /// Hinweise.
    pub findings: Vec<aegis_tools::health::Finding>,
}

/// Standardordner.
#[derive(Debug, Serialize)]
pub struct Defaults {
    /// Downloads.
    pub downloads: Option<PathBuf>,
    /// Bilder.
    pub pictures: Option<PathBuf>,
    /// Desktop.
    pub desktop: Option<PathBuf>,
    /// Orte des Cleaners.
    pub cleaner: Vec<PathBuf>,
    /// Läuft unter Windows (Papierkorb, Hintergrundbild, Autostart, Desktop verfügbar)?
    pub windows: bool,
}

/// Antwort einer Abfrage.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScanResponse {
    /// Speicherplatz.
    Space {
        /// Ergebnis.
        space: Space,
    },
    /// Autostart.
    Autostart {
        /// Einträge.
        entries: Vec<AutostartEntry>,
    },
    /// Standardordner.
    Defaults {
        /// Ordner.
        defaults: Defaults,
    },
    /// Schalter.
    Tweaks {
        /// Stand.
        tweaks: Vec<TweakState>,
    },
    /// Hosts-Datei.
    Hosts {
        /// Inhalt.
        hosts: HostsView,
    },
    /// Systeminfo.
    System {
        /// Daten.
        system: SystemView,
    },
}

/// Systeminfo lesen (nur Windows liefert alles; sonst das, was plattformunabhängig geht).
fn system_info() -> aegis_tools::health::SystemInfo {
    let cores = std::thread::available_parallelism().map_or(0, std::num::NonZero::get);
    #[cfg(windows)]
    {
        use aegis_winffi::inspect::{Hive, read_values};
        let value = |key: &str, name: &str| {
            read_values(&Hive::LocalMachine, key)
                .into_iter()
                .find(|v| v.name.eq_ignore_ascii_case(name))
                .map(|v| v.data)
                .unwrap_or_default()
        };
        let cv = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
        let ubr = value(cv, "UBR");
        let build = value(cv, "CurrentBuild");
        aegis_tools::health::SystemInfo {
            os: value(cv, "ProductName"),
            version: value(cv, "DisplayVersion"),
            build: if ubr.is_empty() {
                build
            } else {
                format!("{build}.{ubr}")
            },
            cpu: value(
                r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
                "ProcessorNameString",
            )
            .trim()
            .to_owned(),
            cores,
            memory: aegis_winffi::sysinfo::memory().ok(),
            uptime: aegis_winffi::sysinfo::uptime_seconds(),
            drives: aegis_winffi::sysinfo::fixed_drives()
                .into_iter()
                .filter_map(|root| {
                    aegis_winffi::fs::disk_space(&root)
                        .ok()
                        .map(|(free, total)| aegis_tools::health::Drive {
                            root: root.display().to_string(),
                            free,
                            total,
                        })
                })
                .collect(),
            computer: std::env::var("COMPUTERNAME").unwrap_or_default(),
        }
    }
    #[cfg(not(windows))]
    {
        aegis_tools::health::SystemInfo {
            os: std::env::consts::OS.to_owned(),
            cores,
            ..aegis_tools::health::SystemInfo::default()
        }
    }
}

/// Nur lesende Abfrage (Speicherplatz, Autostart, Standardordner).
#[tauri::command]
pub async fn tools_scan<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: ScanRequest,
) -> Result<ScanResponse, String> {
    tauri::async_runtime::spawn_blocking(move || match request {
        ScanRequest::Space { root } => {
            checked(&root)?;
            #[cfg(windows)]
            let disk = aegis_winffi::fs::disk_space(&root).ok();
            #[cfg(not(windows))]
            let disk = None;
            Ok(ScanResponse::Space {
                space: space(&root, disk),
            })
        }
        ScanRequest::Autostart {} => {
            #[cfg(windows)]
            let entries = aegis_tools::win::autostart_entries();
            #[cfg(not(windows))]
            let entries = Vec::new();
            Ok(ScanResponse::Autostart { entries })
        }
        ScanRequest::Tweaks {} => {
            let platform = platform(&app)?;
            Ok(ScanResponse::Tweaks {
                tweaks: aegis_tools::tweaks::TWEAKS
                    .iter()
                    .map(|t| TweakState {
                        id: t.id,
                        group: t.group,
                        on: platform
                            .registry_get(t.key, t.name)
                            .is_ok_and(|v| aegis_tools::tweaks::is_on(t, &v)),
                    })
                    .collect(),
            })
        }
        ScanRequest::Hosts {} => {
            let path = aegis_tools::hosts::path();
            let meta = std::fs::symlink_metadata(&path)
                .map_err(|_| "Hosts-Datei nicht lesbar.".to_owned())?;
            if !meta.is_file() || meta.len() > 4 * 1024 * 1024 {
                return Err("Hosts-Datei nicht lesbar.".into());
            }
            let text = std::fs::read(&path).map_err(|_| "Hosts-Datei nicht lesbar.".to_owned())?;
            Ok(ScanResponse::Hosts {
                hosts: HostsView {
                    entries: aegis_tools::hosts::parse(&String::from_utf8_lossy(&text)),
                    path,
                },
            })
        }
        ScanRequest::System {} => {
            let info = system_info();
            Ok(ScanResponse::System {
                system: SystemView {
                    findings: aegis_tools::health::check(&info),
                    info,
                },
            })
        }
        ScanRequest::Defaults {} => {
            let p = app.path();
            Ok(ScanResponse::Defaults {
                defaults: Defaults {
                    downloads: p.download_dir().ok(),
                    pictures: p.picture_dir().ok(),
                    desktop: p.desktop_dir().ok(),
                    cleaner: cleaner_locations(),
                    windows: cfg!(windows),
                },
            })
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn rules_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("tools-rules.json"))
}

fn layouts_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("tools-desktop-layouts.json"))
}

fn read_json<T: serde::de::DeserializeOwned + Default>(path: &std::path::Path) -> T {
    std::fs::symlink_metadata(path)
        .ok()
        .filter(|m| m.is_file() && m.len() <= 4 * 1024 * 1024)
        .and_then(|_| std::fs::read(path).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write_json<T: Serialize>(path: &std::path::Path, value: &T) -> Result<(), String> {
    use std::io::Write;
    let body = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    if let Some(dir) = path.parent() {
        // Eigener App-Datenordner.
        // aegis-mutation: desktop-tools-dir
        #[allow(clippy::disallowed_methods)]
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    {
        // Eigene Hilfsdatei (Regeln bzw. Layouts des Nutzers).
        // aegis-mutation: desktop-tools-write
        #[allow(clippy::disallowed_methods)]
        let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(&body)
            .and_then(|()| file.sync_all())
            .map_err(|e| e.to_string())?;
    }
    // Ersetzt die eigene Datei (Regeln bzw. Layouts).
    // aegis-mutation: desktop-tools-replace
    #[allow(clippy::disallowed_methods)]
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn load_rules<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Vec<Rule>, String> {
    Ok(read_json(&rules_path(app)?))
}

fn load_layouts<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Vec<Layout>, String> {
    Ok(read_json(&layouts_path(app)?))
}

/// Regeln des Nutzers.
#[tauri::command]
pub fn tools_rules<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<Vec<Rule>, String> {
    load_rules(&app)
}

/// Regel anlegen oder ändern (der Nutzer hat sie im Regel-Editor gespeichert).
#[tauri::command]
pub fn tools_rule_save<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    rule: Rule,
) -> Result<Rule, String> {
    let rule = rule.validated()?;
    let mut rules = load_rules(&app)?;
    match rules.iter_mut().find(|r| r.id == rule.id) {
        Some(slot) => *slot = rule.clone(),
        None => {
            if rules.len() >= MAX_RULES {
                return Err("Zu viele Regeln.".into());
            }
            rules.push(rule.clone());
        }
    }
    write_json(&rules_path(&app)?, &rules)?;
    start_watcher(app);
    Ok(rule)
}

/// Regel löschen (nur die Regel; Dateien bleiben, wo sie sind).
#[tauri::command]
pub fn tools_rule_delete<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    id: String,
) -> Result<(), String> {
    let mut rules = load_rules(&app)?;
    let before = rules.len();
    rules.retain(|r| r.id != id);
    if rules.len() == before {
        return Err("Regel nicht gefunden.".into());
    }
    write_json(&rules_path(&app)?, &rules)
}

/// Gespeicherte Desktop-Layouts.
#[tauri::command]
pub fn tools_layouts<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<Vec<Layout>, String> {
    load_layouts(&app)
}

/// Aktuelle Desktop-Symbole (nur lesend; nur Windows).
fn current_icons() -> Result<Vec<aegis_tools::desktop::Icon>, String> {
    #[cfg(windows)]
    {
        aegis_tools::win::desktop_icons().map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        Err("windows_only".into())
    }
}

/// Aktuelle Desktop-Symbole als Layout speichern (liest nur den Desktop).
#[tauri::command]
pub fn tools_layout_save<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    name: String,
) -> Result<Layout, String> {
    let icons = current_icons()?;
    let layout = Layout {
        name,
        saved: now(),
        icons,
    }
    .validated()?;
    let mut layouts = load_layouts(&app)?;
    layouts.retain(|l| l.name != layout.name);
    layouts.push(layout.clone());
    layouts.truncate(20);
    write_json(&layouts_path(&app)?, &layouts)?;
    Ok(layout)
}

/// Gespeichertes Desktop-Layout löschen.
#[tauri::command]
pub fn tools_layout_delete<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    name: String,
) -> Result<(), String> {
    let mut layouts = load_layouts(&app)?;
    let before = layouts.len();
    layouts.retain(|l| l.name != name);
    if layouts.len() == before {
        return Err("Layout nicht gefunden.".into());
    }
    write_json(&layouts_path(&app)?, &layouts)
}

/// Ein Durchgang der Hintergrund-Überwachung: jede eingeschaltete Regel mit „im Hintergrund“
/// prüft ihren Ordner; gefundene Dateien werden verschoben und protokolliert.
fn watch_once<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let (Ok(rules), Ok(journal), Ok(platform)) = (load_rules(app), journal(app), platform(app))
    else {
        return;
    };
    for rule in rules.iter().filter(|r| r.enabled && r.watch) {
        let plan = plan_for_rule(rule, now(), SETTLE);
        if plan.ops.is_empty() {
            continue;
        }
        if let Ok(approved) = Approved::by_rule(&plan, rule) {
            let run = execute(approved, platform.as_ref(), now());
            if run.done() > 0 {
                let _ = journal.append(run);
            }
        }
    }
}

/// Startet die Hintergrund-Überwachung (einmal; tut nichts, solange keine Regel sie verlangt).
pub fn start_watcher<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("aegis-tools-watch".into())
        .spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(WATCH_SECONDS));
                watch_once(&app);
            }
        });
    if spawned.is_err() {
        WATCHING.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vorschau_anfragen_sind_streng() {
        assert!(
            serde_json::from_str::<PreviewRequest>(r#"{"tool":"cleaner","days":3,"extra":true}"#)
                .is_err()
        );
        assert!(serde_json::from_str::<PreviewRequest>(r#"{"tool":"format_disk"}"#).is_err());
        assert!(serde_json::from_str::<ScanRequest>(r#"{"kind":"defaults"}"#).is_ok());
    }
}
