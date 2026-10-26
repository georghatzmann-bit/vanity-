//! Read-only check of Fortnite's own settings file for Bubble Builds.
//!
//! Bubble Builds start the player's game with `-FeatureLevelES31` (Performance Mode). Fortnite might
//! then save Performance Mode as the default in
//! `%LOCALAPPDATA%\FortniteGame\Saved\Config\WindowsClient\GameUserSettings.ini` – a file that every
//! build (and live Fortnite) shares. So before the launch the launcher remembers the two lines in
//! `[D3DRHIPreference]` (`bPreferFeatureLevelES31`, `PreferredFeatureLevel`) and compares them after
//! the game closed. Only when the user clicks "Reset" are exactly these lines put back – nothing
//! else in the file changes. If the file doesn't exist, nothing happens at all.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Section of the two lines.
pub const SECTION: &str = "D3DRHIPreference";
/// Keys that are remembered and restored (in this order).
pub const KEYS: [&str; 2] = ["bPreferFeatureLevelES31", "PreferredFeatureLevel"];

/// `%LOCALAPPDATA%\FortniteGame\Saved\Config\WindowsClient\GameUserSettings.ini`
pub fn game_user_settings_path() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| {
        d.join("FortniteGame").join("Saved").join("Config").join("WindowsClient").join("GameUserSettings.ini")
    })
}

/// The remembered lines: for each of [`KEYS`] the whole line as it was (None = the line wasn't there).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PerfModeLines {
    pub lines: [Option<String>; 2],
}

impl PerfModeLines {
    /// Reads the two lines from the text of the ini file.
    pub fn from_text(text: &str) -> PerfModeLines {
        let lines: Vec<&str> = split_lines(text).into_iter().map(|(content, _)| content).collect();
        let mut out = PerfModeLines::default();
        if let Some((start, end)) = section_range(&lines) {
            for (slot, key) in out.lines.iter_mut().zip(KEYS) {
                *slot = lines[start..end].iter().find(|l| key_of(l).is_some_and(|k| k.eq_ignore_ascii_case(key))).map(|l| l.to_string());
            }
        }
        out
    }

    /// The lines select Performance Mode (ES3.1): `bPreferFeatureLevelES31=True` or
    /// `PreferredFeatureLevel=es31`.
    pub fn prefers_es31(&self) -> bool {
        let value = |i: usize| self.lines[i].as_deref().and_then(value_of).unwrap_or_default();
        let prefer = value(0);
        let level = value(1);
        prefer.eq_ignore_ascii_case("true")
            || prefer == "1"
            || prefer.eq_ignore_ascii_case("yes")
            || level.eq_ignore_ascii_case("es31")
            || level.eq_ignore_ascii_case("es3_1")
    }
}

/// Remembered before the launch: the file path and the two lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub path: PathBuf,
    pub before: PerfModeLines,
}

/// Remembers the lines. None if the file doesn't exist or can't be read (then nothing is checked).
pub fn snapshot(path: &Path) -> Option<Snapshot> {
    let (text, _) = read_ini(path).ok()?;
    Some(Snapshot { path: path.to_path_buf(), before: PerfModeLines::from_text(&text) })
}

/// After the game closed: did Fortnite switch the default to Performance Mode (ES3.1)?
/// False if it was ES3.1 before already, or if the file is gone.
pub fn switched_to_es31(snap: &Snapshot) -> bool {
    if snap.before.prefers_es31() {
        return false;
    }
    match read_ini(&snap.path) {
        Ok((text, _)) => PerfModeLines::from_text(&text).prefers_es31(),
        Err(_) => false,
    }
}

/// Puts the remembered lines back into the file. Nothing else in the file changes.
/// Does nothing (and returns Ok(false)) if the file doesn't exist; Ok(true) when the file was written.
pub fn restore(snap: &Snapshot) -> io::Result<bool> {
    if !snap.path.is_file() {
        return Ok(false);
    }
    let (text, encoding) = read_ini(&snap.path)?;
    let restored = restore_lines(&text, &snap.before);
    if restored == text {
        return Ok(false);
    }
    write_ini(&snap.path, &restored, encoding)?;
    Ok(true)
}

/// Pure part of [`restore`]: returns `text` with the two lines of `[D3DRHIPreference]` put back
/// to `before`. A remembered line replaces the current one (or is added to the section, which is
/// created at the end of the file if it is missing); a line that wasn't there before is removed.
/// All other lines, line endings and the order stay as they are.
pub fn restore_lines(text: &str, before: &PerfModeLines) -> String {
    let mut lines: Vec<(String, String)> =
        split_lines(text).into_iter().map(|(c, e)| (c.to_string(), e.to_string())).collect();
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };

    for (key, wanted) in KEYS.iter().zip(before.lines.iter()) {
        let contents: Vec<&str> = lines.iter().map(|(c, _)| c.as_str()).collect();
        let range = section_range(&contents);
        let positions: Vec<usize> = match range {
            Some((start, end)) => (start..end)
                .filter(|&i| key_of(contents[i]).is_some_and(|k| k.eq_ignore_ascii_case(key)))
                .collect(),
            None => vec![],
        };

        match wanted {
            Some(line) => {
                if let Some(&first) = positions.first() {
                    lines[first].0 = line.clone();
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
                    lines.insert(at, (line.clone(), newline.to_string()));
                } else {
                    // section is gone: add it at the end
                    if let Some(last) = lines.last_mut() {
                        if last.1.is_empty() {
                            last.1 = newline.to_string();
                        }
                    }
                    lines.push((format!("[{SECTION}]"), newline.to_string()));
                    lines.push((line.clone(), newline.to_string()));
                }
            }
            None => {
                for &i in positions.iter().rev() {
                    lines.remove(i);
                }
            }
        }
    }

    lines.into_iter().map(|(c, e)| c + &e).collect()
}

/// How the ini file is stored, so it is written back the same way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
}

pub fn read_ini(path: &Path) -> io::Result<(String, Encoding)> {
    Ok(decode(&fs::read(path)?))
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

/// Writes via a temporary file next to it and renames, so Fortnite never reads half a file.
fn write_ini(path: &Path, text: &str, encoding: Encoding) -> io::Result<()> {
    let tmp = path.with_extension("ini.niobium.tmp");
    fs::write(&tmp, encode(text, encoding))?;
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

/// Line range (after the header, up to the next header) of the first `[D3DRHIPreference]` section.
fn section_range(lines: &[&str]) -> Option<(usize, usize)> {
    let header = lines.iter().position(|l| header_of(l).is_some_and(|h| h.eq_ignore_ascii_case(SECTION)))?;
    let start = header + 1;
    let end = lines[start..].iter().position(|l| header_of(l).is_some()).map(|i| start + i).unwrap_or(lines.len());
    Some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BEFORE: &str = "[/Script/FortniteGame.FortGameUserSettings]\r\nResolutionSizeX=1920\r\n\r\n[D3DRHIPreference]\r\nbUseD3D12InGame=False\r\nbPreferFeatureLevelES31=False\r\n\r\n[ScalabilityGroups]\r\nsg.ViewDistanceQuality=3\r\n";

    #[test]
    fn reads_the_two_lines() {
        let l = PerfModeLines::from_text(BEFORE);
        assert_eq!(l.lines[0].as_deref(), Some("bPreferFeatureLevelES31=False"));
        assert_eq!(l.lines[1], None);
        assert!(!l.prefers_es31());
        // keys in other sections don't count
        let other = "[Other]\nbPreferFeatureLevelES31=True\n[D3DRHIPreference]\nPreferredRHI=dx11\n";
        assert_eq!(PerfModeLines::from_text(other), PerfModeLines::default());
        assert!(!PerfModeLines::from_text("").prefers_es31());
    }

    #[test]
    fn detects_es31() {
        assert!(PerfModeLines::from_text("[D3DRHIPreference]\nbPreferFeatureLevelES31=True\n").prefers_es31());
        assert!(PerfModeLines::from_text("[d3drhipreference]\r\nbpreferfeaturelevelES31 = true\r\n").prefers_es31());
        assert!(PerfModeLines::from_text("[D3DRHIPreference]\nPreferredRHI=dx12\nPreferredFeatureLevel=es31\n").prefers_es31());
        assert!(!PerfModeLines::from_text("[D3DRHIPreference]\nPreferredFeatureLevel=sm5\n").prefers_es31());
        assert!(!PerfModeLines::from_text("[D3DRHIPreference]\n;bPreferFeatureLevelES31=True\n").prefers_es31());
    }

    #[test]
    fn restores_exactly_the_remembered_lines() {
        let before = PerfModeLines::from_text(BEFORE);
        // the game switched to ES3.1, added PreferredFeatureLevel and changed another setting too
        let after = BEFORE
            .replace("bPreferFeatureLevelES31=False", "bPreferFeatureLevelES31=True")
            .replace("bUseD3D12InGame=False\r\n", "bUseD3D12InGame=False\r\nPreferredFeatureLevel=es31\r\n")
            .replace("ResolutionSizeX=1920", "ResolutionSizeX=2560");
        assert!(PerfModeLines::from_text(&after).prefers_es31());
        let fixed = restore_lines(&after, &before);
        // the two lines are back, the other change stays
        assert_eq!(fixed, BEFORE.replace("ResolutionSizeX=1920", "ResolutionSizeX=2560"));
        assert!(!PerfModeLines::from_text(&fixed).prefers_es31());
        // nothing to do → same text
        assert_eq!(restore_lines(BEFORE, &before), BEFORE);
    }

    #[test]
    fn restore_adds_missing_line_and_section() {
        let before = PerfModeLines { lines: [Some("bPreferFeatureLevelES31=False".into()), None] };
        // line removed from the section
        let text = "[D3DRHIPreference]\nbUseD3D12InGame=False\n\n[X]\na=1\n";
        assert_eq!(
            restore_lines(text, &before),
            "[D3DRHIPreference]\nbUseD3D12InGame=False\nbPreferFeatureLevelES31=False\n\n[X]\na=1\n"
        );
        // section gone (file without final newline)
        let text = "[X]\na=1";
        assert_eq!(restore_lines(text, &before), "[X]\na=1\n[D3DRHIPreference]\nbPreferFeatureLevelES31=False\n");
        // header is the last line, without a line ending
        assert_eq!(restore_lines("[D3DRHIPreference]", &before), "[D3DRHIPreference]\nbPreferFeatureLevelES31=False\n");
        // duplicates of a key are folded into the remembered line
        let text = "[D3DRHIPreference]\nbPreferFeatureLevelES31=True\nbPreferFeatureLevelES31=True\n";
        assert_eq!(restore_lines(text, &before), "[D3DRHIPreference]\nbPreferFeatureLevelES31=False\n");
    }

    #[test]
    fn file_roundtrip_keeps_encoding_and_missing_file_is_left_alone() {
        let dir = std::env::temp_dir().join(format!("niobium-perfmode-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("GameUserSettings.ini");

        // no file: no snapshot, nothing written
        assert_eq!(snapshot(&path), None);
        let ghost = Snapshot { path: path.clone(), before: PerfModeLines::default() };
        assert!(!restore(&ghost).unwrap());
        assert!(!path.exists());

        for encoding in [Encoding::Utf8, Encoding::Utf8Bom, Encoding::Utf16Le] {
            fs::write(&path, encode(BEFORE, encoding)).unwrap();
            let snap = snapshot(&path).unwrap();
            assert!(!switched_to_es31(&snap));
            fs::write(&path, encode(&BEFORE.replace("ES31=False", "ES31=True"), encoding)).unwrap();
            assert!(switched_to_es31(&snap));
            assert!(restore(&snap).unwrap());
            assert_eq!(fs::read(&path).unwrap(), encode(BEFORE, encoding), "{encoding:?}");
            assert!(!switched_to_es31(&snap));
            // second reset: nothing to do
            assert!(!restore(&snap).unwrap());
        }
        // no temp files left behind
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);

        // ES3.1 was already the default before the launch: not reported
        fs::write(&path, "[D3DRHIPreference]\nbPreferFeatureLevelES31=True\n").unwrap();
        let snap = snapshot(&path).unwrap();
        assert!(!switched_to_es31(&snap));
        let _ = fs::remove_dir_all(&dir);
    }
}
