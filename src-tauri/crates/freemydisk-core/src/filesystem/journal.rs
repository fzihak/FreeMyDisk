use crate::shared::errors::CoreError;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JournalRecord {
    pub id: i64,
    pub session_id: String,
    pub target_path: PathBuf,
    pub staging_path: Option<PathBuf>,
    pub planned_action: String,
    pub timestamp: u64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RemediationOutcome {
    RestoredToOriginalPath(PathBuf),
    ConflictTargetExistsRequiresManualReview(PathBuf),
    StagingMissingNoOp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemediationResult {
    pub id: i64,
    pub target_path: PathBuf,
    pub outcome: RemediationOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirtyShutdownSummary {
    pub has_interrupted: bool,
    pub interrupted_count: usize,
    pub stranded_staging_paths: Vec<PathBuf>,
    pub can_auto_restore: bool,
}

#[derive(Clone)]
pub struct CrashRecoveryJournal {
    conn: Arc<Mutex<Connection>>,
}

impl CrashRecoveryJournal {
    pub fn open(db_path: &Path) -> Result<Self, CoreError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = Connection::open(db_path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS disposal_journal (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                target_path TEXT NOT NULL,
                staging_path TEXT,
                planned_action TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                status TEXT NOT NULL
            );",
            [],
        )?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_disposal_journal_status ON disposal_journal (status);",
            [],
        )?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS scan_checkpoints (
                scan_id TEXT PRIMARY KEY,
                scan_type TEXT NOT NULL,
                last_scanned_path TEXT NOT NULL,
                files_scanned INTEGER NOT NULL,
                bytes_scanned INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );",
            [],
        )?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS undo_rollback_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                original_path TEXT NOT NULL,
                backup_path TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
            );",
            [],
        )?;

        let journal = Self {
            conn: Arc::new(Mutex::new(conn)),
        };

        // Auto-purge stale records older than 30 days and checkpoint WAL on startup
        let _ = journal.purge_old_records(30);
        let _ = journal.checkpoint_wal();

        Ok(journal)
    }

    pub fn write_intent(
        &self,
        session_id: &str,
        target_path: &Path,
        staging_path: Option<&Path>,
        planned_action: &str,
    ) -> Result<i64, CoreError> {
        let conn = self.conn.lock().unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let target_str = target_path.to_string_lossy();
        let staging_str = staging_path.map(|p| p.to_string_lossy().to_string());

        conn.execute(
            "INSERT INTO disposal_journal (session_id, target_path, staging_path, planned_action, timestamp, status)
             VALUES (?1, ?2, ?3, ?4, ?5, 'in_flight');",
            params![session_id, target_str, staging_str, planned_action, now],
        )?;

        Ok(conn.last_insert_rowid())
    }

    pub fn mark_completed(&self, id: i64) -> Result<(), CoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE disposal_journal SET status = 'completed' WHERE id = ?1;",
            params![id],
        )?;
        Ok(())
    }

    pub fn mark_failed(&self, id: i64, error_code: &str) -> Result<(), CoreError> {
        let conn = self.conn.lock().unwrap();
        let status = format!("failed: {}", error_code);
        conn.execute(
            "UPDATE disposal_journal SET status = ?1 WHERE id = ?2;",
            params![status, id],
        )?;
        Ok(())
    }

    pub fn list_in_flight(&self) -> Result<Vec<JournalRecord>, CoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, target_path, staging_path, planned_action, timestamp, status
             FROM disposal_journal
             WHERE status = 'in_flight';",
        )?;

        let rows = stmt.query_map([], |row| {
            let staging_raw: Option<String> = row.get(3)?;
            Ok(JournalRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                target_path: PathBuf::from(row.get::<_, String>(2)?),
                staging_path: staging_raw.map(PathBuf::from),
                planned_action: row.get(4)?,
                timestamp: row.get(5)?,
                status: row.get(6)?,
            })
        })?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    /// Single-show dismiss: marks all current in_flight rows as acknowledged so the alert does not repeat.
    pub fn acknowledge_in_flight(&self) -> Result<usize, CoreError> {
        let conn = self.conn.lock().unwrap();
        let changed = conn.execute(
            "UPDATE disposal_journal SET status = 'acknowledged' WHERE status = 'in_flight';",
            [],
        )?;
        Ok(changed)
    }

    /// Remediates stranded staged files after an application crash.
    /// - Branch A: Target path does not exist -> Move staging path back to target path, status = 'restored_from_staging'.
    /// - Branch B: Target path was recreated -> DO NOT OVERWRITE. Leave at staging path, status = 'requires_manual_review'.
    pub fn remediate_staged_crashes(&self) -> Result<Vec<RemediationResult>, CoreError> {
        let in_flight = self.list_in_flight()?;
        let mut results = Vec::new();

        for record in in_flight {
            if let Some(staging) = &record.staging_path {
                if staging.exists() {
                    if !record.target_path.exists() {
                        // Branch A: Target free, restore staged file to original location
                        if let Err(e) = std::fs::rename(staging, &record.target_path) {
                            log::error!(
                                "Failed to restore staged file '{}': {}",
                                staging.display(),
                                e
                            );
                        } else {
                            let conn = self.conn.lock().unwrap();
                            conn.execute(
                                "UPDATE disposal_journal SET status = 'restored_from_staging' WHERE id = ?1;",
                                params![record.id],
                            )?;
                            results.push(RemediationResult {
                                id: record.id,
                                target_path: record.target_path.clone(),
                                outcome: RemediationOutcome::RestoredToOriginalPath(
                                    record.target_path.clone(),
                                ),
                            });
                            continue;
                        }
                    } else {
                        // Branch B: Conflict! Target already recreated by system/app. Never overwrite!
                        let conn = self.conn.lock().unwrap();
                        conn.execute(
                            "UPDATE disposal_journal SET status = 'requires_manual_review' WHERE id = ?1;",
                            params![record.id],
                        )?;
                        results.push(RemediationResult {
                            id: record.id,
                            target_path: record.target_path.clone(),
                            outcome: RemediationOutcome::ConflictTargetExistsRequiresManualReview(
                                staging.clone(),
                            ),
                        });
                        continue;
                    }
                } else {
                    results.push(RemediationResult {
                        id: record.id,
                        target_path: record.target_path.clone(),
                        outcome: RemediationOutcome::StagingMissingNoOp,
                    });
                }
            }
        }

        Ok(results)
    }

    /// Queries the journal for uncommitted, interrupted items from an abnormal shutdown.
    pub fn inspect_dirty_shutdown(&self) -> Result<DirtyShutdownSummary, CoreError> {
        let in_flight = self.list_in_flight()?;
        let mut stranded_staging = Vec::new();

        for r in &in_flight {
            if let Some(ref staging) = r.staging_path {
                if staging.exists() {
                    stranded_staging.push(staging.clone());
                }
            }
        }

        let has_interrupted = !in_flight.is_empty();
        let interrupted_count = in_flight.len();
        let can_auto_restore = !stranded_staging.is_empty();

        Ok(DirtyShutdownSummary {
            has_interrupted,
            interrupted_count,
            stranded_staging_paths: stranded_staging,
            can_auto_restore,
        })
    }

    /// Performs self-healing upon startup: inspects dirty shutdown,
    /// restores stranded staging files if their original targets are free,
    /// and logs the self-healing outcome.
    pub fn self_heal_on_boot(&self) -> Result<Vec<RemediationResult>, CoreError> {
        let summary = self.inspect_dirty_shutdown()?;
        if !summary.has_interrupted {
            return Ok(Vec::new());
        }

        log::warn!(
            "Dirty shutdown detected: {} in-flight records found. Initiating self-healing...",
            summary.interrupted_count
        );

        let remediation = self.remediate_staged_crashes()?;
        log::info!(
            "Self-healing completed: {} items remediated",
            remediation.len()
        );
        Ok(remediation)
    }

    /// Terminal resolution for manual review conflicts.
    pub fn mark_resolved_manual(&self, id: i64) -> Result<(), CoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE disposal_journal SET status = 'resolved_manual' WHERE id = ?1;",
            params![id],
        )?;
        Ok(())
    }

    /// Checkpoints SQLite WAL to merge journal transactions and release disk space.
    pub fn checkpoint_wal(&self) -> Result<(), CoreError> {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);");
        Ok(())
    }

    /// Retention policy: purge terminal status rows older than 30 days.
    pub fn purge_old_records(&self, days_retention: u32) -> Result<usize, CoreError> {
        let conn = self.conn.lock().unwrap();
        let cutoff = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            .saturating_sub((days_retention as u64) * 86400);

        let purged = conn.execute(
            "DELETE FROM disposal_journal
             WHERE (status IN ('completed', 'acknowledged', 'restored_from_staging', 'resolved_manual')
                OR status LIKE 'failed%')
               AND timestamp <= ?1;",
            params![cutoff],
        )?;

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let _ = conn.execute(
            "DELETE FROM undo_rollback_records WHERE expires_at <= ?1;",
            params![now],
        );

        Ok(purged)
    }

    /// Retrieves the most recent cleanup operation records.
    pub fn list_recent_history(&self, limit: usize) -> Result<Vec<JournalRecord>, CoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, target_path, staging_path, planned_action, timestamp, status
             FROM disposal_journal
             ORDER BY id DESC
             LIMIT ?1;",
        )?;

        let rows = stmt.query_map(params![limit as i64], |row| {
            let staging_raw: Option<String> = row.get(3)?;
            Ok(JournalRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                target_path: PathBuf::from(row.get::<_, String>(2)?),
                staging_path: staging_raw.map(PathBuf::from),
                planned_action: row.get(4)?,
                timestamp: row.get(5)?,
                status: row.get(6)?,
            })
        })?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    /// Clears historical cleanup records (preserves in_flight records).
    pub fn clear_history(&self) -> Result<usize, CoreError> {
        let conn = self.conn.lock().unwrap();
        let cleared = conn.execute(
            "DELETE FROM disposal_journal WHERE status != 'in_flight';",
            [],
        )?;
        Ok(cleared)
    }

    /// Issues an emergency SQLite WAL checkpoint to ensure all journal data is synchronized to disk before shutdown or panic.
    pub fn emergency_flush(&self) -> Result<(), CoreError> {
        if let Ok(conn) = self.conn.lock() {
            let _ = conn.execute("PRAGMA wal_checkpoint(FULL);", []);
        }
        Ok(())
    }

    /// Runs SQLite PRAGMA integrity_check to verify database file consistency.
    pub fn check_integrity(&self) -> Result<String, CoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("PRAGMA integrity_check;")?;
        let res: String = stmt.query_row([], |row| row.get(0))?;
        Ok(res)
    }

    /// Verifies that the storage volume holding `target` has at least `required_bytes` plus a 500 MB safe headroom buffer.
    pub fn check_disk_space_guard(target: &Path, required_bytes: u64) -> Result<(), CoreError> {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::ffi::OsStrExt;
            let mut root = target.to_path_buf();
            while let Some(parent) = root.parent() {
                if parent.as_os_str().is_empty() || parent == root {
                    break;
                }
                root = parent.to_path_buf();
            }
            let wide: Vec<u16> = root
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let mut free_bytes_available: u64 = 0;
            let mut total_bytes: u64 = 0;
            let mut total_free_bytes: u64 = 0;
            let res = unsafe {
                windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
                    wide.as_ptr(),
                    &mut free_bytes_available,
                    &mut total_bytes,
                    &mut total_free_bytes,
                )
            };
            if res != 0 {
                const MINIMUM_SAFE_HEADROOM: u64 = 500 * 1024 * 1024; // 500 MB minimum safe buffer
                if free_bytes_available < MINIMUM_SAFE_HEADROOM + required_bytes {
                    return Err(CoreError::DiskSpaceExhaustionGuard {
                        available_bytes: free_bytes_available,
                        required_bytes: MINIMUM_SAFE_HEADROOM + required_bytes,
                    });
                }
            }
        }
        Ok(())
    }

    /// Saves or updates an active scan checkpoint for resuming interrupted scans.
    pub fn save_scan_checkpoint(
        &self,
        scan_id: &str,
        scan_type: &str,
        path: &str,
        files: u64,
        bytes: u64,
    ) -> Result<(), CoreError> {
        let conn = self.conn.lock().unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        conn.execute(
            "INSERT INTO scan_checkpoints (scan_id, scan_type, last_scanned_path, files_scanned, bytes_scanned, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(scan_id) DO UPDATE SET
                last_scanned_path = excluded.last_scanned_path,
                files_scanned = excluded.files_scanned,
                bytes_scanned = excluded.bytes_scanned,
                updated_at = excluded.updated_at;",
            params![scan_id, scan_type, path, files as i64, bytes as i64, now as i64],
        )?;
        Ok(())
    }

    /// Retrieves an active scan checkpoint by scan ID if one exists.
    pub fn get_scan_checkpoint(
        &self,
        scan_id: &str,
    ) -> Result<Option<(String, String, u64, u64)>, CoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT scan_type, last_scanned_path, files_scanned, bytes_scanned FROM scan_checkpoints WHERE scan_id = ?1;",
        )?;
        let mut rows = stmt.query(params![scan_id])?;
        if let Some(row) = rows.next()? {
            let scan_type: String = row.get(0)?;
            let path: String = row.get(1)?;
            let files: i64 = row.get(2)?;
            let bytes: i64 = row.get(3)?;
            Ok(Some((scan_type, path, files as u64, bytes as u64)))
        } else {
            Ok(None)
        }
    }

    /// Clears a completed scan checkpoint.
    pub fn clear_scan_checkpoint(&self, scan_id: &str) -> Result<(), CoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM scan_checkpoints WHERE scan_id = ?1;",
            params![scan_id],
        )?;
        Ok(())
    }

    /// Records an undo rollback record with retention window (e.g. 24 hours).
    pub fn record_undo_backup(
        &self,
        session_id: &str,
        original_path: &Path,
        backup_path: &Path,
        retention_hours: u32,
    ) -> Result<i64, CoreError> {
        let conn = self.conn.lock().unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let expires_at = now + (retention_hours as u64) * 3600;

        conn.execute(
            "INSERT INTO undo_rollback_records (session_id, original_path, backup_path, created_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5);",
            params![
                session_id,
                original_path.to_string_lossy(),
                backup_path.to_string_lossy(),
                now as i64,
                expires_at as i64
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Lists active undo rollback backups within the undo window.
    pub fn list_active_undo_backups(
        &self,
    ) -> Result<Vec<(i64, String, PathBuf, PathBuf)>, CoreError> {
        let conn = self.conn.lock().unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let mut stmt = conn.prepare(
            "SELECT id, session_id, original_path, backup_path FROM undo_rollback_records WHERE expires_at > ?1 ORDER BY id DESC;",
        )?;
        let rows = stmt.query_map(params![now as i64], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                PathBuf::from(row.get::<_, String>(2)?),
                PathBuf::from(row.get::<_, String>(3)?),
            ))
        })?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }
}
