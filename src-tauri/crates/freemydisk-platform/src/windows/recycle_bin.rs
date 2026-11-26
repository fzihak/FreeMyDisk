//! Fast Recycle Bin emptying with progress.
//!
//! `SHEmptyRecycleBinW` deletes every file one at a time, drive after drive, and
//! reports no progress. A bin that holds a few deleted folders can contain tens
//! of thousands of files, so it looks frozen for minutes. Here the current
//! user's bin folders on every drive are listed first, then their files are
//! deleted on several threads at once while a counter reports progress. A final
//! `SHEmptyRecycleBinW` call removes anything left and refreshes the shell.
//!
//! Only `<drive>\$Recycle.Bin\<current user SID>\` is touched, which is exactly
//! what the shell's own "Empty Recycle Bin" removes. Links inside the bin are
//! deleted as links and never followed.

use crate::traits::PlatformError;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Progress of [`empty_fast`], reported a few times a second.
#[derive(Debug, Clone, Copy, Default)]
pub struct EmptyProgress {
    pub files_total: u64,
    pub files_deleted: u64,
    pub bytes_total: u64,
    pub bytes_deleted: u64,
}

/// What the bins hold right now: real file count, not the shell's item count.
#[derive(Debug, Clone, Copy, Default)]
pub struct BinContents {
    pub files: u64,
    pub bytes: u64,
}

/// Result of [`empty_fast`].
#[derive(Debug, Clone, Copy, Default)]
pub struct EmptyOutcome {
    pub bytes_freed: u64,
    pub files_deleted: u64,
    pub files_failed: u64,
}

/// The current user's SID as a string, e.g. `S-1-5-21-…-1001`.
pub fn current_user_sid() -> Option<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return None;
        }
        let mut len = 0u32;
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut len);
        let mut buf = vec![0u8; len as usize];
        let ok = GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), len, &mut len);
        CloseHandle(token);
        if ok == 0 {
            return None;
        }
        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut wide: *mut u16 = std::ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut wide) == 0 || wide.is_null() {
            return None;
        }
        let mut n = 0;
        while *wide.add(n) != 0 {
            n += 1;
        }
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(wide, n));
        LocalFree(wide.cast());
        Some(sid)
    }
}

/// The current user's bin folder on every drive that has one.
pub fn user_bin_folders() -> Vec<PathBuf> {
    use windows_sys::Win32::Storage::FileSystem::GetLogicalDrives;
    let Some(sid) = current_user_sid() else {
        return Vec::new();
    };
    let mask = unsafe { GetLogicalDrives() };
    (0..26u8)
        .filter(|i| mask & (1 << i) != 0)
        .map(|i| PathBuf::from(format!("{}:\\$Recycle.Bin\\{}", (b'A' + i) as char, sid)))
        .filter(|p| p.is_dir())
        .collect()
}

/// Files and folders found under the bins, deepest folders last.
#[derive(Default)]
struct Inventory {
    files: Vec<(PathBuf, u64)>,
    dirs: Vec<(PathBuf, usize)>, // (path, depth)
    links: Vec<PathBuf>,
}

fn is_link(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    meta.file_type().is_symlink() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

fn walk(dir: &Path, depth: usize, inv: &mut Inventory) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if is_link(&meta) {
            // Delete the link itself; never walk into what it points to.
            inv.links.push(path);
        } else if meta.is_dir() {
            inv.dirs.push((path.clone(), depth + 1));
            walk(&path, depth + 1, inv);
        } else {
            inv.files.push((path, meta.len()));
        }
    }
}

/// Lists everything in the given bin folders. `desktop.ini` at the top of a bin
/// is kept, as the shell keeps it.
fn inventory(bins: &[PathBuf]) -> Inventory {
    let mut all = Inventory::default();
    for bin in bins {
        let mut inv = Inventory::default();
        walk(bin, 0, &mut inv);
        inv.files.retain(|(p, _)| {
            !(p.parent() == Some(bin.as_path())
                && p.file_name()
                    .is_some_and(|n| n.eq_ignore_ascii_case("desktop.ini")))
        });
        all.files.extend(inv.files);
        all.dirs.extend(inv.dirs);
        all.links.extend(inv.links);
    }
    all
}

/// Real number of files and bytes in the current user's bins.
pub fn contents() -> BinContents {
    let inv = inventory(&user_bin_folders());
    BinContents {
        files: inv.files.len() as u64,
        bytes: inv.files.iter().map(|(_, s)| s).sum(),
    }
}

fn remove_file_forced(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            if let Ok(meta) = std::fs::metadata(path) {
                let mut perms = meta.permissions();
                #[allow(clippy::permissions_set_readonly_false)]
                perms.set_readonly(false);
                let _ = std::fs::set_permissions(path, perms);
            }
            std::fs::remove_file(path)
        }
        other => other,
    }
}

/// Empties the current user's Recycle Bin on every drive, deleting files on
/// several threads, and calls `on_progress` a few times a second.
pub fn empty_fast<F>(on_progress: F) -> Result<EmptyOutcome, PlatformError>
where
    F: Fn(EmptyProgress) + Sync,
{
    let before = super::maintenance::WindowsSystemMaintenanceHandler::query_recycle_bin()
        .map(|(b, _)| b)
        .unwrap_or(0);

    let bins = user_bin_folders();
    let mut inv = inventory(&bins);
    // Largest files first, so the threads finish together.
    inv.files.sort_unstable_by_key(|f| std::cmp::Reverse(f.1));
    let files_total = inv.files.len() as u64;
    let bytes_total: u64 = inv.files.iter().map(|(_, s)| s).sum();

    let deleted = AtomicU64::new(0);
    let bytes_deleted = AtomicU64::new(0);
    let failed = AtomicU64::new(0);
    let next = AtomicUsize::new(0);
    let report = |done: bool| {
        let p = EmptyProgress {
            files_total,
            files_deleted: deleted.load(Ordering::Relaxed),
            bytes_total,
            bytes_deleted: bytes_deleted.load(Ordering::Relaxed),
        };
        if done || p.files_deleted <= p.files_total {
            on_progress(p);
        }
    };
    report(false);

    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(2, 8);
    let last_report = Mutex::new(Instant::now());

    std::thread::scope(|s| {
        for _ in 0..workers {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some((path, size)) = inv.files.get(i) else {
                    break;
                };
                if remove_file_forced(path).is_ok() {
                    deleted.fetch_add(1, Ordering::Relaxed);
                    bytes_deleted.fetch_add(*size, Ordering::Relaxed);
                } else {
                    failed.fetch_add(1, Ordering::Relaxed);
                }
                if let Ok(mut last) = last_report.try_lock() {
                    if last.elapsed() >= Duration::from_millis(150) {
                        *last = Instant::now();
                        report(false);
                    }
                }
            });
        }
    });

    for link in &inv.links {
        let _ = std::fs::remove_file(link).or_else(|_| std::fs::remove_dir(link));
    }
    // Deepest folders first, so each one is empty when it is removed.
    inv.dirs.sort_unstable_by_key(|d| std::cmp::Reverse(d.1));
    for (dir, _) in &inv.dirs {
        let _ = std::fs::remove_dir(dir);
    }

    // Removes anything left (files we could not delete, other bin entries) and
    // lets the shell refresh the Recycle Bin icon and its index.
    unsafe {
        use windows_sys::Win32::UI::Shell::{
            SHEmptyRecycleBinW, SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI, SHERB_NOSOUND,
        };
        let flags = SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND;
        SHEmptyRecycleBinW(std::ptr::null_mut(), std::ptr::null(), flags);
    }
    report(true);

    let after = super::maintenance::WindowsSystemMaintenanceHandler::query_recycle_bin()
        .map(|(b, _)| b)
        .unwrap_or(0);
    let freed = before
        .saturating_sub(after)
        .max(bytes_deleted.load(Ordering::Relaxed));
    Ok(EmptyOutcome {
        bytes_freed: freed,
        files_deleted: deleted.load(Ordering::Relaxed),
        files_failed: failed.load(Ordering::Relaxed),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sid_is_found_for_the_current_user() {
        let sid = current_user_sid().expect("current user SID");
        assert!(sid.starts_with("S-1-"), "{sid}");
    }

    #[test]
    fn inventory_lists_nested_files_and_keeps_desktop_ini() {
        let bin = tempfile::tempdir().unwrap();
        let root = bin.path().to_path_buf();
        std::fs::write(root.join("desktop.ini"), b"x").unwrap();
        std::fs::write(root.join("$IABC.txt"), b"meta").unwrap();
        let folder = root.join("$RABC");
        std::fs::create_dir_all(folder.join("a").join("b")).unwrap();
        std::fs::write(folder.join("a").join("b").join("f1"), b"12345").unwrap();
        std::fs::write(folder.join("f2"), b"123").unwrap();

        let inv = inventory(&[root]);
        assert_eq!(inv.files.len(), 3, "desktop.ini at the top is kept");
        assert_eq!(inv.files.iter().map(|(_, s)| s).sum::<u64>(), 12);
        assert_eq!(inv.dirs.len(), 3);
        let deepest = inv.dirs.iter().map(|(_, d)| *d).max().unwrap();
        assert_eq!(deepest, 3);
    }
}
