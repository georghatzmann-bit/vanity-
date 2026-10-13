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
use super::registry::{self, RegVal, Registry};
use super::types::{ApplyReport, PowerPlan, Tweak, TweakError};
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
/// Alle Optimierungen in Anzeigereihenfolge.
pub const IDS: [&str; 4] = [POWER_PLAN, GAME_MODE, GAME_DVR, MOUSE_ACCEL];

struct Def {
    id: &'static str,
    category: &'static str,
    impact: &'static str,
}

/// Katalog (Kategorie und ehrliche Wirkungsstufe laut `docs/API.md`).
const DEFS: [Def; 4] = [
    Def { id: POWER_PLAN, category: "power", impact: "medium" },
    Def { id: GAME_MODE, category: "windows", impact: "low" },
    Def { id: GAME_DVR, category: "windows", impact: "medium" },
    Def { id: MOUSE_ACCEL, category: "input", impact: "medium" },
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
    pub reg: &'a dyn Registry,
    pub power: &'a dyn PowerCfg,
    /// Mausparameter sofort anwenden: `[Schwelle 1, Schwelle 2, Beschleunigung]` (wie `SPI_SETMOUSE`).
    pub apply_mouse: fn([i32; 3]) -> CmdResult<()>,
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
    }
}

/// Aktuellen Zustand aller Optimierungen lesen (`powercfg` wird nur einmal aufgerufen).
pub fn read_all(env: &Env, store: &SnapshotStore) -> Vec<Tweak> {
    let plans = env.power.list();
    DEFS.iter()
        .map(|d| {
            let (state, detail) = if d.id == POWER_PLAN {
                power_state(&plans)
            } else {
                match slots(d.id).map(|s| read_slots(env.reg, s)) {
                    Some(Ok(values)) => (reg_state(d.id, &values), None),
                    Some(Err(e)) => (St::Unknown, Some(e)),
                    None => (St::Unknown, None),
                }
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

/// Mehrere Optimierungen; doppelte IDs werden nur einmal bearbeitet.
pub fn apply_many(ids: &[String], enable: bool, env: &Env, store: &mut SnapshotStore) -> ApplyReport {
    let mut report = ApplyReport::default();
    for id in unique_ids(ids) {
        match apply_one(&id, enable, env, store) {
            Ok(()) => report.applied.push(id),
            Err(error) => report.failed.push(TweakError { id, error }),
        }
    }
    report
}

/// Alle gesicherten Originalwerte wiederherstellen.
pub fn revert_all(env: &Env, store: &mut SnapshotStore) -> ApplyReport {
    let mut report = ApplyReport::default();
    for id in store.ids() {
        if !IDS.contains(&id.as_str()) {
            // Rest einer älteren Version – still entfernen
            let _ = store.remove(&id);
            continue;
        }
        match apply_one(&id, false, env, store) {
            Ok(()) => report.applied.push(id),
            Err(error) => report.failed.push(TweakError { id, error }),
        }
    }
    report
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

    fn env<'a>(reg: &'a MemRegistry, power: &'a MemPowerCfg) -> Env<'a> {
        Env { reg, power, apply_mouse: record_mouse }
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
        for t in &list {
            assert!(["power", "windows", "input"].contains(&t.category.as_str()), "{}", t.category);
            assert!(["high", "medium", "low"].contains(&t.impact.as_str()), "{}", t.impact);
            assert_eq!(t.state, "unsupported");
            assert!(!t.can_revert);
            assert!(t.detail.is_none());
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
        let ids: Vec<String> = IDS.iter().map(|s| s.to_string()).collect();
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
}
