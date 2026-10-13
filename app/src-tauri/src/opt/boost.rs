//! Boost-Modus: Energieplan „Höchstleistung“, Priorität der Spielprozesse und DNS-Zwischenspeicher –
//! alles ohne Adminrechte. Was geändert wurde, wird gemerkt und beim Stoppen zurückgestellt.
#![cfg_attr(not(windows), allow(dead_code))]

use std::time::{Duration, Instant};

use super::power::{self, PowerCfg};
#[cfg(windows)]
use super::shell;
use super::types::{BoostAction, BoostProfile};
use crate::error::CmdResult;
use crate::models::RunningGame;
use crate::state::Shared;

/// Windows-Prioritätsklassen (Werte wie `PROCESS_CREATION_FLAGS`).
pub const PRIO_NORMAL: u32 = 0x0000_0020;
pub const PRIO_ABOVE: u32 = 0x0000_8000;
pub const PRIO_HIGH: u32 = 0x0000_0080;

/// So lange wartet der Boost auf das gerade gestartete Spiel, bevor er die Priorität aufgibt.
const WAIT_FOR_GAME: Duration = Duration::from_secs(5);
const WAIT_STEP: Duration = Duration::from_millis(500);

// =============================================================================================
// Reine Hilfsfunktionen (getestet)
// =============================================================================================

/// `"normal" | "above" | "high"` → Prioritätsklasse; `None` bei unbekanntem Text.
pub fn priority_class(s: &str) -> Option<u32> {
    match s.trim().to_ascii_lowercase().as_str() {
        "normal" => Some(PRIO_NORMAL),
        "above" => Some(PRIO_ABOVE),
        "high" => Some(PRIO_HIGH),
        _ => None,
    }
}

/// Anzeigename einer Prioritätsklasse.
pub fn priority_label(class: u32) -> &'static str {
    match class {
        PRIO_HIGH => "Hoch",
        PRIO_ABOVE => "Über Normal",
        _ => "Normal",
    }
}

/// Zielprozesse: `pid`, sonst die Prozesse des Spiels `game_id`, sonst alle laufenden Spiele.
pub fn select_pids(pid: Option<u32>, game_id: Option<&str>, running: &[RunningGame]) -> Result<Vec<u32>, String> {
    if let Some(p) = pid {
        return if p == 0 { Err("Ungültige Prozess-ID.".into()) } else { Ok(vec![p]) };
    }
    let mut pids: Vec<u32> = match game_id.map(str::trim).filter(|g| !g.is_empty()) {
        Some(g) => match running.iter().find(|r| r.game_id == g) {
            Some(r) if !r.pids.is_empty() => r.pids.clone(),
            _ => return Err("Das Spiel läuft gerade nicht.".into()),
        },
        None => running.iter().flat_map(|r| r.pids.iter().copied()).collect(),
    };
    pids.retain(|p| *p != 0);
    pids.sort_unstable();
    pids.dedup();
    if pids.is_empty() {
        return Err("Es läuft gerade kein Spiel.".into());
    }
    Ok(pids)
}

fn count_text(n: usize) -> String {
    if n == 1 {
        "1 Prozess".into()
    } else {
        format!("{n} Prozesse")
    }
}

fn action(id: &str, ok: bool, detail: String) -> BoostAction {
    BoostAction { id: id.into(), ok, detail }
}

// =============================================================================================
// Ablauf
// =============================================================================================

/// Zielprozesse bestimmen. Wurde ein Spiel genannt, das die Erkennung noch nicht gesehen hat
/// (gerade erst gestartet), wird kurz darauf gewartet.
pub async fn resolve_pids(core: &Shared, game_id: Option<&str>, pid: Option<u32>) -> Result<Vec<u32>, String> {
    let named_game = game_id.map(str::trim).filter(|g| !g.is_empty()).is_some();
    if pid.is_some() || !named_game {
        return select_pids(pid, game_id, &core.tracker.running());
    }
    let deadline = Instant::now() + WAIT_FOR_GAME;
    loop {
        let r = select_pids(None, game_id, &core.tracker.running());
        if r.is_ok() || Instant::now() >= deadline {
            return r;
        }
        tokio::time::sleep(WAIT_STEP).await;
    }
}

/// Was der Boost geändert hat – zum Zurückstellen in `stop`.
#[derive(Debug, Clone, Default)]
pub struct Changes {
    /// GUID des Energieplans vor dem Boost (nur, wenn der Boost ihn gewechselt hat)
    pub prev_plan: Option<String>,
    /// Prozesse mit angehobener Priorität: (PID, vorherige Klasse)
    pub priorities: Vec<(u32, u32)>,
}

/// Ergebnis von `start`.
#[derive(Default)]
pub struct StartOutcome {
    pub actions: Vec<BoostAction>,
    pub changes: Changes,
}

/// Boost ausführen (blockierend). Jeder Schritt wird einzeln gemeldet; ein Fehler stoppt die
/// anderen nicht.
pub fn start(profile: &BoostProfile, pids: Result<Vec<u32>, String>, power: &dyn PowerCfg) -> StartOutcome {
    let mut out = StartOutcome::default();

    if profile.power_plan {
        let (ok, detail) = match power.list() {
            Ok(plans) => {
                let current = power::active(&plans).cloned();
                match current {
                    Some(c) if power::is_performance(&c) => (true, format!("Energieplan „{}“ ist bereits aktiv.", c.name)),
                    _ => match power::activate_performance(power, &plans) {
                        Ok(plan) => {
                            out.changes.prev_plan = current.map(|c| c.guid);
                            (true, format!("Energieplan „{}“ aktiviert.", plan.name))
                        }
                        Err(e) => (false, e),
                    },
                }
            }
            Err(e) => (false, e),
        };
        out.actions.push(action("powerPlan", ok, detail));
    }

    match priority_class(&profile.game_priority) {
        None => out.actions.push(action(
            "priority",
            false,
            format!("Unbekannte Priorität: „{}“", profile.game_priority),
        )),
        // „Normal“ heißt: nichts ändern
        Some(PRIO_NORMAL) => {}
        Some(class) => {
            let (ok, detail) = match pids {
                Err(e) => (false, e),
                Ok(list) => {
                    let mut failed = Vec::new();
                    for pid in &list {
                        match set_priority(*pid, class) {
                            Ok(prev) => out.changes.priorities.push((*pid, prev)),
                            Err(e) => failed.push(e),
                        }
                    }
                    let done = list.len() - failed.len();
                    if done == 0 {
                        let reason = failed
                            .into_iter()
                            .next()
                            .unwrap_or_else(|| "Kein Spielprozess gefunden.".into());
                        (false, reason)
                    } else {
                        let mut d = format!("Priorität „{}“ für {} gesetzt.", priority_label(class), count_text(done));
                        if !failed.is_empty() {
                            d.push_str(&format!(" {} nicht möglich (geschützt).", count_text(failed.len())));
                        }
                        (true, d)
                    }
                }
            };
            out.actions.push(action("priority", ok, detail));
        }
    }

    if profile.flush_dns {
        let (ok, detail) = match flush_dns() {
            Ok(()) => (true, "DNS-Zwischenspeicher geleert.".into()),
            Err(e) => (false, e),
        };
        out.actions.push(action("flushDns", ok, detail));
    }

    out
}

/// Änderungen zurückstellen (bestmöglich). Liefert Fehler, die der Benutzer sehen sollte.
pub fn stop(changes: &Changes, power: &dyn PowerCfg) -> Vec<String> {
    let mut errors = Vec::new();
    // Prozesse, die inzwischen beendet sind, lassen sich nicht öffnen – kein Fehler
    for (pid, prev) in &changes.priorities {
        let _ = set_priority(*pid, *prev);
    }
    if let Some(guid) = &changes.prev_plan {
        if power.set_active(guid).is_err() && power.set_active(power::BALANCED).is_err() {
            errors.push("Der vorherige Energieplan konnte nicht wiederhergestellt werden.".into());
        }
    }
    errors
}

/// `ipconfig /flushdns` ohne Fenster.
pub fn flush_dns() -> CmdResult<()> {
    #[cfg(windows)]
    {
        let out = shell::run_hidden("ipconfig.exe", &["/flushdns"])?;
        if out.success {
            Ok(())
        } else {
            Err(format!("Der DNS-Zwischenspeicher konnte nicht geleert werden: {}", out.message()))
        }
    }
    #[cfg(not(windows))]
    {
        Err(super::tweaks::NOT_WINDOWS.into())
    }
}

/// Prioritätsklasse eines Prozesses setzen; liefert die vorherige Klasse.
/// Geschützte Prozesse (Anti-Cheat, Adminrechte) melden „Zugriff verweigert“.
fn set_priority(pid: u32, class: u32) -> Result<u32, String> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            GetPriorityClass, OpenProcess, SetPriorityClass, PROCESS_CREATION_FLAGS,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_INFORMATION,
        };
        unsafe {
            let handle = OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
                .map_err(|e| match (e.code().0 as u32) & 0xFFFF {
                    5 => format!("Prozess {pid}: Zugriff verweigert (geschützt, z. B. Anti-Cheat, oder läuft als Administrator)."),
                    87 => format!("Prozess {pid} läuft nicht mehr."),
                    _ => format!("Prozess {pid} konnte nicht geöffnet werden: {}", e.message()),
                })?;
            let prev = GetPriorityClass(handle);
            let result = SetPriorityClass(handle, PROCESS_CREATION_FLAGS(class));
            let _ = CloseHandle(handle);
            result.map_err(|e| format!("Die Priorität von Prozess {pid} konnte nicht gesetzt werden: {}", e.message()))?;
            Ok(if prev == 0 { PRIO_NORMAL } else { prev })
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (pid, class);
        Err(super::tweaks::NOT_WINDOWS.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::opt::power::{MemPowerCfg, BALANCED, HIGH, ULTIMATE};

    fn running(entries: &[(&str, &[u32])]) -> Vec<RunningGame> {
        entries
            .iter()
            .map(|(id, pids)| RunningGame { game_id: id.to_string(), started_at: 0, pids: pids.to_vec() })
            .collect()
    }

    #[test]
    fn priority_mapping() {
        assert_eq!(priority_class("normal"), Some(PRIO_NORMAL));
        assert_eq!(priority_class("above"), Some(PRIO_ABOVE));
        assert_eq!(priority_class(" High "), Some(PRIO_HIGH));
        assert_eq!(priority_class("realtime"), None, "Echtzeit gibt es absichtlich nicht");
        assert_eq!(priority_class(""), None);
        assert_eq!(PRIO_NORMAL, 0x20);
        assert_eq!(PRIO_ABOVE, 0x8000);
        assert_eq!(PRIO_HIGH, 0x80);
        assert_eq!(priority_label(PRIO_HIGH), "Hoch");
        assert_eq!(priority_label(PRIO_ABOVE), "Über Normal");
        assert_eq!(priority_label(PRIO_NORMAL), "Normal");
        assert_eq!(priority_label(0), "Normal");
    }

    #[test]
    fn pid_selection() {
        let games = running(&[("a", &[30, 10]), ("b", &[20, 10, 0])]);
        assert_eq!(select_pids(Some(42), Some("a"), &games), Ok(vec![42]));
        assert_eq!(select_pids(Some(0), None, &games), Err("Ungültige Prozess-ID.".into()));
        assert_eq!(select_pids(None, Some("a"), &games), Ok(vec![10, 30]));
        assert_eq!(select_pids(None, Some("b"), &games), Ok(vec![10, 20]), "PID 0 raus, sortiert");
        assert_eq!(select_pids(None, Some("c"), &games), Err("Das Spiel läuft gerade nicht.".into()));
        assert_eq!(select_pids(None, Some("  "), &games), Ok(vec![10, 20, 30]), "leere ID = alle");
        assert_eq!(select_pids(None, None, &games), Ok(vec![10, 20, 30]));
        assert_eq!(select_pids(None, None, &[]), Err("Es läuft gerade kein Spiel.".into()));
        assert_eq!(select_pids(None, Some("a"), &running(&[("a", &[])])), Err("Das Spiel läuft gerade nicht.".into()));
    }

    #[test]
    fn start_switches_plan_and_stop_restores_it() {
        let power = MemPowerCfg::with(&[(BALANCED, "Balanced", true), (HIGH, "High performance", false)]);
        let profile = BoostProfile { power_plan: true, game_priority: "high".into(), flush_dns: false };
        let out = start(&profile, Ok(vec![123]), &power);
        assert_eq!(out.actions.len(), 2);
        let plan = &out.actions[0];
        assert_eq!(plan.id, "powerPlan");
        assert!(plan.ok, "{}", plan.detail);
        assert!(plan.detail.contains("High performance"));
        assert_eq!(out.changes.prev_plan.as_deref(), Some(BALANCED));
        assert_eq!(power.active_guid(), Some(HIGH.into()));
        // Priorität geht außerhalb von Windows nicht – ehrlich melden, nicht abstürzen
        let prio = &out.actions[1];
        assert_eq!(prio.id, "priority");
        assert!(!prio.ok);
        assert!(out.changes.priorities.is_empty());

        assert!(stop(&out.changes, &power).is_empty());
        assert_eq!(power.active_guid(), Some(BALANCED.into()));
    }

    #[test]
    fn start_reports_already_active_plan_without_remembering_it() {
        let power = MemPowerCfg::with(&[(BALANCED, "Balanced", false), (ULTIMATE, "Ultimative Leistung", true)]);
        let profile = BoostProfile { power_plan: true, game_priority: "normal".into(), flush_dns: false };
        let out = start(&profile, Ok(vec![1]), &power);
        assert_eq!(out.actions.len(), 1, "„normal“ = keine Prioritätsaktion");
        assert!(out.actions[0].ok);
        assert!(out.actions[0].detail.contains("bereits aktiv"));
        assert!(out.changes.prev_plan.is_none());
        assert!(power.set_calls.borrow().is_empty());
        assert!(stop(&out.changes, &power).is_empty());
    }

    #[test]
    fn start_passes_through_pid_errors_and_unknown_priority() {
        let power = MemPowerCfg::with(&[(BALANCED, "Balanced", true)]);
        let profile = BoostProfile { power_plan: false, game_priority: "above".into(), flush_dns: false };
        let out = start(&profile, Err("Das Spiel läuft gerade nicht.".into()), &power);
        assert_eq!(out.actions.len(), 1);
        assert_eq!(out.actions[0].id, "priority");
        assert!(!out.actions[0].ok);
        assert_eq!(out.actions[0].detail, "Das Spiel läuft gerade nicht.");

        let profile = BoostProfile { power_plan: false, game_priority: "turbo".into(), flush_dns: false };
        let out = start(&profile, Ok(vec![1]), &power);
        assert!(!out.actions[0].ok);
        assert!(out.actions[0].detail.contains("turbo"));
    }

    #[test]
    fn start_reports_powercfg_failure_and_flush_result() {
        let power = MemPowerCfg::with(&[(BALANCED, "Balanced", true)]);
        power.fail.set(true);
        let profile = BoostProfile { power_plan: true, game_priority: "normal".into(), flush_dns: true };
        let out = start(&profile, Ok(vec![]), &power);
        assert_eq!(out.actions.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), vec!["powerPlan", "flushDns"]);
        assert!(out.actions.iter().all(|a| !a.ok));
        assert!(out.changes.prev_plan.is_none());
        #[cfg(not(windows))]
        assert_eq!(out.actions[1].detail, super::super::tweaks::NOT_WINDOWS);
    }

    #[test]
    fn stop_falls_back_to_balanced_and_reports_total_failure() {
        let power = MemPowerCfg::with(&[(BALANCED, "Balanced", false), (HIGH, "High performance", true)]);
        let changes = Changes { prev_plan: Some("11111111-2222-3333-4444-555555555555".into()), priorities: vec![(1, PRIO_NORMAL)] };
        assert!(stop(&changes, &power).is_empty(), "gelöschter Plan → Ausbalanciert");
        assert_eq!(power.active_guid(), Some(BALANCED.into()));
        power.fail.set(true);
        let errors = stop(&changes, &power);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("Energieplan"));
        assert!(stop(&Changes::default(), &power).is_empty(), "nichts geändert → nichts zu melden");
    }
}
