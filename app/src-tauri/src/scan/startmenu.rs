//! Startmenü-Verknüpfungen (`.lnk`) aus `%ProgramData%` und `%APPDATA%`.

use crate::models::{GameKind, ScannedEntry};
use crate::tracker::normalize_path;

/// Ergebnis einer aufgelösten Verknüpfung.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LnkInfo {
    pub target: String,
    pub args: String,
    pub work_dir: String,
}

/// Verknüpfungen zu Deinstallern, Handbüchern, Webseiten usw. überspringen.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn is_excluded_name(name: &str) -> bool {
    const WORDS: [&str; 16] = [
        "uninstall",
        "deinstall",
        "readme",
        "read me",
        "help",
        "manual",
        "website",
        "documentation",
        "support",
        "license",
        "update",
        "hilfe",
        "handbuch",
        "lizenz",
        "webseite",
        "entfernen",
    ];
    let l = name.to_lowercase();
    WORDS.iter().any(|w| l.contains(w))
}

/// Spiel oder Programm? Anhand typischer Spiele-Ordner im Zielpfad.
pub fn classify_kind(target: &str) -> GameKind {
    let l = target.to_lowercase().replace('/', "\\");
    if l.contains("steamapps")
        || l.contains("epic games")
        || l.contains("gog games")
        || l.contains("gog galaxy\\games")
        || l.contains("\\games\\")
        || l.contains("xboxgames")
    {
        GameKind::Game
    } else {
        GameKind::App
    }
}

/// Liegt das Ziel im Windows-Ordner (Systemprogramme)?
#[cfg_attr(not(windows), allow(dead_code))]
pub fn is_system_target(target: &str) -> bool {
    let t = normalize_path(target);
    let windir = std::env::var("WINDIR")
        .or_else(|_| std::env::var("SystemRoot"))
        .map(|w| normalize_path(&w))
        .unwrap_or_else(|_| "c:/windows".into());
    t == windir || t.starts_with(&format!("{windir}/"))
}

#[cfg(windows)]
pub use win::{resolve_lnk, ComGuard};

#[cfg(windows)]
mod win {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, STGM_READ,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    use super::LnkInfo;

    /// COM für den aktuellen Thread initialisieren (und beim Verlassen wieder freigeben).
    pub struct ComGuard(bool);

    impl ComGuard {
        pub fn new() -> Self {
            let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
            // S_OK oder S_FALSE → später freigeben; RPC_E_CHANGED_MODE → bereits anders initialisiert
            ComGuard(hr.is_ok())
        }
    }

    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    fn from_wide(buf: &[u16]) -> String {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end]).trim().to_string()
    }

    /// `.lnk` über `IShellLinkW` auflösen (Ziel, Argumente, Arbeitsordner).
    /// Setzt eine COM-Initialisierung auf dem aktuellen Thread voraus (siehe [`ComGuard`]).
    pub fn resolve_lnk(path: &Path) -> Option<LnkInfo> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
            let persist: IPersistFile = link.cast().ok()?;
            persist.Load(PCWSTR(wide.as_ptr()), STGM_READ).ok()?;
            let mut target = vec![0u16; 2048];
            link.GetPath(&mut target, std::ptr::null_mut(), 0).ok()?;
            let mut args = vec![0u16; 4096];
            let _ = link.GetArguments(&mut args);
            let mut wd = vec![0u16; 2048];
            let _ = link.GetWorkingDirectory(&mut wd);
            let target = crate::util::expand_env(&from_wide(&target));
            if target.is_empty() {
                return None;
            }
            Some(LnkInfo {
                target,
                args: from_wide(&args),
                work_dir: crate::util::expand_env(&from_wide(&wd)),
            })
        }
    }
}

/// Alle Startmenü-Programme finden (nur Windows).
pub fn scan(entries: &mut Vec<ScannedEntry>, messages: &mut Vec<String>) {
    #[cfg(windows)]
    {
        use crate::models::{GameSource, LaunchConfig};
        use crate::util::display_path;
        use std::path::{Path, PathBuf};

        let mut roots: Vec<PathBuf> = Vec::new();
        if let Ok(pd) = std::env::var("ProgramData") {
            roots.push(Path::new(&pd).join(r"Microsoft\Windows\Start Menu\Programs"));
        }
        if let Ok(ad) = std::env::var("APPDATA") {
            roots.push(Path::new(&ad).join(r"Microsoft\Windows\Start Menu\Programs"));
        }
        let own_exe = std::env::current_exe()
            .ok()
            .map(|p| normalize_path(&p.to_string_lossy()));
        let _com = ComGuard::new();
        let mut seen = std::collections::HashSet::new();
        let mut found = 0usize;
        for root in roots {
            for e in walkdir::WalkDir::new(&root)
                .max_depth(6)
                .into_iter()
                .filter_map(|e| e.ok())
            {
                let p = e.path();
                if !e.file_type().is_file()
                    || !p.extension().map(|x| x.eq_ignore_ascii_case("lnk")).unwrap_or(false)
                {
                    continue;
                }
                let name = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                if name.trim().is_empty() || is_excluded_name(&name) {
                    continue;
                }
                let Some(info) = resolve_lnk(p) else { continue };
                let target = Path::new(&info.target);
                if !target
                    .extension()
                    .map(|x| x.eq_ignore_ascii_case("exe"))
                    .unwrap_or(false)
                {
                    continue;
                }
                let norm = normalize_path(&info.target);
                if is_system_target(&info.target)
                    || own_exe.as_deref() == Some(norm.as_str())
                    || !target.is_file()
                    || !seen.insert(norm)
                {
                    continue;
                }
                let exe_stem = target
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                // Deinstaller (Squirrel-Apps wie Discord starten über "Update.exe" → behalten)
                if exe_stem.starts_with("unins") {
                    continue;
                }
                entries.push(ScannedEntry {
                    name: name.trim().to_string(),
                    kind: classify_kind(&info.target),
                    source: GameSource::Startmenu,
                    source_id: None,
                    launch: LaunchConfig::shell(display_path(p)),
                    install_dir: target.parent().map(display_path),
                    exe_path: Some(info.target.clone()),
                });
                found += 1;
            }
        }
        messages.push(match found {
            0 => "Startmenü: keine Programme gefunden.".into(),
            1 => "Startmenü: 1 Programm gefunden.".into(),
            n => format!("Startmenü: {n} Programme gefunden."),
        });
    }
    #[cfg(not(windows))]
    {
        let _ = entries;
        messages.push("Startmenü: nur unter Windows verfügbar.".into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excluded_names() {
        assert!(is_excluded_name("Uninstall Foo"));
        assert!(is_excluded_name("Foo Deinstallieren"));
        assert!(is_excluded_name("Foo Website"));
        assert!(is_excluded_name("ReadMe"));
        assert!(is_excluded_name("Foo Updater"));
        assert!(!is_excluded_name("Visual Studio Code"));
        assert!(!is_excluded_name("Hades"));
    }

    #[test]
    fn kind_classification() {
        assert_eq!(classify_kind(r"D:\SteamLibrary\steamapps\common\Hades\Hades.exe"), GameKind::Game);
        assert_eq!(classify_kind(r"C:\Program Files\Epic Games\Fortnite\x.exe"), GameKind::Game);
        assert_eq!(classify_kind(r"C:\GOG Games\Witcher\witcher.exe"), GameKind::Game);
        assert_eq!(classify_kind(r"E:\Games\Celeste\Celeste.exe"), GameKind::Game);
        assert_eq!(classify_kind(r"C:\Program Files\Mozilla Firefox\firefox.exe"), GameKind::App);
    }
}
