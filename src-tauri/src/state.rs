//! Process-wide state shared by IPC commands.

use freemydisk_core::filesystem::journal::CrashRecoveryJournal;

/// The single crash-recovery journal connection for this process.
/// `Err` holds the reason the journal could not be opened at startup.
pub struct JournalState(pub Result<CrashRecoveryJournal, String>);
