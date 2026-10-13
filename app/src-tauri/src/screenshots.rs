//! Screenshots aus Steam, Xbox Game Bar, NVIDIA und eigenen Ordnern sowie Vorschaubilder.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use image::codecs::jpeg::JpegEncoder;
use image::ImageReader;
use tauri::State;

use crate::error::{blocking, io_err, CmdResult};
use crate::models::Screenshot;
use crate::state::Shared;
use crate::tracker::normalize_path;
use crate::util::{clean_path, display_path, mtime_ms, normalize_name, sha256_hex, write_atomic};

pub const MAX_SCREENSHOTS: usize = 500;
const EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "bmp"];

fn is_image(p: &Path) -> bool {
    p.extension()
        .map(|e| {
            let e = e.to_string_lossy().to_lowercase();
            EXTENSIONS.contains(&e.as_str())
        })
        .unwrap_or(false)
}

/// Bilder in einem Ordner sammeln (bis `depth` Ebenen), optional nach Dateinamen gefiltert.
fn collect(dir: &Path, depth: usize, source: &str, filter: Option<&dyn Fn(&str) -> bool>, out: &mut Vec<Screenshot>) {
    if !dir.is_dir() {
        return;
    }
    for e in walkdir::WalkDir::new(dir)
        .min_depth(1)
        .max_depth(depth)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            // Steam legt Vorschaubilder in "thumbnails" ab – nicht doppelt anzeigen
            !(e.file_type().is_dir() && e.file_name().to_string_lossy().eq_ignore_ascii_case("thumbnails"))
        })
        .filter_map(|e| e.ok())
    {
        if !e.file_type().is_file() || !is_image(e.path()) {
            continue;
        }
        if let Some(f) = filter {
            let name = e.file_name().to_string_lossy().to_string();
            if !f(&name) {
                continue;
            }
        }
        let taken_at = e.metadata().map(|m| mtime_ms(&m)).unwrap_or(0);
        out.push(Screenshot {
            path: display_path(e.path()),
            taken_at,
            source: source.into(),
        });
        if out.len() > MAX_SCREENSHOTS * 4 {
            return;
        }
    }
}

/// Unterordner, dessen Name (normalisiert) dem Spielnamen entspricht.
fn find_named_dir(parent: &Path, game: &str) -> Option<PathBuf> {
    if game.is_empty() {
        return None;
    }
    fs::read_dir(parent)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .find(|e| normalize_name(&e.file_name().to_string_lossy()) == game)
        .map(|e| e.path())
}

fn video_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(d) = dirs::video_dir() {
        v.push(d);
    }
    if let Some(h) = crate::util::home_dir() {
        v.push(h.join("Videos"));
    }
    let mut seen = HashSet::new();
    v.into_iter()
        .filter(|p| p.is_dir() && seen.insert(normalize_path(&p.to_string_lossy())))
        .collect()
}

/// Alle Screenshots eines Spiels, neueste zuerst (blockierend).
pub fn list_screenshots(name: &str, steam_app_id: Option<&str>, folder: Option<&str>) -> Vec<Screenshot> {
    let mut out = Vec::new();
    let game = normalize_name(name);

    // Steam: <steam>/userdata/<user>/760/remote/<appid>/screenshots
    if let Some(app) = steam_app_id.filter(|a| !a.is_empty() && a.chars().all(|c| c.is_ascii_digit())) {
        for userdata in crate::scan::steam::userdata_dirs() {
            if let Ok(users) = fs::read_dir(&userdata) {
                for u in users.filter_map(|e| e.ok()) {
                    let dir = u.path().join("760").join("remote").join(app).join("screenshots");
                    collect(&dir, 1, "steam", None, &mut out);
                }
            }
        }
    }

    if !game.is_empty() {
        for videos in video_dirs() {
            // Xbox Game Bar: Videos\Captures\<Spielname> <Datum>.png
            let starts = |file: &str| normalize_name(file).starts_with(&game);
            collect(&videos.join("Captures"), 1, "gamebar", Some(&starts), &mut out);
            // NVIDIA: Videos\NVIDIA\<Spiel> und Videos\<Spiel>
            if let Some(d) = find_named_dir(&videos.join("NVIDIA"), &game) {
                collect(&d, 2, "nvidia", None, &mut out);
            }
            if let Some(d) = find_named_dir(&videos, &game) {
                collect(&d, 2, "nvidia", None, &mut out);
            }
        }
    }

    if let Some(f) = folder.map(clean_path).filter(|p| !p.as_os_str().is_empty()) {
        collect(&f, 3, "folder", None, &mut out);
    }

    let mut seen = HashSet::new();
    out.retain(|s| seen.insert(normalize_path(&s.path)));
    out.sort_by_key(|s| std::cmp::Reverse(s.taken_at));
    out.truncate(MAX_SCREENSHOTS);
    out
}

/// Vorschaubild erzeugen (JPEG, Qualität 82) und den Pfad zurückgeben (blockierend).
pub fn make_thumbnail(src: &Path, size: u32, thumbs_dir: &Path) -> CmdResult<PathBuf> {
    let meta = fs::metadata(src).map_err(|e| io_err(&e, src))?;
    if !meta.is_file() {
        return Err(format!("Die Datei wurde nicht gefunden: {}", src.display()));
    }
    let size = size.clamp(32, 2048);
    let key = format!("{}|{}|{}|{}", normalize_path(&src.to_string_lossy()), mtime_ms(&meta), meta.len(), size);
    let out = thumbs_dir.join(format!("{}.jpg", &sha256_hex(key.as_bytes())[..24]));
    if out.is_file() {
        return Ok(out);
    }
    let img = ImageReader::open(src)
        .map_err(|e| io_err(&e, src))?
        .with_guessed_format()
        .map_err(|e| io_err(&e, src))?
        .decode()
        .map_err(|_| format!("Das Bild konnte nicht gelesen werden: {}", src.display()))?;
    let thumb = img.thumbnail(size, size).to_rgb8();
    let mut buf = Vec::new();
    JpegEncoder::new_with_quality(&mut buf, 82)
        .encode_image(&thumb)
        .map_err(|e| format!("Vorschaubild konnte nicht erstellt werden: {e}"))?;
    write_atomic(&out, &buf)?;
    Ok(out)
}

#[tauri::command]
pub async fn screenshots_list(
    game_id: String,
    name: String,
    steam_app_id: Option<serde_json::Value>,
    folder: Option<String>,
) -> CmdResult<Vec<Screenshot>> {
    let _ = game_id;
    let steam = match steam_app_id {
        Some(serde_json::Value::String(s)) => Some(s.trim().to_string()),
        Some(serde_json::Value::Number(n)) => Some(n.to_string()),
        _ => None,
    };
    blocking(move || Ok(list_screenshots(&name, steam.as_deref(), folder.as_deref()))).await
}

#[tauri::command]
pub async fn thumbnail(state: State<'_, Shared>, path: String, size: Option<f64>) -> CmdResult<String> {
    let src = clean_path(&path);
    let size = size.filter(|s| s.is_finite() && *s > 0.0).unwrap_or(320.0) as u32;
    let dir = state.paths.thumbs_dir();
    blocking(move || make_thumbnail(&src, size, &dir).map(|p| display_path(&p))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, Rgb, RgbImage};

    #[test]
    fn thumbnail_is_cached_jpeg() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("shot.png");
        DynamicImage::ImageRgb8(RgbImage::from_pixel(800, 400, Rgb([10, 200, 30])))
            .save(&src)
            .unwrap();
        let thumbs = dir.path().join("thumbs");
        let t1 = make_thumbnail(&src, 200, &thumbs).unwrap();
        assert_eq!(t1.extension().unwrap(), "jpg");
        let img = image::open(&t1).unwrap();
        assert_eq!((img.width(), img.height()), (200, 100));
        let t2 = make_thumbnail(&src, 200, &thumbs).unwrap();
        assert_eq!(t1, t2, "zweiter Aufruf aus dem Cache");
        let t3 = make_thumbnail(&src, 100, &thumbs).unwrap();
        assert_ne!(t1, t3);
        assert!(make_thumbnail(&dir.path().join("fehlt.png"), 100, &thumbs).is_err());
    }

    #[test]
    fn custom_folder_listing() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("2024");
        fs::create_dir_all(&sub).unwrap();
        fs::write(dir.path().join("a.png"), b"x").unwrap();
        fs::write(sub.join("b.JPG"), b"x").unwrap();
        fs::write(dir.path().join("notes.txt"), b"x").unwrap();
        let list = list_screenshots("", None, Some(&dir.path().to_string_lossy()));
        assert_eq!(list.len(), 2);
        assert!(list.iter().all(|s| s.source == "folder"));
    }
}
