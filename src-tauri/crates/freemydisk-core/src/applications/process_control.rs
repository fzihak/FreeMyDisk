use freemydisk_platform::{get_platform, PlatformApplications, RawRunningProcess};
use std::path::Path;

pub struct ProcessController;

impl ProcessController {
    /// Graceful termination: sends WM_CLOSE to windowed processes, waits up to 3 seconds,
    /// and falls back to TerminateProcess / taskkill tree termination if the process does not exit.
    pub fn graceful_terminate(pid: u32, process_name: &str) -> Result<bool, String> {
        #[cfg(target_os = "windows")]
        {
            Self::graceful_terminate_windows(pid, process_name)
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (pid, process_name);
            Ok(true)
        }
    }

    /// Terminates a process cleanly by PID using graceful shutdown falling back to process tree termination.
    pub fn terminate_by_pid(pid: u32) -> Result<bool, String> {
        Self::graceful_terminate(pid, "process")
    }

    #[cfg(target_os = "windows")]
    fn graceful_terminate_windows(pid: u32, _process_name: &str) -> Result<bool, String> {
        use std::os::windows::process::CommandExt;
        use std::time::{Duration, Instant};
        use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            EnumWindows, GetWindowThreadProcessId, PostMessageW, WM_CLOSE,
        };

        const CREATE_NO_WINDOW: u32 = 0x08000000;

        // Callback context to collect HWNDs owned by the PID
        struct EnumData {
            target_pid: u32,
            hwnds: Vec<HWND>,
        }

        unsafe extern "system" fn enum_window_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let data = &mut *(lparam as *mut EnumData);
            let mut proc_id = 0u32;
            GetWindowThreadProcessId(hwnd, &mut proc_id);
            if proc_id == data.target_pid {
                data.hwnds.push(hwnd);
            }
            1 // continue enumeration
        }

        let mut data = EnumData {
            target_pid: pid,
            hwnds: Vec::new(),
        };

        unsafe {
            EnumWindows(
                Some(enum_window_callback),
                &mut data as *mut EnumData as LPARAM,
            );
        }

        // Send WM_CLOSE to all top-level windows of this process
        for hwnd in data.hwnds {
            unsafe {
                PostMessageW(hwnd, WM_CLOSE, 0, 0);
            }
        }

        // Wait up to 3 seconds for graceful exit
        let deadline = Instant::now() + Duration::from_millis(3000);
        while Instant::now() < deadline {
            if !Self::is_process_alive(pid) {
                return Ok(true);
            }
            std::thread::sleep(Duration::from_millis(150));
        }

        // If still running, forcefully terminate process and all child processes
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        // Final check
        std::thread::sleep(Duration::from_millis(100));
        Ok(!Self::is_process_alive(pid))
    }

    /// Checks if a PID is currently running
    pub fn is_process_alive(pid: u32) -> bool {
        #[cfg(target_os = "windows")]
        {
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            };

            const STILL_ACTIVE: u32 = 259;

            unsafe {
                let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if handle.is_null() {
                    return false;
                }
                let mut exit_code = 0u32;
                let ok = GetExitCodeProcess(handle, &mut exit_code);
                CloseHandle(handle);
                ok != 0 && exit_code == STILL_ACTIVE
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = pid;
            false
        }
    }

    /// Checks if any running process has its executable located inside the given directory
    pub fn find_locking_processes(dir: &Path) -> Vec<RawRunningProcess> {
        let platform = get_platform();
        let procs = platform.list_running_processes().unwrap_or_default();
        let dir_str = dir.to_string_lossy().to_lowercase();

        procs
            .into_iter()
            .filter(|p| {
                if let Some(ref exe) = p.exe_path {
                    exe.to_lowercase().starts_with(&dir_str)
                } else {
                    false
                }
            })
            .collect()
    }

    /// Waits for a process with the given PID to exit up to timeout_ms
    pub fn wait_for_exit(pid: u32, timeout_ms: u32) -> bool {
        let deadline =
            std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms as u64);
        while std::time::Instant::now() < deadline {
            if !Self::is_process_alive(pid) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
        !Self::is_process_alive(pid)
    }

    /// Identifies and terminates all running processes matching the application name
    pub fn terminate_app_processes(app_name: &str) -> Result<usize, String> {
        let platform = get_platform();
        let procs = platform
            .list_running_processes()
            .map_err(|e| e.to_string())?;

        let app_lower = app_name.to_lowercase();
        let app_clean = app_lower.replace(['-', '_', ' ', '.'], "");
        let mut count = 0;

        for p in procs {
            let proc_lower = p.name.to_lowercase();
            let proc_clean = proc_lower
                .trim_end_matches(".exe")
                .replace(['-', '_', ' ', '.'], "");

            let matches = proc_clean == app_clean
                || (app_clean.len() >= 4 && proc_clean.contains(&app_clean))
                || (proc_clean.len() >= 4 && app_clean.contains(&proc_clean));

            if matches && Self::graceful_terminate(p.pid, &p.name)? {
                count += 1;
            }
        }

        Ok(count)
    }
}
