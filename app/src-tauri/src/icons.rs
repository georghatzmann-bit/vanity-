//! Programmsymbole aus `.exe`-Dateien lesen (nur Windows) und als PNG im Cache ablegen.

use std::path::Path;

use crate::error::CmdResult;

/// Liefert den Pfad zu einem 256-px-PNG des Programmsymbols (im Cache), unter Linux `None`.
pub fn exe_icon_cached(exe: &Path, dir: &Path) -> CmdResult<Option<String>> {
    #[cfg(windows)]
    {
        win::exe_icon_cached(exe, dir)
    }
    #[cfg(not(windows))]
    {
        let _ = (exe, dir);
        Ok(None)
    }
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::fs;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use image::RgbaImage;
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ,
    };
    use windows::Win32::UI::Shell::SHDefExtractIconW;
    use windows::Win32::UI::WindowsAndMessaging::{
        DestroyIcon, GetIconInfo, PrivateExtractIconsW, HICON, ICONINFO,
    };

    use crate::error::{io_err, CmdResult};
    use crate::util::{display_path, hash8, mtime_ms, write_atomic};

    pub fn exe_icon_cached(exe: &Path, dir: &Path) -> CmdResult<Option<String>> {
        let meta = fs::metadata(exe).map_err(|e| io_err(&e, exe))?;
        if !meta.is_file() {
            return Err(format!("Die Datei wurde nicht gefunden: {}", exe.display()));
        }
        let key = format!("{}|{}|{}", exe.display(), mtime_ms(&meta), meta.len());
        let out = dir.join(format!("exeicon-{}.png", hash8(&key)));
        if out.is_file() {
            return Ok(Some(display_path(&out)));
        }
        let Some((w, h, rgba)) = extract_rgba(exe, 256) else {
            return Ok(None);
        };
        let Some(img) = RgbaImage::from_raw(w, h, rgba) else {
            return Ok(None);
        };
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .map_err(|e| format!("Symbol konnte nicht gespeichert werden: {e}"))?;
        write_atomic(&out, &png)?;
        // Ältere Symbole dieses Spiels entfernen
        if let Ok(rd) = fs::read_dir(dir) {
            for e in rd.filter_map(|e| e.ok()) {
                let p = e.path();
                if p != out && e.file_name().to_string_lossy().starts_with("exeicon-") {
                    let _ = fs::remove_file(p);
                }
            }
        }
        Ok(Some(display_path(&out)))
    }

    struct IconGuard(HICON);
    impl Drop for IconGuard {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                unsafe {
                    let _ = DestroyIcon(self.0);
                }
            }
        }
    }

    struct BitmapGuard(HBITMAP);
    impl Drop for BitmapGuard {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                unsafe {
                    let _ = DeleteObject(HGDIOBJ(self.0 .0));
                }
            }
        }
    }

    struct DcGuard(HDC);
    impl Drop for DcGuard {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                unsafe {
                    let _ = DeleteDC(self.0);
                }
            }
        }
    }

    /// Symbol laden: zuerst `PrivateExtractIconsW` (beliebige Größe), sonst `SHDefExtractIconW`.
    unsafe fn load_icon(wide: &[u16], size: i32) -> Option<HICON> {
        if wide.len() <= 260 {
            let mut buf = [0u16; 260];
            buf[..wide.len()].copy_from_slice(wide);
            let mut icons = [HICON::default(); 1];
            let mut id = 0u32;
            let n = PrivateExtractIconsW(&buf, 0, size, size, Some(&mut icons), Some(&mut id as *mut u32), 0);
            if n != 0 && n != u32::MAX && !icons[0].is_invalid() {
                return Some(icons[0]);
            }
        }
        let mut large = HICON::default();
        let hr = SHDefExtractIconW(PCWSTR(wide.as_ptr()), 0, 0, Some(&mut large as *mut HICON), None, size as u32);
        if hr.0 == 0 && !large.is_invalid() {
            Some(large)
        } else {
            None
        }
    }

    fn header(w: i32, h: i32) -> BITMAPINFO {
        BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                // negativ = von oben nach unten
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        }
    }

    /// HICON → RGBA-Pixel. Symbole ohne Alphakanal bekommen die Transparenz aus der Maske.
    unsafe fn hicon_to_rgba(hicon: HICON) -> Option<(u32, u32, Vec<u8>)> {
        let mut info = ICONINFO::default();
        GetIconInfo(hicon, &mut info).ok()?;
        let _color_guard = BitmapGuard(info.hbmColor);
        let _mask_guard = BitmapGuard(info.hbmMask);
        if info.hbmColor.is_invalid() {
            return None; // einfarbige Symbole werden nicht unterstützt
        }
        let mut bm = BITMAP::default();
        let got = GetObjectW(
            HGDIOBJ(info.hbmColor.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bm as *mut BITMAP as *mut c_void),
        );
        if got == 0 || bm.bmWidth <= 0 || bm.bmHeight <= 0 {
            return None;
        }
        let (w, h) = (bm.bmWidth, bm.bmHeight);
        let dc = DcGuard(CreateCompatibleDC(None));
        if dc.0.is_invalid() {
            return None;
        }
        let len = (w as usize) * (h as usize) * 4;
        let mut color = vec![0u8; len];
        let mut bmi = header(w, h);
        let lines = GetDIBits(
            dc.0,
            info.hbmColor,
            0,
            h as u32,
            Some(color.as_mut_ptr() as *mut c_void),
            &mut bmi,
            DIB_RGB_COLORS,
        );
        if lines == 0 {
            return None;
        }
        let has_alpha = color.chunks_exact(4).any(|p| p[3] != 0);
        if !has_alpha && !info.hbmMask.is_invalid() {
            let mut mask = vec![0u8; len];
            let mut bmi2 = header(w, h);
            let ok = GetDIBits(
                dc.0,
                info.hbmMask,
                0,
                h as u32,
                Some(mask.as_mut_ptr() as *mut c_void),
                &mut bmi2,
                DIB_RGB_COLORS,
            );
            for (i, px) in color.chunks_exact_mut(4).enumerate() {
                // Maske schwarz = sichtbar
                px[3] = if ok == 0 || mask[i * 4] == 0 { 255 } else { 0 };
            }
        }
        for px in color.chunks_exact_mut(4) {
            px.swap(0, 2); // BGRA → RGBA
        }
        Some((w as u32, h as u32, color))
    }

    pub fn extract_rgba(path: &Path, size: i32) -> Option<(u32, u32, Vec<u8>)> {
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            let icon = IconGuard(load_icon(&wide, size)?);
            hicon_to_rgba(icon.0)
        }
    }
}
