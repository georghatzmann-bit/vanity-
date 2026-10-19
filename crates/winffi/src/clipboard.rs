//! Zwischenablage: lesen (P6.6, Krypto-Adressen-Wächter der App, opt-in: Änderungszähler, Text,
//! Besitzer) und – nur auf Klick „Kopieren“ im Passwort-Tresor (P9) – Text setzen, ohne Verlauf
//! (Win+V) und ohne Cloud-Abgleich, sowie genau diesen Inhalt nach Ablauf wieder leeren.

use std::io;
use std::ptr;

use windows_sys::Win32::Foundation::{GlobalFree, HANDLE, HWND};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardOwner,
    GetClipboardSequenceNumber, IsClipboardFormatAvailable, OpenClipboard,
    RegisterClipboardFormatW, SetClipboardData,
};
use windows_sys::Win32::System::Memory::{
    GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock,
};
use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

/// Unicode-Text (`CF_UNICODETEXT`).
const CF_UNICODETEXT: u32 = 13;

/// Änderungszähler der Zwischenablage (ändert sich bei jedem Kopieren).
#[must_use]
pub fn sequence_number() -> u32 {
    // SAFETY: ohne Argumente, liest nur einen Zähler.
    // aegis-unsafe: winffi-clipboard-sequence
    #[allow(unsafe_code)]
    unsafe {
        GetClipboardSequenceNumber()
    }
}

/// Hat das kopierende Programm den Inhalt als „nicht überwachen“ markiert (z. B.
/// Passwort-Manager: `ExcludeClipboardContentFromMonitorProcessing`)? Dann liest AEGIS ihn nicht.
#[must_use]
pub fn excluded_from_monitoring() -> bool {
    let name = crate::util::wide("ExcludeClipboardContentFromMonitorProcessing");
    // SAFETY: nullterminierter Name; liefert die Kennung des (systemweit bekannten) Formats.
    // aegis-unsafe: winffi-clipboard-exclude-format
    #[allow(unsafe_code)]
    let format = unsafe { RegisterClipboardFormatW(name.as_ptr()) };
    if format == 0 {
        return false;
    }
    // SAFETY: Formatkennung von oben.
    // aegis-unsafe: winffi-clipboard-exclude-check
    #[allow(unsafe_code)]
    let present = unsafe { IsClipboardFormatAvailable(format) };
    present != 0
}

/// Prozess-ID des Programms, dem die Zwischenablage gerade gehört (hat zuletzt kopiert).
#[must_use]
pub fn owner_process() -> Option<u32> {
    // SAFETY: ohne Argumente; liefert ein Fenster-Handle oder null.
    // aegis-unsafe: winffi-clipboard-owner
    #[allow(unsafe_code)]
    let window: HWND = unsafe { GetClipboardOwner() };
    if window.is_null() {
        return None;
    }
    let mut pid = 0u32;
    // SAFETY: `window` stammt von GetClipboardOwner; Ausgabezeiger gültig.
    // aegis-unsafe: winffi-clipboard-owner-pid
    #[allow(unsafe_code)]
    unsafe {
        GetWindowThreadProcessId(window, &mut pid);
    }
    (pid != 0).then_some(pid)
}

/// Schließt die Zwischenablage beim Verlassen.
struct Opened;

impl Drop for Opened {
    fn drop(&mut self) {
        // SAFETY: nur nach erfolgreichem OpenClipboard angelegt.
        // aegis-unsafe: winffi-clipboard-close
        #[allow(unsafe_code)]
        unsafe {
            CloseClipboard();
        }
    }
}

/// Liest den Text der Zwischenablage (höchstens `max_chars` Zeichen). `None`: kein Text.
///
/// # Errors
/// Zwischenablage gerade von einem anderen Programm geöffnet.
pub fn read_text(max_chars: usize) -> io::Result<Option<String>> {
    // SAFETY: fester Formatwert.
    // aegis-unsafe: winffi-clipboard-format
    #[allow(unsafe_code)]
    if unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT) } == 0 {
        return Ok(None);
    }
    // SAFETY: ohne Besitzerfenster (null) – nur zum Lesen.
    // aegis-unsafe: winffi-clipboard-open
    #[allow(unsafe_code)]
    if unsafe { OpenClipboard(ptr::null_mut()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let _opened = Opened;
    // SAFETY: Zwischenablage ist geöffnet; das Handle gehört dem System und wird nicht
    // freigegeben.
    // aegis-unsafe: winffi-clipboard-data
    #[allow(unsafe_code)]
    let handle = unsafe { GetClipboardData(CF_UNICODETEXT) };
    if handle.is_null() {
        return Ok(None);
    }
    // SAFETY: gültiges globales Speicher-Handle aus GetClipboardData.
    // aegis-unsafe: winffi-clipboard-lock
    #[allow(unsafe_code)]
    let (data, size) = unsafe { (GlobalLock(handle).cast::<u16>(), GlobalSize(handle)) };
    if data.is_null() {
        return Ok(None);
    }
    let units = (size / 2).min(max_chars.saturating_mul(2));
    // SAFETY: Der gesperrte Block hat `size` Byte; gelesen werden höchstens `size / 2`
    // UTF-16-Einheiten bis zur ersten Null.
    // aegis-unsafe: winffi-clipboard-read
    #[allow(unsafe_code)]
    let text = unsafe {
        let slice = std::slice::from_raw_parts(data, units);
        let end = slice.iter().position(|u| *u == 0).unwrap_or(units);
        String::from_utf16_lossy(&slice[..end])
    };
    // SAFETY: zu GlobalLock oben passend.
    // aegis-unsafe: winffi-clipboard-unlock
    #[allow(unsafe_code)]
    unsafe {
        GlobalUnlock(handle);
    }
    Ok(Some(text.chars().take(max_chars).collect()))
}

/// Legt `bytes` in einen beweglichen globalen Block und übergibt ihn der Zwischenablage
/// (die danach Besitzerin ist). Nur bei geöffneter Zwischenablage aufrufen.
fn put(format: u32, bytes: &[u8]) -> io::Result<()> {
    // SAFETY: Größe > 0; das Handle wird unten übergeben oder freigegeben.
    // aegis-unsafe: winffi-clipboard-alloc
    #[allow(unsafe_code)]
    let memory = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)) };
    if memory.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: frisch angelegter Block mit mindestens `bytes.len()` Byte.
    // aegis-unsafe: winffi-clipboard-fill
    #[allow(unsafe_code)]
    unsafe {
        let target = GlobalLock(memory).cast::<u8>();
        if target.is_null() {
            GlobalFree(memory);
            return Err(io::Error::last_os_error());
        }
        ptr::copy_nonoverlapping(bytes.as_ptr(), target, bytes.len());
        GlobalUnlock(memory);
    }
    // SAFETY: Zwischenablage ist geöffnet und geleert; bei Erfolg gehört der Block dem System.
    // aegis-unsafe: winffi-clipboard-set
    #[allow(unsafe_code)]
    let set: HANDLE = unsafe { SetClipboardData(format, memory) };
    if set.is_null() {
        let err = io::Error::last_os_error();
        // SAFETY: nicht übergeben – selbst freigeben.
        // aegis-unsafe: winffi-clipboard-free
        #[allow(unsafe_code)]
        unsafe {
            GlobalFree(memory);
        }
        return Err(err);
    }
    Ok(())
}

fn register(name: &str) -> u32 {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: nullterminierter Name.
    // aegis-unsafe: winffi-clipboard-register
    #[allow(unsafe_code)]
    unsafe {
        RegisterClipboardFormatW(wide.as_ptr())
    }
}

fn open() -> io::Result<Opened> {
    // SAFETY: ohne Besitzerfenster (null).
    // aegis-unsafe: winffi-clipboard-open-write
    #[allow(unsafe_code)]
    if unsafe { OpenClipboard(ptr::null_mut()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Opened)
}

/// Setzt Text (vom Nutzer per „Kopieren“ angefordert), ohne Aufnahme in den Verlauf und ohne
/// Cloud-Abgleich. Liefert den Änderungszähler danach (für [`clear_if_unchanged`]).
///
/// # Errors
/// Zwischenablage belegt oder Speicher nicht anlegbar.
pub fn set_private_text(text: &str) -> io::Result<u32> {
    let mut wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let mut bytes: Vec<u8> = wide.iter().flat_map(|u| u.to_le_bytes()).collect();
    let result = (|| {
        let _opened = open()?;
        // SAFETY: Zwischenablage ist geöffnet.
        // aegis-unsafe: winffi-clipboard-empty
        #[allow(unsafe_code)]
        if unsafe { EmptyClipboard() } == 0 {
            return Err(io::Error::last_os_error());
        }
        put(CF_UNICODETEXT, &bytes)?;
        // Hinweise an Windows: nicht in den Verlauf, nicht in die Cloud, nicht überwachen.
        put(
            register("ExcludeClipboardContentFromMonitorProcessing"),
            &[0],
        )?;
        put(
            register("CanIncludeInClipboardHistory"),
            &0u32.to_le_bytes(),
        )?;
        put(register("CanUploadToCloudClipboard"), &0u32.to_le_bytes())?;
        Ok(())
    })();
    // Eigene Kopien des Geheimnisses überschreiben.
    wide.iter_mut().for_each(|u| *u = 0);
    bytes.iter_mut().for_each(|b| *b = 0);
    result.map(|()| sequence_number())
}

/// Leert die Zwischenablage nur, wenn seit [`set_private_text`] nichts anderes kopiert wurde.
///
/// # Errors
/// Zwischenablage belegt.
pub fn clear_if_unchanged(sequence: u32) -> io::Result<bool> {
    if sequence_number() != sequence {
        return Ok(false);
    }
    let _opened = open()?;
    // SAFETY: Zwischenablage ist geöffnet.
    // aegis-unsafe: winffi-clipboard-empty-later
    #[allow(unsafe_code)]
    let ok = unsafe { EmptyClipboard() };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(true)
}
