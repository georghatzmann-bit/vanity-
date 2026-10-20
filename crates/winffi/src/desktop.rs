//! Desktop-Symbole lesen und an gespeicherte Stellen setzen (Werkzeug 4) – über die
//! dokumentierte Shell-Schnittstelle des Desktops (`IShellWindows` → `IFolderView`), ohne in
//! fremde Prozesse zu schreiben. Setzen nur aus einer freigegebenen Werkzeug-Vorschau.

use std::io;

use windows::Win32::Foundation::{POINT, S_OK};
use windows::Win32::System::Com::{
    CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
    CoUninitialize, IServiceProvider,
};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Shell::Common::{ITEMIDLIST, STRRET};
use windows::Win32::UI::Shell::{
    CSIDL_DESKTOP, IEnumIDList, IFolderView, IShellBrowser, IShellFolder, IShellWindows,
    SHGDN_INFOLDER, SID_STopLevelBrowser, SVGIO_ALLVIEW, SVSI_POSITIONITEM, SWC_DESKTOP,
    SWFO_NEEDDISPATCH, ShellWindows, StrRetToStrW,
};
use windows::core::{Interface, PWSTR};

/// Ein Symbol auf dem Desktop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopIcon {
    /// Anzeigename.
    pub name: String,
    /// X in Pixeln.
    pub x: i32,
    /// Y in Pixeln.
    pub y: i32,
}

fn err(e: &windows::core::Error) -> io::Error {
    io::Error::other(format!("Desktop nicht erreichbar: {e}"))
}

/// COM für diesen Faden (wird beim Verlassen wieder abgemeldet).
pub(crate) struct Com(bool);

impl Com {
    pub(crate) fn init() -> Self {
        // SAFETY: Einmal je Aufruf; bei Erfolg (auch S_FALSE) folgt genau ein CoUninitialize.
        // aegis-unsafe: winffi-desktop-com-init
        #[allow(unsafe_code)]
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        Self(hr.is_ok())
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY: Gegenstück zum erfolgreichen CoInitializeEx dieses Fadens.
            // aegis-unsafe: winffi-desktop-com-uninit
            #[allow(unsafe_code)]
            unsafe {
                CoUninitialize();
            }
        }
    }
}

/// Eine Item-ID-Liste, die beim Verlassen freigegeben wird.
struct Pidl(*mut ITEMIDLIST);

impl Drop for Pidl {
    fn drop(&mut self) {
        // SAFETY: Von IEnumIDList::Next geliefert (CoTaskMemAlloc); genau einmal freigeben.
        // aegis-unsafe: winffi-desktop-pidl-free
        #[allow(unsafe_code)]
        unsafe {
            CoTaskMemFree(Some(self.0.cast_const().cast()));
        }
    }
}

fn desktop_view() -> io::Result<IFolderView> {
    // SAFETY: Nur dokumentierte Shell-Schnittstellen in einem COM-Faden; alle Rückgaben sind
    // gezählte Schnittstellen (windows-Crate), Varianten leben bis nach dem Aufruf.
    // aegis-unsafe: winffi-desktop-view
    #[allow(unsafe_code)]
    unsafe {
        let windows: IShellWindows =
            CoCreateInstance(&ShellWindows, None, CLSCTX_LOCAL_SERVER).map_err(|e| err(&e))?;
        let location = VARIANT::from(i32::try_from(CSIDL_DESKTOP).unwrap_or(0));
        let empty = VARIANT::default();
        let mut hwnd = 0i32;
        let dispatch = windows
            .FindWindowSW(&location, &empty, SWC_DESKTOP, &mut hwnd, SWFO_NEEDDISPATCH)
            .map_err(|e| err(&e))?;
        let provider: IServiceProvider = dispatch.cast().map_err(|e| err(&e))?;
        let browser: IShellBrowser = provider
            .QueryService(&SID_STopLevelBrowser)
            .map_err(|e| err(&e))?;
        let view = browser.QueryActiveShellView().map_err(|e| err(&e))?;
        view.cast().map_err(|e| err(&e))
    }
}

fn items(view: &IFolderView) -> io::Result<Vec<(Pidl, String, POINT)>> {
    let mut out = Vec::new();
    // SAFETY: `view` ist gültig; jede gelieferte Item-ID wird in `Pidl` übernommen (Freigabe);
    // STRRET wird per StrRetToStrW in einen eigenen Text gewandelt und dieser freigegeben.
    // aegis-unsafe: winffi-desktop-items
    #[allow(unsafe_code)]
    unsafe {
        let folder: IShellFolder = view.GetFolder().map_err(|e| err(&e))?;
        let list: IEnumIDList = view.Items(SVGIO_ALLVIEW).map_err(|e| err(&e))?;
        loop {
            let mut one = [std::ptr::null_mut::<ITEMIDLIST>(); 1];
            let mut fetched = 0u32;
            if list.Next(&mut one, Some(&mut fetched)) != S_OK || fetched == 0 {
                break;
            }
            let pidl = Pidl(one[0]);
            let mut strret = STRRET::default();
            if folder
                .GetDisplayNameOf(pidl.0, SHGDN_INFOLDER, &mut strret)
                .is_err()
            {
                continue;
            }
            let mut text = PWSTR::null();
            if StrRetToStrW(&mut strret, Some(pidl.0), &mut text).is_err() {
                continue;
            }
            let name = text.to_string().unwrap_or_default();
            CoTaskMemFree(Some(text.0.cast_const().cast()));
            let Ok(point) = view.GetItemPosition(pidl.0) else {
                continue;
            };
            out.push((pidl, name, point));
            if out.len() >= 2000 {
                break;
            }
        }
    }
    Ok(out)
}

/// Liest Namen und Positionen aller Desktop-Symbole (verändert nichts).
///
/// # Errors
/// Desktop nicht erreichbar.
pub fn read_icons() -> io::Result<Vec<DesktopIcon>> {
    let _com = Com::init();
    let view = desktop_view()?;
    Ok(items(&view)?
        .into_iter()
        .map(|(_, name, p)| DesktopIcon {
            name,
            x: p.x,
            y: p.y,
        })
        .collect())
}

/// Setzt die Symbole mit passendem Namen an die gespeicherten Stellen und liefert die
/// Positionen davor (für „Rückgängig“). Ist „Automatisch anordnen“ an, wird nichts verändert.
///
/// # Errors
/// Desktop nicht erreichbar oder automatisches Anordnen an.
pub fn apply_icons(target: &[DesktopIcon]) -> io::Result<Vec<DesktopIcon>> {
    let _com = Com::init();
    let view = desktop_view()?;
    // SAFETY: Rohaufruf der Schnittstelle, um S_OK (an) von S_FALSE (aus) zu unterscheiden.
    // aegis-unsafe: winffi-desktop-auto-arrange
    #[allow(unsafe_code)]
    let auto = unsafe { (Interface::vtable(&view).GetAutoArrange)(Interface::as_raw(&view)) };
    if auto == S_OK {
        return Err(io::Error::other(
            "„Automatisch anordnen“ ist an – bitte im Desktop-Kontextmenü ausschalten.",
        ));
    }
    let current = items(&view)?;
    let previous: Vec<DesktopIcon> = current
        .iter()
        .map(|(_, name, p)| DesktopIcon {
            name: name.clone(),
            x: p.x,
            y: p.y,
        })
        .collect();
    let mut pidls: Vec<*const ITEMIDLIST> = Vec::new();
    let mut points: Vec<POINT> = Vec::new();
    for (pidl, name, _) in &current {
        if let Some(t) = target.iter().find(|t| &t.name == name) {
            pidls.push(pidl.0.cast_const());
            points.push(POINT { x: t.x, y: t.y });
        }
    }
    if pidls.is_empty() {
        return Ok(previous);
    }
    // SAFETY: `pidls` und `points` gleich lang, alle Item-IDs leben in `current` bis nach dem
    // Aufruf; nur Positionieren (SVSI_POSITIONITEM).
    // aegis-unsafe: winffi-desktop-position
    #[allow(unsafe_code)]
    // Setzt Desktop-Symbole – nur aus einer freigegebenen Werkzeug-Vorschau (bzw. Rückgängig).
    // aegis-mutation: winffi-desktop-position-call
    #[allow(clippy::disallowed_methods)]
    let placed = unsafe {
        view.SelectAndPositionItems(
            u32::try_from(pidls.len()).unwrap_or(0),
            pidls.as_ptr(),
            Some(points.as_ptr()),
            SVSI_POSITIONITEM.0 as u32,
        )
    };
    placed.map_err(|e| err(&e))?;
    Ok(previous)
}
