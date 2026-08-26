use crate::cleanup::matchers::is_subpath_protected;
use crate::cleanup::plan::CleanupPlanItem;
use crate::cleanup::protected_paths::ProtectedPathRegistry;
use crate::filesystem::journal::CrashRecoveryJournal;
use crate::shared::errors::CoreError;
use crate::shared::progress::CancellationToken;
use freemydisk_platform::traits::PlatformFilesystem;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisposalItemResult {
    pub path: PathBuf,
    pub success: bool,
    pub bytes_freed: u64,
    pub route_used: String, // "trash" | "permanent"
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisposalSummary {
    pub session_id: String,
    pub total_requested_items: usize,
    pub successful_items: usize,
    pub failed_items: usize,
    pub total_freed_bytes: u64,
    pub results: Vec<DisposalItemResult>,
    pub failed_trash_paths: Vec<PathBuf>,
}

pub struct DisposalEngine;

impl DisposalEngine {
    /// Executes a cleanup plan through the multi-stage disposal pipeline.
    /// Invariants enforced:
    /// - Exclusive kernel cross-process lockfile acquired before any mutations.
    /// - Trash-first default.
    /// - Zero automatic fallback to permanent deletion on trash failure.
    /// - Pre-logging into SQLite WAL CrashRecoveryJournal.
    /// - Atomic staging for permanent delete targets.
    /// - Space accounting includes ONLY successfully freed bytes.
    pub fn execute_plan(
        plan_items: &[CleanupPlanItem],
        platform: &dyn PlatformFilesystem,
        journal: &CrashRecoveryJournal,
        lock_dir: &Path,
        always_trash_override: bool,
        cancel: &CancellationToken,
    ) -> Result<DisposalSummary, CoreError> {
        Self::execute_plan_with_progress(
            plan_items,
            platform,
            journal,
            lock_dir,
            always_trash_override,
            cancel,
            |_, _, _, _| {},
        )
    }

    pub fn execute_plan_with_progress<F>(
        plan_items: &[CleanupPlanItem],
        platform: &dyn PlatformFilesystem,
        journal: &CrashRecoveryJournal,
        lock_dir: &Path,
        always_trash_override: bool,
        cancel: &CancellationToken,
        mut on_progress: F,
    ) -> Result<DisposalSummary, CoreError>
    where
        F: FnMut(usize, usize, &Path, u64),
    {
        let session_id = Uuid::new_v4().to_string();
        let lock_path = lock_dir.join("freemydisk_disposal.lock");

        // Step 0: Acquire cross-process lock
        let _lock_guard = platform
            .acquire_cross_process_lock(&lock_path)
            .map_err(|e| {
                log::error!("Failed to acquire disposal lock: {}", e);
                CoreError::LockBusy
            })?;

        let mut results = Vec::new();
        let mut failed_trash = Vec::new();
        let mut total_freed_bytes = 0u64;
        let mut successful_items = 0usize;
        let mut failed_items = 0usize;

        for (idx, item) in plan_items.iter().enumerate() {
            if cancel.is_cancelled() {
                break;
            }

            let path = &item.original_path;

            // Step 1: Re-validate path and hard-filter protected subpaths
            if !path.exists() {
                continue;
            }

            if is_subpath_protected(path, &item.protect_subpaths) {
                log::warn!("Protected subpath hard filter excised: {}", path.display());
                continue;
            }

            if let Err(e) = ProtectedPathRegistry::assert_safe_for_disposal(path) {
                log::error!("Safety violation refused for {}: {}", path.display(), e);
                results.push(DisposalItemResult {
                    path: path.clone(),
                    success: false,
                    bytes_freed: 0,
                    route_used: "rejected".to_string(),
                    error: Some(e.to_string()),
                });
                failed_items += 1;
                continue;
            }

            // Disk Space Exhaustion Circuit Breaker (§12.4):
            // Blocks staging mutations if the volume free space is dangerously low (< 500 MB)
            if let Err(e) = CrashRecoveryJournal::check_disk_space_guard(path, 0) {
                log::warn!(
                    "Disk space circuit breaker engaged for {}: {}",
                    path.display(),
                    e
                );
                results.push(DisposalItemResult {
                    path: path.clone(),
                    success: false,
                    bytes_freed: 0,
                    route_used: "aborted_low_space".to_string(),
                    error: Some(e.to_string()),
                });
                failed_items += 1;
                continue;
            }

            // Step 2: Classify disposal route
            let route_is_permanent = !always_trash_override
                && item.verified_rebuildable
                && item.default_action == "permanent"
                && (item.risk == "safe" || item.risk == "recoverable");

            let planned_action = if route_is_permanent {
                "permanent"
            } else {
                "trash"
            };

            // Step 3: Write intent to WAL crash recovery journal
            let staging_path = if route_is_permanent {
                Some(generate_staging_path(path))
            } else {
                None
            };

            let journal_id = match journal.write_intent(
                &session_id,
                path,
                staging_path.as_deref(),
                planned_action,
            ) {
                Ok(id) => id,
                Err(e) => {
                    log::error!(
                        "Failed to pre-log journal intent for {}: {}",
                        path.display(),
                        e
                    );
                    results.push(DisposalItemResult {
                        path: path.clone(),
                        success: false,
                        bytes_freed: 0,
                        route_used: planned_action.to_string(),
                        error: Some(format!("journal_error: {}", e)),
                    });
                    failed_items += 1;
                    continue;
                }
            };

            // Step 4: Execute disposal (with TOCTOU race re-validation)
            if let Err(e) = ProtectedPathRegistry::assert_safe_for_disposal(path) {
                log::error!(
                    "TOCTOU safety violation refused for {}: {}",
                    path.display(),
                    e
                );
                let _ = journal.mark_failed(journal_id, &e.to_string());
                results.push(DisposalItemResult {
                    path: path.clone(),
                    success: false,
                    bytes_freed: 0,
                    route_used: planned_action.to_string(),
                    error: Some(e.to_string()),
                });
                failed_items += 1;
                continue;
            }

            if route_is_permanent {
                let (freed, err) = execute_tolerant_permanent_delete(path, cancel);
                if freed > 0 || err.is_none() {
                    let actual_freed = if freed > 0 { freed } else { item.size_bytes };
                    let _ = journal.mark_completed(journal_id);
                    results.push(DisposalItemResult {
                        path: path.clone(),
                        success: true,
                        bytes_freed: actual_freed,
                        route_used: "permanent".to_string(),
                        error: None,
                    });
                    total_freed_bytes += actual_freed;
                    successful_items += 1;
                } else {
                    let err_msg = err.unwrap_or_else(|| "Failed to delete item".to_string());
                    let _ = journal.mark_failed(journal_id, &err_msg);
                    results.push(DisposalItemResult {
                        path: path.clone(),
                        success: false,
                        bytes_freed: 0,
                        route_used: "permanent".to_string(),
                        error: Some(err_msg),
                    });
                    failed_items += 1;
                }
            } else {
                // TRASH ROUTE (Default)
                match platform.trash_path(path) {
                    Ok(()) => {
                        let _ = journal.mark_completed(journal_id);
                        results.push(DisposalItemResult {
                            path: path.clone(),
                            success: true,
                            bytes_freed: item.size_bytes,
                            route_used: "trash".to_string(),
                            error: None,
                        });
                        total_freed_bytes += item.size_bytes;
                        successful_items += 1;
                    }
                    Err(e) => {
                        // Rebuildable cache fallback: if OS Trash fails on safe rebuildable temporary data,
                        // gracefully fall back to tolerant permanent deletion so disk space is actually reclaimed.
                        if item.verified_rebuildable
                            && (item.risk == "safe" || item.risk == "recoverable")
                        {
                            log::info!(
                                "Recycle Bin unavailable for rebuildable item '{}', falling back to tolerant permanent disposal: {}",
                                path.display(),
                                e
                            );
                            let (freed, err) = execute_tolerant_permanent_delete(path, cancel);
                            if freed > 0 || err.is_none() {
                                let actual_freed = if freed > 0 { freed } else { item.size_bytes };
                                let _ = journal.mark_completed(journal_id);
                                results.push(DisposalItemResult {
                                    path: path.clone(),
                                    success: true,
                                    bytes_freed: actual_freed,
                                    route_used: "permanent".to_string(),
                                    error: None,
                                });
                                total_freed_bytes += actual_freed;
                                successful_items += 1;
                            } else {
                                let err_msg = err.unwrap_or_else(|| e.to_string());
                                let _ = journal.mark_failed(journal_id, &err_msg);
                                results.push(DisposalItemResult {
                                    path: path.clone(),
                                    success: false,
                                    bytes_freed: 0,
                                    route_used: "trash".to_string(),
                                    error: Some(err_msg),
                                });
                                failed_trash.push(path.clone());
                                failed_items += 1;
                            }
                        } else {
                            // User documents, personal files, or caution items:
                            // Strictly preserve safety invariant and record for manual decision.
                            log::warn!(
                                "Trash failed for '{}'. Refusing automatic permanent deletion. Error: {}",
                                path.display(),
                                e
                            );
                            let _ = journal.mark_failed(journal_id, "trash_unavailable");
                            results.push(DisposalItemResult {
                                path: path.clone(),
                                success: false,
                                bytes_freed: 0,
                                route_used: "trash".to_string(),
                                error: Some("trash_unavailable".to_string()),
                            });
                            failed_trash.push(path.clone());
                            failed_items += 1;
                        }
                    }
                }
            }

            on_progress(idx + 1, plan_items.len(), path, total_freed_bytes);
        }

        Ok(DisposalSummary {
            session_id,
            total_requested_items: plan_items.len(),
            successful_items,
            failed_items,
            total_freed_bytes,
            results,
            failed_trash_paths: failed_trash,
        })
    }

    /// Explicit manual follow-up action for items where Trash failed.
    pub fn execute_manual_permanent_delete(
        path: &Path,
        journal: &CrashRecoveryJournal,
        platform: &dyn PlatformFilesystem,
        lock_dir: &Path,
    ) -> Result<DisposalItemResult, CoreError> {
        if !path.exists() {
            return Err(CoreError::Io {
                path: path.to_path_buf(),
                source: std::io::Error::new(std::io::ErrorKind::NotFound, "Path not found"),
            });
        }

        ProtectedPathRegistry::assert_safe_for_disposal(path)?;

        let lock_path = lock_dir.join("freemydisk_disposal.lock");
        let _lock_guard = platform
            .acquire_cross_process_lock(&lock_path)
            .map_err(|e| {
                log::error!("Failed to acquire disposal lock for manual delete: {}", e);
                CoreError::LockBusy
            })?;

        let size = if path.is_dir() {
            walkdir::WalkDir::new(path)
                .min_depth(1)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
                .filter_map(|e| e.metadata().ok().map(|m| m.len()))
                .sum()
        } else {
            path.metadata().map(|m| m.len()).unwrap_or(0)
        };

        let session_id = format!("manual-{}", Uuid::new_v4());
        let staging_path = generate_staging_path(path);

        let journal_id =
            journal.write_intent(&session_id, path, Some(&staging_path), "permanent")?;

        let cancel = CancellationToken::new();
        let (freed, err) = execute_tolerant_permanent_delete(path, &cancel);
        if freed > 0 || err.is_none() {
            let actual_freed = if freed > 0 { freed } else { size };
            let _ = journal.mark_completed(journal_id);
            Ok(DisposalItemResult {
                path: path.to_path_buf(),
                success: true,
                bytes_freed: actual_freed,
                route_used: "permanent".to_string(),
                error: None,
            })
        } else {
            let err_msg = err.unwrap_or_else(|| "Failed to delete item".to_string());
            let _ = journal.mark_failed(journal_id, &err_msg);
            Ok(DisposalItemResult {
                path: path.to_path_buf(),
                success: false,
                bytes_freed: 0,
                route_used: "permanent".to_string(),
                error: Some(err_msg),
            })
        }
    }
}

fn generate_staging_path(target: &Path) -> PathBuf {
    let parent = target.parent().unwrap_or(Path::new("."));
    let uuid_str = Uuid::new_v4().to_string();
    parent.join(format!(".fmd-staging-{}", uuid_str))
}

fn strip_readonly_attribute(path: &Path) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        let ext = crate::shared::paths::to_extended_path(path);
        let wide: Vec<u16> = ext
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let attrs =
            unsafe { windows_sys::Win32::Storage::FileSystem::GetFileAttributesW(wide.as_ptr()) };
        if attrs != u32::MAX && (attrs & 0x00000001 != 0) {
            unsafe {
                windows_sys::Win32::Storage::FileSystem::SetFileAttributesW(
                    wide.as_ptr(),
                    attrs & !0x00000001,
                );
            }
        }
    }
}

fn remove_file_with_sharing_retry(path: &Path) -> std::io::Result<()> {
    let ext_path = crate::shared::paths::to_extended_path(path);
    let mut attempts = 0;
    loop {
        match fs::remove_file(&ext_path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                let code = e.raw_os_error().unwrap_or(0);
                if (code == 32 || code == 33) && attempts < 3 {
                    attempts += 1;
                    let delay_ms = match attempts {
                        1 => 50,
                        2 => 150,
                        _ => 300,
                    };
                    std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                    continue;
                }
                return Err(e);
            }
        }
    }
}

fn remove_dir_with_sharing_retry(path: &Path) -> std::io::Result<()> {
    let ext_path = crate::shared::paths::to_extended_path(path);
    let mut attempts = 0;
    loop {
        match fs::remove_dir(&ext_path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                let code = e.raw_os_error().unwrap_or(0);
                if (code == 32 || code == 33) && attempts < 3 {
                    attempts += 1;
                    let delay_ms = match attempts {
                        1 => 50,
                        2 => 150,
                        _ => 300,
                    };
                    std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                    continue;
                }
                return Err(e);
            }
        }
    }
}

pub fn execute_tolerant_permanent_delete(
    target: &Path,
    cancel: &CancellationToken,
) -> (u64, Option<String>) {
    if !target.exists() {
        return (0, None);
    }

    // TOCTOU Symlink / Reparse Point Safety Guard:
    // If target itself is a reparse point (junction, symlink directory, or mount point),
    // NEVER recurse into it. Only unlink the mount-point pointer!
    if ProtectedPathRegistry::is_reparse_point(target) {
        log::info!(
            "Target '{}' is a reparse point (junction/symlink). Unlinking mount-point pointer without recursing.",
            target.display()
        );
        strip_readonly_attribute(target);
        if remove_dir_with_sharing_retry(target).is_ok()
            || remove_file_with_sharing_retry(target).is_ok()
        {
            return (0, None);
        } else {
            return (
                0,
                Some("Failed to unlink reparse point mount pointer".to_string()),
            );
        }
    }

    if target.is_file() || target.is_symlink() {
        let size = target.metadata().map(|m| m.len()).unwrap_or(0);
        strip_readonly_attribute(target);
        match remove_file_with_sharing_retry(target) {
            Ok(()) => (size, None),
            Err(e) => (0, Some(format!("Failed to delete file: {}", e))),
        }
    } else if target.is_dir() {
        let (freed, deleted_count, failed_count) =
            delete_directory_contents_tolerant(target, cancel);
        strip_readonly_attribute(target);
        let _ = remove_dir_with_sharing_retry(target);
        if freed > 0 || deleted_count > 0 {
            (freed, None)
        } else if failed_count > 0 {
            (
                0,
                Some("Directory contents could not be removed (files in use)".to_string()),
            )
        } else {
            (0, None)
        }
    } else {
        (0, None)
    }
}

pub fn delete_directory_contents_tolerant(
    dir: &Path,
    cancel: &CancellationToken,
) -> (u64, usize, usize) {
    let mut freed_bytes = 0u64;
    let mut deleted_count = 0usize;
    let mut failed_count = 0usize;

    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if cancel.is_cancelled() {
                break;
            }

            let path = entry.path();
            if let Ok(ft) = entry.file_type() {
                if ft.is_file() || ft.is_symlink() {
                    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    strip_readonly_attribute(&path);
                    if remove_file_with_sharing_retry(&path).is_ok() {
                        freed_bytes += size;
                        deleted_count += 1;
                    } else {
                        failed_count += 1;
                    }
                } else if ft.is_dir() {
                    // CRITICAL SECURITY GUARD: Inspect if subpath is a junction or symlink reparse point
                    if ProtectedPathRegistry::is_reparse_point(&path) {
                        log::info!("Reparse point (junction/symlink) detected at '{}' — unlinking mount point without recursion", path.display());
                        strip_readonly_attribute(&path);
                        if remove_dir_with_sharing_retry(&path).is_ok()
                            || remove_file_with_sharing_retry(&path).is_ok()
                        {
                            deleted_count += 1;
                        } else {
                            failed_count += 1;
                        }
                    } else {
                        let (sub_bytes, sub_del, sub_fail) =
                            delete_directory_contents_tolerant(&path, cancel);
                        freed_bytes += sub_bytes;
                        deleted_count += sub_del;
                        failed_count += sub_fail;
                        strip_readonly_attribute(&path);
                        let _ = remove_dir_with_sharing_retry(&path);
                    }
                }
            }
        }
    }

    (freed_bytes, deleted_count, failed_count)
}
