//! Builds the launch arguments for Fortnite.
//!
//! These old builds need fixed placeholder values so they start without Epic's servers and
//! without Easy Anti-Cheat – just like with every OG launcher. Easy Anti-Cheat never runs;
//! the build only ever talks to our own backend on 127.0.0.1.

use serde::Serialize;

/// Cleans a player name (only letters/digits, 1–16 characters).
pub fn clean_player_name(name: &str, fallback: &str) -> String {
    let cleaned: String = name.chars().filter(|c| c.is_ascii_alphanumeric()).take(16).collect();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

/// From this version on Fortnite has no DirectX 11 any more (Chapter 6, December 2024).
/// `-d3d11` would stop the game from starting, so it is left out.
pub const DX11_REMOVED: (u32, u32) = (33, 0);

/// Placeholder tokens that OG launchers have passed with every version since 2021 (publicly known,
/// not a secret). The build doesn't check them with Epic – it only needs the format, because anti-cheat
/// never runs and every request goes to our own backend. Can be overridden in the profile arguments.
pub const FLTOKEN: &str = "3db3ba5dcbd2e16703f3978d";
pub const CALDERA: &str = "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2NvdW50X2lkIjoiYmU5ZGE1YzJmYmVhNDQwN2IyZjQwZWJhYWQ4NTlhZDQiLCJnZW5lcmF0ZWQiOjE2Mzg3MTcyNzgsImNhbGRlcmFHdWlkIjoiMzgxMGI4NjMtMmE2NS00NDU3LTliNTgtNGRhYjNiNDgyYTg2IiwiYWNQcm92aWRlciI6IkVhc3lBbnRpQ2hlYXQiLCJub3RlcyI6IiIsImZhbGxiYWNrIjpmYWxzZX0.VAWQB67RTxhiWOxx7DBjnzDnXyyEnX7OljJm-j2d88G_WgwQ9wrE6lwMEHZHjBd1ISJdUO1UVUqkfLdU5nofBQ";

/// Login domain for the placeholder account (`-AUTH_LOGIN=<name>@niobium.local`).
pub const LOGIN_DOMAIN: &str = "niobium.local";

/// Our own hint for the DLLs: `-niobiumversion=19.10` (Unreal ignores unknown arguments).
pub const VERSION_ARG: &str = "-niobiumversion";

/// Launch argument that starts the game with the low-end ES3.1 renderer ("Performance Mode").
pub const FEATURE_LEVEL_ES31: &str = "-FeatureLevelES31";

/// Can a version show Bubble Builds (the see-through "bubble wrap" build look)?
///
/// Chapter 2: the look only exists in Performance Mode (ES3.1 renderer) on Fortnite 15.40 – 16.00.
/// Epic called it a bug and removed it in 16.10; it came back briefly in 16.20 – 16.40 and was fixed
/// again in 16.50. Builds of 15.30 may be from before Epic's February 2021 patch, when builds were
/// partly invisible.
///
/// Chapter 3 Season 1 (19.x): Performance Mode with Fortnite's own "Meshes" setting on Low gives a
/// similar whiter, more see-through look while builds go up ("low meshes"). Experimental.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BubbleSupport {
    /// 15.40 up to (not including) 16.10
    Supported,
    /// 15.30, and 16.10 up to (not including) 16.50: the look may or may not show up
    Experimental,
    /// 19.00 up to (not including) 20.00: Performance Mode with Meshes set to Low (also experimental)
    LowMeshes,
    /// every other version
    Unavailable,
}

impl BubbleSupport {
    /// Bubble Builds are applied at launch (supported, experimental or low meshes).
    pub fn applies(self) -> bool {
        self != BubbleSupport::Unavailable
    }

    /// The look also needs Fortnite's own `[PerformanceMode] MeshQuality` on Low (0): 15.40 – 16.00
    /// and 19.x. The launcher sets it for the game and puts it back afterwards (see `perfmode`).
    pub fn needs_low_meshes(self) -> bool {
        matches!(self, BubbleSupport::Supported | BubbleSupport::LowMeshes)
    }
}

/// `{ level, note }` for the UI (Tauri command `bubble_builds_support`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BubbleBuildsInfo {
    pub level: BubbleSupport,
    pub note: String,
}

pub const BUBBLE_NOTE_SUPPORTED: &str = "The see-through 'bubble wrap' build look from Chapter 2 Seasons 5–6. Starts the game in Performance Mode (lower graphics). Applies on next launch.";
pub const BUBBLE_NOTE_EXPERIMENTAL: &str =
    "Epic changed how builds look around this version. Your builds may look normal even with this on.";
pub const BUBBLE_NOTE_LOW_MESHES: &str = "Chapter 3 version: starts the game in Performance Mode with Meshes set to Low. Builds look whiter and more see-through while they go up, like 'bubble wrap' builds. The whole game has lower graphics. Applies on next launch.";

/// "Not available for 19.10. Bubble Builds work on …" (`version` empty = "this version").
pub fn bubble_note_unavailable(version: &str) -> String {
    let version = version.trim();
    let which = if version.is_empty() { "this version" } else { version };
    format!(
        "Not available for {which}. Bubble Builds work on 15.40 – 16.00, and as an experiment on Chapter 3 Season 1 (19.x). On other versions, try Bubble look in the F9 menu."
    )
}

/// Bubble Builds status and an English note for one Fortnite version (e.g. "15.40" or "15.4").
pub fn bubble_builds_support(version: &str) -> BubbleBuildsInfo {
    let level = VersionRules::for_version(version).bubble_builds;
    let note = match level {
        BubbleSupport::Supported => BUBBLE_NOTE_SUPPORTED.to_string(),
        BubbleSupport::Experimental => BUBBLE_NOTE_EXPERIMENTAL.to_string(),
        BubbleSupport::LowMeshes => BUBBLE_NOTE_LOW_MESHES.to_string(),
        BubbleSupport::Unavailable => bubble_note_unavailable(version),
    };
    BubbleBuildsInfo { level, note }
}

/// Rules that depend on the Fortnite version. Worked out from the version number, so every
/// version can start – even ones nobody has tested with Niobium yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VersionRules {
    pub major: u32,
    pub minor: u32,
    /// `-d3d11` is allowed (up to Chapter 5)
    pub allows_dx11: bool,
    /// Memory-leak fix in the redirect only for Chapter 1 (Reboot does it below 10; we up to 10.40).
    /// The redirect DLL reads `-niobiumversion=` from the command line for this.
    pub memleak_fix: bool,
    /// Seconds after login until the server DLL is loaded. Builds on Unreal 4.21
    /// (Fortnite 5.x/6.x) crash without a window if the DLL comes too late – there it loads at once.
    pub server_inject_delay_secs: u64,
    /// Seconds after login until the in-game menu is loaded. Unreal 5 builds (20.00 and up)
    /// need a bit longer until the engine objects are ready.
    pub client_inject_delay_secs: u64,
    /// Bubble Builds (Performance Mode) for the player's game, see [`BubbleSupport`].
    pub bubble_builds: BubbleSupport,
}

impl VersionRules {
    pub fn for_version(version: &str) -> VersionRules {
        // "15.4" counts as 15.40 here, so limits like 15.40 work for both spellings.
        let v = crate::version::parse_version_number(version).unwrap_or((0, 0));
        let (major, minor) = v;
        let bubble_builds = if (15, 40) <= v && v < (16, 10) {
            BubbleSupport::Supported
        } else if v == (15, 30) || ((16, 10) <= v && v < (16, 50)) {
            BubbleSupport::Experimental
        } else if (19, 0) <= v && v < (20, 0) {
            BubbleSupport::LowMeshes
        } else {
            BubbleSupport::Unavailable
        };
        VersionRules {
            major,
            minor,
            allows_dx11: v < DX11_REMOVED,
            memleak_fix: (1, 0) <= v && v <= (10, 40),
            server_inject_delay_secs: if (5, 0) <= v && v < (7, 0) { 0 } else { 3 },
            client_inject_delay_secs: if major >= 20 { 8 } else { 6 },
            bubble_builds,
        }
    }
}

/// Bubble Builds are used for this launch: the setting is on, the version can show them, and it is
/// the player's game (never the server/host instance).
pub fn bubble_builds_active(host: bool, bubble_builds_setting: bool, version: &str) -> bool {
    !host && bubble_builds_setting && VersionRules::for_version(version).bubble_builds.applies()
}

/// Builds the argument list. `host` = server instance, `headless` = no graphics,
/// `extra` = extra arguments from the profile (e.g. `-d3d11`). `version` = e.g. "19.10";
/// some arguments depend on it (see `VersionRules`). `bubble_builds` = the Bubble Builds setting;
/// it only changes anything for the player's game on a version that can show them
/// (see [`bubble_builds_active`]). With it off, the arguments are exactly the same as without it.
pub fn build(player_name: &str, host: bool, headless: bool, extra: &str, version: &str, bubble_builds: bool) -> Vec<String> {
    let rules = VersionRules::for_version(version);
    let bubble = bubble_builds_active(host, bubble_builds, version);
    let name = clean_player_name(player_name, if host { "Host" } else { "Player" });
    let login = format!("{name}@{LOGIN_DOMAIN}");

    // Order and values as usual with OG launchers (fixed placeholder token).
    let mut args: Vec<(String, Option<String>)> = vec![
        ("-epicapp".into(), Some("Fortnite".into())),
        ("-epicenv".into(), Some("Prod".into())),
        ("-epiclocale".into(), Some("en-us".into())),
        ("-epicportal".into(), None),
        ("-skippatchcheck".into(), None),
        ("-nobe".into(), None),
        ("-fromfl".into(), Some("eac".into())),
        ("-fltoken".into(), Some(FLTOKEN.into())),
        ("-caldera".into(), Some(CALDERA.into())),
        ("-AUTH_LOGIN".into(), Some(login)),
        ("-AUTH_PASSWORD".into(), Some("niobium".into())),
        ("-AUTH_TYPE".into(), Some("epic".into())),
        ("-log".into(), None),
        // our own hint for the DLLs (Unreal ignores unknown arguments)
        (VERSION_ARG.into(), Some(if version.is_empty() { "0".to_string() } else { version.to_string() })),
    ];

    if host {
        args.push(("-nosplash".into(), None));
        args.push(("-nosound".into(), None));
        if headless {
            args.push(("-nullrhi".into(), None));
        }
    }

    // Extra arguments from the profile; the same key overrides.
    for part in extra.split_whitespace() {
        let (mut k, v) = match part.split_once('=') {
            Some((k, v)) => (k.to_string(), Some(v.to_string())),
            None => (part.to_string(), None),
        };
        // No DirectX 11 any more from Chapter 6 on – the argument would stop the game from starting.
        if !rules.allows_dx11 && (k.eq_ignore_ascii_case("-d3d11") || k.eq_ignore_ascii_case("-dx11")) {
            continue;
        }
        // Bubble Builds: Performance Mode runs on DirectX 11 here (Unreal treats -d3d11 and -d3d12 as
        // mutually exclusive). Only for this launch – the profile itself stays as it is.
        if bubble && (k.eq_ignore_ascii_case("-d3d12") || k.eq_ignore_ascii_case("-dx12")) {
            k = "-d3d11".into();
        }
        if let Some(slot) = args.iter_mut().find(|(ek, _)| ek.eq_ignore_ascii_case(&k)) {
            slot.1 = v;
        } else {
            args.push((k, v));
        }
    }

    // Bubble Builds: start the player's game in Performance Mode (ES3.1 renderer).
    // Never `-sm5`, no ini files, nothing in the build folder.
    if bubble && !args.iter().any(|(k, _)| is_feature_level_es31(k)) {
        args.push((FEATURE_LEVEL_ES31.into(), None));
    }

    args.into_iter()
        .map(|(k, v)| match v {
            Some(v) => format!("{k}={v}"),
            None => k,
        })
        .collect()
}

/// `-FeatureLevelES31` (or the `-FeatureLevelES3_1` spelling), any upper/lower case.
fn is_feature_level_es31(key: &str) -> bool {
    key.eq_ignore_ascii_case(FEATURE_LEVEL_ES31) || key.eq_ignore_ascii_case("-FeatureLevelES3_1")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_names() {
        assert_eq!(clean_player_name("georg", "P"), "georg");
        assert_eq!(clean_player_name("gÖrg 99!", "P"), "grg99");
        assert_eq!(clean_player_name("", "Host"), "Host");
        assert_eq!(clean_player_name("verylongname12345678", "P"), "verylongname1234");
    }

    #[test]
    fn host_has_nullrhi_only_when_headless() {
        let a = build("georg", true, true, "", "19.10", false);
        assert!(a.contains(&"-nullrhi".to_string()));
        assert!(a.contains(&"-nosound".to_string()));
        let b = build("georg", true, false, "", "19.10", false);
        assert!(!b.contains(&"-nullrhi".to_string()));
    }

    #[test]
    fn tokens_and_version_hint_present() {
        let a = build("georg", false, false, "", "19.10", false);
        assert!(a.iter().any(|s| s == &format!("-fltoken={FLTOKEN}")));
        assert!(a.iter().any(|s| s.starts_with("-caldera=eyJ")));
        assert!(a.iter().any(|s| s == "-niobiumversion=19.10"));
        assert!(!a.iter().any(|s| s.to_ascii_lowercase().contains("vanity")));
        // The profile may override the tokens
        let b = build("georg", false, false, "-fltoken=abc", "19.10", false);
        assert!(b.iter().any(|s| s == "-fltoken=abc"));
        assert_eq!(b.iter().filter(|s| s.starts_with("-fltoken")).count(), 1);
    }

    #[test]
    fn version_rules() {
        let r = VersionRules::for_version("5.41");
        assert!(r.memleak_fix && r.server_inject_delay_secs == 0 && r.client_inject_delay_secs == 6);
        let r = VersionRules::for_version("10.40");
        assert!(r.memleak_fix && r.server_inject_delay_secs == 3);
        let r = VersionRules::for_version("11.00");
        assert!(!r.memleak_fix);
        let r = VersionRules::for_version("28.01");
        assert!(!r.memleak_fix && r.client_inject_delay_secs == 8 && r.allows_dx11);
        assert!(!VersionRules::for_version("33.00").allows_dx11);
    }

    #[test]
    fn dx11_dropped_from_chapter_6() {
        let old = build("georg", false, false, "-d3d11", "32.11", false);
        assert!(old.contains(&"-d3d11".to_string()));
        let new = build("georg", false, false, "-d3d11 -nosplash", "33.00", false);
        assert!(!new.contains(&"-d3d11".to_string()));
        assert!(new.contains(&"-nosplash".to_string()));
        assert!(VersionRules::for_version("33.20").major == 33);
        // unreadable version → (0, 0) → DX11 allowed, so old profiles keep working
        assert!(VersionRules::for_version("unknown").allows_dx11);
    }

    #[test]
    fn client_has_no_host_flags() {
        let a = build("georg", false, false, "-d3d11", "19.10", false);
        assert!(!a.contains(&"-nullrhi".to_string()));
        assert!(!a.contains(&"-nosplash".to_string()));
        assert!(a.contains(&"-d3d11".to_string()));
        assert!(a.iter().any(|s| s == "-AUTH_LOGIN=georg@niobium.local"));
    }

    #[test]
    fn extra_overrides_duplicate() {
        let a = build("georg", false, false, "-epiclocale=de", "19.10", false);
        assert!(a.iter().any(|s| s == "-epiclocale=de"));
        assert_eq!(a.iter().filter(|s| s.starts_with("-epiclocale")).count(), 1);
    }

    // --- Bubble Builds -------------------------------------------------------------------------

    fn has_es31(args: &[String]) -> bool {
        args.iter().any(|s| s == FEATURE_LEVEL_ES31)
    }

    #[test]
    fn bubble_version_gate() {
        use BubbleSupport::*;
        let level = |v: &str| VersionRules::for_version(v).bubble_builds;
        // supported: 15.40 <= v < 16.10 (also written with a one-digit minor version)
        for v in ["15.40", "15.4", "15.41", "15.50", "15.5", "16.00", "16.0", "16.0.1"] {
            assert_eq!(level(v), Supported, "{v}");
        }
        // experimental: 15.30, and 16.10 <= v < 16.50
        for v in ["15.30", "15.3", "16.10", "16.1", "16.20", "16.30", "16.40", "16.4"] {
            assert_eq!(level(v), Experimental, "{v}");
        }
        // Chapter 3 Season 1: 19.00 <= v < 20.00 (Performance Mode with Meshes set to Low)
        for v in ["19.00", "19", "19.0", "19.01", "19.10", "19.1", "19.20", "19.30", "19.40", "19.4", "19.99"] {
            assert_eq!(level(v), LowMeshes, "{v}");
        }
        // everything else
        for v in ["15.10", "15.20", "15.21", "15.31", "16.50", "16.5", "17.00", "18.40", "20.00", "20.0", "20.10", "12.41", "1.7.2", "", "Cert"] {
            assert_eq!(level(v), Unavailable, "{v}");
        }
        // only 15.40 – 16.00 and 19.x also need Meshes on Low
        assert!(Supported.needs_low_meshes() && LowMeshes.needs_low_meshes());
        assert!(!Experimental.needs_low_meshes() && !Unavailable.needs_low_meshes());
        assert!(LowMeshes.applies());
    }

    #[test]
    fn bubble_off_gives_todays_args() {
        // Toggle off: exactly the same as before, on every version, for client and host.
        for v in ["15.40", "16.00", "16.20", "19.10"] {
            for (host, headless) in [(false, false), (true, true), (true, false)] {
                for extra in ["", "-d3d11", "-d3d12 -nosplash", "-dx12"] {
                    let off = build("georg", host, headless, extra, v, false);
                    assert!(!has_es31(&off), "{v} {extra}");
                    // -d3d12 is not touched when the setting is off
                    if extra.contains("-d3d12") {
                        assert!(off.contains(&"-d3d12".to_string()));
                    }
                }
            }
        }
    }

    #[test]
    fn bubble_only_for_the_client_in_the_window() {
        let a = build("georg", false, false, "-d3d11", "15.40", true);
        assert!(has_es31(&a));
        assert_eq!(a.iter().filter(|s| s.eq_ignore_ascii_case(FEATURE_LEVEL_ES31)).count(), 1);
        // experimental versions also get it
        assert!(has_es31(&build("georg", false, false, "", "16.20", true)));
        assert!(has_es31(&build("georg", false, false, "", "15.3", true)));
        // never for the host (headless or not)
        assert!(!has_es31(&build("georg", true, true, "", "15.40", true)));
        assert!(!has_es31(&build("georg", true, false, "", "15.40", true)));
        // 19.x (low meshes) gets it too, exactly once, and never for the host
        let low = build("georg", false, false, "-d3d11", "19.10", true);
        assert!(has_es31(&low));
        assert_eq!(low.iter().filter(|s| s.eq_ignore_ascii_case(FEATURE_LEVEL_ES31)).count(), 1);
        assert!(!has_es31(&build("georg", true, true, "", "19.10", true)));
        assert!(!has_es31(&build("georg", true, false, "-d3d12", "19.10", true)));
        // not outside the windows
        assert!(!has_es31(&build("georg", false, false, "", "16.50", true)));
        assert!(!has_es31(&build("georg", false, false, "", "18.40", true)));
        assert!(!has_es31(&build("georg", false, false, "", "20.00", true)));
        assert!(!has_es31(&build("georg", false, false, "", "15.20", true)));
        // never -sm5
        for v in ["15.40", "16.20", "19.10"] {
            for host in [false, true] {
                assert!(!build("georg", host, false, "-d3d12", v, true).iter().any(|s| s.eq_ignore_ascii_case("-sm5")));
            }
        }
    }

    #[test]
    fn bubble_swaps_dx12_for_dx11() {
        let a = build("georg", false, false, "-d3d12 -nosplash", "15.50", true);
        assert!(a.contains(&"-d3d11".to_string()));
        assert!(!a.iter().any(|s| s.eq_ignore_ascii_case("-d3d12")));
        assert!(a.contains(&"-nosplash".to_string()));
        let b = build("georg", false, false, "-dx12", "16.00", true);
        assert!(b.contains(&"-d3d11".to_string()));
        assert!(!b.iter().any(|s| s.eq_ignore_ascii_case("-dx12")));
        // both in the profile: only one -d3d11 is left
        let c = build("georg", false, false, "-d3d11 -D3D12", "15.40", true);
        assert_eq!(c.iter().filter(|s| s.eq_ignore_ascii_case("-d3d11")).count(), 1);
        assert!(!c.iter().any(|s| s.eq_ignore_ascii_case("-d3d12")));
        // the host keeps its arguments
        let host = build("georg", true, true, "-d3d12", "15.40", true);
        assert!(host.contains(&"-d3d12".to_string()));
        // 19.10 (low meshes): DirectX 12 becomes 11 as well, the host keeps its arguments
        let low = build("georg", false, false, "-d3d12 -nosplash", "19.10", true);
        assert!(low.contains(&"-d3d11".to_string()));
        assert!(!low.iter().any(|s| s.eq_ignore_ascii_case("-d3d12")));
        let low_dx = build("georg", false, false, "-dx12", "19.10", true);
        assert!(low_dx.contains(&"-d3d11".to_string()) && !low_dx.iter().any(|s| s.eq_ignore_ascii_case("-dx12")));
        assert!(build("georg", true, false, "-d3d12", "19.10", true).contains(&"-d3d12".to_string()));
        // outside the windows nothing is swapped
        let late = build("georg", false, false, "-d3d12", "20.00", true);
        assert!(late.contains(&"-d3d12".to_string()));
        let mid = build("georg", false, false, "-d3d12", "17.50", true);
        assert!(mid.contains(&"-d3d12".to_string()));
    }

    #[test]
    fn bubble_flag_not_doubled() {
        for extra in ["-FeatureLevelES31", "-featurelevelES31", "-FeatureLevelES3_1"] {
            let a = build("georg", false, false, extra, "15.40", true);
            let count = a.iter().filter(|s| is_feature_level_es31(s)).count();
            assert_eq!(count, 1, "{extra}: {a:?}");
        }
    }

    #[test]
    fn bubble_info_for_ui() {
        let s = bubble_builds_support("15.40");
        assert_eq!(s.level, BubbleSupport::Supported);
        assert!(s.note.contains("bubble wrap"));
        assert_eq!(bubble_builds_support("16.20").level, BubbleSupport::Experimental);
        assert!(bubble_builds_support("16.20").note.starts_with("Epic changed"));
        // 19.10 is the experimental Chapter 3 level now
        let low = bubble_builds_support("19.10");
        assert_eq!(low.level, BubbleSupport::LowMeshes);
        assert!(low.note.starts_with("Chapter 3 version") && low.note.contains("Meshes set to Low"));
        // other versions name the version and point to Bubble look
        let none = bubble_builds_support("12.41");
        assert_eq!(none.level, BubbleSupport::Unavailable);
        assert!(none.note.starts_with("Not available for 12.41."), "{}", none.note);
        assert!(none.note.contains("Bubble look in the F9 menu") && none.note.contains("(19.x)"));
        assert!(bubble_builds_support("").note.starts_with("Not available for this version."));
        let json = serde_json::to_value(bubble_builds_support("15.4")).unwrap();
        assert_eq!(json["level"], "supported");
        assert_eq!(serde_json::to_value(BubbleSupport::Unavailable).unwrap(), "unavailable");
        assert_eq!(serde_json::to_value(BubbleSupport::Experimental).unwrap(), "experimental");
        assert_eq!(serde_json::to_value(BubbleSupport::LowMeshes).unwrap(), "lowMeshes");
        assert_eq!(serde_json::to_value(bubble_builds_support("19.10")).unwrap()["level"], "lowMeshes");
    }
}
