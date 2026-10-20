//! Shell-Hüllen für die Windows-Tools (P10): Papierkorb, Hintergrundbild, Verschieben ohne
//! Überschreiben. Jeder verändernde Aufruf ist mit `aegis-mutation` markiert und wird nur aus
//! einer freigegebenen Werkzeug-Vorschau aufgerufen.

use std::io;
use std::path::{Path, PathBuf};

use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW};
use windows_sys::Win32::UI::Shell::{
    FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, SHFILEOPSTRUCTW,
    SHFileOperationW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    SPI_GETDESKWALLPAPER, SPI_SETDESKWALLPAPER, SPIF_SENDWININICHANGE, SPIF_UPDATEINIFILE,
    SystemParametersInfoW,
};

use crate::util::wide;

/// Legt eine Datei in den Papierkorb (umkehrbar, ohne Rückfrage-Dialog).
///
/// # Errors
/// Shell meldet einen Fehler oder der Vorgang wurde abgebrochen.
pub fn recycle(path: &Path) -> io::Result<()> {
    // Doppelt nullterminierte Liste mit genau einem Pfad.
    let mut from = wide(path);
    from.push(0);
    let mut op = SHFILEOPSTRUCTW {
        hwnd: std::ptr::null_mut(),
        wFunc: FO_DELETE,
        pFrom: from.as_ptr(),
        pTo: std::ptr::null(),
        fFlags: u16::try_from(FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT)
            .unwrap_or(0),
        fAnyOperationsAborted: 0,
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: std::ptr::null(),
    };
    // SAFETY: `op` ist vollständig belegt; `from` ist doppelt nullterminiert und lebt bis nach
    // dem Aufruf; ohne Fenster, ohne Dialoge.
    // aegis-unsafe: winffi-shell-recycle
    #[allow(unsafe_code)]
    // Papierkorb (umkehrbar) – nur für Schritte einer freigegebenen Werkzeug-Vorschau.
    // aegis-mutation: winffi-shell-recycle-call
    #[allow(clippy::disallowed_methods)]
    let code = unsafe { SHFileOperationW(&mut op) };
    if code != 0 {
        return Err(io::Error::other(format!(
            "Papierkorb nicht möglich (Code {code})"
        )));
    }
    if op.fAnyOperationsAborted != 0 {
        return Err(io::Error::other("Papierkorb abgebrochen"));
    }
    Ok(())
}

/// Verschiebt eine Datei, ohne ein vorhandenes Ziel zu überschreiben (nur gleiches Laufwerk).
///
/// # Errors
/// Ziel vorhanden, anderes Laufwerk oder kein Zugriff.
pub fn move_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    let (f, t) = (wide(from), wide(to));
    // SAFETY: beide Namen nullterminiert; ohne MOVEFILE_REPLACE_EXISTING und ohne
    // MOVEFILE_COPY_ALLOWED: scheitert, wenn das Ziel existiert oder das Laufwerk wechselt.
    // aegis-unsafe: winffi-move-no-replace
    #[allow(unsafe_code)]
    // Verschiebt nur Dateien aus einer freigegebenen Werkzeug-Vorschau (bzw. Rückgängig).
    // aegis-mutation: winffi-move-no-replace-call
    #[allow(clippy::disallowed_methods)]
    let ok = unsafe { MoveFileExW(f.as_ptr(), t.as_ptr(), MOVEFILE_WRITE_THROUGH) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Aktuelles Hintergrundbild (leer, wenn keins gesetzt ist).
///
/// # Errors
/// Nicht lesbar.
pub fn wallpaper() -> io::Result<PathBuf> {
    let mut buffer = vec![0u16; 1024];
    // SAFETY: Puffer mit 1024 Zeichen; die Länge wird übergeben.
    // aegis-unsafe: winffi-wallpaper-get
    #[allow(unsafe_code)]
    // Nur lesend (SPI_GETDESKWALLPAPER) – dieselbe Funktion setzt sonst Einstellungen.
    // aegis-mutation: winffi-wallpaper-get-call
    #[allow(clippy::disallowed_methods)]
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETDESKWALLPAPER,
            u32::try_from(buffer.len()).unwrap_or(0),
            buffer.as_mut_ptr().cast(),
            0,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let len = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
    Ok(PathBuf::from(String::from_utf16_lossy(
        buffer.get(..len).unwrap_or_default(),
    )))
}

/// Setzt das Hintergrundbild des Kontos (leerer Pfad: kein Bild).
///
/// # Errors
/// Nicht möglich.
pub fn set_wallpaper(path: &Path) -> io::Result<()> {
    let mut name = wide(path);
    // SAFETY: `name` nullterminiert und lebt bis nach dem Aufruf.
    // aegis-unsafe: winffi-wallpaper-set
    #[allow(unsafe_code)]
    // Hintergrundbild des Kontos – nur aus einer freigegebenen Werkzeug-Vorschau.
    // aegis-mutation: winffi-wallpaper-set-call
    #[allow(clippy::disallowed_methods)]
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_SETDESKWALLPAPER,
            0,
            name.as_mut_ptr().cast(),
            SPIF_UPDATEINIFILE | SPIF_SENDWININICHANGE,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
