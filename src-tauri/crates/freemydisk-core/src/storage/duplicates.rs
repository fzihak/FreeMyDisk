pub use super::folder_agg::{DuplicateFolderEntry, DuplicateFolderGroup, FolderAggregator};
pub use super::hash_cache::{CachedHash, HashCache};
use crate::cleanup::disposal::{DisposalEngine, DisposalSummary};
use crate::cleanup::plan::CleanupPlanItem;
use crate::cleanup::protected_paths::ProtectedPathRegistry;
use crate::filesystem::journal::CrashRecoveryJournal;
use crate::shared::errors::CoreError;
use crate::shared::progress::CancellationToken;
use freemydisk_platform::traits::{FileIdentity, PlatformFilesystem};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Instant;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateFileEntry {
    pub path: PathBuf,
    pub size_bytes: u64,
    pub modified_at: u64,
    pub device_id: u64,
    pub file_index: u64,
    pub is_hardlink_or_clone: bool,
    pub selected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateGroup {
    pub group_id: String,
    pub hash: String,
    pub file_size: u64,
    pub files: Vec<DuplicateFileEntry>,
    pub potential_savings_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateScanResult {
    pub total_groups: usize,
    pub total_folder_groups: usize,
    pub total_duplicate_files: usize,
    pub total_potential_savings: u64,
    pub groups: Vec<DuplicateGroup>,
    #[serde(default)]
    pub folder_groups: Vec<DuplicateFolderGroup>,
    #[serde(default)]
    pub cache_hits: usize,
    #[serde(default)]
    pub scan_duration_ms: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum SelectionHeuristic {
    KeepOldest,
    KeepNewest,
    KeepShortestPath,
    KeepLongestPath,
    UnselectAll,
}

pub struct DuplicateDetector;

impl DuplicateDetector {
    /// 4-phase deduplication engine:
    /// Phase 1: Size grouping
    /// Phase 2: Hardlink & clone identity check
    /// Phase 3: Partial hash (prefix + suffix sample)
    /// Phase 4: Full streaming BLAKE3 hash
    ///
    /// SAFETY INVARIANT: Files sharing physical disk blocks (same device_id and file_index)
    /// contribute 0 bytes to potential savings.
    pub fn scan_duplicates(
        roots: &[PathBuf],
        min_size: u64,
        platform: &dyn PlatformFilesystem,
        cancel: &CancellationToken,
    ) -> Result<DuplicateScanResult, CoreError> {
        Self::scan_duplicates_with_cache(roots, min_size, platform, None, cancel)
    }

    /// 4-phase deduplication engine with persistent hash caching and folder aggregation:
    /// Phase 1: Size grouping
    /// Phase 2: Hardlink & clone identity check
    /// Phase 3: Partial hash (prefix + suffix sample) with cache lookup
    /// Phase 4: Full streaming BLAKE3 hash with cache lookup
    /// Phase 5: Folder-level aggregation
    pub fn scan_duplicates_with_cache(
        roots: &[PathBuf],
        min_size: u64,
        platform: &dyn PlatformFilesystem,
        cache: Option<&HashCache>,
        cancel: &CancellationToken,
    ) -> Result<DuplicateScanResult, CoreError> {
        Self::scan_duplicates_with_progress(
            roots,
            min_size,
            platform,
            cache,
            cancel,
            |_, _, _, _, _| {},
        )
    }

    pub fn scan_duplicates_with_progress<F>(
        roots: &[PathBuf],
        min_size: u64,
        platform: &dyn PlatformFilesystem,
        cache: Option<&HashCache>,
        cancel: &CancellationToken,
        mut on_progress: F,
    ) -> Result<DuplicateScanResult, CoreError>
    where
        F: FnMut(&str, u8, u64, &Path, u64),
    {
        let _bg_guard =
            freemydisk_platform::windows::io_priority::BackgroundExecutionGuard::enter();
        let start_time = Instant::now();
        let mut cache_hits = 0usize;
        let mut items_scanned = 0u64;
        let mut last_emit = Instant::now();

        // --- Phase 1: Gather and group by file size ---
        let mut size_groups: HashMap<u64, Vec<PathBuf>> = HashMap::new();

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
                    |entry_path: &Path, _name: &str, size: u64, is_dir: bool| -> bool {
                        items_scanned += 1;
                        if last_emit.elapsed().as_millis() >= 33 {
                            let pct = ((items_scanned % 29) + 1).min(29) as u8;
                            on_progress(
                                "Phase 1/4: Discovering candidate files...",
                                pct,
                                items_scanned,
                                entry_path,
                                0,
                            );
                            last_emit = Instant::now();
                        }

                        if ProtectedPathRegistry::is_protected(entry_path) {
                            return false;
                        }
                        if !is_dir && size >= min_size && size > 0 {
                            size_groups
                                .entry(size)
                                .or_default()
                                .push(entry_path.to_path_buf());
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
                        let pct = ((items_scanned % 29) + 1).min(29) as u8;
                        on_progress(
                            "Phase 1/4: Discovering candidate files...",
                            pct,
                            items_scanned,
                            path,
                            0,
                        );
                        last_emit = Instant::now();
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
                        if len >= min_size && len > 0 {
                            size_groups.entry(len).or_default().push(path.to_path_buf());
                        }
                    }
                }
            }
        }

        // Filter out unique sizes
        let candidate_sizes: Vec<(u64, Vec<PathBuf>)> = size_groups
            .into_iter()
            .filter(|(_, files)| files.len() > 1)
            .collect();

        // --- Phase 2: Identity check & Phase 3: Partial Hash ---
        struct CandidateWithIdentity {
            path: PathBuf,
            size: u64,
            modified_at: u64,
            identity: FileIdentity,
            sample_hash: String,
            cached_full_hash: Option<String>,
        }

        let total_cands: usize = candidate_sizes.iter().map(|(_, files)| files.len()).sum();
        let mut processed_cands = 0usize;
        let mut partial_hash_groups: HashMap<(u64, String), Vec<CandidateWithIdentity>> =
            HashMap::new();

        for (size, files) in candidate_sizes {
            if cancel.is_cancelled() {
                return Err(CoreError::Cancelled);
            }

            for path in files {
                processed_cands += 1;
                if last_emit.elapsed().as_millis() >= 33 {
                    let pct = 30 + ((processed_cands * 30) / total_cands.max(1)).min(30) as u8;
                    on_progress(
                        "Phase 2/4: Computing fast sample hashes...",
                        pct,
                        items_scanned,
                        &path,
                        0,
                    );
                    last_emit = Instant::now();
                }

                if platform.is_cloud_placeholder(&path).unwrap_or(false) {
                    continue;
                }

                let identity = platform.get_file_identity(&path).unwrap_or(FileIdentity {
                    device_id: 0,
                    file_index: 0,
                    link_count: 1,
                    is_reparse_or_symlink: false,
                });

                let modified_at = std::fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);

                let cached_entry = cache.and_then(|c| c.lookup(&path, size, modified_at));
                let (partial_hash, cached_full_hash) = if let Some(cached) = cached_entry {
                    cache_hits += 1;
                    (cached.sample_hash, Some(cached.full_hash))
                } else {
                    let h = match compute_partial_hash(&path, size) {
                        Ok(hash) => hash,
                        Err(_) => continue,
                    };
                    (h, None)
                };

                partial_hash_groups
                    .entry((size, partial_hash.clone()))
                    .or_default()
                    .push(CandidateWithIdentity {
                        path,
                        size,
                        modified_at,
                        identity,
                        sample_hash: partial_hash,
                        cached_full_hash,
                    });
            }
        }

        // --- Phase 4: Full Streaming BLAKE3 Hash ---
        let total_partial_cands: usize = partial_hash_groups
            .values()
            .filter(|c| c.len() >= 2)
            .map(|c| c.len())
            .sum();
        let mut processed_partial = 0usize;
        let mut full_hash_groups: HashMap<(u64, String), Vec<CandidateWithIdentity>> =
            HashMap::new();

        for ((size, _), candidates) in partial_hash_groups {
            if cancel.is_cancelled() {
                return Err(CoreError::Cancelled);
            }

            if candidates.len() < 2 {
                continue;
            }

            for cand in candidates {
                processed_partial += 1;
                if last_emit.elapsed().as_millis() >= 33 {
                    let pct = 60 + ((processed_partial * 30) / total_partial_cands.max(1)).min(30) as u8;
                    on_progress(
                        "Phase 3/4: Computing streaming BLAKE3 hashes...",
                        pct,
                        items_scanned,
                        &cand.path,
                        0,
                    );
                    last_emit = Instant::now();
                }

                let full_hash = if let Some(ref fh) = cand.cached_full_hash {
                    fh.clone()
                } else {
                    match compute_full_hash(&cand.path) {
                        Ok(fh) => {
                            if let Some(c) = cache {
                                c.store(
                                    &cand.path,
                                    cand.size,
                                    cand.modified_at,
                                    &cand.sample_hash,
                                    &fh,
                                );
                            }
                            fh
                        }
                        Err(_) => continue,
                    }
                };

                full_hash_groups
                    .entry((size, full_hash))
                    .or_default()
                    .push(cand);
            }
        }

        // Build final DuplicateGroup list
        let mut groups = Vec::new();
        let mut total_duplicate_files = 0usize;
        let mut total_potential_savings = 0u64;

        for ((size, hash), candidates) in full_hash_groups {
            if candidates.len() < 2 {
                continue;
            }

            // Check hardlinks / clone identity
            let mut seen_identities: HashSet<(u64, u64)> = HashSet::new();
            let mut unique_identity_count = 0usize;

            for cand in &candidates {
                let key = (cand.identity.device_id, cand.identity.file_index);
                if seen_identities.insert(key) {
                    unique_identity_count += 1;
                }
            }

            let potential_savings_bytes = if unique_identity_count > 1 {
                (unique_identity_count as u64 - 1) * size
            } else {
                0
            };

            let mut files = Vec::new();
            let mut identity_count_map: HashMap<(u64, u64), usize> = HashMap::new();
            for c in &candidates {
                *identity_count_map
                    .entry((c.identity.device_id, c.identity.file_index))
                    .or_default() += 1;
            }

            for (idx, cand) in candidates.into_iter().enumerate() {
                let key = (cand.identity.device_id, cand.identity.file_index);
                let is_hardlink_or_clone = cand.identity.link_count > 1
                    || identity_count_map.get(&key).copied().unwrap_or(0) > 1;

                files.push(DuplicateFileEntry {
                    path: cand.path,
                    size_bytes: cand.size,
                    modified_at: cand.modified_at,
                    device_id: cand.identity.device_id,
                    file_index: cand.identity.file_index,
                    is_hardlink_or_clone,
                    // By default, select all duplicates except the first one
                    selected: idx > 0,
                });
            }

            total_duplicate_files += files.len();
            total_potential_savings += potential_savings_bytes;

            groups.push(DuplicateGroup {
                group_id: Uuid::new_v4().to_string(),
                hash,
                file_size: size,
                files,
                potential_savings_bytes,
            });
        }

        // Sort groups by potential savings descending
        groups.sort_by_key(|g| std::cmp::Reverse(g.potential_savings_bytes));

        let total_groups = groups.len();

        // --- Phase 5: Folder Aggregation ---
        on_progress(
            "Phase 4/4: Aggregating folder clusters...",
            95,
            items_scanned,
            Path::new(""),
            total_potential_savings,
        );

        let folder_groups = FolderAggregator::aggregate_folders(&groups);
        let total_folder_groups = folder_groups.len();
        let scan_duration_ms = start_time.elapsed().as_millis() as u64;

        on_progress(
            "Duplicate scan complete",
            100,
            items_scanned,
            Path::new(""),
            total_potential_savings,
        );

        #[cfg(target_os = "windows")]
        freemydisk_platform::windows::memory::trim_working_set();

        Ok(DuplicateScanResult {
            total_groups,
            total_folder_groups,
            total_duplicate_files,
            total_potential_savings,
            groups,
            folder_groups,
            cache_hits,
            scan_duration_ms,
        })
    }

    /// Applies auto-selection heuristics across duplicate groups.
    pub fn apply_selection_heuristic(groups: &mut [DuplicateGroup], heuristic: SelectionHeuristic) {
        for group in groups.iter_mut() {
            if group.files.is_empty() {
                continue;
            }

            match heuristic {
                SelectionHeuristic::UnselectAll => {
                    for f in &mut group.files {
                        f.selected = false;
                    }
                }
                SelectionHeuristic::KeepOldest => {
                    let mut min_idx = 0;
                    for (i, f) in group.files.iter().enumerate() {
                        if f.modified_at < group.files[min_idx].modified_at {
                            min_idx = i;
                        }
                    }
                    for (i, f) in group.files.iter_mut().enumerate() {
                        f.selected = i != min_idx;
                    }
                }
                SelectionHeuristic::KeepNewest => {
                    let mut max_idx = 0;
                    for (i, f) in group.files.iter().enumerate() {
                        if f.modified_at > group.files[max_idx].modified_at {
                            max_idx = i;
                        }
                    }
                    for (i, f) in group.files.iter_mut().enumerate() {
                        f.selected = i != max_idx;
                    }
                }
                SelectionHeuristic::KeepShortestPath => {
                    let mut shortest_idx = 0;
                    for (i, f) in group.files.iter().enumerate() {
                        if f.path.as_os_str().len()
                            < group.files[shortest_idx].path.as_os_str().len()
                        {
                            shortest_idx = i;
                        }
                    }
                    for (i, f) in group.files.iter_mut().enumerate() {
                        f.selected = i != shortest_idx;
                    }
                }
                SelectionHeuristic::KeepLongestPath => {
                    let mut longest_idx = 0;
                    for (i, f) in group.files.iter().enumerate() {
                        if f.path.as_os_str().len()
                            > group.files[longest_idx].path.as_os_str().len()
                        {
                            longest_idx = i;
                        }
                    }
                    for (i, f) in group.files.iter_mut().enumerate() {
                        f.selected = i != longest_idx;
                    }
                }
            }
        }
    }

    /// Safely moves all selected duplicates to the OS Trash.
    /// Uses the standard DisposalEngine with default Trash action and zero permanent delete fallback.
    pub fn batch_trash_duplicates(
        groups: &[DuplicateGroup],
        platform: &dyn PlatformFilesystem,
        journal: &CrashRecoveryJournal,
        lock_dir: &Path,
        cancel: &CancellationToken,
    ) -> Result<DisposalSummary, CoreError> {
        let mut items = Vec::new();

        for group in groups {
            for file in &group.files {
                if file.selected {
                    let canon = dunce::canonicalize(&file.path)
                        .unwrap_or_else(|_| dunce::simplified(&file.path).to_path_buf());

                    items.push(CleanupPlanItem {
                        original_path: file.path.clone(),
                        canonical_path: canon,
                        size_bytes: file.size_bytes,
                        is_dir: false,
                        matched_rules: vec!["duplicate_finder".to_string()],
                        default_action: "trash".to_string(),
                        verified_rebuildable: false,
                        protect_subpaths: Vec::new(),
                        risk: "safe".to_string(),
                    });
                }
            }
        }

        DisposalEngine::execute_plan(
            &items, platform, journal, lock_dir,
            true, // Always Trash override for duplicate cleanup
            cancel,
        )
    }

    /// Safely moves all selected duplicate directories to the OS Trash.
    pub fn batch_trash_duplicate_folders(
        folder_paths: &[PathBuf],
        platform: &dyn PlatformFilesystem,
        journal: &CrashRecoveryJournal,
        lock_dir: &Path,
        cancel: &CancellationToken,
    ) -> Result<DisposalSummary, CoreError> {
        let mut items = Vec::new();

        for dir in folder_paths {
            if !dir.exists() || ProtectedPathRegistry::is_protected(dir) {
                continue;
            }

            let canon =
                dunce::canonicalize(dir).unwrap_or_else(|_| dunce::simplified(dir).to_path_buf());

            items.push(CleanupPlanItem {
                original_path: dir.clone(),
                canonical_path: canon,
                size_bytes: 0,
                is_dir: true,
                matched_rules: vec!["duplicate_folder_finder".to_string()],
                default_action: "trash".to_string(),
                verified_rebuildable: false,
                protect_subpaths: Vec::new(),
                risk: "safe".to_string(),
            });
        }

        DisposalEngine::execute_plan(
            &items, platform, journal, lock_dir, true, // Always OS Recycle Bin
            cancel,
        )
    }
}

fn compute_partial_hash(path: &Path, size: u64) -> Result<String, std::io::Error> {
    let mut file = File::open(path)?;
    let mut hasher = blake3::Hasher::new();

    if size <= 16384 {
        // File is 16KB or smaller: hash all bytes
        let mut buf = Vec::with_capacity(size as usize);
        file.read_to_end(&mut buf)?;
        hasher.update(&buf);
    } else {
        // Hash first 4KB + last 4KB sample
        let mut head = [0u8; 4096];
        file.read_exact(&mut head)?;
        hasher.update(&head);

        file.seek(SeekFrom::End(-4096))?;
        let mut tail = [0u8; 4096];
        file.read_exact(&mut tail)?;
        hasher.update(&tail);
    }

    Ok(hasher.finalize().to_hex().to_string())
}

fn compute_full_hash(path: &Path) -> Result<String, std::io::Error> {
    let file = File::open(path)?;
    let metadata = file.metadata()?;
    let len = metadata.len();

    let mut hasher = blake3::Hasher::new();

    // Memory-mapped fast path for files between 64KB and 1GB:
    // Hashes directly from OS page cache with zero kernel-to-user buffer copying
    if (65536..=1_073_741_824).contains(&len) {
        if let Ok(mmap) = unsafe { memmap2::Mmap::map(&file) } {
            hasher.update(&mmap[..]);
            return Ok(hasher.finalize().to_hex().to_string());
        }
    }

    // High-throughput streaming fallback with 256KB buffer
    let mut file = file;
    let mut buffer = [0u8; 262144];

    loop {
        let bytes_read = file.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }

    Ok(hasher.finalize().to_hex().to_string())
}
