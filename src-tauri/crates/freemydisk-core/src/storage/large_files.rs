use crate::cleanup::disposal::{DisposalEngine, DisposalItemResult, DisposalSummary};
use crate::cleanup::plan::CleanupPlanItem;
use crate::filesystem::journal::CrashRecoveryJournal;
use crate::shared::errors::CoreError;
use crate::shared::progress::CancellationToken;
use crate::storage::discovery::{
    discover_files, run_with_ticks, DiscoveryProgress, ScanExclusions,
};
use freemydisk_platform::traits::PlatformFilesystem;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

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
        let exclusions = ScanExclusions::new();
        let progress = DiscoveryProgress::default();
        let found = Mutex::new(Vec::new());
        let roots: Vec<PathBuf> = roots.iter().filter(|r| r.exists()).cloned().collect();

        // All drives and folders are listed in parallel. Folders such as Windows,
        // Program Files, System Volume Information and $Recycle.Bin are not entered,
        // and OS files (pagefile.sys, hiberfil.sys, ...) are never listed: they
        // cannot be deleted and must not be offered with a delete button.
        let result = run_with_ticks(
            || {
                discover_files(
                    &roots,
                    min_size_bytes,
                    &exclusions,
                    cancel,
                    &progress,
                    |f| found.lock().push(f),
                )
            },
            || {
                let current = progress.current_path.lock().clone();
                on_progress(
                    &current,
                    progress.items_scanned.load(Ordering::Relaxed),
                    progress.bytes_found.load(Ordering::Relaxed),
                );
            },
        );
        result?;

        let mut files: Vec<LargeFileEntry> = found
            .into_inner()
            .into_iter()
            .map(|f| {
                let extension = f
                    .path
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                LargeFileEntry {
                    name: f
                        .path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    category: Self::classify_extension(&extension),
                    extension,
                    size_bytes: f.size,
                    modified_at: f.modified_nanos / 1_000_000_000,
                    path: f.path,
                }
            })
            .collect();
        let total_bytes: u64 = files.iter().map(|f| f.size_bytes).sum();

        // Final progress emit
        if let Some(first_root) = roots.first() {
            on_progress(
                first_root,
                progress.items_scanned.load(Ordering::Relaxed),
                total_bytes,
            );
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
            &items,
            platform,
            journal,
            lock_dir,
            true, // Always Trash
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
