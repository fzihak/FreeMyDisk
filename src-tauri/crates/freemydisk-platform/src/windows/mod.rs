pub mod applications;
pub mod maintenance;
pub mod optimization;
pub mod privacy;
pub mod recycle_bin;
pub mod restart_manager;
pub mod startup;
pub mod usn_scan;
pub mod win32_fast_scan;

pub use crate::{io_priority, memory, power, storage_optim};

use crate::traits::{
    EmergencyRescueSummary, ExplorerSettings, FileIdentity, HibernationInfo, MaintenanceTaskKind,
    PagingFileInfo, PendingRebootDeletion, PlatformApplications, PlatformElevation, PlatformError,
    PlatformFilesystem, PlatformIoPriority, PlatformOptimization, PlatformPrivacy,
    PlatformRebootQueue, PlatformStartup, PlatformSystemMaintenance, RawBrowserProfile,
    RawInstalledApp, RawRunningProcess, RawStartupEntry, RawUwpApp, SystemVitals,
};
use fs4::fs_std::FileExt;
use std::fs::OpenOptions;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Storage::FileSystem::{
    GetFileAttributesW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS, FILE_ATTRIBUTE_RECALL_ON_OPEN,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY, HKEY_LOCAL_MACHINE,
    KEY_READ, KEY_SET_VALUE, REG_MULTI_SZ,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, SetPriorityClass, BELOW_NORMAL_PRIORITY_CLASS, IDLE_PRIORITY_CLASS,
    NORMAL_PRIORITY_CLASS,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

pub struct WindowsPlatform;

impl Default for WindowsPlatform {
    fn default() -> Self {
        Self::new()
    }
}

impl WindowsPlatform {
    pub fn new() -> Self {
        Self
    }

    pub fn get_system_vitals(&self) -> Result<SystemVitals, PlatformError> {
        use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

        let mut mem = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            dwMemoryLoad: 0,
            ullTotalPhys: 0,
            ullAvailPhys: 0,
            ullTotalPageFile: 0,
            ullAvailPageFile: 0,
            ullTotalVirtual: 0,
            ullAvailVirtual: 0,
            ullAvailExtendedVirtual: 0,
        };

        unsafe {
            GlobalMemoryStatusEx(&mut mem);
        }

        let total_ram_bytes = mem.ullTotalPhys;
        let available_ram_bytes = mem.ullAvailPhys;
        let used_ram_bytes = total_ram_bytes.saturating_sub(available_ram_bytes);
        let memory_load_percent = mem.dwMemoryLoad;

        // Read real OS name and version from registry dynamically.
        // On Windows 11, Microsoft retains ProductName as "Windows 10 ..." for legacy application compatibility.
        // We dynamically inspect CurrentBuild / CurrentBuildNumber: if build >= 22000, it is genuinely Windows 11.
        let os_name = {
            use winreg::enums::HKEY_LOCAL_MACHINE;
            use winreg::RegKey;
            let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
            if let Ok(key) = hklm.open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion") {
                let raw_name: String = key
                    .get_value("ProductName")
                    .unwrap_or_else(|_| "Windows".to_string());
                let build_str: String = key
                    .get_value("CurrentBuildNumber")
                    .or_else(|_| key.get_value("CurrentBuild"))
                    .unwrap_or_default();
                let build_num: u32 = build_str.parse().unwrap_or(0);
                let display_version: Option<String> = key.get_value("DisplayVersion").ok();

                let mut name = if build_num >= 22000 && raw_name.contains("Windows 10") {
                    raw_name.replace("Windows 10", "Windows 11")
                } else {
                    raw_name
                };

                if let Some(dv) = display_version {
                    if !dv.trim().is_empty() && !name.contains(&dv) {
                        name = format!("{} ({})", name, dv.trim());
                    }
                }
                name
            } else {
                "Windows".to_string()
            }
        };

        let computer_name =
            std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Windows PC".to_string());
        let cpu_cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);

        Ok(SystemVitals {
            total_ram_bytes,
            available_ram_bytes,
            used_ram_bytes,
            memory_load_percent,
            os_name,
            computer_name,
            cpu_cores,
        })
    }
}

impl PlatformFilesystem for WindowsPlatform {
    #[allow(clippy::permissions_set_readonly_false)]
    fn trash_path(&self, path: &Path) -> Result<(), PlatformError> {
        let clean =
            dunce::canonicalize(path).unwrap_or_else(|_| dunce::simplified(path).to_path_buf());
        if let Ok(metadata) = clean.metadata() {
            let mut permissions = metadata.permissions();
            if permissions.readonly() {
                permissions.set_readonly(false);
                let _ = std::fs::set_permissions(&clean, permissions);
            }
        }
        trash::delete(&clean).map_err(|e| {
            PlatformError::TrashUnavailable(format!(
                "Failed to send '{}' to Recycle Bin: {}",
                clean.display(),
                e
            ))
        })
    }

    fn is_cloud_placeholder(&self, path: &Path) -> Result<bool, PlatformError> {
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let attrs = unsafe { GetFileAttributesW(wide.as_ptr()) };
        if attrs == u32::MAX {
            return Ok(false);
        }

        const FILE_ATTRIBUTE_OFFLINE_CONST: u32 = 0x00001000;

        let is_placeholder = (attrs & FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS != 0)
            || (attrs & FILE_ATTRIBUTE_RECALL_ON_OPEN != 0)
            || (attrs & FILE_ATTRIBUTE_OFFLINE_CONST != 0);

        if is_placeholder {
            return Ok(true);
        }

        // Check cloud reparse tags if reparse point
        if (attrs & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            use windows_sys::Win32::Storage::FileSystem::{
                FindClose, FindFirstFileW, WIN32_FIND_DATAW,
            };
            let mut find_data: WIN32_FIND_DATAW = unsafe { std::mem::zeroed() };
            let handle = unsafe { FindFirstFileW(wide.as_ptr(), &mut find_data) };
            if handle != windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
                unsafe { FindClose(handle) };
                let tag = find_data.dwReserved0;
                const IO_REPARSE_TAG_CLOUD: u32 = 0x9000001A;
                const IO_REPARSE_TAG_CLOUD_1: u32 = 0x9000101A;
                const IO_REPARSE_TAG_ONEDRIVE: u32 = 0x80000021;
                const IO_REPARSE_TAG_PROJFS: u32 = 0x9000001C;
                if tag == IO_REPARSE_TAG_CLOUD
                    || tag == IO_REPARSE_TAG_CLOUD_1
                    || tag == IO_REPARSE_TAG_ONEDRIVE
                    || tag == IO_REPARSE_TAG_PROJFS
                {
                    return Ok(true);
                }
            }
        }

        Ok(false)
    }

    fn get_file_identity(&self, path: &Path) -> Result<FileIdentity, PlatformError> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)?;

        let handle = file.as_raw_handle() as HANDLE;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };

        let success = unsafe { GetFileInformationByHandle(handle, &mut info) };
        if success == 0 {
            return Err(PlatformError::Io(std::io::Error::last_os_error()));
        }

        let is_reparse = (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
        let file_index = ((info.nFileIndexHigh as u64) << 32) | (info.nFileIndexLow as u64);

        Ok(FileIdentity {
            device_id: info.dwVolumeSerialNumber as u64,
            file_index,
            link_count: info.nNumberOfLinks,
            is_reparse_or_symlink: is_reparse,
        })
    }

    fn acquire_cross_process_lock(
        &self,
        lock_path: &Path,
    ) -> Result<Box<dyn std::any::Any + Send + Sync>, PlatformError> {
        if let Some(parent) = lock_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)?;

        match file.try_lock_exclusive() {
            Ok(()) => Ok(Box::new(file)),
            Err(_) => Err(PlatformError::LockBusy),
        }
    }

    fn list_volumes(&self) -> Result<Vec<crate::traits::StorageVolumeInfo>, PlatformError> {
        use windows_sys::Win32::Storage::FileSystem::{
            GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW,
        };

        let mut volumes = Vec::new();
        let mask = unsafe { GetLogicalDrives() };
        for i in 0..26 {
            if (mask & (1 << i)) != 0 {
                let drive_letter = (b'A' + i as u8) as char;
                let root_str = format!("{}:\\", drive_letter);
                let wide_root: Vec<u16> =
                    root_str.encode_utf16().chain(std::iter::once(0)).collect();

                let drive_type = unsafe { GetDriveTypeW(wide_root.as_ptr()) };
                let is_removable = drive_type == 2; // DRIVE_REMOVABLE

                let mut free_bytes: u64 = 0;
                let mut total_bytes: u64 = 0;
                let mut total_free: u64 = 0;

                let success = unsafe {
                    GetDiskFreeSpaceExW(
                        wide_root.as_ptr(),
                        &mut free_bytes,
                        &mut total_bytes,
                        &mut total_free,
                    )
                };

                if success != 0 && total_bytes > 0 {
                    let mut vol_name_buf: [u16; 260] = [0; 260];
                    let mut fs_name_buf: [u16; 260] = [0; 260];

                    unsafe {
                        GetVolumeInformationW(
                            wide_root.as_ptr(),
                            vol_name_buf.as_mut_ptr(),
                            vol_name_buf.len() as u32,
                            std::ptr::null_mut(),
                            std::ptr::null_mut(),
                            std::ptr::null_mut(),
                            fs_name_buf.as_mut_ptr(),
                            fs_name_buf.len() as u32,
                        );
                    }

                    let vol_name = String::from_utf16_lossy(&vol_name_buf)
                        .trim_matches(char::from(0))
                        .to_string();
                    let fs_name = String::from_utf16_lossy(&fs_name_buf)
                        .trim_matches(char::from(0))
                        .to_string();

                    volumes.push(crate::traits::StorageVolumeInfo {
                        mount_point: root_str,
                        volume_name: if vol_name.is_empty() {
                            format!("Local Disk ({}:)", drive_letter)
                        } else {
                            vol_name
                        },
                        total_bytes,
                        available_bytes: free_bytes,
                        file_system: if fs_name.is_empty() {
                            "NTFS".to_string()
                        } else {
                            fs_name
                        },
                        is_removable,
                    });
                }
            }
        }

        Ok(volumes)
    }

    fn refresh_shell(&self) -> Result<(), PlatformError> {
        unsafe {
            windows_sys::Win32::UI::Shell::SHChangeNotify(
                windows_sys::Win32::UI::Shell::SHCNE_ASSOCCHANGED as i32,
                windows_sys::Win32::UI::Shell::SHCNF_IDLIST,
                std::ptr::null(),
                std::ptr::null(),
            );
        }
        Ok(())
    }
}

const SESSION_MANAGER_KEY: &[u16] = &[
    'S' as u16,
    'Y' as u16,
    'S' as u16,
    'T' as u16,
    'E' as u16,
    'M' as u16,
    '\\' as u16,
    'C' as u16,
    'u' as u16,
    'r' as u16,
    'r' as u16,
    'e' as u16,
    'n' as u16,
    't' as u16,
    'C' as u16,
    'o' as u16,
    'n' as u16,
    't' as u16,
    'r' as u16,
    'o' as u16,
    'l' as u16,
    'S' as u16,
    'e' as u16,
    't' as u16,
    '\\' as u16,
    'C' as u16,
    'o' as u16,
    'n' as u16,
    't' as u16,
    'r' as u16,
    'o' as u16,
    'l' as u16,
    '\\' as u16,
    'S' as u16,
    'e' as u16,
    's' as u16,
    's' as u16,
    'i' as u16,
    'o' as u16,
    'n' as u16,
    ' ' as u16,
    'M' as u16,
    'a' as u16,
    'n' as u16,
    'a' as u16,
    'g' as u16,
    'e' as u16,
    'r' as u16,
    0,
];

const PENDING_RENAME_VAL: &[u16] = &[
    'P' as u16, 'e' as u16, 'n' as u16, 'd' as u16, 'i' as u16, 'n' as u16, 'g' as u16, 'F' as u16,
    'i' as u16, 'l' as u16, 'e' as u16, 'R' as u16, 'e' as u16, 'n' as u16, 'a' as u16, 'm' as u16,
    'e' as u16, 'O' as u16, 'p' as u16, 'e' as u16, 'r' as u16, 'a' as u16, 't' as u16, 'i' as u16,
    'o' as u16, 'n' as u16, 's' as u16, 0,
];

impl PlatformRebootQueue for WindowsPlatform {
    fn list_pending_deletions(&self) -> Result<Vec<PendingRebootDeletion>, PlatformError> {
        let mut hkey: HKEY = std::ptr::null_mut();
        let status = unsafe {
            RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                SESSION_MANAGER_KEY.as_ptr(),
                0,
                KEY_READ,
                &mut hkey,
            )
        };

        if status != 0 {
            return Ok(Vec::new());
        }

        let mut data_type: u32 = 0;
        let mut data_size: u32 = 0;

        let query_status = unsafe {
            RegQueryValueExW(
                hkey,
                PENDING_RENAME_VAL.as_ptr(),
                std::ptr::null_mut(),
                &mut data_type,
                std::ptr::null_mut(),
                &mut data_size,
            )
        };

        if query_status != 0 || data_type != REG_MULTI_SZ || data_size == 0 {
            unsafe { RegCloseKey(hkey) };
            return Ok(Vec::new());
        }

        let num_u16s = (data_size / 2) as usize;
        let mut buffer: Vec<u16> = vec![0; num_u16s];

        let read_status = unsafe {
            RegQueryValueExW(
                hkey,
                PENDING_RENAME_VAL.as_ptr(),
                std::ptr::null_mut(),
                &mut data_type,
                buffer.as_mut_ptr() as *mut u8,
                &mut data_size,
            )
        };

        unsafe { RegCloseKey(hkey) };

        if read_status != 0 {
            return Ok(Vec::new());
        }

        // Multi-SZ parsing: null-terminated strings ending with double null
        let mut strings = Vec::new();
        let mut current = Vec::new();
        for &val in &buffer {
            if val == 0 {
                if !current.is_empty() {
                    strings.push(String::from_utf16_lossy(&current));
                    current.clear();
                }
            } else {
                current.push(val);
            }
        }

        // In PendingFileRenameOperations, entries come in pairs:
        // [Source Path, Target Path]
        // If Target Path is empty or null, it represents a DELETION on reboot.
        let mut pending = Vec::new();
        let mut i = 0;
        while i < strings.len() {
            let source = &strings[i];
            let target = strings.get(i + 1).map(|s| s.as_str()).unwrap_or("");
            if target.is_empty() {
                let clean_path = source.trim_start_matches(r"\??\");
                let pb = PathBuf::from(clean_path);
                let size = std::fs::metadata(&pb).map(|m| m.len()).ok();
                pending.push(PendingRebootDeletion {
                    path: pb,
                    size_bytes: size,
                    scheduled_at: None,
                    holding_process: None,
                });
            }
            i += 2;
        }

        Ok(pending)
    }

    fn cancel_pending_deletion(&self, path: &Path) -> Result<(), PlatformError> {
        let path_str = path.to_string_lossy();
        let mut hkey: HKEY = std::ptr::null_mut();
        let status = unsafe {
            RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                SESSION_MANAGER_KEY.as_ptr(),
                0,
                KEY_READ | KEY_SET_VALUE,
                &mut hkey,
            )
        };

        if status != 0 {
            return Err(PlatformError::ElevationRequired(
                "Canceling reboot deletion requires administrative permissions to update the registry.".into(),
            ));
        }

        let mut data_type: u32 = 0;
        let mut data_size: u32 = 0;
        let query_status = unsafe {
            RegQueryValueExW(
                hkey,
                PENDING_RENAME_VAL.as_ptr(),
                std::ptr::null_mut(),
                &mut data_type,
                std::ptr::null_mut(),
                &mut data_size,
            )
        };

        if query_status != 0 || data_size == 0 {
            unsafe { RegCloseKey(hkey) };
            return Ok(());
        }

        let num_u16s = (data_size / 2) as usize;
        let mut buffer: Vec<u16> = vec![0; num_u16s];
        unsafe {
            RegQueryValueExW(
                hkey,
                PENDING_RENAME_VAL.as_ptr(),
                std::ptr::null_mut(),
                &mut data_type,
                buffer.as_mut_ptr() as *mut u8,
                &mut data_size,
            );
        };

        let mut strings = Vec::new();
        let mut current = Vec::new();
        for &val in &buffer {
            if val == 0 {
                if !current.is_empty() {
                    strings.push(String::from_utf16_lossy(&current));
                    current.clear();
                }
            } else {
                current.push(val);
            }
        }

        let mut new_strings = Vec::new();
        let mut i = 0;
        while i < strings.len() {
            let src = &strings[i];
            let tgt = strings.get(i + 1).map(|s| s.as_str()).unwrap_or("");
            let clean_src = src.trim_start_matches(r"\??\");
            if !clean_src.eq_ignore_ascii_case(&path_str) {
                new_strings.push(src.clone());
                new_strings.push(tgt.to_string());
            }
            i += 2;
        }

        let mut new_buffer: Vec<u16> = Vec::new();
        for s in new_strings {
            new_buffer.extend(s.encode_utf16());
            new_buffer.push(0);
        }
        new_buffer.push(0); // Final double null terminator

        let write_status = unsafe {
            RegSetValueExW(
                hkey,
                PENDING_RENAME_VAL.as_ptr(),
                0,
                REG_MULTI_SZ,
                new_buffer.as_ptr() as *const u8,
                (new_buffer.len() * 2) as u32,
            )
        };

        unsafe { RegCloseKey(hkey) };

        if write_status != 0 {
            return Err(PlatformError::OperationFailed(format!(
                "RegSetValueExW failed with code {}",
                write_status
            )));
        }

        Ok(())
    }
}

pub fn is_elevated_windows() -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token_handle: windows_sys::Win32::Foundation::HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token_handle) == 0 {
            return false;
        }

        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut return_length: u32 = 0;
        let result = GetTokenInformation(
            token_handle,
            TokenElevation,
            &mut elevation as *mut TOKEN_ELEVATION as *mut std::ffi::c_void,
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut return_length,
        );

        CloseHandle(token_handle);

        result != 0 && elevation.TokenIsElevated != 0
    }
}

impl PlatformElevation for WindowsPlatform {
    fn is_elevated(&self) -> bool {
        is_elevated_windows()
    }
}

impl PlatformIoPriority for WindowsPlatform {
    fn set_background_idle_priority(&self) -> Result<(), PlatformError> {
        let handle = unsafe { GetCurrentProcess() };
        let success = unsafe { SetPriorityClass(handle, IDLE_PRIORITY_CLASS) };
        if success == 0 {
            return Err(PlatformError::Io(std::io::Error::last_os_error()));
        }
        Ok(())
    }

    fn set_below_normal_priority(&self) -> Result<(), PlatformError> {
        let handle = unsafe { GetCurrentProcess() };
        let success = unsafe { SetPriorityClass(handle, BELOW_NORMAL_PRIORITY_CLASS) };
        if success == 0 {
            return Err(PlatformError::Io(std::io::Error::last_os_error()));
        }
        Ok(())
    }

    fn set_normal_priority(&self) -> Result<(), PlatformError> {
        let handle = unsafe { GetCurrentProcess() };
        let success = unsafe { SetPriorityClass(handle, NORMAL_PRIORITY_CLASS) };
        if success == 0 {
            return Err(PlatformError::Io(std::io::Error::last_os_error()));
        }
        Ok(())
    }

    fn seconds_since_last_input(&self) -> Result<u64, PlatformError> {
        let mut lii: LASTINPUTINFO = unsafe { std::mem::zeroed() };
        lii.cbSize = std::mem::size_of::<LASTINPUTINFO>() as u32;

        let success = unsafe { GetLastInputInfo(&mut lii) };
        if success == 0 {
            return Err(PlatformError::Io(std::io::Error::last_os_error()));
        }

        let tick = unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount() };
        let elapsed_ms = tick.saturating_sub(lii.dwTime);
        Ok((elapsed_ms / 1000) as u64)
    }
}

impl PlatformStartup for WindowsPlatform {
    fn list_startup_entries(&self) -> Result<Vec<RawStartupEntry>, PlatformError> {
        startup::WindowsStartupHandler::new().list_startup_entries()
    }

    fn set_startup_entry_state(&self, entry_id: &str, enable: bool) -> Result<(), PlatformError> {
        startup::WindowsStartupHandler::new().set_startup_entry_state(entry_id, enable)
    }

    fn delete_startup_entry(&self, entry_id: &str) -> Result<(), PlatformError> {
        startup::WindowsStartupHandler::new().delete_startup_entry(entry_id)
    }
}

impl PlatformApplications for WindowsPlatform {
    fn list_installed_apps(&self) -> Result<Vec<RawInstalledApp>, PlatformError> {
        applications::WindowsApplicationsHandler::new().list_installed_apps()
    }

    fn list_running_processes(&self) -> Result<Vec<RawRunningProcess>, PlatformError> {
        applications::WindowsApplicationsHandler::new().list_running_processes()
    }

    fn terminate_process(&self, pid: u32) -> Result<(), PlatformError> {
        applications::WindowsApplicationsHandler::new().terminate_process(pid)
    }

    fn launch_uninstaller(&self, uninstall_string: &str) -> Result<(), PlatformError> {
        applications::WindowsApplicationsHandler::new().launch_uninstaller(uninstall_string)
    }

    fn list_uwp_apps(&self) -> Result<Vec<RawUwpApp>, PlatformError> {
        applications::WindowsApplicationsHandler::new().list_uwp_apps()
    }

    fn uninstall_uwp_app(&self, package_full_name: &str) -> Result<(), PlatformError> {
        applications::WindowsApplicationsHandler::new().uninstall_uwp_app(package_full_name)
    }
}

impl PlatformSystemMaintenance for WindowsPlatform {
    fn execute_maintenance_task(&self, task: MaintenanceTaskKind) -> Result<String, PlatformError> {
        maintenance::WindowsSystemMaintenanceHandler::new().execute_maintenance_task(task)
    }

    fn execute_emergency_rescue(&self) -> Result<EmergencyRescueSummary, PlatformError> {
        maintenance::WindowsSystemMaintenanceHandler::new().execute_emergency_rescue()
    }
}

impl PlatformPrivacy for WindowsPlatform {
    fn list_browser_profiles(&self) -> Result<Vec<RawBrowserProfile>, PlatformError> {
        privacy::WindowsPrivacyHandler::new().list_browser_profiles()
    }

    fn clean_system_activity_traces(&self) -> Result<u64, PlatformError> {
        privacy::WindowsPrivacyHandler::new().clean_system_activity_traces()
    }
}

impl PlatformOptimization for WindowsPlatform {
    fn get_hibernation_status(&self) -> Result<HibernationInfo, PlatformError> {
        optimization::WindowsOptimizationHandler::new().get_hibernation_status()
    }

    fn set_hibernation_state(&self, enable: bool) -> Result<(), PlatformError> {
        optimization::WindowsOptimizationHandler::new().set_hibernation_state(enable)
    }

    fn get_storage_sense_status(&self) -> Result<bool, PlatformError> {
        optimization::WindowsOptimizationHandler::new().get_storage_sense_status()
    }

    fn set_storage_sense_state(&self, enable: bool) -> Result<(), PlatformError> {
        optimization::WindowsOptimizationHandler::new().set_storage_sense_state(enable)
    }

    fn clean_delivery_optimization_cache(&self) -> Result<u64, PlatformError> {
        optimization::WindowsOptimizationHandler::new().clean_delivery_optimization_cache()
    }

    fn get_paging_file_info(&self) -> Result<PagingFileInfo, PlatformError> {
        optimization::WindowsOptimizationHandler::new().get_paging_file_info()
    }

    fn get_explorer_settings(&self) -> Result<ExplorerSettings, PlatformError> {
        optimization::WindowsOptimizationHandler::new().get_explorer_settings()
    }

    fn set_explorer_setting(&self, setting_key: &str, enable: bool) -> Result<(), PlatformError> {
        optimization::WindowsOptimizationHandler::new().set_explorer_setting(setting_key, enable)
    }

    fn trim_process_working_set(&self) -> Result<(), PlatformError> {
        optimization::WindowsOptimizationHandler::new().trim_process_working_set()
    }
}

use std::os::windows::ffi::OsStrExt;
