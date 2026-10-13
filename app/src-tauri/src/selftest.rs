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
                let ok = expect.as_ref().map_or(true, |n| names.iter().any(|x| x == n));
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

        // 7) Optimieren: Tweaks lesen, Energiepläne, Boost an/aus (muss den alten Zustand zurückstellen)
        match crate::opt::opt_tweaks(app.state::<Shared>()).await {
            Ok(list) => {
                let ok = list.len() == 4 && (!cfg!(windows) || list.iter().all(|t| t.state != "unknown"));
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
