//! Process-wide state shared by IPC commands.

use freemydisk_core::cleanup::rule_engine::RuleScanCandidate;
use freemydisk_core::filesystem::journal::CrashRecoveryJournal;
use freemydisk_core::shared::progress::CancellationToken;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The single crash-recovery journal connection for this process.
/// `Err` holds the reason the journal could not be opened at startup.
pub struct JournalState(pub Result<CrashRecoveryJournal, String>);

/// Journal used by the panic hook, set once the app has resolved its data folder.
pub static PANIC_JOURNAL: OnceLock<CrashRecoveryJournal> = OnceLock::new();

/// Tracks running scans and disposals so each can be cancelled on its own,
/// and so shutdown can wait for them to stop.
#[derive(Default, Clone)]
pub struct OperationRegistry {
    next_id: Arc<AtomicU64>,
    running: Arc<Mutex<HashMap<u64, (String, CancellationToken)>>>,
}

impl OperationRegistry {
    /// Registers an operation of the given kind. It stays registered until the
    /// returned guard is dropped.
    pub fn begin(&self, kind: &str) -> OperationGuard {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let token = CancellationToken::new();
        lock(&self.running).insert(id, (kind.to_string(), token.clone()));
        OperationGuard {
            registry: self.clone(),
            id,
            token,
        }
    }

    /// Cancels running operations of `kind`, or all of them when `kind` is `None`.
    /// Returns how many were signalled.
    pub fn cancel(&self, kind: Option<&str>) -> usize {
        let running = lock(&self.running);
        let mut count = 0;
        for (op_kind, token) in running.values() {
            if kind.is_none_or(|k| k == op_kind) {
                token.cancel();
                count += 1;
            }
        }
        count
    }

    pub fn active_count(&self) -> usize {
        lock(&self.running).len()
    }
}

pub struct OperationGuard {
    registry: OperationRegistry,
    id: u64,
    token: CancellationToken,
}

impl OperationGuard {
    pub fn token(&self) -> CancellationToken {
        self.token.clone()
    }
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        lock(&self.registry.running).remove(&self.id);
    }
}

/// Items found by the last cleanup scan, per rule. Cleanup only disposes of
/// these, so files created after the scan, or never shown to the user, are left alone.
#[derive(Default, Clone)]
pub struct RuleScanCache(Arc<Mutex<HashMap<String, Vec<RuleScanCandidate>>>>);

impl RuleScanCache {
    pub fn replace(&self, entries: HashMap<String, Vec<RuleScanCandidate>>) {
        *lock(&self.0) = entries;
    }

    /// Takes the cached candidates for `rule_ids`. Returns the ids that have no
    /// cached scan as the error.
    pub fn take(&self, rule_ids: &[String]) -> Result<Vec<RuleScanCandidate>, Vec<String>> {
        let mut cache = lock(&self.0);
        let missing: Vec<String> = rule_ids
            .iter()
            .filter(|id| !cache.contains_key(id.as_str()))
            .cloned()
            .collect();
        if !missing.is_empty() {
            return Err(missing);
        }
        Ok(rule_ids
            .iter()
            .filter_map(|id| cache.remove(id))
            .flatten()
            .collect())
    }

    pub fn peek(&self, rule_ids: &[String]) -> Vec<RuleScanCandidate> {
        let cache = lock(&self.0);
        rule_ids
            .iter()
            .filter_map(|id| cache.get(id))
            .flatten()
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelling_one_kind_leaves_others_running() {
        let ops = OperationRegistry::default();
        let scan = ops.begin("duplicates");
        let disposal = ops.begin("disposal");
        assert_eq!(ops.cancel(Some("duplicates")), 1);
        assert!(scan.token().is_cancelled());
        assert!(!disposal.token().is_cancelled());
    }

    #[test]
    fn a_finished_operation_does_not_unregister_a_newer_one() {
        let ops = OperationRegistry::default();
        let first = ops.begin("storage");
        let second = ops.begin("storage");
        drop(first);
        assert_eq!(ops.active_count(), 1);
        assert_eq!(ops.cancel(Some("storage")), 1);
        assert!(second.token().is_cancelled());
    }

    #[test]
    fn scan_cache_refuses_rules_without_a_current_scan() {
        let cache = RuleScanCache::default();
        cache.replace(HashMap::from([("chrome".to_string(), Vec::new())]));
        assert_eq!(
            cache.take(&["chrome".to_string(), "edge".to_string()]),
            Err(vec!["edge".to_string()])
        );
        assert!(cache.take(&["chrome".to_string()]).is_ok());
        assert!(
            cache.take(&["chrome".to_string()]).is_err(),
            "results are used once"
        );
    }
}
