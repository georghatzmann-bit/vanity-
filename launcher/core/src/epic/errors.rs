//! Error codes and plain-English texts of the build downloader (shown to the user as they are).

use serde::Serialize;

/// `{ code, message }` – the payload of `download:error` and of a refused `download_start`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DownloadError {
    pub code: String,
    pub message: String,
}

pub const MANIFEST_UNAVAILABLE: &str = "MANIFEST_UNAVAILABLE";
pub const MANIFEST_MISMATCH: &str = "MANIFEST_MISMATCH";
pub const CHUNKS_MISSING: &str = "CHUNKS_MISSING";
pub const EPIC_BLOCKED: &str = "EPIC_BLOCKED";
pub const NETWORK: &str = "NETWORK";
pub const NOT_ENOUGH_SPACE: &str = "NOT_ENOUGH_SPACE";
pub const FAT32: &str = "FAT32";
pub const ONEDRIVE: &str = "ONEDRIVE";
pub const NOT_EMPTY: &str = "NOT_EMPTY";
pub const WRITE_FAILED: &str = "WRITE_FAILED";
pub const VERIFY_FAILED: &str = "VERIFY_FAILED";
pub const IMPORT_FAILED: &str = "IMPORT_FAILED";
// Not in the first table, needed for the folder rules and the job list:
pub const NETWORK_DRIVE: &str = "NETWORK_DRIVE";
pub const PATH_TOO_LONG: &str = "PATH_TOO_LONG";
pub const OWN_FOLDER: &str = "OWN_FOLDER";
pub const ALREADY_RUNNING: &str = "ALREADY_RUNNING";
pub const ANOTHER_RUNNING: &str = "ANOTHER_RUNNING";
pub const UNKNOWN_BUILD: &str = "UNKNOWN_BUILD";

/// Shown while a damaged file is downloaded again (not an error yet – goes to the live log).
pub const TEXT_VERIFY_RETRY: &str = "A downloaded file was damaged and is being downloaded again.";

fn err(code: &str, message: impl Into<String>) -> DownloadError {
    DownloadError { code: code.into(), message: message.into() }
}

/// "drive D:" or "this drive" when the letter is unknown.
fn drive_words(drive: &str) -> String {
    if drive.is_empty() {
        "this drive".into()
    } else {
        format!("drive {drive}")
    }
}

impl DownloadError {
    pub fn manifest_unavailable() -> Self {
        err(
            MANIFEST_UNAVAILABLE,
            "Niobium couldn't get the file list for this version. Check your internet connection and try again later.",
        )
    }

    pub fn manifest_mismatch() -> Self {
        err(
            MANIFEST_MISMATCH,
            "The file list for this version isn't what Niobium expects, so nothing was downloaded. Please update Niobium.",
        )
    }

    pub fn chunks_missing() -> Self {
        err(
            CHUNKS_MISSING,
            "Epic no longer has all the files for this version, so it can't be downloaded. Nothing was downloaded. Pick another version, or add a copy you already have with 'Add a build'.",
        )
    }

    pub fn epic_blocked() -> Self {
        err(
            EPIC_BLOCKED,
            "Epic's download servers refused the download. Nothing is wrong with your PC. Please try again later.",
        )
    }

    pub fn network() -> Self {
        err(
            NETWORK,
            "The connection to Epic's download servers dropped. Press Resume and Niobium continues where it stopped.",
        )
    }

    /// `drive` like "D:" (empty if unknown), sizes in bytes.
    pub fn not_enough_space(drive: &str, need: u64, free: u64) -> Self {
        let words = drive_words(drive);
        err(
            NOT_ENOUGH_SPACE,
            format!(
                "There isn't enough free space on {words}. This version needs {} and {} is free. Free up space or pick another folder.",
                super::gb(need),
                super::gb(free)
            ),
        )
    }

    pub fn fat32(drive: &str) -> Self {
        let start = if drive.is_empty() { "This drive".to_string() } else { format!("Drive {drive}") };
        err(FAT32, format!("{start} can't hold files bigger than 4 GB (FAT32). Pick a folder on another drive."))
    }

    pub fn onedrive() -> Self {
        err(
            ONEDRIVE,
            "This folder is synced by OneDrive. Pick a folder outside OneDrive, or it will try to upload the whole game (up to about 120 GB).",
        )
    }

    pub fn not_empty() -> Self {
        err(NOT_EMPTY, "This folder already has other files in it. Pick an empty folder.")
    }

    pub fn write_failed() -> Self {
        err(WRITE_FAILED, "Niobium can't write to this folder. Pick another one (not inside Program Files).")
    }

    /// A file was still damaged after it was downloaded a second time.
    pub fn verify_failed() -> Self {
        err(VERIFY_FAILED, "A downloaded file was still damaged. Please try again later.")
    }

    pub fn import_failed() -> Self {
        err(IMPORT_FAILED, "The download finished, but Niobium couldn't recognise the version in the folder.")
    }

    pub fn network_drive() -> Self {
        err(NETWORK_DRIVE, "This folder is on a network drive. Pick a folder on a drive inside your PC.")
    }

    pub fn path_too_long() -> Self {
        err(PATH_TOO_LONG, "This folder's path is too long. Pick a shorter one, like D:\\Niobium\\Builds.")
    }

    pub fn own_folder() -> Self {
        err(OWN_FOLDER, "This folder belongs to Niobium itself. Pick another one.")
    }

    pub fn already_running() -> Self {
        err(ALREADY_RUNNING, "This version is already downloading.")
    }

    pub fn another_running() -> Self {
        err(ANOTHER_RUNNING, "Another version is downloading. Pause it first, then start this one.")
    }

    pub fn unknown_build() -> Self {
        err(UNKNOWN_BUILD, "Niobium can't download this version.")
    }

    /// The same error when files of the build are already in the folder (it has a journal):
    /// no "nothing was downloaded", and a write error in the middle of a download is something
    /// Resume can fix (a full disk, a program locking a file) – not a reason to pick a new folder.
    pub fn after_files_written(self) -> Self {
        match self.code.as_str() {
            CHUNKS_MISSING => err(
                CHUNKS_MISSING,
                "Epic no longer has all the files for this version, so the download can't be finished. Remove it to free the space, then pick another version or add a copy you already have with 'Add a build'.",
            ),
            MANIFEST_MISMATCH => err(
                MANIFEST_MISMATCH,
                "The file list for this version isn't what Niobium expects, so the download can't go on. Please update Niobium.",
            ),
            WRITE_FAILED => err(
                WRITE_FAILED,
                "Niobium couldn't write to the download folder. Free up space on the drive or close programs that use the folder, then press Resume.",
            ),
            _ => self,
        }
    }
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn texts_match_the_plan() {
        assert_eq!(
            DownloadError::not_enough_space("D:", 45_400_000_000, 12_300_000_000).message,
            "There isn't enough free space on drive D:. This version needs 45.4 GB and 12.3 GB is free. Free up space or pick another folder."
        );
        assert_eq!(
            DownloadError::fat32("E:").message,
            "Drive E: can't hold files bigger than 4 GB (FAT32). Pick a folder on another drive."
        );
        assert_eq!(DownloadError::fat32("").message, "This drive can't hold files bigger than 4 GB (FAT32). Pick a folder on another drive.");
        assert!(DownloadError::not_enough_space("", 1, 0).message.starts_with("There isn't enough free space on this drive."));
        // true for every build in the list: the biggest one (30.10) is about 120 GB on disk
        assert_eq!(DownloadError::onedrive().message, "This folder is synced by OneDrive. Pick a folder outside OneDrive, or it will try to upload the whole game (up to about 120 GB).");
        assert_eq!(DownloadError::chunks_missing().code, "CHUNKS_MISSING");
        let json = serde_json::to_value(DownloadError::network()).unwrap();
        assert_eq!(json["code"], "NETWORK");
        assert_eq!(
            json["message"],
            "The connection to Epic's download servers dropped. Press Resume and Niobium continues where it stopped."
        );
    }

    #[test]
    fn texts_after_files_were_written() {
        for e in [DownloadError::chunks_missing(), DownloadError::manifest_mismatch()] {
            let after = e.clone().after_files_written();
            assert_eq!(after.code, e.code);
            assert!(!after.message.to_lowercase().contains("nothing was downloaded"), "{}", after.message);
        }
        let w = DownloadError::write_failed().after_files_written();
        assert_eq!(w.code, WRITE_FAILED);
        assert!(w.message.contains("press Resume") && !w.message.contains("Program Files"));
        // everything else stays as it is
        assert_eq!(DownloadError::network().after_files_written(), DownloadError::network());
        assert_eq!(DownloadError::verify_failed().after_files_written(), DownloadError::verify_failed());
    }
}
