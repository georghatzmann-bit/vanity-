//! Die vier Optimierungen: Zustand lesen, einschalten und auf den gesicherten Originalwert (sonst
//! Windows-Standard) zurückstellen. Vor der ersten Änderung wird das Original in kv `opt.snapshots`
//! gesichert: `{ "<tweakId>": { "values": { "<Name>": Wert | null }, "savedAt": ms } }`.
//!
//! Die Logik arbeitet über die Schnittstellen `Registry` und `PowerCfg` und ist damit ohne Windows
//! testbar.
#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::power::{self, PowerCfg};
use super::registry::{self, RegVal, Registry, RegistryRead};
use super::types::{ApplyReport, PowerPlan, Tweak, TweakError};
use crate::elevate::{self, ElevateError, ElevatedTask, Elevator, RegOp};
use crate::error::CmdResult;
use crate::state::Shared;
use crate::util::now_ms;

/// Schlüssel im Schlüssel/Wert-Speicher für die Sicherungen.
pub const KV_SNAPSHOTS: &str = "opt.snapshots";
/// Einheitliche Meldung außerhalb von Windows.
pub const NOT_WINDOWS: &str = "Nur unter Windows verfügbar.";

pub const POWER_PLAN: &str = "powerPlan";
pub const GAME_MODE: &str = "gameMode";
pub const GAME_DVR: &str = "gameDvr";
pub const MOUSE_ACCEL: &str = "mouseAccel";
pub const NAGLE: &str = "nagle";
pub const NET_THROTTLE: &str = "netThrottle";
/// Alle Optimierungen in Anzeigereihenfolge.
pub const IDS: [&str; 6] = [POWER_PLAN, GAME_MODE, GAME_DVR, MOUSE_ACCEL, NAGLE, NET_THROTTLE];
/// Die Optimierungen, für die Windows nachfragt (über den Admin-Helfer).
pub const ADMIN_IDS: [&str; 2] = [NAGLE, NET_THROTTLE];

/// `NetworkThrottlingIndex`: „an“ (Drosselung aus) und Windows-Standard.
pub const THROTTLE_ON: u32 = 0xFFFF_FFFF;
pub const THROTTLE_DEFAULT: u32 = 10;
/// Name des gesicherten Adapters bei `nagle` (GUID als Text).
const SNAP_ADAPTER: &str = "adapter";
/// `nagle` einschalten, solange eine Sicherung für eine andere Verbindung besteht.
pub const NAGLE_OTHER_ADAPTER: &str = "„Nagle“ ist noch an einer anderen Verbindung eingestellt – bitte erst zurückstellen.";

/// Ist das eine Optimierung mit Windows-Abfrage?
pub fn is_admin_id(id: &str) -> bool {
    ADMIN_IDS.contains(&id)
}

struct Def {
    id: &'static str,
    category: &'static str,
    impact: &'static str,
    admin: bool,
    restart: bool,
}

/// Katalog (Kategorie, ehrliche Wirkungsstufe, Adminrechte, Neustart laut `docs/API.md`).
const DEFS: [Def; 6] = [
    Def { id: POWER_PLAN, category: "power", impact: "medium", admin: false, restart: false },
    Def { id: GAME_MODE, category: "windows", impact: "low", admin: false, restart: false },
    Def { id: GAME_DVR, category: "windows", impact: "medium", admin: false, restart: false },
    Def { id: MOUSE_ACCEL, category: "input", impact: "medium", admin: false, restart: false },
    Def { id: NAGLE, category: "network", impact: "low", admin: true, restart: true },
    Def { id: NET_THROTTLE, category: "network", impact: "low", admin: true, restart: true },
];

// Orte in der Registrierung (alle unter HKCU)
const KEY_GAMEBAR: &str = r"Software\Microsoft\GameBar";
const KEY_GAMECONFIG: &str = r"System\GameConfigStore";
const KEY_GAMEDVR: &str = r"Software\Microsoft\Windows\CurrentVersion\GameDVR";
const KEY_MOUSE: &str = r"Control Panel\Mouse";
/// Name des gesicherten Werts beim Energieplan: GUID des vorher aktiven Plans.
const SNAP_ACTIVE_PLAN: &str = "activePlan";

/// Fester Registrierungswert (für die Tabellen unten).
#[derive(Clone, Copy)]
enum Lit {
    D(u32),
    S(&'static str),
}

impl Lit {
    fn val(self) -> RegVal {
        match self {
            Lit::D(d) => RegVal::Dword(d),
            Lit::S(s) => RegVal::Str(s.into()),
        }
    }
}

/// Ein Registrierungswert einer Optimierung: Ort, Wert für „an“ und Windows-Standard für „aus“.
struct Slot {
    key: &'static str,
    name: &'static str,
    on: Lit,
    default: Lit,
}

/// Spielmodus. Ohne Sicherung schaltet „aus“ den Spielmodus sichtbar ab (0), damit der Schalter
/// nicht ins Leere greift (Windows-Standard wäre „an“).
const GAME_MODE_SLOTS: &[Slot] = &[Slot { key: KEY_GAMEBAR, name: "AutoGameModeEnabled", on: Lit::D(1), default: Lit::D(0) }];

/// Game-Bar-Hintergrundaufnahme: „an“ = Aufnahme aus (0/0), Standard = Aufnahme an (1/1).
const GAME_DVR_SLOTS: &[Slot] = &[
    Slot { key: KEY_GAMECONFIG, name: "GameDVR_Enabled", on: Lit::D(0), default: Lit::D(1) },
    Slot { key: KEY_GAMEDVR, name: "AppCaptureEnabled", on: Lit::D(0), default: Lit::D(1) },
];

/// Mausbeschleunigung („Zeigerpräzision verbessern“). Reihenfolge: Beschleunigung, Schwelle 1, Schwelle 2.
const MOUSE_SLOTS: &[Slot] = &[
    Slot { key: KEY_MOUSE, name: "MouseSpeed", on: Lit::S("0"), default: Lit::S("1") },
    Slot { key: KEY_MOUSE, name: "MouseThreshold1", on: Lit::S("0"), default: Lit::S("6") },
    Slot { key: KEY_MOUSE, name: "MouseThreshold2", on: Lit::S("0"), default: Lit::S("10") },
];

/// Windows-Standard der Maus als Zahlen: Beschleunigung, Schwelle 1, Schwelle 2.
const MOUSE_DEFAULT: [i32; 3] = [1, 6, 10];

fn slots(id: &str) -> Option<&'static [Slot]> {
    match id {
        GAME_MODE => Some(GAME_MODE_SLOTS),
        GAME_DVR => Some(GAME_DVR_SLOTS),
        MOUSE_ACCEL => Some(MOUSE_SLOTS),
        _ => None,
    }
}

// =============================================================================================
// Systemzugriff
// =============================================================================================

/// Zugriff auf das System – für Tests austauschbar.
pub struct Env<'a> {
    /// Benutzer-Registrierung (HKCU), lesen und schreiben.
    pub reg: &'a dyn Registry,
    /// System-Registrierung (HKLM), nur lesen (geht ohne Adminrechte).
    pub hklm: &'a dyn RegistryRead,
    pub power: &'a dyn PowerCfg,
    /// Admin-Helfer für die wenigen Änderungen unter HKLM (`nagle`, `netThrottle`).
    pub elevator: &'a dyn Elevator,
    /// Mausparameter sofort anwenden: `[Schwelle 1, Schwelle 2, Beschleunigung]` (wie `SPI_SETMOUSE`).
    pub apply_mouse: fn([i32; 3]) -> CmdResult<()>,
    /// GUID (`{…}`) der Hauptverbindung – für `nagle` (None = keine erkannt).
    pub main_adapter: Option<String>,
}

/// Mausparameter sofort anwenden (`SystemParametersInfoW(SPI_SETMOUSE)`), damit die Änderung ohne
/// Neuanmeldung wirkt. Reihenfolge wie bei Windows: `[Schwelle 1, Schwelle 2, Beschleunigung]`.
pub fn apply_mouse_now(params: [i32; 3]) -> CmdResult<()> {
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            SystemParametersInfoW, SPIF_SENDCHANGE, SPIF_UPDATEINIFILE, SPI_SETMOUSE,
        };
        let mut p = params;
        unsafe {
            SystemParametersInfoW(
                SPI_SETMOUSE,
                0,
                Some(p.as_mut_ptr() as *mut core::ffi::c_void),
                SPIF_UPDATEINIFILE | SPIF_SENDCHANGE,
            )
        }
        .map_err(|e| format!("Die Mauseinstellung konnte nicht übernommen werden: {}", e.message()))
    }
    #[cfg(not(windows))]
    {
        let _ = params;
        Err(NOT_WINDOWS.into())
    }
}

// =============================================================================================
// Sicherungen
// =============================================================================================

/// Originalwerte einer Optimierung vor der ersten Änderung durch Pulsar.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// Name → Wert; `None` = der Wert fehlte.
    pub values: BTreeMap<String, Option<RegVal>>,
    pub saved_at: i64,
}

pub type Snapshots = BTreeMap<String, Snapshot>;

/// Sicherungen aus dem gespeicherten JSON lesen; beschädigte Einträge werden übersprungen.
pub fn parse_snapshots(v: &Value) -> Snapshots {
    let mut out = Snapshots::new();
    if let Some(obj) = v.as_object() {
        for (id, entry) in obj {
            if let Ok(s) = serde_json::from_value::<Snapshot>(entry.clone()) {
                out.insert(id.clone(), s);
            }
        }
    }
    out
}

/// Sicherungen als JSON; leer → `null`, damit der Schlüssel aus der Datenbank verschwindet.
pub fn snapshots_to_value(map: &Snapshots) -> Value {
    if map.is_empty() {
        return Value::Null;
    }
    serde_json::to_value(map).unwrap_or(Value::Null)
}

type Persist = Box<dyn Fn(&Snapshots) -> CmdResult<()>>;

/// Sicherungen mit optionalem Speichern (Datenbank). Eine neue Sicherung wird gespeichert, **bevor**
/// Windows verändert wird – schlägt das fehl, bleibt alles unverändert.
pub struct SnapshotStore {
    map: Snapshots,
    persist: Option<Persist>,
}

impl SnapshotStore {
    /// Ohne Speichern (Tests).
    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self { map: Snapshots::new(), persist: None }
    }

    #[cfg(test)]
    pub fn with_persist(map: Snapshots, persist: Persist) -> Self {
        Self { map, persist: Some(persist) }
    }

    /// Aus kv `opt.snapshots` laden; Änderungen werden dorthin zurückgeschrieben.
    pub fn load(core: &Shared) -> CmdResult<Self> {
        let v = core.db.with(|db| db.kv_get(KV_SNAPSHOTS))?;
        let core = core.clone();
        Ok(Self {
            map: parse_snapshots(&v),
            persist: Some(Box::new(move |m| {
                core.db.with(|db| db.kv_set(KV_SNAPSHOTS, &snapshots_to_value(m)))
            })),
        })
    }

    pub fn get(&self, id: &str) -> Option<&Snapshot> {
        self.map.get(id)
    }

    pub fn ids(&self) -> Vec<String> {
        self.map.keys().cloned().collect()
    }

    fn save(&self) -> CmdResult<()> {
        match &self.persist {
            Some(p) => p(&self.map).map_err(|e| format!("Die Sicherung konnte nicht gespeichert werden: {e}")),
            None => Ok(()),
        }
    }

    /// Sicherung anlegen (ersetzt eine vorhandene nicht – das Original zählt).
    pub fn insert(&mut self, id: &str, values: BTreeMap<String, Option<RegVal>>) -> CmdResult<()> {
        if self.map.contains_key(id) {
            return Ok(());
        }
        self.map.insert(id.to_string(), Snapshot { values, saved_at: now_ms() });
        if let Err(e) = self.save() {
            self.map.remove(id);
            return Err(e);
        }
        Ok(())
    }

    pub fn remove(&mut self, id: &str) -> CmdResult<()> {
        let Some(old) = self.map.remove(id) else { return Ok(()) };
        if let Err(e) = self.save() {
            self.map.insert(id.to_string(), old);
            return Err(e);
        }
        Ok(())
    }
}

// =============================================================================================
// Zustand lesen
// =============================================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum St {
    On,
    Off,
    Unknown,
}

impl St {
    pub fn as_str(self) -> &'static str {
        match self {
            St::On => "on",
            St::Off => "off",
            St::Unknown => "unknown",
        }
    }
}

fn read_slots(reg: &dyn Registry, slots: &[Slot]) -> CmdResult<Vec<Option<RegVal>>> {
    slots.iter().map(|s| reg.get(s.key, s.name)).collect()
}

/// Zustand aus den gelesenen Werten (Reihenfolge wie in den Tabellen).
fn reg_state(id: &str, values: &[Option<RegVal>]) -> St {
    let nums: Vec<Option<u32>> = values.iter().map(|v| v.as_ref().and_then(RegVal::as_u32)).collect();
    let first = nums.first().copied().flatten();
    match id {
        // 1 = an, 0 = aus; fehlt der Wert, gilt der Windows-Standard (Spielmodus an) – ehrlich: unbekannt
        GAME_MODE => match first {
            Some(0) => St::Off,
            Some(_) => St::On,
            None => St::Unknown,
        },
        // Aufnahme ist nur aus, wenn beide Werte 0 sind
        GAME_DVR => {
            if nums.iter().any(|n| matches!(n, Some(x) if *x != 0)) {
                St::Off
            } else if !nums.is_empty() && nums.iter().all(|n| *n == Some(0)) {
                St::On
            } else {
                St::Unknown
            }
        }
        // MouseSpeed 0 = keine Beschleunigung (die Schwellen spielen dann keine Rolle)
        MOUSE_ACCEL => match first {
            Some(0) => St::On,
            Some(_) => St::Off,
            None => St::Unknown,
        },
        _ => St::Unknown,
    }
}

fn power_state(plans: &CmdResult<Vec<PowerPlan>>) -> (St, Option<String>) {
    match plans {
        Ok(p) => match power::active(p) {
            Some(a) => {
                let st = if power::is_performance(a) { St::On } else { St::Off };
                (st, Some(a.name.clone()))
            }
            None => (St::Unknown, None),
        },
        Err(e) => (St::Unknown, Some(e.clone())),
    }
}

fn tweak(def: &Def, state: &str, detail: Option<String>, can_revert: bool) -> Tweak {
    Tweak {
        id: def.id.into(),
        category: def.category.into(),
        impact: def.impact.into(),
        state: state.into(),
        detail,
        can_revert,
        admin: def.admin,
        restart: def.restart,
    }
}

/// Schlüssel der Netzwerk-Einstellungen eines Adapters (für `nagle`).
fn interface_key(guid: &str) -> String {
    format!("{}\\{}", elevate::KEY_INTERFACES, guid)
}

/// Zustand von `nagle` an der Hauptverbindung (ohne Hauptverbindung „unbekannt“).
fn nagle_state(env: &Env) -> CmdResult<(St, Option<String>)> {
    let Some(guid) = env.main_adapter.as_deref() else {
        return Ok((St::Unknown, None));
    };
    let key = interface_key(guid);
    let ack = env.hklm.read(&key, elevate::VAL_TCP_ACK)?.and_then(|v| v.as_u32());
    let nd = env.hklm.read(&key, elevate::VAL_NO_DELAY)?.and_then(|v| v.as_u32());
    let st = if ack == Some(1) && nd == Some(1) { St::On } else { St::Off };
    Ok((st, None))
}

/// Zustand von `netThrottle` (Drosselung aus = „an“).
fn throttle_state(env: &Env) -> CmdResult<St> {
    let v = env.hklm.read(elevate::KEY_SYSTEM_PROFILE, elevate::VAL_THROTTLE)?.and_then(|v| v.as_u32());
    Ok(if v == Some(THROTTLE_ON) { St::On } else { St::Off })
}

/// Aktuellen Zustand aller Optimierungen lesen (`powercfg` wird nur einmal aufgerufen).
pub fn read_all(env: &Env, store: &SnapshotStore) -> Vec<Tweak> {
    let plans = env.power.list();
    DEFS.iter()
        .map(|d| {
            let (state, detail) = match d.id {
                POWER_PLAN => power_state(&plans),
                NAGLE => match nagle_state(env) {
                    Ok(x) => x,
                    Err(e) => (St::Unknown, Some(e)),
                },
                NET_THROTTLE => match throttle_state(env) {
                    Ok(st) => (st, None),
                    Err(e) => (St::Unknown, Some(e)),
                },
                _ => match slots(d.id).map(|s| read_slots(env.reg, s)) {
                    Some(Ok(values)) => (reg_state(d.id, &values), None),
                    Some(Err(e)) => (St::Unknown, Some(e)),
                    None => (St::Unknown, None),
                },
            };
            tweak(d, state.as_str(), detail, store.get(d.id).is_some())
        })
        .collect()
}

/// Außerhalb von Windows: alle Optimierungen als „nicht unterstützt“.
#[cfg_attr(windows, allow(dead_code))]
pub fn unsupported_list() -> Vec<Tweak> {
    DEFS.iter().map(|d| tweak(d, "unsupported", None, false)).collect()
}

/// Außerhalb von Windows: jede angefragte Optimierung schlägt mit klarer Meldung fehl.
#[cfg_attr(windows, allow(dead_code))]
pub fn unsupported_report(ids: &[String]) -> ApplyReport {
    let mut report = ApplyReport::default();
    for id in unique_ids(ids) {
        report.failed.push(TweakError { id, error: NOT_WINDOWS.into() });
    }
    report
}

fn unique_ids(ids: &[String]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    ids.iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && seen.insert(s.clone()))
        .collect()
}

// =============================================================================================
// Anwenden und Zurückstellen
// =============================================================================================

/// Eine Optimierung ein- (`enable`) oder ausschalten. „Aus“ stellt die Sicherung wieder her (und
/// entfernt sie), sonst den Windows-Standard.
pub fn apply_one(id: &str, enable: bool, env: &Env, store: &mut SnapshotStore) -> CmdResult<()> {
    if id == POWER_PLAN {
        return if enable { enable_power(env, store) } else { disable_power(env, store) };
    }
    let Some(slots) = slots(id) else {
        return Err(format!("Unbekannte Optimierung: „{id}“"));
    };
    if enable {
        enable_reg(id, slots, env, store)
    } else {
        disable_reg(id, slots, env, store)
    }
}

/// Mehrere Optimierungen; doppelte IDs werden nur einmal bearbeitet. Die Admin-Optimierungen eines
/// Aufrufs laufen gesammelt über **eine** Windows-Abfrage.
pub fn apply_many(ids: &[String], enable: bool, env: &Env, store: &mut SnapshotStore) -> ApplyReport {
    let (admin, normal): (Vec<String>, Vec<String>) = unique_ids(ids).into_iter().partition(|id| is_admin_id(id));
    let mut report = ApplyReport::default();
    for id in normal {
        match apply_one(&id, enable, env, store) {
            Ok(()) => report.applied.push(id),
            Err(error) => report.failed.push(TweakError { id, error }),
        }
    }
    run_admin(&admin, enable, env, store, &mut report);
    report
}

/// Alle gesicherten Originalwerte wiederherstellen (Admin-Optimierungen gesammelt mit einer Abfrage).
pub fn revert_all(env: &Env, store: &mut SnapshotStore) -> ApplyReport {
    let mut report = ApplyReport::default();
    let mut admin = Vec::new();
    for id in store.ids() {
        if !IDS.contains(&id.as_str()) {
            // Rest einer älteren Version – still entfernen
            let _ = store.remove(&id);
            continue;
        }
        if is_admin_id(&id) {
            admin.push(id);
        } else {
            match apply_one(&id, false, env, store) {
                Ok(()) => report.applied.push(id),
                Err(error) => report.failed.push(TweakError { id, error }),
            }
        }
    }
    run_admin(&admin, false, env, store, &mut report);
    report
}

/// Admin-Optimierungen eines Aufrufs gesammelt ausführen und das Ergebnis in `report` eintragen.
fn run_admin(ids: &[String], enable: bool, env: &Env, store: &mut SnapshotStore, report: &mut ApplyReport) {
    // Läuft noch ein Helfer (Zeitüberschreitung), nichts vorbereiten: Sonst könnte eine Sicherung
    // als „schon zurückgestellt“ verschwinden, kurz bevor der Helfer doch noch ändert.
    if !ids.is_empty() && env.elevator.busy() {
        for id in ids {
            report.failed.push(TweakError { id: id.clone(), error: elevate::MSG_BUSY.into() });
        }
        return;
    }
    let batch = prepare_admin(ids, enable, env, store);
    let ops = batch.reg_ops();
    let outcome = if ops.is_empty() {
        Ok(())
    } else {
        env.elevator.run(&ElevatedTask { dns: Vec::new(), reg: ops })
    };
    let (applied, failed) = batch.settle(&outcome, env, store);
    report.applied.extend(applied);
    report.failed.extend(failed);
}

// =============================================================================================
// Admin-Optimierungen (nagle, netThrottle) – über den Admin-Helfer
// =============================================================================================

/// Eine vorbereitete Admin-Optimierung.
pub struct AdminStep {
    id: String,
    enable: bool,
    /// Zielwerte am richtigen Schlüssel – zugleich die Nachkontrolle.
    ops: Vec<RegOp>,
    /// In diesem Aufruf neu angelegte Sicherung (bei Ablehnung wieder entfernen).
    new_snapshot: bool,
}

/// Mehrere Admin-Optimierungen vorbereiten: Zielwerte bestimmen, Sicherungen anlegen.
#[derive(Default)]
pub struct AdminBatch {
    steps: Vec<AdminStep>,
    /// Schon im Zielzustand – nichts zu tun.
    done: Vec<String>,
    /// Fehler vor dem Helfer (z. B. keine Hauptverbindung).
    failed: Vec<TweakError>,
}

enum Prep {
    /// Schon im Zielzustand (nichts ändern).
    Done,
    /// Vor dem Helfer gescheitert.
    Fail(String),
    /// Über den Helfer ändern.
    Step(Vec<RegOp>, bool),
}

impl AdminBatch {
    /// Alle Registrierungs-Änderungen des Stapels (für den Admin-Helfer).
    pub fn reg_ops(&self) -> Vec<RegOp> {
        self.steps.iter().flat_map(|s| s.ops.clone()).collect()
    }

    /// Nach dem Admin-Helfer: Nachkontrolle, Sicherungen aufräumen, Ergebnis je ID.
    pub fn settle(self, outcome: &Result<(), ElevateError>, env: &Env, store: &mut SnapshotStore) -> (Vec<String>, Vec<TweakError>) {
        let mut applied = self.done;
        let mut failed = self.failed;
        if self.steps.is_empty() {
            return (applied, failed);
        }
        if let Err(ElevateError::Declined) = outcome {
            for s in &self.steps {
                if s.new_snapshot {
                    let _ = store.remove(&s.id);
                }
                failed.push(TweakError { id: s.id.clone(), error: elevate::MSG_DECLINED.into() });
            }
            return (applied, failed);
        }
        let run_err = outcome.as_ref().err();
        for s in self.steps {
            match verify_ops(&s.ops, env) {
                Ok(()) => {
                    // Erfolgreich zurückgestellt → Sicherung weg
                    if !s.enable {
                        let _ = store.remove(&s.id);
                    }
                    applied.push(s.id);
                }
                Err(vmsg) => {
                    let error = run_err.map(ElevateError::to_string).unwrap_or(vmsg);
                    // Die Sicherung bleibt (Windows kann schon teilweise geändert sein): sagen, dass
                    // Zurückstellen geht – die Oberfläche zeigt dann nie „Nicht geändert“
                    let error = if store.get(&s.id).is_some() { format!("{error} {}", crate::net::dnsctl::RESTORE_HINT) } else { error };
                    failed.push(TweakError { id: s.id, error });
                }
            }
        }
        (applied, failed)
    }
}

/// Admin-Optimierungen vorbereiten. Bereits im Zielzustand → nichts tun, nichts sichern.
pub fn prepare_admin(ids: &[String], enable: bool, env: &Env, store: &mut SnapshotStore) -> AdminBatch {
    let mut batch = AdminBatch::default();
    for id in ids {
        let prep = match id.as_str() {
            NAGLE => prepare_nagle(enable, env, store),
            NET_THROTTLE => prepare_throttle(enable, env, store),
            _ => Prep::Fail(format!("Unbekannte Optimierung: „{id}“")),
        };
        match prep {
            Prep::Done => batch.done.push(id.clone()),
            Prep::Fail(error) => batch.failed.push(TweakError { id: id.clone(), error }),
            Prep::Step(ops, new_snapshot) => batch.steps.push(AdminStep { id: id.clone(), enable, ops, new_snapshot }),
        }
    }
    batch
}

/// Nachkontrolle: Jeder Zielwert steht jetzt wirklich so in der Registrierung.
fn verify_ops(ops: &[RegOp], env: &Env) -> Result<(), String> {
    for op in ops {
        let got = env.hklm.read(&op.key, &op.name)?.and_then(|v| v.as_u32());
        if got != op.value {
            return Err("Windows hat die Änderung nicht übernommen.".into());
        }
    }
    Ok(())
}

/// Die gesicherte Adapter-GUID von `nagle`, falls gültig.
fn nagle_saved_adapter(store: &SnapshotStore) -> Option<Result<String, String>> {
    let snap = store.get(NAGLE)?;
    let adapter = snap.values.get(SNAP_ADAPTER).and_then(|v| v.as_ref()).and_then(RegVal::as_str);
    match adapter {
        Some(g) if elevate::is_braced_guid(g) => Some(Ok(g.to_string())),
        _ => Some(Err("Die gesicherte Verbindung für „Nagle“ ist ungültig.".into())),
    }
}

fn prepare_nagle(enable: bool, env: &Env, store: &mut SnapshotStore) -> Prep {
    // Adapter: beim Einschalten die Hauptverbindung, beim Zurückstellen der gesicherte Adapter.
    let guid = if enable {
        match env.main_adapter.as_deref() {
            Some(g) if elevate::is_braced_guid(g) => g.to_string(),
            _ => return Prep::Fail("Keine Hauptverbindung gefunden, an der „Nagle“ eingestellt werden kann.".into()),
        }
    } else {
        match nagle_saved_adapter(store) {
            // Den gesicherten Adapter gibt es nicht mehr → nichts mehr zurückzustellen
            Some(Ok(g)) if !env.hklm.key_exists(&interface_key(&g)) => {
                let _ = store.remove(NAGLE);
                return Prep::Done;
            }
            Some(Ok(g)) => g,
            Some(Err(e)) => return Prep::Fail(e),
            None => match env.main_adapter.as_deref() {
                Some(g) if elevate::is_braced_guid(g) => g.to_string(),
                _ => return Prep::Fail("Keine gesicherte Verbindung für „Nagle“ gefunden.".into()),
            },
        }
    };
    let key = interface_key(&guid);
    let ack = match env.hklm.read(&key, elevate::VAL_TCP_ACK) {
        Ok(v) => v.and_then(|v| v.as_u32()),
        Err(e) => return Prep::Fail(e),
    };
    let nd = match env.hklm.read(&key, elevate::VAL_NO_DELAY) {
        Ok(v) => v.and_then(|v| v.as_u32()),
        Err(e) => return Prep::Fail(e),
    };
    // Zielwerte
    let targets: Vec<(&str, Option<u32>)> = if enable {
        vec![(elevate::VAL_TCP_ACK, Some(1)), (elevate::VAL_NO_DELAY, Some(1))]
    } else {
        match store.get(NAGLE) {
            Some(snap) => vec![
                (elevate::VAL_TCP_ACK, snap.values.get(elevate::VAL_TCP_ACK).and_then(|v| v.as_ref()).and_then(RegVal::as_u32)),
                (elevate::VAL_NO_DELAY, snap.values.get(elevate::VAL_NO_DELAY).and_then(|v| v.as_ref()).and_then(RegVal::as_u32)),
            ],
            // Ohne Sicherung: Windows-Standard = beide Werte fehlen
            None => vec![(elevate::VAL_TCP_ACK, None), (elevate::VAL_NO_DELAY, None)],
        }
    };
    // Schon im Zielzustand?
    if [ack, nd] == [targets[0].1, targets[1].1] {
        if !enable {
            let _ = store.remove(NAGLE);
        }
        return Prep::Done;
    }
    // Gibt es schon eine Sicherung für einen anderen Adapter, wird hier nichts geändert – sonst
    // blieben die Werte an diesem Adapter ohne Sicherung (eine Sicherung je Optimierung).
    if enable {
        match nagle_saved_adapter(store) {
            Some(Ok(saved)) if !saved.eq_ignore_ascii_case(&guid) => return Prep::Fail(NAGLE_OTHER_ADAPTER.into()),
            Some(Err(e)) => return Prep::Fail(e),
            _ => {}
        }
    }
    let mut new_snapshot = false;
    if enable && store.get(NAGLE).is_none() {
        let mut values = BTreeMap::new();
        values.insert(SNAP_ADAPTER.to_string(), Some(RegVal::Str(guid.clone())));
        values.insert(elevate::VAL_TCP_ACK.to_string(), ack.map(RegVal::Dword));
        values.insert(elevate::VAL_NO_DELAY.to_string(), nd.map(RegVal::Dword));
        if let Err(e) = store.insert(NAGLE, values) {
            return Prep::Fail(e);
        }
        new_snapshot = true;
    }
    let ops = targets
        .into_iter()
        .map(|(name, value)| RegOp { key: key.clone(), name: name.to_string(), value })
        .collect();
    Prep::Step(ops, new_snapshot)
}

fn prepare_throttle(enable: bool, env: &Env, store: &mut SnapshotStore) -> Prep {
    let current = match env.hklm.read(elevate::KEY_SYSTEM_PROFILE, elevate::VAL_THROTTLE) {
        Ok(v) => v.and_then(|v| v.as_u32()),
        Err(e) => return Prep::Fail(e),
    };
    let target: Option<u32> = if enable {
        Some(THROTTLE_ON)
    } else {
        match store.get(NET_THROTTLE) {
            Some(snap) => snap.values.get(elevate::VAL_THROTTLE).and_then(|v| v.as_ref()).and_then(RegVal::as_u32),
            None => Some(THROTTLE_DEFAULT),
        }
    };
    if current == target {
        if !enable {
            let _ = store.remove(NET_THROTTLE);
        }
        return Prep::Done;
    }
    let mut new_snapshot = false;
    if enable && store.get(NET_THROTTLE).is_none() {
        let mut values = BTreeMap::new();
        values.insert(elevate::VAL_THROTTLE.to_string(), current.map(RegVal::Dword));
        if let Err(e) = store.insert(NET_THROTTLE, values) {
            return Prep::Fail(e);
        }
        new_snapshot = true;
    }
    let ops = vec![RegOp { key: elevate::KEY_SYSTEM_PROFILE.to_string(), name: elevate::VAL_THROTTLE.to_string(), value: target }];
    Prep::Step(ops, new_snapshot)
}

fn enable_reg(id: &str, slots: &[Slot], env: &Env, store: &mut SnapshotStore) -> CmdResult<()> {
    let current = read_slots(env.reg, slots)?;
    if reg_state(id, &current) == St::On {
        // Schon optimiert (z. B. vom Benutzer selbst) – nichts ändern, nichts sichern
        return Ok(());
    }
    let values = slots.iter().zip(current).map(|(s, v)| (s.name.to_string(), v)).collect();
    store.insert(id, values)?;
    for s in slots {
        env.reg.set(s.key, s.name, &s.on.val())?;
    }
    let written: Vec<Option<RegVal>> = slots.iter().map(|s| Some(s.on.val())).collect();
    after_write(id, env, &written)
}

fn disable_reg(id: &str, slots: &[Slot], env: &Env, store: &mut SnapshotStore) -> CmdResult<()> {
    let written: Vec<Option<RegVal>> = match store.get(id).cloned() {
        Some(snap) => {
            let mut written = Vec::with_capacity(slots.len());
            for s in slots {
                // Fehlt ein Name in der Sicherung (beschädigt), gilt der Windows-Standard
                let v = snap.values.get(s.name).cloned().unwrap_or_else(|| Some(s.default.val()));
                registry::restore(env.reg, s.key, s.name, v.as_ref())?;
                written.push(v);
            }
            store.remove(id)?;
            written
        }
        None => {
            for s in slots {
                env.reg.set(s.key, s.name, &s.default.val())?;
            }
            slots.iter().map(|s| Some(s.default.val())).collect()
        }
    };
    after_write(id, env, &written)
}

/// Nach dem Schreiben: Mausparameter sofort anwenden (alles andere wirkt von selbst).
fn after_write(id: &str, env: &Env, written: &[Option<RegVal>]) -> CmdResult<()> {
    if id != MOUSE_ACCEL {
        return Ok(());
    }
    (env.apply_mouse)(mouse_params(written))
}

/// `[Schwelle 1, Schwelle 2, Beschleunigung]` aus den Werten `MouseSpeed, MouseThreshold1,
/// MouseThreshold2`; fehlende oder unlesbare Werte → Windows-Standard.
pub fn mouse_params(values: &[Option<RegVal>]) -> [i32; 3] {
    let num = |i: usize| {
        values
            .get(i)
            .and_then(|v| v.as_ref())
            .and_then(RegVal::as_u32)
            .and_then(|n| i32::try_from(n).ok())
            .unwrap_or(MOUSE_DEFAULT[i])
    };
    [num(1), num(2), num(0)]
}

fn enable_power(env: &Env, store: &mut SnapshotStore) -> CmdResult<()> {
    let plans = env.power.list()?;
    let current = power::active(&plans).cloned();
    if current.as_ref().map(power::is_performance).unwrap_or(false) {
        return Ok(());
    }
    let mut values = BTreeMap::new();
    values.insert(SNAP_ACTIVE_PLAN.to_string(), current.map(|p| RegVal::Str(p.guid)));
    store.insert(POWER_PLAN, values)?;
    power::activate_performance(env.power, &plans)?;
    Ok(())
}

fn disable_power(env: &Env, store: &mut SnapshotStore) -> CmdResult<()> {
    let saved = store
        .get(POWER_PLAN)
        .and_then(|s| s.values.get(SNAP_ACTIVE_PLAN))
        .and_then(|v| v.as_ref())
        .and_then(RegVal::as_str)
        .filter(|g| power::is_guid(g))
        .map(str::to_ascii_lowercase);
    let target = match saved {
        // Nur zurück zum gesicherten Plan, wenn es ihn noch gibt – sonst „Ausbalanciert“
        Some(g) if env.power.list()?.iter().any(|p| p.guid == g) => g,
        _ => power::BALANCED.to_string(),
    };
    env.power.set_active(&target)?;
    store.remove(POWER_PLAN)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::opt::power::{MemPowerCfg, BALANCED, HIGH, ULTIMATE};
    use crate::opt::registry::MemRegistry;
    use serde_json::json;
    use std::cell::RefCell;

    thread_local! {
        static MOUSE_CALLS: RefCell<Vec<[i32; 3]>> = const { RefCell::new(Vec::new()) };
    }

    fn record_mouse(p: [i32; 3]) -> CmdResult<()> {
        MOUSE_CALLS.with(|m| m.borrow_mut().push(p));
        Ok(())
    }

    fn mouse_calls() -> Vec<[i32; 3]> {
        MOUSE_CALLS.with(|m| std::mem::take(&mut *m.borrow_mut()))
    }

    use crate::elevate::MemElevator;

    /// Für Nicht-Admin-Tests: kein Admin-Helfer erwartet (ruft er an, ist das ein Testfehler).
    struct NoopElevator;
    impl Elevator for NoopElevator {
        fn run(&self, _task: &ElevatedTask) -> Result<(), ElevateError> {
            panic!("Admin-Helfer wurde unerwartet aufgerufen");
        }
    }
    static NOOP: NoopElevator = NoopElevator;

    fn env<'a>(reg: &'a MemRegistry, power: &'a MemPowerCfg) -> Env<'a> {
        Env { reg, hklm: reg, power, elevator: &NOOP, apply_mouse: record_mouse, main_adapter: None }
    }

    /// Für Admin-Tests: eine (gemeinsame) Registrierung, ein Test-Helfer, Hauptverbindung.
    fn env_admin<'a>(reg: &'a MemRegistry, power: &'a MemPowerCfg, el: &'a MemElevator<'a>, main: Option<&str>) -> Env<'a> {
        Env { reg, hklm: reg, power, elevator: el, apply_mouse: record_mouse, main_adapter: main.map(String::from) }
    }

    fn default_power() -> MemPowerCfg {
        MemPowerCfg::with(&[(BALANCED, "Balanced", true), (HIGH, "High performance", false)])
    }

    fn state_of(list: &[Tweak], id: &str) -> (String, bool) {
        let t = list.iter().find(|t| t.id == id).expect("Optimierung fehlt");
        (t.state.clone(), t.can_revert)
    }

    #[test]
    fn catalog_matches_contract() {
        let list = unsupported_list();
        assert_eq!(list.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), IDS);
        assert_eq!(list.len(), 6);
        for t in &list {
            assert!(["power", "windows", "input", "network"].contains(&t.category.as_str()), "{}", t.category);
            assert!(["high", "medium", "low"].contains(&t.impact.as_str()), "{}", t.impact);
            assert_eq!(t.state, "unsupported");
            assert!(!t.can_revert);
            assert!(t.detail.is_none());
        }
        // nagle/netThrottle: Netzwerk, Admin, Neustart
        for id in ADMIN_IDS {
            let t = list.iter().find(|t| t.id == id).unwrap();
            assert_eq!(t.category, "network");
            assert!(t.admin && t.restart, "{id}");
        }
        for id in [POWER_PLAN, GAME_MODE, GAME_DVR, MOUSE_ACCEL] {
            let t = list.iter().find(|t| t.id == id).unwrap();
            assert!(!t.admin && !t.restart, "{id}");
        }
        let report = unsupported_report(&["gameMode".into(), " gameMode ".into(), "gameDvr".into(), "".into()]);
        assert!(report.applied.is_empty());
        assert_eq!(report.failed.len(), 2);
        assert_eq!(report.failed[0].error, NOT_WINDOWS);
    }

    #[test]
    fn snapshot_json_roundtrip_and_lenient_parsing() {
        let mut map = Snapshots::new();
        let mut dvr = BTreeMap::new();
        dvr.insert("GameDVR_Enabled".to_string(), Some(RegVal::Dword(1)));
        dvr.insert("AppCaptureEnabled".to_string(), None);
        map.insert(GAME_DVR.into(), Snapshot { values: dvr, saved_at: 1_700_000_000_000 });
        let mut plan = BTreeMap::new();
        plan.insert(SNAP_ACTIVE_PLAN.to_string(), Some(RegVal::Str(BALANCED.into())));
        map.insert(POWER_PLAN.into(), Snapshot { values: plan, saved_at: 5 });

        let v = snapshots_to_value(&map);
        assert_eq!(
            v,
            json!({
                "gameDvr": { "values": { "AppCaptureEnabled": null, "GameDVR_Enabled": 1 }, "savedAt": 1_700_000_000_000i64 },
                "powerPlan": { "values": { "activePlan": BALANCED }, "savedAt": 5 }
            })
        );
        assert_eq!(parse_snapshots(&v), map);

        // Beschädigte Einträge überspringen, Rest behalten
        let broken = json!({
            "gameMode": { "values": { "AutoGameModeEnabled": null }, "savedAt": 1 },
            "mouseAccel": "kaputt",
            "gameDvr": { "values": { "GameDVR_Enabled": -3 }, "savedAt": 1 }
        });
        let parsed = parse_snapshots(&broken);
        assert_eq!(parsed.keys().collect::<Vec<_>>(), vec!["gameMode"]);
        assert!(parse_snapshots(&Value::Null).is_empty());
        assert!(parse_snapshots(&json!([1, 2])).is_empty());
        assert_eq!(snapshots_to_value(&Snapshots::new()), Value::Null, "leer → Schlüssel löschen");
    }

    #[test]
    fn game_dvr_enable_snapshots_originals_and_disable_restores_them() {
        // Nur ein Wert vorhanden (1), der zweite fehlt
        let reg = MemRegistry::with(&[(KEY_GAMECONFIG, "GameDVR_Enabled", RegVal::Dword(1))]);
        let power = default_power();
        let mut store = SnapshotStore::in_memory();
        let e = env(&reg, &power);

        assert_eq!(state_of(&read_all(&e, &store), GAME_DVR), ("off".into(), false));

        apply_one(GAME_DVR, true, &e, &mut store).unwrap();
        assert_eq!(reg.dword(KEY_GAMECONFIG, "GameDVR_Enabled"), Some(0));
        assert_eq!(reg.dword(KEY_GAMEDVR, "AppCaptureEnabled"), Some(0));
        assert_eq!(state_of(&read_all(&e, &store), GAME_DVR), ("on".into(), true));
        let snap = store.get(GAME_DVR).unwrap();
        assert_eq!(snap.values["GameDVR_Enabled"], Some(RegVal::Dword(1)));
        assert_eq!(snap.values["AppCaptureEnabled"], None);
        assert!(snap.saved_at > 0);

        // Nochmal einschalten: Sicherung bleibt das Original
        apply_one(GAME_DVR, true, &e, &mut store).unwrap();
        assert_eq!(store.get(GAME_DVR).unwrap().values["GameDVR_Enabled"], Some(RegVal::Dword(1)));

        apply_one(GAME_DVR, false, &e, &mut store).unwrap();
        assert_eq!(reg.dword(KEY_GAMECONFIG, "GameDVR_Enabled"), Some(1));
        assert!(!reg.has(KEY_GAMEDVR, "AppCaptureEnabled"), "fehlender Wert wird wieder gelöscht");
        assert!(store.get(GAME_DVR).is_none());
        assert_eq!(state_of(&read_all(&e, &store), GAME_DVR), ("off".into(), false));
    }

    #[test]
    fn disable_without_snapshot_uses_windows_defaults() {
        let reg = MemRegistry::with(&[
            (KEY_GAMECONFIG, "GameDVR_Enabled", RegVal::Dword(0)),
            (KEY_GAMEDVR, "AppCaptureEnabled", RegVal::Dword(0)),
        ]);
        let power = default_power();
        let mut store = SnapshotStore::in_memory();
        let e = env(&reg, &power);
        assert_eq!(state_of(&read_all(&e, &store), GAME_DVR), ("on".into(), false));

        // Schon an → einschalten ändert nichts und sichert nichts
        apply_one(GAME_DVR, true, &e, &mut store).unwrap();
        assert!(store.get(GAME_DVR).is_none());

        apply_one(GAME_DVR, false, &e, &mut store).unwrap();
        assert_eq!(reg.dword(KEY_GAMECONFIG, "GameDVR_Enabled"), Some(1));
        assert_eq!(reg.dword(KEY_GAMEDVR, "AppCaptureEnabled"), Some(1));
        assert!(store.get(GAME_DVR).is_none());
        assert_eq!(state_of(&read_all(&e, &store), GAME_DVR), ("off".into(), false));
    }

    #[test]
    fn game_mode_absent_is_unknown_and_revert_all_deletes_value() {
        let reg = MemRegistry::default();
        let power = default_power();
        let mut store = SnapshotStore::in_memory();
        let e = env(&reg, &power);
        assert_eq!(state_of(&read_all(&e, &store), GAME_MODE), ("unknown".into(), false));

        apply_one(GAME_MODE, true, &e, &mut store).unwrap();
        assert_eq!(reg.dword(KEY_GAMEBAR, "AutoGameModeEnabled"), Some(1));
        assert_eq!(state_of(&read_all(&e, &store), GAME_MODE), ("on".into(), true));
        assert_eq!(store.get(GAME_MODE).unwrap().values["AutoGameModeEnabled"], None);

        let report = revert_all(&e, &mut store);
        assert_eq!(report.applied, vec![GAME_MODE.to_string()]);
        assert!(report.failed.is_empty());
        assert!(!reg.has(KEY_GAMEBAR, "AutoGameModeEnabled"));
        assert!(store.ids().is_empty());
        assert_eq!(state_of(&read_all(&e, &store), GAME_MODE), ("unknown".into(), false));

        // Aus ohne Sicherung: Spielmodus sichtbar aus (0)
        apply_one(GAME_MODE, false, &e, &mut store).unwrap();
        assert_eq!(state_of(&read_all(&e, &store), GAME_MODE), ("off".into(), false));
    }

    #[test]
    fn mouse_accel_writes_strings_and_applies_immediately() {
        let reg = MemRegistry::with(&[
            (KEY_MOUSE, "MouseSpeed", RegVal::Str("1".into())),
            (KEY_MOUSE, "MouseThreshold1", RegVal::Str("6".into())),
            (KEY_MOUSE, "MouseThreshold2", RegVal::Str("10".into())),
        ]);
        let power = default_power();
        let mut store = SnapshotStore::in_memory();
        let e = env(&reg, &power);
        mouse_calls();
        assert_eq!(state_of(&read_all(&e, &store), MOUSE_ACCEL), ("off".into(), false));

        apply_one(MOUSE_ACCEL, true, &e, &mut store).unwrap();
        assert_eq!(reg.string(KEY_MOUSE, "MouseSpeed"), Some("0".into()));
        assert_eq!(reg.string(KEY_MOUSE, "MouseThreshold1"), Some("0".into()));
        assert_eq!(reg.string(KEY_MOUSE, "MouseThreshold2"), Some("0".into()));
        assert_eq!(mouse_calls(), vec![[0, 0, 0]]);
        assert_eq!(state_of(&read_all(&e, &store), MOUSE_ACCEL), ("on".into(), true));

        apply_one(MOUSE_ACCEL, false, &e, &mut store).unwrap();
        assert_eq!(reg.string(KEY_MOUSE, "MouseSpeed"), Some("1".into()));
        assert_eq!(reg.string(KEY_MOUSE, "MouseThreshold2"), Some("10".into()));
        assert_eq!(mouse_calls(), vec![[6, 10, 1]], "Reihenfolge wie SPI_SETMOUSE");
        assert!(store.get(MOUSE_ACCEL).is_none());

        // Ohne Werte → Windows-Standard; unlesbare Werte ebenso
        assert_eq!(mouse_params(&[None, None, None]), [6, 10, 1]);
        assert_eq!(mouse_params(&[Some(RegVal::Str("x".into())), Some(RegVal::Str("2".into()))]), [2, 10, 1]);
        for (i, s) in MOUSE_SLOTS.iter().enumerate() {
            assert_eq!(Some(s.default.val().as_u32().unwrap() as i32), Some(MOUSE_DEFAULT[i]));
        }
    }

    #[test]
    fn mouse_accel_absent_is_unknown() {
        let reg = MemRegistry::default();
        let power = default_power();
        let store = SnapshotStore::in_memory();
        assert_eq!(state_of(&read_all(&env(&reg, &power), &store), MOUSE_ACCEL), ("unknown".into(), false));
    }

    #[test]
    fn power_plan_enable_restore_and_fallback() {
        let reg = MemRegistry::default();
        let power = default_power();
        let mut store = SnapshotStore::in_memory();
        let e = env(&reg, &power);

        let list = read_all(&e, &store);
        assert_eq!(state_of(&list, POWER_PLAN), ("off".into(), false));
        assert_eq!(list[0].detail.as_deref(), Some("Balanced"));

        apply_one(POWER_PLAN, true, &e, &mut store).unwrap();
        assert_eq!(power.active_guid(), Some(HIGH.into()));
        assert_eq!(store.get(POWER_PLAN).unwrap().values[SNAP_ACTIVE_PLAN], Some(RegVal::Str(BALANCED.into())));
        let list = read_all(&e, &store);
        assert_eq!(state_of(&list, POWER_PLAN), ("on".into(), true));
        assert_eq!(list[0].detail.as_deref(), Some("High performance"));

        apply_one(POWER_PLAN, false, &e, &mut store).unwrap();
        assert_eq!(power.active_guid(), Some(BALANCED.into()));
        assert!(store.get(POWER_PLAN).is_none());

        // Gesicherter Plan existiert nicht mehr → Ausbalanciert
        power.plans.borrow_mut().push(PowerPlan { guid: "11111111-2222-3333-4444-555555555555".into(), name: "Eigen".into(), active: false });
        power.set_active("11111111-2222-3333-4444-555555555555").unwrap();
        apply_one(POWER_PLAN, true, &e, &mut store).unwrap();
        power.plans.borrow_mut().retain(|p| p.guid != "11111111-2222-3333-4444-555555555555");
        apply_one(POWER_PLAN, false, &e, &mut store).unwrap();
        assert_eq!(power.active_guid(), Some(BALANCED.into()));

        // Ohne Sicherung → Ausbalanciert; Ultimative Leistung wird bevorzugt
        power.plans.borrow_mut().push(PowerPlan { guid: ULTIMATE.into(), name: "Ultimate Performance".into(), active: false });
        apply_one(POWER_PLAN, true, &e, &mut store).unwrap();
        assert_eq!(power.active_guid(), Some(ULTIMATE.into()));
        store.remove(POWER_PLAN).unwrap();
        apply_one(POWER_PLAN, false, &e, &mut store).unwrap();
        assert_eq!(power.active_guid(), Some(BALANCED.into()));
    }

    #[test]
    fn power_plan_already_on_is_noop() {
        let reg = MemRegistry::default();
        let power = MemPowerCfg::with(&[(BALANCED, "Balanced", false), (HIGH, "High performance", true)]);
        let mut store = SnapshotStore::in_memory();
        apply_one(POWER_PLAN, true, &env(&reg, &power), &mut store).unwrap();
        assert!(store.get(POWER_PLAN).is_none());
        assert!(power.set_calls.borrow().is_empty());
    }

    #[test]
    fn powercfg_failure_shows_unknown_with_reason() {
        let reg = MemRegistry::default();
        let power = default_power();
        power.fail.set(true);
        let mut store = SnapshotStore::in_memory();
        let e = env(&reg, &power);
        let list = read_all(&e, &store);
        assert_eq!(list[0].state, "unknown");
        assert!(list[0].detail.as_deref().unwrap_or("").contains("powercfg"));
        assert!(apply_one(POWER_PLAN, true, &e, &mut store).is_err());
        assert!(store.get(POWER_PLAN).is_none(), "ohne Änderung keine Sicherung");
    }

    #[test]
    fn registry_error_blocks_change_and_snapshot() {
        let reg = MemRegistry::default();
        reg.fail.set(true);
        let power = default_power();
        let mut store = SnapshotStore::in_memory();
        let e = env(&reg, &power);
        assert!(apply_one(GAME_MODE, true, &e, &mut store).is_err());
        assert!(store.get(GAME_MODE).is_none());
        let list = read_all(&e, &store);
        assert_eq!(state_of(&list, GAME_MODE), ("unknown".into(), false));
        assert!(list[1].detail.is_some(), "Fehlergrund als Hinweis");
    }

    #[test]
    fn failed_persist_leaves_windows_untouched() {
        let reg = MemRegistry::with(&[(KEY_GAMECONFIG, "GameDVR_Enabled", RegVal::Dword(1))]);
        let power = default_power();
        let mut store = SnapshotStore::with_persist(Snapshots::new(), Box::new(|_| Err("Datenbank zu".into())));
        let err = apply_one(GAME_DVR, true, &env(&reg, &power), &mut store).unwrap_err();
        assert!(err.contains("Sicherung"), "{err}");
        assert_eq!(reg.dword(KEY_GAMECONFIG, "GameDVR_Enabled"), Some(1));
        assert!(store.get(GAME_DVR).is_none());
    }

    #[test]
    fn apply_many_dedupes_and_reports_unknown_ids() {
        let reg = MemRegistry::default();
        let power = default_power();
        let mut store = SnapshotStore::in_memory();
        let ids = vec!["gameMode".to_string(), "gameMode".into(), "foo".into(), " ".into()];
        let report = apply_many(&ids, true, &env(&reg, &power), &mut store);
        assert_eq!(report.applied, vec!["gameMode".to_string()]);
        assert_eq!(report.failed.len(), 1);
        assert_eq!(report.failed[0].id, "foo");
        assert!(report.failed[0].error.contains("Unbekannte Optimierung"));
    }

    #[test]
    fn revert_all_restores_everything_and_drops_stale_entries() {
        let reg = MemRegistry::with(&[(KEY_MOUSE, "MouseSpeed", RegVal::Str("1".into()))]);
        let power = default_power();
        let mut store = SnapshotStore::in_memory();
        let e = env(&reg, &power);
        // Nur die Nicht-Admin-Optimierungen (Admin-Optimierungen haben eigene Tests)
        let ids: Vec<String> = [POWER_PLAN, GAME_MODE, GAME_DVR, MOUSE_ACCEL].iter().map(|s| s.to_string()).collect();
        let report = apply_many(&ids, true, &e, &mut store);
        assert_eq!(report.applied.len(), 4, "{:?}", report.failed);
        assert_eq!(store.ids().len(), 4);
        store.insert("alt", BTreeMap::new()).unwrap();
        mouse_calls();

        let report = revert_all(&e, &mut store);
        assert_eq!(report.applied.len(), 4);
        assert!(report.failed.is_empty());
        assert!(store.ids().is_empty(), "auch der alte Eintrag ist weg");
        assert_eq!(power.active_guid(), Some(BALANCED.into()));
        assert_eq!(reg.string(KEY_MOUSE, "MouseSpeed"), Some("1".into()));
        assert!(!reg.has(KEY_MOUSE, "MouseThreshold1"), "fehlte vorher → wieder weg");
        assert!(!reg.has(KEY_GAMEBAR, "AutoGameModeEnabled"));
        assert!(!reg.has(KEY_GAMECONFIG, "GameDVR_Enabled"));
        assert_eq!(mouse_calls(), vec![[6, 10, 1]]);
        for t in read_all(&e, &store) {
            assert!(!t.can_revert);
            assert_ne!(t.state, "on", "{}", t.id);
        }
    }

    // ---------------------------------------------------------------------------------------
    // Admin-Optimierungen (nagle, netThrottle)
    // ---------------------------------------------------------------------------------------

    const GUID: &str = "{4d36e972-e325-11ce-bfc1-08002be10318}";

    /// Registrierung mit den Schlüsseln, die der (Test-)Helfer öffnen kann.
    fn admin_reg() -> MemRegistry {
        let reg = MemRegistry::default();
        reg.add_key(&interface_key(GUID));
        reg.add_key(elevate::KEY_SYSTEM_PROFILE);
        reg
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn admin_tweaks_apply_and_revert_with_one_prompt() {
        let reg = admin_reg();
        let power = default_power();
        let el = MemElevator::new(&reg);
        let e = env_admin(&reg, &power, &el, Some(GUID));
        let mut store = SnapshotStore::in_memory();
        let key = interface_key(GUID);

        let list = read_all(&e, &store);
        assert_eq!(state_of(&list, NAGLE), ("off".into(), false));
        assert_eq!(state_of(&list, NET_THROTTLE), ("off".into(), false));

        // Beide einschalten → genau eine Windows-Abfrage
        let report = apply_many(&ids(&[NAGLE, NET_THROTTLE]), true, &e, &mut store);
        assert_eq!(el.calls.get(), 1, "eine Abfrage für beide");
        assert_eq!(report.applied.len(), 2, "{:?}", report.failed);
        assert!(report.failed.is_empty());
        assert_eq!(reg.dword(&key, elevate::VAL_TCP_ACK), Some(1));
        assert_eq!(reg.dword(&key, elevate::VAL_NO_DELAY), Some(1));
        assert_eq!(reg.dword(elevate::KEY_SYSTEM_PROFILE, elevate::VAL_THROTTLE), Some(THROTTLE_ON));
        let list = read_all(&e, &store);
        assert_eq!(state_of(&list, NAGLE), ("on".into(), true));
        assert_eq!(state_of(&list, NET_THROTTLE), ("on".into(), true));
        // Sicherung von nagle: Adapter + Originalwerte (hier: fehlten → null)
        let snap = store.get(NAGLE).unwrap();
        assert_eq!(snap.values[SNAP_ADAPTER], Some(RegVal::Str(GUID.into())));
        assert_eq!(snap.values[elevate::VAL_TCP_ACK], None);

        // Schon „on“ → keine Abfrage, nichts gesichert
        el.calls.set(0);
        let report = apply_many(&ids(&[NAGLE, NET_THROTTLE]), true, &e, &mut store);
        assert_eq!(el.calls.get(), 0, "schon on → keine Abfrage");
        assert_eq!(report.applied.len(), 2);

        // Zurückstellen → eine Abfrage, exakte Rückstellung, Sicherungen weg
        el.calls.set(0);
        let report = apply_many(&ids(&[NAGLE, NET_THROTTLE]), false, &e, &mut store);
        assert_eq!(el.calls.get(), 1);
        assert_eq!(report.applied.len(), 2, "{:?}", report.failed);
        assert!(!reg.has(&key, elevate::VAL_TCP_ACK), "Original fehlte → wieder weg");
        assert!(!reg.has(&key, elevate::VAL_NO_DELAY));
        assert!(!reg.has(elevate::KEY_SYSTEM_PROFILE, elevate::VAL_THROTTLE), "Original fehlte → wieder weg");
        assert!(store.get(NAGLE).is_none() && store.get(NET_THROTTLE).is_none());
    }

    #[test]
    fn admin_disable_without_snapshot_uses_defaults() {
        let reg = admin_reg();
        reg.set(&interface_key(GUID), elevate::VAL_TCP_ACK, &RegVal::Dword(1)).unwrap();
        reg.set(&interface_key(GUID), elevate::VAL_NO_DELAY, &RegVal::Dword(1)).unwrap();
        reg.set(elevate::KEY_SYSTEM_PROFILE, elevate::VAL_THROTTLE, &RegVal::Dword(THROTTLE_ON)).unwrap();
        let power = default_power();
        let el = MemElevator::new(&reg);
        let e = env_admin(&reg, &power, &el, Some(GUID));
        let mut store = SnapshotStore::in_memory();

        let report = apply_many(&ids(&[NAGLE, NET_THROTTLE]), false, &e, &mut store);
        assert_eq!(el.calls.get(), 1);
        assert_eq!(report.applied.len(), 2, "{:?}", report.failed);
        // nagle ohne Sicherung: Werte löschen; netThrottle ohne Sicherung: 10
        assert!(!reg.has(&interface_key(GUID), elevate::VAL_TCP_ACK));
        assert_eq!(reg.dword(elevate::KEY_SYSTEM_PROFILE, elevate::VAL_THROTTLE), Some(THROTTLE_DEFAULT));
    }

    #[test]
    fn decline_removes_new_snapshot_and_changes_nothing() {
        let reg = admin_reg();
        let power = default_power();
        let el = MemElevator::new(&reg);
        el.decline.set(true);
        let e = env_admin(&reg, &power, &el, Some(GUID));
        let mut store = SnapshotStore::in_memory();

        let report = apply_many(&ids(&[NAGLE, NET_THROTTLE]), true, &e, &mut store);
        assert_eq!(el.calls.get(), 1);
        assert!(report.applied.is_empty());
        assert_eq!(report.failed.len(), 2);
        assert!(report.failed.iter().all(|f| f.error == elevate::MSG_DECLINED), "{:?}", report.failed);
        assert!(store.get(NAGLE).is_none() && store.get(NET_THROTTLE).is_none(), "neue Sicherungen entfernt");
        assert!(!reg.has(&interface_key(GUID), elevate::VAL_TCP_ACK), "nichts geändert");
        assert!(!reg.has(elevate::KEY_SYSTEM_PROFILE, elevate::VAL_THROTTLE));
    }

    #[test]
    fn busy_helper_keeps_snapshots_and_makes_no_prompt() {
        let reg = admin_reg();
        let power = default_power();
        let el = MemElevator::new(&reg);
        let e = env_admin(&reg, &power, &el, Some(GUID));
        let mut store = SnapshotStore::in_memory();
        // Nach einer Zeitüberschreitung: Sicherung da, Windows zeigt (noch) den alten Wert
        let mut values = BTreeMap::new();
        values.insert(elevate::VAL_THROTTLE.to_string(), None);
        store.insert(NET_THROTTLE, values).unwrap();
        el.busy.set(true);

        let report = revert_all(&e, &mut store);
        assert_eq!(el.calls.get(), 0, "kein zweiter Helfer");
        assert_eq!(report.failed.len(), 1);
        assert_eq!(report.failed[0].error, elevate::MSG_BUSY);
        assert!(store.get(NET_THROTTLE).is_some(), "nicht als „schon zurückgestellt“ entfernt");

        el.busy.set(false);
        let report = revert_all(&e, &mut store);
        assert_eq!(report.applied, vec![NET_THROTTLE.to_string()]);
        assert!(store.get(NET_THROTTLE).is_none());
    }

    #[test]
    fn verify_failure_is_reported_and_snapshot_kept() {
        let reg = admin_reg();
        let power = default_power();
        let el = MemElevator::new(&reg);
        // Meldet Erfolg, ändert aber nichts → Nachkontrolle muss das merken
        el.ignore.set(true);
        let e = env_admin(&reg, &power, &el, Some(GUID));
        let mut store = SnapshotStore::in_memory();

        let report = apply_many(&ids(&[NET_THROTTLE]), true, &e, &mut store);
        assert_eq!(el.calls.get(), 1);
        assert!(report.applied.is_empty());
        assert_eq!(report.failed.len(), 1);
        assert!(report.failed[0].error.contains("nicht übernommen"), "{:?}", report.failed);
        assert!(report.failed[0].error.ends_with(crate::net::dnsctl::RESTORE_HINT), "Sicherung bleibt → Hinweis");
        assert!(store.get(NET_THROTTLE).is_some());
    }

    #[test]
    fn nagle_without_main_adapter_fails_without_prompt() {
        let reg = admin_reg();
        let power = default_power();
        let el = MemElevator::new(&reg);
        let e = env_admin(&reg, &power, &el, None);
        let mut store = SnapshotStore::in_memory();
        let report = apply_many(&ids(&[NAGLE]), true, &e, &mut store);
        assert_eq!(el.calls.get(), 0, "ohne Hauptverbindung keine Abfrage");
        assert_eq!(report.failed.len(), 1);
        assert!(report.failed[0].error.contains("Hauptverbindung"));
        // Zustand ohne Hauptverbindung: unbekannt
        assert_eq!(state_of(&read_all(&e, &store), NAGLE), ("unknown".into(), false));
    }

    const GUID_B: &str = "{5d36e972-e325-11ce-bfc1-08002be10318}";

    #[test]
    fn nagle_refuses_other_adapter_while_backup_exists() {
        let reg = admin_reg();
        reg.add_key(&interface_key(GUID_B));
        let power = default_power();
        let el = MemElevator::new(&reg);
        let mut store = SnapshotStore::in_memory();

        // An A einschalten
        let report = apply_many(&ids(&[NAGLE]), true, &env_admin(&reg, &power, &el, Some(GUID)), &mut store);
        assert_eq!(report.applied, vec![NAGLE.to_string()], "{:?}", report.failed);
        assert_eq!(el.calls.get(), 1);

        // Hauptverbindung ist jetzt B → Einschalten wird abgelehnt, B bleibt unverändert
        let e_b = env_admin(&reg, &power, &el, Some(GUID_B));
        let report = apply_many(&ids(&[NAGLE]), true, &e_b, &mut store);
        assert_eq!(report.failed.len(), 1);
        assert_eq!(report.failed[0].error, NAGLE_OTHER_ADAPTER);
        assert_eq!(el.calls.get(), 1, "keine Abfrage");
        assert!(!reg.has(&interface_key(GUID_B), elevate::VAL_TCP_ACK));
        assert_eq!(store.get(NAGLE).unwrap().values[SNAP_ADAPTER], Some(RegVal::Str(GUID.into())));

        // Zurückstellen am gesicherten Adapter A, obwohl B die Hauptverbindung ist
        let report = revert_all(&e_b, &mut store);
        assert_eq!(report.applied, vec![NAGLE.to_string()], "{:?}", report.failed);
        assert!(!reg.has(&interface_key(GUID), elevate::VAL_TCP_ACK) && !reg.has(&interface_key(GUID), elevate::VAL_NO_DELAY));
        assert!(store.get(NAGLE).is_none());

        // Danach geht es an B
        let report = apply_many(&ids(&[NAGLE]), true, &e_b, &mut store);
        assert_eq!(report.applied, vec![NAGLE.to_string()], "{:?}", report.failed);
        assert_eq!(reg.dword(&interface_key(GUID_B), elevate::VAL_TCP_ACK), Some(1));
    }

    #[test]
    fn nagle_backup_for_removed_adapter_is_dropped_without_prompt() {
        let reg = admin_reg();
        reg.set(&interface_key(GUID_B), elevate::VAL_TCP_ACK, &RegVal::Dword(1)).unwrap();
        let power = default_power();
        let el = MemElevator::new(&reg);
        let mut store = SnapshotStore::in_memory();
        // An B einschalten (Original: TcpAckFrequency=1, TCPNoDelay fehlte)
        let report = apply_many(&ids(&[NAGLE]), true, &env_admin(&reg, &power, &el, Some(GUID_B)), &mut store);
        assert_eq!(report.applied, vec![NAGLE.to_string()], "{:?}", report.failed);
        assert_eq!(store.get(NAGLE).unwrap().values[elevate::VAL_TCP_ACK], Some(RegVal::Dword(1)));

        // Adapter B wird ausgebaut, Hauptverbindung ist A
        reg.remove_key(&interface_key(GUID_B));
        let report = apply_many(&ids(&[NAGLE]), false, &env_admin(&reg, &power, &el, Some(GUID)), &mut store);
        assert_eq!(el.calls.get(), 1, "nichts mehr zurückzustellen → keine Abfrage");
        assert_eq!(report.applied, vec![NAGLE.to_string()], "{:?}", report.failed);
        assert!(store.get(NAGLE).is_none(), "Sicherung still verworfen");
        assert!(!reg.has(&interface_key(GUID), elevate::VAL_TCP_ACK), "A bleibt unberührt");
    }

    #[test]
    fn revert_all_mixes_ids_with_one_prompt() {
        let reg = admin_reg();
        let power = default_power();
        let el = MemElevator::new(&reg);
        let e = env_admin(&reg, &power, &el, Some(GUID));
        let mut store = SnapshotStore::in_memory();
        mouse_calls();

        // gameMode (ohne Admin) + nagle + netThrottle (Admin) einschalten
        let report = apply_many(&ids(&[GAME_MODE, NAGLE, NET_THROTTLE]), true, &e, &mut store);
        assert_eq!(el.calls.get(), 1, "eine Abfrage für beide Admin-Optimierungen");
        assert_eq!(report.applied.len(), 3, "{:?}", report.failed);
        assert_eq!(store.ids().len(), 3);

        el.calls.set(0);
        let report = revert_all(&e, &mut store);
        assert_eq!(el.calls.get(), 1, "Admin gesammelt mit einer Abfrage");
        assert_eq!(report.applied.len(), 3, "{:?}", report.failed);
        assert!(store.ids().is_empty());
        assert!(!reg.has(KEY_GAMEBAR, "AutoGameModeEnabled"));
        assert!(!reg.has(&interface_key(GUID), elevate::VAL_TCP_ACK));
    }
}
