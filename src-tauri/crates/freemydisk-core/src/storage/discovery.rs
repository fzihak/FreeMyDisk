//! Parallel file discovery shared by the Large Files and Duplicates scans.
//!
//! Every root (drive) and every folder below it is listed as its own rayon task,
//! so several drives and folders are read at once. On Windows each folder is read
//! with one `FindFirstFileExW` listing (basic info, large fetch), which already
//! carries size, attributes and modification time, so no file is opened.

use crate::cleanup::protected_paths::ProtectedPathRegistry;
use crate::shared::errors::CoreError;
use crate::shared::progress::CancellationToken;
use parking_lot::Mutex;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

/// Operating-system files that are never offered for deletion, wherever they are
/// found (every drive can hold its own page file).
pub const OS_CRITICAL_FILE_NAMES: &[&str] = &[
    "pagefile.sys",
    "swapfile.sys",
    "hiberfil.sys",
    "DumpStack.log.tmp",
    "DumpStack.log",
];

/// Per-drive system folders that are never entered.
pub const OS_CRITICAL_DIR_NAMES: &[&str] = &["System Volume Information", "$Recycle.Bin"];

/// A file found by [`discover_files`].
#[derive(Debug, Clone)]
pub struct DiscoveredFile {
    pub path: PathBuf,
    pub size: u64,
    /// Last write time in nanoseconds since the Unix epoch (0 when unknown).
    pub modified_nanos: u64,
    /// Cloud file whose data is not on disk (OneDrive "online-only" and similar).
    pub is_cloud_placeholder: bool,
}

/// Decides which folders a file scan skips and which files it never reports.
pub struct ScanExclusions {
    /// Upper-case, backslash-separated system paths with no trailing separator.
    critical: Vec<String>,
}

impl Default for ScanExclusions {
    fn default() -> Self {
        Self::new()
    }
}

fn normalize(path: &str) -> String {
    let mut s = path.replace('/', "\\").to_ascii_uppercase();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        s = format!(r"\\{}", rest);
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        s = rest.to_string();
    }
    s.trim_end_matches('\\').to_string()
}

impl ScanExclusions {
    pub fn new() -> Self {
        let mut critical: Vec<String> = ProtectedPathRegistry::system_critical_paths()
            .iter()
            .map(|p| normalize(&p.to_string_lossy()))
            .filter(|p| !p.is_empty())
            .collect();
        critical.sort();
        critical.dedup();
        Self { critical }
    }

    fn in_critical(&self, path: &Path) -> bool {
        let norm = normalize(&path.to_string_lossy());
        self.critical.iter().any(|c| {
            norm == *c
                || (norm.len() > c.len()
                    && norm.starts_with(c.as_str())
                    && norm.as_bytes()[c.len()] == b'\\')
        })
    }

    /// True for a folder the scan must not enter: Windows, Program Files and the
    /// other system locations, `System Volume Information`, and `$Recycle.Bin`.
    /// User folders such as `C:\Users\<name>\Downloads` are entered.
    pub fn skip_dir(&self, path: &Path) -> bool {
        let named = path.file_name().is_some_and(|name| {
            OS_CRITICAL_DIR_NAMES
                .iter()
                .any(|n| OsStr::new(n).eq_ignore_ascii_case(name))
        });
        named || self.in_critical(path)
    }

    /// True for a file that is part of the operating system (page file, hibernation
    /// file, ...) or lies inside a system location.
    pub fn skip_file(&self, path: &Path) -> bool {
        let named = path.file_name().is_some_and(|name| {
            OS_CRITICAL_FILE_NAMES
                .iter()
                .any(|n| OsStr::new(n).eq_ignore_ascii_case(name))
        });
        named || self.in_critical(path)
    }
}

/// Live counters a caller can poll while [`discover_files`] runs.
#[derive(Default)]
pub struct DiscoveryProgress {
    pub items_scanned: AtomicU64,
    pub bytes_found: AtomicU64,
    pub current_path: Mutex<PathBuf>,
}

struct Walk<'a, V> {
    min_size: u64,
    exclusions: &'a ScanExclusions,
    cancel: &'a CancellationToken,
    progress: &'a DiscoveryProgress,
    visit: &'a V,
    #[cfg(target_os = "windows")]
    large_fetch: AtomicBool,
}

impl<V: Fn(DiscoveredFile) + Sync> Walk<'_, V> {
    fn file(&self, path: PathBuf, size: u64, modified_nanos: u64, is_cloud_placeholder: bool) {
        if size == 0 || size < self.min_size || self.exclusions.skip_file(&path) {
            return;
        }
        self.progress.bytes_found.fetch_add(size, Ordering::Relaxed);
        (self.visit)(DiscoveredFile {
            path,
            size,
            modified_nanos,
            is_cloud_placeholder,
        });
    }

    fn dir<'s>(&'s self, scope: &rayon::Scope<'s>, dir: PathBuf) {
        if self.cancel.is_cancelled() {
            return;
        }
        if let Some(mut current) = self.progress.current_path.try_lock() {
            current.clone_from(&dir);
        }

        let mut subdirs = Vec::new();
        let mut count = 0u64;

        #[cfg(target_os = "windows")]
        {
            let listing = crate::shared::paths::to_extended_path(&dir);
            let _ = freemydisk_platform::windows::win32_fast_scan::win32_list_dir(
                &listing,
                &self.large_fetch,
                |entry| {
                    count += 1;
                    // Symlinks and junctions are not followed, so the scan never
                    // leaves its roots or loops.
                    if entry.is_reparse {
                        return;
                    }
                    let path = dir.join(&entry.name);
                    if entry.is_dir {
                        subdirs.push(path);
                    } else {
                        let placeholder = entry.is_cloud_placeholder();
                        self.file(
                            path,
                            entry.size_bytes,
                            entry.modified_unix_nanos(),
                            placeholder,
                        );
                    }
                },
            );
        }

        #[cfg(not(target_os = "windows"))]
        if let Ok(read_dir) = std::fs::read_dir(&dir) {
            for entry in read_dir.flatten() {
                count += 1;
                let Ok(file_type) = entry.file_type() else {
                    continue;
                };
                if file_type.is_dir() {
                    subdirs.push(entry.path());
                } else if file_type.is_file() {
                    let Ok(meta) = entry.metadata() else { continue };
                    let modified = meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| u64::try_from(d.as_nanos()).unwrap_or(u64::MAX))
                        .unwrap_or(0);
                    self.file(entry.path(), meta.len(), modified, false);
                }
            }
        }

        self.progress
            .items_scanned
            .fetch_add(count, Ordering::Relaxed);
        for sub in subdirs {
            if !self.exclusions.skip_dir(&sub) {
                scope.spawn(move |s| self.dir(s, sub));
            }
        }
    }
}

/// Finds every regular file of at least `min_size` bytes (and never empty) under
/// `roots`, calling `visit` from worker threads. Excluded folders are not entered
/// and excluded files are not reported (see [`ScanExclusions`]). The roots
/// themselves are always entered.
pub fn discover_files<V>(
    roots: &[PathBuf],
    min_size: u64,
    exclusions: &ScanExclusions,
    cancel: &CancellationToken,
    progress: &DiscoveryProgress,
    visit: V,
) -> Result<(), CoreError>
where
    V: Fn(DiscoveredFile) + Sync,
{
    let walk = Walk {
        min_size,
        exclusions,
        cancel,
        progress,
        visit: &visit,
        #[cfg(target_os = "windows")]
        large_fetch: AtomicBool::new(true),
    };
    rayon::scope(|scope| {
        for root in roots {
            if root.is_dir() {
                let walk = &walk;
                let root = root.clone();
                scope.spawn(move |s| walk.dir(s, root));
            }
        }
    });
    if cancel.is_cancelled() {
        return Err(CoreError::Cancelled);
    }
    Ok(())
}

/// Runs `work` on a helper thread and calls `tick` on the calling thread about
/// every 33 ms until it finishes, so progress callbacks that are not `Send` keep
/// running on the caller's thread.
pub fn run_with_ticks<R, W, T>(work: W, mut tick: T) -> R
where
    R: Send,
    W: FnOnce() -> R + Send,
    T: FnMut(),
{
    let caller = std::thread::current();
    std::thread::scope(|scope| {
        let handle = scope.spawn(|| {
            // Wakes the caller even if `work` panics.
            struct WakeOnDrop(std::thread::Thread);
            impl Drop for WakeOnDrop {
                fn drop(&mut self) {
                    self.0.unpark();
                }
            }
            let _wake = WakeOnDrop(caller.clone());
            work()
        });
        while !handle.is_finished() {
            std::thread::park_timeout(Duration::from_millis(33));
            tick();
        }
        match handle.join() {
            Ok(result) => result,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn collect(roots: &[PathBuf], min: u64) -> Vec<DiscoveredFile> {
        let found = Mutex::new(Vec::new());
        discover_files(
            roots,
            min,
            &ScanExclusions::new(),
            &CancellationToken::new(),
            &DiscoveryProgress::default(),
            |f| found.lock().push(f),
        )
        .unwrap();
        let mut v = found.into_inner();
        v.sort_by(|a, b| a.path.cmp(&b.path));
        v
    }

    #[test]
    fn finds_nested_files_above_threshold() {
        let dir = tempfile::tempdir().unwrap();
        let deep = dir.path().join("a").join("b").join("c");
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("big.bin"), vec![1u8; 5000]).unwrap();
        fs::write(dir.path().join("small.bin"), vec![1u8; 10]).unwrap();
        fs::write(dir.path().join("empty.bin"), b"").unwrap();

        let found = collect(&[dir.path().to_path_buf()], 100);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, deep.join("big.bin"));
        assert_eq!(found[0].size, 5000);
        assert!(found[0].modified_nanos > 0);
        assert!(!found[0].is_cloud_placeholder);
    }

    #[test]
    fn os_files_and_system_folders_are_excluded() {
        let dir = tempfile::tempdir().unwrap();
        for name in OS_CRITICAL_FILE_NAMES {
            fs::write(dir.path().join(name), vec![0u8; 2048]).unwrap();
        }
        fs::write(dir.path().join("PAGEFILE.SYS.bak"), vec![0u8; 2048]).unwrap();
        for name in OS_CRITICAL_DIR_NAMES {
            let sub = dir.path().join(name);
            fs::create_dir_all(&sub).unwrap();
            fs::write(sub.join("restore_point.bin"), vec![0u8; 2048]).unwrap();
        }

        let found = collect(&[dir.path().to_path_buf()], 1024);
        let names: Vec<_> = found
            .iter()
            .map(|f| f.path.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["PAGEFILE.SYS.bak".to_string()]);
    }

    #[test]
    fn exclusions_cover_system_paths_but_not_user_folders() {
        let ex = ScanExclusions::new();
        assert!(ex.skip_file(Path::new(r"D:\pagefile.sys")));
        assert!(ex.skip_file(Path::new(r"E:\HIBERFIL.SYS")));
        assert!(ex.skip_file(Path::new(r"C:\DumpStack.log.tmp")));
        assert!(ex.skip_dir(Path::new(r"D:\System Volume Information")));
        assert!(ex.skip_dir(Path::new(r"D:\$RECYCLE.BIN")));
        assert!(!ex.skip_file(Path::new(r"D:\Games\pagefile.sys.iso")));
        assert!(!ex.skip_dir(Path::new(r"D:\Games")));
        #[cfg(target_os = "windows")]
        {
            assert!(ex.skip_dir(Path::new(r"C:\Windows")));
            assert!(ex.skip_dir(Path::new(r"C:\Windows\System32\drivers")));
            assert!(ex.skip_dir(Path::new(r"\\?\C:\Program Files")));
            let users = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
            assert!(!ex.skip_dir(Path::new(&format!(r"{users}\Users"))));
            if let Ok(home) = std::env::var("USERPROFILE") {
                assert!(!ex.skip_dir(&Path::new(&home).join("Downloads")));
            }
        }
    }

    #[test]
    fn cancelled_scan_reports_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let res = discover_files(
            &[dir.path().to_path_buf()],
            0,
            &ScanExclusions::new(),
            &cancel,
            &DiscoveryProgress::default(),
            |_| {},
        );
        assert!(matches!(res, Err(CoreError::Cancelled)));
    }
}
