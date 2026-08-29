use freemydisk_platform::traits::PlatformError;
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("I/O error at '{path}': {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },

    #[error("Standard I/O error: {0}")]
    StdIo(#[from] std::io::Error),

    #[error("Platform error: {0}")]
    Platform(#[from] PlatformError),

    #[error("Safety violation: path '{0}' is a protected system path and cannot be modified")]
    ProtectedPath(PathBuf),

    #[error(
        "Safety violation: path '{0}' is an active component of FreeMyDisk and cannot be modified"
    )]
    SelfPreservationViolation(PathBuf),

    #[error("Critical disk space exhaustion: available {available_bytes} bytes is below required safe margin {required_bytes} bytes")]
    DiskSpaceExhaustionGuard {
        available_bytes: u64,
        required_bytes: u64,
    },

    #[error("Reparse point traversal violation: refusing recursive traversal of '{0}'")]
    ReparsePointViolation(PathBuf),

    #[error("Safety violation: path '{0}' is outside permitted traversal scope")]
    ScopeViolation(PathBuf),

    #[error("Trash unavailable for '{0}': permanent delete strictly refused")]
    TrashUnavailable(PathBuf),

    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("JSON serialization error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Operation cancelled by user")]
    Cancelled,

    #[error("TOML rule validation failed: {0}")]
    RuleValidation(String),

    #[error("Cleanup lock busy: another cleanup process is running")]
    LockBusy,

    #[error("Virtualization error: {0}")]
    Virtualization(String),

    #[error("Validation failed: {0}")]
    Validation(String),

    #[error("Target not found: {0}")]
    NotFound(String),
}
