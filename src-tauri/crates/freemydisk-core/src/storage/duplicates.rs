pub use super::folder_agg::{DuplicateFolderEntry, DuplicateFolderGroup, FolderAggregator};
pub use super::hash_cache::{CachedHash, HashCache};
use crate::cleanup::disposal::{DisposalEngine, DisposalItemResult, DisposalSummary};
use crate::cleanup::plan::CleanupPlanItem;
use crate::cleanup::protected_paths::ProtectedPathRegistry;
use crate::filesystem::journal::CrashRecoveryJournal;
use crate::shared::errors::CoreError;
use crate::shared::progress::CancellationToken;
use crate::storage::discovery::{
    discover_files, run_with_ticks, DiscoveredFile, DiscoveryProgress, ScanExclusions,
};
use freemydisk_platform::traits::{FileIdentity, PlatformFilesystem};
use parking_lot::Mutex;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
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
        let _bg_guard = freemydisk_platform::io_priority::BackgroundExecutionGuard::enter();
        let start_time = Instant::now();

        // --- Phase 1: Gather and group by file size ---
        // All drives and folders are listed in parallel; system folders and OS files
        // are skipped, and cloud placeholders are dropped (reading them would
        // download them).
        let exclusions = ScanExclusions::new();
        let discovery = DiscoveryProgress::default();
        let size_groups: Mutex<HashMap<u64, Vec<DiscoveredFile>>> = Mutex::new(HashMap::new());
        let roots: Vec<PathBuf> = roots.iter().filter(|r| r.exists()).cloned().collect();
        let found = run_with_ticks(
            || {
                discover_files(
                    &roots,
                    min_size.max(1),
                    &exclusions,
                    cancel,
                    &discovery,
                    |f| {
                        if !f.is_cloud_placeholder {
                            size_groups.lock().entry(f.size).or_default().push(f);
                        }
                    },
                )
            },
            || {
                let items = discovery.items_scanned.load(Ordering::Relaxed);
                let pct = ((items % 29) + 1).min(29) as u8;
                let current = discovery.current_path.lock().clone();
                on_progress(
                    "Phase 1/4: Discovering candidate files...",
                    pct,
                    items,
                    &current,
                    0,
                );
            },
        );
        found?;
        let items_scanned = discovery.items_scanned.load(Ordering::Relaxed);

        // Only files that share their exact size with another file can be
        // duplicates; every other file is never opened.
        let size_collisions: Vec<DiscoveredFile> = size_groups
            .into_inner()
            .into_values()
            .filter(|files| files.len() > 1)
            .flatten()
            .collect();

        // Hashing reads file data, so it runs on a small dedicated pool: enough
        // parallel reads to keep SSDs and several drives busy without flooding a
        // single hard disk with random reads.
        let io_threads = freemydisk_platform::power::get_adaptive_concurrency_limit().clamp(1, 4);
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(io_threads)
            .thread_name(|i| format!("fmd-hash-{}", i))
            .build()
            .map_err(|e| CoreError::Io {
                path: PathBuf::new(),
                source: std::io::Error::other(e.to_string()),
            })?;

        let current = Mutex::new(PathBuf::new());
        let processed = AtomicUsize::new(0);
        let cache_hit_count = AtomicUsize::new(0);

        // --- Phase 2: sampled hash (head, middle and tail) ---
        let total_cands = size_collisions.len();
        let sampled: Vec<Candidate> = run_with_ticks(
            || {
                pool.install(|| {
                    size_collisions
                        .into_par_iter()
                        .filter_map(|f| {
                            if cancel.is_cancelled() {
                                return None;
                            }
                            processed.fetch_add(1, Ordering::Relaxed);
                            if let Some(mut c) = current.try_lock() {
                                c.clone_from(&f.path);
                            }
                            if platform.is_cloud_placeholder(&f.path).unwrap_or(false) {
                                return None;
                            }
                            let cache_stamp = f.modified_nanos;
                            let cached = cache
                                .and_then(|c| c.lookup(&f.path, f.size, cache_stamp))
                                .filter(|c| c.sample_hash.starts_with(SAMPLE_HASH_PREFIX));
                            let (sample_hash, cached_full_hash) = match cached {
                                Some(hit) => {
                                    cache_hit_count.fetch_add(1, Ordering::Relaxed);
                                    (hit.sample_hash, Some(hit.full_hash))
                                }
                                None => (compute_partial_hash(&f.path, f.size).ok()?, None),
                            };
                            Some(Candidate {
                                modified_at: f.modified_nanos / 1_000_000_000,
                                size: f.size,
                                path: f.path,
                                cache_stamp,
                                sample_hash,
                                cached_full_hash,
                            })
                        })
                        .collect()
                })
            },
            || {
                let done = processed.load(Ordering::Relaxed);
                let pct = 30 + ((done * 30) / total_cands.max(1)).min(30) as u8;
                let path = current.lock().clone();
                on_progress(
                    "Phase 2/4: Computing fast sample hashes...",
                    pct,
                    items_scanned,
                    &path,
                    0,
                );
            },
        );
        if cancel.is_cancelled() {
            return Err(CoreError::Cancelled);
        }

        // --- Phase 3: full streaming BLAKE3 hash, only for sample collisions ---
        let to_hash: Vec<Candidate> = group_by_key(sampled, |c| (c.size, c.sample_hash.clone()))
            .into_iter()
            .flatten()
            .collect();
        let total_partial_cands = to_hash.len();
        processed.store(0, Ordering::Relaxed);
        let hashed: Vec<(Candidate, String)> = run_with_ticks(
            || {
                pool.install(|| {
                    to_hash
                        .into_par_iter()
                        .filter_map(|cand| {
                            if cancel.is_cancelled() {
                                return None;
                            }
                            processed.fetch_add(1, Ordering::Relaxed);
                            if let Some(mut c) = current.try_lock() {
                                c.clone_from(&cand.path);
                            }
                            let full_hash = match cand.cached_full_hash.clone() {
                                Some(fh) => fh,
                                None => {
                                    let fh = compute_full_hash(&cand.path).ok()?;
                                    if let Some(c) = cache {
                                        c.store(
                                            &cand.path,
                                            cand.size,
                                            cand.cache_stamp,
                                            &cand.sample_hash,
                                            &fh,
                                        );
                                    }
                                    fh
                                }
                            };
                            Some((cand, full_hash))
                        })
                        .collect()
                })
            },
            || {
                let done = processed.load(Ordering::Relaxed);
                let pct = 60 + ((done * 30) / total_partial_cands.max(1)).min(30) as u8;
                let path = current.lock().clone();
                on_progress(
                    "Phase 3/4: Computing streaming BLAKE3 hashes...",
                    pct,
                    items_scanned,
                    &path,
                    0,
                );
            },
        );
        if cancel.is_cancelled() {
            return Err(CoreError::Cancelled);
        }
        let cache_hits = cache_hit_count.load(Ordering::Relaxed);

        // File identity (for hard links and clones) is only needed for confirmed
        // duplicates, so it is read for those files alone.
        let unknown_identities = AtomicU64::new(0);
        let full_hash_groups: Vec<HashGroup> = pool.install(|| {
            group_by_key(hashed, |(c, h)| (c.size, h.clone()))
                .into_par_iter()
                .map(|members| {
                    let size = members[0].0.size;
                    let hash = members[0].1.clone();
                    let mut with_identity: Vec<(Candidate, FileIdentity)> = members
                        .into_iter()
                        .map(|(cand, _)| {
                            // An unknown identity must never make two different
                            // files look like one physical file, so each gets a
                            // key no real file can share.
                            let identity =
                                platform.get_file_identity(&cand.path).unwrap_or_else(|_| {
                                    FileIdentity {
                                        device_id: u64::MAX,
                                        file_index: unknown_identities
                                            .fetch_add(1, Ordering::Relaxed)
                                            + 1,
                                        link_count: 1,
                                        is_reparse_or_symlink: false,
                                    }
                                });
                            (cand, identity)
                        })
                        .collect();
                    // A stable order: the first file is the copy kept by default.
                    with_identity.sort_by(|a, b| a.0.path.cmp(&b.0.path));
                    (size, hash, with_identity)
                })
                .collect()
        });

        // Build final DuplicateGroup list
        let mut groups = Vec::new();
        let mut total_duplicate_files = 0usize;
        let mut total_potential_savings = 0u64;

        for (size, hash, candidates) in full_hash_groups {
            // Check hardlinks / clone identity
            let mut identity_count_map: HashMap<(u64, u64), usize> = HashMap::new();
            for (_, identity) in &candidates {
                *identity_count_map
                    .entry((identity.device_id, identity.file_index))
                    .or_default() += 1;
            }
            let unique_identity_count = identity_count_map.len();

            let potential_savings_bytes = if unique_identity_count > 1 {
                (unique_identity_count as u64 - 1) * size
            } else {
                0
            };

            let mut files = Vec::new();
            for (idx, (cand, identity)) in candidates.into_iter().enumerate() {
                let key = (identity.device_id, identity.file_index);
                let is_hardlink_or_clone = identity.link_count > 1
                    || identity_count_map.get(&key).copied().unwrap_or(0) > 1;

                files.push(DuplicateFileEntry {
                    path: cand.path,
                    size_bytes: cand.size,
                    modified_at: cand.modified_at,
                    device_id: identity.device_id,
                    file_index: identity.file_index,
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
        freemydisk_platform::memory::trim_working_set();

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

    /// Moves the selected copies of each group to the Recycle Bin.
    ///
    /// The groups come from the UI, so they are re-checked here: every group must
    /// keep at least one existing copy, and each selected file is re-hashed and must
    /// still match the kept copy. Files that fail either check are not touched.
    pub fn batch_trash_duplicates(
        groups: &[DuplicateGroup],
        platform: &dyn PlatformFilesystem,
        journal: &CrashRecoveryJournal,
        lock_dir: &Path,
        cancel: &CancellationToken,
    ) -> Result<DisposalSummary, CoreError> {
        let mut items = Vec::new();
        let mut rejected = Vec::new();

        for group in groups {
            let selected: Vec<&DuplicateFileEntry> =
                group.files.iter().filter(|f| f.selected).collect();
            if selected.is_empty() {
                continue;
            }

            let keeper = group.files.iter().find(|f| !f.selected && f.path.is_file());
            let keeper_hash = keeper.and_then(|k| compute_full_hash(&k.path).ok());
            let Some(keeper_hash) = keeper_hash else {
                for file in &selected {
                    rejected.push(reject(&file.path, "At least one copy must be kept"));
                }
                continue;
            };

            for file in selected {
                if cancel.is_cancelled() {
                    break;
                }
                match compute_full_hash(&file.path) {
                    Ok(hash) if hash == keeper_hash => {
                        let size = file
                            .path
                            .metadata()
                            .map(|m| m.len())
                            .unwrap_or(file.size_bytes);
                        items.push(CleanupPlanItem {
                            original_path: file.path.clone(),
                            canonical_path: dunce::canonicalize(&file.path)
                                .unwrap_or_else(|_| dunce::simplified(&file.path).to_path_buf()),
                            size_bytes: size,
                            is_dir: false,
                            matched_rules: vec!["duplicate_finder".to_string()],
                            default_action: "trash".to_string(),
                            verified_rebuildable: false,
                            protect_subpaths: Vec::new(),
                            risk: "safe".to_string(),
                        });
                    }
                    Ok(_) => rejected.push(reject(&file.path, "File changed since the scan")),
                    Err(_) => rejected.push(reject(&file.path, "File could not be read")),
                }
            }
        }

        let mut summary = DisposalEngine::execute_plan(
            &items, platform, journal, lock_dir,
            true, // Always Trash override for duplicate cleanup
            cancel,
        )?;
        summary.total_requested_items += rejected.len();
        summary.failed_items += rejected.len();
        summary.results.extend(rejected);
        Ok(summary)
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

/// Size, full hash and the files (with their identity) of one duplicate group.
type HashGroup = (u64, String, Vec<(Candidate, FileIdentity)>);

/// A file that shares its size with at least one other file.
struct Candidate {
    path: PathBuf,
    size: u64,
    modified_at: u64,
    /// Modification time in nanoseconds; part of the hash-cache key.
    cache_stamp: u64,
    sample_hash: String,
    cached_full_hash: Option<String>,
}

/// Splits `items` into groups that share a key and keeps only the groups with at
/// least two members: a value seen once cannot have a duplicate.
fn group_by_key<T, K, F>(items: Vec<T>, key: F) -> Vec<Vec<T>>
where
    K: std::hash::Hash + Eq,
    F: Fn(&T) -> K,
{
    let mut map: HashMap<K, Vec<T>> = HashMap::new();
    for item in items {
        map.entry(key(&item)).or_default().push(item);
    }
    map.into_values().filter(|g| g.len() >= 2).collect()
}

fn reject(path: &Path, reason: &str) -> DisposalItemResult {
    DisposalItemResult {
        path: path.to_path_buf(),
        success: false,
        bytes_freed: 0,
        route_used: "rejected".to_string(),
        error: Some(reason.to_string()),
    }
}

/// Marks sample hashes made by [`compute_partial_hash`]. Cached samples from the
/// older head-and-tail scheme lack it and are recomputed, so samples from both
/// schemes are never compared with each other.
const SAMPLE_HASH_PREFIX: &str = "s3:";

/// Bytes read at each sample point.
const SAMPLE_CHUNK: u64 = 16 * 1024;

/// Hashes three samples of the file (start, middle and end) together with its
/// size. Files up to four samples long are hashed whole. Two files with different
/// samples cannot be equal, so only files whose samples collide are read in full.
fn compute_partial_hash(path: &Path, size: u64) -> Result<String, std::io::Error> {
    let mut file = File::open(crate::shared::paths::to_extended_path(path))?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(&size.to_le_bytes());

    if size <= SAMPLE_CHUNK * 4 {
        let mut buf = Vec::with_capacity(size as usize);
        file.read_to_end(&mut buf)?;
        hasher.update(&buf);
    } else {
        let mut chunk = vec![0u8; SAMPLE_CHUNK as usize];
        for offset in [0, size / 2 - SAMPLE_CHUNK / 2, size - SAMPLE_CHUNK] {
            file.seek(SeekFrom::Start(offset))?;
            file.read_exact(&mut chunk)?;
            hasher.update(&chunk);
        }
    }

    Ok(format!(
        "{}{}",
        SAMPLE_HASH_PREFIX,
        hasher.finalize().to_hex()
    ))
}

/// Streams the file through BLAKE3 with buffered reads. Memory-mapping is avoided:
/// if another process truncates a mapped file, Windows raises an in-page error
/// that would crash the app.
fn compute_full_hash(path: &Path) -> Result<String, std::io::Error> {
    let file = File::open(crate::shared::paths::to_extended_path(path))?;
    let mut hasher = blake3::Hasher::new();
    hasher.update_reader(std::io::BufReader::with_capacity(1 << 20, file))?;
    Ok(hasher.finalize().to_hex().to_string())
}
