//! Zugriff auf die Registrierung hinter kleinen Schnittstellen, damit die Optimierungs-Logik ohne
//! Windows getestet werden kann: `HKEY_CURRENT_USER` lesen und schreiben ([`Registry`]),
//! `HKEY_LOCAL_MACHINE` nur lesen ([`RegistryRead`], geht ohne Adminrechte). Geschrieben wird
//! unter HKLM ausschließlich über den Admin-Helfer (`crate::elevate`).
#![cfg_attr(not(windows), allow(dead_code))]

use serde::{Deserialize, Serialize};

use crate::error::CmdResult;

/// Ein Registrierungswert – nur die Typen, die Pulsar braucht. Im JSON eine Zahl (DWORD) bzw. ein
/// Text (REG_SZ), fehlende Werte sind `null`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RegVal {
    Dword(u32),
    Str(String),
}

impl RegVal {
    /// Zahlwert – bei Texten wird geparst („0“ → 0), sonst `None`.
    pub fn as_u32(&self) -> Option<u32> {
        match self {
            RegVal::Dword(d) => Some(*d),
            RegVal::Str(s) => s.trim().parse().ok(),
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            RegVal::Str(s) => Some(s),
            RegVal::Dword(_) => None,
        }
    }
}

/// Lesen, Schreiben und Löschen von Werten unter `HKCU`.
pub trait Registry {
    /// Liest `name` unter `HKCU\key`. `Ok(None)`, wenn Schlüssel oder Wert fehlen.
    fn get(&self, key: &str, name: &str) -> CmdResult<Option<RegVal>>;
    /// Schreibt `name` unter `HKCU\key` und legt den Schlüssel bei Bedarf an.
    fn set(&self, key: &str, name: &str, value: &RegVal) -> CmdResult<()>;
    /// Löscht `name` unter `HKCU\key`; kein Fehler, wenn er schon fehlt.
    fn delete(&self, key: &str, name: &str) -> CmdResult<()>;
}

/// Nur lesen (für `HKLM`; Lesen braucht dort keine Adminrechte).
pub trait RegistryRead {
    /// Liest `name` unter `key`. `Ok(None)`, wenn Schlüssel oder Wert fehlen.
    fn read(&self, key: &str, name: &str) -> CmdResult<Option<RegVal>>;
    /// Gibt es den Schlüssel `key`?
    fn key_exists(&self, key: &str) -> bool;
}

/// Setzt einen Wert oder löscht ihn (`None`) – zum Zurückstellen aus einer Sicherung.
pub fn restore(reg: &dyn Registry, key: &str, name: &str, value: Option<&RegVal>) -> CmdResult<()> {
    match value {
        Some(v) => reg.set(key, name, v),
        None => reg.delete(key, name),
    }
}

// =============================================================================================
// Windows
// =============================================================================================

/// Die echte Registrierung des angemeldeten Benutzers.
#[cfg(windows)]
pub struct Hkcu;

#[cfg(windows)]
fn reg_err_in(root: &str, what: &str, key: &str, name: &str, e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::PermissionDenied => {
            format!("Zugriff auf die Registrierung verweigert: {root}\\{key}\\{name}")
        }
        _ => format!("Der Registrierungswert {root}\\{key}\\{name} konnte nicht {what} werden: {e}"),
    }
}

#[cfg(windows)]
fn reg_err(what: &str, key: &str, name: &str, e: &std::io::Error) -> String {
    reg_err_in("HKCU", what, key, name, e)
}

/// Einen Wert lesen (DWORD oder Text). `Ok(None)`, wenn Schlüssel oder Wert fehlen.
#[cfg(windows)]
fn read_value(root: &winreg::RegKey, root_name: &str, key: &str, name: &str) -> CmdResult<Option<RegVal>> {
    use std::io::ErrorKind;
    use winreg::enums::{KEY_READ, KEY_WOW64_64KEY, REG_DWORD, REG_EXPAND_SZ, REG_SZ};
    use winreg::types::FromRegValue;

    let sub = match root.open_subkey_with_flags(key, KEY_READ | KEY_WOW64_64KEY) {
        Ok(k) => k,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(reg_err_in(root_name, "gelesen", key, name, &e)),
    };
    let raw = match sub.get_raw_value(name) {
        Ok(r) => r,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(reg_err_in(root_name, "gelesen", key, name, &e)),
    };
    let parsed = match raw.vtype {
        REG_DWORD => u32::from_reg_value(&raw).map(RegVal::Dword),
        REG_SZ | REG_EXPAND_SZ => String::from_reg_value(&raw).map(RegVal::Str),
        _ => return Err(format!("Unerwarteter Werttyp in der Registrierung: {root_name}\\{key}\\{name}")),
    };
    parsed.map(Some).map_err(|e| reg_err_in(root_name, "gelesen", key, name, &e))
}

/// `HKEY_LOCAL_MACHINE`, nur lesend.
#[cfg(windows)]
pub struct HklmRead;

#[cfg(windows)]
impl RegistryRead for HklmRead {
    fn read(&self, key: &str, name: &str) -> CmdResult<Option<RegVal>> {
        read_value(&winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE), "HKLM", key, name)
    }

    fn key_exists(&self, key: &str) -> bool {
        use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, KEY_WOW64_64KEY};
        winreg::RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(key, KEY_QUERY_VALUE | KEY_WOW64_64KEY)
            .is_ok()
    }
}

#[cfg(windows)]
impl Registry for Hkcu {
    fn get(&self, key: &str, name: &str) -> CmdResult<Option<RegVal>> {
        read_value(&winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER), "HKCU", key, name)
    }

    fn set(&self, key: &str, name: &str, value: &RegVal) -> CmdResult<()> {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE};
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (sub, _) = hkcu
            .create_subkey_with_flags(key, KEY_WRITE)
            .map_err(|e| reg_err("geschrieben", key, name, &e))?;
        let r = match value {
            RegVal::Dword(d) => sub.set_value(name, d),
            RegVal::Str(s) => sub.set_value(name, s),
        };
        r.map_err(|e| reg_err("geschrieben", key, name, &e))
    }

    fn delete(&self, key: &str, name: &str) -> CmdResult<()> {
        use std::io::ErrorKind;
        use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let sub = match hkcu.open_subkey_with_flags(key, KEY_SET_VALUE) {
            Ok(k) => k,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(reg_err("gelöscht", key, name, &e)),
        };
        match sub.delete_value(name) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
            Err(e) => Err(reg_err("gelöscht", key, name, &e)),
        }
    }
}

// =============================================================================================
// Tests: Registrierung im Speicher
// =============================================================================================

/// Registrierung im Speicher (Schlüssel und Namen wie unter Windows ohne Groß-/Kleinschreibung).
#[cfg(test)]
#[derive(Default)]
pub struct MemRegistry {
    values: std::cell::RefCell<std::collections::BTreeMap<(String, String), RegVal>>,
    /// Schlüssel, die es gibt (auch ohne Werte)
    keys: std::cell::RefCell<std::collections::BTreeSet<String>>,
    /// Alle Zugriffe schlagen fehl (simuliert eine gesperrte Registrierung)
    pub fail: std::cell::Cell<bool>,
}

#[cfg(test)]
impl MemRegistry {
    fn id(key: &str, name: &str) -> (String, String) {
        (key.to_lowercase(), name.to_lowercase())
    }

    pub fn with(values: &[(&str, &str, RegVal)]) -> Self {
        let reg = Self::default();
        for (k, n, v) in values {
            reg.values.borrow_mut().insert(Self::id(k, n), v.clone());
            reg.add_key(k);
        }
        reg
    }

    /// Schlüssel anlegen (ohne Werte).
    pub fn add_key(&self, key: &str) {
        self.keys.borrow_mut().insert(key.to_lowercase());
    }

    /// Schlüssel samt Werten entfernen (z. B. Netzwerkadapter ausgebaut).
    pub fn remove_key(&self, key: &str) {
        let k = key.to_lowercase();
        self.keys.borrow_mut().remove(&k);
        self.values.borrow_mut().retain(|(vk, _), _| *vk != k);
    }

    pub fn dword(&self, key: &str, name: &str) -> Option<u32> {
        self.values.borrow().get(&Self::id(key, name)).and_then(RegVal::as_u32)
    }

    pub fn string(&self, key: &str, name: &str) -> Option<String> {
        self.values
            .borrow()
            .get(&Self::id(key, name))
            .and_then(|v| v.as_str().map(str::to_string))
    }

    pub fn has(&self, key: &str, name: &str) -> bool {
        self.values.borrow().contains_key(&Self::id(key, name))
    }
}

#[cfg(test)]
impl Registry for MemRegistry {
    fn get(&self, key: &str, name: &str) -> CmdResult<Option<RegVal>> {
        if self.fail.get() {
            return Err("Registrierung gesperrt (Test)".into());
        }
        Ok(self.values.borrow().get(&Self::id(key, name)).cloned())
    }

    fn set(&self, key: &str, name: &str, value: &RegVal) -> CmdResult<()> {
        if self.fail.get() {
            return Err("Registrierung gesperrt (Test)".into());
        }
        self.values.borrow_mut().insert(Self::id(key, name), value.clone());
        self.add_key(key);
        Ok(())
    }

    fn delete(&self, key: &str, name: &str) -> CmdResult<()> {
        if self.fail.get() {
            return Err("Registrierung gesperrt (Test)".into());
        }
        self.values.borrow_mut().remove(&Self::id(key, name));
        Ok(())
    }
}

#[cfg(test)]
impl RegistryRead for MemRegistry {
    fn read(&self, key: &str, name: &str) -> CmdResult<Option<RegVal>> {
        self.get(key, name)
    }

    fn key_exists(&self, key: &str) -> bool {
        self.keys.borrow().contains(&key.to_lowercase())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn regval_json_roundtrip() {
        let vals: Vec<Option<RegVal>> = vec![Some(RegVal::Dword(1)), Some(RegVal::Str("10".into())), None];
        let json = serde_json::to_value(&vals).unwrap();
        assert_eq!(json, json!([1, "10", null]));
        let back: Vec<Option<RegVal>> = serde_json::from_value(json).unwrap();
        assert_eq!(back, vals);
        assert!(serde_json::from_value::<RegVal>(json!(-5)).is_err(), "negative Zahl ist kein DWORD");
        assert!(serde_json::from_value::<RegVal>(json!([1])).is_err());
    }

    #[test]
    fn regval_accessors() {
        assert_eq!(RegVal::Dword(7).as_u32(), Some(7));
        assert_eq!(RegVal::Str(" 6 ".into()).as_u32(), Some(6));
        assert_eq!(RegVal::Str("x".into()).as_u32(), None);
        assert_eq!(RegVal::Str("a".into()).as_str(), Some("a"));
        assert_eq!(RegVal::Dword(1).as_str(), None);
    }

    #[test]
    fn mem_registry_is_case_insensitive_and_restore_deletes() {
        let reg = MemRegistry::default();
        reg.set(r"Software\X", "Wert", &RegVal::Dword(3)).unwrap();
        assert_eq!(reg.get(r"software\x", "wert").unwrap(), Some(RegVal::Dword(3)));
        restore(&reg, r"Software\X", "Wert", None).unwrap();
        assert_eq!(reg.get(r"Software\X", "Wert").unwrap(), None);
        reg.delete(r"Software\X", "Wert").unwrap();
        restore(&reg, r"Software\X", "Wert", Some(&RegVal::Str("a".into()))).unwrap();
        assert_eq!(reg.string(r"Software\X", "Wert"), Some("a".into()));
    }
}
