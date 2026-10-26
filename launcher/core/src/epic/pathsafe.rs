//! Checks the file paths that come from a manifest before anything is written.
//!
//! A manifest is data from the internet (pinned by SHA-1, but still): a path must never leave the
//! build folder, name a drive, a device (`CON`, `NUL`, …) or an NTFS stream, and the full path must
//! stay short enough for Fortnite.

use std::path::{Path, PathBuf};

/// Longest build folder path (characters) the downloader accepts. The longest path inside a
/// Fortnite manifest is 106 characters, so this keeps the full path well below 248.
pub const MAX_ROOT_CHARS: usize = 100;

/// Longest full path (build folder + file path) that is written.
pub const MAX_PATH_CHARS: usize = 240;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathError {
    Empty,
    Absolute,
    /// `C:…` or `file:stream`
    DriveOrStream,
    /// `.` or `..` as a folder name
    DotFolder,
    /// empty folder name (`a//b`), or a name ending in a dot or space
    BadName(String),
    BadChar(char),
    /// `CON`, `NUL`, `COM1`, … (Windows device names)
    DeviceName(String),
    TooLong(usize),
}

impl std::fmt::Display for PathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PathError::Empty => write!(f, "empty path"),
            PathError::Absolute => write!(f, "absolute path"),
            PathError::DriveOrStream => write!(f, "path with ':'"),
            PathError::DotFolder => write!(f, "path with '.' or '..'"),
            PathError::BadName(n) => write!(f, "bad name '{n}'"),
            PathError::BadChar(c) => write!(f, "bad character {c:?}"),
            PathError::DeviceName(n) => write!(f, "device name '{n}'"),
            PathError::TooLong(n) => write!(f, "path too long ({n} characters)"),
        }
    }
}

const BAD_CHARS: &[char] = &['<', '>', '"', '|', '?', '*'];
const DEVICE_NAMES: &[&str] = &["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"];

fn is_device_name(component: &str) -> bool {
    let base = component.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    if DEVICE_NAMES.contains(&base.as_str()) {
        return true;
    }
    // COM0–COM9, LPT0–LPT9 (also with superscript digits, which Windows treats the same)
    let mut chars = base.chars();
    let prefix: String = chars.by_ref().take(3).collect();
    let rest: String = chars.collect();
    (prefix == "COM" || prefix == "LPT")
        && rest.chars().count() == 1
        && rest.chars().all(|c| c.is_ascii_digit() || matches!(c, '¹' | '²' | '³'))
}

/// Checks a relative path from a manifest ("FortniteGame/Content/Paks/x.pak") and returns its
/// folder/file names. `/` and `\` both count as separators.
pub fn check_relative(rel: &str) -> Result<Vec<&str>, PathError> {
    if rel.is_empty() {
        return Err(PathError::Empty);
    }
    if rel.starts_with('/') || rel.starts_with('\\') {
        return Err(PathError::Absolute);
    }
    if rel.contains(':') {
        return Err(PathError::DriveOrStream);
    }
    if let Some(c) = rel.chars().find(|c| (*c as u32) < 0x20 || BAD_CHARS.contains(c)) {
        return Err(PathError::BadChar(c));
    }
    let parts: Vec<&str> = rel.split(['/', '\\']).collect();
    for part in &parts {
        if *part == "." || *part == ".." {
            return Err(PathError::DotFolder);
        }
        if part.is_empty() || part.ends_with('.') || part.ends_with(' ') {
            return Err(PathError::BadName((*part).to_string()));
        }
        if is_device_name(part) {
            return Err(PathError::DeviceName((*part).to_string()));
        }
    }
    Ok(parts)
}

/// `root` + the checked relative path. Refuses paths that would get too long.
pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, PathError> {
    let parts = check_relative(rel)?;
    let total = root.to_string_lossy().chars().count() + 1 + rel.chars().count();
    if total > MAX_PATH_CHARS {
        return Err(PathError::TooLong(total));
    }
    let mut out = root.to_path_buf();
    for p in parts {
        out.push(p);
    }
    Ok(out)
}

/// True if a build folder path is longer than [`MAX_ROOT_CHARS`].
pub fn root_too_long(root: &Path) -> bool {
    root.to_string_lossy().chars().count() > MAX_ROOT_CHARS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_paths_pass() {
        assert_eq!(
            check_relative("FortniteGame/Content/Paks/pakchunk0-WindowsClient.pak").unwrap(),
            vec!["FortniteGame", "Content", "Paks", "pakchunk0-WindowsClient.pak"]
        );
        assert!(check_relative("Engine\\Binaries\\ThirdParty\\x.dll").is_ok());
        assert!(check_relative("FortniteGame/Binaries/Win64/FortniteClient-Win64-Shipping.exe").is_ok());
        assert!(check_relative("a/.hidden/file").is_ok());
        assert!(check_relative("Console/conout.txt").is_ok());
        assert!(check_relative("COM10.txt").is_ok());
    }

    #[test]
    fn bad_paths_fail() {
        assert_eq!(check_relative(""), Err(PathError::Empty));
        assert_eq!(check_relative("/etc/passwd"), Err(PathError::Absolute));
        assert_eq!(check_relative("\\Windows\\x"), Err(PathError::Absolute));
        assert_eq!(check_relative("C:/Windows/x"), Err(PathError::DriveOrStream));
        assert_eq!(check_relative("a/b.pak:stream"), Err(PathError::DriveOrStream));
        assert_eq!(check_relative("../x"), Err(PathError::DotFolder));
        assert_eq!(check_relative("a/../../x"), Err(PathError::DotFolder));
        assert_eq!(check_relative("a/./x"), Err(PathError::DotFolder));
        assert_eq!(check_relative("a//x"), Err(PathError::BadName(String::new())));
        assert_eq!(check_relative("a/"), Err(PathError::BadName(String::new())));
        assert_eq!(check_relative("a./x"), Err(PathError::BadName("a.".into())));
        assert_eq!(check_relative("a /x"), Err(PathError::BadName("a ".into())));
        assert_eq!(check_relative("a/b?c"), Err(PathError::BadChar('?')));
        assert_eq!(check_relative("a/b\0c"), Err(PathError::BadChar('\0')));
        assert_eq!(check_relative("a/NUL"), Err(PathError::DeviceName("NUL".into())));
        assert_eq!(check_relative("con.txt"), Err(PathError::DeviceName("con.txt".into())));
        assert_eq!(check_relative("x/LPT1.log"), Err(PathError::DeviceName("LPT1.log".into())));
        assert_eq!(check_relative("x/com3"), Err(PathError::DeviceName("com3".into())));
    }

    #[test]
    fn join_and_length() {
        let root = Path::new("D:/Niobium/Builds/18.30-CL-17882303");
        let p = safe_join(root, "FortniteGame/Content/Paks/a.pak").unwrap();
        assert!(p.ends_with("FortniteGame/Content/Paks/a.pak"));
        assert!(p.starts_with(root));
        let long_root = PathBuf::from(format!("D:/{}", "x".repeat(150)));
        assert!(matches!(safe_join(&long_root, "y/".repeat(50).trim_end_matches('/')), Err(PathError::TooLong(_))));
        assert!(root_too_long(&long_root));
        assert!(!root_too_long(root));
        // the longest real path (106 characters) fits under the longest allowed root
        let max_root = PathBuf::from("D".repeat(MAX_ROOT_CHARS));
        assert!(safe_join(&max_root, &"z".repeat(106)).is_ok());
    }
}
