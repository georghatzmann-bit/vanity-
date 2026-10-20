//! Shell-Hüllen für die Windows-Tools (P10): Papierkorb, Hintergrundbild, Verschieben ohne
//! Überschreiben. Jeder verändernde Aufruf ist mit `aegis-mutation` markiert und wird nur aus
//! einer freigegebenen Werkzeug-Vorschau aufgerufen.

use std::io;
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use windows::Win32::Foundation::E_ABORT;
use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance};
use windows::Win32::UI::Shell::{
    FOF_ALLOWUNDO, FOF_NO_CONNECTED_ELEMENTS, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
    FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE, FileOperation, IFileOperation,
    IFileOperationProgressSink, IFileOperationProgressSink_Impl, IShellItem,
    SHCreateItemFromParsingName, TSF_DELETE_RECYCLE_IF_POSSIBLE,
};
use windows::core::{HRESULT, PCWSTR, Ref};
use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, MOVEFILE_WRITE_THROUGH, MoveFileExW};

use windows_sys::Win32::UI::WindowsAndMessaging::{
    SPI_GETDESKWALLPAPER, SPI_SETDESKWALLPAPER, SPIF_SENDWININICHANGE, SPIF_UPDATEINIFILE,
    SystemParametersInfoW,
};

use crate::desktop::Com;
use crate::util::wide;

/// `DRIVE_FIXED`.
const DRIVE_FIXED: u32 = 3;

// Das `implement`-Makro erzeugt die COM-Tabelle (unsafe) des Wächters; der eigene Code
// darin ist frei von `unsafe`.
// aegis-unsafe: winffi-recycle-guard
#[allow(unsafe_code)]
fn recycle_guard(refused: Arc<AtomicBool>) -> IFileOperationProgressSink {
    /// Wacht über einen Papierkorb-Vorgang: Will die Shell ein Element endgültig löschen statt es
    /// in den Papierkorb zu legen (zu groß, Wechseldatenträger, Netzlaufwerk, Papierkorb aus),
    /// bricht der Wächter ab – endgültiges Löschen braucht die zweite, getrennte Bestätigung.
    #[windows_core::implement(IFileOperationProgressSink)]
    struct RecycleGuard {
        refused: Arc<AtomicBool>,
    }

    impl IFileOperationProgressSink_Impl for RecycleGuard_Impl {
        fn StartOperations(&self) -> windows::core::Result<()> {
            Ok(())
        }
        fn FinishOperations(&self, _: HRESULT) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreRenameItem(
            &self,
            _: u32,
            _: Ref<IShellItem>,
            _: &PCWSTR,
        ) -> windows::core::Result<()> {
            Err(E_ABORT.into())
        }
        fn PostRenameItem(
            &self,
            _: u32,
            _: Ref<IShellItem>,
            _: &PCWSTR,
            _: HRESULT,
            _: Ref<IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreMoveItem(
            &self,
            _: u32,
            _: Ref<IShellItem>,
            _: Ref<IShellItem>,
            _: &PCWSTR,
        ) -> windows::core::Result<()> {
            Err(E_ABORT.into())
        }
        fn PostMoveItem(
            &self,
            _: u32,
            _: Ref<IShellItem>,
            _: Ref<IShellItem>,
            _: &PCWSTR,
            _: HRESULT,
            _: Ref<IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreCopyItem(
            &self,
            _: u32,
            _: Ref<IShellItem>,
            _: Ref<IShellItem>,
            _: &PCWSTR,
        ) -> windows::core::Result<()> {
            Err(E_ABORT.into())
        }
        fn PostCopyItem(
            &self,
            _: u32,
            _: Ref<IShellItem>,
            _: Ref<IShellItem>,
            _: &PCWSTR,
            _: HRESULT,
            _: Ref<IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreDeleteItem(&self, flags: u32, _: Ref<IShellItem>) -> windows::core::Result<()> {
            // Nur „in den Papierkorb“ ist erlaubt; fehlt das Kennzeichen, würde die Shell
            // endgültig löschen.
            if flags & TSF_DELETE_RECYCLE_IF_POSSIBLE.0.cast_unsigned() == 0 {
                self.refused.store(true, Ordering::SeqCst);
                return Err(E_ABORT.into());
            }
            Ok(())
        }
        fn PostDeleteItem(
            &self,
            _: u32,
            _: Ref<IShellItem>,
            _: HRESULT,
            _: Ref<IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreNewItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> windows::core::Result<()> {
            Err(E_ABORT.into())
        }
        fn PostNewItem(
            &self,
            _: u32,
            _: Ref<IShellItem>,
            _: &PCWSTR,
            _: &PCWSTR,
            _: u32,
            _: HRESULT,
            _: Ref<IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn UpdateProgress(&self, _: u32, _: u32) -> windows::core::Result<()> {
            Ok(())
        }
        fn ResetTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }
        fn PauseTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }
        fn ResumeTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }
    }

    RecycleGuard { refused }.into()
}

/// Nur gewöhnliche feste Laufwerke (`C:\…`) haben einen Papierkorb, der zuverlässig greift;
/// Wechseldatenträger und Netzlaufwerke würden endgültig löschen.
fn fixed_drive(path: &Path) -> bool {
    let Some(Component::Prefix(prefix)) = path.components().next() else {
        return false;
    };
    let Prefix::Disk(letter) = prefix.kind() else {
        return false;
    };
    let root = wide(format!("{}:\\", char::from(letter)));
    // SAFETY: `root` ist nullterminiert; nur Abfrage.
    // aegis-unsafe: winffi-recycle-drive-type
    #[allow(unsafe_code)]
    let kind = unsafe { GetDriveTypeW(root.as_ptr()) };
    kind == DRIVE_FIXED
}

/// Legt eine Datei in den Papierkorb (umkehrbar, ohne Rückfrage-Dialog). Ginge sie nicht in
/// den Papierkorb (zu groß, Papierkorb aus, kein festes Laufwerk), passiert **nichts** – die
/// Shell würde sonst endgültig löschen.
///
/// # Errors
/// Kein Papierkorb möglich, Shell meldet einen Fehler oder der Vorgang wurde abgebrochen.
pub fn recycle(path: &Path) -> io::Result<()> {
    if !fixed_drive(path) {
        return Err(io::Error::other(
            "Papierkorb nur auf festen Laufwerken – nichts gelöscht",
        ));
    }
    let _com = Com::init();
    let name = wide(path);
    let refused = Arc::new(AtomicBool::new(false));
    let guard = recycle_guard(Arc::clone(&refused));
    // SAFETY: Dokumentierte Shell-Schnittstelle in einem COM-Faden; `name` ist nullterminiert
    // und lebt bis nach dem Aufruf; alle Rückgaben sind gezählte Schnittstellen.
    // aegis-unsafe: winffi-shell-recycle
    #[allow(unsafe_code)]
    let result = unsafe {
        (|| -> windows::core::Result<bool> {
            let op: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL)?;
            op.SetOperationFlags(
                FOFX_RECYCLEONDELETE
                    | FOF_ALLOWUNDO
                    | FOF_NOCONFIRMATION
                    | FOF_NOERRORUI
                    | FOF_SILENT
                    | FOF_NO_CONNECTED_ELEMENTS
                    | FOFX_EARLYFAILURE,
            )?;
            let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(name.as_ptr()), None)?;
            op.DeleteItem(&item, &guard)?;
            // Papierkorb (umkehrbar) – nur für Schritte einer freigegebenen Werkzeug-Vorschau.
            // aegis-mutation: winffi-shell-recycle-call
            #[allow(clippy::disallowed_methods)]
            let performed = op.PerformOperations();
            let aborted = op
                .GetAnyOperationsAborted()
                .map(|b| b.as_bool())
                .unwrap_or(true);
            performed.map(|()| aborted)
        })()
    };
    if refused.load(Ordering::SeqCst) {
        return Err(io::Error::other(
            "passt nicht in den Papierkorb (zu groß oder Papierkorb aus) – nichts gelöscht",
        ));
    }
    match result {
        Ok(false) => Ok(()),
        Ok(true) => Err(io::Error::other("Papierkorb abgebrochen")),
        Err(e) => Err(io::Error::other(format!("Papierkorb nicht möglich: {e}"))),
    }
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
