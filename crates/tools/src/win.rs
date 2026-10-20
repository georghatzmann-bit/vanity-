//! Windows-Anbindung der Werkzeuge: Papierkorb der Shell (mit Wiederfinden über `$I…`),
//! Hintergrundbild, Autostart-Schalter (`StartupApproved`, nur `HKCU`).

use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use aegis_winffi::inspect::{Hive, read_values};
use aegis_winffi::registry::{RawValue, read_raw, write_raw};

use crate::autostart::{Entry, EntryRef, Location, approved_enabled, approved_value};
use crate::platform::{Platform, Recycled};
use crate::recycle::parse_info;
use crate::tweaks::Value;

/// `REG_BINARY`.
const REG_BINARY: u32 = 3;
/// `REG_SZ`.
const REG_SZ: u32 = 1;
/// `REG_DWORD`.
const REG_DWORD: u32 = 4;
const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

fn filetime_now() -> u64 {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    (secs + 11_644_473_600) * 10_000_000
}

/// Papierkorb-Ordner des Kontos auf dem Laufwerk von `path`.
fn bin_for(path: &Path) -> io::Result<PathBuf> {
    let root = path
        .components()
        .next()
        .map(|c| PathBuf::from(format!("{}\\", c.as_os_str().to_string_lossy())))
        .ok_or_else(|| io::Error::other("kein Laufwerk"))?;
    let sid = aegis_winffi::pipe::current_user_sid()?;
    Ok(root.join("$Recycle.Bin").join(sid))
}

fn same_path(a: &Path, b: &Path) -> bool {
    aegis_winffi::fs::ordinal_eq_ignore_case(&a.to_string_lossy(), &b.to_string_lossy())
}

/// Windows (Konto des angemeldeten Nutzers).
#[derive(Debug, Clone, Copy, Default)]
pub struct WindowsPlatform;

impl Platform for WindowsPlatform {
    fn recycle(&self, path: &Path) -> io::Result<Recycled> {
        let bin = bin_for(path)?;
        aegis_winffi::shell::recycle(path)?;
        // Den eben angelegten Eintrag wiederfinden: Originalpfad, jüngste Löschzeit.
        let mut best: Option<(u64, PathBuf)> = None;
        for entry in std::fs::read_dir(&bin)?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with("$I") {
                continue;
            }
            let Ok(bytes) = std::fs::read(entry.path()) else {
                continue;
            };
            if let Some(info) = parse_info(&bytes)
                && same_path(&info.original, path)
                && best.as_ref().is_none_or(|(t, _)| info.deleted > *t)
            {
                best = Some((info.deleted, entry.path()));
            }
        }
        let (_, info) = best.ok_or_else(|| {
            io::Error::other("im Papierkorb nicht wiedergefunden – Rückgängig über den Papierkorb")
        })?;
        let data_name = info
            .file_name()
            .map(|n| n.to_string_lossy().replacen("$I", "$R", 1))
            .ok_or_else(|| io::Error::other("Name"))?;
        Ok(Recycled {
            data: info.with_file_name(data_name),
            info: Some(info),
        })
    }

    fn restore(&self, item: &Recycled, original: &Path) -> io::Result<()> {
        let info_path = item
            .info
            .as_ref()
            .ok_or_else(|| io::Error::other("ohne Begleitdatei"))?;
        // Nur aus dem Papierkorb des Kontos und nur, wenn die Begleitdatei den Ort nennt.
        let bin = bin_for(original)?;
        // Genau ein `$I…`/`$R…`-Paar direkt im Papierkorb des Kontos (gleiche Endung).
        let name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().into_owned());
        let pair = name(info_path).zip(name(&item.data)).is_some_and(|(i, r)| {
            i.strip_prefix("$I")
                .zip(r.strip_prefix("$R"))
                .is_some_and(|(a, b)| !a.is_empty() && a == b)
        });
        if info_path.parent() != Some(bin.as_path())
            || item.data.parent() != Some(bin.as_path())
            || !pair
        {
            return Err(io::Error::other("nicht aus dem Papierkorb dieses Kontos"));
        }
        let info = parse_info(&std::fs::read(info_path)?)
            .ok_or_else(|| io::Error::other("Begleitdatei unlesbar"))?;
        if !same_path(&info.original, original) {
            return Err(io::Error::other("Eintrag gehört zu einer anderen Datei"));
        }
        aegis_winffi::shell::move_no_replace(&item.data, original)?;
        // Begleitdatei des zurückgeholten Eintrags entfernen (wie „Wiederherstellen“ im
        // Papierkorb).
        // aegis-mutation: tools-recycle-info-remove
        #[allow(clippy::disallowed_methods)]
        let _ = std::fs::remove_file(info_path);
        Ok(())
    }

    fn wallpaper(&self) -> io::Result<PathBuf> {
        aegis_winffi::shell::wallpaper()
    }

    fn set_wallpaper(&self, path: &Path) -> io::Result<()> {
        aegis_winffi::shell::set_wallpaper(path)
    }

    fn autostart_enabled(&self, entry: &EntryRef) -> io::Result<bool> {
        let key = entry
            .location
            .approved_key()
            .ok_or_else(|| io::Error::other("nur Anzeige"))?;
        let value = read_raw(&Hive::CurrentUser, key, &entry.name)?;
        Ok(approved_enabled(value.as_ref().map(|v| v.bytes.as_slice())))
    }

    fn set_autostart(&self, entry: &EntryRef, enable: bool) -> io::Result<()> {
        if !crate::autostart::valid_name(&entry.name) {
            return Err(io::Error::other("ungültiger Name"));
        }
        let key = entry
            .location
            .approved_key()
            .ok_or_else(|| io::Error::other("nur Anzeige"))?;
        write_raw(
            &Hive::CurrentUser,
            key,
            &entry.name,
            &RawValue {
                kind: REG_BINARY,
                bytes: approved_value(enable, filetime_now()),
            },
        )
    }

    fn registry_get(&self, key: &str, name: &str) -> io::Result<Value> {
        if !crate::tweaks::known(key, name) {
            return Err(io::Error::other("unbekannter Schalter"));
        }
        Ok(match read_raw(&Hive::CurrentUser, key, name)? {
            None => Value::Absent,
            Some(v) if v.kind == REG_DWORD => Value::Dword(u32::from_le_bytes(
                v.bytes
                    .get(..4)
                    .and_then(|b| b.try_into().ok())
                    .ok_or_else(|| io::Error::other("DWORD zu kurz"))?,
            )),
            Some(v) if v.kind == REG_SZ => {
                let units: Vec<u16> = v
                    .bytes
                    .chunks_exact(2)
                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                    .take_while(|u| *u != 0)
                    .collect();
                Value::Text(String::from_utf16_lossy(&units))
            }
            Some(_) => return Err(io::Error::other("unerwarteter Typ")),
        })
    }

    fn registry_set(&self, key: &str, name: &str, value: &Value) -> io::Result<()> {
        // Nur Schalter aus der festen Liste, nur HKCU.
        if !crate::tweaks::known(key, name) {
            return Err(io::Error::other("unbekannter Schalter"));
        }
        match value {
            Value::Dword(v) => write_raw(&Hive::CurrentUser, key, name, &RawValue::dword(*v)),
            Value::Text(t) => {
                let bytes: Vec<u8> = t
                    .encode_utf16()
                    .chain(std::iter::once(0))
                    .flat_map(u16::to_le_bytes)
                    .collect();
                write_raw(
                    &Hive::CurrentUser,
                    key,
                    name,
                    &RawValue {
                        kind: REG_SZ,
                        bytes,
                    },
                )
            }
            Value::Absent => aegis_winffi::registry::delete_value(&Hive::CurrentUser, key, name),
        }
    }

    fn apply_desktop_layout(
        &self,
        layout: &crate::desktop::Layout,
    ) -> io::Result<crate::desktop::Layout> {
        let target: Vec<aegis_winffi::desktop::DesktopIcon> = layout
            .icons
            .iter()
            .map(|i| aegis_winffi::desktop::DesktopIcon {
                name: i.name.clone(),
                x: i.x,
                y: i.y,
            })
            .collect();
        let previous = aegis_winffi::desktop::apply_icons(&target)?;
        Ok(crate::desktop::Layout {
            name: format!("Vor „{}“", layout.name),
            saved: crate::walk::unix(Ok(SystemTime::now())),
            icons: previous.into_iter().map(icon).collect(),
        })
    }
}

fn icon(i: aegis_winffi::desktop::DesktopIcon) -> crate::desktop::Icon {
    crate::desktop::Icon {
        name: i.name,
        x: i.x,
        y: i.y,
    }
}

/// Aktuelle Desktop-Symbole (nur lesend).
///
/// # Errors
/// Desktop nicht erreichbar.
pub fn desktop_icons() -> io::Result<Vec<crate::desktop::Icon>> {
    Ok(aegis_winffi::desktop::read_icons()?
        .into_iter()
        .map(icon)
        .collect())
}

fn startup_folder(var: &str, rel: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(|v| PathBuf::from(v).join(rel))
}

/// Alle Autostart-Einträge (Konto änderbar, rechnerweit nur Anzeige).
#[must_use]
pub fn autostart_entries() -> Vec<Entry> {
    let platform = WindowsPlatform;
    let mut out = Vec::new();
    let mut push = |location: Location, name: String, command: String| {
        let entry = EntryRef { location, name };
        let enabled = if location.editable() {
            platform.autostart_enabled(&entry).unwrap_or(true)
        } else {
            let key = match location {
                Location::RunMachine => {
                    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
                }
                _ => {
                    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder"
                }
            };
            read_raw(&Hive::LocalMachine, key, &entry.name)
                .ok()
                .is_none_or(|v| approved_enabled(v.as_ref().map(|v| v.bytes.as_slice())))
        };
        out.push(Entry {
            editable: location.editable(),
            entry,
            command,
            enabled,
        });
    };
    for v in read_values(&Hive::CurrentUser, RUN) {
        push(Location::RunUser, v.name, v.data);
    }
    for v in read_values(&Hive::LocalMachine, RUN) {
        push(Location::RunMachine, v.name, v.data);
    }
    for (location, folder) in [
        (
            Location::StartupFolderUser,
            startup_folder("APPDATA", r"Microsoft\Windows\Start Menu\Programs\Startup"),
        ),
        (
            Location::StartupFolderMachine,
            startup_folder(
                "ProgramData",
                r"Microsoft\Windows\Start Menu\Programs\StartUp",
            ),
        ),
    ] {
        let Some(folder) = folder else { continue };
        let Ok(entries) = std::fs::read_dir(&folder) else {
            continue;
        };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.eq_ignore_ascii_case("desktop.ini") {
                continue;
            }
            push(location, name, e.path().display().to_string());
        }
    }
    out
}
