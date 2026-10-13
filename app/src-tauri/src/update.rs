//! Update-Prüfung über `latest.json` und Installation über das Setup (`--update`).

use std::cmp::Ordering;
use std::io::Write;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};

use crate::config::config;
use crate::error::{http_status_err, io_err, net_err, CmdResult};
use crate::models::{ProgressEvent, UpdateInfo};
use crate::state::Shared;

#[derive(Debug, Deserialize)]
struct Asset {
    url: String,
    #[serde(default)]
    sha256: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    version: String,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    setup: Option<Asset>,
}

/// Versionsnummer in Zahlen zerlegen; Vorabversionen (`-beta`) sind kleiner als die fertige Version.
fn parse_version(v: &str) -> (Vec<u64>, Option<String>) {
    let v = v.trim().trim_start_matches(['v', 'V']);
    let (core, pre) = match v.split_once(['-', '+']) {
        Some((c, p)) => (c, Some(p.to_string())),
        None => (v, None),
    };
    let nums = core
        .split('.')
        .map(|p| {
            p.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse::<u64>()
                .unwrap_or(0)
        })
        .collect();
    (nums, pre.filter(|p| !p.is_empty()))
}

/// Vergleicht zwei Versionen (`1.2.10` > `1.2.9`, `1.0.0` > `1.0.0-beta`).
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let (na, pa) = parse_version(a);
    let (nb, pb) = parse_version(b);
    let len = na.len().max(nb.len());
    for i in 0..len {
        let x = na.get(i).copied().unwrap_or(0);
        let y = nb.get(i).copied().unwrap_or(0);
        match x.cmp(&y) {
            Ordering::Equal => continue,
            o => return o,
        }
    }
    match (pa, pb) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) => x.cmp(&y),
    }
}

/// Relative Adressen relativ zur Manifest-Adresse auflösen.
fn resolve_url(base: &str, url: &str) -> String {
    if url.contains("://") {
        return url.to_string();
    }
    reqwest::Url::parse(base)
        .and_then(|b| b.join(url))
        .map(|u| u.to_string())
        .unwrap_or_else(|_| url.to_string())
}

fn build_info(manifest: Manifest, manifest_url: &str, current: &str) -> UpdateInfo {
    let available = compare_versions(&manifest.version, current) == Ordering::Greater;
    let setup_url = manifest
        .setup
        .as_ref()
        .map(|s| resolve_url(manifest_url, s.url.trim()))
        .filter(|u| !u.is_empty());
    UpdateInfo {
        available,
        current: current.to_string(),
        latest: Some(manifest.version.trim().to_string()),
        notes: manifest.notes.filter(|n| !n.trim().is_empty()),
        setup_url,
        setup_sha256: manifest
            .setup
            .and_then(|s| s.sha256)
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty()),
    }
}

#[tauri::command]
pub async fn update_check(state: State<'_, Shared>) -> CmdResult<UpdateInfo> {
    let cfg = config();
    let current = cfg.version.clone();
    let url = cfg.manifest_url.trim();
    if url.is_empty() {
        return Err(format!("Für diese Version von {} ist keine Update-Adresse hinterlegt.", cfg.app_name));
    }
    let resp = state.http.get(url).send().await.map_err(|e| net_err(&e))?;
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        if code == 404 {
            return Err("Es wurden noch keine Updates veröffentlicht.".into());
        }
        return Err(format!("Update-Prüfung: {}", http_status_err(code)));
    }
    let manifest: Manifest = resp
        .json()
        .await
        .map_err(|_| "Die Update-Informationen sind ungültig.".to_string())?;
    Ok(build_info(manifest, url, &current))
}

#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    state: State<'_, Shared>,
    setup_url: String,
    sha256: Option<String>,
) -> CmdResult<()> {
    if !cfg!(windows) {
        return Err("Automatische Updates sind nur unter Windows verfügbar.".into());
    }
    let url = setup_url.trim().to_string();
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Ungültige Update-Adresse.".into());
    }
    let resp = state
        .http
        .get(&url)
        .timeout(Duration::from_secs(60 * 30))
        .send()
        .await
        .map_err(|e| net_err(&e))?;
    if !resp.status().is_success() {
        return Err(format!("Download des Updates: {}", http_status_err(resp.status().as_u16())));
    }
    let total = resp.content_length().unwrap_or(0);
    let path = std::env::temp_dir().join("NovaLauncher-Setup.exe");
    let mut file = std::fs::File::create(&path).map_err(|e| io_err(&e, &path))?;
    let mut hasher = Sha256::new();
    let mut done: u64 = 0;
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                drop(file);
                let _ = std::fs::remove_file(&path);
                return Err(net_err(&e));
            }
        };
        if let Err(e) = file.write_all(&chunk) {
            drop(file);
            let _ = std::fs::remove_file(&path);
            return Err(io_err(&e, &path));
        }
        hasher.update(&chunk);
        done += chunk.len() as u64;
        if last_emit.elapsed() >= Duration::from_millis(120) {
            last_emit = Instant::now();
            let _ = app.emit("update://progress", ProgressEvent { done, total: total.max(done), label: None });
        }
    }
    let _ = app.emit("update://progress", ProgressEvent { done, total: total.max(done), label: None });
    if let Err(e) = file.flush().and_then(|_| file.sync_all()) {
        let _ = std::fs::remove_file(&path);
        return Err(io_err(&e, &path));
    }
    drop(file);

    let expected = sha256.map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());
    if let Some(expected) = expected {
        let actual = hex::encode(hasher.finalize());
        if actual != expected {
            let _ = std::fs::remove_file(&path);
            return Err("Die heruntergeladene Datei ist beschädigt (Prüfsumme stimmt nicht). Bitte erneut versuchen.".into());
        }
    }

    std::process::Command::new(&path)
        .arg("--update")
        .spawn()
        .map_err(|e| format!("Das Update konnte nicht gestartet werden: {}", io_err(&e, &path)))?;

    // Antwort noch an die Oberfläche schicken, dann sauber beenden
    let core = state.inner().clone();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        crate::native::quit(&handle, &core);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_comparison() {
        assert_eq!(compare_versions("1.0.1", "1.0.0"), Ordering::Greater);
        assert_eq!(compare_versions("1.2.10", "1.2.9"), Ordering::Greater);
        assert_eq!(compare_versions("v2.0", "1.9.9"), Ordering::Greater);
        assert_eq!(compare_versions("1.0", "1.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.0.0", "1.0.0-beta.2"), Ordering::Greater);
        assert_eq!(compare_versions("1.0.0-beta.2", "1.0.0-beta.1"), Ordering::Greater);
        assert_eq!(compare_versions("0.9.0", "1.0.0"), Ordering::Less);
        assert_eq!(compare_versions(" 1.0.0 ", "1.0.0"), Ordering::Equal);
    }

    #[test]
    fn manifest_to_update_info() {
        let m: Manifest = serde_json::from_str(
            r#"{"version":"1.1.0","notes":"Neu","app":{"url":"https://x/NovaLauncher.exe","sha256":"AA","size":1},
                "setup":{"url":"NovaLauncher-Setup.exe","sha256":"ABCDEF","size":2}}"#,
        )
        .unwrap();
        let info = build_info(m, "https://example.com/releases/latest/download/latest.json", "1.0.0");
        assert!(info.available);
        assert_eq!(info.latest.as_deref(), Some("1.1.0"));
        assert_eq!(info.setup_url.as_deref(), Some("https://example.com/releases/latest/download/NovaLauncher-Setup.exe"));
        assert_eq!(info.setup_sha256.as_deref(), Some("abcdef"));

        let same: Manifest = serde_json::from_str(r#"{"version":"1.0.0"}"#).unwrap();
        let info = build_info(same, "https://e/x.json", "1.0.0");
        assert!(!info.available);
        assert!(info.setup_url.is_none());
    }
}
