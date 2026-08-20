use crate::cleanup::disposal::{DisposalEngine, DisposalItemResult, DisposalSummary};
use crate::cleanup::plan::CleanupPlanItem;
use crate::cleanup::protected_paths::ProtectedPathRegistry;
use crate::filesystem::journal::CrashRecoveryJournal;
use crate::shared::errors::CoreError;
use crate::shared::progress::CancellationToken;
use freemydisk_platform::traits::PlatformFilesystem;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum FileCategory {
    Media,
    Archives,
    Documents,
    Binaries,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LargeFileEntry {
    pub path: PathBuf,
    pub name: String,
    pub size_bytes: u64,
    pub modified_at: u64,
    pub category: FileCategory,
    pub extension: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LargeFilesScanResult {
    pub total_files: usize,
    pub total_bytes: u64,
    pub files: Vec<LargeFileEntry>,
}

pub struct LargeFilesScanner;

impl LargeFilesScanner {
    pub fn classify_extension(ext: &str) -> FileCategory {
        let ext_lower = ext.to_ascii_lowercase();
        match ext_lower.as_str() {
            "mp4" | "mkv" | "avi" | "mov" | "wmv" | "flv" | "webm" | "mp3" | "wav" | "flac"
            | "aac" | "ogg" | "m4a" | "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" | "raw"
            | "svg" | "tiff" | "psd" => FileCategory::Media,

            "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "iso" | "dmg" | "vhd" | "vhdx"
            | "cab" | "pkg" | "deb" | "rpm" => FileCategory::Archives,

            "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "csv" | "rtf"
            | "epub" | "md" => FileCategory::Documents,

            "exe" | "msi" | "dll" | "sys" | "so" | "dylib" | "bin" | "app" | "apk" | "com" => {
                FileCategory::Binaries
            }

            _ => FileCategory::Other,
        }
    }

    pub fn scan_large_files(
        roots: &[PathBuf],
        min_size_bytes: u64,
        cancel: &CancellationToken,
    ) -> Result<LargeFilesScanResult, CoreError> {
        Self::scan_large_files_with_progress(roots, min_size_bytes, cancel, |_, _, _| {})
    }

    pub fn scan_large_files_with_progress<F>(
        roots: &[PathBuf],
        min_size_bytes: u64,
        cancel: &CancellationToken,
        mut on_progress: F,
    ) -> Result<LargeFilesScanResult, CoreError>
    where
        F: FnMut(&Path, u64, u64),
    {
        let mut files = Vec::new();
        let mut total_bytes = 0u64;
        let mut items_scanned = 0u64;
        let mut last_emit = std::time::Instant::now();

        for root in roots {
            if cancel.is_cancelled() {
                return Err(CoreError::Cancelled);
            }

            if !root.exists() {
                continue;
            }

            #[cfg(target_os = "windows")]
            {
                let cancel_fn = || cancel.is_cancelled();
                let mut callback =
                    |entry_path: &Path, name: &str, size: u64, is_dir: bool| -> bool {
                        items_scanned += 1;
                        if last_emit.elapsed().as_millis() >= 33 {
                            on_progress(entry_path, items_scanned, total_bytes);
                            last_emit = std::time::Instant::now();
                        }

                        if ProtectedPathRegistry::is_protected(entry_path) {
                            return false;
                        }
                        if !is_dir && size >= min_size_bytes {
                            let extension = entry_path
                                .extension()
                                .and_then(|s| s.to_str())
                                .unwrap_or("")
                                .to_string();
                            let category = Self::classify_extension(&extension);
                            let modified_at = entry_path
                                .metadata()
                                .ok()
                                .and_then(|m| m.modified().ok())
                                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                .map(|d| d.as_secs())
                                .unwrap_or(0);

                            total_bytes += size;
                            files.push(LargeFileEntry {
                                path: entry_path.to_path_buf(),
                                name: name.to_string(),
                                size_bytes: size,
                                modified_at,
                                category,
                                extension,
                            });
                        }
                        true
                    };

                if let Err(e) = freemydisk_platform::windows::win32_fast_scan::win32_traverse_tree(
                    root,
                    &cancel_fn,
                    &mut callback,
                ) {
                    if e.kind() == std::io::ErrorKind::Interrupted {
                        return Err(CoreError::Cancelled);
                    }
                }
            }

            #[cfg(not(target_os = "windows"))]
            {
                let mut it = walkdir::WalkDir::new(root)
                    .min_depth(1)
                    .follow_links(false)
                    .into_iter();

                while let Some(entry_res) = it.next() {
                    if cancel.is_cancelled() {
                        return Err(CoreError::Cancelled);
                    }

                    let entry = match entry_res {
                        Ok(e) => e,
                        Err(_) => continue,
                    };

                    let path = entry.path();
                    items_scanned += 1;
                    if last_emit.elapsed().as_millis() >= 33 {
                        on_progress(path, items_scanned, total_bytes);
                        last_emit = std::time::Instant::now();
                    }

                    if entry.file_type().is_dir() {
                        if ProtectedPathRegistry::is_protected(path) {
                            it.skip_current_dir();
                        }
                        continue;
                    }

                    if entry.file_type().is_file() {
                        if ProtectedPathRegistry::is_protected(path) {
                            continue;
                        }

                        let len = entry.metadata().map(|m| m.len()).unwrap_or(0);
                        if len >= min_size_bytes {
                            let name = entry.file_name().to_string_lossy().to_string();
                            let extension = path
                                .extension()
                                .and_then(|s| s.to_str())
                                .unwrap_or("")
                                .to_string();
                            let category = Self::classify_extension(&extension);

                            let modified_at = entry
                                .metadata()
                                .ok()
                                .and_then(|m| m.modified().ok())
                                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                .map(|d| d.as_secs())
                                .unwrap_or(0);

                            total_bytes += len;
                            files.push(LargeFileEntry {
                                path: path.to_path_buf(),
                                name,
                                size_bytes: len,
                                modified_at,
                                category,
                                extension,
                            });
                        }
                    }
                }
            }
        }

        // Final progress emit
        if let Some(first_root) = roots.first() {
            on_progress(first_root, items_scanned, total_bytes);
        }

        // Sort descending by size by default
        files.sort_by_key(|f| std::cmp::Reverse(f.size_bytes));
        let total_files = files.len();

        Ok(LargeFilesScanResult {
            total_files,
            total_bytes,
            files,
        })
    }

    /// Quick-trash multiple files in batch using Trash-First disposal model.
    pub fn trash_large_files(
        paths: &[PathBuf],
        platform: &dyn PlatformFilesystem,
        journal: &CrashRecoveryJournal,
        lock_dir: &Path,
    ) -> Result<DisposalSummary, CoreError> {
        Self::trash_large_files_with_progress(paths, platform, journal, lock_dir, |_, _, _, _| {})
    }

    /// Quick-trash multiple files in batch with real-time progress callbacks.
    pub fn trash_large_files_with_progress<F>(
        paths: &[PathBuf],
        platform: &dyn PlatformFilesystem,
        journal: &CrashRecoveryJournal,
        lock_dir: &Path,
        on_progress: F,
    ) -> Result<DisposalSummary, CoreError>
    where
        F: FnMut(usize, usize, &Path, u64),
    {
        let items: Vec<CleanupPlanItem> = paths
            .iter()
            .map(|path| {
                let size = path.metadata().map(|m| m.len()).unwrap_or(0);
                let canon = dunce::canonicalize(path)
                    .unwrap_or_else(|_| dunce::simplified(path).to_path_buf());
                CleanupPlanItem {
                    original_path: path.to_path_buf(),
                    canonical_path: canon,
                    size_bytes: size,
                    is_dir: false,
                    matched_rules: vec!["large_files".to_string()],
                    default_action: "trash".to_string(),
                    verified_rebuildable: false,
                    protect_subpaths: Vec::new(),
                    risk: "safe".to_string(),
                }
            })
            .collect();

        let cancel = CancellationToken::new();
        DisposalEngine::execute_plan_with_progress(
            &items, platform, journal, lock_dir, true, // Always Trash
            &cancel,
            on_progress,
        )
    }

    /// Quick-trash individual file using Trash-First disposal model.
    pub fn trash_large_file(
        path: &Path,
        platform: &dyn PlatformFilesystem,
        journal: &CrashRecoveryJournal,
        lock_dir: &Path,
    ) -> Result<DisposalItemResult, CoreError> {
        let summary = Self::trash_large_files(&[path.to_path_buf()], platform, journal, lock_dir)?;
        summary
            .results
            .into_iter()
            .next()
            .ok_or_else(|| CoreError::Cancelled)
    }
}
