//! `Pulsar.exe --revert-all`: stellt vor dem Deinstallieren alle von Pulsar an Windows gemachten
//! Änderungen zurück – ohne Fenster.
//!
//! Öffnet die Datenbank im normalen Datenordner (wie die App), stellt den gesicherten DNS und
//! **alle** Sicherungen aus `opt.snapshots` zurück. Die Nicht-Admin-Optimierungen laufen direkt,
//! DNS und die Admin-Optimierungen (`nagle`, `netThrottle`) gesammelt über **einen** Admin-Helfer-
//! Aufruf – also höchstens eine Windows-Abfrage, keine, wenn schon Adminrechte bestehen oder nichts
//! zu tun ist. Erfolgreich zurückgestellte Sicherungen werden entfernt.
//!
//! Gibt es keine Datenbank, endet es sofort mit 0 und legt nichts an. Eine beschädigte Datenbank
//! wird hier **nicht** aus einem Backup wiederhergestellt (das kennt neuere Sicherungen nicht):
//! Sie ergibt Exit-Code 1, damit der Deinstaller die Daten behält.
//!
//! Exit-Code 0 = alles zurückgestellt oder nichts zu tun, 1 = etwas ist übrig geblieben oder
//! Pulsar weiß nicht sicher, ob alles zurückgestellt ist (Marke `opt.recoveryUnknown`).
#![cfg_attr(not(windows), allow(dead_code))]

use std::path::PathBuf;
use std::sync::Arc;

use crate::error::CmdResult;
use crate::net::dnsctl::DnsSys;
use crate::opt::tweaks::{self, Env, SnapshotStore};
use crate::state::{Core, Paths, Shared, DEFAULT_PROFILE};

/// Datenordner wie die App (`dirs::data_dir()/<IDENTIFIER>`, lokal `dirs::data_local_dir()/…`).
fn data_paths() -> Paths {
    let dir = |base: Option<PathBuf>| base.unwrap_or_else(std::env::temp_dir).join(crate::IDENTIFIER);
    Paths::new(dir(dirs::data_dir()), dir(dirs::data_local_dir()))
}

/// Datenbank öffnen und einen schlanken Zustand aufbauen (ohne die volle App/Tauri). Ohne
/// Wiederherstellung aus einem Backup: Lässt sich die Datenbank nicht öffnen, ist das ein Fehler.
fn open_core(paths: Paths) -> CmdResult<Shared> {
    let core: Shared = Arc::new(Core::new(paths, false));
    let db = crate::db::Db::open(&core.paths.db_path(DEFAULT_PROFILE))?;
    core.db.replace(Some(db));
    Ok(core)
}

/// Ließen sich die Sicherungen nach einer beschädigten Datenbank nicht lesen (Marke gesetzt)?
fn recovery_unknown(core: &Shared) -> bool {
    core.db
        .with(|db| db.kv_get(crate::backup::KV_RECOVERY_UNKNOWN))
        .map(|v| !v.is_null())
        .unwrap_or(true)
}

/// Einstiegspunkt für `--revert-all`. Liefert den Exit-Code (0 = fertig/nichts zu tun, 1 = Rest).
pub fn main() -> i32 {
    main_with(data_paths())
}

fn main_with(paths: Paths) -> i32 {
    // Ohne Datenbank hat Pulsar nichts geändert – nichts anlegen, sofort fertig
    if !paths.db_path(DEFAULT_PROFILE).is_file() {
        return 0;
    }
    let core = match open_core(paths) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("--revert-all: {e}");
            return 1;
        }
    };
    let result = revert_all(&core);
    // Nach einer beschädigten Datenbank kann es Änderungen ohne Sicherung geben – dann nie „fertig“
    if recovery_unknown(&core) {
        eprintln!("--revert-all: Die Datenbank war beschädigt – Pulsar weiß nicht sicher, ob alles zurückgestellt ist.");
        return 1;
    }
    match result {
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
        revert_with(core, &crate::opt::env(), &crate::net::dnsctl::WinDnsSys)
    }
    #[cfg(not(windows))]
    {
        // Nur Windows kann zurückstellen – hier bleibt alles, wie es ist
        Ok(true)
    }
}

/// Zurückstellen: Nicht-Admin-Optimierungen direkt, DNS + Admin-Optimierungen in **einem**
/// Helfer-Aufruf (wie `net_auto_restore`). Nach jedem Ergebnis außer „abgelehnt“ werden zuerst die
/// zurückgestellten Sicherungen entfernt. `Ok(true)` = etwas blieb übrig.
fn revert_with(core: &Shared, env: &Env, sys: &dyn DnsSys) -> CmdResult<bool> {
    let _change = crate::elevate::change_lock();
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
        if let Err(e) = tweaks::apply_one(&id, false, env, &mut store) {
            eprintln!("--revert-all: {id}: {e}");
            left = true;
        }
    }

    // Admin-Optimierungen + DNS gesammelt über EINEN Admin-Helfer-Aufruf
    let report = crate::net::dnsctl::restore_admin_and_dns(core, env, sys, &mut store)?;
    for f in &report.failed {
        eprintln!("--revert-all: {}: {}", f.id, f.error);
        left = true;
    }
    if report.declined {
        eprintln!("--revert-all: {}", crate::elevate::MSG_DECLINED);
        left = true;
    }
    if let Some(e) = &report.dns_error {
        eprintln!("--revert-all: DNS: {e}");
        left = true;
    }

    if !crate::net::read_dns_backups(core)?.is_empty() || !store.ids().is_empty() {
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
    fn missing_database_exits_without_creating_anything() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = crate::state::test_paths(tmp.path());
        let db = paths.db_path(DEFAULT_PROFILE);
        assert_eq!(main_with(paths), 0);
        assert!(!db.exists(), "keine neue Datenbank");
        assert!(!tmp.path().join("data").exists(), "kein neuer Datenordner");
    }

    #[test]
    fn corrupt_database_is_not_recovered_and_reports_rest() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = crate::state::test_paths(tmp.path());
        let db_path = paths.db_path(DEFAULT_PROFILE);
        {
            // Backup ohne DNS-Sicherung, danach eine echte Sicherung – dann geht die Datei kaputt
            let db = crate::db::Db::open(&db_path).unwrap();
            crate::backup::backup_db(&db, &paths.backups_dir(DEFAULT_PROFILE)).unwrap();
            db.kv_set(crate::net::dns::KV_DNS_BACKUP, &json!({ A: { "adapter": "Ethernet" } })).unwrap();
        }
        std::fs::write(&db_path, vec![0x42u8; 8192]).unwrap();
        assert_eq!(main_with(paths), 1, "nie „alles zurückgestellt“ mit einem Backup von gestern");
        assert_eq!(std::fs::read(&db_path).unwrap(), vec![0x42u8; 8192], "beschädigte Datei bleibt unangetastet");
    }

    #[test]
    fn unknown_backups_after_recovery_report_rest() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = crate::state::test_paths(tmp.path());
        let core = open_core(paths.clone()).unwrap();
        core.db.with(|db| db.kv_set(crate::backup::KV_RECOVERY_UNKNOWN, &json!({ "at": 1 }))).unwrap();
        drop(core);
        assert_eq!(main_with(paths), 1);
    }

    /// Registrierung mit Adapter `A` (IPv4/IPv6) und dem Schlüssel für `netThrottle`.
    fn admin_reg() -> crate::opt::registry::MemRegistry {
        let reg = crate::opt::registry::MemRegistry::default();
        reg.add_key(&format!("{}\\{A}", crate::elevate::KEY_INTERFACES));
        reg.add_key(&format!("{}\\{A}", crate::elevate::KEY_INTERFACES6));
        reg.add_key(crate::elevate::KEY_SYSTEM_PROFILE);
        reg
    }

    const A: &str = "{4d36e972-e325-11ce-bfc1-08002be10318}";

    #[test]
    fn revert_with_restores_dns_and_all_tweaks_with_one_prompt() {
        use crate::elevate::MemElevator;
        use crate::net::dnsctl::{auto_optimize, DnsPlan, MemDnsSys};
        use crate::net::types::DnsConfig;
        use crate::opt::power::{MemPowerCfg, BALANCED};

        let tmp = tempfile::tempdir().unwrap();
        let core = core_with(tmp.path());
        let reg = admin_reg();
        let power = MemPowerCfg::with(&[(BALANCED, "Balanced", true)]);
        let el = MemElevator::new(&reg);
        let env = Env { reg: &reg, hklm: &reg, power: &power, elevator: &el, apply_mouse: |_| Ok(()), main_adapter: Some(A.into()) };
        let sys = MemDnsSys::new(&reg, Some(A));
        let cfg = DnsConfig { adapter_id: A.into(), adapter: "Ethernet".into(), can_change: true, ..Default::default() };
        let plan = DnsPlan::Apply(crate::net::dns::provider("google").unwrap(), cfg);
        let ids: Vec<String> = ["gameMode", "nagle", "netThrottle"].iter().map(|s| s.to_string()).collect();
        let rep = auto_optimize(&core, &env, &sys, plan, &ids).unwrap();
        assert!(rep.dns_changed && rep.failed.is_empty(), "{rep:?}");
        assert_eq!(el.calls.get(), 1);

        // Abgelehnt → alles bleibt, Rest wird gemeldet
        el.decline.set(true);
        assert!(revert_with(&core, &env, &sys).unwrap());
        assert_eq!(el.calls.get(), 2);
        assert!(!crate::net::read_dns_backups(&core).unwrap().is_empty());
        assert_eq!(SnapshotStore::load(&core).unwrap().ids(), vec!["nagle".to_string(), "netThrottle".to_string()], "gameMode läuft ohne Abfrage");

        el.decline.set(false);
        assert!(!revert_with(&core, &env, &sys).unwrap(), "nichts übrig");
        assert_eq!(el.calls.get(), 3, "DNS + nagle + netThrottle mit einer Abfrage");
        assert!(crate::net::read_dns_backups(&core).unwrap().is_empty());
        assert!(SnapshotStore::load(&core).unwrap().ids().is_empty());
        assert_eq!(reg.string(&format!("{}\\{A}", crate::elevate::KEY_INTERFACES), "NameServer").as_deref(), Some(""));
    }

    #[test]
    fn revert_with_reports_dns_rest() {
        use crate::elevate::MemElevator;
        use crate::net::dnsctl::MemDnsSys;
        use crate::opt::power::{MemPowerCfg, BALANCED};
        use crate::opt::registry::{RegVal, Registry};

        let tmp = tempfile::tempdir().unwrap();
        let core = core_with(tmp.path());
        let reg = admin_reg();
        let key = format!("{}\\{A}", crate::elevate::KEY_INTERFACES);
        reg.set(&key, "NameServer", &RegVal::Str("1.1.1.1".into())).unwrap();
        core.db
            .with(|db| {
                db.kv_set(
                    crate::net::dns::KV_DNS_BACKUP,
                    &json!({ A: { "adapter": "Ethernet", "v4": { "dhcp": true, "servers": [] }, "v6": { "dhcp": true, "servers": [] }, "savedAt": 1 } }),
                )
            })
            .unwrap();
        let power = MemPowerCfg::with(&[(BALANCED, "Balanced", true)]);
        let el = MemElevator::new(&reg);
        el.ignore.set(true);
        let env = Env { reg: &reg, hklm: &reg, power: &power, elevator: &el, apply_mouse: |_| Ok(()), main_adapter: Some(A.into()) };
        let sys = MemDnsSys::new(&reg, Some(A));
        assert!(revert_with(&core, &env, &sys).unwrap(), "Windows hat nichts übernommen → Rest");
        assert!(!crate::net::read_dns_backups(&core).unwrap().is_empty(), "Sicherung bleibt");
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
