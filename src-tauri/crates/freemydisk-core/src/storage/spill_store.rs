use crate::shared::errors::CoreError;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CandidateEntry {
    pub path: PathBuf,
    pub size_bytes: u64,
    pub is_dir: bool,
    pub modified_at: u64,
    pub rule_id: Option<String>,
}

enum StoreBackend {
    Memory(Vec<CandidateEntry>),
    Disk {
        conn: Connection,
        db_path: PathBuf,
        count: usize,
    },
}

/// CandidateStore provides bounded-memory tracking for filesystem scans.
/// Maintains candidates in RAM up to `spill_threshold` (e.g. 5,000,000 entries).
/// Automatically transitions to a temporary SQLite indexed table if the count
/// exceeds the threshold, preventing Out-Of-Memory (OOM) crashes on large drives.
pub struct CandidateStore {
    spill_threshold: usize,
    temp_dir: PathBuf,
    backend: StoreBackend,
}

impl CandidateStore {
    pub fn new(spill_threshold: usize, temp_dir: PathBuf) -> Self {
        Self {
            spill_threshold,
            temp_dir,
            backend: StoreBackend::Memory(Vec::new()),
        }
    }

    pub fn is_spilled(&self) -> bool {
        matches!(self.backend, StoreBackend::Disk { .. })
    }

    pub fn len(&self) -> usize {
        match &self.backend {
            StoreBackend::Memory(vec) => vec.len(),
            StoreBackend::Disk { count, .. } => *count,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn push(&mut self, entry: CandidateEntry) -> Result<(), CoreError> {
        match &mut self.backend {
            StoreBackend::Memory(vec) => {
                if vec.len() < self.spill_threshold {
                    vec.push(entry);
                    Ok(())
                } else {
                    // Threshold exceeded: Spill existing RAM buffer to SQLite disk database
                    fs::create_dir_all(&self.temp_dir)?;
                    let db_path = self.temp_dir.join(format!("spill_{}.db", Uuid::new_v4()));
                    let mut conn = Connection::open(&db_path)?;

                    conn.pragma_update(None, "journal_mode", "WAL")?;
                    conn.pragma_update(None, "synchronous", "NORMAL")?;

                    conn.execute(
                        "CREATE TABLE candidates (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            path TEXT NOT NULL,
                            size_bytes INTEGER NOT NULL,
                            is_dir INTEGER NOT NULL,
                            modified_at INTEGER NOT NULL,
                            rule_id TEXT
                        );",
                        [],
                    )?;

                    conn.execute(
                        "CREATE INDEX idx_candidates_size ON candidates(size_bytes);",
                        [],
                    )?;

                    // Batch insert memory entries + new entry in a single transaction
                    let tx = conn.transaction()?;
                    {
                        let mut stmt = tx.prepare(
                            "INSERT INTO candidates (path, size_bytes, is_dir, modified_at, rule_id)
                             VALUES (?1, ?2, ?3, ?4, ?5);"
                        )?;

                        for item in vec.iter() {
                            stmt.execute(params![
                                item.path.to_string_lossy(),
                                item.size_bytes,
                                if item.is_dir { 1 } else { 0 },
                                item.modified_at,
                                item.rule_id
                            ])?;
                        }

                        stmt.execute(params![
                            entry.path.to_string_lossy(),
                            entry.size_bytes,
                            if entry.is_dir { 1 } else { 0 },
                            entry.modified_at,
                            entry.rule_id
                        ])?;
                    }
                    tx.commit()?;

                    let total_count = vec.len() + 1;
                    self.backend = StoreBackend::Disk {
                        conn,
                        db_path,
                        count: total_count,
                    };
                    Ok(())
                }
            }
            StoreBackend::Disk { conn, count, .. } => {
                conn.execute(
                    "INSERT INTO candidates (path, size_bytes, is_dir, modified_at, rule_id)
                     VALUES (?1, ?2, ?3, ?4, ?5);",
                    params![
                        entry.path.to_string_lossy(),
                        entry.size_bytes,
                        if entry.is_dir { 1 } else { 0 },
                        entry.modified_at,
                        entry.rule_id
                    ],
                )?;
                *count += 1;
                Ok(())
            }
        }
    }

    pub fn read_all(&self) -> Result<Vec<CandidateEntry>, CoreError> {
        match &self.backend {
            StoreBackend::Memory(vec) => Ok(vec.clone()),
            StoreBackend::Disk { conn, .. } => {
                let mut stmt = conn.prepare(
                    "SELECT path, size_bytes, is_dir, modified_at, rule_id
                     FROM candidates ORDER BY id ASC;",
                )?;

                let rows = stmt.query_map([], |row| {
                    let path_str: String = row.get(0)?;
                    let size_bytes: u64 = row.get(1)?;
                    let is_dir_int: i32 = row.get(2)?;
                    let modified_at: u64 = row.get(3)?;
                    let rule_id: Option<String> = row.get(4)?;

                    Ok(CandidateEntry {
                        path: PathBuf::from(path_str),
                        size_bytes,
                        is_dir: is_dir_int != 0,
                        modified_at,
                        rule_id,
                    })
                })?;

                let mut entries = Vec::new();
                for r in rows {
                    entries.push(r?);
                }
                Ok(entries)
            }
        }
    }

    pub fn read_by_min_size(&self, min_size: u64) -> Result<Vec<CandidateEntry>, CoreError> {
        match &self.backend {
            StoreBackend::Memory(vec) => Ok(vec
                .iter()
                .filter(|c| c.size_bytes >= min_size)
                .cloned()
                .collect()),
            StoreBackend::Disk { conn, .. } => {
                let mut stmt = conn.prepare(
                    "SELECT path, size_bytes, is_dir, modified_at, rule_id
                     FROM candidates WHERE size_bytes >= ?1 ORDER BY size_bytes DESC;",
                )?;

                let rows = stmt.query_map(params![min_size], |row| {
                    let path_str: String = row.get(0)?;
                    let size_bytes: u64 = row.get(1)?;
                    let is_dir_int: i32 = row.get(2)?;
                    let modified_at: u64 = row.get(3)?;
                    let rule_id: Option<String> = row.get(4)?;

                    Ok(CandidateEntry {
                        path: PathBuf::from(path_str),
                        size_bytes,
                        is_dir: is_dir_int != 0,
                        modified_at,
                        rule_id,
                    })
                })?;

                let mut entries = Vec::new();
                for r in rows {
                    entries.push(r?);
                }
                Ok(entries)
            }
        }
    }
}

impl Drop for CandidateStore {
    fn drop(&mut self) {
        if let StoreBackend::Disk { db_path, .. } = &self.backend {
            let _ = fs::remove_file(db_path);
            let _ = fs::remove_file(db_path.with_extension("db-wal"));
            let _ = fs::remove_file(db_path.with_extension("db-shm"));
        }
    }
}
