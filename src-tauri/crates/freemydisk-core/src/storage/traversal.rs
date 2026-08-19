use crate::shared::errors::CoreError;
use crate::shared::progress::{CancellationToken, TraversalProgress};
use freemydisk_platform::traits::{FileIdentity, PlatformFilesystem};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScannedEntry {
    pub path: PathBuf,
    pub is_dir: bool,
    pub size_bytes: u64,
    pub identity: Option<FileIdentity>,
    pub is_cloud_placeholder: bool,
}

pub struct DirectoryTraversal {
    platform: Arc<dyn PlatformFilesystem>,
    cancellation: CancellationToken,
}

impl DirectoryTraversal {
    pub fn new(platform: Arc<dyn PlatformFilesystem>, cancellation: CancellationToken) -> Self {
        Self {
            platform,
            cancellation,
        }
    }

    /// Performs an adaptive, cycle-safe, placeholder-aware iterative directory traversal.
    pub fn scan<F>(&self, root: &Path, mut progress_cb: F) -> Result<Vec<ScannedEntry>, CoreError>
    where
        F: FnMut(&TraversalProgress),
    {
        if !root.exists() {
            return Err(CoreError::Io {
                path: root.to_path_buf(),
                source: std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "Root path does not exist",
                ),
            });
        }

        let start_time = Instant::now();
        let mut results = Vec::new();
        let mut visited_identities: HashSet<(u64, u64)> = HashSet::new();

        let mut queue: Vec<PathBuf> = vec![root.to_path_buf()];
        let mut progress = TraversalProgress::default();

        let mut last_progress_emit = Instant::now();

        while let Some(current_dir) = queue.pop() {
            if self.cancellation.is_cancelled() {
                return Err(CoreError::Cancelled);
            }

            // Check directory identity for circular symlink loops
            if let Ok(id) = self.platform.get_file_identity(&current_dir) {
                if !visited_identities.insert((id.device_id, id.file_index)) {
                    // Loop/cycle detected! Skip traversing into it again.
                    continue;
                }
            }

            progress.directories_scanned += 1;
            progress.current_path = current_dir
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| current_dir.to_string_lossy().to_string());

            let entries_res = std::fs::read_dir(&current_dir);
            let entries = match entries_res {
                Ok(rd) => rd,
                Err(e) => {
                    progress.errors_encountered += 1;
                    log::warn!(
                        "Access denied / error reading '{}': {}",
                        current_dir.display(),
                        e
                    );
                    continue;
                }
            };

            for entry_res in entries {
                if self.cancellation.is_cancelled() {
                    return Err(CoreError::Cancelled);
                }

                let entry = match entry_res {
                    Ok(e) => e,
                    Err(e) => {
                        progress.errors_encountered += 1;
                        log::warn!("Error on entry in '{}': {}", current_dir.display(), e);
                        continue;
                    }
                };

                let path = entry.path();
                let file_type = match entry.file_type() {
                    Ok(ft) => ft,
                    Err(e) => {
                        progress.errors_encountered += 1;
                        log::warn!("Error reading file type for '{}': {}", path.display(), e);
                        continue;
                    }
                };

                let is_symlink = file_type.is_symlink();
                let is_dir = file_type.is_dir();

                // Check cloud placeholder status (OneDrive / iCloud)
                let is_placeholder = self.platform.is_cloud_placeholder(&path).unwrap_or(false);

                if is_placeholder {
                    progress.placeholders_skipped += 1;
                }

                let size = if is_dir {
                    0
                } else if is_placeholder {
                    // Report metadata logical size only without triggering content download
                    entry.metadata().map(|m| m.len()).unwrap_or(0)
                } else {
                    entry.metadata().map(|m| m.len()).unwrap_or(0)
                };

                let identity = if !is_symlink {
                    self.platform.get_file_identity(&path).ok()
                } else {
                    None
                };

                progress.files_found += 1;
                progress.total_bytes += size;

                results.push(ScannedEntry {
                    path: path.clone(),
                    is_dir,
                    size_bytes: size,
                    identity,
                    is_cloud_placeholder: is_placeholder,
                });

                // Do not traverse into symlinked directories or reparse junctions to prevent escaping scope
                if is_dir && !is_symlink {
                    queue.push(path);
                }
            }

            // Debounce progress emission to UI at max ~30Hz (33ms)
            if last_progress_emit.elapsed().as_millis() >= 33 {
                progress.elapsed_ms = start_time.elapsed().as_millis() as u64;
                progress_cb(&progress);
                last_progress_emit = Instant::now();
            }
        }

        progress.elapsed_ms = start_time.elapsed().as_millis() as u64;
        progress_cb(&progress);

        Ok(results)
    }
}
