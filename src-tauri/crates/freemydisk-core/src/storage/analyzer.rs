use crate::cleanup::protected_paths::ProtectedPathRegistry;
use crate::shared::errors::CoreError;
use crate::shared::progress::CancellationToken;
use freemydisk_platform::traits::PlatformFilesystem;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub type StorageVolume = freemydisk_platform::traits::StorageVolumeInfo;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageTreeNode {
    pub path: PathBuf,
    pub name: String,
    pub size_bytes: u64,
    pub file_count: u64,
    pub dir_count: u64,
    pub is_dir: bool,
    #[serde(default)]
    pub is_system_protected: bool,
    pub children: Vec<StorageTreeNode>,
}

pub struct StorageAnalyzer;

impl StorageAnalyzer {
    /// Enumerate all mounted storage volumes on the system via platform abstraction.
    pub fn list_volumes(platform: &dyn PlatformFilesystem) -> Vec<StorageVolume> {
        platform.list_volumes().unwrap_or_default()
    }

    /// Scans a directory hierarchically up to `max_depth` to build a storage tree.
    pub fn scan_directory(
        root: &Path,
        max_depth: usize,
        platform: &dyn PlatformFilesystem,
        cancel: &CancellationToken,
    ) -> Result<StorageTreeNode, CoreError> {
        let mut seen_identities = HashSet::new();
        Self::scan_recursive(root, 0, max_depth, platform, &mut seen_identities, cancel)
    }

    fn scan_recursive(
        path: &Path,
        current_depth: usize,
        max_depth: usize,
        platform: &dyn PlatformFilesystem,
        seen_identities: &mut HashSet<(u64, u64)>,
        cancel: &CancellationToken,
    ) -> Result<StorageTreeNode, CoreError> {
        if cancel.is_cancelled() {
            return Err(CoreError::Cancelled);
        }

        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string());

        let is_system_protected = ProtectedPathRegistry::is_protected(path);

        let meta = match std::fs::symlink_metadata(path) {
            Ok(m) => m,
            Err(_) => {
                return Ok(StorageTreeNode {
                    path: path.to_path_buf(),
                    name,
                    size_bytes: 0,
                    file_count: 0,
                    dir_count: 0,
                    is_dir: false,
                    is_system_protected,
                    children: Vec::new(),
                });
            }
        };

        if !meta.is_dir() {
            let size = meta.len();
            return Ok(StorageTreeNode {
                path: path.to_path_buf(),
                name,
                size_bytes: size,
                file_count: 1,
                dir_count: 0,
                is_dir: false,
                is_system_protected,
                children: Vec::new(),
            });
        }

        // Cycle check for directories using hardware identity
        if let Ok(id) = platform.get_file_identity(path) {
            if !seen_identities.insert((id.device_id, id.file_index)) {
                // Cycle detected, stop recursion
                return Ok(StorageTreeNode {
                    path: path.to_path_buf(),
                    name,
                    size_bytes: 0,
                    file_count: 0,
                    dir_count: 0,
                    is_dir: true,
                    is_system_protected,
                    children: Vec::new(),
                });
            }
        }

        let mut children = Vec::new();
        let mut total_size = 0u64;
        let mut file_count = 0u64;
        let mut dir_count = 0u64;

        if let Ok(entries) = std::fs::read_dir(path) {
            let entry_list: Vec<_> = entries.flatten().collect();

            if current_depth == 0 {
                use rayon::prelude::*;
                let results: Result<Vec<Option<StorageTreeNode>>, CoreError> = entry_list
                    .into_par_iter()
                    .map(|entry| {
                        if cancel.is_cancelled() {
                            return Err(CoreError::Cancelled);
                        }

                        let child_path = entry.path();
                        let is_child_protected = ProtectedPathRegistry::is_protected(&child_path);

                        let child_meta = match entry.metadata() {
                            Ok(m) => m,
                            Err(_) => return Ok(None),
                        };

                        if child_meta.is_dir() {
                            // Check if directory is a junction to prevent circular traversals
                            if ProtectedPathRegistry::is_directory_junction(&child_path) {
                                let name = child_path
                                    .file_name()
                                    .map(|s| s.to_string_lossy().to_string())
                                    .unwrap_or_default();
                                return Ok(Some(StorageTreeNode {
                                    path: child_path,
                                    name,
                                    size_bytes: 0,
                                    file_count: 0,
                                    dir_count: 0,
                                    is_dir: true,
                                    is_system_protected: is_child_protected,
                                    children: Vec::new(),
                                }));
                            }

                            let mut local_seen = seen_identities.clone();
                            let node = Self::scan_recursive(
                                &child_path,
                                1,
                                max_depth,
                                platform,
                                &mut local_seen,
                                cancel,
                            )?;
                            Ok(Some(node))
                        } else {
                            let size = child_meta.len();
                            let name = child_path
                                .file_name()
                                .map(|s| s.to_string_lossy().to_string())
                                .unwrap_or_default();
                            Ok(Some(StorageTreeNode {
                                path: child_path,
                                name,
                                size_bytes: size,
                                file_count: 1,
                                dir_count: 0,
                                is_dir: false,
                                is_system_protected: is_child_protected,
                                children: Vec::new(),
                            }))
                        }
                    })
                    .collect();

                let nodes = results?;
                for node in nodes.into_iter().flatten() {
                    total_size += node.size_bytes;
                    file_count += node.file_count;
                    dir_count += node.dir_count;
                    if node.is_dir {
                        dir_count += 1;
                    }
                    children.push(node);
                }
            } else {
                for entry in entry_list {
                    if cancel.is_cancelled() {
                        return Err(CoreError::Cancelled);
                    }

                    let child_path = entry.path();
                    let is_child_protected = ProtectedPathRegistry::is_protected(&child_path);

                    let child_meta = match entry.metadata() {
                        Ok(m) => m,
                        Err(_) => continue,
                    };

                    if child_meta.is_dir() {
                        dir_count += 1;
                        if ProtectedPathRegistry::is_directory_junction(&child_path) {
                            let name = child_path
                                .file_name()
                                .map(|s| s.to_string_lossy().to_string())
                                .unwrap_or_default();
                            children.push(StorageTreeNode {
                                path: child_path,
                                name,
                                size_bytes: 0,
                                file_count: 0,
                                dir_count: 0,
                                is_dir: true,
                                is_system_protected: is_child_protected,
                                children: Vec::new(),
                            });
                            continue;
                        }

                        if current_depth < max_depth {
                            if let Ok(child_node) = Self::scan_recursive(
                                &child_path,
                                current_depth + 1,
                                max_depth,
                                platform,
                                seen_identities,
                                cancel,
                            ) {
                                total_size += child_node.size_bytes;
                                file_count += child_node.file_count;
                                dir_count += child_node.dir_count;
                                children.push(child_node);
                            }
                        } else {
                            // At max depth, calculate size recursively and push node without deeper children
                            let (s, f, d) = calculate_shallow_dir(&child_path, platform, cancel);
                            total_size += s;
                            file_count += f;
                            dir_count += d;
                            children.push(StorageTreeNode {
                                path: child_path.clone(),
                                name: child_path
                                    .file_name()
                                    .map(|s| s.to_string_lossy().to_string())
                                    .unwrap_or_default(),
                                size_bytes: s,
                                file_count: f,
                                dir_count: d,
                                is_dir: true,
                                is_system_protected: is_child_protected,
                                children: Vec::new(),
                            });
                        }
                    } else {
                        file_count += 1;
                        let size = child_meta.len();
                        total_size += size;

                        if current_depth < max_depth {
                            children.push(StorageTreeNode {
                                path: child_path.clone(),
                                name: child_path
                                    .file_name()
                                    .map(|s| s.to_string_lossy().to_string())
                                    .unwrap_or_default(),
                                size_bytes: size,
                                file_count: 1,
                                dir_count: 0,
                                is_dir: false,
                                is_system_protected: is_child_protected,
                                children: Vec::new(),
                            });
                        }
                    }
                }
            }
        }

        // Sort children by size descending for immediate display & treemap rendering
        children.sort_by_key(|n| std::cmp::Reverse(n.size_bytes));

        // Group excess small children (over 150 items) to prevent high memory serialization while keeping 100% exact space accounting
        const MAX_CHILDREN_PER_NODE: usize = 150;
        if children.len() > MAX_CHILDREN_PER_NODE {
            let mut truncated = Vec::with_capacity(MAX_CHILDREN_PER_NODE + 1);
            let mut other_size = 0u64;
            let mut other_files = 0u64;
            let mut other_dirs = 0u64;

            for (i, child) in children.into_iter().enumerate() {
                if i < MAX_CHILDREN_PER_NODE {
                    truncated.push(child);
                } else {
                    other_size += child.size_bytes;
                    other_files += child.file_count;
                    other_dirs += child.dir_count;
                    if child.is_dir {
                        other_dirs += 1;
                    }
                }
            }

            if other_size > 0 || other_files > 0 || other_dirs > 0 {
                truncated.push(StorageTreeNode {
                    path: path.join("[Other items]"),
                    name: format!("[Other {} items]", other_files + other_dirs),
                    size_bytes: other_size,
                    file_count: other_files,
                    dir_count: other_dirs,
                    is_dir: false,
                    is_system_protected: false,
                    children: Vec::new(),
                });
            }
            children = truncated;
        }

        Ok(StorageTreeNode {
            path: path.to_path_buf(),
            name,
            size_bytes: total_size,
            file_count,
            dir_count,
            is_dir: true,
            is_system_protected,
            children,
        })
    }

    /// Export the scanned storage tree to a JSON string.
    pub fn export_to_json(tree: &StorageTreeNode) -> Result<String, CoreError> {
        serde_json::to_string_pretty(tree).map_err(CoreError::Json)
    }

    /// Export the scanned storage tree to a CSV string.
    pub fn export_to_csv(tree: &StorageTreeNode) -> Result<String, CoreError> {
        let mut rows = Vec::new();
        rows.push("Path,Name,Size (Bytes),File Count,Directory Count,Protected,Type".to_string());
        Self::collect_csv_rows(tree, &mut rows);
        Ok(rows.join("\r\n"))
    }

    fn collect_csv_rows(node: &StorageTreeNode, rows: &mut Vec<String>) {
        let escaped_path = format!("\"{}\"", node.path.to_string_lossy().replace('\"', "\"\""));
        let escaped_name = format!("\"{}\"", node.name.replace('\"', "\"\""));
        let item_type = if node.is_dir { "Directory" } else { "File" };
        let prot = if node.is_system_protected {
            "Yes"
        } else {
            "No"
        };

        rows.push(format!(
            "{},{},{},{},{},{},{}",
            escaped_path,
            escaped_name,
            node.size_bytes,
            node.file_count,
            node.dir_count,
            prot,
            item_type
        ));

        for child in &node.children {
            Self::collect_csv_rows(child, rows);
        }
    }
}

fn calculate_shallow_dir(
    dir: &Path,
    _platform: &dyn PlatformFilesystem,
    cancel: &CancellationToken,
) -> (u64, u64, u64) {
    let mut size = 0u64;
    let mut files = 0u64;
    let mut dirs = 0u64;

    let walk = walkdir::WalkDir::new(dir)
        .min_depth(1)
        .follow_links(false)
        .into_iter();

    for entry in walk.flatten() {
        if cancel.is_cancelled() {
            break;
        }
        if entry.file_type().is_dir() {
            dirs += 1;
        } else {
            files += 1;
            size += entry.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }

    (size, files, dirs)
}
