//! Allgemeine App-Infos für die Oberfläche.

use tauri::State;

use crate::error::CmdResult;
use crate::models::AppInfo;
use crate::state::Shared;
use crate::util::display_path;

/// Läuft Pulsar gerade mit Adminrechten?
pub fn is_elevated() -> bool {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Foundation::{CloseHandle, HANDLE};
        use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
        use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut core::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok && elevation.TokenIsElevated != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[tauri::command]
pub async fn app_info(state: State<'_, Shared>) -> CmdResult<AppInfo> {
    let platform = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    Ok(AppInfo {
        version: crate::config::config().version.clone(),
        data_dir: display_path(&state.paths.data_dir),
        cache_dir: display_path(&state.paths.cache_dir),
        platform: platform.into(),
        started_minimized: state.started_minimized,
        is_admin: is_elevated(),
    })
}
