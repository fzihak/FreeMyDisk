use crate::traits::{PlatformError, RawRunningProcess};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows_sys::Win32::Foundation::ERROR_MORE_DATA;
use windows_sys::Win32::System::RestartManager::{
    RmEndSession, RmGetList, RmRegisterResources, RmStartSession, CCH_RM_SESSION_KEY,
    RM_PROCESS_INFO,
};

pub struct RestartManagerHelper;

impl RestartManagerHelper {
    /// Queries the Windows Restart Manager API to identify which running processes
    /// currently hold active locks or open handles on the given file or directory.
    pub fn get_locking_processes(path: &Path) -> Result<Vec<RawRunningProcess>, PlatformError> {
        let mut session_handle: u32 = 0;
        let mut session_key = [0u16; CCH_RM_SESSION_KEY as usize + 1];

        let start_res = unsafe { RmStartSession(&mut session_handle, 0, session_key.as_mut_ptr()) };

        if start_res != 0 {
            return Err(PlatformError::OperationFailed(format!(
                "RmStartSession failed with error code: {}",
                start_res
            )));
        }

        let wide_path: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let file_paths = [wide_path.as_ptr()];

        let reg_res = unsafe {
            RmRegisterResources(
                session_handle,
                1,
                file_paths.as_ptr(),
                0,
                std::ptr::null(),
                0,
                std::ptr::null(),
            )
        };

        if reg_res != 0 {
            unsafe { RmEndSession(session_handle) };
            return Err(PlatformError::OperationFailed(format!(
                "RmRegisterResources failed with error code: {}",
                reg_res
            )));
        }

        let mut n_proc_info_needed: u32 = 0;
        let mut n_proc_info: u32 = 0;
        let mut reboot_reasons: u32 = 0;

        // First call to determine size
        let get_res = unsafe {
            RmGetList(
                session_handle,
                &mut n_proc_info_needed,
                &mut n_proc_info,
                std::ptr::null_mut(),
                &mut reboot_reasons,
            )
        };

        if get_res != ERROR_MORE_DATA && get_res != 0 {
            unsafe { RmEndSession(session_handle) };
            return Ok(Vec::new());
        }

        if n_proc_info_needed == 0 {
            unsafe { RmEndSession(session_handle) };
            return Ok(Vec::new());
        }

        let mut proc_info: Vec<RM_PROCESS_INFO> =
            vec![unsafe { std::mem::zeroed() }; n_proc_info_needed as usize];
        n_proc_info = n_proc_info_needed;

        let get_res = unsafe {
            RmGetList(
                session_handle,
                &mut n_proc_info_needed,
                &mut n_proc_info,
                proc_info.as_mut_ptr(),
                &mut reboot_reasons,
            )
        };

        unsafe { RmEndSession(session_handle) };

        if get_res != 0 {
            return Ok(Vec::new());
        }

        let mut results = Vec::new();
        for info in &proc_info[..n_proc_info as usize] {
            let pid = info.Process.dwProcessId;
            let name_len = info
                .strAppName
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(info.strAppName.len());
            let app_name = String::from_utf16_lossy(&info.strAppName[..name_len]);

            results.push(RawRunningProcess {
                pid,
                name: if app_name.is_empty() {
                    format!("PID-{}", pid)
                } else {
                    app_name
                },
                exe_path: None,
            });
        }

        Ok(results)
    }
}
