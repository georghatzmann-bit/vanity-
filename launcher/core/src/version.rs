//! Erkennt, welche Fortnite-Version in einem Build-Ordner liegt.
//!
//! Vorgehen (wie bei Reboot nachgelesen, aber neu geschrieben):
//! 1. `FortniteClient-Win64-Shipping.exe` im Ordner suchen.
//! 2. Die Versionszeile `++Fortnite+Release-19.10-CL-18675304` aus den Datei-Infos von
//!    `CrashReportClient.exe` bzw. der Spiel-exe lesen.
//! 3. Ersatzweise die Spiel-exe nach genau dieser Zeichenfolge (UTF-16) durchsuchen.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const SHIPPING_EXE: &str = "FortniteClient-Win64-Shipping.exe";
pub const LAUNCHER_EXE: &str = "FortniteLauncher.exe";
pub const EAC_EXE: &str = "FortniteClient-Win64-Shipping_EAC.exe";
pub const CRASH_REPORT_EXE: &str = "CrashReportClient.exe";
pub const AFTERMATH_DLL: &str = "GFSDK_Aftermath_Lib.dll";

/// Versionen, die wirklich getestet wurden (von dir bestätigt). Nur die bekommen „getestet“.
pub const TESTED: &[&str] = &["19.10"];
/// Älteste Version, mit der die Bauteile (Umleitung aus Tellurium, Game Server aus Erbium/Magnesium)
/// umgehen können. Alles ab hier wird gestartet – ungetestete Versionen mit Hinweis.
pub const MIN_VERSION: (u32, u32) = (1, 7);
/// Ab hier lehnt der Game Server (Erbium/Magnesium, `SDK/Offsets.h`: MaximumSupportedFortniteVersionExclusive)
/// den Build selbst ab – Hosten geht dort nicht, also starten wir solche Builds nicht.
pub const SERVER_MAX_EXCLUSIVE: (u32, u32) = (31, 0);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionString {
    pub version: String,
    pub changelist: Option<u32>,
    pub engine: Option<String>,
    pub raw: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    pub id: String,
    pub version: String,
    pub changelist: Option<u32>,
    pub season: String,
    pub engine: String,
    /// Ordner, den der Nutzer gewählt hat
    pub path: String,
    /// Ordner mit der Spiel-exe (…\FortniteGame\Binaries\Win64)
    pub binaries: String,
    pub support: Support,
    /// Erklärung zur Stufe in einfachen Worten (siehe `support_note`)
    #[serde(default)]
    pub support_note: String,
    #[serde(default)]
    pub launch_args: String,
}

/// Wie gut Vanity eine Version kennt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Support {
    /// getestet – darauf ist alles abgestimmt
    Supported,
    /// die Bauteile kennen die Version, getestet wurde sie nicht – Start wird versucht
    Experimental,
    /// zu alt (vor `MIN_VERSION`) oder Version unlesbar
    Unsupported,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub ok: bool,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectReport {
    pub build: Option<BuildInfo>,
    pub checks: Vec<Check>,
    pub has_aftermath: bool,
}

/// Liest „19.10“ und die Changelist aus einer Fortnite-Versionszeile.
///
/// Mögliche Formen:
/// - `++Fortnite+Release-19.10-CL-18675304`
/// - `5.0.0-18675304+++Fortnite+Release-19.10`
/// - `4.19.0-3870737+++Fortnite+Release-Next` (Version über die Changelist-Tabelle)
pub fn parse_version_string(raw: &str) -> Option<VersionString> {
    let raw = raw.trim().trim_matches('\0');
    let idx = raw.find("++Fortnite+Release-")?;
    let after = &raw[idx + "++Fortnite+Release-".len()..];

    // Engine-Teil vorne: "5.0.0-18675304+"
    let (engine, engine_cl) = {
        let head = raw[..idx].trim_end_matches('+');
        let mut parts = head.splitn(2, '-');
        let e = parts.next().filter(|s| !s.is_empty()).map(str::to_string);
        let cl = parts.next().and_then(|s| s.parse::<u32>().ok());
        (e, cl)
    };

    // Release-Teil: "19.10-CL-18675304" oder "19.10" oder "Cert"/"Next"
    let mut release = after;
    let mut cl = engine_cl;
    if let Some(pos) = after.find("-CL-") {
        release = &after[..pos];
        let digits: String = after[pos + 4..].chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(n) = digits.parse() {
            cl = Some(n);
        }
    }
    let release: String = release
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '.')
        .collect();

    let version = if release.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        normalize_version(&release)
    } else {
        // "Cert", "Next" usw. → Version über die Changelist
        cl.and_then(version_for_changelist)?.to_string()
    };

    Some(VersionString { version, changelist: cl, engine, raw: raw.to_string() })
}

/// „19.1“ → „19.10“, „4.5“ bleibt „4.5“ (Fortnite schreibt zweistellige Unterversionen ab 5.0).
fn normalize_version(v: &str) -> String {
    let mut parts = v.split('.');
    let major: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let minor = parts.next().unwrap_or("0");
    if major >= 5 && minor.len() == 1 {
        format!("{major}.{minor}0")
    } else {
        format!("{major}.{minor}")
    }
}

/// Changelist → Version für Builds, deren Versionszeile nur „Cert“/„Next“ enthält.
/// Quelle der Zuordnung: öffentliche Build-Liste (github.com/polynite/fn-releases).
fn version_for_changelist(cl: u32) -> Option<&'static str> {
    const TABLE: &[(u32, &str)] = &[
        (3668626, "1.6.4"), (3681159, "1.7"), (3700114, "1.7.2"), (3724489, "1.8"), (3729133, "1.8.1"), (3741772, "1.8.2"),
        (3757339, "1.9"), (3775276, "1.9.1"), (3790078, "1.10"), (3807424, "1.11"),
        (3825894, "2.1"), (3841827, "2.2"), (3847564, "2.3"), (3858292, "2.4"),
        (3870737, "2.4.2"), (3889387, "2.5"), (3901517, "3.0"), (3915963, "3.1"),
        (3917250, "3.1.1"), (3935073, "3.2"), (3942182, "3.3"), (4008490, "3.5"),
        (4019403, "3.6"), (4039451, "4.0"), (4053532, "4.1"), (4072250, "4.2"),
        (4117433, "4.4"), (4127312, "4.4.1"), (4159770, "4.5"),
        (18675304, "19.10"),
    ];
    TABLE.iter().find(|(c, _)| *c == cl).map(|(_, v)| *v)
}

/// Chapter/Season zu einer Version, z. B. 19.10 → „Chapter 3 · Season 1“.
pub fn season_for(version: &str) -> String {
    let major: u32 = version.split('.').next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let (chapter, season) = match major {
        1..=10 => (1, if major == 10 { "X".to_string() } else { major.to_string() }),
        11..=18 => (2, (major - 10).to_string()),
        19..=22 => (3, (major - 18).to_string()),
        23..=27 => (4, if major == 27 { "OG".to_string() } else { (major - 22).to_string() }),
        28..=32 => (5, if major == 32 { "Remix".to_string() } else { (major - 27).to_string() }),
        33..=36 => (6, (major - 32).to_string()),
        0 => return "Unbekannte Season".to_string(),
        _ => return format!("Version {major} · neuere Season"),
    };
    format!("Chapter {chapter} · Season {season}")
}

/// „19.10“ → (19, 10); „1.7.2“ → (1, 7). None, wenn vorne keine Zahl steht.
pub fn parse_major_minor(version: &str) -> Option<(u32, u32)> {
    let mut parts = version.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    Some((major, minor))
}

pub fn support_for(version: &str, _changelist: Option<u32>) -> Support {
    if TESTED.contains(&version) {
        return Support::Supported;
    }
    match parse_major_minor(version) {
        Some(v) if v >= MIN_VERSION && v < SERVER_MAX_EXCLUSIVE => Support::Experimental,
        _ => Support::Unsupported,
    }
}

/// Kurze Erklärung zur Stufe in einfachen Worten – für Bibliothek und Prüf-Dialog.
/// Die Grenzen stammen aus dem Quellcode der Bauteile (siehe docs/02-architektur.md, „Versionen“).
pub fn support_note(version: &str) -> String {
    let Some(v) = parse_major_minor(version) else {
        return "Version unlesbar".into();
    };
    if v < MIN_VERSION {
        return format!("zu alt – Vanity braucht mindestens {}.{}", MIN_VERSION.0, MIN_VERSION.1);
    }
    if v >= SERVER_MAX_EXCLUSIVE {
        return format!(
            "zu neu – der Game Server (Erbium/Magnesium) kennt Versionen nur bis {}.x; sobald die Quellprojekte nachziehen, kommt sie dazu",
            SERVER_MAX_EXCLUSIVE.0 - 1
        );
    }
    if TESTED.contains(&version) {
        return "getestet".into();
    }
    let mut notes = vec!["ungetestet – Start wird versucht".to_string()];
    if v < (3, 4) {
        notes.push("sehr alter Build – Erbium nennt die Unterstützung „teilweise“".into());
    }
    if (9, 40) <= v && v <= (10, 40) {
        notes.push("kein Party-System/XMPP (diese Builds vertragen keine Hotfix-Dateien vom Backend)".into());
    }
    if v >= (24, 30) {
        notes.push("Edit/Reset on Release gibt es im Menü ab 24.30 nicht mehr".into());
    } else if v >= (15, 20) {
        notes.push("den Pre-Edits-Schalter gibt es ab 15.20 nicht mehr".into());
    }
    if v >= (20, 0) {
        notes.push("Erbium nennt die Unterstützung ab 20.00 „teilweise“".into());
    }
    notes.join(" · ")
}

/// Sucht eine Datei mit genau diesem Namen unterhalb von `root` (höchstens `depth` Ebenen tief).
pub fn find_file(root: &Path, name: &str, depth: usize) -> Option<PathBuf> {
    let direct = root.join(name);
    if direct.is_file() {
        return Some(direct);
    }
    if depth == 0 {
        return None;
    }
    let entries = fs::read_dir(root).ok()?;
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    // Bekannte Unterordner zuerst, damit die Suche schnell ist
    dirs.sort_by_key(|p| {
        let n = p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
        match n.as_str() {
            "fortnitegame" | "binaries" | "win64" | "engine" => 0,
            "content" | "paks" | "saved" => 2,
            _ => 1,
        }
    });
    dirs.iter().find_map(|d| find_file(d, name, depth - 1))
}

/// Sucht die UTF-16-Zeichenfolge `++Fortnite+Release-…` in einer Datei.
pub fn scan_file_for_version(path: &Path) -> Option<VersionString> {
    let bytes = fs::read(path).ok()?;
    scan_bytes_for_version(&bytes)
}

pub fn scan_bytes_for_version(bytes: &[u8]) -> Option<VersionString> {
    let needle: Vec<u8> = "++Fortnite+Release-".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let mut start = 0;
    while let Some(pos) = find_bytes(&bytes[start..], &needle) {
        let at = start + pos;
        // Rückwärts bis zum Anfang der Zeichenfolge (Engine-Version kann davor stehen)
        let mut begin = at;
        while begin >= 2 {
            let ch = u16::from_le_bytes([bytes[begin - 2], bytes[begin - 1]]);
            if ch == 0 || !(0x20..0x7f).contains(&ch) {
                break;
            }
            begin -= 2;
        }
        let mut end = at;
        while end + 1 < bytes.len() {
            let ch = u16::from_le_bytes([bytes[end], bytes[end + 1]]);
            if ch == 0 || !(0x20..0x7f).contains(&ch) {
                break;
            }
            end += 2;
        }
        let units: Vec<u16> = bytes[begin..end].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let text = String::from_utf16_lossy(&units);
        if let Some(v) = parse_version_string(&text) {
            return Some(v);
        }
        start = at + needle.len();
    }
    None
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    let first = needle[0];
    let mut i = 0;
    while i + needle.len() <= haystack.len() {
        match haystack[i..].iter().position(|&b| b == first) {
            None => return None,
            Some(off) => {
                i += off;
                if i + needle.len() <= haystack.len() && &haystack[i..i + needle.len()] == needle {
                    return Some(i);
                }
                i += 1;
            }
        }
    }
    None
}

/// Liest alle Text-Einträge aus den Versions-Infos einer exe (Windows-Ressource).
/// `pelite` nur unter Windows; sonst greift die Suche in der Datei.
#[cfg(windows)]
fn version_info_strings(path: &Path) -> Vec<String> {
    use pelite::pe64::{Pe, PeFile};
    let Ok(map) = pelite::FileMap::open(path) else { return vec![] };
    let Ok(file) = PeFile::from_bytes(&map) else { return vec![] };
    let Ok(resources) = file.resources() else { return vec![] };
    let Ok(info) = resources.version_info() else { return vec![] };
    let mut out = Vec::new();
    for lang in info.translation() {
        info.strings(*lang, |_key, value| out.push(value.to_string()));
    }
    out
}

#[cfg(not(windows))]
fn version_info_strings(_path: &Path) -> Vec<String> {
    Vec::new()
}

/// Ermittelt die Version: erst Datei-Infos, dann Suche in der exe.
pub fn detect_version(shipping_exe: &Path, crash_report_exe: Option<&Path>) -> Option<VersionString> {
    let mut candidates: Vec<&Path> = Vec::new();
    if let Some(c) = crash_report_exe {
        candidates.push(c);
    }
    candidates.push(shipping_exe);
    for exe in &candidates {
        for s in version_info_strings(exe) {
            if let Some(v) = parse_version_string(&s) {
                return Some(v);
            }
        }
    }
    candidates.iter().find_map(|exe| scan_file_for_version(exe))
}

/// Prüft einen gewählten Ordner und liefert Ergebnis + einzelne Prüfschritte für die Oberfläche.
pub fn detect_build(folder: &Path) -> DetectReport {
    let mut checks = Vec::new();
    let fail = |checks: &mut Vec<Check>, text: String| {
        checks.push(Check { ok: false, text });
        DetectReport { build: None, checks: checks.clone(), has_aftermath: false }
    };

    if !folder.is_dir() {
        return fail(&mut checks, "Ordner nicht gefunden".into());
    }
    let Some(exe) = find_file(folder, SHIPPING_EXE, 6) else {
        return fail(&mut checks, format!("{SHIPPING_EXE} nicht gefunden – ist das der richtige Ordner?"));
    };
    checks.push(Check { ok: true, text: format!("{SHIPPING_EXE} gefunden") });

    let binaries = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    // Build-Wurzel = Ordner über „FortniteGame“
    let root = binaries
        .ancestors()
        .find(|p| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("FortniteGame")))
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| folder.to_path_buf());

    let crash_exe = find_file(&root.join("Engine"), CRASH_REPORT_EXE, 4);
    let Some(v) = detect_version(&exe, crash_exe.as_deref()) else {
        return fail(&mut checks, "Version konnte nicht gelesen werden".into());
    };
    let cl_text = v.changelist.map(|c| format!(" (CL-{c})")).unwrap_or_default();
    checks.push(Check { ok: true, text: format!("Version gelesen: {}{}", v.version, cl_text) });

    let paks = root.join("FortniteGame").join("Content").join("Paks");
    let pak_count = fs::read_dir(&paks)
        .map(|d| {
            d.filter_map(Result::ok)
                .filter(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("pak")))
                .count()
        })
        .unwrap_or(0);
    checks.push(Check {
        ok: pak_count > 0,
        text: if pak_count > 0 {
            format!("Spieldaten vorhanden ({pak_count} .pak-Dateien)")
        } else {
            "Keine Spieldaten (.pak) gefunden – Build unvollständig?".into()
        },
    });

    let support = support_for(&v.version, v.changelist);
    let note = support_note(&v.version);
    checks.push(Check { ok: support != Support::Unsupported, text: format!("Version {}: {}", v.version, note) });

    let engine = v
        .engine
        .as_deref()
        .map(|e| {
            let short: Vec<&str> = e.split('.').take(2).collect();
            format!("Unreal Engine {}", short.join("."))
        })
        .unwrap_or_else(|| "Unreal Engine (unbekannt)".into());

    let has_aftermath = find_file(&root, AFTERMATH_DLL, 6).is_some();

    let build = BuildInfo {
        id: format!("{}-{}", v.version, v.changelist.unwrap_or(0)),
        season: season_for(&v.version),
        version: v.version,
        changelist: v.changelist,
        engine,
        path: root.to_string_lossy().into_owned(),
        binaries: binaries.to_string_lossy().into_owned(),
        support,
        support_note: note,
        launch_args: "-d3d11".into(),
    };
    DetectReport { build: Some(build), checks, has_aftermath }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_release_with_cl() {
        let v = parse_version_string("++Fortnite+Release-19.10-CL-18675304").unwrap();
        assert_eq!(v.version, "19.10");
        assert_eq!(v.changelist, Some(18675304));
        assert_eq!(v.engine, None);
    }

    #[test]
    fn parses_engine_prefix() {
        let v = parse_version_string("5.0.0-18675304+++Fortnite+Release-19.10").unwrap();
        assert_eq!(v.version, "19.10");
        assert_eq!(v.changelist, Some(18675304));
        assert_eq!(v.engine.as_deref(), Some("5.0.0"));
    }

    #[test]
    fn parses_cert_via_table() {
        let v = parse_version_string("4.19.0-3870737+++Fortnite+Release-Next").unwrap();
        assert_eq!(v.version, "2.4.2");
    }

    #[test]
    fn normalizes_single_digit_minor() {
        let v = parse_version_string("++Fortnite+Release-19.1-CL-18675304").unwrap();
        assert_eq!(v.version, "19.10");
        let old = parse_version_string("4.20.0-4008490+++Fortnite+Release-3.5").unwrap();
        assert_eq!(old.version, "3.5");
    }

    #[test]
    fn rejects_other_strings() {
        assert!(parse_version_string("Unreal Engine 5").is_none());
    }

    #[test]
    fn seasons() {
        assert_eq!(season_for("19.10"), "Chapter 3 · Season 1");
        assert_eq!(season_for("10.40"), "Chapter 1 · Season X");
        assert_eq!(season_for("12.41"), "Chapter 2 · Season 2");
    }

    #[test]
    fn support_tiers() {
        assert_eq!(support_for("19.10", Some(18675304)), Support::Supported);
        assert_eq!(support_for("19.40", None), Support::Experimental);
        assert_eq!(support_for("30.00", None), Support::Experimental);
        assert_eq!(support_for("1.7.2", None), Support::Experimental);
        assert_eq!(support_for("1.6", None), Support::Unsupported);
        assert_eq!(support_for("Cert", None), Support::Unsupported);
        assert_eq!(support_for("30.40", None), Support::Experimental);
        assert_eq!(support_for("31.00", None), Support::Unsupported);
        assert!(support_note("33.00").contains("zu neu"));
        assert!(support_note("1.6").contains("zu alt"));
        assert!(support_note("10.40").contains("XMPP"));
        assert_eq!(support_note("19.10"), "getestet");
        assert_eq!(parse_version_string("4.16.0-3681159+++Fortnite+Release-Cert").unwrap().version, "1.7");
        assert_eq!(parse_major_minor("33.20"), Some((33, 20)));
        assert_eq!(season_for("33.20"), "Chapter 6 · Season 1");
        assert_eq!(season_for("32.00"), "Chapter 5 · Season Remix");
        assert_eq!(season_for("40.00"), "Version 40 · neuere Season");
    }

    #[test]
    fn scans_utf16_in_binary() {
        let mut bytes = vec![0u8; 64];
        let s = "5.0.0-18675304+++Fortnite+Release-19.10";
        bytes.extend(s.encode_utf16().flat_map(|u| u.to_le_bytes()));
        bytes.extend([0, 0, 1, 2, 3]);
        let v = scan_bytes_for_version(&bytes).unwrap();
        assert_eq!(v.version, "19.10");
        assert_eq!(v.engine.as_deref(), Some("5.0.0"));
    }

    #[test]
    fn detects_fake_build_folder() {
        let dir = std::env::temp_dir().join(format!("vanity-test-{}", std::process::id()));
        let bin = dir.join("FortniteGame/Binaries/Win64");
        let paks = dir.join("FortniteGame/Content/Paks");
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(&paks).unwrap();
        let mut exe = b"MZ not a real pe".to_vec();
        exe.extend("++Fortnite+Release-19.10-CL-18675304".encode_utf16().flat_map(|u| u.to_le_bytes()));
        exe.extend([0, 0]);
        fs::write(bin.join(SHIPPING_EXE), exe).unwrap();
        fs::write(paks.join("pakchunk0-WindowsClient.pak"), b"x").unwrap();
        fs::write(bin.join(AFTERMATH_DLL), b"x").unwrap();

        let report = detect_build(&dir);
        let build = report.build.expect("build erkannt");
        assert_eq!(build.version, "19.10");
        assert_eq!(build.support, Support::Supported);
        assert_eq!(build.season, "Chapter 3 · Season 1");
        assert!(report.has_aftermath);
        assert!(report.checks.iter().all(|c| c.ok), "{:?}", report.checks);
        fs::remove_dir_all(&dir).ok();
    }
}
