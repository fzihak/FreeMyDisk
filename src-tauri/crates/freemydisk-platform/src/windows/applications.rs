use crate::traits::{
    PlatformApplications, PlatformError, RawInstalledApp, RawRunningProcess, RawUwpApp,
};
use std::collections::HashSet;
use std::os::windows::process::CommandExt;
use std::path::Path;
use winreg::enums::{
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
};
use winreg::RegKey;

const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum InstallerEngine {
    Msi,
    InnoSetup,
    Nsis,
    InstallShield,
    Squirrel,
    ClickOnce,
    Generic,
}

fn hidden_cmd(prog: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(prog);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

pub struct WindowsApplicationsHandler;

impl WindowsApplicationsHandler {
    pub fn new() -> Self {
        Self
    }

    pub fn expand_env_vars(raw: &str) -> String {
        use windows_sys::Win32::System::Environment::ExpandEnvironmentStringsW;
        let wide: Vec<u16> = raw.encode_utf16().chain(std::iter::once(0)).collect();
        let needed = unsafe { ExpandEnvironmentStringsW(wide.as_ptr(), std::ptr::null_mut(), 0) };
        if needed > 0 {
            let mut buf = vec![0u16; needed as usize];
            let written =
                unsafe { ExpandEnvironmentStringsW(wide.as_ptr(), buf.as_mut_ptr(), needed) };
            if written > 0 {
                if let Some(pos) = buf.iter().position(|&c| c == 0) {
                    buf.truncate(pos);
                }
                return String::from_utf16_lossy(&buf);
            }
        }
        raw.to_string()
    }

    pub fn parse_uninstall_string(raw: &str) -> (String, Option<String>) {
        let expanded = Self::expand_env_vars(raw);
        let trimmed = expanded.trim();
        if let Some(stripped) = trimmed.strip_prefix('"') {
            if let Some(second_quote) = stripped.find('"') {
                let file = stripped[..second_quote].to_string();
                let args = stripped[second_quote + 1..].trim();
                let args_opt = if args.is_empty() {
                    None
                } else {
                    Some(args.to_string())
                };
                return (file, args_opt);
            }
        }

        // Check for msiexec (e.g. MsiExec.exe /X{GUID} or msiexec /i ...)
        if trimmed.to_lowercase().starts_with("msiexec") {
            let parts: Vec<&str> = trimmed.split_whitespace().collect();
            if !parts.is_empty() {
                let file = parts[0].to_string();
                let args = trimmed[parts[0].len()..].trim();
                let args_opt = if args.is_empty() {
                    None
                } else {
                    Some(args.to_string())
                };
                return (file, args_opt);
            }
        }

        // Check if contains .exe
        let lower = trimmed.to_lowercase();
        if let Some(exe_idx) = lower.find(".exe") {
            let file = trimmed[..exe_idx + 4].trim().trim_matches('"').to_string();
            let args = trimmed[exe_idx + 4..].trim();
            let args_opt = if args.is_empty() {
                None
            } else {
                Some(args.to_string())
            };
            return (file, args_opt);
        }

        (trimmed.to_string(), None)
    }

    pub fn detect_installer_engine(file: &str, args: Option<&str>) -> InstallerEngine {
        let f_lower = file.to_lowercase();
        let a_lower = args.map(|a| a.to_lowercase()).unwrap_or_default();

        if f_lower.contains("msiexec") || a_lower.contains("/x{") || a_lower.contains("/i{") {
            InstallerEngine::Msi
        } else if f_lower.contains("unins000") || a_lower.contains("inno") {
            InstallerEngine::InnoSetup
        } else if f_lower.contains("_isuninst") || f_lower.contains("setup.exe") {
            InstallerEngine::InstallShield
        } else if f_lower.ends_with("uninstall.exe") || f_lower.ends_with("uninst.exe") {
            InstallerEngine::Nsis
        } else if f_lower.contains("update.exe") && a_lower.contains("--uninstall") {
            InstallerEngine::Squirrel
        } else if f_lower.contains("dfshim.dll") {
            InstallerEngine::ClickOnce
        } else {
            InstallerEngine::Generic
        }
    }

    pub fn prepare_silent_uninstall_args(
        engine: InstallerEngine,
        raw_args: Option<&str>,
        install_dir: Option<&str>,
    ) -> Option<String> {
        match engine {
            InstallerEngine::Msi => {
                let base = raw_args.unwrap_or("/x");
                let mut out = base.to_string();
                if !out.to_lowercase().contains("/qn") {
                    out.push_str(" /qn");
                }
                if !out.to_lowercase().contains("/norestart") {
                    out.push_str(" /norestart");
                }
                Some(out)
            }
            InstallerEngine::InnoSetup => {
                Some("/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-".to_string())
            }
            InstallerEngine::Nsis => {
                if let Some(dir) = install_dir {
                    Some(format!("/S _?={}", dir))
                } else {
                    Some("/S".to_string())
                }
            }
            InstallerEngine::InstallShield => Some("/s /v\"/qn /norestart\"".to_string()),
            InstallerEngine::Squirrel => Some("--uninstall -s".to_string()),
            InstallerEngine::ClickOnce | InstallerEngine::Generic => {
                raw_args.map(|s| s.to_string())
            }
        }
    }

    pub fn format_uwp_display_name(name: &str) -> String {
        let trimmed = name
            .trim_start_matches("MicrosoftCorporationII.")
            .trim_start_matches("Microsoft.Windows.")
            .trim_start_matches("Microsoft.")
            .trim_start_matches("AppUp.")
            .trim_start_matches("NVIDIACorp.")
            .trim_start_matches("AD2F1837.");

        let mut result = String::new();
        let chars: Vec<char> = trimmed.chars().collect();
        for (i, &ch) in chars.iter().enumerate() {
            if ch == '.' || ch == '_' {
                result.push(' ');
                continue;
            }
            if ch.is_uppercase() && i > 0 {
                let prev = chars[i - 1];
                if prev.is_lowercase()
                    || (prev.is_uppercase() && i + 1 < chars.len() && chars[i + 1].is_lowercase())
                {
                    result.push(' ');
                }
            }
            result.push(ch);
        }
        let out = result.trim().to_string();
        if out.is_empty() {
            name.to_string()
        } else {
            out
        }
    }

    pub fn format_uwp_publisher(raw: &str) -> String {
        if let Some(cn_idx) = raw.find("CN=") {
            let after = &raw[cn_idx + 3..];
            if let Some(comma) = after.find(',') {
                return after[..comma].trim().to_string();
            }
            return after.trim().to_string();
        }
        raw.trim().to_string()
    }

    pub fn quick_dir_size(p: &std::path::Path) -> Option<u64> {
        let mut total = 0u64;
        let mut stack = vec![(p.to_path_buf(), 0usize)];
        while let Some((dir, depth)) = stack.pop() {
            if depth > 5 {
                continue;
            }
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    if let Ok(meta) = entry.metadata() {
                        if meta.is_file() {
                            total += meta.len();
                        } else if meta.is_dir() {
                            stack.push((entry.path(), depth + 1));
                        }
                    }
                }
            }
        }
        if total > 0 {
            Some(total)
        } else {
            None
        }
    }

    fn find_uwp_icon(install_location: &str) -> (Option<String>, Option<String>) {
        let base = std::path::Path::new(install_location);
        if !base.exists() {
            return (None, None);
        }

        let search_dirs = [
            base.join("Assets"),
            base.join("assets"),
            base.join("Images"),
            base.join("images"),
            base.to_path_buf(),
        ];

        let mut found_path: Option<std::path::PathBuf> = None;

        for dir in &search_dirs {
            if !dir.is_dir() {
                continue;
            }
            if let Ok(entries) = std::fs::read_dir(dir) {
                let mut candidates: Vec<std::path::PathBuf> = Vec::new();
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_file() {
                        if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                            if ext.eq_ignore_ascii_case("png") {
                                let fname = p
                                    .file_name()
                                    .unwrap_or_default()
                                    .to_string_lossy()
                                    .to_lowercase();
                                if !fname.contains("splash")
                                    && !fname.contains("wide")
                                    && !fname.contains("badge")
                                {
                                    candidates.push(p);
                                }
                            }
                        }
                    }
                }

                if !candidates.is_empty() {
                    candidates.sort_by_key(|p| {
                        let name = p
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_lowercase();
                        if name.contains("square44x44logo") {
                            1
                        } else if name.contains("storelogo") {
                            2
                        } else if name.contains("square150x150logo") {
                            3
                        } else if name.contains("logo") {
                            4
                        } else if name.contains("icon") {
                            5
                        } else {
                            6
                        }
                    });
                    found_path = Some(candidates[0].clone());
                    break;
                }
            }
        }

        if let Some(p) = found_path {
            let path_str = p.to_string_lossy().to_string();
            if let Ok(bytes) = std::fs::read(&p) {
                if bytes.len() <= 512 * 1024 {
                    let b64 = Self::bytes_to_base64(&bytes);
                    return (
                        Some(path_str),
                        Some(format!("data:image/png;base64,{}", b64)),
                    );
                }
            }
            return (Some(path_str), None);
        }

        (None, None)
    }

    fn bytes_to_base64(bytes: &[u8]) -> String {
        const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
        for chunk in bytes.chunks(3) {
            let b0 = chunk[0];
            let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
            let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };

            let idx0 = (b0 >> 2) as usize;
            let idx1 = (((b0 & 0x03) << 4) | (b1 >> 4)) as usize;
            let idx2 = (((b1 & 0x0f) << 2) | (b2 >> 6)) as usize;
            let idx3 = (b2 & 0x3f) as usize;

            out.push(CHARS[idx0] as char);
            out.push(CHARS[idx1] as char);
            if chunk.len() > 1 {
                out.push(CHARS[idx2] as char);
            } else {
                out.push('=');
            }
            if chunk.len() > 2 {
                out.push(CHARS[idx3] as char);
            } else {
                out.push('=');
            }
        }
        out
    }
}

impl Default for WindowsApplicationsHandler {
    fn default() -> Self {
        Self::new()
    }
}

impl PlatformApplications for WindowsApplicationsHandler {
    fn list_installed_apps(&self) -> Result<Vec<RawInstalledApp>, PlatformError> {
        let mut apps = Vec::new();
        let mut seen_ids = HashSet::new();

        let mut scan_root = |root_key: winreg::HKEY,
                             subkey_path: &str,
                             flags: u32,
                             source_tag: &str| {
            let root = RegKey::predef(root_key);
            if let Ok(key) = root.open_subkey_with_flags(subkey_path, KEY_READ | flags) {
                for subkey_name in key.enum_keys().flatten() {
                    if let Ok(app_key) = key.open_subkey_with_flags(&subkey_name, KEY_READ | flags)
                    {
                        let sys_comp: u32 = app_key.get_value("SystemComponent").unwrap_or(0);
                        let parent_key: String =
                            app_key.get_value("ParentKeyName").unwrap_or_default();
                        if sys_comp == 1 || !parent_key.is_empty() {
                            continue;
                        }

                        let display_name: String =
                            match app_key.get_value::<String, _>("DisplayName") {
                                Ok(name) if !name.trim().is_empty() => name,
                                _ => continue,
                            };

                        let id = format!("{}:{}", source_tag, subkey_name);
                        let lower_name = display_name.to_lowercase();
                        if seen_ids.contains(&lower_name) {
                            continue;
                        }
                        seen_ids.insert(lower_name);

                        let publisher: Option<String> = app_key.get_value("Publisher").ok();
                        let display_version: Option<String> =
                            app_key.get_value("DisplayVersion").ok();
                        let install_location: Option<String> = app_key
                            .get_value("InstallLocation")
                            .ok()
                            .filter(|s: &String| !s.trim().is_empty());
                        let uninstall_string: Option<String> = app_key
                            .get_value("UninstallString")
                            .ok()
                            .filter(|s: &String| !s.trim().is_empty());
                        let estimated_size_kb: Option<u32> =
                            app_key.get_value("EstimatedSize").ok();
                        let estimated_size_bytes = estimated_size_kb.map(|kb| (kb as u64) * 1024);
                        let install_date: Option<String> = app_key.get_value("InstallDate").ok();

                        // Safely read DisplayIcon as a path string ONLY.
                        // NO GDI/Win32 icon extraction — that caused memory access violations.
                        // The frontend renders a styled initials fallback SVG icon.
                        let display_icon: Option<String> = app_key
                            .get_value("DisplayIcon")
                            .ok()
                            .filter(|s: &String| !s.trim().is_empty())
                            .map(|raw: String| {
                                let expanded = Self::expand_env_vars(&raw);
                                let trimmed = expanded.trim().trim_matches('"').to_string();
                                if let Some(comma_pos) = trimmed.rfind(',') {
                                    trimmed[..comma_pos].trim().trim_matches('"').to_string()
                                } else {
                                    trimmed
                                }
                            });

                        apps.push(RawInstalledApp {
                            id,
                            name: display_name,
                            publisher,
                            display_version,
                            install_location,
                            uninstall_string,
                            estimated_size_bytes,
                            install_date,
                            display_icon,
                            // Never extracted via GDI to prevent crashes.
                            // Frontend renders SVG initials fallback icon.
                            icon_data: None,
                        });
                    }
                }
            }
        };

        // 1. HKLM 64-bit
        scan_root(
            HKEY_LOCAL_MACHINE,
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
            KEY_WOW64_64KEY,
            "hklm64",
        );
        // 2. HKLM 32-bit (Wow6432Node)
        scan_root(
            HKEY_LOCAL_MACHINE,
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
            KEY_WOW64_32KEY,
            "hklm32",
        );
        // 3. HKCU
        scan_root(
            HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
            0,
            "hkcu",
        );

        apps.sort_by_key(|a| a.name.to_lowercase());
        Ok(apps)
    }

    fn list_running_processes(&self) -> Result<Vec<RawRunningProcess>, PlatformError> {
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };

        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(PlatformError::Io(std::io::Error::last_os_error()));
        }

        let mut procs = Vec::new();
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

        if unsafe { Process32FirstW(snapshot, &mut entry) } != 0 {
            loop {
                let name_len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);

                procs.push(RawRunningProcess {
                    pid: entry.th32ProcessID,
                    name,
                    exe_path: None,
                });

                if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
                    break;
                }
            }
        }

        unsafe { CloseHandle(snapshot) };
        Ok(procs)
    }

    fn terminate_process(&self, pid: u32) -> Result<(), PlatformError> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, TerminateProcess, PROCESS_TERMINATE,
        };

        let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
        if handle.is_null() {
            return Err(PlatformError::PermissionDenied(format!(
                "Cannot open process {} for termination",
                pid
            )));
        }

        let success = unsafe { TerminateProcess(handle, 1) };
        unsafe { CloseHandle(handle) };

        if success == 0 {
            return Err(PlatformError::OperationFailed(format!(
                "Failed to terminate process {}",
                pid
            )));
        }
        Ok(())
    }

    fn launch_uninstaller(&self, uninstall_string: &str) -> Result<(), PlatformError> {
        let trimmed = uninstall_string.trim();
        if trimmed.is_empty() {
            return Err(PlatformError::OperationFailed(
                "Empty uninstall string".to_string(),
            ));
        }

        let (file, args) = WindowsApplicationsHandler::parse_uninstall_string(trimmed);

        let to_wide =
            |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };

        let file_w = to_wide(&file);
        let args_w = args.as_deref().map(&to_wide);
        let args_ptr = args_w
            .as_ref()
            .map(|w| w.as_ptr())
            .unwrap_or(std::ptr::null());

        let verb_open = to_wide("open");
        let verb_runas = to_wide("runas");

        unsafe {
            use windows_sys::Win32::UI::Shell::ShellExecuteW;
            use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

            // 1. Try with "open" (standard shell launch, triggers UAC prompt if required by binary manifest)
            let res = ShellExecuteW(
                std::ptr::null_mut(),
                verb_open.as_ptr(),
                file_w.as_ptr(),
                args_ptr,
                std::ptr::null(),
                SW_SHOWNORMAL as _,
            );

            if (res as usize) > 32 {
                return Ok(());
            }

            // 2. Retry with "runas" (forces UAC elevation dialog)
            let res_runas = ShellExecuteW(
                std::ptr::null_mut(),
                verb_runas.as_ptr(),
                file_w.as_ptr(),
                args_ptr,
                std::ptr::null(),
                SW_SHOWNORMAL as _,
            );

            if (res_runas as usize) > 32 {
                return Ok(());
            }
        }

        // 3. Fallback: PowerShell Start-Process with -Verb RunAs
        let mut ps_args = format!("Start-Process -FilePath '{}'", file.replace('\'', "''"));
        if let Some(ref a) = args {
            ps_args.push_str(&format!(" -ArgumentList '{}'", a.replace('\'', "''")));
        }
        ps_args.push_str(" -Verb RunAs -ErrorAction SilentlyContinue");

        let status = hidden_cmd("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps_args])
            .spawn();

        if status.is_ok() {
            return Ok(());
        }

        Err(PlatformError::OperationFailed(format!(
            "Failed to launch uninstaller for '{}'",
            file
        )))
    }

    fn launch_silent_uninstaller(
        &self,
        uninstall_string: &str,
        install_dir: Option<&str>,
    ) -> Result<(), PlatformError> {
        let trimmed = uninstall_string.trim();
        if trimmed.is_empty() {
            return Err(PlatformError::OperationFailed(
                "Empty uninstall string".to_string(),
            ));
        }

        let (file, args) = WindowsApplicationsHandler::parse_uninstall_string(trimmed);
        let engine = WindowsApplicationsHandler::detect_installer_engine(&file, args.as_deref());
        let silent_args = WindowsApplicationsHandler::prepare_silent_uninstall_args(
            engine,
            args.as_deref(),
            install_dir,
        );

        let final_args = silent_args.as_deref().or(args.as_deref());

        let to_wide =
            |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };

        let file_w = to_wide(&file);
        let args_w = final_args.map(&to_wide);
        let args_ptr = args_w
            .as_ref()
            .map(|w| w.as_ptr())
            .unwrap_or(std::ptr::null());

        let verb_open = to_wide("open");
        let verb_runas = to_wide("runas");

        unsafe {
            use windows_sys::Win32::UI::Shell::ShellExecuteW;
            use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

            // 1. Try with "open"
            let res = ShellExecuteW(
                std::ptr::null_mut(),
                verb_open.as_ptr(),
                file_w.as_ptr(),
                args_ptr,
                std::ptr::null(),
                SW_SHOWNORMAL as _,
            );

            if (res as usize) > 32 {
                return Ok(());
            }

            // 2. Retry with "runas"
            let res_runas = ShellExecuteW(
                std::ptr::null_mut(),
                verb_runas.as_ptr(),
                file_w.as_ptr(),
                args_ptr,
                std::ptr::null(),
                SW_SHOWNORMAL as _,
            );

            if (res_runas as usize) > 32 {
                return Ok(());
            }
        }

        // 3. Fallback: PowerShell Start-Process with -Verb RunAs
        let mut ps_args = format!("Start-Process -FilePath '{}'", file.replace('\'', "''"));
        if let Some(fa) = final_args {
            ps_args.push_str(&format!(" -ArgumentList '{}'", fa.replace('\'', "''")));
        }
        ps_args.push_str(" -Verb RunAs -ErrorAction SilentlyContinue");

        let status = hidden_cmd("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps_args])
            .spawn();

        if status.is_ok() {
            return Ok(());
        }

        Err(PlatformError::OperationFailed(format!(
            "Failed to launch silent uninstaller for '{}'",
            file
        )))
    }

    fn list_uwp_apps(&self) -> Result<Vec<RawUwpApp>, PlatformError> {
        let cmd = "@(Get-AppxPackage | Where-Object { -not $_.IsFramework -and -not $_.NonRemovable } | Select-Object Name, Version, PackageFullName, InstallLocation, Publisher) | ConvertTo-Json -Compress";

        let output = hidden_cmd("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", cmd])
            .output()
            .map_err(PlatformError::Io)?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(PlatformError::OperationFailed(format!(
                "Failed to list UWP packages: {}",
                stderr
            )));
        }

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if stdout.is_empty() {
            return Ok(Vec::new());
        }

        #[derive(serde::Deserialize)]
        struct PsUwpItem {
            #[serde(rename = "Name")]
            name: Option<String>,
            #[serde(rename = "Version")]
            version: Option<String>,
            #[serde(rename = "PackageFullName")]
            package_full_name: Option<String>,
            #[serde(rename = "InstallLocation")]
            install_location: Option<String>,
            #[serde(rename = "Publisher")]
            publisher: Option<String>,
        }

        let parsed: Vec<PsUwpItem> = serde_json::from_str(&stdout)
            .or_else(|_| serde_json::from_str::<PsUwpItem>(&stdout).map(|item| vec![item]))
            .unwrap_or_default();

        let mut results = Vec::new();
        for item in parsed {
            let name = match item.name {
                Some(n) if !n.trim().is_empty() => n,
                _ => continue,
            };
            let package_full_name = match item.package_full_name {
                Some(p) if !p.trim().is_empty() => p,
                _ => continue,
            };

            let display_name = Self::format_uwp_display_name(&name);
            let publisher_clean = item.publisher.map(|p| Self::format_uwp_publisher(&p));

            let estimated_size_bytes = item.install_location.as_ref().and_then(|loc| {
                let p = std::path::Path::new(loc);
                if p.exists() {
                    Self::quick_dir_size(p)
                } else {
                    None
                }
            });

            let (icon_path, icon_data_url) = item
                .install_location
                .as_deref()
                .map(Self::find_uwp_icon)
                .unwrap_or((None, None));

            results.push(RawUwpApp {
                name,
                display_name,
                publisher: publisher_clean,
                package_full_name,
                install_location: item.install_location,
                version: item.version,
                estimated_size_bytes,
                icon_path,
                icon_data_url,
            });
        }

        results.sort_by_key(|a| a.display_name.to_lowercase());
        Ok(results)
    }

    fn uninstall_uwp_app(&self, package_full_name: &str) -> Result<(), PlatformError> {
        let safe_name = package_full_name.replace('\'', "''").replace('"', "");

        // 1. Try non-elevated removal first
        let script = format!(
            "Remove-AppxPackage -Package '{}' -ErrorAction Stop",
            safe_name
        );
        let output = hidden_cmd("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output();

        if let Ok(out) = output {
            if out.status.success() {
                return Ok(());
            }
        }

        // 2. Launch with ShellExecuteW runas for elevation (AllUsers)
        let to_wide =
            |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };

        let file_w = to_wide("powershell.exe");
        let ps_args = format!(
            "-NoProfile -WindowStyle Hidden -Command \"Remove-AppxPackage -Package '{}' -AllUsers\"",
            safe_name
        );
        let args_w = to_wide(&ps_args);
        let verb_runas = to_wide("runas");

        unsafe {
            use windows_sys::Win32::UI::Shell::ShellExecuteW;
            use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

            let res = ShellExecuteW(
                std::ptr::null_mut(),
                verb_runas.as_ptr(),
                file_w.as_ptr(),
                args_w.as_ptr(),
                std::ptr::null(),
                SW_HIDE as _,
            );

            if (res as usize) > 32 {
                return Ok(());
            }
        }

        Err(PlatformError::OperationFailed(format!(
            "Failed to uninstall UWP package '{}'",
            package_full_name
        )))
    }

    fn get_locking_processes(&self, path: &Path) -> Result<Vec<RawRunningProcess>, PlatformError> {
        super::restart_manager::RestartManagerHelper::get_locking_processes(path)
    }
}
