//! Eingebauter Selbsttest für automatische Prüfungen (z. B. auf dem Windows-Rechner von GitHub):
//!
//! `Pulsar.exe --selftest <bericht.json>`
//!
//! Startet die App normal, ruft dann die echten Backend-Befehle auf (Scan, Bilder, Icons, Ping,
//! Regionen, DNS, Adapter, Tweaks, Boost, Starten, Spielzeit-Erkennung, Beenden) und schreibt einen
//! JSON-Bericht. Exit-Code 0 = alles ok.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::state::Shared;

/// Pfad des Berichts, falls `--selftest` angegeben wurde.
pub fn report_path() -> Option<PathBuf> {
    let args: Vec<String> = std::env::args().collect();
    let i = args.iter().position(|a| a == "--selftest")?;
    Some(
        args.get(i + 1)
            .filter(|a| !a.starts_with("--"))
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("pulsar-selftest.json")),
    )
}

struct Report {
    steps: Vec<Value>,
    ok: bool,
}

impl Report {
    fn step(&mut self, name: &str, ok: bool, detail: impl Into<String>) {
        let detail = detail.into();
        println!("[{}] {name}: {detail}", if ok { " OK " } else { "FAIL" });
        self.ok &= ok;
        self.steps.push(json!({ "name": name, "ok": ok, "detail": detail }));
    }
}

fn from<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).expect("Selbsttest: ungültige Testdaten")
}

/// Testprogramm, das etwa 25 Sekunden läuft und sich als "Spiel" überwachen lässt.
fn test_program() -> (String, String) {
    if cfg!(windows) {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        (format!("{root}\\System32\\PING.EXE"), "-n 30 127.0.0.1".into())
    } else {
        let p = if std::path::Path::new("/usr/bin/sleep").exists() { "/usr/bin/sleep" } else { "/bin/sleep" };
        (p.into(), "25".into())
    }
}

pub fn spawn(app: AppHandle, report_file: PathBuf) {
    tauri::async_runtime::spawn(async move {
        // Oberfläche erst einmal starten lassen
        tokio::time::sleep(Duration::from_secs(3)).await;
        let mut r = Report { steps: Vec::new(), ok: true };

        // 1) Steam-Scan
        match crate::scan::scan_library(from(json!({ "steam": true, "epic": false, "gog": false, "startMenu": false, "folders": [] }))).await {
            Ok(res) => {
                let names: Vec<String> = res.entries.iter().map(|e| e.name.clone()).collect();
                let expect = std::env::var("PULSAR_SELFTEST_EXPECT_STEAM").ok();
                let ok = expect.as_ref().is_none_or(|n| names.iter().any(|x| x == n));
                r.step("steam-scan", ok, format!("{} gefunden: {:?} {:?}", names.len(), names, res.messages));
            }
            Err(e) => r.step("steam-scan", false, e),
        }

        // 2) Epic, GOG, Startmenü
        match crate::scan::scan_library(from(json!({ "steam": false, "epic": true, "gog": true, "startMenu": true, "folders": [] }))).await {
            Ok(res) => {
                let sample: Vec<String> = res.entries.iter().take(6).map(|e| format!("{} ({:?})", e.name, e.kind)).collect();
                r.step("startmenue-epic-gog-scan", true, format!("{} Einträge, z. B. {sample:?}", res.entries.len()));
            }
            Err(e) => r.step("startmenue-epic-gog-scan", false, e),
        }

        // 3) Steam-Bilder von Steams Server (ohne API-Schlüssel): Cover, Hintergrund, Logo, Icon
        let is_file = |p: &Option<String>| p.as_ref().is_some_and(|p| std::path::Path::new(p).is_file());
        let req = from(json!({ "gameId": "selftest-portal2", "name": "Portal 2", "steamAppId": "620", "kinds": ["cover", "hero", "logo", "icon"] }));
        match crate::images::images_fetch(app.state::<Shared>(), req).await {
            Ok(res) => {
                let ok = is_file(&res.images.cover) && is_file(&res.images.hero) && is_file(&res.images.logo) && is_file(&res.images.icon);
                r.step("steam-bilder", ok, format!("Quelle {:?}, Bilder {:?}", res.source, res.images));
            }
            Err(e) => r.step("steam-bilder", false, e),
        }

        // 3b) Spiel ohne Steam-ID (z. B. von Epic/GOG): Bilder per Namenssuche
        let req = from(json!({ "gameId": "selftest-byname", "name": "Hades II", "lookupByName": true, "kinds": ["cover", "hero", "icon"] }));
        match crate::images::images_fetch(app.state::<Shared>(), req).await {
            Ok(res) => {
                let ok = res.steam_app_id.as_deref() == Some("1145350") && is_file(&res.images.cover) && is_file(&res.images.icon);
                r.step("bilder-per-name", ok, format!("Steam-ID {:?}, Bilder {:?}", res.steam_app_id, res.images));
            }
            Err(e) => r.step("bilder-per-name", false, e),
        }

        // 4) Programm-Icon aus einer .exe (nur Windows)
        if cfg!(windows) {
            let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
            match crate::images::exe_icon(app.state::<Shared>(), format!("{root}\\explorer.exe"), "selftest-icon".into()).await {
                Ok(Some(p)) => r.step("exe-icon", std::path::Path::new(&p).is_file(), p),
                Ok(None) => r.step("exe-icon", false, "kein Icon"),
                Err(e) => r.step("exe-icon", false, e),
            }
            // Nur der Installationsordner ist bekannt (wie bei Steam-Spielen): Haupt-.exe finden
            let folder = format!("{root}\\System32\\WindowsPowerShell\\v1.0");
            let req = from(json!({ "gameId": "selftest-folder-icon", "name": "Windows PowerShell", "installDir": folder, "kinds": ["icon"] }));
            match crate::images::images_fetch(app.state::<Shared>(), req).await {
                Ok(res) => r.step("icon-aus-ordner", is_file(&res.images.icon), format!("{:?}", res.images.icon)),
                Err(e) => r.step("icon-aus-ordner", false, e),
            }
        }

        // 5) PC-Auslastung
        match crate::system::system_stats(app.state::<Shared>()).await {
            Ok(s) => r.step("pc-auslastung", s.ram_total > 0, format!("CPU {:.0} %, RAM {} MB, GPU {:?} {:?}", s.cpu, s.ram_total / 1_048_576, s.gpu, s.gpu_name)),
            Err(e) => r.step("pc-auslastung", false, e),
        }

        // 6) Netzwerk: Regionen, Ping, DNS, Adapter, WLAN
        let regions = match crate::net::net_regions().await {
            Ok(list) => {
                let areas: std::collections::BTreeSet<String> = list.iter().map(|r| format!("{:?}", r.area)).collect();
                r.step("regionen-liste", list.len() >= 15 && areas.len() >= 5, format!("{} Regionen, Gebiete {:?}", list.len(), areas));
                list
            }
            Err(e) => {
                r.step("regionen-liste", false, e);
                Vec::new()
            }
        };
        let tcp_target = from(json!({ "id": "selftest-tcp", "label": "Cloudflare", "host": "1.1.1.1", "port": 443, "method": "tcp" }));
        match crate::net::net_ping_once(tcp_target, Some(4)).await {
            Ok(s) => r.step("ping-tcp", s.avg.is_some_and(|v| v > 0.0 && v < 2000.0), format!("Ø {:?} ms, Jitter {:?}, Verlust {:.0} %", s.avg.map(|v| v.round()), s.jitter.map(|v| (v * 10.0).round() / 10.0), s.loss * 100.0)),
            Err(e) => r.step("ping-tcp", false, e),
        }
        let icmp_target = from(json!({ "id": "selftest-icmp", "label": "Cloudflare", "host": "1.1.1.1", "method": "icmp" }));
        match crate::net::net_ping_once(icmp_target, Some(4)).await {
            // ICMP darf in einer Firewall geblockt sein – dann zählt nur, dass der Aufruf sauber antwortet
            Ok(s) => r.step("ping-icmp", true, format!("Ø {:?} ms, Verlust {:.0} %", s.avg.map(|v| v.round()), s.loss * 100.0)),
            Err(e) => r.step("ping-icmp", false, e),
        }
        if !regions.is_empty() {
            let ids: Vec<String> = regions.iter().take(3).map(|x| x.id.clone()).collect();
            match crate::net::net_regions_ping(Some(ids.clone()), Some(3)).await {
                Ok(list) => {
                    let measured = list.iter().filter(|x| x.stats.avg.is_some()).count();
                    r.step("regionen-ping", list.len() == ids.len() && measured >= 1, format!("{measured}/{} Regionen geantwortet", list.len()));
                }
                Err(e) => r.step("regionen-ping", false, e),
            }
        }
        match crate::net::net_game_servers(app.state::<Shared>(), "cs2".into()).await {
            Ok(list) => r.step("spielserver-cs2", !list.is_empty(), format!("{} Valve-Standorte, z. B. {:?}", list.len(), list.iter().take(3).map(|x| x.name.clone()).collect::<Vec<_>>())),
            Err(e) => r.step("spielserver-cs2", false, e),
        }
        match crate::net::net_dns_benchmark(app.clone(), Some(1)).await {
            Ok(list) => {
                let answered = list.iter().filter(|d| d.cached_ms.is_some() || d.uncached_ms.is_some()).count();
                r.step("dns-vergleich", answered >= 2, format!("{answered}/{} Dienste geantwortet", list.len()));
            }
            Err(e) => r.step("dns-vergleich", false, e),
        }
        match crate::net::net_dns_current(app.state::<Shared>()).await {
            Ok(cfg) => r.step("dns-aktuell", true, format!("{cfg:?}")),
            Err(e) => r.step("dns-aktuell", false, e),
        }
        match crate::net::net_adapters().await {
            Ok(list) => r.step("adapter", !cfg!(windows) || !list.is_empty(), format!("{} Adapter: {:?}", list.len(), list.iter().map(|a| format!("{} ({}, {})", a.name, a.kind, if a.up { "aktiv" } else { "aus" })).collect::<Vec<_>>())),
            Err(e) => r.step("adapter", false, e),
        }
        match crate::net::net_wifi().await {
            Ok(w) => r.step("wlan", true, w.map_or("kein WLAN".to_string(), |w| format!("{} {} %", w.ssid, w.signal))),
            Err(e) => r.step("wlan", false, e),
        }
        match crate::net::net_traceroute(app.clone(), "1.1.1.1".into(), Some(12)).await {
            Ok(t) => r.step("route", !t.hops.is_empty(), format!("{} Stationen, Ziel erreicht: {}", t.hops.len(), t.reached)),
            Err(e) => r.step("route", !cfg!(windows), e),
        }
        history_steps(&app, &mut r, &regions).await;

        // 7) Optimieren: Tweaks lesen, Energiepläne, Boost an/aus (muss den alten Zustand zurückstellen)
        match crate::opt::opt_tweaks(app.state::<Shared>()).await {
            Ok(list) => {
                // Alle Optimierungen in der Reihenfolge des Katalogs (auch `nagle` und `netThrottle`).
                // „unknown“ ist bei fehlenden Registry-Werten (frisches Windows) erlaubt; der Energieplan muss lesbar sein
                let ids: Vec<&str> = list.iter().map(|t| t.id.as_str()).collect();
                let ok = ids == crate::opt::tweaks::IDS
                    && (!cfg!(windows) || list.iter().any(|t| t.id == "powerPlan" && (t.state == "on" || t.state == "off")));
                r.step("tweaks-lesen", ok, format!("{:?}", list.iter().map(|t| format!("{}={}", t.id, t.state)).collect::<Vec<_>>()));
            }
            Err(e) => r.step("tweaks-lesen", false, e),
        }
        if cfg!(windows) {
            match crate::opt::opt_power_plans().await {
                Ok(plans) => r.step("energieplaene", plans.iter().any(|p| p.active), format!("{:?}", plans.iter().map(|p| format!("{}{}", p.name, if p.active { " *" } else { "" })).collect::<Vec<_>>())),
                Err(e) => r.step("energieplaene", false, e),
            }
            let before = crate::opt::opt_power_plans().await.ok().and_then(|p| p.into_iter().find(|p| p.active).map(|p| p.guid));
            let profile = from(json!({ "powerPlan": true, "gamePriority": "high", "flushDns": true }));
            match crate::opt::boost_start(app.clone(), app.state::<Shared>(), profile, None, None).await {
                Ok(st) => {
                    r.step("boost-start", st.active && !st.actions.is_empty(), format!("{:?}", st.actions.iter().map(|a| format!("{}:{}", a.id, a.ok)).collect::<Vec<_>>()));
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    match crate::opt::boost_stop(app.clone(), app.state::<Shared>()).await {
                        Ok(st) => {
                            let after = crate::opt::opt_power_plans().await.ok().and_then(|p| p.into_iter().find(|p| p.active).map(|p| p.guid));
                            r.step("boost-stop", !st.active && before == after, format!("Energieplan vorher {before:?}, nachher {after:?}"));
                        }
                        Err(e) => r.step("boost-stop", false, e),
                    }
                }
                Err(e) => r.step("boost-start", false, e),
            }
        }

        // 7b) Admin-Helfer, DNS einstellen/zurückstellen, Netzwerk-Tweaks.
        // Nur mit Adminrechten (der GitHub-Windows-Rechner läuft als Administrator); sonst nur ein
        // Hinweis, dass übersprungen wurde.
        if !crate::appinfo::is_elevated() {
            r.step("admin-tests", true, "übersprungen (keine Adminrechte)");
        } else {
            admin_steps(&app, &mut r).await;
        }

        // 8) Starten + Spielzeit-Erkennung + Beenden
        let (exe, args) = test_program();
        let game_id = "selftest-game".to_string();
        let tracked = from(json!([{ "gameId": game_id, "name": "Selbsttest", "exePath": exe }]));
        if let Err(e) = crate::launch::set_tracked_games(app.state::<Shared>(), tracked).await {
            r.step("tracking-liste", false, e);
        }
        let launch = from(json!({ "type": "exe", "target": exe, "args": args }));
        match crate::launch::launch_game(app.clone(), app.state::<Shared>(), game_id.clone(), launch).await {
            Ok(()) => {
                r.step("starten", true, format!("{exe} {args}"));
                let started = Instant::now();
                let mut seen = false;
                while started.elapsed() < Duration::from_secs(20) {
                    if let Ok(list) = crate::launch::running_games(app.state::<Shared>()).await {
                        if list.iter().any(|g| g.game_id == game_id) {
                            seen = true;
                            break;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                r.step("laeuft-gerade-erkannt", seen, format!("nach {:.1} s", started.elapsed().as_secs_f32()));
                tokio::time::sleep(Duration::from_secs(13)).await;
                match crate::launch::stop_game(app.state::<Shared>(), game_id.clone()).await {
                    Ok(n) => r.step("beenden", n >= 1, format!("{n} Prozess(e) beendet")),
                    Err(e) => r.step("beenden", false, e),
                }
                tokio::time::sleep(Duration::from_secs(4)).await;
                match crate::library::playtime_stats(app.state::<Shared>()).await {
                    Ok(stats) => {
                        let st = stats.iter().find(|s| s.game_id == game_id);
                        r.step(
                            "spielzeit-gespeichert",
                            st.is_some_and(|s| s.total_seconds >= 10),
                            st.map_or("keine Sitzung".to_string(), |s| format!("{} s in {} Sitzung(en)", s.total_seconds, s.sessions)),
                        );
                    }
                    Err(e) => r.step("spielzeit-gespeichert", false, e),
                }
            }
            Err(e) => r.step("starten", false, e),
        }

        let report = json!({ "ok": r.ok, "steps": r.steps });
        if let Some(parent) = report_file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&report_file, serde_json::to_vec_pretty(&report).unwrap_or_default());
        println!("SELFTEST {} – {}", if r.ok { "OK" } else { "FAILED" }, report_file.display());
        app.exit(if r.ok { 0 } else { 1 });
    });
}

/// Schritte der 7 Netzwerk-Funktionen (Teil 2, `docs/API.md` „Gemeinsam für die 7 Funktionen“):
/// Adapter-Zähler, Teilroute, Lag-Momentaufnahme, WLAN-Netze, Getaktet, Messverlauf, Datei-Export.
async fn history_steps(app: &AppHandle, r: &mut Report, regions: &[crate::net::types::Region]) {
    use crate::net::types::PingTarget;

    // Adapter-Zähler: zweimal im Abstand von ≈ 1 s, eine TCP-Messung dazwischen
    let has_primary = crate::net::net_adapters().await.map(|l| l.iter().any(|a| a.primary)).unwrap_or(false);
    let first = crate::net::net_if_counters(app.state::<Shared>()).await;
    let tcp: PingTarget = from(json!({ "id": "selftest-zaehler", "label": "Cloudflare", "host": "1.1.1.1", "port": 443, "method": "tcp" }));
    let _ = crate::net::net_ping_once(tcp, Some(1)).await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    let second = crate::net::net_if_counters(app.state::<Shared>()).await;
    match (first, second) {
        (Ok(a), Ok(b)) if cfg!(windows) && has_primary => {
            let ok = matches!((&a, &b), (Some(x), Some(y)) if y.rx_bytes >= x.rx_bytes);
            r.step("adapter-zaehler", ok, format!("{:?} → {:?}", a.map(|c| (c.adapter, c.rx_bytes, c.tx_bytes)), b.map(|c| (c.rx_bytes, c.tx_bytes))));
        }
        (Ok(_), Ok(_)) => r.step("adapter-zaehler", true, "keine Hauptverbindung"),
        (Err(e), _) | (_, Err(e)) => r.step("adapter-zaehler", false, e),
    }

    // Teilroute: bis 3 Stationen, auch leer ok
    match crate::net::ping::resolve_host("1.1.1.1", true).await {
        Ok(std::net::IpAddr::V4(dst)) => {
            let hops = crate::net::quickhops::quick_hops(dst, 3, crate::net::quickhops::HOP_TIMEOUT).await;
            let answered = hops.iter().filter(|h| h.rtt.is_some()).count();
            r.step("teilroute", true, format!("{answered} von 3 Stationen antworten"));
        }
        Ok(ip) => r.step("teilroute", true, format!("keine IPv4 ({ip})")),
        Err(e) => r.step("teilroute", false, e),
    }

    // Lag-Momentaufnahme auf Wunsch (Region Frankfurt)
    let frankfurt = regions.iter().find(|x| x.name == "Frankfurt").or_else(|| regions.first());
    match frankfurt {
        Some(region) => match crate::net::net_lag_snapshot(app.state::<Shared>(), region.target.clone()).await {
            Ok(check) => r.step(
                "lag-momentaufnahme",
                crate::net::lag::LagCause::parse(check.cause.as_str()).is_some(),
                format!("Ursache {}, {} ms", check.cause.as_str(), check.snapshot.took_ms),
            ),
            Err(e) => r.step("lag-momentaufnahme", false, e),
        },
        None => r.step("lag-momentaufnahme", false, "keine Region"),
    }

    // WLAN-Netze (Zwischenspeicher) und WLAN-Zustand; Sperr-Fehler gilt als sauber
    let scan = crate::net::net_wifi_scan(app.state::<Shared>(), Some(false)).await;
    let state = crate::net::net_wifi_state().await;
    let locked = |e: &String| e == crate::net::wifiscan::WIFI_LOCKED;
    match (scan, state) {
        (Err(e), _) if locked(&e) => r.step("wlan-netze", true, "Ortung gesperrt"),
        (Ok(s), Ok(st)) => {
            let detail = if s.interfaces == 0 && st.state == crate::net::wifiscan::WifiStateKind::NoService {
                "kein WLAN-Dienst".to_string()
            } else {
                format!("{} Netze, Zustand {:?}", s.networks.len(), st.state)
            };
            r.step("wlan-netze", true, detail);
        }
        (Ok(_), Err(e)) => r.step("wlan-netze", locked(&e), e),
        (Err(e), _) => r.step("wlan-netze", false, e),
    }

    // Getaktete Verbindung: antwortet (Wert egal)
    match crate::net::net_metered().await {
        Ok(v) => r.step("getaktet", true, format!("{v:?}")),
        Err(e) => r.step("getaktet", false, e),
    }

    // Messverlauf gegen eine temporäre Datenbank mit eigenem Recorder
    let (ok, detail) = history_roundtrip();
    r.step("messwerte-speichern", ok, detail);

    // Datei-Export: .txt schreiben und lesen, .exe ablehnen
    let dir = std::env::temp_dir().join(format!("pulsar-selftest-export-{}", crate::util::now_ms()));
    let (ok, detail) = match std::fs::create_dir_all(&dir) {
        Ok(()) => {
            let file = dir.join("export.txt");
            let data = "Pulsar-Selbsttest äöü\n".as_bytes();
            let written = crate::export::export_bytes(&file.to_string_lossy(), data);
            let same = std::fs::read(&file).map(|b| b == data).unwrap_or(false);
            let exe = crate::export::check_path(&dir.join("x.exe").to_string_lossy());
            let _ = std::fs::remove_dir_all(&dir);
            (written.is_ok() && same && exe == Err(crate::export::FILE_TYPE), format!("geschrieben {written:?}, gleich {same}, .exe → {exe:?}"))
        }
        Err(e) => (false, e.to_string()),
    };
    r.step("export-datei", ok, detail);
}

/// Feste Werte in eine temporäre Datenbank aufzeichnen und wiederfinden; die Datei wird danach
/// gelöscht. Die echte Profil-Datenbank bleibt unberührt.
fn history_roundtrip() -> (bool, String) {
    use crate::net::hist_types::EventKind;
    use crate::net::recorder::{flush_with, FlushGate, IngestCtx, Recorder};
    use crate::net::types::{PingSample, PingTarget};
    use std::sync::Mutex;

    let path = std::env::temp_dir().join(format!("pulsar-selftest-{}.db", crate::util::now_ms()));
    let db = match crate::db::Db::open(&path) {
        Ok(db) => db,
        Err(e) => return (false, e),
    };
    let handle = crate::db::DbHandle::new();
    handle.replace(Some(db));
    let recorder = Mutex::new(Recorder::default());
    let gate = FlushGate::default();
    let target: PingTarget = from(json!({ "id": "selftest-verlauf", "label": "Selbsttest", "host": "127.0.0.1", "port": 443, "method": "tcp" }));
    let start = crate::util::now_ms() - 120_000;
    let ticks = 90;
    {
        let mut rec = crate::error::LockExt::lock_safe(&recorder);
        for i in 0..ticks {
            let t = start + i * 1000;
            // Takte 40–45 verloren → ein Aussetzer
            let rtt = if (40..46).contains(&i) { None } else { Some(20.0 + (i % 5) as f64) };
            let samples = [PingSample { target_id: target.id.clone(), t, rtt }];
            let load = crate::net::ifstats::LoadSample { at: t, ..Default::default() };
            let _ = rec.ingest(t, 1000, std::slice::from_ref(&target), &[None], &samples, &load, IngestCtx::default());
        }
        rec.on_stop(start + ticks * 1000);
    }
    let flushed = flush_with(&recorder, &gate, &handle);
    let to = start + ticks * 1000 + 3_600_000;
    let hourly = handle.with(|db| crate::net::history_hourly::hourly(db, start - 3_600_000, to, Some(&target.id), None));
    let events = handle.with(|db| crate::net::history_events::list(db, start - 1000, to, None, None, 100));
    handle.replace(None);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
    let n: i64 = hourly.as_ref().map(|rows| rows.iter().map(|x| x.n).sum()).unwrap_or(0);
    let outages = events.as_ref().map(|p| p.events.iter().filter(|e| e.kind == EventKind::Outage).count()).unwrap_or(0);
    let ok = flushed.is_ok() && n == ticks && outages >= 1 && !path.exists();
    (ok, format!("Flush {flushed:?}, {n} von {ticks} Messungen, {outages} Aussetzer, Datei gelöscht: {}", !path.exists()))
}

/// Die eigene Exe als Kindprozess starten und (bis zum Zeitlimit) auf das Ende warten.
/// `Ok(Some(code))` = beendet, `Ok(None)` = Zeitlimit (Prozess wurde beendet).
async fn run_self_exe(args: &[&str], timeout: Duration) -> Result<Option<i32>, String> {
    use std::process::{Command, Stdio};
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(exe);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let start = Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => return Ok(status.code()),
            None if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Ok(None);
            }
            None => tokio::time::sleep(Duration::from_millis(200)).await,
        }
    }
}

/// Aktuellen `NetworkThrottlingIndex` lesen (ohne Adminrechte); `None`, wenn er fehlt.
#[cfg(windows)]
fn read_current_throttle() -> Option<u32> {
    use crate::opt::registry::{HklmRead, RegistryRead};
    HklmRead
        .read(crate::elevate::KEY_SYSTEM_PROFILE, crate::elevate::VAL_THROTTLE)
        .ok()
        .flatten()
        .and_then(|v| v.as_u32())
}
#[cfg(not(windows))]
fn read_current_throttle() -> Option<u32> {
    None
}

/// Zustand einer Optimierung aus `opt_tweaks` holen (`(state, canRevert)`).
fn tweak_state(list: &[crate::opt::types::Tweak], id: &str) -> Option<(String, bool)> {
    list.iter().find(|t| t.id == id).map(|t| (t.state.clone(), t.can_revert))
}

/// Admin-Schritte: Admin-Helfer über die Exe, DNS einstellen/zurückstellen, Netzwerk-Tweaks.
async fn admin_steps(app: &AppHandle, r: &mut Report) {
    use crate::elevate::{self, ElevatedTask, RegOp};

    // a) Admin-Helfer-CLI: ungültiger Auftrag → Exit 20, gültiger harmloser Auftrag → Exit 0
    {
        let invalid = elevate::encode(&ElevatedTask {
            dns: Vec::new(),
            reg: vec![RegOp { key: r"SOFTWARE\Pulsar\NichtErlaubt".into(), name: "x".into(), value: Some(1) }],
        })
        .unwrap_or_default();
        let mut ok = true;
        let mut detail = String::new();
        match run_self_exe(&["--elevated", &invalid], Duration::from_secs(30)).await {
            Ok(Some(code)) => {
                ok &= code == elevate::EXIT_INVALID;
                detail.push_str(&format!("ungültig→{code}; "));
            }
            Ok(None) => {
                ok = false;
                detail.push_str("ungültig→Zeitüberschreitung; ");
            }
            Err(e) => {
                ok = false;
                detail.push_str(&format!("ungültig→Fehler ({e}); "));
            }
        }
        match read_current_throttle() {
            Some(v) => {
                let hex = elevate::encode(&ElevatedTask {
                    dns: Vec::new(),
                    reg: vec![RegOp { key: elevate::KEY_SYSTEM_PROFILE.into(), name: elevate::VAL_THROTTLE.into(), value: Some(v) }],
                })
                .unwrap_or_default();
                match run_self_exe(&["--elevated", &hex], Duration::from_secs(30)).await {
                    Ok(Some(code)) => {
                        ok &= code == elevate::EXIT_OK;
                        detail.push_str(&format!("gültig→{code}"));
                    }
                    Ok(None) => {
                        ok = false;
                        detail.push_str("gültig→Zeitüberschreitung");
                    }
                    Err(e) => {
                        ok = false;
                        detail.push_str(&format!("gültig→Fehler ({e})"));
                    }
                }
            }
            None => detail.push_str("gültig übersprungen (kein Wert)"),
        }
        r.step("admin-helfer-cli", ok, detail);
    }

    // b) DNS auf Cloudflare einstellen (Live-Prüfung + Nachkontrolle im Befehl)
    let before = crate::net::net_dns_current(app.state::<Shared>()).await.ok().flatten();
    match crate::net::net_dns_apply(app.state::<Shared>(), "cloudflare".into()).await {
        Ok(cfg) => {
            let set_ok = cfg.servers.first().map(String::as_str) == Some("1.1.1.1")
                && cfg.provider.as_deref() == Some("cloudflare")
                && cfg.changed_by_pulsar;
            let resolved = tokio::time::timeout(Duration::from_secs(5), tokio::net::lookup_host("api.github.com:443"))
                .await
                .ok()
                .and_then(|res| res.ok())
                .map(|mut addrs| addrs.next().is_some())
                .unwrap_or(false);
            r.step("dns-einstellen", set_ok && resolved, format!("servers {:?}, provider {:?}, Auflösung {resolved}", cfg.servers, cfg.provider));
        }
        Err(e) => r.step("dns-einstellen", false, e),
    }

    // c) DNS zurückstellen – IMMER versuchen, auch wenn b) scheitert
    match crate::net::net_dns_restore(app.state::<Shared>()).await {
        Ok(cfg) => {
            let ok = match (&before, &cfg) {
                (Some(b), Some(c)) => !c.changed_by_pulsar && c.dhcp == b.dhcp && (b.dhcp || c.servers == b.servers),
                (_, Some(c)) => !c.changed_by_pulsar,
                _ => true,
            };
            r.step("dns-zurueckstellen", ok, format!("{cfg:?}"));
        }
        // Keine Sicherung (z. B. b) ist vor dem Einstellen gescheitert) → es gibt nichts zurückzustellen
        Err(e) if e.contains("nichts zurückzustellen") => r.step("dns-zurueckstellen", true, e),
        Err(e) => r.step("dns-zurueckstellen", false, e),
    }

    // d) Netzwerk-Tweaks einschalten und per „--revert-all“ wieder zurückstellen
    {
        let before = crate::opt::opt_tweaks(app.state::<Shared>()).await.unwrap_or_default();
        let nagle_before = tweak_state(&before, "nagle");
        let throttle_before = tweak_state(&before, "netThrottle");
        match crate::opt::opt_apply(app.state::<Shared>(), vec!["nagle".into(), "netThrottle".into()], true).await {
            Ok(report) => {
                let after = crate::opt::opt_tweaks(app.state::<Shared>()).await.unwrap_or_default();
                let both_on = tweak_state(&after, "nagle").map(|(s, _)| s) == Some("on".into())
                    && tweak_state(&after, "netThrottle").map(|(s, _)| s) == Some("on".into());
                match run_self_exe(&["--revert-all"], Duration::from_secs(60)).await {
                    Ok(Some(0)) => {
                        let back = crate::opt::opt_tweaks(app.state::<Shared>()).await.unwrap_or_default();
                        let nagle_back = tweak_state(&back, "nagle");
                        let throttle_back = tweak_state(&back, "netThrottle");
                        // Wie vorher und nichts mehr zurückzustellen (Sicherung entfernt)
                        let same = |back: &Option<(String, bool)>, before: &Option<(String, bool)>| match (back, before) {
                            (Some((bs, can_revert)), Some((fs, _))) => !can_revert && bs == fs,
                            (None, None) => true,
                            _ => false,
                        };
                        let restored = same(&nagle_back, &nagle_before) && same(&throttle_back, &throttle_before);
                        r.step(
                            "netzwerk-tweaks",
                            both_on && restored,
                            format!("angewendet {:?}, danach {nagle_back:?}/{throttle_back:?}", report.applied),
                        );
                    }
                    Ok(Some(code)) => r.step("netzwerk-tweaks", false, format!("--revert-all Exit {code}")),
                    Ok(None) => r.step("netzwerk-tweaks", false, "--revert-all Zeitüberschreitung"),
                    Err(e) => r.step("netzwerk-tweaks", false, e),
                }
            }
            Err(e) => r.step("netzwerk-tweaks", false, e),
        }
    }
}

#[cfg(test)]
mod tests {
    /// Der Selbsttest-Schritt `messwerte-speichern` läuft ohne Netz und ohne Windows –
    /// er muss also schon hier sauber durchlaufen (Stunden-Summen und Aussetzer).
    #[test]
    fn history_roundtrip_is_clean() {
        let (ok, detail) = super::history_roundtrip();
        assert!(ok, "{detail}");
    }
}
