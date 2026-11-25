use super::InstalledAppInfo;
use freemydisk_platform::{get_platform, PlatformApplications, RawRunningProcess};
use std::path::{Path, PathBuf};

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

    /// Closes every running process whose executable lives in one of the app's
    /// folders. Apps whose folder cannot be determined are refused rather than
    /// guessed by name, which used to close unrelated processes.
    pub fn terminate_app(app: &InstalledAppInfo) -> Result<usize, String> {
        let dirs = app_folders(app.install_location.as_deref(), app.display_icon.as_deref());
        if dirs.is_empty() {
            return Err(format!(
                "'{}' does not report its install folder, so its processes cannot be identified safely.",
                app.name
            ));
        }

        let procs = get_platform()
            .list_running_processes()
            .map_err(|e| e.to_string())?;
        let mut count = 0;
        for p in procs.iter().filter(|p| runs_from(p, &dirs)) {
            if Self::graceful_terminate(p.pid, &p.name)? {
                count += 1;
            }
        }
        Ok(count)
    }
}

/// Folders an installed app runs from: its install location and the folder of
/// its display icon (usually the main executable). System and shared folders are
/// excluded so they can never match unrelated processes.
pub fn app_folders(install_location: Option<&str>, display_icon: Option<&str>) -> Vec<PathBuf> {
    let icon_dir = display_icon.and_then(|icon| {
        let exe = icon.trim().trim_matches('"');
        let exe = exe
            .split(',')
            .next()
            .unwrap_or(exe)
            .trim()
            .trim_matches('"');
        Path::new(exe).parent().map(Path::to_path_buf)
    });

    let mut dirs: Vec<PathBuf> = install_location
        .map(|l| PathBuf::from(l.trim().trim_matches('"')))
        .into_iter()
        .chain(icon_dir)
        .filter(|d| d.is_absolute() && is_app_specific_folder(d))
        .map(|d| dunce::canonicalize(&d).unwrap_or(d))
        .collect();
    dirs.dedup();
    dirs
}

/// True when `dir` belongs to one app rather than to Windows or to many apps.
fn is_app_specific_folder(dir: &Path) -> bool {
    let norm = |p: &Path| {
        p.to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_ascii_lowercase()
    };
    let candidate = norm(dir);
    if dir.components().count() < 3 {
        return false;
    }
    let shared: Vec<String> = [
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "ProgramData",
        "LOCALAPPDATA",
        "APPDATA",
        "USERPROFILE",
    ]
    .iter()
    .filter_map(|v| std::env::var(v).ok())
    .map(|v| norm(Path::new(&v)))
    .collect();
    if shared.contains(&candidate) {
        return false;
    }
    let windows = std::env::var("SystemRoot")
        .map(|v| norm(Path::new(&v)))
        .unwrap_or_else(|_| r"c:\windows".to_string());
    candidate != windows && !candidate.starts_with(&format!("{}\\", windows))
}

/// True when the process executable lies inside one of `dirs`.
pub fn runs_from(process: &RawRunningProcess, dirs: &[PathBuf]) -> bool {
    // Windows paths are case-insensitive, so compare lowercased strings on a
    // separator boundary.
    process.exe_path.as_deref().is_some_and(|exe| {
        let exe = exe.to_lowercase();
        dirs.iter().any(|d| {
            let dir = d.to_string_lossy().to_lowercase();
            let dir = dir.trim_end_matches(['\\', '/']);
            exe.strip_prefix(dir)
                .is_some_and(|rest| rest.starts_with(['\\', '/']))
        })
    })
}
