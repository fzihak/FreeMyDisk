/// Trims the process working set, flushing unused/inactive physical pages back to the Windows kernel.
/// This achieves the < 60 MB idle RAM footprint target for FreeMyDisk.
#[cfg(target_os = "windows")]
pub fn trim_working_set() -> bool {
    use windows_sys::Win32::System::ProcessStatus::EmptyWorkingSet;
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    unsafe {
        let handle = GetCurrentProcess();
        EmptyWorkingSet(handle) != 0
    }
}

#[cfg(not(target_os = "windows"))]
pub fn trim_working_set() -> bool {
    false
}
