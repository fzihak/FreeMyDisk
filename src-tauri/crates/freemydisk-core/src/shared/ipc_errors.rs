use crate::shared::errors::CoreError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcError {
    pub code: String,
    pub message: String,
    pub path: Option<String>,
    pub recoverable: bool,
}

impl IpcError {
    pub fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        path: Option<String>,
        recoverable: bool,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            path,
            recoverable,
        }
    }
}

impl From<CoreError> for IpcError {
    fn from(err: CoreError) -> Self {
        match &err {
            CoreError::ProtectedPath(p) => Self::new(
                "PROTECTED_PATH",
                err.to_string(),
                Some(p.to_string_lossy().to_string()),
                false,
            ),
            CoreError::SelfPreservationViolation(p) => Self::new(
                "SELF_PRESERVATION",
                err.to_string(),
                Some(p.to_string_lossy().to_string()),
                false,
            ),
            CoreError::ReparsePointViolation(p) => Self::new(
                "REPARSE_POINT_VIOLATION",
                err.to_string(),
                Some(p.to_string_lossy().to_string()),
                false,
            ),
            CoreError::DiskSpaceExhaustionGuard { .. } => {
                Self::new("DISK_SPACE_EXHAUSTION", err.to_string(), None, true)
            }
            CoreError::LockBusy => Self::new("LOCK_BUSY", err.to_string(), None, true),
            CoreError::Cancelled => Self::new("CANCELLED", err.to_string(), None, true),
            CoreError::TrashUnavailable(p) => Self::new(
                "TRASH_UNAVAILABLE",
                err.to_string(),
                Some(p.to_string_lossy().to_string()),
                true,
            ),
            CoreError::Io { path, .. } => Self::new(
                "IO_ERROR",
                err.to_string(),
                Some(path.to_string_lossy().to_string()),
                true,
            ),
            CoreError::StdIo(e) => Self::new("IO_ERROR", e.to_string(), None, true),
            CoreError::Database(e) => Self::new("DATABASE_ERROR", e.to_string(), None, false),
            CoreError::RuleValidation(msg) => {
                Self::new("RULE_VALIDATION_ERROR", msg.clone(), None, false)
            }
            _ => Self::new("INTERNAL_ERROR", err.to_string(), None, false),
        }
    }
}

impl From<String> for IpcError {
    fn from(msg: String) -> Self {
        Self::new("GENERIC_ERROR", msg, None, true)
    }
}

impl From<&str> for IpcError {
    fn from(msg: &str) -> Self {
        Self::new("GENERIC_ERROR", msg, None, true)
    }
}

impl From<freemydisk_platform::traits::PlatformError> for IpcError {
    fn from(err: freemydisk_platform::traits::PlatformError) -> Self {
        match &err {
            freemydisk_platform::traits::PlatformError::LockBusy => {
                Self::new("LOCK_BUSY", err.to_string(), None, true)
            }
            freemydisk_platform::traits::PlatformError::ElevationRequired(msg) => {
                Self::new("ELEVATION_REQUIRED", msg.clone(), None, true)
            }
            freemydisk_platform::traits::PlatformError::PermissionDenied(msg) => {
                Self::new("PERMISSION_DENIED", msg.clone(), None, false)
            }
            freemydisk_platform::traits::PlatformError::TrashUnavailable(msg) => {
                Self::new("TRASH_UNAVAILABLE", msg.clone(), None, true)
            }
            freemydisk_platform::traits::PlatformError::Io(e) => {
                Self::new("IO_ERROR", e.to_string(), None, true)
            }
            freemydisk_platform::traits::PlatformError::OperationFailed(msg) => {
                Self::new("OPERATION_FAILED", msg.clone(), None, false)
            }
            freemydisk_platform::traits::PlatformError::Unsupported(msg) => {
                Self::new("UNSUPPORTED", msg.clone(), None, false)
            }
        }
    }
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}]: {}", self.code, self.message)
    }
}

impl std::error::Error for IpcError {}
