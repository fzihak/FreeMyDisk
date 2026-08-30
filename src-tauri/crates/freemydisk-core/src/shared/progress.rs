use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub fn reset(&self) {
        self.cancelled.store(false, Ordering::SeqCst);
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TraversalProgress {
    pub directories_scanned: u64,
    pub files_found: u64,
    pub total_bytes: u64,
    pub current_path: String,
    pub errors_encountered: u64,
    pub placeholders_skipped: u64,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ScanProgress {
    pub phase: String,
    pub files_processed: u64,
    pub files_total: u64,
    pub bytes_processed: u64,
    pub current_file: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppScanProgress {
    pub scan_type: String,
    pub stage: String,
    pub percent: u8,
    pub items_scanned: u64,
    pub current_path: String,
    pub bytes_found: u64,
    pub is_complete: bool,
}
