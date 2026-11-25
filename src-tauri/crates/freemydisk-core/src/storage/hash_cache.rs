use crate::shared::errors::CoreError;
use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct HashCache {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone)]
pub struct CachedHash {
    pub sample_hash: String,
    pub full_hash: String,
}

impl HashCache {
    /// Opens or creates the SQLite-backed hash persistence store.
    pub fn open(db_path: &Path) -> Result<Self, CoreError> {
        if let Some(parent) = db_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let conn = Connection::open(db_path)?;

        // WAL mode for fast concurrency
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             DROP TABLE IF EXISTS hash_cache;
             CREATE TABLE IF NOT EXISTS hash_cache_v2 (
                 path TEXT NOT NULL,
                 size INTEGER NOT NULL,
                 mtime_ns INTEGER NOT NULL,
                 sample_hash TEXT NOT NULL,
                 full_hash TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 PRIMARY KEY (path, size, mtime_ns)
             );",
        )?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Opens an in-memory hash cache (primarily for unit tests).
    pub fn in_memory() -> Result<Self, CoreError> {
        let conn = Connection::open_in_memory()?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS hash_cache_v2 (
                 path TEXT NOT NULL,
                 size INTEGER NOT NULL,
                 mtime_ns INTEGER NOT NULL,
                 sample_hash TEXT NOT NULL,
                 full_hash TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 PRIMARY KEY (path, size, mtime_ns)
             );",
        )?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Looks up a cached hash for the given path, size and modification time in
    /// nanoseconds. Any change to the file's size or timestamp misses the cache.
    /// (The previous table keyed on whole seconds, so an edit within the same second
    /// returned a stale hash; it is dropped on open.)
    pub fn lookup(&self, path: &Path, size: u64, mtime_ns: u64) -> Option<CachedHash> {
        let path_str = path.to_string_lossy();
        let guard = self.conn.lock().ok()?;

        let mut stmt = guard
            .prepare_cached(
                "SELECT sample_hash, full_hash FROM hash_cache_v2 WHERE path = ?1 AND size = ?2 AND mtime_ns = ?3 LIMIT 1",
            )
            .ok()?;

        let res = stmt
            .query_row(
                params![path_str.as_ref(), size as i64, mtime_ns as i64],
                |row| {
                    Ok(CachedHash {
                        sample_hash: row.get(0)?,
                        full_hash: row.get(1)?,
                    })
                },
            )
            .ok();

        res
    }

    /// Stores a computed partial and full hash in the persistent cache.
    pub fn store(&self, path: &Path, size: u64, mtime_ns: u64, sample_hash: &str, full_hash: &str) {
        let path_str = path.to_string_lossy();
        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        if let Ok(guard) = self.conn.lock() {
            let _ = guard.execute(
                "INSERT OR REPLACE INTO hash_cache_v2 (path, size, mtime_ns, sample_hash, full_hash, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    path_str.as_ref(),
                    size as i64,
                    mtime_ns as i64,
                    sample_hash,
                    full_hash,
                    now_secs as i64
                ],
            );
        }
    }

    /// Evicts entries older than `max_age_days`.
    pub fn evict_stale(&self, max_age_days: u32) -> Result<usize, CoreError> {
        let cutoff_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
            .saturating_sub((max_age_days as u64) * 86400);

        let guard = self.conn.lock().map_err(|_| CoreError::LockBusy)?;

        let deleted = guard.execute(
            "DELETE FROM hash_cache_v2 WHERE created_at < ?1",
            params![cutoff_secs as i64],
        )?;

        Ok(deleted)
    }
}
