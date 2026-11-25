use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationIcon {
    pub path: String,
    pub data_url: String,
}

static ICON_CACHE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

pub struct ApplicationIconService;

impl ApplicationIconService {
    const MAX_BATCH_SIZE: usize = 64;

    pub fn load_icons(paths: Vec<String>) -> Vec<ApplicationIcon> {
        let mut results = Vec::new();
        let mut to_extract = Vec::new();

        // 1. Check in-memory cache first
        {
            let mut guard = ICON_CACHE.lock().unwrap();
            let cache = guard.get_or_insert_with(HashMap::new);

            for path in paths.into_iter().take(Self::MAX_BATCH_SIZE) {
                if let Some(cached_data_url) = cache.get(&path) {
                    results.push(ApplicationIcon {
                        path: path.clone(),
                        data_url: cached_data_url.clone(),
                    });
                } else {
                    to_extract.push(path);
                }
            }
        }

        if to_extract.is_empty() {
            return results;
        }

        // 2. Extract icons natively for uncached paths
        let extracted = Self::extract_batch(&to_extract);

        // 3. Update cache with newly extracted icons
        {
            let mut guard = ICON_CACHE.lock().unwrap();
            if let Some(cache) = guard.as_mut() {
                for icon in &extracted {
                    cache.insert(icon.path.clone(), icon.data_url.clone());
                }
            }
        }

        results.extend(extracted);
        results
    }

    fn clean_icon_path(raw: &str) -> Option<String> {
        let mut s = raw.trim();
        if s.is_empty() {
            return None;
        }
        if s.starts_with('"') {
            if let Some(second_quote) = s[1..].find('"') {
                s = &s[1..=second_quote];
            } else {
                s = s.trim_matches('"');
            }
        } else if s.contains(',') {
            s = s.split(',').next().unwrap_or(s);
        }
        let s_clean = s.trim().trim_matches('"').trim();
        if s_clean.is_empty() {
            return None;
        }

        let pb = std::path::PathBuf::from(s_clean);
        if pb.exists() {
            return Some(pb.to_string_lossy().to_string());
        }

        if s_clean.contains('%') {
            let mut expanded = s_clean.to_string();
            for (k, v) in std::env::vars() {
                let var_name = format!("%{}%", k);
                if expanded.contains(&var_name) {
                    expanded = expanded.replace(&var_name, &v);
                }
            }
            let exp_pb = std::path::PathBuf::from(&expanded);
            if exp_pb.exists() {
                return Some(exp_pb.to_string_lossy().to_string());
            }
        }

        None
    }

    fn extract_batch(paths: &[String]) -> Vec<ApplicationIcon> {
        let mut icons = Vec::new();

        for p in paths {
            let clean_p = match Self::clean_icon_path(p) {
                Some(c) => c,
                None => continue,
            };

            let path_obj = Path::new(&clean_p);
            let ext = path_obj
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();

            if ext == "ico" {
                if let Ok(bytes) = std::fs::read(path_obj) {
                    let b64 = Self::bytes_to_base64(&bytes);
                    icons.push(ApplicationIcon {
                        path: p.clone(),
                        data_url: format!("data:image/x-icon;base64,{}", b64),
                    });
                    continue;
                }
            } else if ext == "png" {
                if let Ok(bytes) = std::fs::read(path_obj) {
                    let b64 = Self::bytes_to_base64(&bytes);
                    icons.push(ApplicationIcon {
                        path: p.clone(),
                        data_url: format!("data:image/png;base64,{}", b64),
                    });
                    continue;
                }
            }

            // High-performance native Win32 Shell API icon extraction (<0.1ms, zero process spawn)
            #[cfg(target_os = "windows")]
            {
                if let Some(bmp_bytes) = extract_win32_icon_bmp(&clean_p) {
                    let b64 = Self::bytes_to_base64(&bmp_bytes);
                    icons.push(ApplicationIcon {
                        path: p.clone(),
                        data_url: format!("data:image/bmp;base64,{}", b64),
                    });
                }
            }
        }

        icons
    }

    fn bytes_to_base64(bytes: &[u8]) -> String {
        const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
        for chunk in bytes.chunks(3) {
            let b0 = chunk[0];
            let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
            let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };

            let idx0 = (b0 >> 2) as usize;
            let idx1 = (((b0 & 0x03) << 4) | (b1 >> 4)) as usize;
            let idx2 = (((b1 & 0x0f) << 2) | (b2 >> 6)) as usize;
            let idx3 = (b2 & 0x3f) as usize;

            out.push(CHARS[idx0] as char);
            out.push(CHARS[idx1] as char);
            if chunk.len() > 1 {
                out.push(CHARS[idx2] as char);
            } else {
                out.push('=');
            }
            if chunk.len() > 2 {
                out.push(CHARS[idx3] as char);
            } else {
                out.push('=');
            }
        }
        out
    }
}

#[cfg(target_os = "windows")]
fn extract_win32_icon_bmp(path: &str) -> Option<Vec<u8>> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC,
    };
    use windows_sys::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
    use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

    let p = std::path::Path::new(path);
    if !p.exists() {
        return None;
    }

    let wide: Vec<u16> = p
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let mut shfi: SHFILEINFOW = unsafe { std::mem::zeroed() };
    let res = unsafe {
        SHGetFileInfoW(
            wide.as_ptr(),
            0,
            &mut shfi,
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };

    if res == 0 || shfi.hIcon == 0 as _ {
        return None;
    }

    let hicon: HICON = shfi.hIcon;
    let mut icon_info: ICONINFO = unsafe { std::mem::zeroed() };
    let ok = unsafe { GetIconInfo(hicon, &mut icon_info) };
    if ok == 0 {
        unsafe { DestroyIcon(hicon) };
        return None;
    }

    let mut bmp: BITMAP = unsafe { std::mem::zeroed() };
    let get_obj_ok = unsafe {
        GetObjectW(
            icon_info.hbmColor,
            std::mem::size_of::<BITMAP>() as i32,
            &mut bmp as *mut _ as *mut _,
        )
    };

    if get_obj_ok == 0 || bmp.bmWidth <= 0 || bmp.bmHeight <= 0 {
        unsafe {
            if icon_info.hbmColor != 0 as _ {
                DeleteObject(icon_info.hbmColor as _);
            }
            if icon_info.hbmMask != 0 as _ {
                DeleteObject(icon_info.hbmMask as _);
            }
            DestroyIcon(hicon);
        }
        return None;
    }

    let width = bmp.bmWidth;
    let height = bmp.bmHeight;
    let mut bih: BITMAPINFOHEADER = unsafe { std::mem::zeroed() };
    bih.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bih.biWidth = width;
    bih.biHeight = height; // bottom-up for standard BMP
    bih.biPlanes = 1;
    bih.biBitCount = 32;
    bih.biCompression = BI_RGB;

    let pixel_count = (width * height) as usize;
    let mut pixels = vec![0u8; pixel_count * 4];

    let hdc: HDC = unsafe { CreateCompatibleDC(0 as _) };
    if hdc == 0 as _ {
        unsafe {
            if icon_info.hbmColor != 0 as _ {
                DeleteObject(icon_info.hbmColor as _);
            }
            if icon_info.hbmMask != 0 as _ {
                DeleteObject(icon_info.hbmMask as _);
            }
            DestroyIcon(hicon);
        }
        return None;
    }

    let lines = unsafe {
        GetDIBits(
            hdc,
            icon_info.hbmColor,
            0,
            height as u32,
            pixels.as_mut_ptr() as *mut _,
            &mut bih as *mut _ as *mut BITMAPINFO,
            DIB_RGB_COLORS,
        )
    };

    // If all pixels have 0 alpha (common in 24-bit color icons), populate alpha from hbmMask
    let has_alpha = pixels.chunks_exact(4).any(|p| p[3] != 0);
    if !has_alpha && icon_info.hbmMask != 0 as _ {
        let mut mask_bih: BITMAPINFOHEADER = unsafe { std::mem::zeroed() };
        mask_bih.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        mask_bih.biWidth = width;
        mask_bih.biHeight = height;
        mask_bih.biPlanes = 1;
        mask_bih.biBitCount = 32;
        mask_bih.biCompression = BI_RGB;

        let mut mask_pixels = vec![0u8; pixel_count * 4];
        let mask_lines = unsafe {
            GetDIBits(
                hdc,
                icon_info.hbmMask,
                0,
                height as u32,
                mask_pixels.as_mut_ptr() as *mut _,
                &mut mask_bih as *mut _ as *mut BITMAPINFO,
                DIB_RGB_COLORS,
            )
        };

        if mask_lines > 0 {
            for (p, m) in pixels.chunks_exact_mut(4).zip(mask_pixels.chunks_exact(4)) {
                // If mask is black (0), pixel is opaque (255). If mask is white (255), pixel is transparent (0).
                p[3] = if m[0] == 0 { 255 } else { 0 };
            }
        } else {
            for p in pixels.chunks_exact_mut(4) {
                p[3] = 255;
            }
        }
    }

    unsafe {
        DeleteDC(hdc);
        if icon_info.hbmColor != 0 as _ {
            DeleteObject(icon_info.hbmColor as _);
        }
        if icon_info.hbmMask != 0 as _ {
            DeleteObject(icon_info.hbmMask as _);
        }
        DestroyIcon(hicon);
    }

    if lines == 0 {
        return None;
    }

    // Build standard 32-bit BMP in memory
    let file_header_len = 14usize;
    let dib_header_len = 40usize;
    let total_len = file_header_len + dib_header_len + pixels.len();

    let mut bmp_data = Vec::with_capacity(total_len);
    // 1. BITMAPFILEHEADER
    bmp_data.extend_from_slice(b"BM");
    bmp_data.extend_from_slice(&(total_len as u32).to_le_bytes());
    bmp_data.extend_from_slice(&0u16.to_le_bytes());
    bmp_data.extend_from_slice(&0u16.to_le_bytes());
    bmp_data.extend_from_slice(&((file_header_len + dib_header_len) as u32).to_le_bytes());

    // 2. BITMAPINFOHEADER
    bmp_data.extend_from_slice(&(dib_header_len as u32).to_le_bytes());
    bmp_data.extend_from_slice(&(width as i32).to_le_bytes());
    bmp_data.extend_from_slice(&(height as i32).to_le_bytes());
    bmp_data.extend_from_slice(&1u16.to_le_bytes());
    bmp_data.extend_from_slice(&32u16.to_le_bytes());
    bmp_data.extend_from_slice(&0u32.to_le_bytes()); // BI_RGB
    bmp_data.extend_from_slice(&(pixels.len() as u32).to_le_bytes());
    bmp_data.extend_from_slice(&0u32.to_le_bytes());
    bmp_data.extend_from_slice(&0u32.to_le_bytes());
    bmp_data.extend_from_slice(&0u32.to_le_bytes());
    bmp_data.extend_from_slice(&0u32.to_le_bytes());

    // 3. Pixel data (BGRA)
    bmp_data.extend_from_slice(&pixels);

    Some(bmp_data)
}
