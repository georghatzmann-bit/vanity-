//! `Pulsar.exe --revert-all`: stellt vor dem Deinstallieren alle von Pulsar an Windows gemachten
//! Änderungen zurück – ohne Fenster.
//!
//! Öffnet die Datenbank im normalen Datenordner (wie die App), stellt den gesicherten DNS und
//! **alle** Sicherungen aus `opt.snapshots` zurück. Die Nicht-Admin-Optimierungen laufen direkt,
//! DNS und die Admin-Optimierungen (`nagle`, `netThrottle`) gesammelt über **einen** Admin-Helfer-
//! Aufruf – also höchstens eine Windows-Abfrage, keine, wenn schon Adminrechte bestehen oder nichts
//! zu tun ist. Erfolgreich zurückgestellte Sicherungen werden entfernt.
//!
//! Exit-Code 0 = alles zurückgestellt oder nichts zu tun, 1 = etwas ist übrig geblieben.
#![cfg_attr(not(windows), allow(dead_code))]

use std::path::PathBuf;
use std::sync::Arc;

use crate::error::CmdResult;
use crate::opt::tweaks::SnapshotStore;
use crate::state::{Core, Paths, Shared, DEFAULT_PROFILE};

/// Datenordner wie die App (`dirs::data_dir()/<IDENTIFIER>`, lokal `dirs::data_local_dir()/…`).
fn data_paths() -> Paths {
    let dir = |base: Option<PathBuf>| base.unwrap_or_else(std::env::temp_dir).join(crate::IDENTIFIER);
    Paths::new(dir(dirs::data_dir()), dir(dirs::data_local_dir()))
}

/// Datenbank öffnen und einen schlanken Zustand aufbauen (ohne die volle App/Tauri).
fn open_core(paths: Paths) -> CmdResult<Shared> {
    let core: Shared = Arc::new(Core::new(paths, false));
    let db = crate::backup::open_with_recovery(&core.paths, DEFAULT_PROFILE)?;
    core.db.replace(Some(db));
    Ok(core)
}

/// Einstiegspunkt für `--revert-all`. Liefert den Exit-Code (0 = fertig/nichts zu tun, 1 = Rest).
pub fn main() -> i32 {
    let core = match open_core(data_paths()) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("--revert-all: {e}");
            return 1;
        }
    };
    match revert_all(&core) {
        Ok(false) => 0,
        Ok(true) => 1,
        Err(e) => {
            eprintln!("--revert-all: {e}");
            1
        }
    }
}

/// Alles zurückstellen. `Ok(true)` = etwas blieb übrig.
fn revert_all(core: &Shared) -> CmdResult<bool> {
    let snaps = SnapshotStore::load(core)?;
    let dns_backups = crate::net::read_dns_backups(core)?;
    // Nichts zu tun → sofort fertig, keine Windows-Abfrage
    if snaps.ids().is_empty() && dns_backups.is_empty() {
        return Ok(false);
    }
    #[cfg(windows)]
    {
        windows_revert(core)
    }
    #[cfg(not(windows))]
    {
        // Nur Windows kann zurückstellen – hier bleibt alles, wie es ist
        Ok(true)
    }
}

/// Zurückstellen unter Windows: Nicht-Admin direkt, DNS + Admin-Optimierungen in einem Aufruf.
#[cfg(windows)]
fn windows_revert(core: &Shared) -> CmdResult<bool> {
    use crate::elevate::{ElevatedTask, Elevator, RealElevator};
    use crate::opt::tweaks;

    let env = crate::opt::env();
    let mut store = SnapshotStore::load(core)?;
    let mut left = false;

    // Nicht-Admin-Optimierungen direkt
    for id in store.ids() {
        if !tweaks::IDS.contains(&id.as_str()) {
            // Rest einer älteren Version – still entfernen
            let _ = store.remove(&id);
            continue;
        }
        if tweaks::is_admin_id(&id) {
            continue;
        }
        if let Err(e) = tweaks::apply_one(&id, false, &env, &mut store) {
            eprintln!("--revert-all: {id}: {e}");
            left = true;
        }
    }

    // Admin-Optimierungen + DNS gesammelt über EINEN Admin-Helfer-Aufruf
    let admin: Vec<String> = store.ids().into_iter().filter(|id| tweaks::is_admin_id(id)).collect();
    let batch = tweaks::prepare_admin(&admin, false, &env, &mut store);
    let mut backups = crate::net::read_dns_backups(core)?;
    let (dns_ops, pruned) = crate::net::dnsctl::restore_ops(&mut backups);
    if pruned {
        crate::net::write_dns_backups(core, &backups)?;
    }

    let task = ElevatedTask { dns: dns_ops, reg: batch.reg_ops() };
    let outcome = if task.is_empty() { Ok(()) } else { RealElevator.run(&task) };

    let (_applied, failed) = batch.settle(&outcome, &env, &mut store);
    if !failed.is_empty() {
        left = true;
    }

    match &outcome {
        Err(e) => {
            eprintln!("--revert-all: DNS: {e}");
            left = true;
        }
        Ok(()) => {
            let ids: Vec<String> = backups.keys().cloned().collect();
            for id in ids {
                if crate::net::dnsctl::restored(&id, &backups[&id]) {
                    backups.remove(&id);
                }
            }
            crate::net::write_dns_backups(core, &backups)?;
            let _ = crate::opt::boost::flush_dns();
        }
    }

    if !backups.is_empty() || !store.ids().is_empty() {
        left = true;
    }
    Ok(left)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn core_with(root: &std::path::Path) -> Shared {
        open_core(crate::state::test_paths(root)).unwrap()
    }

    #[test]
    fn nothing_to_do_exits_without_work() {
        let tmp = tempfile::tempdir().unwrap();
        let core = core_with(tmp.path());
        // Leere Datenbank → nichts zurückzustellen
        assert!(!revert_all(&core).unwrap());
    }

    #[test]
    fn leftover_snapshot_reports_work_remaining_off_windows() {
        let tmp = tempfile::tempdir().unwrap();
        let core = core_with(tmp.path());
        core.db
            .with(|db| db.kv_set("opt.snapshots", &json!({ "gameMode": { "values": { "AutoGameModeEnabled": null }, "savedAt": 1 } })))
            .unwrap();
        // Außerhalb von Windows kann nichts zurückgestellt werden → etwas bleibt übrig
        #[cfg(not(windows))]
        assert!(revert_all(&core).unwrap());
        // Datenbank unverändert lesbar
        assert!(!SnapshotStore::load(&core).unwrap().ids().is_empty());
    }
}
