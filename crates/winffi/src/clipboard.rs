//! Zwischenablage **nur lesen** (P6.6, Krypto-Adressen-Wächter der App, opt-in): Änderungszähler,
//! Text (gekürzt) und der Prozess, dem die Zwischenablage gehört. Geschrieben oder geleert wird
//! die Zwischenablage nie.

use std::io;
use std::ptr;

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, GetClipboardOwner, GetClipboardSequenceNumber,
    IsClipboardFormatAvailable, OpenClipboard,
};
use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
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
