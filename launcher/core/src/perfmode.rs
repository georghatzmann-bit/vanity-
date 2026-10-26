//! Fortnite's own settings file and Bubble Builds.
//!
//! Bubble Builds start the player's game with `-FeatureLevelES31` (Performance Mode). On 15.40 – 16.00
//! and 19.x the look also needs Fortnite's "Meshes" setting on Low (`[PerformanceMode] MeshQuality=0`).
//! Both live in `%LOCALAPPDATA%\FortniteGame\Saved\Config\WindowsClient\GameUserSettings.ini`, a file
//! that every build (and live Fortnite) shares. The user allowed Niobium to change it for Bubble
//! Builds, as long as the original values come back by themselves after the game.
//!
//! So before the launch the launcher writes a backup of exactly the lines it may change (or that
//! Fortnite may change because of Performance Mode) to `%LOCALAPPDATA%\Niobium\gus-backup.json`:
//! the file path and, for each line, the line as it was or "absent", and whether its section was
//! there. Only then it sets `MeshQuality=0` (the line is added if it is missing, so the look never
//! rests on Fortnite's unknown default). After the game it puts exactly these lines back (a line
//! that was absent is removed again, and so is a section header that wasn't there and is now
//! empty) and deletes the backup. If the launcher closed or crashed during the game, the next
//! start finds the backup and does the same.
//!
//! Nothing else in the file changes: every other line, the order, the line endings and the text
//! encoding stay as they are. A file that doesn't exist is left alone, and so is a file whose bytes
//! wouldn't come back exactly after decoding (unusual encoding) or that lists one of these
//! settings (or its section) twice, since one remembered line couldn't put that back exactly.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// One `Key=Value` line in one `[Section]` of GameUserSettings.ini.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IniKey {
    pub section: &'static str,
    pub key: &'static str,
}

/// Fortnite may save Performance Mode as the default with these two lines.
pub const PREFER_ES31: IniKey = IniKey { section: "D3DRHIPreference", key: "bPreferFeatureLevelES31" };
pub const PREFERRED_FEATURE_LEVEL: IniKey = IniKey { section: "D3DRHIPreference", key: "PreferredFeatureLevel" };
/// Fortnite's "Meshes" setting in Performance Mode: 0 = Low, 1 = High.
pub const MESH_QUALITY: IniKey = IniKey { section: "PerformanceMode", key: "MeshQuality" };

/// Every line Niobium may ever back up and put back. Nothing outside this list is ever written.
pub const ALLOWED_KEYS: [IniKey; 3] = [PREFER_ES31, PREFERRED_FEATURE_LEVEL, MESH_QUALITY];

/// File name of the backup in `%LOCALAPPDATA%\Niobium`.
pub const BACKUP_FILE: &str = "gus-backup.json";
/// Format version of the backup file.
pub const BACKUP_FORMAT: u32 = 1;

/// `%LOCALAPPDATA%\FortniteGame\Saved\Config\WindowsClient\GameUserSettings.ini`
pub fn game_user_settings_path() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| {
        d.join("FortniteGame").join("Saved").join("Config").join("WindowsClient").join("GameUserSettings.ini")
    })
}

/// `%LOCALAPPDATA%\Niobium\gus-backup.json`
pub fn backup_path() -> PathBuf {
    crate::profiles::local_dir().join(BACKUP_FILE)
}

/// The lines Niobium backs up for one launch: always the two Performance Mode lines, plus
/// `MeshQuality` when the version needs Meshes on Low (15.40 – 16.00 and 19.x).
pub fn keys_for(low_meshes: bool) -> Vec<IniKey> {
    let mut keys = vec![PREFER_ES31, PREFERRED_FEATURE_LEVEL];
    if low_meshes {
        keys.push(MESH_QUALITY);
    }
    keys
}

// --- Backup file -------------------------------------------------------------------------------

/// How a line looked before the launch: the whole line, or "absent" (it wasn't in the file).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Original {
    Absent,
    Line(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedLine {
    pub section: String,
    pub key: String,
    pub original: Original,
    /// Whether its `[section]` was in the file before the launch. If not (Niobium or Fortnite added
    /// it), the header is removed again when the section is empty after the restore. Missing in the
    /// JSON = true, so a header is never removed by mistake.
    #[serde(default = "section_existed_default")]
    pub section_existed: bool,
}

fn section_existed_default() -> bool {
    true
}

/// Contents of `gus-backup.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub format: u32,
    /// Unique per launch, so a watcher never restores a newer launch's backup.
    pub id: String,
    /// The GameUserSettings.ini these lines belong to.
    pub path: PathBuf,
    pub lines: Vec<SavedLine>,
}

impl Backup {
    /// Only lines Niobium may touch, each line really is its own key, and the path is a
    /// GameUserSettings.ini. Anything else is treated as a broken backup and never applied.
    pub fn is_valid(&self) -> bool {
        let file_ok = self
            .path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.eq_ignore_ascii_case("GameUserSettings.ini"));
        file_ok
            && self.format == BACKUP_FORMAT
            && !self.lines.is_empty()
            && self.lines.iter().all(|l| {
                let allowed = allowed_key(&l.section, &l.key).is_some();
                let line_ok = match &l.original {
                    Original::Absent => true,
                    Original::Line(text) => {
                        !text.contains(['\r', '\n']) && key_of(text).is_some_and(|k| k.eq_ignore_ascii_case(&l.key))
                    }
                };
                allowed && line_ok
            })
    }

    /// Sections that weren't in the file before the launch (see [`SavedLine::section_existed`]).
    pub fn added_sections(&self) -> Vec<&'static str> {
        let mut sections: Vec<&'static str> = Vec::new();
        for line in self.lines.iter().filter(|l| !l.section_existed) {
            if let Some(key) = allowed_key(&line.section, &line.key) {
                if !sections.iter().any(|s| s.eq_ignore_ascii_case(key.section)) {
                    sections.push(key.section);
                }
            }
        }
        sections
    }

    /// The remembered lines as `(key, line or None)` for [`restore_lines`].
    pub fn wanted(&self) -> Vec<(IniKey, Option<String>)> {
        self.lines
            .iter()
            .filter_map(|l| {
                let key = allowed_key(&l.section, &l.key)?;
                let line = match &l.original {
                    Original::Absent => None,
                    Original::Line(text) => Some(text.clone()),
                };
                Some((key, line))
            })
            .collect()
    }
}

fn allowed_key(section: &str, key: &str) -> Option<IniKey> {
    ALLOWED_KEYS
        .iter()
        .copied()
        .find(|k| k.section.eq_ignore_ascii_case(section) && k.key.eq_ignore_ascii_case(key))
}

/// Reads the backup. `Ok(None)` = there is none.
pub fn read_backup(path: &Path) -> io::Result<Option<Backup>> {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    serde_json::from_slice(&bytes).map(Some).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

fn write_backup(path: &Path, backup: &Backup) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_vec_pretty(backup).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    write_atomic(path, &json)
}

// --- Before the launch -------------------------------------------------------------------------

/// What [`prepare`] did with `MeshQuality`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MeshChange {
    /// This version doesn't need Meshes on Low (the line was not touched or backed up).
    NotNeeded,
    /// It was 0 (Low) already.
    AlreadyLow,
    /// There was no `MeshQuality` line: `MeshQuality=0` was added for this game (and its section,
    /// if that was missing too). Both are removed again afterwards.
    Added,
    /// Set to 0 for this game; `from` = the value it had.
    SetToLow { from: String },
    /// Couldn't write the file; nothing changed.
    WriteFailed(String),
}

/// Result of [`prepare`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Prepared {
    /// GameUserSettings.ini doesn't exist: nothing was backed up or changed.
    NoFile,
    /// Nothing was backed up or changed, for the reason given (plain English).
    Skipped(String),
    /// The backup is on disk (with this id), and Meshes was handled as said.
    BackedUp { id: String, meshes: MeshChange },
}

/// Before the player's game starts with Bubble Builds: write the backup of the lines that may change
/// (see [`keys_for`]), then – only when `low_meshes` – set `MeshQuality` to 0 (added if missing).
///
/// The backup is written before the ini file is touched, so a crash at any point can be undone.
/// If an older backup is still there (it couldn't be put back yet), nothing is done: that backup
/// holds the real original values and must not be replaced. A file that has one of the lines (or
/// its section) twice is left alone too: one remembered line couldn't put that back exactly.
pub fn prepare(ini: &Path, backup: &Path, low_meshes: bool, id: &str) -> io::Result<Prepared> {
    if backup.exists() {
        return Ok(Prepared::Skipped("An older backup of Fortnite's settings is still waiting to be put back.".into()));
    }
    let bytes = match fs::read(ini) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Prepared::NoFile),
        Err(e) => return Err(e),
    };
    let Some((text, encoding)) = decode_exact(&bytes) else {
        return Ok(Prepared::Skipped("Fortnite's settings file has an unusual text format, so Niobium leaves it alone.".into()));
    };

    let keys = keys_for(low_meshes);
    if keys.iter().any(|k| is_ambiguous(&text, *k)) {
        return Ok(Prepared::Skipped("Fortnite's settings file lists one of these settings twice, so Niobium leaves it alone.".into()));
    }
    let lines = keys
        .iter()
        .map(|k| SavedLine {
            section: k.section.to_string(),
            key: k.key.to_string(),
            original: match find_line(&text, *k) {
                Some(line) => Original::Line(line),
                None => Original::Absent,
            },
            section_existed: section_exists(&text, k.section),
        })
        .collect();
    write_backup(backup, &Backup { format: BACKUP_FORMAT, id: id.to_string(), path: ini.to_path_buf(), lines })?;

    let meshes = if !low_meshes {
        MeshChange::NotNeeded
    } else {
        match low_meshes_text(&text) {
            LowMeshes::AlreadyLow => MeshChange::AlreadyLow,
            LowMeshes::Change { text: changed, from } => match write_ini(ini, &changed, encoding) {
                Ok(()) => match from {
                    Some(from) => MeshChange::SetToLow { from },
                    None => MeshChange::Added,
                },
                Err(e) => MeshChange::WriteFailed(e.to_string()),
            },
        }
    };
    Ok(Prepared::BackedUp { id: id.to_string(), meshes })
}

/// What setting Meshes to Low would do to a file's text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LowMeshes {
    AlreadyLow,
    /// `from` = the value the line had; None = there was no line, so `MeshQuality=0` is added.
    Change { text: String, from: Option<String> },
}

/// Pure part of the Meshes change: the text with the `[PerformanceMode] MeshQuality` line set to 0.
/// A line that already says 0 stays as it is. A missing line is added at the end of its section
/// (the section is added at the end of the file if it is missing too). [`prepare`] never calls this
/// for a file that has the line twice.
pub fn low_meshes_text(text: &str) -> LowMeshes {
    let Some(line) = find_line(text, MESH_QUALITY) else {
        let added = format!("{}=0", MESH_QUALITY.key);
        return LowMeshes::Change { text: set_line(text, MESH_QUALITY, Some(&added)), from: None };
    };
    let from = value_of(&line).unwrap_or_default().to_string();
    if from.parse::<i64>() == Ok(0) {
        return LowMeshes::AlreadyLow;
    }
    LowMeshes::Change { text: set_line(text, MESH_QUALITY, Some(&with_value(&line, "0"))), from: Some(from) }
}

// --- After the game ----------------------------------------------------------------------------

/// Result of [`restore`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Restored {
    /// There is no backup.
    NoBackup,
    /// The backup belongs to another launch (`only_id` didn't match): left alone.
    OtherBackup,
    /// The backup couldn't be read or isn't valid. It was moved aside (`gus-backup.bad.json`)
    /// and nothing was written.
    Corrupt,
    /// GameUserSettings.ini is gone, so there was nothing to put back.
    FileGone,
    /// The lines were already as before; the file wasn't written.
    Unchanged,
    /// The file was written: the remembered lines are back.
    Restored,
}

/// Puts the backed-up lines back into GameUserSettings.ini and (unless `keep_backup`) deletes the
/// backup. `only_id` = only act on the backup of that launch. On an error the backup stays, so the
/// next try (or the next launcher start) can do it.
pub fn restore(backup: &Path, only_id: Option<&str>, keep_backup: bool) -> io::Result<Restored> {
    let saved = match read_backup(backup) {
        Ok(None) => return Ok(Restored::NoBackup),
        Ok(Some(saved)) => saved,
        Err(e) if e.kind() == io::ErrorKind::InvalidData => {
            set_aside(backup);
            return Ok(Restored::Corrupt);
        }
        Err(e) => return Err(e),
    };
    if only_id.is_some_and(|id| id != saved.id) {
        return Ok(Restored::OtherBackup);
    }
    if !saved.is_valid() {
        set_aside(backup);
        return Ok(Restored::Corrupt);
    }

    let outcome = match fs::read(&saved.path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Restored::FileGone,
        Err(e) => return Err(e),
        Ok(bytes) => {
            let Some((text, encoding)) = decode_exact(&bytes) else {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "Fortnite's settings file has an unusual text format"));
            };
            let mut restored = restore_lines(&text, &saved.wanted());
            for section in saved.added_sections() {
                restored = remove_empty_section(&restored, section);
            }
            if restored == text {
                Restored::Unchanged
            } else {
                write_ini(&saved.path, &restored, encoding)?;
                Restored::Restored
            }
        }
    };
    if !keep_backup {
        match fs::remove_file(backup) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(outcome)
}

/// A broken backup is renamed, not deleted, so it can still be looked at.
fn set_aside(backup: &Path) {
    let bad = backup.with_extension("bad.json");
    let _ = fs::remove_file(&bad);
    if fs::rename(backup, &bad).is_err() {
        let _ = fs::remove_file(backup);
    }
}

// --- Line logic (pure) -------------------------------------------------------------------------

/// The whole line (without its line ending) of `key` in the first `[section]`, if it is there.
pub fn find_line(text: &str, key: IniKey) -> Option<String> {
    let lines: Vec<&str> = split_lines(text).into_iter().map(|(content, _)| content).collect();
    let (start, end) = section_range(&lines, key.section)?;
    lines[start..end]
        .iter()
        .find(|l| key_of(l).is_some_and(|k| k.eq_ignore_ascii_case(key.key)))
        .map(|l| l.to_string())
}

/// `line` with its value replaced; the key, the spacing around `=` and after the value stay.
pub fn with_value(line: &str, value: &str) -> String {
    let Some(eq) = line.find('=') else { return line.to_string() };
    let (head, rest) = line.split_at(eq + 1);
    let lead = rest.len() - rest.trim_start().len();
    let trail = rest.len() - rest.trim_end().len();
    if lead + trail >= rest.len() {
        return format!("{head}{rest}{value}");
    }
    format!("{head}{}{value}{}", &rest[..lead], &rest[rest.len() - trail..])
}

/// Returns `text` with each `(key, line)` put back: a remembered line replaces the current one (or is
/// added to its section, which is created at the end of the file if it is missing); `None` = the line
/// wasn't there before, so it is removed. All other lines, line endings and the order stay as they are.
pub fn restore_lines(text: &str, wanted: &[(IniKey, Option<String>)]) -> String {
    wanted.iter().fold(text.to_string(), |acc, (key, line)| set_line(&acc, *key, line.as_deref()))
}

/// Removes the first `[section]` header when nothing but blank lines follows it up to the next header
/// (or the end of the file); those blank lines go with it. Otherwise `text` stays as it is.
pub fn remove_empty_section(text: &str, section: &str) -> String {
    let lines = split_lines(text);
    let contents: Vec<&str> = lines.iter().map(|(c, _)| *c).collect();
    let Some((start, end)) = section_range(&contents, section) else { return text.to_string() };
    if contents[start..end].iter().any(|l| !l.trim().is_empty()) {
        return text.to_string();
    }
    let header = start - 1;
    lines
        .iter()
        .enumerate()
        .filter(|(i, _)| *i < header || *i >= end)
        .map(|(_, (c, e))| format!("{c}{e}"))
        .collect()
}

/// Sets one key of one section to exactly `wanted` (a whole line), or removes it (`None`).
/// Duplicates of the key in that section are folded into the one line (only a file Fortnite
/// changed during the game can have them: [`prepare`] leaves a file with duplicates alone).
pub fn set_line(text: &str, key: IniKey, wanted: Option<&str>) -> String {
    let mut lines: Vec<(String, String)> =
        split_lines(text).into_iter().map(|(c, e)| (c.to_string(), e.to_string())).collect();
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let contents: Vec<&str> = lines.iter().map(|(c, _)| c.as_str()).collect();
    let range = section_range(&contents, key.section);
    let positions: Vec<usize> = match range {
        Some((start, end)) => {
            (start..end).filter(|&i| key_of(contents[i]).is_some_and(|k| k.eq_ignore_ascii_case(key.key))).collect()
        }
        None => vec![],
    };

    match wanted {
        Some(line) => {
            if let Some(&first) = positions.first() {
                lines[first].0 = line.to_string();
                // duplicates of the same key would override the restored line – remove them
                for &i in positions.iter().skip(1).rev() {
                    lines.remove(i);
                }
            } else if let Some((start, end)) = range {
                // add after the last non-empty line of the section
                let mut at = end;
                while at > start && lines[at - 1].0.trim().is_empty() {
                    at -= 1;
                }
                // the line before may be the last line of the file without a line ending
                if lines[at - 1].1.is_empty() {
                    lines[at - 1].1 = newline.to_string();
                }
                lines.insert(at, (line.to_string(), newline.to_string()));
            } else {
                // section is gone: add it at the end
                if let Some(last) = lines.last_mut() {
                    if last.1.is_empty() {
                        last.1 = newline.to_string();
                    }
                }
                lines.push((format!("[{}]", key.section), newline.to_string()));
                lines.push((line.to_string(), newline.to_string()));
            }
        }
        None => {
            for &i in positions.iter().rev() {
                lines.remove(i);
            }
        }
    }

    lines.into_iter().map(|(c, e)| c + &e).collect()
}

// --- Reading and writing the file ----------------------------------------------------------------

/// How the ini file is stored, so it is written back the same way. Unreal 4.2x+ writes UTF-8 without
/// a BOM; older builds write UTF-16 LE with a BOM when the file has non-ASCII characters; hand-edited
/// copies often have a UTF-8 BOM.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
}

pub fn decode(bytes: &[u8]) -> (String, Encoding) {
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let units: Vec<u16> = rest.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return (String::from_utf16_lossy(&units), Encoding::Utf16Le);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return (String::from_utf8_lossy(rest).into_owned(), Encoding::Utf8Bom);
    }
    (String::from_utf8_lossy(bytes).into_owned(), Encoding::Utf8)
}

/// Like [`decode`], but only when writing the text back gives exactly the same bytes. Otherwise
/// (broken UTF-8, odd UTF-16 length, …) None: then the file is never written.
pub fn decode_exact(bytes: &[u8]) -> Option<(String, Encoding)> {
    let (text, encoding) = decode(bytes);
    (encode(&text, encoding) == bytes).then_some((text, encoding))
}

pub fn encode(text: &str, encoding: Encoding) -> Vec<u8> {
    match encoding {
        Encoding::Utf8 => text.as_bytes().to_vec(),
        Encoding::Utf8Bom => [&[0xEF, 0xBB, 0xBF][..], text.as_bytes()].concat(),
        Encoding::Utf16Le => {
            let mut out = vec![0xFF, 0xFE];
            out.extend(text.encode_utf16().flat_map(|u| u.to_le_bytes()));
            out
        }
    }
}

fn write_ini(path: &Path, text: &str, encoding: Encoding) -> io::Result<()> {
    write_atomic(path, &encode(text, encoding))
}

/// Writes via a temporary file next to it and renames, so nobody ever reads half a file.
fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut tmp_name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    tmp_name.push(".niobium.tmp");
    let tmp = path.with_file_name(tmp_name);
    fs::write(&tmp, bytes)?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// Splits into (line without ending, ending) – the ending is "\r\n", "\n" or "" (last line).
fn split_lines(text: &str) -> Vec<(&str, &str)> {
    text.split_inclusive('\n')
        .map(|l| {
            if let Some(c) = l.strip_suffix("\r\n") {
                (c, "\r\n")
            } else if let Some(c) = l.strip_suffix('\n') {
                (c, "\n")
            } else {
                (l, "")
            }
        })
        .collect()
}

/// `[Section]` header → its name.
fn header_of(line: &str) -> Option<&str> {
    let t = line.trim();
    t.strip_prefix('[')?.strip_suffix(']').map(str::trim)
}

/// `Key=Value` → Key (not for comments).
fn key_of(line: &str) -> Option<&str> {
    let t = line.trim_start();
    if t.starts_with(';') || t.starts_with('#') || t.starts_with('[') {
        return None;
    }
    let (k, _) = t.split_once('=')?;
    Some(k.trim())
}

fn value_of(line: &str) -> Option<&str> {
    line.split_once('=').map(|(_, v)| v.trim())
}

fn section_exists(text: &str, section: &str) -> bool {
    split_lines(text).iter().any(|(c, _)| header_of(c).is_some_and(|h| h.eq_ignore_ascii_case(section)))
}

/// The section header is in the file more than once, or the key is in its (first) section more than
/// once: one remembered line can't describe that, so such a file is never changed.
fn is_ambiguous(text: &str, key: IniKey) -> bool {
    let contents: Vec<&str> = split_lines(text).into_iter().map(|(c, _)| c).collect();
    let headers = contents.iter().filter(|l| header_of(l).is_some_and(|h| h.eq_ignore_ascii_case(key.section))).count();
    if headers > 1 {
        return true;
    }
    let Some((start, end)) = section_range(&contents, key.section) else { return false };
    contents[start..end].iter().filter(|l| key_of(l).is_some_and(|k| k.eq_ignore_ascii_case(key.key))).count() > 1
}

/// Line range (after the header, up to the next header) of the first `[section]`.
fn section_range(lines: &[&str], section: &str) -> Option<(usize, usize)> {
    let header = lines.iter().position(|l| header_of(l).is_some_and(|h| h.eq_ignore_ascii_case(section)))?;
    let start = header + 1;
    let end = lines[start..].iter().position(|l| header_of(l).is_some()).map(|i| start + i).unwrap_or(lines.len());
    Some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shaped like a real 19.10 GameUserSettings.ini (CRLF, as Unreal writes it on Windows).
    const BEFORE: &str = "[/Script/FortniteGame.FortGameUserSettings]\r\nResolutionSizeX=1920\r\n\r\n[D3DRHIPreference]\r\nbUseD3D12InGame=False\r\nbPreferFeatureLevelES31=False\r\n\r\n[ScalabilityGroups]\r\nsg.ViewDistanceQuality=3\r\n\r\n[PerformanceMode]\r\nMeshQuality=1\r\n";

    fn wanted_of(text: &str, low_meshes: bool) -> Vec<(IniKey, Option<String>)> {
        keys_for(low_meshes).into_iter().map(|k| (k, find_line(text, k))).collect()
    }

    /// A fresh, empty folder for one test.
    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("niobium-perfmode-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn finds_lines_only_in_their_section() {
        assert_eq!(find_line(BEFORE, PREFER_ES31).as_deref(), Some("bPreferFeatureLevelES31=False"));
        assert_eq!(find_line(BEFORE, PREFERRED_FEATURE_LEVEL), None);
        assert_eq!(find_line(BEFORE, MESH_QUALITY).as_deref(), Some("MeshQuality=1"));
        // keys in other sections and comments don't count; any upper/lower case does
        let other = "[Other]\nMeshQuality=1\n[performancemode]\n;MeshQuality=1\n meshquality = 1 \n";
        assert_eq!(find_line(other, MESH_QUALITY).as_deref(), Some(" meshquality = 1 "));
        assert_eq!(find_line("", MESH_QUALITY), None);
        assert_eq!(find_line("[Other]\nMeshQuality=1\n", MESH_QUALITY), None);
    }

    #[test]
    fn with_value_keeps_the_spelling() {
        assert_eq!(with_value("MeshQuality=1", "0"), "MeshQuality=0");
        assert_eq!(with_value(" meshquality = 1 ", "0"), " meshquality = 0 ");
        assert_eq!(with_value("MeshQuality=", "0"), "MeshQuality=0");
        assert_eq!(with_value("MeshQuality=  ", "0"), "MeshQuality=  0");
    }

    #[test]
    fn low_meshes_changes_only_the_mesh_line() {
        match low_meshes_text(BEFORE) {
            LowMeshes::Change { text, from } => {
                assert_eq!(from.as_deref(), Some("1"));
                assert_eq!(text, BEFORE.replace("MeshQuality=1", "MeshQuality=0"));
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(low_meshes_text(&BEFORE.replace("MeshQuality=1", "MeshQuality=0")), LowMeshes::AlreadyLow);
        assert_eq!(low_meshes_text(&BEFORE.replace("MeshQuality=1", "MeshQuality= 0")), LowMeshes::AlreadyLow);
        // no line: it is added at the end of its section
        assert_eq!(
            low_meshes_text(&BEFORE.replace("MeshQuality=1\r\n", "")),
            LowMeshes::Change { text: BEFORE.replace("MeshQuality=1", "MeshQuality=0"), from: None }
        );
        // no section either: both are added at the end of the file
        assert_eq!(
            low_meshes_text("[D3DRHIPreference]\nbPreferFeatureLevelES31=False\n"),
            LowMeshes::Change {
                text: "[D3DRHIPreference]\nbPreferFeatureLevelES31=False\n[PerformanceMode]\nMeshQuality=0\n".into(),
                from: None
            }
        );
        // any other value becomes 0 too
        assert!(matches!(low_meshes_text("[PerformanceMode]\nMeshQuality=2\n"), LowMeshes::Change { from: Some(from), .. } if from == "2"));
    }

    #[test]
    fn restores_exactly_the_remembered_lines() {
        let before = wanted_of(BEFORE, true);
        // Niobium set Meshes to Low; the game then saved ES3.1 as default, added a line and changed
        // another setting too
        let after = BEFORE
            .replace("MeshQuality=1", "MeshQuality=0")
            .replace("bPreferFeatureLevelES31=False", "bPreferFeatureLevelES31=True")
            .replace("bUseD3D12InGame=False\r\n", "bUseD3D12InGame=False\r\nPreferredFeatureLevel=es31\r\n")
            .replace("ResolutionSizeX=1920", "ResolutionSizeX=2560");
        let fixed = restore_lines(&after, &before);
        // our lines are back (the added one removed), the other change stays
        assert_eq!(fixed, BEFORE.replace("ResolutionSizeX=1920", "ResolutionSizeX=2560"));
        // nothing to do → same text
        assert_eq!(restore_lines(BEFORE, &before), BEFORE);
    }

    #[test]
    fn absent_lines_are_removed_again() {
        // Meshes had no line before; the game wrote one in Performance Mode
        let text = "[D3DRHIPreference]\nPreferredRHI=dx11\n\n[PerformanceMode]\nMeshQuality=0\n";
        let wanted = vec![(PREFER_ES31, None), (PREFERRED_FEATURE_LEVEL, None), (MESH_QUALITY, None)];
        let restored = restore_lines(text, &wanted);
        assert_eq!(restored, "[D3DRHIPreference]\nPreferredRHI=dx11\n\n[PerformanceMode]\n");
        // the section header goes too when the section wasn't there before (see `restore`)
        assert_eq!(remove_empty_section(&restored, "PerformanceMode"), "[D3DRHIPreference]\nPreferredRHI=dx11\n\n");
    }

    #[test]
    fn empty_sections_only() {
        // a section with something left in it stays, so does a missing one
        let text = "[A]\r\nx=1\r\n\r\n[PerformanceMode]\r\nOther=1\r\n\r\n[B]\r\ny=2\r\n";
        assert_eq!(remove_empty_section(text, "PerformanceMode"), text);
        assert_eq!(remove_empty_section(text, "D3DRHIPreference"), text);
        // an empty one in the middle goes with its blank lines; the order and line endings stay
        let text = "[A]\r\nx=1\r\n\r\n[PerformanceMode]\r\n\r\n[B]\r\ny=2\r\n";
        assert_eq!(remove_empty_section(text, "performancemode"), "[A]\r\nx=1\r\n\r\n[B]\r\ny=2\r\n");
        // a comment counts as content
        let text = "[PerformanceMode]\n; mine\n";
        assert_eq!(remove_empty_section(text, "PerformanceMode"), text);
        assert_eq!(remove_empty_section("[PerformanceMode]", "PerformanceMode"), "");
    }

    #[test]
    fn restore_adds_missing_line_and_section() {
        let wanted = vec![(PREFER_ES31, Some("bPreferFeatureLevelES31=False".to_string()))];
        // line removed from the section
        let text = "[D3DRHIPreference]\nbUseD3D12InGame=False\n\n[X]\na=1\n";
        assert_eq!(
            restore_lines(text, &wanted),
            "[D3DRHIPreference]\nbUseD3D12InGame=False\nbPreferFeatureLevelES31=False\n\n[X]\na=1\n"
        );
        // section gone (file without final newline)
        assert_eq!(restore_lines("[X]\na=1", &wanted), "[X]\na=1\n[D3DRHIPreference]\nbPreferFeatureLevelES31=False\n");
        // header is the last line, without a line ending
        assert_eq!(restore_lines("[D3DRHIPreference]", &wanted), "[D3DRHIPreference]\nbPreferFeatureLevelES31=False\n");
        // duplicates of a key are folded into the remembered line
        let text = "[D3DRHIPreference]\nbPreferFeatureLevelES31=True\nbPreferFeatureLevelES31=True\n";
        assert_eq!(restore_lines(text, &wanted), "[D3DRHIPreference]\nbPreferFeatureLevelES31=False\n");
        // CRLF files get CRLF for added lines
        let text = "[PerformanceMode]\r\nOther=1\r\n";
        assert_eq!(
            restore_lines(text, &[(MESH_QUALITY, Some("MeshQuality=1".into()))]),
            "[PerformanceMode]\r\nOther=1\r\nMeshQuality=1\r\n"
        );
    }

    #[test]
    fn decode_exact_refuses_what_it_cant_write_back() {
        for encoding in [Encoding::Utf8, Encoding::Utf8Bom, Encoding::Utf16Le] {
            let bytes = encode("[PerformanceMode]\r\nMeshQuality=1\r\nName=Jürgen\r\n", encoding);
            let (text, found) = decode_exact(&bytes).unwrap();
            assert_eq!(found, encoding);
            assert!(text.contains("Jürgen"));
        }
        // Latin-1 byte (not UTF-8), odd UTF-16 length, unpaired UTF-16 surrogate
        assert_eq!(decode_exact(b"[PerformanceMode]\nName=J\xfcrgen\n"), None);
        assert_eq!(decode_exact(&[0xFF, 0xFE, b'[', 0, b']']), None);
        assert_eq!(decode_exact(&[0xFF, 0xFE, 0x00, 0xD8, b'a', 0]), None);
    }

    #[test]
    fn backup_json_format() {
        let backup = Backup {
            format: BACKUP_FORMAT,
            id: "1-2".into(),
            path: PathBuf::from("C:/Users/georg/AppData/Local/FortniteGame/Saved/Config/WindowsClient/GameUserSettings.ini"),
            lines: vec![
                SavedLine {
                    section: "PerformanceMode".into(),
                    key: "MeshQuality".into(),
                    original: Original::Line("MeshQuality=1".into()),
                    section_existed: true,
                },
                SavedLine {
                    section: "D3DRHIPreference".into(),
                    key: "PreferredFeatureLevel".into(),
                    original: Original::Absent,
                    section_existed: false,
                },
            ],
        };
        let json = serde_json::to_value(&backup).unwrap();
        assert_eq!(json["lines"][0]["original"]["line"], "MeshQuality=1");
        assert_eq!(json["lines"][1]["original"], "absent");
        assert_eq!(json["lines"][1]["sectionExisted"], false);
        assert!(json["path"].as_str().unwrap().ends_with("GameUserSettings.ini"));
        assert!(backup.is_valid());
        assert_eq!(backup.added_sections(), vec!["D3DRHIPreference"]);
        let back: Backup = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(back, backup);
        // no "sectionExisted" in the JSON: the section counts as existing (its header is never removed)
        let mut older = json;
        older["lines"][1].as_object_mut().unwrap().remove("sectionExisted");
        let older: Backup = serde_json::from_value(older).unwrap();
        assert!(older.lines[1].section_existed && older.added_sections().is_empty());

        // only our three lines, each line must be its own key, and only a GameUserSettings.ini
        let mut other_key = backup.clone();
        other_key.lines[0] = SavedLine {
            section: "ScalabilityGroups".into(),
            key: "sg.ViewDistanceQuality".into(),
            original: Original::Absent,
            section_existed: true,
        };
        assert!(!other_key.is_valid());
        let mut smuggled = backup.clone();
        smuggled.lines[0].original = Original::Line("ResolutionSizeX=640".into());
        assert!(!smuggled.is_valid());
        let mut two_lines = backup.clone();
        two_lines.lines[0].original = Original::Line("MeshQuality=1\r\nResolutionSizeX=640".into());
        assert!(!two_lines.is_valid());
        let mut other_file = backup;
        other_file.path = PathBuf::from("C:/Windows/win.ini");
        assert!(!other_file.is_valid());
    }

    /// The whole round trip on disk: backup, Meshes Low, the game changes things, restore.
    #[test]
    fn prepare_and_restore_keep_every_other_byte() {
        let dir = temp_dir("roundtrip");
        let ini = dir.join("GameUserSettings.ini");
        let backup = dir.join(BACKUP_FILE);

        for encoding in [Encoding::Utf8, Encoding::Utf8Bom, Encoding::Utf16Le] {
            let original = encode(BEFORE, encoding);
            fs::write(&ini, &original).unwrap();

            let prepared = prepare(&ini, &backup, true, "launch-1").unwrap();
            assert_eq!(prepared, Prepared::BackedUp { id: "launch-1".into(), meshes: MeshChange::SetToLow { from: "1".into() } });
            // the backup is on disk with the original lines
            let saved = read_backup(&backup).unwrap().unwrap();
            assert_eq!(saved.path, ini);
            assert_eq!(
                saved.lines.iter().map(|l| l.original.clone()).collect::<Vec<_>>(),
                vec![Original::Line("bPreferFeatureLevelES31=False".into()), Original::Absent, Original::Line("MeshQuality=1".into())]
            );
            // only the Meshes line changed, in the same encoding
            assert_eq!(fs::read(&ini).unwrap(), encode(&BEFORE.replace("MeshQuality=1", "MeshQuality=0"), encoding), "{encoding:?}");

            // the game saves Performance Mode as default and changes the resolution
            let played = BEFORE
                .replace("bPreferFeatureLevelES31=False", "bPreferFeatureLevelES31=True")
                .replace("MeshQuality=1", "MeshQuality=0")
                .replace("ResolutionSizeX=1920", "ResolutionSizeX=2560");
            fs::write(&ini, encode(&played, encoding)).unwrap();

            // another launch's watcher never touches this backup
            assert_eq!(restore(&backup, Some("launch-0"), false).unwrap(), Restored::OtherBackup);
            assert!(backup.exists());

            assert_eq!(restore(&backup, Some("launch-1"), false).unwrap(), Restored::Restored);
            assert_eq!(fs::read(&ini).unwrap(), encode(&BEFORE.replace("ResolutionSizeX=1920", "ResolutionSizeX=2560"), encoding));
            assert!(!backup.exists());
            // nothing left to do
            assert_eq!(restore(&backup, None, false).unwrap(), Restored::NoBackup);
        }
        // no temporary files left behind
        let names: Vec<_> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("GameUserSettings.ini")]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prepare_leaves_low_meshes_alone() {
        let dir = temp_dir("lowmeshes");
        let ini = dir.join("GameUserSettings.ini");
        let backup = dir.join(BACKUP_FILE);

        let text = BEFORE.replace("MeshQuality=1", "MeshQuality=0");
        fs::write(&ini, &text).unwrap();
        assert_eq!(prepare(&ini, &backup, true, "x").unwrap(), Prepared::BackedUp { id: "x".into(), meshes: MeshChange::AlreadyLow });
        assert_eq!(fs::read_to_string(&ini).unwrap(), text, "file untouched");
        assert!(backup.exists());
        assert_eq!(restore(&backup, None, false).unwrap(), Restored::Unchanged);
        assert_eq!(fs::read_to_string(&ini).unwrap(), text);

        // Experimental versions (15.30, 16.10 – 16.40): Meshes isn't touched or backed up
        fs::write(&ini, BEFORE).unwrap();
        assert_eq!(prepare(&ini, &backup, false, "y").unwrap(), Prepared::BackedUp { id: "y".into(), meshes: MeshChange::NotNeeded });
        assert_eq!(read_backup(&backup).unwrap().unwrap().lines.len(), 2);
        assert_eq!(fs::read_to_string(&ini).unwrap(), BEFORE);
        // even if the game changes Meshes, only the two Performance Mode lines come back
        fs::write(&ini, BEFORE.replace("MeshQuality=1", "MeshQuality=0").replace("ES31=False", "ES31=True")).unwrap();
        assert_eq!(restore(&backup, None, false).unwrap(), Restored::Restored);
        assert_eq!(fs::read_to_string(&ini).unwrap(), BEFORE.replace("MeshQuality=1", "MeshQuality=0"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_or_unusual_file_is_never_written() {
        let dir = temp_dir("nofile");
        let ini = dir.join("GameUserSettings.ini");
        let backup = dir.join(BACKUP_FILE);

        // no file: no backup, nothing created
        assert_eq!(prepare(&ini, &backup, true, "a").unwrap(), Prepared::NoFile);
        assert!(!ini.exists() && !backup.exists());

        // bytes that wouldn't come back the same: left alone, no backup
        let odd = b"[PerformanceMode]\r\nMeshQuality=1\r\nName=J\xfcrgen\r\n".to_vec();
        fs::write(&ini, &odd).unwrap();
        assert!(matches!(prepare(&ini, &backup, true, "a").unwrap(), Prepared::Skipped(_)));
        assert_eq!(fs::read(&ini).unwrap(), odd);
        assert!(!backup.exists());

        // the file disappears during the game: the backup is dropped, nothing is created
        fs::write(&ini, BEFORE).unwrap();
        assert!(matches!(prepare(&ini, &backup, true, "b").unwrap(), Prepared::BackedUp { .. }));
        fs::remove_file(&ini).unwrap();
        assert_eq!(restore(&backup, Some("b"), false).unwrap(), Restored::FileGone);
        assert!(!ini.exists() && !backup.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    /// No Meshes line (or no [PerformanceMode] at all): `MeshQuality=0` is added for the game, and
    /// after it the file is byte for byte what it was – the added section header goes too.
    #[test]
    fn missing_meshes_line_is_added_and_removed_again() {
        let dir = temp_dir("addmeshes");
        let ini = dir.join("GameUserSettings.ini");
        let backup = dir.join(BACKUP_FILE);

        let no_line = BEFORE.replace("MeshQuality=1\r\n", "");
        let no_section = BEFORE.replace("[PerformanceMode]\r\nMeshQuality=1\r\n", "");
        for (original, during) in [
            (no_line.clone(), BEFORE.replace("MeshQuality=1", "MeshQuality=0")),
            (no_section.clone(), format!("{no_section}[PerformanceMode]\r\nMeshQuality=0\r\n")),
        ] {
            for encoding in [Encoding::Utf8, Encoding::Utf16Le] {
                fs::write(&ini, encode(&original, encoding)).unwrap();
                assert_eq!(prepare(&ini, &backup, true, "add").unwrap(), Prepared::BackedUp { id: "add".into(), meshes: MeshChange::Added });
                assert_eq!(fs::read(&ini).unwrap(), encode(&during, encoding));
                let saved = read_backup(&backup).unwrap().unwrap();
                let mesh = saved.lines.iter().find(|l| l.key == "MeshQuality").unwrap();
                assert_eq!(mesh.original, Original::Absent);
                assert_eq!(mesh.section_existed, original == no_line);

                // the game also saves Performance Mode as default (that section was there)
                fs::write(&ini, encode(&during.replace("ES31=False", "ES31=True"), encoding)).unwrap();
                assert_eq!(restore(&backup, Some("add"), false).unwrap(), Restored::Restored);
                assert_eq!(fs::read(&ini).unwrap(), encode(&original, encoding), "{encoding:?}");
                assert!(!backup.exists());
            }
        }

        // Fortnite added [D3DRHIPreference] itself (it wasn't there): it goes again once empty
        let without = "[ScalabilityGroups]\r\nsg.ViewDistanceQuality=3\r\n\r\n[PerformanceMode]\r\nMeshQuality=0\r\n";
        fs::write(&ini, without).unwrap();
        assert!(matches!(prepare(&ini, &backup, true, "rhi").unwrap(), Prepared::BackedUp { meshes: MeshChange::AlreadyLow, .. }));
        let with_rhi = format!("{without}\r\n[D3DRHIPreference]\r\nbPreferFeatureLevelES31=True\r\nPreferredFeatureLevel=es31\r\n");
        fs::write(&ini, &with_rhi).unwrap();
        assert_eq!(restore(&backup, Some("rhi"), false).unwrap(), Restored::Restored);
        assert_eq!(fs::read_to_string(&ini).unwrap(), format!("{without}\r\n"));
        // … but stays when Fortnite put other lines in it too
        fs::write(&ini, without).unwrap();
        assert!(matches!(prepare(&ini, &backup, true, "rhi2").unwrap(), Prepared::BackedUp { .. }));
        fs::write(&ini, format!("{with_rhi}bUseD3D12InGame=False\r\n")).unwrap();
        assert_eq!(restore(&backup, Some("rhi2"), false).unwrap(), Restored::Restored);
        assert_eq!(fs::read_to_string(&ini).unwrap(), format!("{without}\r\n[D3DRHIPreference]\r\nbUseD3D12InGame=False\r\n"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// A setting (or its section) listed twice can't be put back from one remembered line: such a
    /// file is never touched and no backup is written.
    #[test]
    fn duplicates_are_left_alone() {
        let dir = temp_dir("dupes");
        let ini = dir.join("GameUserSettings.ini");
        let backup = dir.join(BACKUP_FILE);
        for text in [
            BEFORE.replace("MeshQuality=1\r\n", "MeshQuality=1\r\nMeshQuality=1\r\n"),
            BEFORE.replace("bPreferFeatureLevelES31=False\r\n", "bPreferFeatureLevelES31=False\r\nbpreferfeaturelevelES31=True\r\n"),
            format!("{BEFORE}[PerformanceMode]\r\nMeshQuality=1\r\n"),
        ] {
            fs::write(&ini, &text).unwrap();
            assert!(matches!(prepare(&ini, &backup, true, "d").unwrap(), Prepared::Skipped(_)));
            assert_eq!(fs::read_to_string(&ini).unwrap(), text);
            assert!(!backup.exists());
        }
        // a duplicate Meshes line doesn't matter where Meshes isn't touched (15.30, 16.10 – 16.40)
        let text = BEFORE.replace("MeshQuality=1\r\n", "MeshQuality=1\r\nMeshQuality=1\r\n");
        fs::write(&ini, &text).unwrap();
        assert!(matches!(prepare(&ini, &backup, false, "e").unwrap(), Prepared::BackedUp { .. }));
        assert_eq!(fs::read_to_string(&ini).unwrap(), text);
        let _ = fs::remove_dir_all(&dir);
    }

    /// The launcher crashed during the game: the next start finds the backup and puts it back.
    /// A waiting backup is never replaced by a new launch.
    #[test]
    fn crash_recovery() {
        let dir = temp_dir("crash");
        let ini = dir.join("GameUserSettings.ini");
        let backup = dir.join(BACKUP_FILE);
        fs::write(&ini, BEFORE).unwrap();

        assert!(matches!(prepare(&ini, &backup, true, "crashed").unwrap(), Prepared::BackedUp { .. }));
        // (the launcher is gone; the game wrote Performance Mode as default)
        fs::write(&ini, BEFORE.replace("MeshQuality=1", "MeshQuality=0").replace("ES31=False", "ES31=True")).unwrap();

        // a new launch before the old backup was put back: nothing is replaced or changed
        let changed = fs::read(&ini).unwrap();
        assert!(matches!(prepare(&ini, &backup, true, "new").unwrap(), Prepared::Skipped(_)));
        assert_eq!(read_backup(&backup).unwrap().unwrap().id, "crashed");
        assert_eq!(fs::read(&ini).unwrap(), changed);

        // next launcher start: any backup is put back
        assert_eq!(restore(&backup, None, false).unwrap(), Restored::Restored);
        assert_eq!(fs::read_to_string(&ini).unwrap(), BEFORE);
        assert!(!backup.exists());

        // phase 1 of a normal game (server still running): restore but keep the backup …
        assert!(matches!(prepare(&ini, &backup, true, "two-step").unwrap(), Prepared::BackedUp { .. }));
        assert_eq!(restore(&backup, Some("two-step"), true).unwrap(), Restored::Restored);
        assert!(backup.exists());
        // … the server Fortnite writes its own copy later …
        fs::write(&ini, BEFORE.replace("MeshQuality=1", "MeshQuality=0")).unwrap();
        // … phase 2 puts it back again and deletes the backup
        assert_eq!(restore(&backup, Some("two-step"), false).unwrap(), Restored::Restored);
        assert_eq!(fs::read_to_string(&ini).unwrap(), BEFORE);
        assert!(!backup.exists());

        // a broken backup is moved aside and nothing is written
        fs::write(&backup, b"{ not json").unwrap();
        fs::write(&ini, "[PerformanceMode]\nMeshQuality=0\n").unwrap();
        assert_eq!(restore(&backup, None, false).unwrap(), Restored::Corrupt);
        assert!(!backup.exists() && dir.join("gus-backup.bad.json").exists());
        assert_eq!(fs::read_to_string(&ini).unwrap(), "[PerformanceMode]\nMeshQuality=0\n");
        // a backup that names other lines is never applied
        let evil = serde_json::json!({
            "format": 1, "id": "e", "path": ini,
            "lines": [{ "section": "ScalabilityGroups", "key": "sg.ViewDistanceQuality", "original": { "line": "sg.ViewDistanceQuality=0" } }]
        });
        fs::write(&backup, serde_json::to_vec(&evil).unwrap()).unwrap();
        assert_eq!(restore(&backup, None, false).unwrap(), Restored::Corrupt);
        assert_eq!(fs::read_to_string(&ini).unwrap(), "[PerformanceMode]\nMeshQuality=0\n");
        let _ = fs::remove_dir_all(&dir);
    }
}
