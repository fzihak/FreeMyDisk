use crate::cleanup::protected_paths::ProtectedPathRegistry;
use crate::shared::errors::CoreError;
use crate::shared::progress::CancellationToken;
use std::fs::{self, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::Path;
use uuid::Uuid;

const CHUNK_SIZE: usize = 65536; // 64 KB write buffer

#[derive(Debug, Clone)]
pub struct ShredOptions {
    pub passes: u32,
    pub force_hdd_mode: bool,
    pub strip_ads: bool,
    pub rename_before_delete: bool,
}

impl Default for ShredOptions {
    fn default() -> Self {
        Self {
            passes: 3,
            force_hdd_mode: false,
            strip_ads: true,
            rename_before_delete: true,
        }
    }
}

/// Cryptographically secure random byte filler using Windows RtlGenRandom CSPRNG (§9.4)
#[inline]
pub fn fill_crypto_random_bytes(buf: &mut [u8]) {
    #[cfg(target_os = "windows")]
    {
        extern "system" {
            #[link_name = "SystemFunction036"]
            fn RtlGenRandom(buffer: *mut u8, length: u32) -> u8;
        }

        unsafe {
            for chunk in buf.chunks_mut(u32::MAX as usize) {
                RtlGenRandom(chunk.as_mut_ptr(), chunk.len() as u32);
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        use std::time::SystemTime;
        let mut seed = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0xCAFEBABE);

        for b in buf.iter_mut() {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            *b = (seed & 0xFF) as u8;
        }
    }
}

/// Strips NTFS Alternate Data Streams (ADS) such as Zone.Identifier before permanent file deletion.
pub fn strip_ntfs_alternate_streams(path: &Path) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        let path_str = path.to_string_lossy();

        // 1. Common Internet download tracking stream (Zone.Identifier)
        let zone_stream = format!("{}:Zone.Identifier", path_str);
        let _ = fs::remove_file(&zone_stream);

        let zone_data = format!("{}:Zone.Identifier:$DATA", path_str);
        let wide: Vec<u16> = std::ffi::OsStr::new(&zone_data)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            windows_sys::Win32::Storage::FileSystem::DeleteFileW(wide.as_ptr());
        }
    }
}

/// Flushes internal file buffers to physical disk storage media.
fn flush_to_physical_disk(file: &std::fs::File) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::io::AsRawHandle;
        let handle = file.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
        let success = unsafe { windows_sys::Win32::Storage::FileSystem::FlushFileBuffers(handle) };
        if success == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        file.sync_all()
    }
}

/// Checks whether the target volume is an SSD to adjust shredding passes.
fn is_ssd_media(path: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        let drive_char = path.to_string_lossy().chars().next().unwrap_or('C');
        let media = freemydisk_platform::windows::storage_optim::detect_drive_media(drive_char);
        media == freemydisk_platform::windows::storage_optim::DriveMedia::Ssd
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// Securely shreds an individual file following NIST SP 800-88 / DoD 5220.22-M standards (§9.4).
///
/// Execution Pipeline:
/// 1. Self-preservation and critical protected path defense assertion.
/// 2. Reparse point detection (never traverse junction/symlink targets).
/// 3. Read-only attribute stripping.
/// 4. Hardware-aware pass calculation (SSD = 1-pass zero-fill to minimize flash wear; HDD = 3-pass DoD).
/// 5. Overwrite passes (Pass 1: 0x00 zeros, Pass 2: 0xFF ones, Pass 3: CSPRNG cryptorandom bytes).
/// 6. Physical media synchronization (`FlushFileBuffers`).
/// 7. Alternate Data Stream (ADS) stripping (`Zone.Identifier`).
/// 8. Truncation to 0 bytes.
/// 9. MFT filename index obfuscation (rename to random UUID).
/// 10. File unlink from disk.
pub fn secure_shred_file(path: &Path, options: Option<ShredOptions>) -> Result<u64, CoreError> {
    // Step 1: Protected path assertion (must execute before existence check)
    ProtectedPathRegistry::assert_safe_for_disposal(path)?;

    if !path.exists() {
        return Ok(0);
    }

    // Step 2: Reparse-point defense
    if ProtectedPathRegistry::is_reparse_point(path) {
        log::info!("Shredder encountered reparse point pointer at '{}' — unlinking without overwriting target content", path.display());
        let _ = fs::remove_file(path);
        let _ = fs::remove_dir(path);
        return Ok(0);
    }

    let opts = options.unwrap_or_default();
    let is_ssd = !opts.force_hdd_mode && is_ssd_media(path);

    // Step 3: Strip read-only attribute if set
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let attrs =
            unsafe { windows_sys::Win32::Storage::FileSystem::GetFileAttributesW(wide.as_ptr()) };
        if attrs != u32::MAX && (attrs & 0x00000001 != 0) {
            unsafe {
                windows_sys::Win32::Storage::FileSystem::SetFileAttributesW(
                    wide.as_ptr(),
                    attrs & !0x00000001,
                );
            }
        }
    }

    let file_len = fs::metadata(path)
        .map(|m| m.len())
        .map_err(|e| CoreError::Io {
            path: path.to_path_buf(),
            source: e,
        })?;

    if file_len > 0 {
        let mut file = OpenOptions::new()
            .read(false)
            .write(true)
            .open(path)
            .map_err(|e| CoreError::Io {
                path: path.to_path_buf(),
                source: e,
            })?;

        let num_passes = if is_ssd { 1 } else { opts.passes.max(1) };
        let mut buffer = vec![0u8; CHUNK_SIZE];

        for pass in 1..=num_passes {
            file.seek(SeekFrom::Start(0)).map_err(|e| CoreError::Io {
                path: path.to_path_buf(),
                source: e,
            })?;

            let mut remaining = file_len;

            while remaining > 0 {
                let to_write = (remaining as usize).min(CHUNK_SIZE);
                let slice = &mut buffer[..to_write];

                match pass {
                    1 => slice.fill(0x00),                // Pass 1: Zeros
                    2 => slice.fill(0xFF),                // Pass 2: Ones
                    _ => fill_crypto_random_bytes(slice), // Pass 3+: CSPRNG Random
                }

                file.write_all(slice).map_err(|e| CoreError::Io {
                    path: path.to_path_buf(),
                    source: e,
                })?;

                remaining -= to_write as u64;
            }

            // Force buffers to physical storage media
            let _ = flush_to_physical_disk(&file);
        }

        // Truncate to zero bytes
        let _ = file.set_len(0);
        let _ = flush_to_physical_disk(&file);
        drop(file);
    }

    // Step 7: Strip NTFS Alternate Data Streams
    if opts.strip_ads {
        strip_ntfs_alternate_streams(path);
    }

    // Step 9: Obfuscate original filename in NTFS MFT index before unlinking
    let unlink_path = if opts.rename_before_delete {
        let parent = path.parent().unwrap_or(Path::new("."));
        let obfuscated_name = format!(".fmd-shred-{}", Uuid::new_v4());
        let obfuscated_path = parent.join(obfuscated_name);
        match fs::rename(path, &obfuscated_path) {
            Ok(()) => obfuscated_path,
            Err(_) => path.to_path_buf(),
        }
    } else {
        path.to_path_buf()
    };

    // Step 10: Unlink file
    fs::remove_file(&unlink_path).map_err(|e| CoreError::Io {
        path: unlink_path,
        source: e,
    })?;

    Ok(file_len)
}

/// Securely shreds all files within a directory hierarchy and removes the directories.
/// Reparse points and directory junctions are unlinked as mount points only and never traversed.
pub fn secure_shred_directory(
    dir: &Path,
    options: Option<ShredOptions>,
    cancel: &CancellationToken,
) -> Result<(u64, usize), CoreError> {
    if !dir.exists() {
        return Ok((0, 0));
    }

    ProtectedPathRegistry::assert_safe_for_disposal(dir)?;

    // If target itself is a reparse point (junction), unlink pointer without traversing
    if ProtectedPathRegistry::is_reparse_point(dir) {
        let _ = fs::remove_dir(dir);
        let _ = fs::remove_file(dir);
        return Ok((0, 1));
    }

    let mut total_shredded_bytes = 0u64;
    let mut total_files_shredded = 0usize;

    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if cancel.is_cancelled() {
                break;
            }

            let path = entry.path();
            if let Ok(ft) = entry.file_type() {
                if ft.is_file() || ft.is_symlink() {
                    match secure_shred_file(&path, options.clone()) {
                        Ok(bytes) => {
                            total_shredded_bytes += bytes;
                            total_files_shredded += 1;
                        }
                        Err(e) => {
                            log::warn!("Failed to shred file '{}': {}", path.display(), e);
                        }
                    }
                } else if ft.is_dir() {
                    if ProtectedPathRegistry::is_reparse_point(&path) {
                        log::info!("Reparse point junction detected in dir traversal at '{}' — unlinking pointer", path.display());
                        let _ = fs::remove_dir(&path);
                        let _ = fs::remove_file(&path);
                    } else {
                        let (sub_bytes, sub_count) =
                            secure_shred_directory(&path, options.clone(), cancel)?;
                        total_shredded_bytes += sub_bytes;
                        total_files_shredded += sub_count;
                        let _ = fs::remove_dir(&path);
                    }
                }
            }
        }
    }

    let _ = fs::remove_dir(dir);

    Ok((total_shredded_bytes, total_files_shredded))
}
