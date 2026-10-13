//! Eingebauter Selbsttest für automatische Prüfungen (z. B. auf dem Windows-Rechner von GitHub):
//!
//! `Pulsar.exe --selftest <bericht.json>`
//!
//! Startet die App normal, ruft dann die echten Backend-Befehle auf (Scan, Bilder, Icons,
//! Starten, Spielzeit-Erkennung, Beenden) und schreibt einen JSON-Bericht. Exit-Code 0 = alles ok.

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
            .unwrap_or_else(|| std::env::temp_dir().join("nova-selftest.json")),
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
                let expect = std::env::var("NOVA_SELFTEST_EXPECT_STEAM").ok();
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

        // 6) Starten + Spielzeit-Erkennung + Beenden
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
