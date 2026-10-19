//! Sonde des Labors (Stufe 1): läuft **nur in der Windows Sandbox** (Konto
//! `WDAGUtilityAccount`), startet dort die Probe, beobachtet sie und schreibt den
//! Verhaltensbericht (`report.json` + Bildschirmfotos) in den Ausgabe-Ordner. Auf dem echten
//! Rechner verweigert sie den Start.
//!
//! Aufruf (aus der `.wsb`-Konfiguration):
//! `aegis-sandbox-probe --sample <Datei> --out <Ordner> --seconds <n> [--network] [--shutdown]`

#[cfg(windows)]
fn main() {
    std::process::exit(match windows::run(std::env::args().skip(1).collect()) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("aegis-sandbox-probe: {e}");
            2
        }
    });
}

#[cfg(not(windows))]
fn main() {
    eprintln!("aegis-sandbox-probe läuft nur in der Windows Sandbox.");
    std::process::exit(2);
}

#[cfg(windows)]
mod windows {
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use aegis_sandbox::observe::Observer;
    use aegis_sandbox::report::{BehaviorReport, RunEnd, Stage};
    use aegis_winffi::inspect::{self, Hive};

    /// Konto der Windows Sandbox – nur dort darf die Sonde Proben starten.
    const SANDBOX_ACCOUNT: &str = "WDAGUtilityAccount";
    const MAX_SHOTS: usize = 20;

    struct Args {
        sample: PathBuf,
        out: PathBuf,
        seconds: u32,
        network: bool,
        shutdown: bool,
    }

    fn parse(args: Vec<String>) -> Result<Args, String> {
        let mut sample = None;
        let mut out = None;
        let mut seconds = 60u32;
        let (mut network, mut shutdown) = (false, false);
        let mut it = args.into_iter();
        while let Some(a) = it.next() {
            match a.as_str() {
                "--sample" => sample = it.next().map(PathBuf::from),
                "--out" => out = it.next().map(PathBuf::from),
                "--seconds" => {
                    seconds = it
                        .next()
                        .and_then(|s| s.parse().ok())
                        .filter(|s| (5..=600).contains(s))
                        .ok_or("--seconds: 5 bis 600")?;
                }
                "--network" => network = true,
                "--shutdown" => shutdown = true,
                other => return Err(format!("unbekanntes Argument {other}")),
            }
        }
        Ok(Args {
            sample: sample.ok_or("--sample fehlt")?,
            out: out.ok_or("--out fehlt")?,
            seconds,
            network,
            shutdown,
        })
    }

    /// Läuft die Sonde wirklich in der Windows Sandbox? Konto aus dem Prozess-Token (nicht aus
    /// Umgebungsvariablen) und die eingebundenen AEGIS-Ordner müssen passen.
    fn in_windows_sandbox() -> bool {
        let account = aegis_winffi::system::current_account_name()
            .is_ok_and(|u| u.eq_ignore_ascii_case(SANDBOX_ACCOUNT));
        account
            && Path::new(aegis_sandbox::wsb::SANDBOX_PROBE_DIR).is_dir()
            && Path::new(aegis_sandbox::wsb::SANDBOX_OUTPUT_DIR).is_dir()
    }

    fn write_file(path: &Path, data: &[u8]) -> Result<(), String> {
        // Schreibt Bericht/Bildschirmfoto in den Ausgabe-Ordner der Windows Sandbox.
        // aegis-mutation: probe-write-output
        #[allow(clippy::disallowed_methods)]
        let result = std::fs::write(path, data);
        result.map_err(|e| format!("{}: {e}", path.display()))
    }

    pub fn run(args: Vec<String>) -> Result<(), String> {
        let args = parse(args)?;
        if !in_windows_sandbox() {
            return Err(
                "läuft nur in der Windows Sandbox – auf diesem Rechner wird nichts gestartet"
                    .into(),
            );
        }
        let env_dir = |k: &str| std::env::var_os(k).map(PathBuf::from);
        let mut dirs: Vec<PathBuf> = ["USERPROFILE", "ProgramData", "TEMP"]
            .iter()
            .filter_map(|k| env_dir(k))
            .collect();
        if let Some(root) = env_dir("SystemRoot") {
            dirs.push(root.join(r"System32\Tasks"));
        }
        let mut observer = Observer::start(dirs, Hive::CurrentUser, !args.network);
        let work = env_dir("TEMP").unwrap_or_else(|| PathBuf::from(r"C:\"));
        // Startet die Probe – nur innerhalb der Windows Sandbox (oben geprüft), die nach dem
        // Lauf verworfen wird. Gestartet wurde der Lauf nach „Ja, ausführen“ in AEGIS.
        // aegis-mutation: probe-start-sample
        #[allow(clippy::disallowed_methods)]
        let spawned = std::process::Command::new(&args.sample)
            .current_dir(&work)
            .spawn();
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => {
                return finish(
                    &args,
                    observer,
                    RunEnd::Failed {
                        message: format!("Probe startet nicht: {e}"),
                    },
                    Vec::new(),
                );
            }
        };
        let root = child.id();
        let deadline = Instant::now() + Duration::from_secs(u64::from(args.seconds));
        let mut shots = Vec::new();
        let mut last_shot = Instant::now() - Duration::from_secs(10);
        let mut end = RunEnd::TimedOut;
        let mut exited_at: Option<Instant> = None;
        while Instant::now() < deadline {
            let running = observer.poll(&[root]);
            if last_shot.elapsed() >= Duration::from_secs(3) && shots.len() < MAX_SHOTS {
                last_shot = Instant::now();
                if let Ok(c) = inspect::capture_screen()
                    && let Ok(png) = aegis_sandbox::png::encode_bgra(c.width, c.height, &c.bgra)
                {
                    let name = format!("bild-{:02}.png", shots.len() + 1);
                    if write_file(&args.out.join(&name), &png).is_ok() {
                        shots.push(name);
                    }
                }
            }
            if exited_at.is_none()
                && let Ok(Some(status)) = child.try_wait()
            {
                end = RunEnd::Exited {
                    code: i64::from(status.code().unwrap_or(-1)),
                };
                exited_at = Some(Instant::now());
            }
            // Probe und alle Nachkommen beendet: noch kurz nachbeobachten, dann Schluss.
            if exited_at.is_some_and(|t| t.elapsed() > Duration::from_secs(3)) && running.is_empty()
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        finish(&args, observer, end, shots)
    }

    fn finish(
        args: &Args,
        observer: Observer,
        end: RunEnd,
        screenshots: Vec<String>,
    ) -> Result<(), String> {
        let observed = observer.finish();
        let mut notes = vec![
            "Beobachtet in der Windows Sandbox (eigene, wegwerfbare VM).".to_owned(),
            "Befehlszeilen der Prozesse werden in dieser Stufe nicht erfasst.".to_owned(),
        ];
        if !args.network {
            notes.push(
                "Netzwerk war aus – Verbindungsversuche erscheinen nur, solange sie im System sichtbar waren."
                    .to_owned(),
            );
        }
        let mut report = BehaviorReport {
            stage: Stage::WindowsSandbox,
            sample: args
                .sample
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            sha256: None,
            seconds: args.seconds,
            end,
            processes: observed.processes,
            files: observed.files,
            registry: observed.registry,
            network: observed.network,
            screenshots,
            notes,
        };
        report.truncate();
        let json = serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?;
        write_file(&args.out.join("report.json"), &json)?;
        if args.shutdown && in_windows_sandbox() {
            // Fährt nur die Windows Sandbox (VM) herunter – geprüft über das Sandbox-Konto.
            // aegis-mutation: probe-shutdown-sandbox
            #[allow(clippy::disallowed_methods)]
            let _ = std::process::Command::new("shutdown")
                .args(["/s", "/t", "5"])
                .spawn();
        }
        Ok(())
    }
}
