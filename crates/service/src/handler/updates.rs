//! Software-Updates (P6.5): Der Dienst fragt winget nach neueren Versionen installierter
//! Programme (nur auf Knopfdruck – das braucht Netz) und schlägt je Paket ein Update vor.
//! Installiert wird nur nach „Ja“, genau die Kennung und Version aus dem Plan, aus der
//! winget-Paketquelle, außerhalb der Dienst-Sperre (siehe [`super::backup::Deferred`]).
//!
//! Ehrlich: Der Dienst läuft als SYSTEM – winget aktualisiert damit rechnerweit installierte
//! Programme. Nur für ein Konto installierte Programme meldet winget hier oft nicht; die lassen
//! sich in winget im eigenen Konto aktualisieren. Rückgängig gibt es nicht automatisch.

use std::collections::HashMap;
use std::sync::Arc;

use aegis_core::audit::Durable;
use aegis_core::consent::{Clock, ExecutionPermit};
use aegis_core::plan::{
    ActionKind, ActionPlan, Target, UndoHint, param, valid_package_id, valid_package_version,
};
use aegis_core::risk::RiskLevel;
use aegis_core::time::{Duration, OffsetDateTime};
use aegis_hardening::updates::Upgrade;
use aegis_quarantine::UserAccess;
use serde::Serialize;

use super::Service;
use crate::protocol::Response;

/// So lange gilt eine Liste für Vorschläge (Minuten).
pub const LIST_MINUTES: i64 = 60;

/// Paketverwaltung: Liste lesen, ein Paket aktualisieren. Unter Windows winget
/// ([`Winget`]), in Tests ein Ersatz.
pub trait PackageManager: Send + Sync + std::fmt::Debug {
    /// Pakete mit neuerer Version (nur lesend; fragt die Paketquelle über das Netz).
    ///
    /// # Errors
    /// winget fehlt oder meldet einen Fehler.
    fn list(&self) -> Result<Vec<Upgrade>, String>;
    /// Aktualisiert genau Kennung und Version aus dem Plan der Erlaubnis.
    ///
    /// # Errors
    /// Ungültiger Plan, winget fehlt oder meldet einen Fehler.
    fn upgrade(&self, permit: &ExecutionPermit) -> Result<String, String>;
}

/// Kennung und Zielversion aus dem Plan (erneut geprüft).
///
/// # Errors
/// Fehlt oder ungültig.
pub fn plan_package(permit: &ExecutionPermit) -> Result<(String, String), String> {
    let plan = permit.plan();
    if plan.kind() != ActionKind::UpdateSoftware {
        return Err("Kein Software-Update".into());
    }
    let id = plan.parameter(param::PACKAGE_ID).unwrap_or_default();
    let version = plan.parameter(param::PACKAGE_VERSION).unwrap_or_default();
    if valid_package_id(id) && valid_package_version(version) {
        Ok((id.to_owned(), version.to_owned()))
    } else {
        Err("Ungültige Paket-Kennung oder Version".into())
    }
}

/// winget (Windows, App-Installer).
#[derive(Debug, Default)]
pub struct Winget;

impl PackageManager for Winget {
    fn list(&self) -> Result<Vec<Upgrade>, String> {
        #[cfg(windows)]
        {
            sys::list()
        }
        #[cfg(not(windows))]
        {
            Err("Software-Updates über winget gibt es nur unter Windows.".into())
        }
    }

    fn upgrade(&self, permit: &ExecutionPermit) -> Result<String, String> {
        use std::sync::atomic::{AtomicBool, Ordering};
        static RUNNING: AtomicBool = AtomicBool::new(false);
        let (id, version) = plan_package(permit)?;
        if RUNNING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("Es läuft bereits ein Software-Update – bitte danach erneut.".into());
        }
        #[cfg(windows)]
        let result = sys::upgrade(&id, &version);
        #[cfg(not(windows))]
        let result: Result<String, String> = {
            let _ = (id, version);
            Err("Software-Updates über winget gibt es nur unter Windows.".into())
        };
        RUNNING.store(false, Ordering::SeqCst);
        result
    }
}

#[cfg(windows)]
mod sys {
    use std::io::Read;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use aegis_hardening::updates::{Upgrade, parse_upgrades};

    /// Keine Pakete / kein anwendbares Update (winget-Fehlercodes).
    const NO_PACKAGES: [u32; 2] = [0x8A15_0014, 0x8A15_002B];
    /// Größte gelesene Ausgabe.
    const MAX_OUTPUT: u64 = 4 * 1024 * 1024;

    /// `winget.exe` des App-Installers (geschützter Ordner `WindowsApps`, höchste Version).
    fn locate() -> Result<PathBuf, String> {
        let base = std::env::var_os("ProgramFiles")
            .map_or_else(|| PathBuf::from(r"C:\Program Files"), PathBuf::from)
            .join("WindowsApps");
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64__8wekyb3d8bbwe"
        } else {
            "x64__8wekyb3d8bbwe"
        };
        let missing = || {
            "winget nicht gefunden – bitte den „App-Installer“ aus dem Microsoft Store installieren bzw. aktualisieren.".to_owned()
        };
        let mut best: Option<(Vec<u64>, PathBuf)> = None;
        for entry in std::fs::read_dir(&base).map_err(|_| missing())?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some((version, rest)) = name
                .strip_prefix("Microsoft.DesktopAppInstaller_")
                .and_then(|r| r.split_once('_'))
            else {
                continue;
            };
            if rest != arch {
                continue;
            }
            let Ok(parts) = version
                .split('.')
                .map(str::parse::<u64>)
                .collect::<Result<Vec<_>, _>>()
            else {
                continue;
            };
            let exe = entry.path().join("winget.exe");
            let plain = std::fs::symlink_metadata(&exe).is_ok_and(|m| m.file_type().is_file());
            if plain && best.as_ref().is_none_or(|(v, _)| parts > *v) {
                best = Some((parts, exe));
            }
        }
        best.map(|(_, exe)| exe).ok_or_else(missing)
    }

    /// Startet winget ohne Fenster, liest die Ausgabe (höchstens 4 MiB) und wartet höchstens
    /// `limit`. Liefert (Code, Ausgabe).
    fn run(exe: &Path, args: &[&str], limit: Duration) -> Result<(u32, String), String> {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let dir = aegis_winffi::accounts::system_dir().map_err(|e| e.to_string())?;
        // Startet winget am festen Ort: Liste lesen bzw. ein freigegebenes Update (Argumente
        // fest, Kennung und Version aus dem Plan).
        // aegis-mutation: service-winget-run
        #[allow(clippy::disallowed_methods)]
        let child = std::process::Command::new(exe)
            .args(args)
            .current_dir(dir)
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn();
        let mut child = child.map_err(|e| format!("winget startet nicht: {e}"))?;
        let mut stdout = child.stdout.take().ok_or("Keine Ausgabe von winget")?;
        let reader = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = (&mut stdout).take(MAX_OUTPUT).read_to_end(&mut bytes);
            // Rest verwerfen, damit winget nicht beim Schreiben hängt.
            let _ = std::io::copy(&mut stdout, &mut std::io::sink());
            bytes
        });
        let deadline = Instant::now() + limit;
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                break status;
            }
            if Instant::now() >= deadline {
                // Beendet nur das selbst gestartete winget nach Ablauf der Frist.
                // aegis-mutation: service-winget-timeout
                #[allow(clippy::disallowed_methods)]
                let _ = child.kill();
                let _ = child.wait();
                return Err("winget hat zu lange gebraucht und wurde beendet. Ein bereits gestartetes Installationsprogramm kann noch weiterlaufen – bitte später „Erneut suchen“.".into());
            }
            std::thread::sleep(Duration::from_millis(250));
        };
        let bytes = reader.join().unwrap_or_default();
        let code = status.code().map_or(u32::MAX, |c| c as u32);
        Ok((code, String::from_utf8_lossy(&bytes).into_owned()))
    }

    /// Letzte sichtbare Zeile der Ausgabe (gekürzt) – als Meldung.
    fn last_line(output: &str) -> String {
        output
            .lines()
            .map(|l| l.rsplit('\r').next().unwrap_or(l).trim())
            .rfind(|l| l.chars().any(char::is_alphanumeric))
            .unwrap_or_default()
            .chars()
            .filter(|c| !c.is_control())
            .take(200)
            .collect()
    }

    pub(super) fn list() -> Result<Vec<Upgrade>, String> {
        let exe = locate()?;
        let (code, output) = run(
            &exe,
            &[
                "upgrade",
                "--source",
                "winget",
                "--disable-interactivity",
                "--accept-source-agreements",
            ],
            Duration::from_secs(180),
        )?;
        let list = parse_upgrades(&output);
        if code == 0 || !list.is_empty() || NO_PACKAGES.contains(&code) {
            Ok(list)
        } else {
            Err(format!(
                "winget meldet Code 0x{code:08X}: {}",
                last_line(&output)
            ))
        }
    }

    pub(super) fn upgrade(id: &str, version: &str) -> Result<String, String> {
        let exe = locate()?;
        let (code, output) = run(
            &exe,
            &[
                "upgrade",
                "--id",
                id,
                "--exact",
                "--version",
                version,
                "--source",
                "winget",
                "--silent",
                "--disable-interactivity",
                "--accept-package-agreements",
                "--accept-source-agreements",
            ],
            Duration::from_secs(30 * 60),
        )?;
        if code == 0 {
            Ok(format!("{id} auf {version} aktualisiert"))
        } else {
            Err(format!(
                "winget meldet Code 0x{code:08X}: {}",
                last_line(&output)
            ))
        }
    }
}

/// Zustand für die Oberfläche.
#[derive(Debug, Clone, Serialize)]
pub struct UpdatesState {
    /// Unter Windows verfügbar?
    pub available: bool,
    /// Pakete mit neuerer Version.
    pub packages: Vec<Upgrade>,
    /// Zeitpunkt der Abfrage (RFC 3339).
    pub checked_at: String,
    /// Darf das Konto aktualisieren (Administrator)?
    pub admin: bool,
    /// Fehlermeldung (winget fehlt, keine Verbindung …).
    pub error: Option<String>,
}

impl<C: Clock, W: Durable> Service<C, W> {
    /// Ersatz für winget setzen (Tests).
    pub fn set_package_manager(&mut self, packages: Arc<dyn PackageManager>) {
        self.packages = packages;
    }

    /// Die Paketverwaltung (zum Lesen außerhalb der Dienst-Sperre).
    #[must_use]
    pub fn package_manager(&self) -> Arc<dyn PackageManager> {
        Arc::clone(&self.packages)
    }

    /// Ergebnis einer Abfrage merken (für Vorschläge) und antworten.
    pub fn updates_finish(
        &mut self,
        result: Result<Vec<Upgrade>, String>,
        user: &dyn UserAccess,
    ) -> Response {
        let now: OffsetDateTime = self.now();
        let (packages, error) = match result {
            Ok(list) => {
                self.updates = Some((now, list.clone()));
                (list, None)
            }
            Err(e) => (Vec::new(), Some(e)),
        };
        Response::Updates {
            state: Box::new(UpdatesState {
                available: cfg!(windows),
                packages,
                checked_at: now
                    .format(&aegis_core::time::format_description::well_known::Rfc3339)
                    .unwrap_or_default(),
                admin: user.is_admin(),
                error,
            }),
        }
    }

    /// Schlägt vor, ein Paket aus der letzten Abfrage zu aktualisieren.
    pub fn propose_software_update(&mut self, id: &str, user: &dyn UserAccess) -> Response {
        if !user.is_admin() {
            return Response::error(
                "admin",
                "Software-Updates gelten für den ganzen PC – dafür braucht AEGIS Administratorrechte.",
            );
        }
        let now = self.now();
        let Some(package) = self
            .updates
            .as_ref()
            .filter(|(at, _)| now - *at < Duration::minutes(LIST_MINUTES))
            .and_then(|(_, list)| list.iter().find(|p| p.id == id))
            .cloned()
        else {
            return Response::error("unknown", "Paket nicht gefunden – bitte neu suchen");
        };
        if package.truncated || !valid_package_id(&package.id) {
            return Response::error(
                "updates",
                "winget hat Name oder Kennung gekürzt – bitte in winget selbst aktualisieren.",
            );
        }
        let plan = ActionPlan::builder(ActionKind::UpdateSoftware)
            .target(Target::other(format!(
                "winget-Paket {} ({}): {} → {}",
                super::quoted(&package.name),
                package.id,
                package.version,
                package.available
            )))
            .parameter(param::PACKAGE_ID, package.id.clone())
            .parameter(param::PACKAGE_VERSION, package.available.clone())
            .what(format!(
                "Software aktualisieren: {} von {} auf {}",
                super::quoted(&package.name),
                package.version,
                package.available
            ))
            .why("Eine neuere Version ist verfügbar – Updates schließen oft Sicherheitslücken.")
            .consequence(format!(
                "AEGIS lässt winget das Paket „{}“ in Version {} aus der winget-Paketquelle (Microsoft-Community-Repository) laden und still installieren – für alle Konten. Damit stimmst du den Lizenzbedingungen des Pakets zu. Das Programm sollte vorher geschlossen sein; manchmal ist ein Neustart nötig.",
                package.id, package.available
            ))
            .undo(UndoHint::irreversible(format!(
                "Nicht automatisch rückgängig. Eine ältere Version lässt sich ggf. mit „winget install --id {} --version {}“ wieder installieren.",
                package.id, package.version
            )))
            .severity(RiskLevel::Info)
            .build(now);
        match plan {
            Ok(plan) => self.register(plan, user.identity(), HashMap::new()),
            Err(e) => Response::error("plan", e.to_string()),
        }
    }

    /// Update nach dem „Ja“: läuft außerhalb der Dienst-Sperre. Die Administratorrechte werden
    /// beim Ausführen erneut geprüft.
    pub(super) fn apply_software_update(
        &mut self,
        permit: ExecutionPermit,
        user: &dyn UserAccess,
    ) -> Response {
        let action = permit.plan().kind();
        if !user.is_admin() {
            let result = aegis_core::audit::ExecutionResult::Failed {
                message: "Software-Updates gelten für den ganzen PC – dafür braucht AEGIS Administratorrechte.".into(),
            };
            self.finish_plan(permit, &result, user, None);
            return Response::Executed {
                kind: action,
                result,
                entries: Vec::new(),
                failures: Vec::new(),
            };
        }
        self.deferred = Some(super::backup::Deferred::update(
            permit,
            Arc::clone(&self.packages),
        ));
        // Wird durch das Ergebnis der aufgeschobenen Arbeit ersetzt.
        Response::Executed {
            kind: action,
            result: aegis_core::audit::ExecutionResult::Failed {
                message: "läuft".into(),
            },
            entries: Vec::new(),
            failures: Vec::new(),
        }
    }
}
