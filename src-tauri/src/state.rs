//! Process-wide state shared by IPC commands.

use freemydisk_core::filesystem::journal::CrashRecoveryJournal;
use std::sync::OnceLock;

/// The single crash-recovery journal connection for this process.
/// `Err` holds the reason the journal could not be opened at startup.
pub struct JournalState(pub Result<CrashRecoveryJournal, String>);

/// Journal used by the panic hook, set once the app has resolved its data folder.
pub static PANIC_JOURNAL: OnceLock<CrashRecoveryJournal> = OnceLock::new();
