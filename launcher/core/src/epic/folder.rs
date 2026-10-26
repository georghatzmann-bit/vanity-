//! Rules for the folder a build is downloaded into. The facts about the drive are gathered by the
//! launcher (Windows API, see `src-tauri/src/download/disk.rs`); the rules here are plain code so
//! they can be tested with made-up drives.

use std::path::{Component, Path, PathBuf};

use super::errors::DownloadError;
use super::pathsafe;

/// Kept free on top of the remaining file bytes.
pub const SPACE_RESERVE: u64 = 2 << 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriveKind {
    Fixed,
    Removable,
    Network,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VolumeFacts {
    /// "D:" (empty if the drive has no letter)
    pub letter: String,
    pub free_bytes: u64,
    /// "NTFS", "exFAT", "FAT32", …
    pub file_system: String,
    pub kind: DriveKind,
}

#[derive(Debug, Clone, Default)]
pub struct FolderFacts {
    pub folder: PathBuf,
    /// None = unknown (not on Windows) – then only the path rules apply.
    pub volume: Option<VolumeFacts>,
    /// The folder exists and has something in it (besides the downloader's own state folder).
    pub has_other_files: bool,
    /// Catalog key in `job.json` of an earlier download into this folder.
    pub journal_key: Option<String>,
    /// OneDrive folders (`%OneDrive%`, `%OneDriveConsumer%`, `%OneDriveCommercial%`).
    pub onedrive_roots: Vec<PathBuf>,
    /// Program Files, Windows.
    pub protected_roots: Vec<PathBuf>,
    /// Niobium's own install folder (never downloaded into).
    pub own_dirs: Vec<PathBuf>,
}

/// Bytes the drive must have free: what is still to be written plus 2 GiB.
pub fn space_needed(remaining_bytes: u64) -> u64 {
    remaining_bytes.saturating_add(SPACE_RESERVE)
}

/// Folder names lower-case, `/` and `\` alike, without the `\\?\` prefix.
fn normalized(path: &Path) -> Vec<String> {
    let text = path.to_string_lossy().replace('\\', "/");
    let text = text.strip_prefix("//?/").unwrap_or(&text).to_string();
    Path::new(&text)
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().to_lowercase()),
            Component::Prefix(p) => Some(p.as_os_str().to_string_lossy().to_lowercase()),
            Component::RootDir | Component::CurDir => None,
            Component::ParentDir => Some("..".into()),
        })
        .flat_map(|s| s.split('/').filter(|x| !x.is_empty()).map(str::to_string).collect::<Vec<_>>())
        .collect()
}

/// True if `path` is `root` or inside it (Windows rules: case doesn't matter).
pub fn is_inside(path: &Path, root: &Path) -> bool {
    let p = normalized(path);
    let r = normalized(root);
    !r.is_empty() && p.len() >= r.len() && p[..r.len()] == r[..]
}

fn looks_like_onedrive(path: &Path) -> bool {
    normalized(path).iter().any(|c| c == "onedrive" || c.starts_with("onedrive - "))
}

fn is_unc(path: &Path) -> bool {
    let text = path.to_string_lossy().replace('\\', "/");
    (text.starts_with("//") && !text.starts_with("//?/") && !text.starts_with("//./")) || text.to_lowercase().starts_with("//?/unc/")
}

/// Checks a download folder for `key`. `need_bytes` = [`space_needed`] of what's left to write.
pub fn check_folder(facts: &FolderFacts, key: &str, need_bytes: u64) -> Result<(), DownloadError> {
    let folder = &facts.folder;
    if pathsafe::root_too_long(folder) {
        return Err(DownloadError::path_too_long());
    }
    if facts.own_dirs.iter().any(|d| is_inside(folder, d)) {
        return Err(DownloadError::own_folder());
    }
    if facts.protected_roots.iter().any(|d| is_inside(folder, d)) {
        return Err(DownloadError::write_failed());
    }
    if facts.onedrive_roots.iter().any(|d| is_inside(folder, d)) || looks_like_onedrive(folder) {
        return Err(DownloadError::onedrive());
    }
    if is_unc(folder) || facts.volume.as_ref().is_some_and(|v| v.kind == DriveKind::Network) {
        return Err(DownloadError::network_drive());
    }
    if let Some(v) = &facts.volume {
        let fs = v.file_system.to_ascii_uppercase();
        if fs == "FAT" || fs == "FAT32" || fs == "FAT16" {
            return Err(DownloadError::fat32(&v.letter));
        }
    }
    let ours = facts.journal_key.as_deref() == Some(key);
    if facts.has_other_files && !ours {
        return Err(DownloadError::not_empty());
    }
    if facts.journal_key.is_some() && !ours {
        return Err(DownloadError::not_empty());
    }
    if let Some(v) = &facts.volume {
        if v.free_bytes < need_bytes {
            return Err(DownloadError::not_enough_space(&v.letter, need_bytes, v.free_bytes));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::epic::errors;

    fn drive(fs: &str, free: u64, kind: DriveKind) -> Option<VolumeFacts> {
        Some(VolumeFacts { letter: "D:".into(), free_bytes: free, file_system: fs.into(), kind })
    }

    fn facts(folder: &str) -> FolderFacts {
        FolderFacts {
            folder: folder.into(),
            volume: drive("NTFS", 500_000_000_000, DriveKind::Fixed),
            onedrive_roots: vec![r"C:\Users\Georg\OneDrive".into()],
            protected_roots: vec![r"C:\Program Files".into(), r"C:\Program Files (x86)".into(), r"C:\Windows".into()],
            own_dirs: vec![r"C:\Users\Georg\AppData\Local\Niobium".into()],
            ..FolderFacts::default()
        }
    }

    const KEY: &str = "18.30-CL-17882303";
    const NEED: u64 = 45_400_000_000;

    fn code(r: Result<(), DownloadError>) -> String {
        r.err().map(|e| e.code).unwrap_or_default()
    }

    #[test]
    fn a_good_folder_passes() {
        assert!(check_folder(&facts(r"D:\Niobium\Builds\18.30-CL-17882303"), KEY, NEED).is_ok());
        assert!(check_folder(&facts(r"D:\Games\Fortnite 18.30"), KEY, NEED).is_ok());
        // exFAT can hold big files
        let mut f = facts(r"E:\Builds\18.30");
        f.volume = drive("exFAT", 900_000_000_000, DriveKind::Removable);
        assert!(check_folder(&f, KEY, NEED).is_ok());
    }

    #[test]
    fn space() {
        let mut f = facts(r"D:\Niobium\Builds\18.30");
        f.volume = drive("NTFS", 12_300_000_000, DriveKind::Fixed);
        let e = check_folder(&f, KEY, NEED).unwrap_err();
        assert_eq!(e.code, errors::NOT_ENOUGH_SPACE);
        assert_eq!(
            e.message,
            "There isn't enough free space on drive D:. This version needs 45.4 GB and 12.3 GB is free. Free up space or pick another folder."
        );
        assert_eq!(space_needed(10), 10 + (2 << 30));
    }

    #[test]
    fn fat32_and_network() {
        let mut f = facts(r"E:\Builds");
        f.volume = Some(VolumeFacts { letter: "E:".into(), free_bytes: u64::MAX, file_system: "FAT32".into(), kind: DriveKind::Removable });
        let e = check_folder(&f, KEY, NEED).unwrap_err();
        assert_eq!(e.code, errors::FAT32);
        assert!(e.message.starts_with("Drive E: can't hold files bigger than 4 GB"));
        let mut f = facts(r"Z:\Builds");
        f.volume = drive("NTFS", u64::MAX, DriveKind::Network);
        assert_eq!(code(check_folder(&f, KEY, NEED)), errors::NETWORK_DRIVE);
        let mut f = facts(r"\\nas\games\18.30");
        f.volume = None;
        assert_eq!(code(check_folder(&f, KEY, NEED)), errors::NETWORK_DRIVE);
        let mut f = facts(r"\\?\UNC\nas\games\18.30");
        f.volume = None;
        assert_eq!(code(check_folder(&f, KEY, NEED)), errors::NETWORK_DRIVE);
    }

    #[test]
    fn onedrive_program_files_and_own_folder() {
        assert_eq!(code(check_folder(&facts(r"C:\Users\Georg\OneDrive\Builds"), KEY, NEED)), errors::ONEDRIVE);
        assert_eq!(code(check_folder(&facts(r"c:\users\georg\onedrive"), KEY, NEED)), errors::ONEDRIVE);
        assert_eq!(code(check_folder(&facts(r"C:\Users\Georg\OneDrive - Firma\x"), KEY, NEED)), errors::ONEDRIVE);
        assert_eq!(code(check_folder(&facts(r"C:\Program Files\Fortnite"), KEY, NEED)), errors::WRITE_FAILED);
        assert_eq!(code(check_folder(&facts(r"C:\Program Files (x86)\x"), KEY, NEED)), errors::WRITE_FAILED);
        assert_eq!(code(check_folder(&facts(r"C:\Windows\Temp\x"), KEY, NEED)), errors::WRITE_FAILED);
        // "Program Files Games" is not "Program Files"
        assert!(check_folder(&facts(r"C:\Program Files Games\x"), KEY, NEED).is_ok());
        assert_eq!(code(check_folder(&facts(r"C:\Users\Georg\AppData\Local\Niobium\Builds"), KEY, NEED)), errors::OWN_FOLDER);
        assert_eq!(code(check_folder(&facts(r"C:\Users\Georg\AppData\Local\Niobium"), KEY, NEED)), errors::OWN_FOLDER);
        assert!(check_folder(&facts(r"C:\Users\Georg\AppData\Local\NiobiumBuilds"), KEY, NEED).is_ok());
    }

    #[test]
    fn non_empty_folders() {
        let mut f = facts(r"D:\Stuff");
        f.has_other_files = true;
        assert_eq!(code(check_folder(&f, KEY, NEED)), errors::NOT_EMPTY);
        // our own unfinished download of the same build: continue there
        f.journal_key = Some(KEY.into());
        assert!(check_folder(&f, KEY, NEED).is_ok());
        // an unfinished download of another build
        f.journal_key = Some("18.20-CL-17745267".into());
        assert_eq!(code(check_folder(&f, KEY, NEED)), errors::NOT_EMPTY);
        f.has_other_files = false;
        assert_eq!(code(check_folder(&f, KEY, NEED)), errors::NOT_EMPTY);
    }

    #[test]
    fn long_paths() {
        let long = format!(r"D:\{}", "a".repeat(120));
        assert_eq!(code(check_folder(&facts(&long), KEY, NEED)), errors::PATH_TOO_LONG);
    }

    #[test]
    fn inside() {
        assert!(is_inside(Path::new(r"C:\A\b\c"), Path::new("c:/a")));
        assert!(is_inside(Path::new(r"\\?\C:\A\b"), Path::new(r"C:\a")));
        assert!(!is_inside(Path::new(r"C:\Ab"), Path::new(r"C:\A")));
        assert!(!is_inside(Path::new(r"C:\A"), Path::new("")));
    }
}
