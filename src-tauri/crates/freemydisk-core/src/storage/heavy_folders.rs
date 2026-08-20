use crate::cleanup::protected_paths::ProtectedPathRegistry;
use crate::shared::errors::CoreError;
use crate::shared::progress::CancellationToken;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HeavyFolderNode {
    pub path: PathBuf,
    pub name: String,
    pub size_bytes: u64,
    pub file_count: u64,
    pub folder_count: u64,
    pub is_system_protected: bool,
    pub children: Vec<HeavyFolderNode>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HeavyFoldersScanResult {
    pub root: PathBuf,
    pub min_size_bytes: u64,
    pub total_scanned_bytes: u64,
    pub total_scanned_files: u64,
    pub heavy_folders: Vec<HeavyFolderNode>,
}

pub struct HeavyFoldersScanner;

struct DirStats {
    size_bytes: u64,
    file_count: u64,
    folder_count: u64,
    heavy_subfolders: Vec<HeavyFolderNode>,
}

impl HeavyFoldersScanner {
    pub fn scan_heavy_folders(
        root: &Path,
        min_size_bytes: u64,
        max_depth: usize,
        cancel: &CancellationToken,
    ) -> Result<HeavyFoldersScanResult, CoreError> {
        Self::scan_heavy_folders_with_progress(root, min_size_bytes, max_depth, cancel, |_, _, _| {})
    }

    pub fn scan_heavy_folders_with_progress<F>(
        root: &Path,
        min_size_bytes: u64,
        max_depth: usize,
        cancel: &CancellationToken,
        mut on_progress: F,
    ) -> Result<HeavyFoldersScanResult, CoreError>
    where
        F: FnMut(&Path, u64, u64),
    {
        let mut total_scanned_bytes = 0u64;
        let mut total_scanned_files = 0u64;
        let mut last_emit = std::time::Instant::now();

        let root_stats = Self::scan_dir_internal(
            root,
            0,
            max_depth,
            min_size_bytes,
            cancel,
            &mut total_scanned_bytes,
            &mut total_scanned_files,
            &mut last_emit,
            &mut on_progress,
        )?;

        let mut heavy_folders = root_stats.heavy_subfolders;
        heavy_folders.sort_by_key(|f| std::cmp::Reverse(f.size_bytes));

        on_progress(root, total_scanned_files, total_scanned_bytes);

        Ok(HeavyFoldersScanResult {
            root: root.to_path_buf(),
            min_size_bytes,
            total_scanned_bytes,
            total_scanned_files,
            heavy_folders,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn scan_dir_internal<F>(
        path: &Path,
        current_depth: usize,
        max_depth: usize,
        min_size_bytes: u64,
        cancel: &CancellationToken,
        total_bytes: &mut u64,
        total_files: &mut u64,
        last_emit: &mut std::time::Instant,
        on_progress: &mut F,
    ) -> Result<DirStats, CoreError>
    where
        F: FnMut(&Path, u64, u64),
    {
        if cancel.is_cancelled() {
            return Err(CoreError::Cancelled);
        }

        let mut dir_size = 0u64;
        let mut file_count = 0u64;
        let mut folder_count = 0u64;
        let mut heavy_children = Vec::new();

        let entries = match fs::read_dir(path) {
            Ok(e) => e,
            Err(_) => {
                return Ok(DirStats {
                    size_bytes: 0,
                    file_count: 0,
                    folder_count: 0,
                    heavy_subfolders: Vec::new(),
                });
            }
        };

        for entry in entries.flatten() {
            if cancel.is_cancelled() {
                return Err(CoreError::Cancelled);
            }

            let entry_path = entry.path();
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };

            *total_files += 1;
            if last_emit.elapsed().as_millis() >= 33 {
                on_progress(&entry_path, *total_files, *total_bytes);
                *last_emit = std::time::Instant::now();
            }

            if meta.is_dir() {
                folder_count += 1;
                let is_protected = ProtectedPathRegistry::is_protected(&entry_path);

                if current_depth < max_depth {
                    let child_stats = Self::scan_dir_internal(
                        &entry_path,
                        current_depth + 1,
                        max_depth,
                        min_size_bytes,
                        cancel,
                        total_bytes,
                        total_files,
                        last_emit,
                        on_progress,
                    )?;

                    dir_size += child_stats.size_bytes;
                    file_count += child_stats.file_count;
                    folder_count += child_stats.folder_count;

                    if child_stats.size_bytes >= min_size_bytes {
                        let name = entry_path
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_else(|| entry_path.to_string_lossy().to_string());

                        let mut sorted_children = child_stats.heavy_subfolders;
                        sorted_children.sort_by_key(|c| std::cmp::Reverse(c.size_bytes));

                        heavy_children.push(HeavyFolderNode {
                            path: entry_path,
                            name,
                            size_bytes: child_stats.size_bytes,
                            file_count: child_stats.file_count,
                            folder_count: child_stats.folder_count,
                            is_system_protected: is_protected,
                            children: sorted_children,
                        });
                    }
                }
            } else {
                let size = meta.len();
                dir_size += size;
                file_count += 1;
                *total_bytes += size;
            }
        }

        heavy_children.sort_by_key(|c| std::cmp::Reverse(c.size_bytes));

        Ok(DirStats {
            size_bytes: dir_size,
            file_count,
            folder_count,
            heavy_subfolders: heavy_children,
        })
    }
}
