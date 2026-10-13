//! Optimieren: Windows-Einstellungen für Spiele (mit Sicherung und „Rückgängig“), Energiepläne
//! und der Boost-Modus. Alles läuft ohne Adminrechte: nur HKCU, `powercfg`, die Priorität der
//! eigenen Spielprozesse und `ipconfig /flushdns`.
//!
//! Befehle und Events stehen in `docs/API.md`. Unter Linux/macOS (Entwicklung, Tests) melden die
//! Befehle „Nur unter Windows verfügbar.“; die Logik selbst ist dort über Schnittstellen testbar.

pub mod boost;
pub mod power;
pub mod registry;
pub mod shell;
pub mod tweaks;
pub mod types;

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, State};

use crate::error::{blocking, CmdResult, LockExt};
use crate::state::Shared;
use boost::Changes;
#[cfg(windows)]
use power::PowerCfg;
use types::*;

/// Name des Ereignisses mit dem Boost-Zustand.
pub const EVENT_BOOST_STATE: &str = "boost://state";

#[derive(Default)]
struct BoostRuntime {
    state: BoostState,
    changes: Changes,
}

/// Laufzeit-Zustand (aktiver Boost samt dem, was er geändert hat).
#[derive(Default)]
pub struct OptState {
    boost: Mutex<BoostRuntime>,
}

impl OptState {
    /// Aktueller Boost-Zustand (Kopie).
    pub fn boost_state(&self) -> BoostState {
        self.boost.lock_safe().state.clone()
    }

    /// Boost als aktiv merken.
    #[cfg_attr(not(windows), allow(dead_code))]
    fn activate(&self, state: BoostState, changes: Changes) {
        let mut b = self.boost.lock_safe();
        b.state = state;
        b.changes = changes;
    }

    /// Boost auf „aus“ setzen und die gemerkten Änderungen zum Zurückstellen herausgeben
    /// (`None`, wenn kein Boost lief).
    fn deactivate(&self) -> Option<Changes> {
        let mut b = self.boost.lock_safe();
        if !b.state.active {
            return None;
        }
        b.state = BoostState::default();
        Some(std::mem::take(&mut b.changes))
    }
}

// Echte Systemzugriffe (nur Windows)
#[cfg(windows)]
static REG: registry::Hkcu = registry::Hkcu;
#[cfg(windows)]
static HKLM: registry::HklmRead = registry::HklmRead;
#[cfg(windows)]
static POWER: power::PowerCfgCli = power::PowerCfgCli;
#[cfg(windows)]
static ELEVATOR: crate::elevate::RealElevator = crate::elevate::RealElevator;

/// Zugriff auf das echte System (GUID der Hauptverbindung einmal für `nagle` nachschlagen).
#[cfg(windows)]
pub fn env() -> tweaks::Env<'static> {
    let main_adapter = crate::net::adapters::primary_adapter_guid(&crate::net::adapters::read_raw().unwrap_or_default());
    tweaks::Env {
        reg: &REG,
        hklm: &HKLM,
        power: &POWER,
        elevator: &ELEVATOR,
        apply_mouse: tweaks::apply_mouse_now,
        main_adapter,
    }
}

/// Beim Beenden der App aufrufen (z. B. aus `native::finalize`): stellt einen noch laufenden Boost
/// zurück (Energieplan, Prioritäten), damit nichts „hängen bleibt“. Blockierend, kein Fehler.
pub fn shutdown(core: &crate::state::Core) {
    let Some(changes) = core.opt.deactivate() else { return };
    #[cfg(windows)]
    for e in boost::stop(&changes, &POWER) {
        eprintln!("Boost: {e}");
    }
    #[cfg(not(windows))]
    let _ = changes;
}

// =============================================================================================
// Optimierungen
// =============================================================================================

#[tauri::command]
pub async fn opt_tweaks(state: State<'_, Shared>) -> CmdResult<Vec<Tweak>> {
    let core = state.inner().clone();
    blocking(move || {
        #[cfg(windows)]
        {
            let store = tweaks::SnapshotStore::load(&core)?;
            Ok(tweaks::read_all(&env(), &store))
        }
        #[cfg(not(windows))]
        {
            let _ = core;
            Ok(tweaks::unsupported_list())
        }
    })
    .await
}

#[tauri::command]
pub async fn opt_apply(state: State<'_, Shared>, ids: Vec<String>, enable: bool) -> CmdResult<ApplyReport> {
    let core = state.inner().clone();
    blocking(move || {
        #[cfg(windows)]
        {
            let mut store = tweaks::SnapshotStore::load(&core)?;
            Ok(tweaks::apply_many(&ids, enable, &env(), &mut store))
        }
        #[cfg(not(windows))]
        {
            let _ = (core, enable);
            Ok(tweaks::unsupported_report(&ids))
        }
    })
    .await
}

#[tauri::command]
pub async fn opt_revert_all(state: State<'_, Shared>) -> CmdResult<ApplyReport> {
    let core = state.inner().clone();
    blocking(move || {
        #[cfg(windows)]
        {
            let mut store = tweaks::SnapshotStore::load(&core)?;
            Ok(tweaks::revert_all(&env(), &mut store))
        }
        #[cfg(not(windows))]
        {
            let _ = core;
            // Außerhalb von Windows wird nichts geändert – also gibt es nichts zurückzustellen
            Ok(ApplyReport::default())
        }
    })
    .await
}

// =============================================================================================
// Energiepläne, DNS
// =============================================================================================

#[tauri::command]
pub async fn opt_power_plans() -> CmdResult<Vec<PowerPlan>> {
    #[cfg(windows)]
    {
        blocking(|| POWER.list()).await
    }
    #[cfg(not(windows))]
    {
        Err(tweaks::NOT_WINDOWS.into())
    }
}

#[tauri::command]
pub async fn opt_power_set(guid: String) -> CmdResult<()> {
    let guid = power::normalize_guid(&guid)?;
    #[cfg(windows)]
    {
        blocking(move || POWER.set_active(&guid)).await
    }
    #[cfg(not(windows))]
    {
        let _ = guid;
        Err(tweaks::NOT_WINDOWS.into())
    }
}

#[tauri::command]
pub async fn opt_flush_dns() -> CmdResult<()> {
    #[cfg(windows)]
    {
        blocking(boost::flush_dns).await
    }
    #[cfg(not(windows))]
    {
        Err(tweaks::NOT_WINDOWS.into())
    }
}

// =============================================================================================
// Boost
// =============================================================================================

#[tauri::command]
pub async fn boost_start(
    app: AppHandle,
    state: State<'_, Shared>,
    profile: BoostProfile,
    game_id: Option<String>,
    pid: Option<u32>,
) -> CmdResult<BoostState> {
    #[cfg(not(windows))]
    {
        let _ = (app, state, profile, game_id, pid);
        Err(tweaks::NOT_WINDOWS.into())
    }
    #[cfg(windows)]
    {
        let core = state.inner().clone();
        // Läuft schon ein Boost? Erst sauber beenden (Energieplan und Prioritäten zurück).
        if let Some(changes) = core.opt.deactivate() {
            blocking(move || {
                for e in boost::stop(&changes, &POWER) {
                    eprintln!("Boost: {e}");
                }
                Ok(())
            })
            .await?;
        }
        let game_id = game_id.map(|g| g.trim().to_string()).filter(|g| !g.is_empty());
        let wants_priority = boost::priority_class(&profile.game_priority)
            .map(|c| c != boost::PRIO_NORMAL)
            .unwrap_or(false);
        let pids = if wants_priority {
            boost::resolve_pids(&core, game_id.as_deref(), pid).await
        } else {
            Ok(Vec::new())
        };
        let outcome = blocking(move || Ok(boost::start(&profile, pids, &POWER))).await?;
        if !outcome.actions.is_empty() && outcome.actions.iter().all(|a| !a.ok) {
            let reason = outcome.actions.first().map(|a| a.detail.clone()).unwrap_or_default();
            let _ = app.emit(EVENT_BOOST_STATE, &core.opt.boost_state());
            return Err(format!("Der Boost konnte nicht gestartet werden: {reason}"));
        }
        let st = BoostState {
            active: true,
            since: Some(crate::util::now_ms()),
            game_id,
            actions: outcome.actions,
        };
        core.opt.activate(st.clone(), outcome.changes);
        let _ = app.emit(EVENT_BOOST_STATE, &st);
        Ok(st)
    }
}

#[tauri::command]
pub async fn boost_stop(app: AppHandle, state: State<'_, Shared>) -> CmdResult<BoostState> {
    let core = state.inner().clone();
    let changes = core.opt.deactivate();
    let errors: Vec<String> = {
        #[cfg(windows)]
        {
            match changes {
                Some(changes) => blocking(move || Ok(boost::stop(&changes, &POWER))).await?,
                None => Vec::new(),
            }
        }
        #[cfg(not(windows))]
        {
            let _ = changes;
            Vec::new()
        }
    };
    let st = core.opt.boost_state();
    let _ = app.emit(EVENT_BOOST_STATE, &st);
    match errors.into_iter().next() {
        Some(e) => Err(e),
        None => Ok(st),
    }
}

#[tauri::command]
pub async fn boost_state(state: State<'_, Shared>) -> CmdResult<BoostState> {
    Ok(state.opt.boost_state())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opt_state_tracks_boost_lifecycle() {
        let opt = OptState::default();
        assert!(!opt.boost_state().active);
        assert!(opt.deactivate().is_none(), "ohne Boost nichts zurückzustellen");

        let changes = Changes { prev_plan: Some(power::BALANCED.into()), priorities: vec![(7, boost::PRIO_NORMAL)] };
        let st = BoostState { active: true, since: Some(1), game_id: Some("g".into()), actions: Vec::new() };
        opt.activate(st, changes);
        assert!(opt.boost_state().active);
        assert_eq!(opt.boost_state().game_id.as_deref(), Some("g"));

        let taken = opt.deactivate().expect("Änderungen zurückgeben");
        assert_eq!(taken.prev_plan.as_deref(), Some(power::BALANCED));
        assert_eq!(taken.priorities, vec![(7, boost::PRIO_NORMAL)]);
        let after = opt.boost_state();
        assert!(!after.active);
        assert!(after.since.is_none() && after.game_id.is_none() && after.actions.is_empty());
        assert!(opt.deactivate().is_none());
    }
}
