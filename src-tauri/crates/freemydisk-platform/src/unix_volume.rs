//! Shared helpers for Unix-like platforms (macOS and the generic fallback).

use crate::traits::{PlatformError, StorageVolumeInfo};
use std::ffi::CString;

/// Reads real capacity and free space for the volume mounted at `mount_point`.
pub fn volume_info(
    mount_point: &str,
    volume_name: &str,
    file_system: &str,
) -> Result<StorageVolumeInfo, PlatformError> {
    let c_path = CString::new(mount_point)
        .map_err(|e| PlatformError::Unsupported(format!("Invalid mount point: {e}")))?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c_path` is a valid NUL-terminated string and `stat` is a valid
    // out-pointer for the duration of the call.
    if unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let block = stat.f_frsize as u64;
    Ok(StorageVolumeInfo {
        mount_point: mount_point.to_string(),
        volume_name: volume_name.to_string(),
        total_bytes: (stat.f_blocks as u64).saturating_mul(block),
        available_bytes: (stat.f_bavail as u64).saturating_mul(block),
        file_system: file_system.to_string(),
        is_removable: false,
    })
}

/// True when the current process runs as root.
pub fn is_root() -> bool {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() == 0 }
}
