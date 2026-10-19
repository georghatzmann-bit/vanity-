//! Beobachter eines Labor-Laufs (Windows): merkt sich Prozessbaum, Verbindungen und
//! Bildschirmfotos während des Laufs und vergleicht Ordner sowie Autostart-Einträge vorher und
//! nachher. **Nur lesend.**

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use aegis_winffi::inspect::{self, Hive, RegValue};

use crate::report::{Change, FileChange, MAX_ITEMS, NetworkAttempt, ProcessRecord, RegistryChange};
use crate::snapshot::DirSnapshot;

/// Ergebnis der Beobachtung.
#[derive(Debug, Default)]
pub struct Observed {
    /// Prozesse.
    pub processes: Vec<ProcessRecord>,
    /// Dateien.
    pub files: Vec<FileChange>,
    /// Registry.
    pub registry: Vec<RegistryChange>,
    /// Netzwerk.
    pub network: Vec<NetworkAttempt>,
}

/// Beobachter.
#[derive(Debug)]
pub struct Observer {
    dirs: Vec<(PathBuf, DirSnapshot)>,
    hive: Hive,
    registry: BTreeSet<RegValue>,
    processes: BTreeMap<u32, ProcessRecord>,
    network: BTreeSet<(String, u16)>,
    network_blocked: bool,
}

impl Observer {
    /// Nimmt den Ausgangszustand auf.
    #[must_use]
    pub fn start(dirs: Vec<PathBuf>, hive: Hive, network_blocked: bool) -> Self {
        let dirs = dirs
            .into_iter()
            .map(|d| {
                let snap = DirSnapshot::capture(&d);
                (d, snap)
            })
            .collect();
        let registry = inspect::autostart_snapshot(&hive);
        Self {
            dirs,
            hive,
            registry,
            processes: BTreeMap::new(),
            network: BTreeSet::new(),
            network_blocked,
        }
    }

    /// Erfasst Nachkommen der Wurzel-Prozesse (und die Wurzeln) und deren Verbindungen.
    /// Gibt die aktuell laufenden, beobachteten Prozess-IDs zurück.
    pub fn poll(&mut self, roots: &[u32]) -> Vec<u32> {
        let Ok(all) = inspect::processes() else {
            return Vec::new();
        };
        let mut tree: BTreeSet<u32> = roots.iter().copied().collect();
        tree.extend(self.processes.keys().copied());
        loop {
            let before = tree.len();
            for p in &all {
                if tree.contains(&p.parent) && p.pid != 0 {
                    tree.insert(p.pid);
                }
            }
            if tree.len() == before {
                break;
            }
        }
        let running: Vec<u32> = all
            .iter()
            .filter(|p| tree.contains(&p.pid))
            .map(|p| p.pid)
            .collect();
        for p in all.iter().filter(|p| tree.contains(&p.pid)) {
            if self.processes.len() >= MAX_ITEMS {
                break;
            }
            self.processes
                .entry(p.pid)
                .or_insert_with(|| ProcessRecord {
                    pid: p.pid,
                    parent: p.parent,
                    image: aegis_winffi::process_image_path(p.pid)
                        .map_or_else(|_| p.name.clone(), |i| i.to_string_lossy().into_owned()),
                    command_line: None,
                });
        }
        if let Ok(conns) = inspect::tcp_connections() {
            for c in conns.into_iter().filter(|c| running.contains(&c.pid)) {
                if self.network.len() < MAX_ITEMS {
                    self.network.insert((c.remote.to_string(), c.port));
                }
            }
        }
        running
    }

    /// Bildschirmfotos der Fenster der beobachteten Prozesse (PNG).
    #[must_use]
    pub fn window_shots(&self, running: &[u32], max: usize) -> Vec<Vec<u8>> {
        inspect::capture_windows(running, max)
            .into_iter()
            .filter_map(|c| crate::png::encode_bgra(c.width, c.height, &c.bgra).ok())
            .collect()
    }

    /// Vergleicht mit dem Ausgangszustand.
    #[must_use]
    pub fn finish(self) -> Observed {
        let mut files = Vec::new();
        for (dir, before) in &self.dirs {
            files.extend(before.diff(&DirSnapshot::capture(dir)));
        }
        files.truncate(MAX_ITEMS);
        let after = inspect::autostart_snapshot(&self.hive);
        let key = |v: &RegValue| (v.key.clone(), v.name.clone());
        let before: BTreeMap<_, _> = self.registry.iter().map(|v| (key(v), v)).collect();
        let now: BTreeMap<_, _> = after.iter().map(|v| (key(v), v)).collect();
        let mut registry = Vec::new();
        for (k, v) in &now {
            let change = match before.get(k) {
                None => Change::Created,
                Some(old) if old.data != v.data => Change::Modified,
                Some(_) => continue,
            };
            registry.push(RegistryChange {
                key: v.key.clone(),
                value: v.name.clone(),
                change,
                data: Some(v.data.clone()),
            });
        }
        for (k, v) in &before {
            if !now.contains_key(k) {
                registry.push(RegistryChange {
                    key: v.key.clone(),
                    value: v.name.clone(),
                    change: Change::Deleted,
                    data: None,
                });
            }
        }
        registry.truncate(MAX_ITEMS);
        Observed {
            processes: self.processes.into_values().collect(),
            files,
            registry,
            network: self
                .network
                .into_iter()
                .map(|(remote, port)| NetworkAttempt {
                    remote,
                    port,
                    blocked: self.network_blocked,
                })
                .collect(),
        }
    }
}
