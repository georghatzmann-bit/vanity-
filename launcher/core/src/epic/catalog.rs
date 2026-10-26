//! The list of builds Niobium can download (`launcher/core/data/build-catalog.json`).
//!
//! Only builds that were complete on Epic's CDN when checked AND that Niobium's game server is
//! meant to run are listed (13.x–18.x and 21.x–30.x). Seasons Epic has deleted parts of are marked
//! "notFromEpic"; a season the server isn't ready for would be "notOfferedYet" (none right now).
//! Nothing from 31.00 on is ever offered (the game server refuses those builds, and the live game
//! must never show up here).

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

use crate::version::{self, MIN_VERSION, SERVER_MAX_EXCLUSIVE};

pub const CATALOG_JSON: &str = include_str!("../../data/build-catalog.json");

/// Where the manifests come from (raw GitHub URLs; `{id}` = manifest id).
pub const POLYNITE_URL: &str = "https://raw.githubusercontent.com/polynite/fn-releases/master/manifests/{id}.manifest";
pub const VASTBLAST_URL: &str =
    "https://raw.githubusercontent.com/VastBlast/FortniteManifestArchive/main/Fortnite/Windows/{id}.manifest";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SeasonStatus {
    Available,
    NotFromEpic,
    NotOfferedYet,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Badge {
    Tested,
    Experimental,
}

/// Card text for a season Epic has deleted files of.
pub const NOTE_NOT_FROM_EPIC: &str = "Epic has deleted part of the files for this season, so no download can get it complete. If you already have this version on your PC, it keeps working. Add it with 'Add a build'.";
/// Card text for a season the game server isn't ready for.
pub const NOTE_NOT_OFFERED_YET: &str = "Niobium's game server isn't ready for this season yet, so it isn't offered.";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogFile {
    pub checked_on: String,
    pub seasons: Vec<SeasonEntry>,
    pub builds: Vec<BuildEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeasonEntry {
    pub chapter: u32,
    /// Number of the season card in its chapter (Chapter 1 "X" = 10, Chapter 4 "OG" = 5).
    pub season: u32,
    pub label: String,
    /// The Fortnite major version of the season (13 = 13.x).
    pub major: u32,
    /// Status when the season has no offered build.
    pub status: SeasonStatus,
    /// One short line about what the season had, shown on its card ("" = none).
    #[serde(default)]
    pub about: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildEntry {
    pub version: String,
    pub cl: u32,
    pub manifest_id: String,
    pub manifest_sha1: String,
    pub manifest_bytes: u64,
    /// "json" or "binary"
    pub format: String,
    pub chunks: u32,
    pub files: u32,
    pub download_bytes: u64,
    pub installed_bytes: u64,
    /// VastBlast has the same file (checked by SHA-1), so it can be the fallback.
    #[serde(default)]
    pub vastblast: bool,
    #[serde(default)]
    pub note: String,
    pub checked_on: String,
}

impl BuildEntry {
    /// "18.30-CL-17882303"
    pub fn key(&self) -> String {
        format!("{}-CL-{}", self.version, self.cl)
    }

    /// polynite first, VastBlast second (only if it has the same file).
    pub fn manifest_urls(&self) -> Vec<String> {
        let mut urls = vec![POLYNITE_URL.replace("{id}", &self.manifest_id)];
        if self.vastblast {
            urls.push(VASTBLAST_URL.replace("{id}", &self.manifest_id));
        }
        urls
    }

    pub fn badge(&self) -> Badge {
        if version::TESTED.contains(&self.version.as_str()) {
            Badge::Tested
        } else {
            Badge::Experimental
        }
    }

    /// Version rule: only what the game server can run, never 31.00 and newer.
    fn allowed(&self) -> bool {
        version::parse_version_number(&self.version).is_some_and(|v| v >= MIN_VERSION && v < SERVER_MAX_EXCLUSIVE)
    }
}

// --- What the UI gets (command `catalog_list`) ---

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub checked_on: String,
    pub chapters: Vec<ChapterOut>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterOut {
    pub chapter: u32,
    pub label: String,
    pub seasons: Vec<SeasonOut>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeasonOut {
    pub season: u32,
    pub label: String,
    /// "13.x"
    pub versions: String,
    pub status: SeasonStatus,
    /// Card text for "notFromEpic" / "notOfferedYet" (empty for "available").
    pub note: String,
    /// One short line about what the season had ("" = none).
    pub about: String,
    pub builds: Vec<BuildOut>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildOut {
    pub key: String,
    pub version: String,
    pub cl: u32,
    pub download_bytes: u64,
    pub installed_bytes: u64,
    pub badge: Badge,
    pub note: String,
}

pub fn parse(json: &str) -> Result<CatalogFile, String> {
    serde_json::from_str(json).map_err(|e| e.to_string())
}

/// The built-in catalog (empty if the file were broken – a test makes sure it isn't).
pub fn builtin() -> &'static CatalogFile {
    static CACHE: OnceLock<CatalogFile> = OnceLock::new();
    CACHE.get_or_init(|| {
        parse(CATALOG_JSON).unwrap_or_else(|e| {
            eprintln!("[Niobium] build-catalog.json is broken: {e}");
            CatalogFile { checked_on: String::new(), seasons: vec![], builds: vec![] }
        })
    })
}

/// A downloadable build by key ("18.30-CL-17882303"). Never anything from 31.00 on.
pub fn find_build(key: &str) -> Option<BuildEntry> {
    builtin().builds.iter().find(|b| b.key() == key && b.allowed()).cloned()
}

/// Chapters → seasons → builds, for the UI.
pub fn catalog() -> Catalog {
    group(builtin())
}

pub fn group(file: &CatalogFile) -> Catalog {
    let max_major = SERVER_MAX_EXCLUSIVE.0;
    let mut chapters: Vec<ChapterOut> = Vec::new();
    for s in file.seasons.iter().filter(|s| s.major < max_major) {
        let builds: Vec<BuildOut> = file
            .builds
            .iter()
            .filter(|b| b.allowed() && version::parse_version_number(&b.version).map(|v| v.0) == Some(s.major))
            .map(|b| BuildOut {
                key: b.key(),
                version: b.version.clone(),
                cl: b.cl,
                download_bytes: b.download_bytes,
                installed_bytes: b.installed_bytes,
                badge: b.badge(),
                note: b.note.clone(),
            })
            .collect();
        let status = if builds.is_empty() {
            match s.status {
                SeasonStatus::Available => SeasonStatus::NotOfferedYet,
                other => other,
            }
        } else {
            SeasonStatus::Available
        };
        let note = match status {
            SeasonStatus::Available => String::new(),
            SeasonStatus::NotFromEpic => NOTE_NOT_FROM_EPIC.into(),
            SeasonStatus::NotOfferedYet => NOTE_NOT_OFFERED_YET.into(),
        };
        let season = SeasonOut {
            season: s.season,
            label: s.label.clone(),
            versions: format!("{}.x", s.major),
            status,
            note,
            about: s.about.clone(),
            builds,
        };
        match chapters.iter_mut().find(|c| c.chapter == s.chapter) {
            Some(c) => c.seasons.push(season),
            None => chapters.push(ChapterOut { chapter: s.chapter, label: format!("Chapter {}", s.chapter), seasons: vec![season] }),
        }
    }
    chapters.sort_by_key(|c| c.chapter);
    for c in &mut chapters {
        c.seasons.sort_by_key(|s| s.season);
    }
    Catalog { checked_on: file.checked_on.clone(), chapters }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_catalog_is_valid() {
        let file = parse(CATALOG_JSON).expect("build-catalog.json parses");
        assert!(!file.builds.is_empty());
        let mut keys = std::collections::HashSet::new();
        for b in &file.builds {
            assert!(keys.insert(b.key()), "{} twice", b.key());
            assert!(b.allowed(), "{} is outside the server's versions", b.key());
            assert_eq!(b.manifest_sha1.len(), 40);
            assert!(b.manifest_sha1.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
            assert!(b.download_bytes > 0 && b.installed_bytes >= b.download_bytes / 2);
            assert!(b.format == "json" || b.format == "binary");
            assert_eq!(b.manifest_urls()[0], format!("https://raw.githubusercontent.com/polynite/fn-releases/master/manifests/{}.manifest", b.manifest_id));
            // the builds the plan offers: 13.30/13.40, 15.00, 16.00, 17.21, 17.50, 18.00–18.30, and
            // 21.x–30.x (only builds whose game exe Epic still has completely)
            let major = version::parse_version_number(&b.version).unwrap().0;
            assert!([13, 15, 16, 17, 18].contains(&major) || (21..=30).contains(&major), "{} is not on the offer list", b.key());
            // 21.x–30.x: none of them is in the VastBlast archive, so polynite is the only source
            if major >= 21 {
                assert!(!b.vastblast && b.format == "binary", "{}", b.key());
                assert_eq!(b.manifest_urls().len(), 1);
            }
            // every build belongs to a season
            assert!(file.seasons.iter().any(|s| s.major == major));
        }
        // the user's main version can't be downloaded: Epic deleted a quarter of its pieces
        assert!(find_build("19.10-CL-18675304").is_none());
        assert!(find_build("18.30-CL-17882303").is_some());
        // 20 main builds plus 7 extra ones for 21.x–30.x, next to the 17 older ones
        assert_eq!(file.builds.len(), 44);
        assert!(find_build("27.11-CL-29739262").is_some());
        assert!(find_build("30.40-CL-35235494").is_some());
        // builds whose game exe Epic deleted are never offered (e.g. 21.00, 22.00, 23.10)
        assert!(file.builds.iter().all(|b| !["21.00", "22.00", "23.10"].contains(&b.version.as_str())));
        // inside a season the builds go from old to new (the picker shows the newest first)
        for pair in file.builds.windows(2) {
            let (a, b) = (&pair[0], &pair[1]);
            let (va, vb) = (version::parse_version_number(&a.version).unwrap(), version::parse_version_number(&b.version).unwrap());
            assert!(va < vb || (va == vb && a.cl < b.cl), "{} comes before {}", a.key(), b.key());
        }
        // a very big build says so (the picker shows that note in the warning colour)
        for b in &file.builds {
            if b.installed_bytes >= 95_000_000_000 {
                assert!(b.note.starts_with("Very big: about "), "{}", b.key());
            }
        }
    }

    #[test]
    fn manifest_pins_of_new_builds() {
        // Spot checks against the research (SHA-1 of the polynite file, its size, chunk count)
        let b = find_build("22.40-CL-23070899").unwrap();
        assert_eq!(b.manifest_id, "yTUVvOU-BiOQgUeuLkavho8cCAt9_g");
        assert_eq!(b.manifest_sha1, "5836b23451f6c8a991121a44407f85bf4bdede3c");
        assert_eq!((b.manifest_bytes, b.chunks), (2_667_116, 38_720));
        let b = find_build("30.10-CL-34399867").unwrap();
        assert_eq!(b.manifest_sha1, "cdd0710c4b41904c9cbe55109a1f668af1d9b419");
        assert_eq!((b.download_bytes, b.installed_bytes), (111_620_737_997, 119_773_345_537));
        assert!(b.note.starts_with("Very big: about 120 GB on disk."));
        assert_eq!(b.manifest_urls(), vec![POLYNITE_URL.replace("{id}", "8mTO_w4sy5ubMXTizEKFD2W6Q5glQw")]);
    }

    #[test]
    fn grouping_and_statuses() {
        let c = catalog();
        let chapters: Vec<u32> = c.chapters.iter().map(|c| c.chapter).collect();
        assert_eq!(chapters, vec![1, 2, 3, 4, 5]);
        let season = |ch: u32, s: u32| c.chapters.iter().find(|x| x.chapter == ch).unwrap().seasons.iter().find(|x| x.season == s).unwrap().clone();
        let ch3s1 = season(3, 1);
        assert_eq!(ch3s1.status, SeasonStatus::NotFromEpic);
        assert_eq!(ch3s1.note, NOTE_NOT_FROM_EPIC);
        assert!(ch3s1.builds.is_empty());
        assert_eq!(ch3s1.versions, "19.x");
        let ch2s8 = season(2, 8);
        assert_eq!(ch2s8.status, SeasonStatus::Available);
        assert!(ch2s8.builds.iter().any(|b| b.key == "18.30-CL-17882303"));
        assert!(ch2s8.builds.iter().all(|b| b.badge == Badge::Experimental));
        assert_eq!(season(1, 10).label, "Season X");
        assert_eq!(season(4, 5).label, "Season OG");
        // 21.x–30.x can be downloaded now: Chapter 3 Seasons 3–4, all of Chapter 4, Chapter 5 Seasons 1–3
        for (ch, s, n) in [(3, 3, 3), (3, 4, 2), (4, 1, 2), (4, 2, 3), (4, 3, 3), (4, 4, 2), (4, 5, 3), (5, 1, 3), (5, 2, 3), (5, 3, 3)] {
            let x = season(ch, s);
            assert_eq!(x.status, SeasonStatus::Available, "Chapter {ch} Season {s}");
            assert_eq!(x.builds.len(), n, "Chapter {ch} Season {s}");
            assert!(x.note.is_empty());
            assert!(!x.about.is_empty(), "Chapter {ch} Season {s} has its line");
            assert!(x.builds.iter().all(|b| b.badge == Badge::Experimental));
        }
        assert_eq!(season(4, 5).versions, "27.x");
        assert!(season(4, 5).builds.iter().any(|b| b.key == "27.11-CL-29739262"));
        // the older seasons have no line (yet)
        assert!(season(2, 8).about.is_empty());
        // nothing in the built-in list is "not offered yet" any more
        assert!(c.chapters.iter().flat_map(|ch| &ch.seasons).all(|s| s.status != SeasonStatus::NotOfferedYet));
        // nothing from 31.00 on, anywhere
        for ch in &c.chapters {
            for s in &ch.seasons {
                assert!(s.versions.trim_end_matches(".x").parse::<u32>().unwrap() < 31);
                for b in &s.builds {
                    assert!(version::parse_version_number(&b.version).unwrap() < SERVER_MAX_EXCLUSIVE);
                }
            }
        }
        let json = serde_json::to_value(&c).unwrap();
        assert_eq!(json["chapters"][2]["seasons"][0]["status"], "notFromEpic");
        assert_eq!(json["chapters"][2]["seasons"][0]["about"], "");
        let b = &json["chapters"][1]["seasons"][7]["builds"][0];
        assert!(b["downloadBytes"].as_u64().unwrap() > 0);
        assert_eq!(b["badge"], "experimental");
        assert_eq!(json["chapters"][3]["seasons"][4]["label"], "Season OG");
        assert!(json["chapters"][3]["seasons"][4]["about"].as_str().unwrap().starts_with("The Chapter 1 map comes back"));
    }

    #[test]
    fn new_builds_are_filtered() {
        let file = parse(
            r#"{"checkedOn":"2026-10-26","seasons":[
                {"chapter":5,"season":4,"label":"Season 4","major":31,"status":"available"},
                {"chapter":5,"season":3,"label":"Season 3","major":30,"status":"notOfferedYet"}],
              "builds":[
                {"version":"31.00","cl":1,"manifestId":"x","manifestSha1":"0000000000000000000000000000000000000000","manifestBytes":1,
                 "format":"binary","chunks":1,"files":1,"downloadBytes":1,"installedBytes":1,"checkedOn":"x"},
                {"version":"30.40","cl":2,"manifestId":"y","manifestSha1":"0000000000000000000000000000000000000000","manifestBytes":1,
                 "format":"binary","chunks":1,"files":1,"downloadBytes":1,"installedBytes":1,"checkedOn":"x"}]}"#,
        )
        .unwrap();
        let c = group(&file);
        assert_eq!(c.chapters.len(), 1);
        assert_eq!(c.chapters[0].seasons.len(), 1, "the 31.x season is never listed");
        assert_eq!(c.chapters[0].seasons[0].status, SeasonStatus::Available);
        assert_eq!(c.chapters[0].seasons[0].builds[0].key, "30.40-CL-2");
        assert_eq!(c.chapters[0].seasons[0].about, "", "a season without the line still loads");
    }

    #[test]
    fn season_without_builds_is_not_offered_yet() {
        // "available" in the file but no build → "notOfferedYet" with its card text
        let file = parse(
            r#"{"checkedOn":"x","seasons":[{"chapter":4,"season":1,"label":"Season 1","major":23,"status":"available","about":"New island."}],"builds":[]}"#,
        )
        .unwrap();
        let s = &group(&file).chapters[0].seasons[0];
        assert_eq!(s.status, SeasonStatus::NotOfferedYet);
        assert_eq!(s.note, NOTE_NOT_OFFERED_YET);
        assert_eq!(s.about, "New island.");
    }
}
