use super::duplicates::DuplicateGroup;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateFolderEntry {
    pub path: PathBuf,
    pub file_count: usize,
    pub total_size_bytes: u64,
    pub selected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateFolderGroup {
    pub group_id: String,
    pub folder_hash: String,
    pub directories: Vec<DuplicateFolderEntry>,
    pub total_files: usize,
    pub folder_size_bytes: u64,
    pub potential_savings_bytes: u64,
}

pub struct FolderAggregator;

impl FolderAggregator {
    /// Aggregates duplicate files into higher-level duplicate folder groups.
    /// Two folders are identified as duplicates when they share identical files and matching file hashes.
    pub fn aggregate_folders(groups: &[DuplicateGroup]) -> Vec<DuplicateFolderGroup> {
        // Map: parent_dir -> Vec<(file_name, file_size, file_hash)>
        let mut dir_files: HashMap<PathBuf, Vec<(String, u64, String)>> = HashMap::new();

        for group in groups {
            for file in &group.files {
                if let Some(parent) = file.path.parent() {
                    let file_name = file
                        .path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or_default()
                        .to_string();

                    dir_files.entry(parent.to_path_buf()).or_default().push((
                        file_name,
                        file.size_bytes,
                        group.hash.clone(),
                    ));
                }
            }
        }

        // For each directory with duplicate files, compute composite signature
        // Map: folder_signature -> Vec<(dir_path, file_count, folder_size)>
        let mut signature_groups: HashMap<String, Vec<(PathBuf, usize, u64)>> = HashMap::new();

        for (dir, mut files) in dir_files {
            // Sort by file name for deterministic composite hashing
            files.sort_by(|a, b| a.0.cmp(&b.0));

            let mut hasher = blake3::Hasher::new();
            let mut total_size = 0u64;

            for (name, size, hash) in &files {
                hasher.update(name.as_bytes());
                hasher.update(&size.to_le_bytes());
                hasher.update(hash.as_bytes());
                total_size += size;
            }

            let folder_hash = hasher.finalize().to_hex().to_string();
            let file_count = files.len();

            signature_groups
                .entry(folder_hash)
                .or_default()
                .push((dir, file_count, total_size));
        }

        let mut folder_groups = Vec::new();

        for (folder_hash, dirs) in signature_groups {
            // Only consider directories if at least 2 distinct directories have identical signatures
            if dirs.len() < 2 {
                continue;
            }

            let file_count = dirs[0].1;
            let folder_size = dirs[0].2;
            let dir_count = dirs.len();

            let mut entries = Vec::new();
            for (idx, (path, count, size)) in dirs.into_iter().enumerate() {
                entries.push(DuplicateFolderEntry {
                    path,
                    file_count: count,
                    total_size_bytes: size,
                    // Keep the first directory by default; select duplicates for trashing
                    selected: idx > 0,
                });
            }

            let potential_savings = (dir_count as u64 - 1) * folder_size;

            folder_groups.push(DuplicateFolderGroup {
                group_id: Uuid::new_v4().to_string(),
                folder_hash,
                directories: entries,
                total_files: file_count,
                folder_size_bytes: folder_size,
                potential_savings_bytes: potential_savings,
            });
        }

        // Sort folder groups by potential savings descending
        folder_groups.sort_by_key(|g| std::cmp::Reverse(g.potential_savings_bytes));

        folder_groups
    }
}
