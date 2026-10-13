//! Bilder: Steam (ohne Schlüssel) und SteamGridDB herunterladen, Icons aus der `.exe`,
//! im Cache ablegen, Farbpalette berechnen.

use std::fs;
use std::path::{Path, PathBuf};

use image::{DynamicImage, ImageFormat, ImageReader};
use serde_json::Value;
use tauri::State;

use crate::error::{blocking, http_status_err, io_err, net_err, CmdResult};
use crate::models::{
    GameImages, GamePalette, ImageFetchRequest, ImageFetchResult, ImageKind, SavedImage, SgdbGame,
    SgdbImage,
};
use crate::state::Shared;
use crate::util::{clean_path, display_path, dir_size, hash8, mtime_ms, write_atomic};

const STEAM_HOSTS: [&str; 2] = [
    "https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/",
    "https://cdn.cloudflare.steamstatic.com/steam/apps/",
];
/// Aktuelle Bildpfade (mit Hash) und das Icon eines Steam-Spiels – öffentlich, ohne Schlüssel
const STEAM_ITEMS_API: &str = "https://api.steampowered.com/IStoreBrowseService/GetItems/v1/";
/// Steam-Shop-Suche per Name – öffentlich, ohne Schlüssel
const STEAM_SEARCH_API: &str = "https://store.steampowered.com/api/storesearch/";
/// Zweite Steam-Suche (findet auch Spiele, die der Shop ausblendet) – öffentlich, ohne Schlüssel
const STEAM_COMMUNITY_SEARCH: &str = "https://steamcommunity.com/actions/SearchApps/";
const STEAM_ASSET_HOST: &str = "https://shared.steamstatic.com/store_item_assets/";
const STEAM_ICON_HOST: &str = "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/";
const SGDB_API: &str = "https://www.steamgriddb.com/api/v2";
const MAX_IMAGE_BYTES: usize = 40 * 1024 * 1024;
const SGDB_INVALID_KEY: &str = "SteamGridDB-Schlüssel ungültig";

// =============================================================================================
// Farbpalette
// =============================================================================================

fn rgb_to_hsl(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let (r, g, b) = (r / 255.0, g / 255.0, b / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    if (max - min).abs() < f32::EPSILON {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
    let h = if max == r {
        ((g - b) / d) % 6.0
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    let mut h = h * 60.0;
    if h < 0.0 {
        h += 360.0;
    }
    (h, s, l)
}

fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (u8, u8, u8) {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = (h.rem_euclid(360.0)) / 60.0;
    let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
    let (r1, g1, b1) = match hp as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    let conv = |v: f32| ((v + m) * 255.0).round().clamp(0.0, 255.0) as u8;
    (conv(r1), conv(g1), conv(b1))
}

fn hex((r, g, b): (u8, u8, u8)) -> String {
    format!("#{r:02x}{g:02x}{b:02x}")
}

fn hue_distance(a: f32, b: f32) -> f32 {
    let d = (a - b).abs() % 360.0;
    d.min(360.0 - d)
}

/// Standardpalette (Nova-Farben), wenn das Bild kaum Farbe enthält.
pub fn default_palette() -> GamePalette {
    GamePalette {
        primary: "#ff4f8b".into(),
        secondary: "#7c5cff".into(),
        dark: "#0b0b12".into(),
    }
}

/// Kräftige Haupt-, eine abgesetzte Zweit- und eine sehr dunkle Hintergrundfarbe bestimmen.
pub fn palette_from_image(img: &DynamicImage) -> GamePalette {
    const BINS: usize = 24;
    #[derive(Clone, Copy, Default)]
    struct Bin {
        score: f32,
        count: u32,
        r: f32,
        g: f32,
        b: f32,
    }
    let small = img.thumbnail(48, 48).to_rgba8();
    let mut bins = [Bin::default(); BINS];
    let mut total = 0u32;
    for px in small.pixels() {
        if px[3] < 128 {
            continue;
        }
        total += 1;
        let (r, g, b) = (px[0] as f32, px[1] as f32, px[2] as f32);
        let (h, s, l) = rgb_to_hsl(r, g, b);
        if s < 0.2 || !(0.12..=0.88).contains(&l) {
            continue;
        }
        let idx = ((h / (360.0 / BINS as f32)) as usize).min(BINS - 1);
        // Gewicht: kräftig (Sättigung) und mittlere Helligkeit bevorzugen
        let w = s * (1.0 - (l - 0.55).abs() * 1.5).max(0.15);
        let bin = &mut bins[idx];
        bin.score += w;
        bin.count += 1;
        bin.r += r * w;
        bin.g += g * w;
        bin.b += b * w;
    }
    let colorful: u32 = bins.iter().map(|b| b.count).sum();
    if total == 0 || colorful < (total * 3 / 100).max(3) {
        return default_palette();
    }
    let avg = |b: &Bin| {
        let w = b.score.max(f32::EPSILON);
        rgb_to_hsl(b.r / w, b.g / w, b.b / w)
    };
    let (pi, primary_bin) = bins
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.score.total_cmp(&b.1.score))
        .map(|(i, b)| (i, *b))
        .unwrap_or_default();
    let (ph, ps, pl) = avg(&primary_bin);
    let primary = hsl_to_rgb(ph, ps.clamp(0.55, 0.95), pl.clamp(0.5, 0.65));

    let secondary_bin = bins
        .iter()
        .enumerate()
        .filter(|(i, b)| {
            *i != pi && b.count > 0 && b.score >= primary_bin.score * 0.08 && hue_distance(avg(b).0, ph) >= 40.0
        })
        .max_by(|a, b| a.1.score.total_cmp(&b.1.score))
        .map(|(_, b)| *b);
    let secondary = match secondary_bin {
        Some(b) => {
            let (h, s, l) = avg(&b);
            hsl_to_rgb(h, s.clamp(0.45, 0.9), l.clamp(0.45, 0.65))
        }
        None => hsl_to_rgb(ph + 40.0, ps.clamp(0.5, 0.9), pl.clamp(0.5, 0.65)),
    };
    let dark = hsl_to_rgb(ph, (ps * 0.5).clamp(0.2, 0.45), 0.08);
    GamePalette {
        primary: hex(primary),
        secondary: hex(secondary),
        dark: hex(dark),
    }
}

fn decode_file(path: &Path) -> CmdResult<DynamicImage> {
    let reader = ImageReader::open(path)
        .map_err(|e| io_err(&e, path))?
        .with_guessed_format()
        .map_err(|e| io_err(&e, path))?;
    reader
        .decode()
        .map_err(|_| format!("Das Bild konnte nicht gelesen werden: {}", path.display()))
}

/// Palette aus einer Bilddatei (blockierend).
pub fn palette_for_file(path: &Path) -> CmdResult<GamePalette> {
    Ok(palette_from_image(&decode_file(path)?))
}

// =============================================================================================
// Cache
// =============================================================================================

fn ext_for(format: ImageFormat) -> Option<&'static str> {
    Some(match format {
        ImageFormat::Jpeg => "jpg",
        ImageFormat::Png => "png",
        ImageFormat::WebP => "webp",
        ImageFormat::Gif => "gif",
        ImageFormat::Bmp => "bmp",
        ImageFormat::Ico => "ico",
        _ => return None,
    })
}

/// Dateiendung anhand des Inhalts (nur unterstützte Bildformate).
pub fn detect_ext(bytes: &[u8]) -> Option<&'static str> {
    image::guess_format(bytes).ok().and_then(ext_for)
}

fn kind_prefix(kind: ImageKind) -> String {
    format!("{}-", kind.as_str())
}

/// Vorhandenes Bild einer Art im Spiel-Cache finden (neuestes zuerst).
pub fn find_cached(dir: &Path, kind: ImageKind) -> Option<PathBuf> {
    let prefix = kind_prefix(kind);
    let rd = fs::read_dir(dir).ok()?;
    rd.filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.starts_with(&prefix) && !name.ends_with(".tmp") && e.path().is_file()
        })
        .filter_map(|e| e.metadata().ok().map(|m| (mtime_ms(&m), m.len(), e.path())))
        .filter(|(_, len, _)| *len > 0)
        .max_by_key(|(t, _, _)| *t)
        .map(|(_, _, p)| p)
}

/// Bild speichern (`<kind>-<hash8>.<ext>`) und ältere Bilder derselben Art entfernen.
pub fn store_image(dir: &Path, kind: ImageKind, key: &str, bytes: &[u8]) -> CmdResult<PathBuf> {
    let ext = detect_ext(bytes).ok_or_else(|| "Die Datei ist kein unterstütztes Bild.".to_string())?;
    let path = dir.join(format!("{}{}.{ext}", kind_prefix(kind), hash8(key)));
    write_atomic(&path, bytes)?;
    let prefix = kind_prefix(kind);
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let p = e.path();
            if p != path && e.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = fs::remove_file(p);
            }
        }
    }
    Ok(path)
}

// =============================================================================================
// Netzwerk
// =============================================================================================

enum DlError {
    NotFound,
    Other(String),
}

async fn download(http: &reqwest::Client, url: &str) -> Result<Vec<u8>, DlError> {
    let resp = http
        .get(url)
        .send()
        .await
        .map_err(|e| DlError::Other(net_err(&e)))?;
    let status = resp.status().as_u16();
    if status == 404 || status == 403 {
        return Err(DlError::NotFound);
    }
    if !resp.status().is_success() {
        return Err(DlError::Other(http_status_err(status)));
    }
    if resp.content_length().map(|l| l as usize > MAX_IMAGE_BYTES).unwrap_or(false) {
        return Err(DlError::Other("Das Bild ist zu groß.".into()));
    }
    let bytes = resp.bytes().await.map_err(|e| DlError::Other(net_err(&e)))?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(DlError::NotFound);
    }
    if detect_ext(&bytes).is_none() {
        return Err(DlError::NotFound);
    }
    Ok(bytes.to_vec())
}

fn steam_urls(app_id: &str, kind: ImageKind) -> Vec<String> {
    let files: &[&str] = match kind {
        ImageKind::Cover => &["library_600x900_2x.jpg", "library_600x900.jpg"],
        ImageKind::Hero => &["library_hero.jpg"],
        ImageKind::Logo => &["logo.png"],
        ImageKind::Icon => &[],
    };
    let mut out = Vec::new();
    for f in files {
        for host in STEAM_HOSTS {
            out.push(format!("{host}{app_id}/{f}"));
        }
    }
    out
}

/// Bildadressen eines Steam-Spiels laut Steam-Shop (aktuelle Dateien, auch bei neuen Spielen).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct SteamAssets {
    pub cover: Vec<String>,
    pub hero: Vec<String>,
    /// Breites Shop-Bild (460×215) – Grundlage für Ersatz-Cover und -Hintergrund
    pub header: Vec<String>,
    pub icon: Option<String>,
}

pub fn parse_steam_assets(app_id: &str, v: &Value) -> Option<SteamAssets> {
    let item = v["response"]["store_items"]
        .as_array()?
        .iter()
        .find(|i| i["appid"].as_u64().map(|a| a.to_string()).as_deref() == Some(app_id))?;
    let a = &item["assets"];
    let format = a["asset_url_format"].as_str().unwrap_or_default();
    let url = |key: &str| -> Option<String> {
        let file = a[key].as_str().filter(|f| !f.is_empty())?;
        let path = if format.contains("${FILENAME}") {
            format.replace("${FILENAME}", file)
        } else {
            format!("steam/apps/{app_id}/{file}")
        };
        Some(format!("{STEAM_ASSET_HOST}{path}"))
    };
    let list = |keys: &[&str]| keys.iter().filter_map(|k| url(k)).collect::<Vec<_>>();
    let icon = a["community_icon"]
        .as_str()
        .filter(|h| !h.is_empty() && h.chars().all(|c| c.is_ascii_hexdigit()))
        .map(|h| format!("{STEAM_ICON_HOST}{app_id}/{h}.jpg"));
    Some(SteamAssets {
        cover: list(&["library_capsule", "library_capsule_2x"]),
        hero: list(&["library_hero", "library_hero_2x"]),
        header: list(&["header_2x", "header"]),
        icon,
    })
}

async fn steam_assets(http: &reqwest::Client, app_id: &str) -> Option<SteamAssets> {
    let input = serde_json::json!({
        "ids": [{ "appid": app_id.parse::<u64>().ok()? }],
        "context": { "language": "english", "country_code": "US" },
        "data_request": { "include_assets": true }
    });
    let url = reqwest::Url::parse_with_params(STEAM_ITEMS_API, &[("input_json", input.to_string())]).ok()?;
    let resp = http.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let v: Value = resp.json().await.ok()?;
    parse_steam_assets(app_id, &v)
}

const ROMAN: [(&str, &str); 9] = [
    ("ii", "2"), ("iii", "3"), ("iv", "4"), ("v", "5"), ("vi", "6"), ("vii", "7"), ("viii", "8"), ("ix", "9"), ("x", "10"),
];
const EDITION_SUFFIXES: [&str; 16] = [
    "game of the year edition", "goty edition", "goty", "definitive edition", "complete edition",
    "deluxe edition", "enhanced edition", "ultimate edition", "standard edition", "gold edition",
    "directors cut", "the final cut", "final cut", "remastered", "anniversary edition", "edition",
];

/// Spielnamen vergleichbar machen: klein, ohne ™®©, Satzzeichen und römische Zahlen als Ziffern.
pub fn normalize_title(s: &str) -> String {
    let lower = s
        .to_lowercase()
        .replace(['™', '®', '©'], "")
        .replace('&', " and ")
        .replace(['\'', '’', '`'], "");
    let cleaned: String = lower.chars().map(|c| if c.is_alphanumeric() { c } else { ' ' }).collect();
    cleaned
        .split_whitespace()
        .map(|w| ROMAN.iter().find(|(r, _)| *r == w).map(|(_, d)| *d).unwrap_or(w))
        .collect::<Vec<_>>()
        .join(" ")
}

fn strip_edition(normalized: &str) -> String {
    let mut s = normalized.trim().to_string();
    for suffix in EDITION_SUFFIXES {
        if let Some(rest) = s.strip_suffix(suffix) {
            s = rest.trim().to_string();
        }
    }
    s
}

/// Aus den Treffern der Steam-Suche den passenden wählen – nur bei (fast) gleichem Namen,
/// damit nie ein falsches Spiel seine Bilder hergibt.
pub fn pick_steam_match(name: &str, v: &Value) -> Option<String> {
    let wanted = normalize_title(name);
    if wanted.is_empty() {
        return None;
    }
    let wanted_base = strip_edition(&wanted);
    // Shop-Suche: {"items": [{"id": 730, "name": …}]}, Community-Suche: [{"appid": "730", "name": …}]
    let list = v["items"].as_array().or_else(|| v.as_array())?;
    let items: Vec<(String, String)> = list
        .iter()
        .filter(|i| i["type"].as_str().map_or(true, |t| t == "app"))
        .filter_map(|i| {
            let id = i["id"].as_u64().map(|n| n.to_string()).or_else(|| i["appid"].as_str().map(str::to_string))
                .or_else(|| i["appid"].as_u64().map(|n| n.to_string()))?;
            id.chars().all(|c| c.is_ascii_digit()).then_some(())?;
            Some((id, normalize_title(i["name"].as_str()?)))
        })
        .collect();
    items
        .iter()
        .find(|(_, n)| *n == wanted)
        .or_else(|| items.iter().find(|(_, n)| !wanted_base.is_empty() && strip_edition(n) == wanted_base))
        .map(|(id, _)| id.clone())
}

async fn steam_find_app_id(http: &reqwest::Client, name: &str) -> Option<String> {
    let term = name.trim();
    if term.is_empty() {
        return None;
    }
    let get_json = |url: reqwest::Url| async move {
        let resp = http.get(url).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        resp.json::<Value>().await.ok()
    };
    let shop = reqwest::Url::parse_with_params(STEAM_SEARCH_API, &[("term", term), ("l", "english"), ("cc", "US")]).ok()?;
    if let Some(id) = get_json(shop).await.and_then(|v| pick_steam_match(name, &v)) {
        return Some(id);
    }
    let mut community = reqwest::Url::parse(STEAM_COMMUNITY_SEARCH).ok()?;
    community.path_segments_mut().ok()?.pop_if_empty().push(term);
    get_json(community).await.and_then(|v| pick_steam_match(name, &v))
}

/// Ersatzbild aus einem breiten Shop-Bild: unscharfer, abgedunkelter Hintergrund, scharfes Bild in der Mitte.
pub fn compose_fallback(src: &DynamicImage, w: u32, h: u32) -> DynamicImage {
    use image::imageops::FilterType;
    let mut bg = src
        .resize_to_fill((w / 6).max(8), (h / 6).max(8), FilterType::Triangle)
        .blur(3.0)
        .resize_exact(w, h, FilterType::Triangle)
        .brighten(-45);
    let fg = src.resize(w * 94 / 100, h * 88 / 100, FilterType::Lanczos3);
    let x = (w.saturating_sub(fg.width()) / 2) as i64;
    let y = (h.saturating_sub(fg.height()) / 2) as i64;
    image::imageops::overlay(&mut bg, &fg, x, y);
    bg
}

fn compose_jpeg(bytes: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
    let src = image::load_from_memory(bytes).ok()?;
    let out = compose_fallback(&src, w, h).to_rgb8();
    let mut jpg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, 88)
        .encode_image(&out)
        .ok()?;
    Some(jpg)
}

/// Icon aus der Programmdatei oder – falls nur der Ordner bekannt ist – aus der Haupt-.exe darin.
fn local_exe_icon(dir: &Path, name: &str, exe_path: Option<&str>, install_dir: Option<&str>) -> Option<String> {
    if let Some(exe) = exe_path.map(clean_path).filter(|p| p.is_file()) {
        if let Ok(Some(icon)) = crate::icons::exe_icon_cached(&exe, dir) {
            return Some(icon);
        }
    }
    let folder = install_dir.map(clean_path).filter(|p| p.is_dir())?;
    let candidates = crate::scan::folder::collect_exes(&folder, 3);
    let best = crate::scan::folder::pick_best_exe(name, &candidates)?;
    crate::icons::exe_icon_cached(&candidates[best].path, dir).ok().flatten()
}

fn sgdb_url(segments: &[&str], query: &[(&str, &str)]) -> CmdResult<reqwest::Url> {
    let mut url = reqwest::Url::parse(SGDB_API).map_err(|e| e.to_string())?;
    url.path_segments_mut()
        .map_err(|_| "Ungültige Adresse.".to_string())?
        .extend(segments);
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query);
    }
    Ok(url)
}

/// GET auf die SteamGridDB-API. `Ok(None)` bei 404 (nicht gefunden).
async fn sgdb_get(http: &reqwest::Client, key: &str, url: reqwest::Url) -> CmdResult<Option<Value>> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Kein SteamGridDB-Schlüssel hinterlegt.".into());
    }
    let resp = http
        .get(url)
        .bearer_auth(key)
        .send()
        .await
        .map_err(|e| net_err(&e))?;
    match resp.status().as_u16() {
        401 | 403 => return Err(SGDB_INVALID_KEY.into()),
        404 => return Ok(None),
        s if !(200..300).contains(&s) => return Err(format!("SteamGridDB: {}", http_status_err(s))),
        _ => {}
    }
    let v: Value = resp.json().await.map_err(|e| net_err(&e))?;
    if v.get("success").and_then(|s| s.as_bool()) == Some(false) {
        return Ok(None);
    }
    Ok(Some(v))
}

/// SteamGridDB-Spiel-ID über die Steam-AppID oder den Namen finden.
async fn sgdb_resolve(
    http: &reqwest::Client,
    key: &str,
    steam_app_id: Option<&str>,
    name: &str,
) -> CmdResult<Option<u64>> {
    if let Some(id) = steam_app_id {
        if let Some(v) = sgdb_get(http, key, sgdb_url(&["games", "steam", id], &[])?).await? {
            if let Some(gid) = v.get("data").and_then(|d| d.get("id")).and_then(|i| i.as_u64()) {
                return Ok(Some(gid));
            }
        }
    }
    let name = name.trim();
    if name.is_empty() {
        return Ok(None);
    }
    let games = sgdb_search_raw(http, key, name).await?;
    Ok(games.first().map(|g| g.id))
}

async fn sgdb_search_raw(http: &reqwest::Client, key: &str, query: &str) -> CmdResult<Vec<SgdbGame>> {
    let Some(v) = sgdb_get(http, key, sgdb_url(&["search", "autocomplete", query], &[])?).await? else {
        return Ok(Vec::new());
    };
    Ok(parse_sgdb_games(&v))
}

pub fn parse_sgdb_games(v: &Value) -> Vec<SgdbGame> {
    use chrono::Datelike;
    v.get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|g| {
                    let year = g
                        .get("release_date")
                        .and_then(|r| r.as_i64())
                        .filter(|r| *r > 0)
                        .and_then(|r| chrono::DateTime::from_timestamp(r, 0))
                        .map(|d| d.year());
                    Some(SgdbGame {
                        id: g.get("id")?.as_u64()?,
                        name: g.get("name")?.as_str()?.to_string(),
                        year,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_sgdb_images(v: &Value) -> Vec<SgdbImage> {
    v.get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|i| {
                    let url = i.get("url")?.as_str()?.to_string();
                    Some(SgdbImage {
                        thumb: i
                            .get("thumb")
                            .and_then(|t| t.as_str())
                            .map(|t| t.to_string())
                            .unwrap_or_else(|| url.clone()),
                        url,
                        width: i.get("width").and_then(|w| w.as_u64()).unwrap_or(0) as u32,
                        height: i.get("height").and_then(|h| h.as_u64()).unwrap_or(0) as u32,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn sgdb_list(http: &reqwest::Client, key: &str, game_id: u64, kind: ImageKind) -> CmdResult<Vec<SgdbImage>> {
    let id = game_id.to_string();
    let url = match kind {
        ImageKind::Cover => sgdb_url(
            &["grids", "game", &id],
            &[("dimensions", "600x900,342x482,660x930"), ("types", "static")],
        )?,
        ImageKind::Hero => sgdb_url(&["heroes", "game", &id], &[("types", "static")])?,
        ImageKind::Logo => sgdb_url(&["logos", "game", &id], &[("types", "static")])?,
        ImageKind::Icon => sgdb_url(&["icons", "game", &id], &[("types", "static")])?,
    };
    Ok(sgdb_get(http, key, url)
        .await?
        .map(|v| parse_sgdb_images(&v))
        .unwrap_or_default())
}

async fn palette_async(path: PathBuf) -> Option<GamePalette> {
    blocking(move || palette_for_file(&path)).await.ok()
}

async fn store_async(dir: PathBuf, kind: ImageKind, key: String, bytes: Vec<u8>) -> CmdResult<PathBuf> {
    blocking(move || store_image(&dir, kind, &key, &bytes)).await
}

fn kind_label(kind: ImageKind) -> &'static str {
    match kind {
        ImageKind::Cover => "Cover",
        ImageKind::Hero => "Hintergrundbild",
        ImageKind::Logo => "Logo",
        ImageKind::Icon => "Symbol",
    }
}

fn check_game_id(id: &str) -> CmdResult<()> {
    if id.trim().is_empty() {
        Err("Ungültige Spiel-ID.".into())
    } else {
        Ok(())
    }
}

// =============================================================================================
// Befehle
// =============================================================================================

#[tauri::command]
pub async fn images_fetch(state: State<'_, Shared>, request: ImageFetchRequest) -> CmdResult<ImageFetchResult> {
    check_game_id(&request.game_id)?;
    let http = state.http.clone();
    let dir = state.paths.game_images_dir(&request.game_id);
    let force = request.force.unwrap_or(false);
    let mut kinds: Vec<ImageKind> = Vec::new();
    for k in &request.kinds {
        if !kinds.contains(k) {
            kinds.push(*k);
        }
    }
    if kinds.is_empty() {
        kinds = vec![ImageKind::Cover, ImageKind::Hero, ImageKind::Logo, ImageKind::Icon];
    }

    let mut images = GameImages::default();
    let mut messages = Vec::new();
    let mut from_steam = false;
    let mut from_sgdb = false;
    let mut from_exe = false;
    let mut missing: Vec<ImageKind> = Vec::new();
    for k in &kinds {
        match (!force).then(|| find_cached(&dir, *k)).flatten() {
            Some(p) => images.set(*k, display_path(&p)),
            None => missing.push(*k),
        }
    }

    // 1) Icon direkt aus der Programmdatei (scharf, 256 px, nur Windows)
    if missing.contains(&ImageKind::Icon) {
        let (d, name, exe, folder) = (dir.clone(), request.name.clone(), request.exe_path.clone(), request.install_dir.clone());
        let icon = tokio::task::spawn_blocking(move || {
            let _ = fs::create_dir_all(&d);
            local_exe_icon(&d, &name, exe.as_deref(), folder.as_deref())
        })
        .await
        .ok()
        .flatten();
        if let Some(icon) = icon {
            images.icon = Some(icon);
            missing.retain(|k| *k != ImageKind::Icon);
            from_exe = true;
        }
    }

    // 2) Steam (ohne Schlüssel): bekannte Steam-ID oder Suche per Name
    let mut steam_id = request
        .steam_app_id
        .clone()
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()));
    let mut found_by_name: Option<String> = None;
    if steam_id.is_none() && request.lookup_by_name.unwrap_or(false) && !missing.is_empty() {
        found_by_name = steam_find_app_id(&http, &request.name).await;
        steam_id = found_by_name.clone();
    }
    let mut network_error: Option<String> = None;
    let mut header_urls: Vec<String> = Vec::new();
    if let Some(app_id) = steam_id.as_deref() {
        let assets = if missing.is_empty() { None } else { steam_assets(&http, app_id).await };
        if let Some(a) = &assets {
            header_urls = a.header.clone();
        }
        for kind in missing.clone() {
            // Aktuelle Dateien laut Shop zuerst, danach die festen Adressen (ältere Spiele)
            let mut urls: Vec<String> = match (&assets, kind) {
                (Some(a), ImageKind::Cover) => a.cover.clone(),
                (Some(a), ImageKind::Hero) => a.hero.clone(),
                (Some(a), ImageKind::Icon) => a.icon.iter().cloned().collect(),
                _ => Vec::new(),
            };
            urls.extend(steam_urls(app_id, kind));
            for url in urls {
                match download(&http, &url).await {
                    Ok(bytes) => {
                        let p = store_async(dir.clone(), kind, url.clone(), bytes).await?;
                        images.set(kind, display_path(&p));
                        missing.retain(|k| *k != kind);
                        from_steam = true;
                        break;
                    }
                    Err(DlError::NotFound) => continue,
                    Err(DlError::Other(e)) => {
                        network_error.get_or_insert(e);
                        continue;
                    }
                }
            }
        }
    }

    // 3) SteamGridDB (mit Schlüssel)
    let api_key = request.api_key.as_deref().map(str::trim).filter(|k| !k.is_empty());
    if !missing.is_empty() {
        if let Some(key) = api_key {
            match sgdb_resolve(&http, key, steam_id.as_deref(), &request.name).await {
                Ok(Some(gid)) => {
                    for kind in missing.clone() {
                        let list = match sgdb_list(&http, key, gid, kind).await {
                            Ok(l) => l,
                            Err(e) => {
                                messages.push(e);
                                continue;
                            }
                        };
                        for img in list.iter().take(3) {
                            match download(&http, &img.url).await {
                                Ok(bytes) => {
                                    let p = store_async(dir.clone(), kind, img.url.clone(), bytes).await?;
                                    images.set(kind, display_path(&p));
                                    missing.retain(|k| *k != kind);
                                    from_sgdb = true;
                                    break;
                                }
                                Err(DlError::NotFound) => continue,
                                Err(DlError::Other(e)) => {
                                    network_error.get_or_insert(e);
                                    continue;
                                }
                            }
                        }
                    }
                }
                Ok(None) => messages.push(format!(
                    "„{}“ wurde bei SteamGridDB nicht gefunden.",
                    request.name.trim()
                )),
                Err(e) => messages.push(e),
            }
        }
    }

    // 4) Kein Cover/Hintergrund, aber ein Shop-Bild: Ersatz daraus zusammensetzen
    if missing.contains(&ImageKind::Cover) || missing.contains(&ImageKind::Hero) {
        for url in &header_urls {
            let Ok(bytes) = download(&http, url).await else { continue };
            for (kind, w, h) in [(ImageKind::Cover, 600, 900), (ImageKind::Hero, 1920, 620)] {
                if !missing.contains(&kind) {
                    continue;
                }
                let b = bytes.clone();
                let composed = tokio::task::spawn_blocking(move || compose_jpeg(&b, w, h)).await.ok().flatten();
                if let Some(jpg) = composed {
                    let p = store_async(dir.clone(), kind, format!("{url}#{w}x{h}"), jpg).await?;
                    images.set(kind, display_path(&p));
                    missing.retain(|k| *k != kind);
                    from_steam = true;
                }
            }
            break;
        }
    }

    if let Some(e) = network_error {
        if !messages.contains(&e) {
            messages.push(e);
        }
    }
    if !missing.is_empty() {
        let names: Vec<&str> = missing.iter().map(|k| kind_label(*k)).collect();
        if api_key.is_none() {
            messages.push(format!(
                "Nicht gefunden: {}. Mit einem SteamGridDB-Schlüssel (Einstellungen) findet Nova mehr Bilder.",
                names.join(", ")
            ));
        } else {
            messages.push(format!("Nicht gefunden: {}.", names.join(", ")));
        }
    }

    let palette = match images.cover.clone() {
        Some(cover) => palette_async(PathBuf::from(cover)).await,
        None => None,
    };
    let source = if from_steam {
        "steam"
    } else if from_sgdb {
        "steamgriddb"
    } else if from_exe {
        "exe"
    } else {
        "none"
    };
    Ok(ImageFetchResult {
        images,
        palette,
        source: source.into(),
        messages,
        steam_app_id: found_by_name,
    })
}

#[tauri::command]
pub async fn sgdb_search(state: State<'_, Shared>, query: String, api_key: String) -> CmdResult<Vec<SgdbGame>> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    sgdb_search_raw(&state.http, &api_key, q).await
}

#[tauri::command]
pub async fn sgdb_images(
    state: State<'_, Shared>,
    sgdb_id: f64,
    kind: ImageKind,
    api_key: String,
) -> CmdResult<Vec<SgdbImage>> {
    if !sgdb_id.is_finite() || sgdb_id <= 0.0 {
        return Err("Ungültige SteamGridDB-ID.".into());
    }
    sgdb_list(&state.http, &api_key, sgdb_id as u64, kind).await
}

#[tauri::command]
pub async fn image_download(
    state: State<'_, Shared>,
    url: String,
    game_id: String,
    kind: ImageKind,
) -> CmdResult<SavedImage> {
    check_game_id(&game_id)?;
    let url = url.trim().to_string();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Ungültige Bild-Adresse.".into());
    }
    let bytes = match download(&state.http, &url).await {
        Ok(b) => b,
        Err(DlError::NotFound) => return Err("Unter dieser Adresse wurde kein Bild gefunden.".into()),
        Err(DlError::Other(e)) => return Err(e),
    };
    let dir = state.paths.game_images_dir(&game_id);
    let path = store_async(dir, kind, url, bytes).await?;
    let palette = if kind == ImageKind::Cover {
        palette_async(path.clone()).await
    } else {
        None
    };
    Ok(SavedImage {
        path: display_path(&path),
        palette,
    })
}

#[tauri::command]
pub async fn image_set_custom(
    state: State<'_, Shared>,
    game_id: String,
    kind: ImageKind,
    source_path: String,
) -> CmdResult<SavedImage> {
    check_game_id(&game_id)?;
    let src = clean_path(&source_path);
    let dir = state.paths.game_images_dir(&game_id);
    blocking(move || {
        let meta = fs::metadata(&src).map_err(|e| io_err(&e, &src))?;
        if !meta.is_file() {
            return Err(format!("Die Datei wurde nicht gefunden: {}", src.display()));
        }
        if meta.len() as usize > MAX_IMAGE_BYTES {
            return Err("Das Bild ist zu groß (max. 40 MB).".into());
        }
        let bytes = fs::read(&src).map_err(|e| io_err(&e, &src))?;
        let key = format!("{}|{}|{}", src.display(), mtime_ms(&meta), meta.len());
        let path = store_image(&dir, kind, &key, &bytes)?;
        let palette = if kind == ImageKind::Cover {
            palette_for_file(&path).ok()
        } else {
            None
        };
        Ok(SavedImage {
            path: display_path(&path),
            palette,
        })
    })
    .await
}

#[tauri::command]
pub async fn image_palette(path: String) -> CmdResult<GamePalette> {
    let p = clean_path(&path);
    blocking(move || palette_for_file(&p)).await
}

#[tauri::command]
pub async fn exe_icon(state: State<'_, Shared>, exe_path: String, game_id: String) -> CmdResult<Option<String>> {
    check_game_id(&game_id)?;
    let exe = clean_path(&exe_path);
    let dir = state.paths.game_images_dir(&game_id);
    blocking(move || crate::icons::exe_icon_cached(&exe, &dir)).await
}

#[tauri::command]
pub async fn cache_size(state: State<'_, Shared>) -> CmdResult<u64> {
    let dir = state.paths.cache_dir.clone();
    blocking(move || Ok(dir_size(&dir))).await
}

#[tauri::command]
pub async fn cache_clear(state: State<'_, Shared>) -> CmdResult<u64> {
    let dir = state.paths.cache_dir.clone();
    blocking(move || {
        let before = dir_size(&dir);
        if let Ok(rd) = fs::read_dir(&dir) {
            for e in rd.filter_map(|e| e.ok()) {
                let p = e.path();
                let _ = if p.is_dir() {
                    fs::remove_dir_all(&p)
                } else {
                    fs::remove_file(&p)
                };
            }
        }
        let after = dir_size(&dir);
        Ok(before.saturating_sub(after))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    fn hsl_of(hex: &str) -> (f32, f32, f32) {
        let v = u32::from_str_radix(hex.trim_start_matches('#'), 16).unwrap();
        rgb_to_hsl(((v >> 16) & 255) as f32, ((v >> 8) & 255) as f32, (v & 255) as f32)
    }

    #[test]
    fn palette_from_generated_image() {
        // 70 % Rot, 30 % Blau, dazu etwas Grau
        let mut img = RgbImage::new(100, 100);
        for (x, y, p) in img.enumerate_pixels_mut() {
            *p = if y < 5 {
                Rgb([128, 128, 128])
            } else if x < 70 {
                Rgb([220, 30, 40])
            } else {
                Rgb([30, 60, 220])
            };
        }
        let pal = palette_from_image(&DynamicImage::ImageRgb8(img));
        let (h1, s1, l1) = hsl_of(&pal.primary);
        assert!(hue_distance(h1, 357.0) < 15.0, "Hauptfarbe rot: {}", pal.primary);
        assert!(s1 >= 0.5 && (0.45..=0.7).contains(&l1));
        let (h2, _, _) = hsl_of(&pal.secondary);
        assert!(hue_distance(h2, 228.0) < 20.0, "Zweitfarbe blau: {}", pal.secondary);
        let (_, _, l3) = hsl_of(&pal.dark);
        assert!(l3 < 0.12, "dunkel: {}", pal.dark);
    }

    #[test]
    fn palette_grayscale_falls_back() {
        let img = RgbImage::from_pixel(32, 32, Rgb([90, 90, 90]));
        assert_eq!(palette_from_image(&DynamicImage::ImageRgb8(img)), default_palette());
    }

    #[test]
    fn hsl_roundtrip() {
        for (r, g, b) in [(255u8, 79u8, 139u8), (10, 200, 30), (0, 0, 0), (255, 255, 255)] {
            let (h, s, l) = rgb_to_hsl(r as f32, g as f32, b as f32);
            let (r2, g2, b2) = hsl_to_rgb(h, s, l);
            assert!((r as i32 - r2 as i32).abs() <= 1 && (g as i32 - g2 as i32).abs() <= 1 && (b as i32 - b2 as i32).abs() <= 1);
        }
    }

    #[test]
    fn cache_store_and_find() {
        let dir = tempfile::tempdir().unwrap();
        let mut png = Vec::new();
        DynamicImage::ImageRgb8(RgbImage::from_pixel(4, 4, Rgb([255, 0, 0])))
            .write_to(&mut std::io::Cursor::new(&mut png), ImageFormat::Png)
            .unwrap();
        assert!(store_image(dir.path(), ImageKind::Cover, "k", b"kein bild").is_err());
        let p1 = store_image(dir.path(), ImageKind::Cover, "url1", &png).unwrap();
        assert!(p1.file_name().unwrap().to_string_lossy().starts_with("cover-"));
        assert!(p1.extension().unwrap() == "png");
        let p2 = store_image(dir.path(), ImageKind::Cover, "url2", &png).unwrap();
        assert!(!p1.exists(), "altes Cover ersetzt");
        assert_eq!(find_cached(dir.path(), ImageKind::Cover), Some(p2));
        assert_eq!(find_cached(dir.path(), ImageKind::Hero), None);
    }

    #[test]
    fn sgdb_parsing() {
        let v = serde_json::json!({"success": true, "data": [
            {"id": 5, "name": "Hades", "release_date": 1600387200},
            {"id": 6, "name": "Ohne Datum"}
        ]});
        let g = parse_sgdb_games(&v);
        assert_eq!(g[0], SgdbGame { id: 5, name: "Hades".into(), year: Some(2020) });
        assert_eq!(g[1].year, None);
        let imgs = parse_sgdb_images(&serde_json::json!({"data": [{"url": "https://x/a.png", "width": 600, "height": 900}]}));
        assert_eq!(imgs[0].thumb, "https://x/a.png");
        assert_eq!(imgs[0].height, 900);
    }

    #[test]
    fn title_normalizing() {
        assert_eq!(normalize_title("Baldur's Gate 3"), "baldurs gate 3");
        assert_eq!(normalize_title("Hades II"), "hades 2");
        assert_eq!(normalize_title("The Witcher® 3: Wild Hunt"), "the witcher 3 wild hunt");
        assert_eq!(normalize_title("Ori and the Will of the Wisps"), normalize_title("Ori & the Will of the Wisps"));
        assert_eq!(strip_edition(&normalize_title("Fallout 4: Game of the Year Edition")), "fallout 4");
    }

    #[test]
    fn steam_search_picks_only_matching_names() {
        let v = serde_json::json!({"total": 3, "items": [
            {"type": "app", "name": "Counter-Strike 2 Soundtrack", "id": 2678630},
            {"type": "app", "name": "Counter-Strike 2", "id": 730},
            {"type": "app", "name": "Counter-Strike: Source", "id": 240}
        ]});
        assert_eq!(pick_steam_match("Counter-Strike 2", &v).as_deref(), Some("730"));
        assert_eq!(pick_steam_match("counter strike 2", &v).as_deref(), Some("730"));
        // Kein ähnlicher, aber falscher Treffer
        assert_eq!(pick_steam_match("Counter-Strike", &v), None);
        let goty = serde_json::json!({"items": [{"type": "app", "name": "The Witcher 3: Wild Hunt", "id": 292030}]});
        assert_eq!(pick_steam_match("The Witcher 3: Wild Hunt - Game of the Year Edition", &goty).as_deref(), Some("292030"));
        assert_eq!(pick_steam_match("", &goty), None);
        // Antwort der Community-Suche
        let community = serde_json::json!([{"appid": "632470", "name": "Disco Elysium - The Final Cut"}]);
        assert_eq!(pick_steam_match("Disco Elysium", &community).as_deref(), Some("632470"));
        assert_eq!(pick_steam_match("Witcher", &serde_json::json!({})), None);
    }

    #[test]
    fn steam_assets_parsing() {
        let v = serde_json::json!({"response": {"store_items": [{
            "appid": 1145350,
            "assets": {
                "asset_url_format": "steam/apps/1145350/${FILENAME}?t=1",
                "header": "91ac/header.jpg",
                "library_capsule": "2ba1/library_capsule.jpg",
                "library_hero": "2d2e/library_hero.jpg",
                "community_icon": "621d9f1cfa204c0bae07a981f41007d2cf03a56c"
            }
        }]}});
        let a = parse_steam_assets("1145350", &v).unwrap();
        assert_eq!(a.cover, vec!["https://shared.steamstatic.com/store_item_assets/steam/apps/1145350/2ba1/library_capsule.jpg?t=1"]);
        assert_eq!(a.hero.len(), 1);
        assert_eq!(a.header.len(), 1);
        assert_eq!(
            a.icon.as_deref(),
            Some("https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/1145350/621d9f1cfa204c0bae07a981f41007d2cf03a56c.jpg")
        );
        assert!(parse_steam_assets("730", &v).is_none(), "andere ID");
    }

    #[test]
    fn fallback_cover_has_target_size() {
        let wide = DynamicImage::ImageRgb8(image::RgbImage::from_fn(460, 215, |x, _| image::Rgb([(x % 255) as u8, 80, 160])));
        let cover = compose_fallback(&wide, 600, 900);
        assert_eq!((cover.width(), cover.height()), (600, 900));
        let mut png = Vec::new();
        wide.write_to(&mut std::io::Cursor::new(&mut png), ImageFormat::Png).unwrap();
        let jpg = compose_jpeg(&png, 1920, 620).unwrap();
        assert_eq!(detect_ext(&jpg), Some("jpg"));
    }

    #[test]
    fn steam_url_order() {
        let urls = steam_urls("570", ImageKind::Cover);
        assert_eq!(urls.len(), 4);
        assert!(urls[0].ends_with("570/library_600x900_2x.jpg"));
        assert!(urls[0].starts_with("https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/"));
        assert!(steam_urls("570", ImageKind::Icon).is_empty());
    }
}
