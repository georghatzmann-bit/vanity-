//! DPAPI (Rechner-Bereich): bindet AEGIS-eigene Schlüssel an diesen Rechner. Ein auf einen
//! anderen Rechner kopierter Datenordner ist damit nicht entschlüsselbar. Ehrlich: Prozesse mit
//! Administratorrechten auf **diesem** Rechner können den Schlüssel weiterhin auspacken.

use std::io;
use std::ptr;

use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_LOCAL_MACHINE, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
    CryptUnprotectData,
};

/// Zusätzliche Entropie: Blobs anderer Programme passen nicht.
const ENTROPY: &[u8] = b"AEGIS-Suite/Quarantaene-Schluessel/v1";

fn blob(data: &[u8]) -> io::Result<CRYPT_INTEGER_BLOB> {
    Ok(CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(data.len()).map_err(|_| io::Error::other("zu groß"))?,
        pbData: data.as_ptr().cast_mut(),
    })
}

/// Nimmt das Ergebnis von DPAPI (LocalAlloc) als Vec und gibt den Puffer frei (vorher genullt).
fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    let len = usize::try_from(out.cbData).unwrap_or(0);
    let mut data = Vec::with_capacity(len);
    if !out.pbData.is_null() {
        // SAFETY: DPAPI liefert `cbData` gültige Bytes ab `pbData`; danach genullt und genau
        // einmal mit LocalFree freigegeben.
        // aegis-unsafe: winffi-dpapi-take
        #[allow(unsafe_code)]
        unsafe {
            data.extend_from_slice(std::slice::from_raw_parts(out.pbData, len));
            std::ptr::write_bytes(out.pbData, 0, len);
            let _ = LocalFree(out.pbData.cast());
        }
    }
    data
}

/// Verschlüsselt `data` für diesen Rechner.
///
/// # Errors
/// DPAPI nicht verfügbar.
pub fn protect_machine(data: &[u8]) -> io::Result<Vec<u8>> {
    let input = blob(data)?;
    let entropy = blob(ENTROPY)?;
    let mut out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    // SAFETY: Eingaben zeigen auf lebende Puffer; `out` erhält einen LocalAlloc-Puffer.
    // aegis-unsafe: winffi-dpapi-protect
    #[allow(unsafe_code)]
    let ok = unsafe {
        CryptProtectData(
            &input,
            ptr::null(),
            &entropy,
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(take(out))
}

/// Entschlüsselt einen mit [`protect_machine`] erzeugten Blob.
///
/// # Errors
/// Blob beschädigt, von einem anderen Rechner oder DPAPI nicht verfügbar.
pub fn unprotect(data: &[u8]) -> io::Result<Vec<u8>> {
    let input = blob(data)?;
    let entropy = blob(ENTROPY)?;
    let mut out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    // SAFETY: Eingaben zeigen auf lebende Puffer; `out` erhält einen LocalAlloc-Puffer.
    // aegis-unsafe: winffi-dpapi-unprotect
    #[allow(unsafe_code)]
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            ptr::null_mut(),
            &entropy,
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(take(out))
}
