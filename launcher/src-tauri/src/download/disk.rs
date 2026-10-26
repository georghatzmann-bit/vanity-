//! Facts about the download folder and its drive (Windows API), and the default folder.
//! The rules that use these facts are in `niobium_core::epic::folder` (tested there).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use niobium_core::epic::folder::{DriveKind, FolderFacts, VolumeFacts};
use niobium_core::epic::journal;

fn env_dirs(names: &[&str]) -> Vec<PathBuf> {
    names.iter().filter_map(std::env::var_os).filter(|v| !v.is_empty()).map(PathBuf::from).collect()
}

/// Everything `check_folder` needs to know about a folder.
pub fn folder_facts(folder: &Path, own_dirs: Vec<PathBuf>) -> FolderFacts {
    let journal_key = journal::read_job(folder).map(|j| j.key);
    let has_other_files = fs::read_dir(folder)
        .map(|rd| rd.flatten().any(|e| e.file_name() != journal::STATE_DIR))
        .unwrap_or(false);
    FolderFacts {
        folder: folder.to_path_buf(),
        volume: volume_facts(folder),
        has_other_files,
        journal_key,
        onedrive_roots: env_dirs(&["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]),
        protected_roots: env_dirs(&["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "SystemRoot", "windir"]),
        own_dirs,
    }
}

/// Creates the folder (if needed) and writes + deletes a tiny test file.
/// Returns the folders this call created, deepest first (e.g. `…\Builds\<key>`, `…\Builds`,
/// `D:\Niobium`), so they can be removed again if the download stops before writing anything.
pub fn write_probe(folder: &Path) -> io::Result<Vec<PathBuf>> {
    let created: Vec<PathBuf> = folder
        .ancestors()
        .take_while(|p| !p.as_os_str().is_empty() && !p.exists())
        .map(Path::to_path_buf)
        .collect();
    let result = (|| {
        fs::create_dir_all(folder)?;
        let probe = folder.join(".niobium-write-test");
        fs::write(&probe, b"ok")?;
        fs::remove_file(&probe)
    })();
    match result {
        Ok(()) => Ok(created),
        Err(e) => {
            remove_empty_dirs(&created);
            Err(e)
        }
    }
}

/// Removes these folders (deepest first) if they are empty; anything with files in it stays.
pub fn remove_empty_dirs(deepest_first: &[PathBuf]) {
    for d in deepest_first {
        let _ = fs::remove_dir(d);
    }
}

#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn until_nul(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// Kind of a drive root like `D:\`. Doesn't touch the media, so an empty card reader or DVD
/// drive never brings up "There is no disk in the drive".
#[cfg(windows)]
fn drive_kind(root: &str) -> DriveKind {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDriveTypeW;
    let root_w = wide(root);
    // SAFETY: root_w is NUL-terminated and lives for the call.
    match unsafe { GetDriveTypeW(PCWSTR(root_w.as_ptr())) } {
        2 => DriveKind::Removable,
        3 => DriveKind::Fixed,
        4 => DriveKind::Network,
        _ => DriveKind::Other,
    }
}

/// Free space, file system and kind of a drive root like `D:\` (Windows API).
#[cfg(windows)]
fn drive_info(root: &str) -> Option<VolumeFacts> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetVolumeInformationW};
    let kind = drive_kind(root);
    let root_w = wide(root);
    let mut free = 0u64;
    // SAFETY: root_w is NUL-terminated and lives for the call; `free` is a valid out pointer.
    unsafe { GetDiskFreeSpaceExW(PCWSTR(root_w.as_ptr()), Some(&mut free as *mut u64), None, None) }.ok()?;
    let mut fs_name = [0u16; 64];
    // SAFETY: as above; the name buffer is a valid slice.
    let _ = unsafe { GetVolumeInformationW(PCWSTR(root_w.as_ptr()), None, None, None, None, Some(&mut fs_name)) };
    let letter = {
        let b = root.as_bytes();
        if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
            root[..2].to_ascii_uppercase()
        } else {
            String::new()
        }
    };
    Some(VolumeFacts { letter, free_bytes: free, file_system: until_nul(&fs_name), kind })
}

#[cfg(windows)]
fn volume_facts(folder: &Path) -> Option<VolumeFacts> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetVolumePathNameW;
    // the download folder may not exist yet: ask about its nearest existing parent
    let existing = folder.ancestors().find(|p| p.exists())?;
    let path_w = wide(&existing.to_string_lossy());
    let mut root = [0u16; 512];
    // SAFETY: path_w is NUL-terminated; `root` is a valid buffer.
    unsafe { GetVolumePathNameW(PCWSTR(path_w.as_ptr()), &mut root) }.ok()?;
    drive_info(&until_nul(&root))
}

#[cfg(not(windows))]
fn volume_facts(_folder: &Path) -> Option<VolumeFacts> {
    None
}

/// `<fixed drive with the most free space>:\Niobium\Builds\<key>` (FAT drives are skipped).
#[cfg(windows)]
pub fn default_folder(key: &str) -> PathBuf {
    use windows::Win32::Storage::FileSystem::GetLogicalDrives;
    // SAFETY: no arguments.
    let mask = unsafe { GetLogicalDrives() };
    let best = (0..26u8)
        .filter(|i| mask & (1 << i) != 0)
        .map(|i| format!("{}:\\", (b'A' + i) as char))
        // only fixed drives are asked for their space (removable/optical ones may have no media)
        .filter(|root| drive_kind(root) == DriveKind::Fixed)
        .filter_map(|root| drive_info(&root))
        .filter(|v| !v.file_system.to_ascii_uppercase().starts_with("FAT"))
        .max_by_key(|v| v.free_bytes);
    let letter = best.map(|v| v.letter).unwrap_or_else(|| "C:".into());
    PathBuf::from(format!("{letter}\\")).join("Niobium").join("Builds").join(key)
}

#[cfg(not(windows))]
pub fn default_folder(key: &str) -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join("Niobium").join("Builds").join(key)
}
