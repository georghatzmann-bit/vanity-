//! Tests des Setup-Kerns (laufen unter Linux ohne Tauri-Laufzeit).

mod server;

use crate::args::{decode_preset, encode_preset, CliArgs};
use crate::commands::compute_mode;
use crate::config::{config, parse_config, DOWNLOAD_DIR_NAME, INSTALL_INFO_NAME, UNINSTALLER_NAME};
use crate::disk::{disk_info, normalize_windows_path};
use crate::download::{self, DownloadSpec, PartMeta, ProgressFn, RetryPolicy};
use crate::install::{self, InstallPlan};
use crate::manifest::{fetch_manifest, resolve_manifest_source, Location, ManifestOrigin};
use crate::selftest::{run_selftest, SelftestConfig};
use crate::types::{InstallOptions, InstallRecord, Manifest, ManifestFile, Progress, SetupMode, UninstallProgress};
use crate::uninstall::{run_uninstall, UninstallPlan};
use server::{closed_url, TestServer};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const APP: &str = "NovaLauncher.exe";
const SIZE: usize = 3 * 1024 * 1024 + 12_345;

// ------------------------------------------------------------------ Helfer

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!("nova-setup-test-{tag}-{}", crate::util::random_suffix()));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
    fn path(&self) -> &Path {
        &self.0
    }
    fn join(&self, p: &str) -> PathBuf {
        self.0.join(p)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn test_data(len: usize, seed: u64) -> Vec<u8> {
    let mut x = seed | 1;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 24) as u8
        })
        .collect()
}

fn sha(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn recorder() -> (ProgressFn, Arc<Mutex<Vec<Progress>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    (Arc::new(move |p: Progress| sink.lock().unwrap().push(p)), events)
}

fn fast_retry() -> RetryPolicy {
    RetryPolicy { delays: vec![Duration::from_millis(20); 4] }
}

fn spec(url: &str, data: &[u8], work: &Path, with_size: bool, with_sha: bool) -> DownloadSpec {
    DownloadSpec {
        source: Location::parse(url, None).unwrap(),
        sha256: with_sha.then(|| sha(data)),
        size: with_size.then_some(data.len() as u64),
        version: "1.2.3".into(),
        work_dir: work.to_path_buf(),
        file_name: APP.into(),
    }
}

fn write_meta_for(spec: &DownloadSpec) {
    std::fs::create_dir_all(&spec.work_dir).unwrap();
    let meta = PartMeta {
        url: spec.source.to_url_string(),
        sha256: spec.sha256.clone(),
        size: spec.size,
        version: spec.version.clone(),
        etag: None,
        last_modified: None,
    };
    std::fs::write(spec.meta_path(), serde_json::to_vec(&meta).unwrap()).unwrap();
}

fn manifest_json(version: &str, url: &str, sha256: Option<&str>, size: Option<u64>) -> String {
    let mut app = serde_json::json!({ "url": url });
    if let Some(s) = sha256 {
        app["sha256"] = serde_json::json!(s);
    }
    if let Some(s) = size {
        app["size"] = serde_json::json!(s);
    }
    serde_json::json!({ "name": "Nova Launcher", "version": version, "notes": "Neu", "pubDate": "2026-10-12T12:00:00Z", "app": app })
        .to_string()
}

fn client() -> reqwest::Client {
    crate::manifest::build_client().unwrap()
}

// ------------------------------------------------------------------ Konfiguration / Kommandozeile

#[test]
fn embedded_config_parses() {
    let cfg = config();
    assert_eq!(cfg.app_exe_name, "NovaLauncher.exe");
    assert_eq!(cfg.app_name, "Nova Launcher");
    assert!(!cfg.manifest_url.is_empty());
    assert!(parse_config("{ broken").is_none());
}

#[test]
fn cli_parsing() {
    let cli = CliArgs::parse([
        "--uninstall",
        "--target",
        "\"C:\\Program Files\\Nova Launcher\"",
        "--manifest=https://example.com/latest.json",
        "--quiet",
    ]);
    assert!(cli.uninstall && cli.quiet && !cli.update && !cli.selftest);
    assert_eq!(cli.target, Some(PathBuf::from("C:\\Program Files\\Nova Launcher")));
    assert_eq!(cli.manifest.as_deref(), Some("https://example.com/latest.json"));

    let opts = InstallOptions { dir: "D:\\Spiele\\Nova".into(), desktop_shortcut: true, start_menu: false, autostart: true, launch_after: true };
    let cli = CliArgs::parse(["--elevated".to_string(), "--preset".to_string(), encode_preset(&opts), "--update".to_string()]);
    assert!(cli.elevated && cli.update);
    assert_eq!(cli.preset, Some(opts));

    let cli = CliArgs::parse(["--selftest", "--dir", "/tmp/x", "--report", "/tmp/r.json", "--unknown", "value"]);
    assert!(cli.selftest);
    assert_eq!(cli.dir, Some(PathBuf::from("/tmp/x")));
    assert_eq!(cli.report, Some(PathBuf::from("/tmp/r.json")));
}

#[test]
fn preset_roundtrip() {
    let opts = InstallOptions {
        dir: "C:\\Program Files\\Nova Launcher – ä".into(),
        desktop_shortcut: true,
        start_menu: true,
        autostart: false,
        launch_after: true,
    };
    let encoded = encode_preset(&opts);
    assert!(encoded.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'), "url-safe: {encoded}");
    assert_eq!(decode_preset(&encoded).unwrap(), opts);
    // Standard-Base64 mit Padding wird ebenfalls akzeptiert, fehlende Felder bekommen Standardwerte.
    use base64::Engine;
    let std_b64 = base64::engine::general_purpose::STANDARD.encode(br#"{"dir":"C:\\X","startMenu":true}"#);
    let d = decode_preset(&std_b64).unwrap();
    assert_eq!(d.dir, "C:\\X");
    assert!(d.start_menu && !d.desktop_shortcut);
    assert!(decode_preset("%%%nope").is_err());
    assert!(decode_preset(&base64::engine::general_purpose::STANDARD.encode(b"not json")).is_err());
}

#[test]
fn setup_mode_logic() {
    let parse = |a: &[&str]| CliArgs::parse(a.iter().copied());
    assert_eq!(compute_mode(&parse(&[]), false), SetupMode::Install);
    assert_eq!(compute_mode(&parse(&[]), true), SetupMode::Maintenance);
    assert_eq!(compute_mode(&parse(&["--update"]), true), SetupMode::Update);
    assert_eq!(compute_mode(&parse(&["--update"]), false), SetupMode::Install);
    assert_eq!(compute_mode(&parse(&["--uninstall"]), true), SetupMode::Uninstall);
    let preset = encode_preset(&InstallOptions::default());
    assert_eq!(compute_mode(&parse(&["--elevated", "--preset", &preset]), true), SetupMode::Install);
}

#[test]
fn helpers() {
    use crate::util::{quote_windows_arg, rfc3339_utc};
    assert_eq!(quote_windows_arg("plain"), "plain");
    assert_eq!(quote_windows_arg("C:\\Program Files\\Nova\\"), "\"C:\\Program Files\\Nova\\\\\"");
    assert_eq!(quote_windows_arg("a\"b"), "\"a\\\"b\"");
    assert_eq!(quote_windows_arg(""), "\"\"");
    assert_eq!(rfc3339_utc(0), "1970-01-01T00:00:00Z");
    assert_eq!(rfc3339_utc(1_760_270_400), "2025-10-12T12:00:00Z");
    assert_eq!(rfc3339_utc(951_782_400), "2000-02-29T00:00:00Z");
    assert_eq!(crate::util::today_yyyymmdd().len(), 8);
}

#[test]
fn serialization_is_camel_case() {
    let info = crate::types::SetupInfo {
        mode: SetupMode::Maintenance,
        setup_version: "1.0.0".into(),
        app_name: "Nova Launcher".into(),
        default_dir: "C:\\x".into(),
        installed: None,
        elevated: false,
        system_lang: "de".into(),
        preset: None,
        manifest_url: "https://x".into(),
    };
    let v = serde_json::to_value(&info).unwrap();
    assert_eq!(v["mode"], "maintenance");
    assert!(v.get("setupVersion").is_some() && v.get("defaultDir").is_some() && v.get("manifestUrl").is_some());
    assert!(v.get("installed").is_none() && v.get("preset").is_none());
    let d = serde_json::to_value(crate::types::DiskInfo { needs_admin: true, ..Default::default() }).unwrap();
    assert_eq!(d["needsAdmin"], true);
    let p = serde_json::to_value(Progress::step("verify", 90.0)).unwrap();
    assert_eq!(p["phase"], "verify");
    for key in ["downloaded", "total", "speed", "eta", "percent"] {
        assert!(p.get(key).is_some(), "{key}");
    }
    let done = serde_json::to_value(crate::types::InstallDone { dir: "d".into(), exe_path: "e".into(), version: "1".into(), verified: true }).unwrap();
    assert_eq!(done["exePath"], "e");
}

// ------------------------------------------------------------------ Manifest

#[test]
fn manifest_source_resolution_order() {
    let tmp = TempDir::new("source");
    let embedded = "https://embedded.example/latest.json";
    let s = resolve_manifest_source(Some("https://cli.example/l.json"), Some("https://env.example/l.json"), Some(tmp.path()), embedded);
    assert_eq!((s.origin, s.location.as_str()), (ManifestOrigin::CommandLine, "https://cli.example/l.json"));
    let s = resolve_manifest_source(None, Some("https://env.example/l.json"), Some(tmp.path()), embedded);
    assert_eq!((s.origin, s.location.as_str()), (ManifestOrigin::Environment, "https://env.example/l.json"));
    let s = resolve_manifest_source(None, None, Some(tmp.path()), embedded);
    assert_eq!((s.origin, s.location.as_str()), (ManifestOrigin::Embedded, embedded));
    std::fs::write(tmp.join("nova-setup.json"), "\u{feff}{ \"manifestUrl\": \"feed/latest.json\" }").unwrap();
    let s = resolve_manifest_source(Some("  "), Some(""), Some(tmp.path()), embedded);
    assert_eq!(s.origin, ManifestOrigin::OverrideFile);
    assert_eq!(PathBuf::from(&s.location), tmp.join("feed").join("latest.json"));
    // Relativer Pfad auf der Kommandozeile wird absolut gemacht.
    let s = resolve_manifest_source(Some("some/latest.json"), None, None, embedded);
    assert!(Path::new(&s.location).is_absolute());
}

#[test]
fn location_resolution() {
    let base = Location::parse("https://github.com/o/r/releases/latest/download/latest.json", None).unwrap();
    assert_eq!(base.join(APP).unwrap().to_url_string(), "https://github.com/o/r/releases/latest/download/NovaLauncher.exe");
    assert_eq!(base.join("../v2/x.exe").unwrap().to_url_string(), "https://github.com/o/r/releases/latest/v2/x.exe");
    assert_eq!(base.join("https://cdn.example/a.exe").unwrap().to_url_string(), "https://cdn.example/a.exe");
    // Dateipfade sind plattformabhängig (Windows braucht einen Laufwerksbuchstaben).
    #[cfg(windows)]
    let (path, url, url_upper, joined) = ("C:\\srv\\feed\\latest.json", "file:///C:/srv/feed/latest.json", "FILE:///C:/srv/feed/latest.json", "C:\\srv\\feed\\bin\\NovaLauncher.exe");
    #[cfg(not(windows))]
    let (path, url, url_upper, joined) = ("/srv/feed/latest.json", "file:///srv/feed/latest.json", "FILE:///srv/feed/latest.json", "/srv/feed/bin/NovaLauncher.exe");
    let file = Location::parse(path, None).unwrap();
    assert_eq!(file.join("bin/NovaLauncher.exe").unwrap(), Location::File(PathBuf::from(joined)));
    assert_eq!(Location::parse(url, None).unwrap(), file);
    assert_eq!(Location::parse(url_upper, None).unwrap(), file);
    assert!(Location::parse("", None).is_err());
    assert!(base.join("  ").is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manifest_over_http_with_relative_url_and_errors() {
    let srv = TestServer::start();
    let data = test_data(1000, 1);
    let upper = sha(&data).to_ascii_uppercase();
    srv.add_file("/feed/latest.json", manifest_json("2.0.0", APP, Some(&upper), Some(1000)));
    srv.add_file("/bad.json", "{ not json");
    srv.add_file("/nover.json", r#"{ "version": "", "app": { "url": "x" } }"#);
    srv.add_file("/badsha.json", manifest_json("1.0.0", APP, Some("abc"), None));
    let c = client();
    let loc = Location::parse(&srv.url("/feed/latest.json"), None).unwrap();
    let m = fetch_manifest(&c, &loc).await.unwrap();
    assert_eq!(m.version, "2.0.0");
    assert_eq!(m.app.url, srv.url("/feed/NovaLauncher.exe"));
    assert_eq!(m.app.sha256.as_deref(), Some(sha(&data).as_str()));
    assert_eq!(m.app.size, Some(1000));
    assert_eq!(m.notes.as_deref(), Some("Neu"));

    for (path, code) in [("/missing.json", "manifest"), ("/bad.json", "manifest"), ("/nover.json", "manifest"), ("/badsha.json", "manifest")] {
        let err = fetch_manifest(&c, &Location::parse(&srv.url(path), None).unwrap()).await.unwrap_err();
        assert_eq!(err.code, code, "{path}: {}", err.message);
    }
    let err = fetch_manifest(&c, &Location::parse(&closed_url("/latest.json"), None).unwrap()).await.unwrap_err();
    assert_eq!(err.code, "network", "{}", err.message);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manifest_from_local_path_and_file_url() {
    let tmp = TempDir::new("manifest-file");
    let data = test_data(200_000, 2);
    std::fs::write(tmp.join(APP), &data).unwrap();
    std::fs::write(tmp.join("latest.json"), manifest_json("3.1.0", APP, Some(&sha(&data)), Some(data.len() as u64))).unwrap();
    let c = client();
    let by_path = fetch_manifest(&c, &Location::parse(&tmp.join("latest.json").to_string_lossy(), None).unwrap()).await.unwrap();
    let file_url = reqwest::Url::from_file_path(tmp.join("latest.json")).unwrap().to_string();
    let by_url = fetch_manifest(&c, &Location::parse(&file_url, None).unwrap()).await.unwrap();
    assert_eq!(by_path, by_url);
    let expected_app = reqwest::Url::from_file_path(tmp.join(APP)).unwrap().to_string();
    assert_eq!(by_path.app.url, expected_app);

    // Download aus lokaler Quelle (für Offline-Tests) inkl. Prüfung.
    let work = tmp.join("work");
    let s = DownloadSpec {
        source: Location::parse(&by_path.app.url, None).unwrap(),
        sha256: by_path.app.sha256.clone(),
        size: by_path.app.size,
        version: by_path.version.clone(),
        work_dir: work.clone(),
        file_name: APP.into(),
    };
    let (progress, _) = recorder();
    let cancel = CancellationToken::new();
    download::download(&c, &s, &progress, &cancel, &fast_retry()).await.unwrap();
    assert!(download::verify(&s, &progress, &cancel).await.unwrap());

    let missing = fetch_manifest(&c, &Location::parse(&tmp.join("nope.json").to_string_lossy(), None).unwrap()).await.unwrap_err();
    assert_eq!(missing.code, "manifest");
}

// ------------------------------------------------------------------ Download

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn download_full_and_verify() {
    let srv = TestServer::start();
    let data = test_data(SIZE, 3);
    srv.add_file("/NovaLauncher.exe", data.clone());
    let tmp = TempDir::new("full");
    let s = spec(&srv.url("/NovaLauncher.exe"), &data, &tmp.join("dl"), true, true);
    let (progress, events) = recorder();
    let cancel = CancellationToken::new();
    let stats = download::download(&client(), &s, &progress, &cancel, &fast_retry()).await.unwrap();
    assert_eq!(stats.requests, 1);
    assert_eq!(stats.size, data.len() as u64);
    assert_eq!(stats.resumed_from, None);
    assert!(download::verify(&s, &progress, &cancel).await.unwrap());
    assert_eq!(std::fs::read(s.part_path()).unwrap(), data);

    let ev = events.lock().unwrap();
    assert_eq!(ev.first().unwrap().phase, "connect");
    let last = ev.last().unwrap();
    assert_eq!((last.phase, last.percent), ("verify", download::VERIFY_END));
    let mut prev = 0.0;
    for e in ev.iter() {
        assert!(e.percent + 1e-9 >= prev, "percent must not go backwards: {e:?}");
        assert!(e.percent <= 100.0);
        prev = e.percent;
    }
    let dl: Vec<_> = ev.iter().filter(|e| e.phase == "download").collect();
    assert!(dl.iter().all(|e| e.total == data.len() as u64 && e.percent <= download::DOWNLOAD_END));
    assert_eq!(dl.last().unwrap().downloaded, data.len() as u64);
    assert_eq!(srv.requests_for("/NovaLauncher.exe")[0].range, None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn download_resumes_after_disconnect() {
    let srv = TestServer::start();
    let data = test_data(SIZE, 4);
    srv.add_file("/files/NovaLauncher.exe", data.clone());
    srv.add_redirect("/latest/NovaLauncher.exe", "/files/NovaLauncher.exe");
    srv.drop_once_after("/files/NovaLauncher.exe", 1_000_000);
    let tmp = TempDir::new("resume");
    let s = spec(&srv.url("/latest/NovaLauncher.exe"), &data, &tmp.join("dl"), true, true);
    let (progress, _) = recorder();
    let cancel = CancellationToken::new();
    let stats = download::download(&client(), &s, &progress, &cancel, &fast_retry()).await.unwrap();
    assert_eq!(stats.requests, 2, "one retry after the forced disconnect");
    let reqs = srv.requests_for("/files/NovaLauncher.exe");
    assert_eq!(reqs.len(), 2);
    assert_eq!(reqs[0].range, None);
    let offset = stats.resumed_from.expect("second request resumed");
    assert!(offset > 0 && offset <= 1_000_000, "offset {offset}");
    assert_eq!(reqs[1].range.as_deref(), Some(format!("bytes={offset}-").as_str()));
    assert_eq!(reqs[1].status, 206);
    // Die Weiterleitung wurde für beide Versuche befolgt (Range-Header blieb erhalten).
    assert_eq!(srv.requests_for("/latest/NovaLauncher.exe").len(), 2);
    assert!(download::verify(&s, &progress, &cancel).await.unwrap());
    assert_eq!(download::sha256_file(&s.part_path()).unwrap(), sha(&data));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn network_error_keeps_part_and_next_call_resumes() {
    let srv = TestServer::start();
    let data = test_data(SIZE, 5);
    srv.add_file("/NovaLauncher.exe", data.clone());
    srv.drop_once_after("/NovaLauncher.exe", 700_000);
    let tmp = TempDir::new("keep-part");
    let s = spec(&srv.url("/NovaLauncher.exe"), &data, &tmp.join("dl"), true, true);
    let (progress, _) = recorder();
    let cancel = CancellationToken::new();
    let err = download::download(&client(), &s, &progress, &cancel, &RetryPolicy::none()).await.unwrap_err();
    assert_eq!((err.phase, err.code, err.retryable), ("download", "network", true));
    let kept = std::fs::metadata(s.part_path()).unwrap().len();
    assert!(kept > 0 && kept <= 700_000, "kept {kept}");
    assert!(s.meta_path().exists());

    // "Erneut versuchen" = neuer start_install-Aufruf: setzt fort.
    let stats = download::download(&client(), &s, &progress, &cancel, &RetryPolicy::none()).await.unwrap();
    assert_eq!(stats.resumed_from, Some(kept));
    assert_eq!(stats.bytes_transferred, data.len() as u64 - kept);
    assert_eq!(srv.requests_for("/NovaLauncher.exe")[1].range.as_deref(), Some(format!("bytes={kept}-").as_str()));
    assert!(download::verify(&s, &progress, &cancel).await.unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checksum_mismatch_removes_part() {
    let srv = TestServer::start();
    let data = test_data(500_000, 6);
    srv.add_file("/NovaLauncher.exe", data.clone());
    let tmp = TempDir::new("checksum");
    let mut s = spec(&srv.url("/NovaLauncher.exe"), &data, &tmp.join("dl"), true, true);
    s.sha256 = Some(sha(b"something else"));
    let (progress, _) = recorder();
    let cancel = CancellationToken::new();
    download::download(&client(), &s, &progress, &cancel, &fast_retry()).await.unwrap();
    assert!(s.part_path().exists());
    let err = download::verify(&s, &progress, &cancel).await.unwrap_err();
    assert_eq!((err.phase, err.code, err.retryable), ("verify", "checksum", true));
    assert!(!s.part_path().exists(), ".part must be deleted");
    assert!(!s.meta_path().exists(), "meta.json must be deleted");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn server_ignoring_range_restarts_from_zero() {
    let srv = TestServer::start();
    let data = test_data(SIZE, 7);
    srv.add_file("/NovaLauncher.exe", data.clone());
    srv.set_ignore_range(true);
    let tmp = TempDir::new("ignore-range");
    let s = spec(&srv.url("/NovaLauncher.exe"), &data, &tmp.join("dl"), true, true);
    write_meta_for(&s);
    std::fs::write(s.part_path(), vec![0xAAu8; 512_000]).unwrap(); // passende Meta, aber Inhalt egal
    let (progress, _) = recorder();
    let cancel = CancellationToken::new();
    let stats = download::download(&client(), &s, &progress, &cancel, &fast_retry()).await.unwrap();
    let reqs = srv.requests_for("/NovaLauncher.exe");
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].range.as_deref(), Some("bytes=512000-"));
    assert_eq!(reqs[0].status, 200);
    assert_eq!(stats.resumed_from, None);
    assert_eq!(stats.bytes_transferred, data.len() as u64);
    assert!(download::verify(&s, &progress, &cancel).await.unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn range_not_satisfiable_means_complete() {
    let srv = TestServer::start();
    let data = test_data(300_000, 8);
    srv.add_file("/NovaLauncher.exe", data.clone());
    let tmp = TempDir::new("416");
    let s = spec(&srv.url("/NovaLauncher.exe"), &data, &tmp.join("dl"), false, true); // Größe unbekannt
    write_meta_for(&s);
    std::fs::write(s.part_path(), &data).unwrap();
    let (progress, _) = recorder();
    let cancel = CancellationToken::new();
    let stats = download::download(&client(), &s, &progress, &cancel, &fast_retry()).await.unwrap();
    let reqs = srv.requests_for("/NovaLauncher.exe");
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].status, 416);
    assert_eq!(stats.bytes_transferred, 0);
    assert!(download::verify(&s, &progress, &cancel).await.unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn complete_part_skips_network_and_stale_part_is_discarded() {
    let srv = TestServer::start();
    let data = test_data(400_000, 9);
    srv.add_file("/NovaLauncher.exe", data.clone());
    let tmp = TempDir::new("complete");
    let s = spec(&srv.url("/NovaLauncher.exe"), &data, &tmp.join("dl"), true, true);
    write_meta_for(&s);
    std::fs::write(s.part_path(), &data).unwrap();
    let (progress, _) = recorder();
    let cancel = CancellationToken::new();
    let stats = download::download(&client(), &s, &progress, &cancel, &fast_retry()).await.unwrap();
    assert_eq!(stats.requests, 0, "already complete – no request");

    // Teil-Datei einer anderen Version: verwerfen und neu laden (ohne Range).
    let mut other = s.clone();
    other.version = "0.9.0".into();
    write_meta_for(&other);
    std::fs::write(s.part_path(), vec![1u8; 100_000]).unwrap();
    let stats = download::download(&client(), &s, &progress, &cancel, &fast_retry()).await.unwrap();
    assert_eq!(stats.requests, 1);
    assert_eq!(srv.requests_for("/NovaLauncher.exe")[0].range, None);
    assert!(download::verify(&s, &progress, &cancel).await.unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_keeps_part() {
    let srv = TestServer::start();
    let data = test_data(SIZE, 10);
    srv.add_file("/NovaLauncher.exe", data.clone());
    srv.set_throttle(Some(Duration::from_millis(25)));
    let tmp = TempDir::new("cancel");
    let s = spec(&srv.url("/NovaLauncher.exe"), &data, &tmp.join("dl"), true, true);
    let (progress, events) = recorder();
    let cancel = CancellationToken::new();
    let c2 = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        c2.cancel();
    });
    let err = download::download(&client(), &s, &progress, &cancel, &fast_retry()).await.unwrap_err();
    assert_eq!((err.code, err.retryable), ("cancelled", true));
    let kept = std::fs::metadata(s.part_path()).map(|m| m.len()).unwrap_or(0);
    assert!(kept > 0 && kept < data.len() as u64, "kept {kept}");
    assert!(events.lock().unwrap().iter().any(|e| e.phase == "download" && e.speed > 0.0), "speed is reported");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_404_is_a_network_error() {
    let srv = TestServer::start();
    let tmp = TempDir::new("404");
    let s = spec(&srv.url("/nothing.exe"), b"x", &tmp.join("dl"), false, false);
    let (progress, _) = recorder();
    let err = download::download(&client(), &s, &progress, &CancellationToken::new(), &fast_retry()).await.unwrap_err();
    assert_eq!((err.phase, err.code), ("download", "network"));
    assert!(err.message.contains("404"));
}

// ------------------------------------------------------------------ Laufwerk

#[test]
fn disk_space_on_temp_dir() {
    let tmp = TempDir::new("disk");
    let info = disk_info(&tmp.path().to_string_lossy(), 1000, false);
    assert!(info.valid && info.exists && info.writable && !info.needs_admin, "{info:?}");
    assert!(info.free > 0 && info.total >= info.free, "{info:?}");
    assert_eq!(info.required, 1000);
    assert!(info.message.is_none());

    let sub = tmp.join("a/b/../c/Nova Launcher");
    let info = disk_info(&sub.to_string_lossy(), 1000, false);
    assert!(info.valid && !info.exists && info.writable, "{info:?}");
    assert_eq!(PathBuf::from(&info.path), tmp.join("a/c/Nova Launcher"));
    assert!(info.free > 0);

    for bad in ["", "   ", "relative/path"] {
        let info = disk_info(bad, 1000, false);
        assert!(!info.valid && info.message.is_some(), "{bad:?}: {info:?}");
    }
    std::fs::write(tmp.join("file.txt"), "x").unwrap();
    let info = disk_info(&tmp.join("file.txt").to_string_lossy(), 1000, false);
    assert!(!info.valid && info.message.is_some());

    let info = disk_info(&tmp.path().to_string_lossy(), u64::MAX, false);
    assert!(info.valid && info.message.is_some(), "low space is reported");
    // Keine Reste der Schreibprobe.
    assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 1);
}

#[test]
fn windows_path_validation() {
    let ok = |s: &str| normalize_windows_path(s).unwrap();
    assert_eq!(ok("C:/Games/Nova"), "C:\\Games\\Nova");
    assert_eq!(ok("  \"c:\\Program Files\\Nova Launcher\\\"  "), "C:\\Program Files\\Nova Launcher");
    assert_eq!(ok("D:\\a\\..\\b\\.\\c\\\\d"), "D:\\b\\c\\d");
    assert_eq!(ok("\\\\server\\share\\Nova"), "\\\\server\\share\\Nova");
    assert_eq!(ok("C:\\Spiele\\COM10"), "C:\\Spiele\\COM10");
    assert_eq!(ok("C:\\"), "C:\\");
    for bad in ["", "Games\\Nova", "C:", "C:Games", "\\Games", "C:\\Ga<mes", "C:\\a|b", "C:\\CON\\x", "C:\\x\\com1.txt", "C:\\folder.", "C:\\trail \\x", "\\\\server"] {
        assert!(normalize_windows_path(bad).is_err(), "{bad:?} should be invalid");
    }
    assert!(normalize_windows_path(&format!("C:\\{}", "a".repeat(250))).is_err());
}

// ------------------------------------------------------------------ Installieren / Deinstallieren

fn test_manifest(url: String, data: &[u8], with_sha: bool) -> Manifest {
    Manifest {
        version: "1.2.3".into(),
        notes: None,
        pub_date: None,
        app: ManifestFile { url, sha256: with_sha.then(|| sha(data)), size: Some(data.len() as u64) },
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn install_and_uninstall_files() {
    let _guard = system_lock();
    let srv = TestServer::start();
    let data = test_data(SIZE, 11);
    srv.add_file("/NovaLauncher.exe", data.clone());
    let tmp = TempDir::new("install");
    let setup = tmp.join("NovaLauncher-Setup.exe");
    std::fs::write(&setup, b"setup-binary").unwrap();
    let dir = tmp.join("Programs/Nova Launcher");
    let options = InstallOptions { dir: String::new(), desktop_shortcut: true, start_menu: true, autostart: false, launch_after: true };
    let mut plan = InstallPlan::new(test_manifest(srv.url("/NovaLauncher.exe"), &data, true), dir.clone(), options);
    plan.uninstaller_source = Some(setup.clone());
    plan.retry = fast_retry();
    let (progress, events) = recorder();
    let done = install::run_install(&client(), &plan, &progress, &CancellationToken::new()).await.unwrap();

    assert_eq!(done.version, "1.2.3");
    assert!(done.verified);
    assert_eq!(PathBuf::from(&done.exe_path), dir.join(APP));
    assert_eq!(PathBuf::from(&done.dir), dir);
    assert_eq!(std::fs::read(dir.join(APP)).unwrap(), data);
    assert_eq!(std::fs::read(dir.join(UNINSTALLER_NAME)).unwrap(), b"setup-binary");
    assert!(!dir.join(DOWNLOAD_DIR_NAME).exists(), "download folder removed");
    let record: InstallRecord = serde_json::from_slice(&std::fs::read(dir.join(INSTALL_INFO_NAME)).unwrap()).unwrap();
    assert_eq!(record.version, "1.2.3");
    assert_eq!(PathBuf::from(&record.options.dir), dir);
    assert!(record.options.desktop_shortcut && record.options.start_menu && !record.options.autostart);
    let raw: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join(INSTALL_INFO_NAME)).unwrap()).unwrap();
    assert!(raw.get("installedAt").is_some() && raw.get("options").is_some());

    let ev = events.lock().unwrap().clone();
    let phases: Vec<&str> = ev.iter().map(|e| e.phase).collect();
    for p in ["connect", "download", "verify", "install", "done"] {
        assert!(phases.contains(&p), "phase {p} missing: {phases:?}");
    }
    assert_eq!(ev.last().unwrap().percent, 100.0);
    assert!(ev.windows(2).all(|w| w[1].percent + 1e-9 >= w[0].percent), "monotonic");

    // Update-Modus übernimmt Ordner und alte Verknüpfungs-Auswahl.
    let given = InstallOptions { dir: "/elsewhere".into(), desktop_shortcut: false, start_menu: false, autostart: true, launch_after: true };
    let eff = install::effective_update_options(&given, &dir);
    assert_eq!(PathBuf::from(&eff.dir), dir);
    assert!(eff.desktop_shortcut && eff.start_menu && !eff.autostart && eff.launch_after);

    // Erneute Installation (Reparatur) ersetzt vorhandene Dateien.
    let done2 = install::run_install(&client(), &plan, &progress, &CancellationToken::new()).await.unwrap();
    assert_eq!(done2, done);

    // Deinstallation: Benutzerdaten löschen.
    let roaming = tmp.join("roaming/com.nova.launcher");
    let local = tmp.join("local/com.nova.launcher");
    let unrelated = tmp.join("local/other-app");
    for d in [&roaming, &local, &unrelated] {
        std::fs::create_dir_all(d).unwrap();
        std::fs::write(d.join("data.db"), b"x").unwrap();
    }
    let uplan = UninstallPlan {
        dir: dir.clone(),
        keep_data: false,
        data_dirs: vec![roaming.clone(), local.clone(), unrelated.clone()],
        integrate: true,
        self_exe: None,
        app_exe_name: APP.into(),
    };
    let steps = Arc::new(Mutex::new(Vec::<UninstallProgress>::new()));
    let sink = steps.clone();
    let outcome = run_uninstall(&uplan, &move |p| sink.lock().unwrap().push(p)).unwrap();
    assert!(outcome.dir_removed && !outcome.self_delete_pending, "{outcome:?}");
    assert!(!dir.exists());
    assert!(!roaming.exists() && !local.exists());
    assert!(unrelated.exists(), "only folders named com.nova.launcher are removed");
    let names: Vec<&str> = steps.lock().unwrap().iter().map(|p| p.step).collect();
    assert_eq!(names.first(), Some(&"stop"));
    assert_eq!(names.last(), Some(&"done"));
    for s in ["shortcuts", "registry", "files", "data"] {
        assert!(names.contains(&s), "{s} missing: {names:?}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn uninstall_keeps_foreign_files_and_data() {
    let tmp = TempDir::new("uninstall-keep");
    let dir = tmp.join("Nova");
    std::fs::create_dir_all(dir.join(DOWNLOAD_DIR_NAME)).unwrap();
    for f in [APP, UNINSTALLER_NAME, INSTALL_INFO_NAME] {
        std::fs::write(dir.join(f), b"x").unwrap();
    }
    std::fs::write(dir.join("my-notes.txt"), b"keep me").unwrap();
    let data_dir = tmp.join("roaming/com.nova.launcher");
    std::fs::create_dir_all(&data_dir).unwrap();
    let plan = UninstallPlan {
        dir: dir.clone(),
        keep_data: true,
        data_dirs: vec![data_dir.clone()],
        integrate: false,
        self_exe: None,
        app_exe_name: APP.into(),
    };
    let outcome = run_uninstall(&plan, &|_| {}).unwrap();
    assert!(!outcome.dir_removed);
    for f in [APP, UNINSTALLER_NAME, INSTALL_INFO_NAME, DOWNLOAD_DIR_NAME] {
        assert!(!dir.join(f).exists(), "{f} should be gone");
    }
    assert!(dir.join("my-notes.txt").exists());
    assert!(data_dir.exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn install_reports_disk_and_permission_problems() {
    let _guard = system_lock();
    let tmp = TempDir::new("install-errors");
    std::fs::write(tmp.join("blocker"), b"file").unwrap();
    let data = test_data(1000, 12);
    // Zielordner liegt "in" einer Datei → kann nicht angelegt werden.
    let plan = InstallPlan::new(test_manifest("http://127.0.0.1:9/x.exe".into(), &data, true), tmp.join("blocker/sub"), InstallOptions::default());
    let (progress, _) = recorder();
    let err = install::run_install(&client(), &plan, &progress, &CancellationToken::new()).await.unwrap_err();
    assert_eq!(err.phase, "download");
    assert!(["permission", "unknown"].contains(&err.code), "{err:?}");

    // Riesige Datei laut Manifest → `disk`.
    let mut m = test_manifest("http://127.0.0.1:9/x.exe".into(), &data, true);
    m.app.size = Some(u64::MAX / 4);
    let plan = InstallPlan::new(m, tmp.join("ok"), InstallOptions::default());
    let err = install::run_install(&client(), &plan, &progress, &CancellationToken::new()).await.unwrap_err();
    assert_eq!((err.phase, err.code, err.retryable), ("download", "disk", true));
}

/// Tests, die unter Windows echte Verknüpfungen und Registry-Einträge anlegen, dürfen nicht
/// gleichzeitig laufen – sonst überschreiben sie sich gegenseitig den Installationsort.
fn system_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

// ------------------------------------------------------------------ Selbsttest

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn selftest_end_to_end() {
    let _guard = system_lock();
    let srv = TestServer::start();
    let data = test_data(SIZE, 13);
    srv.add_file("/rel/NovaLauncher.exe", data.clone());
    srv.add_file("/rel/latest.json", manifest_json("4.5.6", APP, Some(&sha(&data)), Some(data.len() as u64)));
    srv.drop_once_after("/rel/NovaLauncher.exe", 800_000);
    let tmp = TempDir::new("selftest");
    let setup = tmp.join("setup.exe");
    std::fs::write(&setup, b"setup").unwrap();
    let cfg = SelftestConfig {
        dir: tmp.join("install"),
        manifest: srv.url("/rel/latest.json"),
        report: tmp.join("report.json"),
        uninstaller_source: Some(setup),
        retry: fast_retry(),
        echo: false,
    };
    let report = run_selftest(&cfg).await;
    assert!(report.ok, "{report:#?}");
    let names: Vec<&str> = report.steps.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["manifest", "download", "verify", "install", "files", "shortcuts", "registry", "uninstall", "removed"]);
    assert!(report.steps[0].detail.contains("4.5.6"));
    assert_eq!(srv.requests_for("/rel/NovaLauncher.exe").len(), 2, "resumed once");
    assert!(!cfg.dir.join(APP).exists());

    crate::selftest::write_report(&report, &cfg.report).unwrap();
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(&cfg.report).unwrap()).unwrap();
    assert_eq!(json["ok"], true);
    assert_eq!(json["steps"][0]["name"], "manifest");
    assert!(json["steps"][0].get("detail").is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn selftest_reports_failures() {
    let _guard = system_lock();
    let tmp = TempDir::new("selftest-fail");
    let cfg = SelftestConfig {
        dir: tmp.join("install"),
        manifest: closed_url("/latest.json"),
        report: tmp.join("report.json"),
        uninstaller_source: None,
        retry: RetryPolicy::none(),
        echo: false,
    };
    let report = run_selftest(&cfg).await;
    assert!(!report.ok);
    assert_eq!(report.steps.len(), 1);
    assert_eq!(report.steps[0].name, "manifest");

    // Prüfsumme falsch → verify schlägt fehl, danach wird aufgeräumt.
    let srv = TestServer::start();
    let data = test_data(100_000, 14);
    srv.add_file("/NovaLauncher.exe", data.clone());
    srv.add_file("/latest.json", manifest_json("1.0.0", APP, Some(&sha(b"other")), None));
    let cfg = SelftestConfig { manifest: srv.url("/latest.json"), ..cfg };
    let report = run_selftest(&cfg).await;
    assert!(!report.ok);
    let verify = report.steps.iter().find(|s| s.name == "verify").unwrap();
    assert!(!verify.ok && verify.detail.contains("checksum"), "{verify:?}");
    assert!(report.steps.iter().any(|s| s.name == "cleanup" && s.ok));
    assert!(!cfg.dir.exists() || std::fs::read_dir(&cfg.dir).unwrap().next().is_none());
}

#[test]
fn selftest_cli_entry_point() {
    let _guard = system_lock();
    // Kompletter `--selftest`-Ablauf wie von der Kommandozeile (eigene Laufzeit, Standard-Berichtspfad).
    let srv = TestServer::start();
    let data = test_data(600_000, 15);
    srv.add_file("/NovaLauncher.exe", data.clone());
    srv.add_file("/latest.json", manifest_json("7.0.0", APP, Some(&sha(&data)), Some(data.len() as u64)));
    let tmp = TempDir::new("selftest-cli");
    let dir = tmp.join("target dir");
    let cli = CliArgs::parse(["--selftest".to_string(), "--dir".into(), dir.to_string_lossy().into_owned(), "--manifest".into(), srv.url("/latest.json")]);
    let code = crate::selftest::run_from_cli(&cli);
    let report: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("selftest.json")).unwrap()).unwrap();
    assert_eq!(code, 0, "{report:#}");
    assert_eq!(report["ok"], true);

    let bad = CliArgs::parse(["--selftest".to_string(), "--dir".into(), tmp.join("x").to_string_lossy().into_owned(), "--manifest".into(), closed_url("/l.json")]);
    assert_eq!(crate::selftest::run_from_cli(&bad), 1);
    assert_eq!(crate::selftest::run_from_cli(&CliArgs::parse(["--selftest"])), 1, "missing --dir");
}
