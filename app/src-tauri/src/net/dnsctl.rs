//! DNS einstellen und zurückstellen: `net_dns_apply`, `net_dns_restore`, `net_auto_optimize`,
//! `net_auto_restore` und der DNS-Teil von `--revert-all`.
//!
//! Die Abläufe hängen nicht an Windows: Der Admin-Helfer kommt über [`Elevator`], das Lesen der
//! Adapter über [`DnsSys`]. Unter Windows sind das nur dünne Hüllen ([`WinDnsSys`] und
//! `RealElevator`); in den Tests laufen dieselben Abläufe mit einer Registrierung im Speicher.
//!
//! Regeln (Vertrag in `docs/API.md`, Abschnitt „DNS automatisch einstellen“):
//! - Eine vorhandene Sicherung wird nie überschrieben (das Original zählt).
//! - Pulsar ändert den DNS nur, wenn sich die Sicherung später sicher zurückstellen lässt:
//!   höchstens 3 fest eingetragene Server je Familie, höchstens 16 gesicherte Verbindungen.
//! - Eine in diesem Ablauf neu angelegte Sicherung wird nur entfernt, wenn nachweislich nichts
//!   geändert wurde: Windows-Abfrage abgelehnt, oder die Nachkontrolle zeigt am Adapter noch genau
//!   den gesicherten Zustand. Bei Zeitüberschreitung oder Teilerfolg bleibt sie.
//! - Beim Zurückstellen wird nach jedem Ergebnis außer „abgelehnt“ zuerst aufgeräumt
//!   (zurückgestellte Einträge entfernen) und erst danach ein Rest als Fehler gemeldet.
#![cfg_attr(not(windows), allow(dead_code))]

use std::net::{IpAddr, SocketAddr};

use super::types::{AutoReport, DnsConfig};
use super::{dns, read_dns_backups, write_dns_backups};
use crate::elevate::{self, DnsOp, ElevateError, ElevatedTask, Elevator, MAX_ADDRS, MAX_DNS_OPS};
use crate::error::CmdResult;
use crate::opt::tweaks::{self, Env, SnapshotStore};
use crate::opt::types::TweakError;
use crate::state::Shared;
use crate::util::now_ms;

/// Meldung, wenn Pulsar den DNS hier nicht ändern kann.
pub const CANNOT_CHANGE: &str =
    "Pulsar kann den DNS auf diesem System nicht einstellen. Dafür braucht es Windows 10 Version 2004 oder neuer.";
/// Nachkontrolle: Windows hat die Änderung nicht übernommen.
pub const NOT_TAKEN: &str = "Windows hat die DNS-Änderung nicht übernommen.";
/// `net_dns_restore` ohne Sicherung.
pub const NOTHING_TO_RESTORE: &str = "Pulsar hat den DNS nicht geändert – es gibt nichts zurückzustellen.";
/// Mehr fest eingetragene Server, als sich sicher zurückstellen lassen.
pub const TOO_MANY_SERVERS: &str =
    "Bei dieser Verbindung sind mehr als 3 DNS-Server fest eingetragen – Pulsar ändert den DNS hier nicht, damit er sich sicher zurückstellen lässt.";
/// Zusatz, wenn nach einem Fehler eine Sicherung für den Adapter besteht.
pub const RESTORE_HINT: &str = "Zurückstellen ist weiter möglich.";
/// Mehr gesicherte Verbindungen, als ein Auftrag zurückstellen kann.
pub const MORE_LEFT: &str = "Es sind noch weitere Verbindungen übrig – bitte noch einmal zurückstellen.";

/// Meldung, wenn schon für zu viele Verbindungen eine Sicherung besteht.
pub fn too_many_adapters() -> String {
    format!("Pulsar hat den DNS schon an {MAX_DNS_OPS} Verbindungen geändert – bitte erst zurückstellen.")
}

// =============================================================================================
// Systemzugriff
// =============================================================================================

/// Lesen der Netzwerkadapter – für Tests austauschbar. Alles ohne Adminrechte.
pub trait DnsSys {
    /// Die fest eingetragenen DNS-Server eines Adapters (`NameServer`), doppelte entfernt.
    fn static_servers(&self, adapter_id: &str) -> dns::StaticDns;
    /// Gibt es den Netzwerk-Schlüssel dieses Adapters noch?
    fn interface_exists(&self, adapter_id: &str) -> bool;
    /// Aktuelle DNS-Einstellung der Hauptverbindung (`changedByPulsar` aus der Datenbank).
    fn config_now(&self, core: &Shared) -> Option<DnsConfig>;
    /// DNS-Zwischenspeicher leeren (wie `opt_flush_dns`; ein Fehler ändert nichts am Ergebnis).
    fn flush(&self);
}

/// Das echte System (Windows).
#[cfg(windows)]
pub struct WinDnsSys;

#[cfg(windows)]
impl DnsSys for WinDnsSys {
    fn static_servers(&self, adapter_id: &str) -> dns::StaticDns {
        super::adapters::static_servers(adapter_id)
    }

    fn interface_exists(&self, adapter_id: &str) -> bool {
        super::adapters::interface_exists(adapter_id)
    }

    fn config_now(&self, core: &Shared) -> Option<DnsConfig> {
        let backups = read_dns_backups(core).unwrap_or_default();
        let raw = super::adapters::read_raw().unwrap_or_default();
        let mut cfg = super::adapters::build_dns_config(
            &raw,
            super::adapters::is_static_dns,
            elevate::dns_api_available(),
            |id| backups.contains_key(id),
        )?;
        cfg.other_backups = other_backups(&backups, &cfg.adapter_id);
        Some(cfg)
    }

    fn flush(&self) {
        let _ = crate::opt::boost::flush_dns();
    }
}

// =============================================================================================
// Sicherung prüfen und vergleichen (rein, testbar)
// =============================================================================================

/// Namen der anderen Verbindungen (nicht `main_id`), für die eine DNS-Sicherung besteht – damit die
/// Oberfläche auch dort „Zurückstellen“ anbietet, wenn inzwischen eine andere Verbindung die
/// Hauptverbindung ist.
pub(crate) fn other_backups(backups: &dns::DnsBackups, main_id: &str) -> Vec<String> {
    backups
        .iter()
        .filter(|(id, _)| !id.eq_ignore_ascii_case(main_id))
        .map(|(id, b)| if b.adapter.trim().is_empty() { id.clone() } else { b.adapter.clone() })
        .collect()
}

/// DNS-Server einer gesicherten Familie als `DnsOp`-Teil (`[]` = automatisch/DHCP).
pub(crate) fn family_servers(f: &dns::FamilyBackup) -> Vec<String> {
    if f.dhcp {
        Vec::new()
    } else {
        f.servers.clone()
    }
}

/// Entspricht die aktuelle Liste einer Familie der Sicherung? Die Reihenfolge zählt: Windows
/// fragt den ersten Server zuerst – vertauschte Server sind eine echte Änderung.
fn family_matches(now: &[String], want: &dns::FamilyBackup) -> bool {
    if want.dhcp {
        now.is_empty()
    } else {
        now == want.servers.as_slice()
    }
}

/// Nachkontrolle: Steht am Adapter jetzt genau das, was der `DnsOp` setzen sollte (beide
/// geschickten Familien, in derselben Reihenfolge)?
fn op_reached(sys: &dyn DnsSys, op: &DnsOp) -> bool {
    let now = sys.static_servers(&op.adapter);
    op.v4.as_ref().is_none_or(|want| &now.v4 == want) && op.v6.as_ref().is_none_or(|want| &now.v6 == want)
}

/// Steht am Adapter (wieder bzw. noch) genau der gesicherte Zustand?
pub(crate) fn restored(sys: &dyn DnsSys, adapter_id: &str, b: &dns::DnsBackup) -> bool {
    let now = sys.static_servers(adapter_id);
    family_matches(&now.v4, &b.v4) && family_matches(&now.v6, &b.v6)
}

/// Den aktuellen (fest eingetragenen) DNS-Zustand eines Adapters sichern.
fn make_backup(sys: &dyn DnsSys, adapter_id: &str, name: &str) -> dns::DnsBackup {
    let now = sys.static_servers(adapter_id);
    dns::DnsBackup {
        adapter: name.to_string(),
        v4: dns::FamilyBackup { dhcp: now.v4.is_empty(), servers: now.v4 },
        v6: dns::FamilyBackup { dhcp: now.v6.is_empty(), servers: now.v6 },
        saved_at: now_ms(),
    }
}

/// Der `DnsOp`, der eine Sicherung vollständig zurückstellt (beide Familien).
pub(crate) fn restore_op(adapter_id: &str, b: &dns::DnsBackup) -> DnsOp {
    DnsOp { adapter: adapter_id.to_string(), v4: Some(family_servers(&b.v4)), v6: Some(family_servers(&b.v6)) }
}

/// Lässt sich die Sicherung dieses Adapters später sicher zurückstellen? Es gelten dieselben Regeln
/// wie im Admin-Helfer (höchstens 3 Adressen je Familie, höchstens 16 Verbindungen je Auftrag).
pub(crate) fn check_restorable(backups: &dns::DnsBackups, adapter_id: &str) -> Result<(), String> {
    if backups.len() > MAX_DNS_OPS {
        return Err(too_many_adapters());
    }
    let Some(b) = backups.get(adapter_id) else { return Ok(()) };
    if b.v4.servers.len() > MAX_ADDRS || b.v6.servers.len() > MAX_ADDRS {
        return Err(TOO_MANY_SERVERS.into());
    }
    elevate::validate(&ElevatedTask { dns: vec![restore_op(adapter_id, b)], reg: Vec::new() }).map_err(|e| {
        format!("Die DNS-Einstellung dieser Verbindung lässt sich nicht sicher sichern – Pulsar ändert den DNS hier nicht ({e})")
    })
}

/// Sicherung für den Adapter anlegen (falls noch keine existiert) und prüfen, ob sie sich sicher
/// zurückstellen lässt. Bei einem Fehler bleibt `backups` unverändert. `Ok(true)` = neu angelegt.
fn prepare_backup(sys: &dyn DnsSys, backups: &mut dns::DnsBackups, cfg: &DnsConfig) -> Result<bool, String> {
    let mut future = backups.clone();
    let new_backup = dns::insert_if_absent(&mut future, &cfg.adapter_id, make_backup(sys, &cfg.adapter_id, &cfg.adapter));
    check_restorable(&future, &cfg.adapter_id)?;
    *backups = future;
    Ok(new_backup)
}

/// Der `DnsOp` zum Einstellen eines Dienstes (IPv6 nur, wenn der Adapter echte IPv6-DNS hat).
fn target_op(p: &dns::Provider, cfg: &DnsConfig) -> DnsOp {
    let v6 = if cfg.ipv6_servers.is_empty() { None } else { Some(p.v6_servers()) };
    DnsOp { adapter: cfg.adapter_id.clone(), v4: Some(p.v4_servers()), v6 }
}

/// Nach dem Admin-Helfer: Eine in diesem Ablauf neu angelegte Sicherung nur entfernen, wenn
/// nachweislich nichts geändert wurde (abgelehnt, oder der Adapter steht noch genau auf dem
/// gesicherten Zustand). Bei Zeitüberschreitung bleibt sie immer. `true` = entfernt.
fn drop_unused_backup(
    core: &Shared,
    sys: &dyn DnsSys,
    backups: &mut dns::DnsBackups,
    adapter_id: &str,
    new_backup: bool,
    outcome: &Result<(), ElevateError>,
) -> bool {
    if !new_backup {
        return false;
    }
    let unchanged = match outcome {
        Err(ElevateError::Declined) => true,
        Err(ElevateError::TimedOut) => false,
        _ => backups.get(adapter_id).is_some_and(|b| restored(sys, adapter_id, b)),
    };
    if unchanged {
        backups.remove(adapter_id);
        // Klappt das Speichern nicht, bleibt eine unnötige Sicherung stehen – das ist ungefährlich
        let _ = write_dns_backups(core, backups);
    }
    unchanged
}

/// Fehlertext des Helfers, bei bestehender Sicherung mit dem Hinweis, dass Zurückstellen geht.
fn error_with_hint(e: &ElevateError, has_backup: bool) -> String {
    let hint = has_backup && matches!(e, ElevateError::Failed(_) | ElevateError::TimedOut);
    if hint {
        format!("{e} {RESTORE_HINT}")
    } else {
        e.to_string()
    }
}

/// Fehlertext, wenn die Nachkontrolle das Ziel nicht zeigt: Text des Helfers bzw. [`NOT_TAKEN`],
/// bei bestehender Sicherung mit dem Hinweis, dass Zurückstellen geht (dann kann sich schon
/// etwas geändert haben, z. B. nur IPv4).
fn not_reached_error(outcome: &Result<(), ElevateError>, has_backup: bool) -> String {
    match outcome {
        Err(e) => error_with_hint(e, has_backup),
        Ok(()) if has_backup => format!("{NOT_TAKEN} {RESTORE_HINT}"),
        Ok(()) => NOT_TAKEN.into(),
    }
}

// =============================================================================================
// Zurückstellen vorbereiten und aufräumen
// =============================================================================================

/// Was ein Zurückstellen an den Admin-Helfer schickt.
#[derive(Debug, Default)]
pub(crate) struct RestorePlan {
    /// Höchstens 16 einzeln geprüfte `DnsOp`s.
    pub ops: Vec<DnsOp>,
    /// Einträge wurden schon ohne Helfer entfernt (Adapter fehlt oder schon zurückgestellt).
    pub changed: bool,
    /// So viele Einträge standen schon auf dem gesicherten Zustand.
    pub already: usize,
    /// Hinweise zu Einträgen, die in diesem Auftrag nicht zurückgestellt werden.
    pub notes: Vec<String>,
}

/// Zurückstellen planen:
/// - Einträge, deren Adapter es nicht mehr gibt, still verwerfen;
/// - Einträge, deren Adapter schon den gesicherten Zustand hat, ohne Helfer entfernen;
/// - je Familie nur schicken, was vom gesicherten Zustand abweicht (sonst `null`);
/// - jeden `DnsOp` einzeln prüfen – ein ungültiger blockiert die anderen (und die `RegOp`s) nicht;
/// - höchstens 16 `DnsOp`s, der Rest bleibt für den nächsten Versuch.
pub(crate) fn plan_restore(backups: &mut dns::DnsBackups, sys: &dyn DnsSys) -> RestorePlan {
    let mut plan = RestorePlan::default();
    let mut deferred = false;
    let ids: Vec<String> = backups.keys().cloned().collect();
    for id in ids {
        if !sys.interface_exists(&id) {
            backups.remove(&id);
            plan.changed = true;
            continue;
        }
        let Some(b) = backups.get(&id) else { continue };
        let now = sys.static_servers(&id);
        let v4 = (!family_matches(&now.v4, &b.v4)).then(|| family_servers(&b.v4));
        let v6 = (!family_matches(&now.v6, &b.v6)).then(|| family_servers(&b.v6));
        if v4.is_none() && v6.is_none() {
            backups.remove(&id);
            plan.changed = true;
            plan.already += 1;
            continue;
        }
        let op = DnsOp { adapter: id.clone(), v4, v6 };
        let checked = if plan.ops.iter().any(|o| o.adapter.eq_ignore_ascii_case(&id)) {
            // Gleicher Adapter in anderer Schreibweise (nur bei beschädigten Daten möglich)
            Err(format!("Adapter doppelt im Auftrag: {id}"))
        } else {
            elevate::validate(&ElevatedTask { dns: vec![op.clone()], reg: Vec::new() })
        };
        if let Err(e) = checked {
            plan.notes.push(format!("Die gesicherte DNS-Einstellung von „{}“ lässt sich nicht zurückstellen: {e}", b.adapter));
            continue;
        }
        if plan.ops.len() >= MAX_DNS_OPS {
            deferred = true;
            continue;
        }
        plan.ops.push(op);
    }
    if deferred {
        plan.notes.push(MORE_LEFT.into());
    }
    plan
}

/// Nach dem Helfer (außer bei Ablehnung): alle Einträge entfernen, deren Adapter jetzt den
/// gesicherten Zustand hat, und speichern. Liefert die Zahl der entfernten Einträge.
fn reconcile(core: &Shared, sys: &dyn DnsSys, backups: &mut dns::DnsBackups) -> CmdResult<usize> {
    let before = backups.len();
    backups.retain(|id, b| !restored(sys, id, b));
    write_dns_backups(core, backups)?;
    Ok(before - backups.len())
}

/// Fehlertext, wenn nach dem Zurückstellen noch Sicherungen übrig sind.
fn rest_error(outcome: &Result<(), ElevateError>, plan: &RestorePlan, backups: &dns::DnsBackups) -> String {
    let mut parts: Vec<String> = Vec::new();
    if plan.ops.iter().any(|op| backups.contains_key(&op.adapter)) {
        parts.push(match outcome {
            Err(e) => e.to_string(),
            Ok(()) => NOT_TAKEN.into(),
        });
    }
    parts.extend(plan.notes.iter().cloned());
    if parts.is_empty() {
        parts.push(NOT_TAKEN.into());
    }
    parts.join(" ")
}

// =============================================================================================
// net_dns_apply / net_dns_restore
// =============================================================================================

/// Live-Prüfung: Der Dienst muss `cloudflare.com` innerhalb von 1,5 s beantworten (rcode 0).
pub async fn live_check(p: &dns::Provider) -> CmdResult<()> {
    let primary: IpAddr = p.v4.0.parse().map_err(|_| "Interner Fehler: ungültige Dienst-Adresse.".to_string())?;
    let server = SocketAddr::new(primary, 53);
    match dns::query(server, "cloudflare.com", dns::QTYPE_A, dns::LIVE_TIMEOUT).await {
        Ok((resp, _)) if resp.rcode == 0 => Ok(()),
        _ => Err(format!("{} antwortet gerade nicht – Pulsar stellt ihn deshalb nicht ein.", p.name)),
    }
}

/// Schritte 4–7 von `net_dns_apply` (blockierend): Sicherung, Admin-Helfer, Nachkontrolle,
/// Zwischenspeicher leeren.
pub fn apply(core: &Shared, el: &dyn Elevator, sys: &dyn DnsSys, provider: &str, cfg: &DnsConfig) -> CmdResult<DnsConfig> {
    let p = dns::provider(provider).ok_or_else(|| format!("Unbekannter DNS-Dienst: „{provider}“."))?;
    let _change = elevate::change_lock();
    elevate::ensure_idle(el)?;
    // 4. Sicherung anlegen (falls für diesen Adapter noch keine existiert), vor jeder Änderung speichern
    let mut backups = read_dns_backups(core)?;
    let new_backup = prepare_backup(sys, &mut backups, cfg)?;
    if new_backup {
        write_dns_backups(core, &backups)?;
    }
    // 5. Admin-Helfer mit einem DnsOp
    let op = target_op(p, cfg);
    let outcome = el.run(&ElevatedTask { dns: vec![op.clone()], reg: Vec::new() });
    drop_unused_backup(core, sys, &mut backups, &cfg.adapter_id, new_backup, &outcome);
    let has_backup = backups.contains_key(&cfg.adapter_id);
    if let Err(e) = &outcome {
        return Err(error_with_hint(e, has_backup));
    }
    // 6. Nachkontrolle ohne Adminrechte (alle geschickten Adressen, in derselben Reihenfolge)
    if !op_reached(sys, &op) {
        return Err(not_reached_error(&outcome, has_backup));
    }
    // 7. Zwischenspeicher leeren, neues DnsConfig
    sys.flush();
    Ok(sys.config_now(core).unwrap_or_default())
}

/// `net_dns_restore` (blockierend).
pub fn restore(core: &Shared, el: &dyn Elevator, sys: &dyn DnsSys) -> CmdResult<Option<DnsConfig>> {
    let _change = elevate::change_lock();
    elevate::ensure_idle(el)?;
    let mut backups = read_dns_backups(core)?;
    if backups.is_empty() {
        return Err(NOTHING_TO_RESTORE.into());
    }
    let plan = plan_restore(&mut backups, sys);
    if plan.changed {
        write_dns_backups(core, &backups)?;
    }
    let outcome = if plan.ops.is_empty() {
        Ok(())
    } else {
        el.run(&ElevatedTask { dns: plan.ops.clone(), reg: Vec::new() })
    };
    if let Err(ElevateError::Declined) = outcome {
        return Err(elevate::MSG_DECLINED.into());
    }
    // Erst aufräumen (auch nach einem Fehler), dann einen Rest melden
    if !plan.ops.is_empty() {
        reconcile(core, sys, &mut backups)?;
        sys.flush();
    }
    if !backups.is_empty() {
        return Err(rest_error(&outcome, &plan, &backups));
    }
    Ok(sys.config_now(core))
}

// =============================================================================================
// Netzwerk automatisch optimieren / zurückstellen
// =============================================================================================

/// Was mit dem DNS geschehen soll (nach Live-Prüfung).
pub enum DnsPlan {
    /// Kein Dienst angefragt.
    Skip,
    /// DNS bleibt; Grund für `dnsError`.
    Error(String),
    /// Diesen Dienst einstellen (mit der aktuellen Hauptverbindung).
    Apply(&'static dns::Provider, DnsConfig),
}

/// DNS-Plan samt Live-Prüfung bestimmen (asynchron, ohne Adminrechte, ohne Sperre).
pub async fn plan_dns(provider: Option<&str>, cfg: Option<DnsConfig>) -> DnsPlan {
    let Some(id) = provider else { return DnsPlan::Skip };
    let Some(p) = dns::provider(id) else {
        return DnsPlan::Error(format!("Unbekannter DNS-Dienst: „{id}“."));
    };
    match cfg {
        None => DnsPlan::Error("Keine aktive Netzwerkverbindung gefunden.".into()),
        Some(c) if !c.can_change => DnsPlan::Error(CANNOT_CHANGE.into()),
        Some(c) => match live_check(p).await {
            Ok(()) => DnsPlan::Apply(p, c),
            Err(e) => DnsPlan::Error(e),
        },
    }
}

/// Doppelte und leere IDs entfernen.
fn unique(ids: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        let id = id.trim();
        if !id.is_empty() && !out.iter().any(|x| x == id) {
            out.push(id.to_string());
        }
    }
    out
}

/// Mindestens eine angewendete/zurückgestellte Optimierung wirkt erst nach einem Neustart?
fn needs_restart(applied: &[String]) -> bool {
    applied.iter().any(|id| id == tweaks::NAGLE || id == tweaks::NET_THROTTLE)
}

/// `net_auto_optimize` (blockierend): DNS und die Admin-Optimierungen mit **einem** Helfer-Aufruf.
pub fn auto_optimize(core: &Shared, env: &Env, sys: &dyn DnsSys, plan: DnsPlan, tweak_ids: &[String]) -> CmdResult<AutoReport> {
    let _change = elevate::change_lock();
    elevate::ensure_idle(env.elevator)?;
    let mut report = AutoReport::default();
    let mut store = SnapshotStore::load(core)?;
    let mut backups = read_dns_backups(core)?;

    // Optimierungen aufteilen: Admin-IDs über den Helfer, die anderen direkt
    let (admin, normal): (Vec<String>, Vec<String>) = unique(tweak_ids).into_iter().partition(|id| tweaks::is_admin_id(id));
    for id in normal {
        match tweaks::apply_one(&id, true, env, &mut store) {
            Ok(()) => report.applied.push(id),
            Err(error) => report.failed.push(TweakError { id, error }),
        }
    }
    let batch = tweaks::prepare_admin(&admin, true, env, &mut store);

    // DNS vorbereiten: Sicherung prüfen und vor der Änderung speichern
    let mut dns_ops: Vec<DnsOp> = Vec::new();
    // (geschickter DnsOp, Sicherung neu angelegt)
    let mut target: Option<(DnsOp, bool)> = None;
    match plan {
        DnsPlan::Skip => {}
        DnsPlan::Error(e) => report.dns_error = Some(e),
        DnsPlan::Apply(p, cfg) => match prepare_backup(sys, &mut backups, &cfg) {
            Err(e) => report.dns_error = Some(e),
            Ok(new_backup) => {
                let saved = if new_backup { write_dns_backups(core, &backups) } else { Ok(()) };
                match saved {
                    Err(e) => report.dns_error = Some(format!("Die Sicherung konnte nicht gespeichert werden: {e}")),
                    Ok(()) => {
                        let op = target_op(p, &cfg);
                        dns_ops.push(op.clone());
                        target = Some((op, new_backup));
                    }
                }
            }
        },
    }

    // Alles mit EINER Windows-Abfrage (keine, wenn nichts zu tun ist)
    let task = ElevatedTask { dns: dns_ops, reg: batch.reg_ops() };
    let outcome = if task.is_empty() { Ok(()) } else { env.elevator.run(&task) };

    let (applied, failed) = batch.settle(&outcome, env, &mut store);
    report.applied.extend(applied);
    report.failed.extend(failed);
    report.declined = matches!(outcome, Err(ElevateError::Declined));

    if let Some((op, new_backup)) = target {
        drop_unused_backup(core, sys, &mut backups, &op.adapter, new_backup, &outcome);
        if !report.declined {
            // Nachkontrolle wie bei net_dns_apply: IPv4 und (falls geschickt) IPv6. Ein Fehler
            // nur bei den Optimierungen ändert nichts daran, dass der DNS angekommen ist.
            if op_reached(sys, &op) {
                report.dns_changed = true;
            } else {
                report.dns_error = Some(not_reached_error(&outcome, backups.contains_key(&op.adapter)));
            }
            sys.flush();
        }
    }

    report.restart = needs_restart(&report.applied);
    report.dns = sys.config_now(core);
    Ok(report)
}

/// Gemeinsamer Kern von `net_auto_restore` und `--revert-all`: den gesicherten DNS und die
/// Sicherungen von `nagle`/`netThrottle` mit **einem** Helfer-Aufruf zurückstellen. Füllt
/// `dnsChanged`, `dnsError`, `applied`, `failed`, `declined` (nicht `dns`/`restart`).
/// Die Sperre ([`elevate::change_lock`]) hält der Aufrufer.
pub(crate) fn restore_admin_and_dns(core: &Shared, env: &Env, sys: &dyn DnsSys, store: &mut SnapshotStore) -> CmdResult<AutoReport> {
    // Läuft noch ein Helfer, könnte er gleich noch ändern – dann nichts als „zurückgestellt“ werten
    elevate::ensure_idle(env.elevator)?;
    let mut report = AutoReport::default();
    let mut backups = read_dns_backups(core)?;

    let admin: Vec<String> = store.ids().into_iter().filter(|id| tweaks::is_admin_id(id)).collect();
    let batch = tweaks::prepare_admin(&admin, false, env, store);

    let plan = plan_restore(&mut backups, sys);
    if plan.changed {
        write_dns_backups(core, &backups)?;
    }
    report.dns_changed = plan.already > 0;

    let task = ElevatedTask { dns: plan.ops.clone(), reg: batch.reg_ops() };
    let outcome = if task.is_empty() { Ok(()) } else { env.elevator.run(&task) };

    let (applied, failed) = batch.settle(&outcome, env, store);
    report.applied.extend(applied);
    report.failed.extend(failed);

    if let Err(ElevateError::Declined) = outcome {
        report.declined = true;
        return Ok(report);
    }
    // Erst aufräumen (auch nach einem Fehler), dann einen Rest melden
    if !plan.ops.is_empty() {
        match reconcile(core, sys, &mut backups) {
            Ok(removed) => report.dns_changed |= removed > 0,
            Err(e) => report.dns_error = Some(e),
        }
        sys.flush();
    }
    if !backups.is_empty() && report.dns_error.is_none() {
        report.dns_error = Some(rest_error(&outcome, &plan, &backups));
    }
    Ok(report)
}

/// `net_auto_restore` (blockierend). Die anderen Optimierungen bleiben (dafür gibt es `opt_revert_all`).
pub fn auto_restore(core: &Shared, env: &Env, sys: &dyn DnsSys) -> CmdResult<AutoReport> {
    let _change = elevate::change_lock();
    let mut store = SnapshotStore::load(core)?;
    let mut report = restore_admin_and_dns(core, env, sys, &mut store)?;
    report.restart = needs_restart(&report.applied);
    report.dns = sys.config_now(core);
    Ok(report)
}

// =============================================================================================
// Tests: Adapter im Speicher
// =============================================================================================

/// Test-System: liest `NameServer` aus einer Registrierung im Speicher (dort schreibt auch der
/// Test-Helfer `MemElevator`).
#[cfg(test)]
pub struct MemDnsSys<'a> {
    pub reg: &'a crate::opt::registry::MemRegistry,
    /// Hauptverbindung (GUID, Name) für `config_now`
    pub main: Option<(String, String)>,
    pub flushes: std::cell::Cell<u32>,
}

#[cfg(test)]
impl<'a> MemDnsSys<'a> {
    pub fn new(reg: &'a crate::opt::registry::MemRegistry, main: Option<&str>) -> Self {
        Self { reg, main: main.map(|g| (g.to_string(), "Ethernet".to_string())), flushes: Default::default() }
    }
}

#[cfg(test)]
impl DnsSys for MemDnsSys<'_> {
    fn static_servers(&self, adapter_id: &str) -> dns::StaticDns {
        use crate::opt::registry::RegistryRead;
        let read = |base: &str| {
            let v = self
                .reg
                .read(&format!("{base}\\{adapter_id}"), "NameServer")
                .ok()
                .flatten()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_default();
            dns::static_list(&v)
        };
        dns::StaticDns { v4: read(elevate::KEY_INTERFACES), v6: read(elevate::KEY_INTERFACES6) }
    }

    fn interface_exists(&self, adapter_id: &str) -> bool {
        use crate::opt::registry::RegistryRead;
        elevate::is_braced_guid(adapter_id) && self.reg.key_exists(&format!("{}\\{adapter_id}", elevate::KEY_INTERFACES))
    }

    fn config_now(&self, core: &Shared) -> Option<DnsConfig> {
        let (id, name) = self.main.clone()?;
        let now = self.static_servers(&id);
        let backups = read_dns_backups(core).unwrap_or_default();
        Some(DnsConfig {
            provider: dns::provider_for(&now.v4),
            changed_by_pulsar: backups.contains_key(&id),
            other_backups: other_backups(&backups, &id),
            can_change: true,
            dhcp: now.v4.is_empty(),
            servers: now.v4,
            ipv6_servers: now.v6,
            adapter_id: id,
            adapter: name,
        })
    }

    fn flush(&self) {
        self.flushes.set(self.flushes.get() + 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::elevate::{MemElevator, KEY_INTERFACES, KEY_INTERFACES6, KEY_SYSTEM_PROFILE, VAL_NO_DELAY, VAL_TCP_ACK, VAL_THROTTLE};
    use crate::opt::power::{MemPowerCfg, BALANCED};
    use crate::opt::registry::{MemRegistry, RegVal, Registry};

    const A: &str = "{4d36e972-e325-11ce-bfc1-08002be10318}";
    const B: &str = "{5d36e972-e325-11ce-bfc1-08002be10318}";

    fn guid(i: usize) -> String {
        format!("{{00000000-0000-0000-0000-{i:012}}}")
    }

    fn v4_key(id: &str) -> String {
        format!("{KEY_INTERFACES}\\{id}")
    }

    fn v6_key(id: &str) -> String {
        format!("{KEY_INTERFACES6}\\{id}")
    }

    /// Adapter mit IPv4- und IPv6-Schlüssel anlegen, `v4` als fest eingetragene Server.
    fn add_adapter(reg: &MemRegistry, id: &str, v4: &str) {
        reg.add_key(&v4_key(id));
        reg.add_key(&v6_key(id));
        if !v4.is_empty() {
            reg.set(&v4_key(id), "NameServer", &RegVal::Str(v4.into())).unwrap();
        }
    }

    fn name_server(reg: &MemRegistry, key: &str) -> String {
        reg.string(key, "NameServer").unwrap_or_default()
    }

    fn cfg(id: &str, ipv6: bool) -> DnsConfig {
        DnsConfig {
            adapter_id: id.into(),
            adapter: "Ethernet".into(),
            ipv6_servers: if ipv6 { vec!["2001:db8::53".into()] } else { Vec::new() },
            can_change: true,
            ..Default::default()
        }
    }

    fn backups(core: &Shared) -> dns::DnsBackups {
        read_dns_backups(core).unwrap()
    }

    fn backup(v4: &[&str], v6: &[&str]) -> dns::DnsBackup {
        let fam = |l: &[&str]| dns::FamilyBackup { dhcp: l.is_empty(), servers: l.iter().map(|s| s.to_string()).collect() };
        dns::DnsBackup { adapter: "Alt".into(), v4: fam(v4), v6: fam(v6), saved_at: 1 }
    }

    fn power() -> MemPowerCfg {
        MemPowerCfg::with(&[(BALANCED, "Balanced", true)])
    }

    fn env<'a>(reg: &'a MemRegistry, power: &'a MemPowerCfg, el: &'a MemElevator<'a>, main: Option<&str>) -> Env<'a> {
        Env { reg, hklm: reg, power, elevator: el, apply_mouse: |_| Ok(()), main_adapter: main.map(String::from) }
    }

    fn cloudflare() -> &'static dns::Provider {
        dns::provider("cloudflare").unwrap()
    }

    // -----------------------------------------------------------------------------------------
    // Reine Prüfungen
    // -----------------------------------------------------------------------------------------

    #[test]
    fn check_restorable_follows_helper_rules() {
        let mut map = dns::DnsBackups::new();
        map.insert(A.into(), backup(&["192.168.1.1", "1.1.1.1", "8.8.8.8"], &[]));
        assert_eq!(check_restorable(&map, A), Ok(()), "3 Server gehen");
        map.insert(A.into(), backup(&["192.168.1.1", "1.1.1.1", "8.8.8.8", "9.9.9.9"], &[]));
        assert_eq!(check_restorable(&map, A), Err(TOO_MANY_SERVERS.into()), "4 IPv4-Server");
        map.insert(A.into(), backup(&[], &["2001:db8::1", "2001:db8::2", "2001:db8::3", "2001:db8::4"]));
        assert_eq!(check_restorable(&map, A), Err(TOO_MANY_SERVERS.into()), "4 IPv6-Server");
        // Doppelte Adresse (nur in einer alten Sicherung möglich) → nicht sicher
        map.insert(A.into(), backup(&["1.1.1.1", "1.1.1.1"], &[]));
        assert!(check_restorable(&map, A).is_err());
        // Andere Adapter zählen nur für die Obergrenze
        map.insert(A.into(), backup(&[], &[]));
        for i in 1..MAX_DNS_OPS {
            map.insert(guid(i), backup(&[], &[]));
        }
        assert_eq!(map.len(), MAX_DNS_OPS);
        assert_eq!(check_restorable(&map, A), Ok(()));
        map.insert(guid(99), backup(&[], &[]));
        assert_eq!(check_restorable(&map, A), Err(too_many_adapters()));
    }

    #[test]
    fn config_lists_backups_of_other_connections() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        let reg = MemRegistry::default();
        add_adapter(&reg, A, "");
        add_adapter(&reg, B, "");
        let el = MemElevator::new(&reg);
        // Pulsar stellt den DNS am Kabel (A) ein, danach ist WLAN (B) die Hauptverbindung
        apply(&core, &el, &MemDnsSys::new(&reg, Some(A)), "cloudflare", &cfg(A, false)).unwrap();
        let sys = MemDnsSys::new(&reg, Some(B));
        let now = sys.config_now(&core).unwrap();
        assert!(!now.changed_by_pulsar);
        assert_eq!(now.other_backups, vec!["Ethernet".to_string()]);
        // Zurückstellen stellt auch die andere Verbindung zurück
        let out = restore(&core, &el, &sys).unwrap().unwrap();
        assert!(out.other_backups.is_empty());
        assert_eq!(name_server(&reg, &v4_key(A)), "");
    }

    #[test]
    fn plan_restore_skips_matching_families_and_invalid_entries() {
        let reg = MemRegistry::default();
        add_adapter(&reg, A, "1.1.1.1,1.0.0.1");
        add_adapter(&reg, B, "1.1.1.1");
        let sys = MemDnsSys::new(&reg, Some(A));
        let mut map = dns::DnsBackups::new();
        // A: IPv4 war automatisch, IPv6 war (und ist) automatisch → nur IPv4 schicken
        map.insert(A.into(), backup(&[], &[]));
        // B: alte, ungültige Sicherung (4 Server) → nicht schicken, Hinweis, bleibt stehen
        map.insert(B.into(), backup(&["192.168.1.1", "192.168.1.2", "192.168.1.3", "192.168.1.4"], &[]));
        // Adapter gibt es nicht mehr → still verwerfen
        map.insert(guid(7), backup(&[], &[]));
        let plan = plan_restore(&mut map, &sys);
        assert_eq!(plan.ops, vec![DnsOp { adapter: A.into(), v4: Some(vec![]), v6: None }]);
        assert!(plan.changed);
        assert_eq!(plan.already, 0);
        assert_eq!(plan.notes.len(), 1, "{:?}", plan.notes);
        assert!(plan.notes[0].contains("Alt"), "{:?}", plan.notes);
        assert_eq!(map.keys().cloned().collect::<Vec<_>>(), vec![A.to_string(), B.to_string()]);

        // Derselbe Adapter in anderer Schreibweise darf den Auftrag nicht ungültig machen
        let mut map = dns::DnsBackups::new();
        map.insert(A.into(), backup(&[], &[]));
        map.insert(A.to_uppercase(), backup(&["9.9.9.9"], &[]));
        let plan = plan_restore(&mut map, &sys);
        assert_eq!(plan.ops.len(), 1);
        assert_eq!(plan.notes.len(), 1, "{:?}", plan.notes);
        assert!(elevate::validate(&ElevatedTask { dns: plan.ops.clone(), reg: Vec::new() }).is_ok());

        // Schon im gesicherten Zustand → ohne Helfer entfernen
        let mut map = dns::DnsBackups::new();
        map.insert(A.into(), backup(&["1.1.1.1", "1.0.0.1"], &[]));
        let plan = plan_restore(&mut map, &sys);
        assert!(plan.ops.is_empty() && plan.changed && plan.already == 1);
        assert!(map.is_empty());

        // Gleiche Server in anderer Reihenfolge sind NICHT zurückgestellt
        let mut map = dns::DnsBackups::new();
        map.insert(A.into(), backup(&["1.0.0.1", "1.1.1.1"], &[]));
        let plan = plan_restore(&mut map, &sys);
        assert_eq!(plan.ops, vec![DnsOp { adapter: A.into(), v4: Some(vec!["1.0.0.1".into(), "1.1.1.1".into()]), v6: None }]);
        assert_eq!(plan.already, 0);
        assert!(map.contains_key(A));
    }

    // -----------------------------------------------------------------------------------------
    // net_dns_apply
    // -----------------------------------------------------------------------------------------

    #[test]
    fn apply_backs_up_sets_and_flushes() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        let reg = MemRegistry::default();
        add_adapter(&reg, A, "");
        let el = MemElevator::new(&reg);
        let sys = MemDnsSys::new(&reg, Some(A));

        let out = apply(&core, &el, &sys, "cloudflare", &cfg(A, false)).unwrap();
        assert_eq!(el.calls.get(), 1);
        assert_eq!(el.tasks.borrow()[0].dns[0].v6, None, "ohne IPv6-DNS bleibt IPv6 unverändert");
        assert_eq!(name_server(&reg, &v4_key(A)), "1.1.1.1,1.0.0.1");
        assert_eq!(out.provider.as_deref(), Some("cloudflare"));
        assert!(out.changed_by_pulsar);
        assert_eq!(sys.flushes.get(), 1);
        let b = &backups(&core)[A];
        assert!(b.v4.dhcp && b.v6.dhcp);

        // Zurückstellen: ein Helfer-Aufruf, nur IPv4, Sicherung weg
        let out = restore(&core, &el, &sys).unwrap().unwrap();
        assert_eq!(el.calls.get(), 2);
        assert_eq!(el.tasks.borrow()[1].dns, vec![DnsOp { adapter: A.into(), v4: Some(vec![]), v6: None }]);
        assert!(out.dhcp && !out.changed_by_pulsar);
        assert!(backups(&core).is_empty());
        assert_eq!(restore(&core, &el, &sys).unwrap_err(), NOTHING_TO_RESTORE);
        assert_eq!(el.calls.get(), 2, "nichts zu tun → keine Abfrage");
    }

    #[test]
    fn apply_declined_removes_new_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        let reg = MemRegistry::default();
        add_adapter(&reg, A, "192.168.1.1");
        let el = MemElevator::new(&reg);
        el.decline.set(true);
        let sys = MemDnsSys::new(&reg, Some(A));
        assert_eq!(apply(&core, &el, &sys, "google", &cfg(A, false)).unwrap_err(), elevate::MSG_DECLINED);
        assert!(backups(&core).is_empty());
        assert_eq!(name_server(&reg, &v4_key(A)), "192.168.1.1");
    }

    #[test]
    fn apply_failure_without_change_removes_new_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        let reg = MemRegistry::default();
        add_adapter(&reg, A, "");
        let el = MemElevator::new(&reg);
        el.fail.set(true);
        let sys = MemDnsSys::new(&reg, Some(A));
        let err = apply(&core, &el, &sys, "google", &cfg(A, false)).unwrap_err();
        assert_eq!(err, elevate::MSG_PARTLY, "kein Hinweis aufs Zurückstellen – es gibt nichts");
        assert!(backups(&core).is_empty(), "nachweislich nichts geändert → Sicherung weg");
    }

    #[test]
    fn apply_partial_failure_keeps_new_backup_and_restore_works() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        let reg = MemRegistry::default();
        // Ohne IPv6-Schlüssel: IPv4 wird gesetzt, IPv6 scheitert (wie Exit 10)
        reg.add_key(&v4_key(A));
        let el = MemElevator::new(&reg);
        let sys = MemDnsSys::new(&reg, Some(A));
        let err = apply(&core, &el, &sys, "cloudflare", &cfg(A, true)).unwrap_err();
        assert!(err.ends_with(RESTORE_HINT), "{err}");
        assert_eq!(name_server(&reg, &v4_key(A)), "1.1.1.1,1.0.0.1", "IPv4 ist geändert");
        assert!(backups(&core).contains_key(A), "Adapter geändert → Sicherung bleibt");

        // Zurückstellen schickt nur IPv4 (IPv6 steht schon auf dem gesicherten Zustand)
        restore(&core, &el, &sys).unwrap();
        assert_eq!(el.tasks.borrow()[1].dns[0].v6, None);
        assert_eq!(name_server(&reg, &v4_key(A)), "");
        assert!(backups(&core).is_empty());
    }

    #[test]
    fn apply_reported_partial_keeps_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        let reg = MemRegistry::default();
        add_adapter(&reg, A, "");
        let el = MemElevator::new(&reg);
        el.partial.set(true);
        let sys = MemDnsSys::new(&reg, Some(A));
        let err = apply(&core, &el, &sys, "quad9", &cfg(A, false)).unwrap_err();
        assert_eq!(err, format!("{} {RESTORE_HINT}", elevate::MSG_PARTLY));
        assert!(backups(&core).contains_key(A));
    }

    #[test]
    fn apply_timeout_keeps_new_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        let reg = MemRegistry::default();
        add_adapter(&reg, A, "");
        let el = MemElevator::new(&reg);
        el.time_out.set(true);
        let sys = MemDnsSys::new(&reg, Some(A));
        let err = apply(&core, &el, &sys, "google", &cfg(A, false)).unwrap_err();
        assert_eq!(err, format!("{} {RESTORE_HINT}", elevate::MSG_TIMED_OUT));
        assert!(backups(&core).contains_key(A), "der Helfer könnte noch ändern → Sicherung bleibt");

        // Hat sich doch nichts geändert, räumt das Zurückstellen ohne Abfrage auf
        el.time_out.set(false);
        assert!(restore(&core, &el, &sys).is_ok());
        assert_eq!(el.calls.get(), 1);
        assert!(backups(&core).is_empty());
    }

    #[test]
    fn apply_keeps_backup_when_only_the_order_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        let reg = MemRegistry::default();
        // Gleiche Server, andere Reihenfolge: Windows fragt den ersten zuerst → echte Änderung
        add_adapter(&reg, A, "1.0.0.1,1.1.1.1");
        let el = MemElevator::new(&reg);
        let sys = MemDnsSys::new(&reg, Some(A));

        let out = apply(&core, &el, &sys, "cloudflare", &cfg(A, false)).unwrap();
        assert_eq!(name_server(&reg, &v4_key(A)), "1.1.1.1,1.0.0.1");
        assert!(out.changed_by_pulsar);
        assert_eq!(backups(&core)[A].v4.servers, vec!["1.0.0.1", "1.1.1.1"]);

        restore(&core, &el, &sys).unwrap();
        assert_eq!(el.calls.get(), 2, "Zurückstellen braucht den Helfer");
        assert_eq!(el.tasks.borrow()[1].dns[0].v4, Some(vec!["1.0.0.1".to_string(), "1.1.1.1".to_string()]));
        assert_eq!(name_server(&reg, &v4_key(A)), "1.0.0.1,1.1.1.1", "exakt die alte Reihenfolge");
        assert!(backups(&core).is_empty());
    }

    #[test]
    fn timed_out_helper_blocks_every_flow_until_it_is_done() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        let reg = admin_reg();
        let power = power();
        let el = MemElevator::new(&reg);
        let e = env(&reg, &power, &el, Some(A));
        let sys = MemDnsSys::new(&reg, Some(A));
        el.time_out.set(true);
        assert!(apply(&core, &el, &sys, "google", &cfg(A, false)).is_err());
        assert!(backups(&core).contains_key(A));

        // Der Helfer läuft noch und hat (noch) nichts geändert: Kein Ablauf darf die Sicherung jetzt
        // als „schon zurückgestellt“ entfernen oder einen zweiten Helfer starten
        el.time_out.set(false);
        el.busy.set(true);
        assert_eq!(restore(&core, &el, &sys).unwrap_err(), elevate::MSG_BUSY);
        assert_eq!(auto_restore(&core, &e, &sys).unwrap_err(), elevate::MSG_BUSY);
        assert_eq!(apply(&core, &el, &sys, "quad9", &cfg(A, false)).unwrap_err(), elevate::MSG_BUSY);
        let plan = DnsPlan::Apply(cloudflare(), cfg(A, false));
        assert_eq!(auto_optimize(&core, &e, &sys, plan, &tweak_ids(&[tweaks::NET_THROTTLE])).unwrap_err(), elevate::MSG_BUSY);
        assert_eq!(el.calls.get(), 1);
        assert!(backups(&core).contains_key(A));

        // Jetzt wird der Helfer doch noch fertig – die Sicherung ist noch da und stellt exakt zurück
        reg.set(&v4_key(A), "NameServer", &RegVal::Str("8.8.8.8,8.8.4.4".into())).unwrap();
        el.busy.set(false);
        restore(&core, &el, &sys).unwrap();
        assert_eq!(name_server(&reg, &v4_key(A)), "");
        assert!(backups(&core).is_empty());
    }

    #[test]
    fn apply_never_overwrites_existing_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        let reg = MemRegistry::default();
        add_adapter(&reg, A, "1.1.1.1,1.0.0.1");
        let mut map = dns::DnsBackups::new();
        map.insert(A.into(), backup(&["192.168.1.53"], &[]));
        write_dns_backups(&core, &map).unwrap();
        let el = MemElevator::new(&reg);
        let sys = MemDnsSys::new(&reg, Some(A));

        apply(&core, &el, &sys, "google", &cfg(A, false)).unwrap();
        assert_eq!(name_server(&reg, &v4_key(A)), "8.8.8.8,8.8.4.4");
        assert_eq!(backups(&core)[A].v4.servers, vec!["192.168.1.53"], "Original bleibt");
        // Auch eine Ablehnung entfernt die alte Sicherung nicht
        el.decline.set(true);
        assert!(apply(&core, &el, &sys, "quad9", &cfg(A, false)).is_err());
        assert_eq!(backups(&core)[A].v4.servers, vec!["192.168.1.53"]);

        el.decline.set(false);
        restore(&core, &el, &sys).unwrap();
        assert_eq!(name_server(&reg, &v4_key(A)), "192.168.1.53");
    }

    #[test]
    fn apply_verification_failure_is_reported() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        let reg = MemRegistry::default();
        add_adapter(&reg, A, "");
        let el = MemElevator::new(&reg);
        el.ignore.set(true);
        let sys = MemDnsSys::new(&reg, Some(A));
        assert_eq!(apply(&core, &el, &sys, "google", &cfg(A, false)).unwrap_err(), NOT_TAKEN);
        assert!(backups(&core).is_empty(), "nichts geändert → keine Sicherung");
        assert_eq!(sys.flushes.get(), 0);
    }

    #[test]
    fn apply_refuses_unrestorable_backup_without_prompt() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        let reg = MemRegistry::default();
        add_adapter(&reg, A, "192.168.1.1,192.168.1.2,192.168.1.3,192.168.1.4");
        let el = MemElevator::new(&reg);
        let sys = MemDnsSys::new(&reg, Some(A));
        assert_eq!(apply(&core, &el, &sys, "google", &cfg(A, false)).unwrap_err(), TOO_MANY_SERVERS);
        assert_eq!(el.calls.get(), 0);
        assert!(backups(&core).is_empty());

        // Doppelt eingetragene Server zählen nur einmal → geht und lässt sich zurückstellen
        reg.set(&v4_key(A), "NameServer", &RegVal::Str("192.168.1.1,192.168.1.1,192.168.1.2".into())).unwrap();
        apply(&core, &el, &sys, "google", &cfg(A, false)).unwrap();
        assert_eq!(backups(&core)[A].v4.servers, vec!["192.168.1.1", "192.168.1.2"]);
        restore(&core, &el, &sys).unwrap();
        assert_eq!(name_server(&reg, &v4_key(A)), "192.168.1.1,192.168.1.2");
    }

    #[test]
    fn apply_refuses_seventeenth_adapter() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        let reg = MemRegistry::default();
        add_adapter(&reg, A, "");
        let mut map = dns::DnsBackups::new();
        for i in 1..=MAX_DNS_OPS {
            map.insert(guid(i), backup(&[], &[]));
        }
        write_dns_backups(&core, &map).unwrap();
        let el = MemElevator::new(&reg);
        let sys = MemDnsSys::new(&reg, Some(A));
        assert_eq!(apply(&core, &el, &sys, "google", &cfg(A, false)).unwrap_err(), too_many_adapters());
        assert_eq!(el.calls.get(), 0);
        assert_eq!(backups(&core).len(), MAX_DNS_OPS);
    }

    // -----------------------------------------------------------------------------------------
    // net_dns_restore
    // -----------------------------------------------------------------------------------------

    #[test]
    fn restore_removes_only_restored_entries_and_reports_rest() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        let reg = MemRegistry::default();
        add_adapter(&reg, A, "1.1.1.1");
        // B ohne IPv6-Schlüssel: das Zurückstellen von IPv6 scheitert dort
        reg.add_key(&v4_key(B));
        reg.set(&v4_key(B), "NameServer", &RegVal::Str("8.8.8.8".into())).unwrap();
        let mut map = dns::DnsBackups::new();
        map.insert(A.into(), backup(&[], &[]));
        map.insert(B.into(), backup(&[], &["2001:db8::53"]));
        write_dns_backups(&core, &map).unwrap();
        let el = MemElevator::new(&reg);
        let sys = MemDnsSys::new(&reg, Some(A));

        let err = restore(&core, &el, &sys).unwrap_err();
        assert_eq!(el.calls.get(), 1, "beide Adapter in einem Auftrag");
        assert!(err.contains("Adapter fehlt"), "{err}");
        let left = backups(&core);
        assert_eq!(left.keys().cloned().collect::<Vec<_>>(), vec![B.to_string()], "A ist zurückgestellt und weg");
        assert_eq!(name_server(&reg, &v4_key(A)), "");
        assert_eq!(sys.flushes.get(), 1);
    }

    #[test]
    fn restore_reports_verification_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        let reg = MemRegistry::default();
        add_adapter(&reg, A, "1.1.1.1");
        let mut map = dns::DnsBackups::new();
        map.insert(A.into(), backup(&[], &[]));
        write_dns_backups(&core, &map).unwrap();
        let el = MemElevator::new(&reg);
        el.ignore.set(true);
        let sys = MemDnsSys::new(&reg, Some(A));
        assert_eq!(restore(&core, &el, &sys).unwrap_err(), NOT_TAKEN, "kein falsches „zurückgestellt“");
        assert!(backups(&core).contains_key(A));

        el.ignore.set(false);
        el.decline.set(true);
        assert_eq!(restore(&core, &el, &sys).unwrap_err(), elevate::MSG_DECLINED);
        assert!(backups(&core).contains_key(A));
    }

    #[test]
    fn restore_handles_seventeen_adapters_and_invalid_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        let reg = MemRegistry::default();
        let mut map = dns::DnsBackups::new();
        for i in 1..=MAX_DNS_OPS + 1 {
            add_adapter(&reg, &guid(i), "9.9.9.9");
            map.insert(guid(i), backup(&[], &[]));
        }
        // Eine alte, ungültige Sicherung darf die anderen nicht blockieren
        add_adapter(&reg, A, "9.9.9.9");
        map.insert(A.into(), backup(&["192.168.1.1", "192.168.1.2", "192.168.1.3", "192.168.1.4"], &[]));
        write_dns_backups(&core, &map).unwrap();
        let el = MemElevator::new(&reg);
        let sys = MemDnsSys::new(&reg, None);

        let err = restore(&core, &el, &sys).unwrap_err();
        assert_eq!(el.tasks.borrow()[0].dns.len(), MAX_DNS_OPS);
        assert!(err.contains(MORE_LEFT) && err.contains("Alt"), "{err}");
        assert_eq!(backups(&core).len(), 2, "16 zurückgestellt");

        let err = restore(&core, &el, &sys).unwrap_err();
        assert_eq!(el.calls.get(), 2);
        assert!(!err.contains(MORE_LEFT), "{err}");
        let left = backups(&core);
        assert_eq!(left.keys().cloned().collect::<Vec<_>>(), vec![A.to_string()], "nur die ungültige bleibt");
        for i in 1..=MAX_DNS_OPS + 1 {
            assert_eq!(name_server(&reg, &v4_key(&guid(i))), "", "{i}");
        }
    }

    // -----------------------------------------------------------------------------------------
    // Netzwerk automatisch optimieren / zurückstellen
    // -----------------------------------------------------------------------------------------

    fn admin_reg() -> MemRegistry {
        let reg = MemRegistry::default();
        add_adapter(&reg, A, "");
        reg.add_key(KEY_SYSTEM_PROFILE);
        reg
    }

    fn tweak_ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn auto_optimize_and_restore_use_one_prompt_each() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        let reg = admin_reg();
        let power = power();
        let el = MemElevator::new(&reg);
        let e = env(&reg, &power, &el, Some(A));
        let sys = MemDnsSys::new(&reg, Some(A));

        let ids = tweak_ids(&[tweaks::NAGLE, tweaks::NET_THROTTLE, tweaks::GAME_MODE]);
        let rep = auto_optimize(&core, &e, &sys, DnsPlan::Apply(cloudflare(), cfg(A, false)), &ids).unwrap();
        assert_eq!(el.calls.get(), 1, "DNS + nagle + netThrottle mit einer Abfrage");
        assert_eq!(el.tasks.borrow()[0].dns.len(), 1);
        assert_eq!(el.tasks.borrow()[0].reg.len(), 3);
        assert!(rep.dns_changed && rep.dns_error.is_none() && !rep.declined && rep.restart);
        assert_eq!(rep.applied.len(), 3, "{:?}", rep.failed);
        assert!(rep.dns.as_ref().is_some_and(|d| d.changed_by_pulsar));
        assert_eq!(name_server(&reg, &v4_key(A)), "1.1.1.1,1.0.0.1");
        assert_eq!(reg.dword(&v4_key(A), VAL_TCP_ACK), Some(1));

        let rep = auto_restore(&core, &e, &sys).unwrap();
        assert_eq!(el.calls.get(), 2, "Zurückstellen mit einer Abfrage");
        assert!(rep.dns_changed && rep.dns_error.is_none(), "{rep:?}");
        assert_eq!(rep.applied.len(), 2, "{:?}", rep.failed);
        assert!(backups(&core).is_empty());
        assert_eq!(name_server(&reg, &v4_key(A)), "");
        assert!(!reg.has(&v4_key(A), VAL_TCP_ACK) && !reg.has(&v4_key(A), VAL_NO_DELAY));
        assert!(!reg.has(KEY_SYSTEM_PROFILE, VAL_THROTTLE));
        // gameMode bleibt (dafür gibt es opt_revert_all)
        assert_eq!(SnapshotStore::load(&core).unwrap().ids(), vec![tweaks::GAME_MODE.to_string()]);
    }

    #[test]
    fn auto_without_work_makes_no_prompt() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        let reg = admin_reg();
        let power = power();
        let el = MemElevator::new(&reg);
        let e = env(&reg, &power, &el, Some(A));
        let sys = MemDnsSys::new(&reg, Some(A));
        let rep = auto_optimize(&core, &e, &sys, DnsPlan::Skip, &[]).unwrap();
        assert_eq!(el.calls.get(), 0);
        assert!(!rep.dns_changed && rep.dns_error.is_none() && rep.applied.is_empty());
        let rep = auto_restore(&core, &e, &sys).unwrap();
        assert_eq!(el.calls.get(), 0);
        assert!(!rep.dns_changed && rep.dns_error.is_none() && !rep.declined);
    }

    #[test]
    fn auto_optimize_declined_removes_new_backups() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        let reg = admin_reg();
        let power = power();
        let el = MemElevator::new(&reg);
        el.decline.set(true);
        let e = env(&reg, &power, &el, Some(A));
        let sys = MemDnsSys::new(&reg, Some(A));
        let rep = auto_optimize(&core, &e, &sys, DnsPlan::Apply(cloudflare(), cfg(A, false)), &tweak_ids(&[tweaks::NAGLE])).unwrap();
        assert!(rep.declined && !rep.dns_changed && rep.dns_error.is_none());
        assert!(backups(&core).is_empty());
        assert!(SnapshotStore::load(&core).unwrap().ids().is_empty());
        assert!(!rep.dns.unwrap().changed_by_pulsar);
    }

    #[test]
    fn auto_optimize_failure_without_change_removes_dns_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        let reg = admin_reg();
        let power = power();
        let el = MemElevator::new(&reg);
        el.fail.set(true);
        let e = env(&reg, &power, &el, Some(A));
        let sys = MemDnsSys::new(&reg, Some(A));
        let rep = auto_optimize(&core, &e, &sys, DnsPlan::Apply(cloudflare(), cfg(A, false)), &[]).unwrap();
        assert_eq!(rep.dns_error.as_deref(), Some(elevate::MSG_PARTLY));
        assert!(!rep.dns_changed);
        assert!(backups(&core).is_empty(), "nichts geändert → kein „Von Pulsar eingestellt“");
        assert!(!rep.dns.unwrap().changed_by_pulsar);
    }

    #[test]
    fn auto_optimize_reports_ipv6_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        // Ohne IPv6-Schlüssel: IPv4 wird gesetzt, IPv6 scheitert (wie Exit 10)
        let reg = MemRegistry::default();
        reg.add_key(&v4_key(A));
        let power = power();
        let el = MemElevator::new(&reg);
        let e = env(&reg, &power, &el, Some(A));
        let sys = MemDnsSys::new(&reg, Some(A));
        let rep = auto_optimize(&core, &e, &sys, DnsPlan::Apply(cloudflare(), cfg(A, true)), &[]).unwrap();
        assert!(el.tasks.borrow()[0].dns[0].v6.is_some());
        assert!(!rep.dns_changed, "nicht alles angekommen → kein „DNS geändert“");
        let err = rep.dns_error.unwrap_or_default();
        assert!(err.contains("Adapter fehlt") && err.ends_with(RESTORE_HINT), "{err}");
        assert!(backups(&core).contains_key(A), "IPv4 ist geändert → Sicherung bleibt");
    }

    #[test]
    fn auto_optimize_dns_counts_even_if_a_tweak_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        // Ohne Multimedia-Schlüssel scheitert netThrottle im Helfer, der DNS kommt trotzdem an
        let reg = MemRegistry::default();
        add_adapter(&reg, A, "");
        let power = power();
        let el = MemElevator::new(&reg);
        let e = env(&reg, &power, &el, Some(A));
        let sys = MemDnsSys::new(&reg, Some(A));
        let rep = auto_optimize(&core, &e, &sys, DnsPlan::Apply(cloudflare(), cfg(A, false)), &tweak_ids(&[tweaks::NET_THROTTLE])).unwrap();
        assert!(rep.dns_changed && rep.dns_error.is_none(), "{rep:?}");
        assert_eq!(rep.failed.len(), 1, "{rep:?}");
        assert_eq!(rep.failed[0].id, tweaks::NET_THROTTLE);
    }

    #[test]
    fn auto_optimize_keeps_tweaks_when_dns_is_not_restorable() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        let reg = admin_reg();
        reg.set(&v4_key(A), "NameServer", &RegVal::Str("10.0.0.1,10.0.0.2,10.0.0.3,10.0.0.4".into())).unwrap();
        let power = power();
        let el = MemElevator::new(&reg);
        let e = env(&reg, &power, &el, Some(A));
        let sys = MemDnsSys::new(&reg, Some(A));
        let rep = auto_optimize(&core, &e, &sys, DnsPlan::Apply(cloudflare(), cfg(A, false)), &tweak_ids(&[tweaks::NET_THROTTLE])).unwrap();
        assert_eq!(rep.dns_error.as_deref(), Some(TOO_MANY_SERVERS));
        assert_eq!(rep.applied, vec![tweaks::NET_THROTTLE.to_string()]);
        assert!(el.tasks.borrow()[0].dns.is_empty(), "kein DnsOp");
        assert!(backups(&core).is_empty());
    }

    #[test]
    fn auto_restore_reports_rest_as_dns_error() {
        let tmp = tempfile::tempdir().unwrap();
        let core = crate::state::test_core(tmp.path());
        let reg = admin_reg();
        reg.set(&v4_key(A), "NameServer", &RegVal::Str("1.1.1.1".into())).unwrap();
        let mut map = dns::DnsBackups::new();
        map.insert(A.into(), backup(&[], &[]));
        write_dns_backups(&core, &map).unwrap();
        let power = power();
        let el = MemElevator::new(&reg);
        el.ignore.set(true);
        let e = env(&reg, &power, &el, Some(A));
        let sys = MemDnsSys::new(&reg, Some(A));
        let rep = auto_restore(&core, &e, &sys).unwrap();
        assert_eq!(rep.dns_error.as_deref(), Some(NOT_TAKEN));
        assert!(!rep.dns_changed);
        assert!(backups(&core).contains_key(A));

        el.ignore.set(false);
        el.fail.set(true);
        let rep = auto_restore(&core, &e, &sys).unwrap();
        assert_eq!(rep.dns_error.as_deref(), Some(elevate::MSG_PARTLY), "echte Ursache bleibt erhalten");
    }
}
