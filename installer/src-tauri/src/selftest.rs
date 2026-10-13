//! `--selftest --dir <dir> [--manifest <url>] [--report <datei>]`: komplette Installation und
//! Deinstallation ohne Oberfläche, mit JSON-Bericht. Exit-Code 0 = alles ok.

use crate::args::CliArgs;
use crate::config::{config, INSTALL_INFO_NAME, UNINSTALLER_NAME};
use crate::download::{self, ProgressFn, RetryPolicy};
use crate::install::{self, InstallPlan};
use crate::manifest::{self, Location};
use crate::platform;
use crate::types::{InstallOptions, Progress};
use crate::uninstall::{self, UninstallPlan};
use crate::util::{display_path, eprint_line, same_path};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SelftestStep {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SelftestReport {
    pub ok: bool,
    pub steps: Vec<SelftestStep>,
}

#[derive(Debug, Clone)]
pub struct SelftestConfig {
    pub dir: PathBuf,
    pub manifest: String,
    pub report: PathBuf,
    /// Quelle für `Uninstall Pulsar.exe` (Standard: die laufende Exe).
    pub uninstaller_source: Option<PathBuf>,
    pub retry: RetryPolicy,
    pub echo: bool,
}

struct Recorder {
    steps: Vec<SelftestStep>,
    echo: bool,
}

impl Recorder {
    fn push(&mut self, name: &str, ok: bool, detail: impl Into<String>) -> bool {
        let detail = detail.into();
        if self.echo {
            eprint_line(format!("[{}] {name}: {detail}", if ok { " OK " } else { "FAIL" }));
        }
        crate::util::log(format!("Selbsttest {name}: {} – {detail}", if ok { "ok" } else { "FEHLER" }));
        self.steps.push(SelftestStep { name: name.into(), ok, detail });
        ok
    }
}

fn missing(paths: &[&Path], should_exist: bool) -> Vec<String> {
    paths.iter().filter(|p| p.exists() != should_exist).map(|p| display_path(p)).collect()
}

pub async fn run_selftest(cfg: &SelftestConfig) -> SelftestReport {
    let mut rec = Recorder { steps: Vec::new(), echo: cfg.echo };
    let integrate = platform::integration_supported();
    let skipped = "skipped (Windows only)";

    // ---- 1. Manifest
    let client = match manifest::build_client() {
        Ok(c) => c,
        Err(e) => {
            rec.push("manifest", false, e);
            return finish(rec);
        }
    };
    let fetched = match Location::parse(&cfg.manifest, None) {
        Ok(loc) => manifest::fetch_manifest(&client, &loc).await.map_err(|e| format!("{}: {}", e.code, e.message)),
        Err(e) => Err(e),
    };
    let manifest = match fetched {
        Ok(m) => {
            rec.push("manifest", true, format!("v{} – {} ({})", m.version, m.app.url, cfg.manifest));
            m
        }
        Err(e) => {
            rec.push("manifest", false, format!("{e} ({})", cfg.manifest));
            return finish(rec);
        }
    };

    let options = InstallOptions {
        dir: display_path(&cfg.dir),
        desktop_shortcut: true,
        start_menu: true,
        autostart: false,
        launch_after: false,
    };
    let mut plan = InstallPlan::new(manifest.clone(), cfg.dir.clone(), options);
    plan.uninstaller_source = cfg.uninstaller_source.clone();
    plan.retry = cfg.retry.clone();
    plan.integrate = true;

    let last_phase = Arc::new(Mutex::new(""));
    let echo = cfg.echo;
    let progress: ProgressFn = {
        let last_phase = last_phase.clone();
        Arc::new(move |p: Progress| {
            let mut last = last_phase.lock().unwrap_or_else(|e| e.into_inner());
            if *last != p.phase {
                *last = p.phase;
                if echo {
                    eprint_line(format!("       {:>5.1}% {}", p.percent, p.phase));
                }
            }
        })
    };
    let cancel = CancellationToken::new();

    // ---- 2. Download
    let spec = match install::prepare_target(&plan).and_then(|_| plan.download_spec()) {
        Ok(s) => s,
        Err(e) => {
            rec.push("download", false, e.to_string());
            cleanup(&mut rec, &plan);
            return finish(rec);
        }
    };
    let started = Instant::now();
    match download::download(&client, &spec, &progress, &cancel, &plan.retry).await {
        Ok(stats) => {
            rec.push(
                "download",
                true,
                format!("{} bytes in {} ms, {} request(s)", stats.size, started.elapsed().as_millis(), stats.requests),
            );
        }
        Err(e) => {
            rec.push("download", false, e.to_string());
            cleanup(&mut rec, &plan);
            return finish(rec);
        }
    }

    // ---- 3. Prüfen
    let verified = match download::verify(&spec, &progress, &cancel).await {
        Ok(v) => {
            rec.push("verify", true, if v { "sha256 ok" } else { "no sha256 in manifest – not verified" });
            v
        }
        Err(e) => {
            rec.push("verify", false, e.to_string());
            cleanup(&mut rec, &plan);
            return finish(rec);
        }
    };

    // ---- 4. Installieren
    match install::finish_install(&plan, &spec, verified, &progress) {
        Ok(done) => {
            rec.push("install", true, format!("{} (v{})", done.exe_path, done.version));
        }
        Err(e) => {
            rec.push("install", false, e.to_string());
            cleanup(&mut rec, &plan);
            return finish(rec);
        }
    }

    // ---- 5. Dateien vorhanden?
    let exe = plan.exe_path();
    let uninstaller = plan.dir.join(UNINSTALLER_NAME);
    let info = plan.dir.join(INSTALL_INFO_NAME);
    let mut expected: Vec<&Path> = vec![&exe, &info];
    if plan.uninstaller_source.is_some() {
        expected.push(&uninstaller);
    }
    let absent = missing(&expected, true);
    let record_ok = install::read_install_record(&plan.dir).is_some_and(|r| r.version == manifest.version);
    let hash_ok = match &manifest.app.sha256 {
        Some(h) => download::sha256_file(&exe).map(|a| a.eq_ignore_ascii_case(h)).unwrap_or(false),
        None => true,
    };
    rec.push(
        "files",
        absent.is_empty() && record_ok && hash_ok,
        if absent.is_empty() && record_ok && hash_ok {
            format!("{} files present, install.json ok", expected.len())
        } else {
            format!("missing: {absent:?}, install.json ok: {record_ok}, exe hash ok: {hash_ok}")
        },
    );

    // ---- 6. Verknüpfungen
    let shortcuts: Vec<PathBuf> = [platform::start_menu_shortcut(), platform::desktop_shortcut()].into_iter().flatten().collect();
    if integrate {
        let refs: Vec<&Path> = shortcuts.iter().map(PathBuf::as_path).collect();
        let absent = missing(&refs, true);
        let autostart_off = platform::autostart_command().is_none();
        let ok = absent.is_empty() && shortcuts.len() == 2 && autostart_off;
        rec.push(
            "shortcuts",
            ok,
            if ok { format!("{} shortcuts, no autostart", shortcuts.len()) } else { format!("missing: {absent:?}, autostart off: {autostart_off}") },
        );
    } else {
        rec.push("shortcuts", true, skipped);
    }

    // ---- 7. Registry
    if integrate {
        let (user, machine) = platform::uninstall_entry_exists();
        let state = platform::read_install_state();
        let state_ok = state.as_ref().is_some_and(|(d, v)| same_path(d, &plan.dir) && *v == manifest.version);
        let ok = (user || machine) && state_ok;
        rec.push("registry", ok, format!("uninstall entry hkcu={user} hklm={machine}, install dir ok: {state_ok}"));
    } else {
        rec.push("registry", true, skipped);
    }

    // ---- 8. Deinstallieren (Daten behalten)
    let mut uplan = UninstallPlan::new(plan.dir.clone(), true);
    uplan.integrate = true;
    match uninstall::run_uninstall(&uplan, &|_| {}) {
        Ok(o) => {
            let detail = if o.warnings.is_empty() { format!("ok, --revert-all: {}", o.revert.describe()) } else { o.warnings.join("; ") };
            rec.push("uninstall", true, detail)
        }
        Err(e) => rec.push("uninstall", false, e),
    };

    // ---- 9. Alles entfernt?
    let mut leftovers = missing(&[&exe, &info, &uninstaller], false);
    if integrate {
        let refs: Vec<&Path> = shortcuts.iter().map(PathBuf::as_path).collect();
        leftovers.extend(missing(&refs, false));
        let (user, machine) = platform::uninstall_entry_exists();
        if user || machine {
            leftovers.push("registry: uninstall entry".into());
        }
        if platform::read_install_state().is_some() {
            leftovers.push(format!("registry: {}", crate::config::STATE_KEY));
        }
    }
    let ok = leftovers.is_empty();
    rec.push("removed", ok, if ok { "all files and entries removed".to_string() } else { format!("left over: {leftovers:?}") });

    finish(rec)
}

/// Nach einem Fehler möglichst sauber aufräumen.
fn cleanup(rec: &mut Recorder, plan: &InstallPlan) {
    let mut uplan = UninstallPlan::new(plan.dir.clone(), true);
    uplan.integrate = plan.exe_path().exists();
    match uninstall::run_uninstall(&uplan, &|_| {}) {
        Ok(_) => rec.push("cleanup", true, "ok"),
        Err(e) => rec.push("cleanup", false, e),
    };
}

fn finish(rec: Recorder) -> SelftestReport {
    SelftestReport { ok: !rec.steps.is_empty() && rec.steps.iter().all(|s| s.ok), steps: rec.steps }
}

pub fn write_report(report: &SelftestReport, path: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_vec_pretty(report).unwrap_or_default())
}

/// Einstiegspunkt für `--selftest`. Liefert den Exit-Code.
pub fn run_from_cli(cli: &CliArgs) -> i32 {
    let Some(dir_raw) = cli.dir.as_ref() else {
        eprint_line("--selftest needs --dir <dir>");
        return 1;
    };
    let dir = match crate::disk::normalize_path(&dir_raw.to_string_lossy()) {
        Ok(d) => d,
        Err(e) => {
            eprint_line(format!("--dir: {e}"));
            return 1;
        }
    };
    let source = manifest::manifest_source_for_process(cli.manifest.as_deref());
    let cfg = SelftestConfig {
        report: cli.report.clone().unwrap_or_else(|| dir.join("selftest.json")),
        dir,
        manifest: source.location,
        uninstaller_source: std::env::current_exe().ok(),
        retry: RetryPolicy::default(),
        echo: true,
    };
    eprint_line(format!("{} selftest – {}", config().app_name, cfg.dir.display()));
    let report = match tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() {
        Ok(rt) => rt.block_on(run_selftest(&cfg)),
        Err(e) => SelftestReport { ok: false, steps: vec![SelftestStep { name: "runtime".into(), ok: false, detail: e.to_string() }] },
    };
    if let Err(e) = write_report(&report, &cfg.report) {
        eprint_line(format!("report {}: {e}", cfg.report.display()));
        return 1;
    }
    eprint_line(format!("{} – report: {}", if report.ok { "SELFTEST OK" } else { "SELFTEST FAILED" }, cfg.report.display()));
    if report.ok {
        0
    } else {
        1
    }
}
