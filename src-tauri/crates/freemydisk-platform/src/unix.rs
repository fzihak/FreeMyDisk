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

/// Reads memory size, host name and CPU count on Unix-like platforms.
pub fn system_vitals(os_name: &str) -> crate::traits::SystemVitals {
    // SAFETY: sysconf has no preconditions; a negative result means "unknown".
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) }.max(0) as u64;
    let total_pages = unsafe { libc::sysconf(libc::_SC_PHYS_PAGES) }.max(0) as u64;
    let total_ram_bytes = total_pages.saturating_mul(page);

    #[cfg(target_os = "linux")]
    let available_ram_bytes = {
        // SAFETY: as above.
        let avail = unsafe { libc::sysconf(libc::_SC_AVPHYS_PAGES) }.max(0) as u64;
        avail.saturating_mul(page)
    };
    // sysconf cannot report free memory on macOS; report it as fully used
    // rather than inventing a number.
    #[cfg(not(target_os = "linux"))]
    let available_ram_bytes = 0u64;

    let used_ram_bytes = total_ram_bytes.saturating_sub(available_ram_bytes);
    let memory_load_percent = if total_ram_bytes == 0 {
        0
    } else {
        ((used_ram_bytes as u128 * 100) / total_ram_bytes as u128) as u32
    };

    let mut buf = [0u8; 256];
    // SAFETY: `buf` is valid for `buf.len()` bytes.
    let computer_name = if unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0 {
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        String::from_utf8_lossy(&buf[..end]).into_owned()
    } else {
        String::new()
    };

    crate::traits::SystemVitals {
        total_ram_bytes,
        available_ram_bytes,
        used_ram_bytes,
        memory_load_percent,
        os_name: os_name.to_string(),
        computer_name,
        cpu_cores: std::thread::available_parallelism().map_or(1, |n| n.get()),
    }
}
