use crate::traits::{PlatformError, PlatformStartup, RawStartupEntry};
use std::path::PathBuf;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE};
use winreg::RegKey;

pub struct WindowsStartupHandler;

impl WindowsStartupHandler {
    pub fn new() -> Self {
        Self
    }
}

impl Default for WindowsStartupHandler {
    fn default() -> Self {
        Self::new()
    }
}

fn extract_target_path(command: &str) -> Option<String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some(rest) = trimmed.strip_prefix('"') {
        if let Some(end) = rest.find('"') {
            return Some(rest[..end].to_string());
        }
    }

    if let Some(space_idx) = trimmed.find(' ') {
        Some(trimmed[..space_idx].to_string())
    } else {
        Some(trimmed.to_string())
    }
}

fn get_user_startup_dir() -> Option<PathBuf> {
    std::env::var("APPDATA").ok().map(|appdata| {
        PathBuf::from(appdata).join(r"Microsoft\Windows\Start Menu\Programs\Startup")
    })
}

impl PlatformStartup for WindowsStartupHandler {
    fn list_startup_entries(&self) -> Result<Vec<RawStartupEntry>, PlatformError> {
        let mut entries = Vec::new();

        // 1. HKCU\Software\Microsoft\Windows\CurrentVersion\Run
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(run_key) =
            hkcu.open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Run", KEY_READ)
        {
            for val in run_key.enum_values().flatten() {
                let (name, val_data) = val;
                let command = val_data.to_string();
                let target_path = extract_target_path(&command);
                entries.push(RawStartupEntry {
                    id: format!("hkcu:run:{}", name),
                    name: name.clone(),
                    command,
                    location: r"HKCU\Run".to_string(),
                    enabled: true,
                    target_path,
                });
            }
        }

        // 2. HKLM\Software\Microsoft\Windows\CurrentVersion\Run
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        if let Ok(run_key) =
            hklm.open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Run", KEY_READ)
        {
            for val in run_key.enum_values().flatten() {
                let (name, val_data) = val;
                let command = val_data.to_string();
                let target_path = extract_target_path(&command);
                entries.push(RawStartupEntry {
                    id: format!("hklm:run:{}", name),
                    name: name.clone(),
                    command,
                    location: r"HKLM\Run".to_string(),
                    enabled: true,
                    target_path,
                });
            }
        }

        // 3. HKCU\Software\FreeMyDisk\DisabledStartup
        if let Ok(disabled_key) =
            hkcu.open_subkey_with_flags(r"Software\FreeMyDisk\DisabledStartup", KEY_READ)
        {
            for val in disabled_key.enum_values().flatten() {
                let (id, val_data) = val;
                let parts_str = val_data.to_string();
                let mut parts = parts_str.splitn(2, "||");
                let orig_loc = parts.next().unwrap_or(r"HKCU\Run");
                let command = parts.next().unwrap_or("");
                let name = id.split(':').next_back().unwrap_or(&id).to_string();
                let target_path = extract_target_path(command);
                entries.push(RawStartupEntry {
                    id: id.clone(),
                    name,
                    command: command.to_string(),
                    location: format!("{} (Disabled)", orig_loc),
                    enabled: false,
                    target_path,
                });
            }
        }

        // 4. User Startup Folder
        if let Some(user_startup) = get_user_startup_dir() {
            if user_startup.exists() {
                if let Ok(dir) = std::fs::read_dir(&user_startup) {
                    for entry in dir.flatten() {
                        let path = entry.path();
                        let fname = entry.file_name().to_string_lossy().to_string();
                        if fname.ends_with(".lnk") {
                            let name = fname.trim_end_matches(".lnk").to_string();
                            entries.push(RawStartupEntry {
                                id: format!("folder:user:{}", fname),
                                name,
                                command: path.to_string_lossy().to_string(),
                                location: "User Startup Folder".to_string(),
                                enabled: true,
                                target_path: Some(path.to_string_lossy().to_string()),
                            });
                        } else if fname.ends_with(".lnk.disabled") {
                            let name = fname.trim_end_matches(".lnk.disabled").to_string();
                            entries.push(RawStartupEntry {
                                id: format!("folder:user:{}", fname),
                                name,
                                command: path.to_string_lossy().to_string(),
                                location: "User Startup Folder (Disabled)".to_string(),
                                enabled: false,
                                target_path: Some(path.to_string_lossy().to_string()),
                            });
                        }
                    }
                }
            }
        }

        Ok(entries)
    }

    fn set_startup_entry_state(&self, entry_id: &str, enable: bool) -> Result<(), PlatformError> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        if let Some(name) = entry_id.strip_prefix("hkcu:run:") {
            if enable {
                // Read from DisabledStartup and restore to Run
                if let Ok(disabled_key) = hkcu.open_subkey_with_flags(
                    r"Software\FreeMyDisk\DisabledStartup",
                    KEY_READ | KEY_SET_VALUE,
                ) {
                    if let Ok(raw_val) = disabled_key.get_value::<String, _>(entry_id) {
                        let command = raw_val.split_once("||").map(|x| x.1).unwrap_or(&raw_val);
                        if let Ok((run_key, _)) =
                            hkcu.create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run")
                        {
                            let _ = run_key.set_value(name, &command);
                            let _ = disabled_key.delete_value(entry_id);
                        }
                    }
                }
            } else {
                // Read from Run, store in DisabledStartup, and remove from Run
                if let Ok(run_key) = hkcu.open_subkey_with_flags(
                    r"Software\Microsoft\Windows\CurrentVersion\Run",
                    KEY_READ | KEY_SET_VALUE,
                ) {
                    if let Ok(command) = run_key.get_value::<String, _>(name) {
                        if let Ok((disabled_key, _)) =
                            hkcu.create_subkey(r"Software\FreeMyDisk\DisabledStartup")
                        {
                            let payload = format!(r"HKCU\Run||{}", command);
                            let _ = disabled_key.set_value(entry_id, &payload);
                            let _ = run_key.delete_value(name);
                        }
                    }
                }
            }
        } else if let Some(name) = entry_id.strip_prefix("hklm:run:") {
            let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
            if !crate::windows::is_elevated_windows() {
                return Err(PlatformError::ElevationRequired(
                    "Administrator privileges are required to modify system-wide (HKLM) startup entries. Please run FreeMyDisk as Administrator.".to_string(),
                ));
            }
            if enable {
                let disabled_key = hkcu
                    .open_subkey_with_flags(
                        r"Software\FreeMyDisk\DisabledStartup",
                        KEY_READ | KEY_SET_VALUE,
                    )
                    .map_err(|e| {
                        PlatformError::OperationFailed(format!(
                            "Failed to open backup registry key: {}",
                            e
                        ))
                    })?;
                let raw_val = disabled_key.get_value::<String, _>(entry_id).map_err(|e| {
                    PlatformError::OperationFailed(format!(
                        "Failed to read disabled startup entry: {}",
                        e
                    ))
                })?;
                let command = raw_val.split_once("||").map(|x| x.1).unwrap_or(&raw_val);
                let run_key = hklm
                    .open_subkey_with_flags(
                        r"Software\Microsoft\Windows\CurrentVersion\Run",
                        KEY_SET_VALUE,
                    )
                    .map_err(|e| {
                        PlatformError::OperationFailed(format!(
                            "Failed to open HKLM Run key: {}",
                            e
                        ))
                    })?;
                run_key.set_value(name, &command).map_err(|e| {
                    PlatformError::OperationFailed(format!(
                        "Failed to restore HKLM Run value: {}",
                        e
                    ))
                })?;
                let _ = disabled_key.delete_value(entry_id);
            } else {
                let run_key = hklm
                    .open_subkey_with_flags(
                        r"Software\Microsoft\Windows\CurrentVersion\Run",
                        KEY_READ | KEY_SET_VALUE,
                    )
                    .map_err(|e| {
                        PlatformError::OperationFailed(format!(
                            "Failed to open HKLM Run key: {}",
                            e
                        ))
                    })?;
                let command = run_key.get_value::<String, _>(name).map_err(|e| {
                    PlatformError::OperationFailed(format!(
                        "Failed to read command from HKLM Run: {}",
                        e
                    ))
                })?;
                let (disabled_key, _) = hkcu
                    .create_subkey(r"Software\FreeMyDisk\DisabledStartup")
                    .map_err(|e| {
                        PlatformError::OperationFailed(format!(
                            "Failed to create backup key: {}",
                            e
                        ))
                    })?;
                let payload = format!(r"HKLM\Run||{}", command);
                disabled_key.set_value(entry_id, &payload).map_err(|e| {
                    PlatformError::OperationFailed(format!(
                        "Failed to record disabled startup state: {}",
                        e
                    ))
                })?;
                run_key.delete_value(name).map_err(|e| {
                    PlatformError::OperationFailed(format!(
                        "Failed to remove entry from HKLM Run: {}",
                        e
                    ))
                })?;
            }
        } else if let Some(fname) = entry_id.strip_prefix("folder:user:") {
            if let Some(user_startup) = get_user_startup_dir() {
                if enable && fname.ends_with(".lnk.disabled") {
                    let old_path = user_startup.join(fname);
                    let new_path = user_startup.join(fname.trim_end_matches(".disabled"));
                    let _ = std::fs::rename(old_path, new_path);
                } else if !enable && fname.ends_with(".lnk") {
                    let old_path = user_startup.join(fname);
                    let new_path = user_startup.join(format!("{}.disabled", fname));
                    let _ = std::fs::rename(old_path, new_path);
                }
            }
        }

        Ok(())
    }

    fn delete_startup_entry(&self, entry_id: &str) -> Result<(), PlatformError> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        if let Some(name) = entry_id.strip_prefix("hkcu:run:") {
            if let Ok(run_key) = hkcu.open_subkey_with_flags(
                r"Software\Microsoft\Windows\CurrentVersion\Run",
                KEY_SET_VALUE,
            ) {
                let _ = run_key.delete_value(name);
            }
            if let Ok(disabled_key) =
                hkcu.open_subkey_with_flags(r"Software\FreeMyDisk\DisabledStartup", KEY_SET_VALUE)
            {
                let _ = disabled_key.delete_value(entry_id);
            }
        } else if let Some(name) = entry_id.strip_prefix("hklm:run:") {
            let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
            if !crate::windows::is_elevated_windows() {
                return Err(PlatformError::ElevationRequired(
                    "Administrator privileges are required to delete system-wide (HKLM) startup entries. Please run FreeMyDisk as Administrator.".to_string(),
                ));
            }
            let run_key = hklm
                .open_subkey_with_flags(
                    r"Software\Microsoft\Windows\CurrentVersion\Run",
                    KEY_SET_VALUE,
                )
                .map_err(|e| {
                    PlatformError::OperationFailed(format!("Failed to open HKLM Run key: {}", e))
                })?;
            let _ = run_key.delete_value(name);
            if let Ok(disabled_key) =
                hkcu.open_subkey_with_flags(r"Software\FreeMyDisk\DisabledStartup", KEY_SET_VALUE)
            {
                let _ = disabled_key.delete_value(entry_id);
            }
        } else if let Some(fname) = entry_id.strip_prefix("folder:user:") {
            if let Some(user_startup) = get_user_startup_dir() {
                let path = user_startup.join(fname);
                let _ = std::fs::remove_file(path);
            }
        }

        Ok(())
    }
}
