use crate::cleanup::matchers::{contains_protected_subpath, is_subpath_protected};
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
    /// Items that no longer existed when their turn came.
    #[serde(default)]
    pub skipped_items: usize,
    /// Bytes actually removed from disk. Items moved to the Recycle Bin still
    /// occupy the same volume, so they are counted in `recycled_bytes` instead.
    pub total_freed_bytes: u64,
    /// Bytes moved to the Recycle Bin.
    #[serde(default)]
    pub recycled_bytes: u64,
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

        let plan_items = expand_protected_dirs(plan_items);

        let mut results = Vec::new();
        let mut failed_trash = Vec::new();
        let mut total_freed_bytes = 0u64;
        let mut recycled_bytes = 0u64;
        let mut successful_items = 0usize;
        let mut failed_items = 0usize;
        let mut skipped_items = 0usize;

        for (idx, item) in plan_items.iter().enumerate() {
            if cancel.is_cancelled() {
                break;
            }

            let path = &item.original_path;
            'item: {
                if !path.exists() {
                    skipped_items += 1;
                    results.push(DisposalItemResult {
                        path: path.clone(),
                        success: true,
                        bytes_freed: 0,
                        route_used: "missing".to_string(),
                        error: None,
                    });
                    break 'item;
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
                    break 'item;
                }

                let route_is_permanent = !always_trash_override
                    && item.verified_rebuildable
                    && item.default_action == "permanent"
                    && (item.risk == "safe" || item.risk == "recoverable");
                let planned_action = if route_is_permanent {
                    "permanent"
                } else {
                    "trash"
                };

                // Write intent to the crash recovery journal before touching the disk.
                let staging_path = route_is_permanent.then(|| generate_staging_path(path));
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
                        break 'item;
                    }
                };

                // Re-validate right before acting (TOCTOU).
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
                    break 'item;
                }

                if route_is_permanent {
                    let (freed, err) = delete_through_staging(
                        path,
                        staging_path.as_deref(),
                        journal,
                        journal_id,
                        cancel,
                    );
                    // Only measured bytes count, also when deletion was partial.
                    total_freed_bytes += freed;
                    let _ = match err {
                        None => journal.mark_completed(journal_id),
                        Some(ref msg) => journal.mark_failed(journal_id, msg),
                    };
                    if err.is_none() {
                        successful_items += 1;
                    } else {
                        failed_items += 1;
                    }
                    results.push(DisposalItemResult {
                        path: path.clone(),
                        success: err.is_none(),
                        bytes_freed: freed,
                        route_used: "permanent".to_string(),
                        error: err,
                    });
                } else {
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
                            recycled_bytes += item.size_bytes;
                            successful_items += 1;
                        }
                        Err(e) => {
                            // Never fall back to permanent deletion: the item is reported so the
                            // user can decide explicitly (retry trash or force delete).
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

            on_progress(
                idx + 1,
                plan_items.len(),
                path,
                total_freed_bytes + recycled_bytes,
            );
        }

        Ok(DisposalSummary {
            session_id,
            total_requested_items: plan_items.len(),
            successful_items,
            failed_items,
            skipped_items,
            total_freed_bytes,
            recycled_bytes,
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

        let session_id = format!("manual-{}", Uuid::new_v4());
        let staging_path = generate_staging_path(path);

        let journal_id =
            journal.write_intent(&session_id, path, Some(&staging_path), "permanent")?;

        let cancel = CancellationToken::new();
        let (freed, err) =
            delete_through_staging(path, Some(&staging_path), journal, journal_id, &cancel);
        let _ = match err {
            None => journal.mark_completed(journal_id),
            Some(ref msg) => journal.mark_failed(journal_id, msg),
        };
        Ok(DisposalItemResult {
            path: path.to_path_buf(),
            success: err.is_none(),
            bytes_freed: freed,
            route_used: "permanent".to_string(),
            error: err,
        })
    }
}

/// Splits folder items that contain entries matching `protect_subpaths` into their
/// unprotected children, so protected entries stay on disk. Items that are
/// protected themselves are dropped.
fn expand_protected_dirs(items: &[CleanupPlanItem]) -> Vec<CleanupPlanItem> {
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        push_unprotected(item, &item.original_path, &mut out);
    }
    out
}

fn push_unprotected(template: &CleanupPlanItem, path: &Path, out: &mut Vec<CleanupPlanItem>) {
    if is_subpath_protected(path, &template.protect_subpaths) {
        log::info!("Keeping protected path: {}", path.display());
        return;
    }

    let splittable = path.is_dir()
        && !ProtectedPathRegistry::is_reparse_point(path)
        && contains_protected_subpath(path, &template.protect_subpaths);
    if !splittable {
        if path == template.original_path {
            out.push(template.clone());
        } else {
            out.push(CleanupPlanItem {
                original_path: path.to_path_buf(),
                canonical_path: crate::shared::paths::normalize_path(path),
                size_bytes: measure_size(path),
                is_dir: path.is_dir(),
                ..template.clone()
            });
        }
        return;
    }

    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            push_unprotected(template, &entry.path(), out);
        }
    }
}

fn measure_size(path: &Path) -> u64 {
    if path.is_dir() {
        walkdir::WalkDir::new(path)
            .min_depth(1)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
            .filter_map(|e| e.metadata().ok().map(|m| m.len()))
            .sum()
    } else {
        path.symlink_metadata().map(|m| m.len()).unwrap_or(0)
    }
}

/// Renames `path` to its staging name before deleting it, so a crash leaves a
/// restorable copy that the journal can put back. Whatever cannot be deleted is
/// restored to the original location. When the rename is refused (for example,
/// a folder with open files), the item is deleted in place.
fn delete_through_staging(
    path: &Path,
    staging: Option<&Path>,
    journal: &CrashRecoveryJournal,
    journal_id: i64,
    cancel: &CancellationToken,
) -> (u64, Option<String>) {
    let Some(staged) = staging.filter(|s| fs::rename(path, s).is_ok()) else {
        let _ = journal.clear_staging(journal_id);
        return execute_tolerant_permanent_delete(path, cancel);
    };

    let (freed, err) = execute_tolerant_permanent_delete(staged, cancel);
    if staged.exists() {
        if let Err(e) = fs::rename(staged, path) {
            log::error!(
                "Could not restore partially deleted '{}' from staging: {}",
                path.display(),
                e
            );
        } else {
            let _ = journal.clear_staging(journal_id);
        }
        let reason = err.unwrap_or_else(|| "Some files could not be deleted".to_string());
        return (freed, Some(reason));
    }
    (freed, err)
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
