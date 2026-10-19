//! `aegis-scanworker` – Prüfprozess der AEGIS Suite. Wird nur vom Dienst gestartet (unter
//! Windows mit eingeschränktem Token, niedriger Integrität, im Job-Objekt). Liest eine
//! Anfrage (JSON) von der Standardeingabe und schreibt den Bericht (JSON) auf die
//! Standardausgabe. Verändert nichts – die Engine ist nur lesend.
#![forbid(unsafe_code)]

use std::io::{Read, Write};

use aegis_engine::clamav::ClamAv;
use aegis_engine::yara::YaraRules;
use aegis_engine::{Engine, EngineConfig, ScanReport};
use aegis_service::worker::{MAX_REQUEST, WorkerRequest};

fn main() {
    let mut input = Vec::new();
    if std::io::stdin()
        .take(MAX_REQUEST)
        .read_to_end(&mut input)
        .is_err()
    {
        std::process::exit(2);
    }
    let Ok(request) = serde_json::from_slice::<WorkerRequest>(&input) else {
        std::process::exit(2);
    };
    let Ok(rules) = YaraRules::builtin() else {
        std::process::exit(3);
    };
    let engine = Engine::new(EngineConfig {
        yara: Some(rules),
        clamav: if request.clamav {
            ClamAv::locate()
        } else {
            None
        },
        ..EngineConfig::default()
    });
    let report = if request.files_only {
        ScanReport {
            findings: request.paths.iter().map(|p| engine.scan_file(p)).collect(),
            ..ScanReport::default()
        }
    } else {
        engine.scan_paths(&request.paths)
    };
    let mut out = std::io::stdout().lock();
    if serde_json::to_writer(&mut out, &report).is_err() || out.flush().is_err() {
        std::process::exit(4);
    }
}
