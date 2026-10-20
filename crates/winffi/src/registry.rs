//! Registrierungswerte lesen (roh, für „Rückgängig“) und schreiben – **nur** aus freigegebenen
//! Plänen der Härtung (P6). Jeder schreibende Aufruf ist mit `aegis-mutation` markiert.

use std::io;
use std::ptr;

use windows_sys::Win32::System::Registry::{
    HKEY, KEY_QUERY_VALUE, KEY_SET_VALUE, KEY_WOW64_64KEY, REG_DWORD, REG_OPTION_NON_VOLATILE,
    RegCloseKey, RegCreateKeyExW, RegDeleteKeyExW, RegDeleteValueW, RegOpenKeyExW,
    RegQueryInfoKeyW, RegQueryValueExW, RegSetValueExW,
};

use crate::inspect::Hive;
use crate::util::wide;

/// `ERROR_FILE_NOT_FOUND`: Schlüssel oder Wert fehlt.
const NOT_FOUND: u32 = 2;
/// Größter Wert, der für „Rückgängig“ gemerkt wird.
const MAX_VALUE: usize = 64 * 1024;

/// Ein Wert, wie er in der Registrierung steht (Typ + Bytes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawValue {
    /// Typ (`REG_DWORD` = 4, `REG_SZ` = 1 …).
    pub kind: u32,
    /// Daten.
    pub bytes: Vec<u8>,
}

impl RawValue {
    /// Ein `REG_DWORD`.
    #[must_use]
    pub fn dword(value: u32) -> Self {
        Self {
            kind: REG_DWORD,
            bytes: value.to_le_bytes().to_vec(),
        }
    }
}

struct Key(HKEY);

impl Drop for Key {
    fn drop(&mut self) {
        // SAFETY: eigener, geöffneter Schlüssel; genau einmal schließen.
        // aegis-unsafe: winffi-registry-close
        #[allow(unsafe_code)]
        let _ = unsafe { RegCloseKey(self.0) };
    }
}

fn status(code: u32) -> io::Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(
            i32::try_from(code).unwrap_or(i32::MAX),
        ))
    }
}

/// Liest einen Wert roh (`None` = Schlüssel oder Wert fehlt).
///
/// # Errors
/// Kein Zugriff oder Wert zu groß.
pub fn read_raw(hive: &Hive, key: &str, name: &str) -> io::Result<Option<RawValue>> {
    let (root, path, _) = hive.root_and_prefix(key);
    let path = wide(&path);
    let mut handle: HKEY = ptr::null_mut();
    // SAFETY: nullterminierter Pfad; nur Leserecht; Ausgabezeiger gültig.
    // aegis-unsafe: winffi-registry-open-read
    #[allow(unsafe_code)]
    let code = unsafe {
        RegOpenKeyExW(
            root,
            path.as_ptr(),
            0,
            KEY_QUERY_VALUE | KEY_WOW64_64KEY,
            &mut handle,
        )
    };
    if code == NOT_FOUND {
        return Ok(None);
    }
    status(code)?;
    let handle = Key(handle);
    let name = wide(name);
    let mut kind = 0u32;
    let mut buffer = vec![0u8; 1024];
    loop {
        let mut len = u32::try_from(buffer.len()).unwrap_or(u32::MAX);
        // SAFETY: Schlüssel offen; Puffer der angegebenen Länge.
        // aegis-unsafe: winffi-registry-query
        #[allow(unsafe_code)]
        let code = unsafe {
            RegQueryValueExW(
                handle.0,
                name.as_ptr(),
                ptr::null(),
                &mut kind,
                buffer.as_mut_ptr(),
                &mut len,
            )
        };
        let len = usize::try_from(len).unwrap_or(usize::MAX);
        match code {
            0 => {
                buffer.truncate(len);
                return Ok(Some(RawValue {
                    kind,
                    bytes: buffer,
                }));
            }
            NOT_FOUND => return Ok(None),
            // ERROR_MORE_DATA
            234 if len <= MAX_VALUE => buffer.resize(len, 0),
            234 => return Err(io::Error::other("Wert zu groß")),
            other => return status(other).map(|()| None),
        }
    }
}

fn open_for_write(hive: &Hive, key: &str) -> io::Result<Key> {
    let (root, path, _) = hive.root_and_prefix(key);
    let path = wide(&path);
    let mut handle: HKEY = ptr::null_mut();
    // SAFETY: nullterminierter Pfad; Ausgabezeiger gültig; keine Sicherheitsattribute (erbt).
    // aegis-unsafe: winffi-registry-create
    #[allow(unsafe_code)]
    // Öffnet (oder legt an) den Schlüssel eines freigegebenen Härtungs-Plans.
    // aegis-mutation: winffi-registry-create-key
    #[allow(clippy::disallowed_methods)]
    let code = unsafe {
        RegCreateKeyExW(
            root,
            path.as_ptr(),
            0,
            ptr::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE | KEY_WOW64_64KEY,
            ptr::null(),
            &mut handle,
            ptr::null_mut(),
        )
    };
    status(code)?;
    Ok(Key(handle))
}

/// Schreibt einen Wert. Nur aus einem freigegebenen Härtungs-Plan aufrufen.
///
/// # Errors
/// Kein Zugriff.
pub fn write_raw(hive: &Hive, key: &str, name: &str, value: &RawValue) -> io::Result<()> {
    let handle = open_for_write(hive, key)?;
    let name = wide(name);
    // SAFETY: Schlüssel offen; Daten der angegebenen Länge.
    // aegis-unsafe: winffi-registry-set
    #[allow(unsafe_code)]
    // Setzt genau den Wert aus dem freigegebenen Plan.
    // aegis-mutation: winffi-registry-set-value
    #[allow(clippy::disallowed_methods)]
    let code = unsafe {
        RegSetValueExW(
            handle.0,
            name.as_ptr(),
            0,
            value.kind,
            value.bytes.as_ptr(),
            u32::try_from(value.bytes.len()).unwrap_or(u32::MAX),
        )
    };
    status(code)
}

/// Entfernt einen Wert (fehlt er schon: kein Fehler). Nur für „Rückgängig“ eines Werts, den
/// ein freigegebener Härtungs-Plan neu angelegt hat.
///
/// # Errors
/// Kein Zugriff.
pub fn delete_value(hive: &Hive, key: &str, name: &str) -> io::Result<()> {
    // Nur öffnen, nie anlegen: Fehlt der Schlüssel, gibt es auch den Wert nicht.
    let (root, path, _) = hive.root_and_prefix(key);
    let path = wide(&path);
    let mut raw: HKEY = ptr::null_mut();
    // SAFETY: nullterminierter Pfad; nur Recht zum Setzen/Entfernen von Werten.
    // aegis-unsafe: winffi-registry-open-delete
    #[allow(unsafe_code)]
    let code = unsafe {
        RegOpenKeyExW(
            root,
            path.as_ptr(),
            0,
            KEY_SET_VALUE | KEY_WOW64_64KEY,
            &mut raw,
        )
    };
    if code == NOT_FOUND {
        return Ok(());
    }
    status(code)?;
    let handle = Key(raw);
    let name = wide(name);
    // SAFETY: Schlüssel offen; nullterminierter Name.
    // aegis-unsafe: winffi-registry-delete
    #[allow(unsafe_code)]
    // Entfernt nur den Wert, den der Plan selbst angelegt hatte („Rückgängig“).
    // aegis-mutation: winffi-registry-delete-value
    #[allow(clippy::disallowed_methods)]
    let code = unsafe { RegDeleteValueW(handle.0, name.as_ptr()) };
    if code == NOT_FOUND {
        Ok(())
    } else {
        status(code)
    }
}

/// Entfernt einen Schlüssel nur, wenn er **leer** ist (keine Werte, keine Unterschlüssel) –
/// für „Rückgängig“ eines Schlüssels, den ein freigegebener Plan selbst angelegt hat. Fehlt er:
/// kein Fehler. Liefert, ob er entfernt wurde.
///
/// # Errors
/// Kein Zugriff.
pub fn delete_empty_key(hive: &Hive, key: &str) -> io::Result<bool> {
    let (root, path, _) = hive.root_and_prefix(key);
    let wide_path = wide(&path);
    let mut raw: HKEY = ptr::null_mut();
    // SAFETY: nullterminierter Pfad; nur Leserecht zum Zählen.
    // aegis-unsafe: winffi-registry-open-count
    #[allow(unsafe_code)]
    let code = unsafe {
        RegOpenKeyExW(
            root,
            wide_path.as_ptr(),
            0,
            KEY_QUERY_VALUE | KEY_WOW64_64KEY,
            &mut raw,
        )
    };
    if code == NOT_FOUND {
        return Ok(false);
    }
    status(code)?;
    let handle = Key(raw);
    let (mut subkeys, mut values) = (0u32, 0u32);
    // SAFETY: Schlüssel offen; nur die beiden Zähler werden abgefragt, alle anderen
    // Ausgaben sind Nullzeiger (laut Dokumentation erlaubt).
    // aegis-unsafe: winffi-registry-count
    #[allow(unsafe_code)]
    let code = unsafe {
        RegQueryInfoKeyW(
            handle.0,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null(),
            &mut subkeys,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut values,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    status(code)?;
    drop(handle);
    if subkeys != 0 || values != 0 {
        return Ok(false);
    }
    // SAFETY: nullterminierter Pfad; RegDeleteKeyExW entfernt nur diesen (leeren) Schlüssel.
    // aegis-unsafe: winffi-registry-delete-key
    #[allow(unsafe_code)]
    // Entfernt nur einen leeren Schlüssel, den der Plan selbst angelegt hatte („Rückgängig“).
    // aegis-mutation: winffi-registry-delete-empty-key
    #[allow(clippy::disallowed_methods)]
    let code = unsafe { RegDeleteKeyExW(root, wide_path.as_ptr(), KEY_WOW64_64KEY, 0) };
    if code == NOT_FOUND {
        return Ok(false);
    }
    status(code).map(|()| true)
}
