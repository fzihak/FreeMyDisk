use crate::traits::PlatformApplications;
use crate::traits::{PlatformError, PlatformPrivacy, RawBrowserProfile};
use crate::windows::applications::WindowsApplicationsHandler;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

pub struct WindowsPrivacyHandler;

impl WindowsPrivacyHandler {
    pub fn new() -> Self {
        Self
    }

    fn check_running_exe(exe_name: &str, running_set: &HashSet<String>) -> bool {
        running_set.contains(&exe_name.to_lowercase())
    }
}

impl Default for WindowsPrivacyHandler {
    fn default() -> Self {
        Self::new()
    }
}

impl PlatformPrivacy for WindowsPrivacyHandler {
    fn list_browser_profiles(&self) -> Result<Vec<RawBrowserProfile>, PlatformError> {
        let mut profiles = Vec::new();

        let procs = WindowsApplicationsHandler::new()
            .list_running_processes()
            .unwrap_or_default();
        let running_names: HashSet<String> =
            procs.into_iter().map(|p| p.name.to_lowercase()).collect();

        let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let app_data = std::env::var("APPDATA").unwrap_or_default();

        // 1. Google Chrome
        if !local_app_data.is_empty() {
            let chrome_user_data = PathBuf::from(&local_app_data).join(r"Google\Chrome\User Data");
            if chrome_user_data.exists() {
                let is_running = Self::check_running_exe("chrome.exe", &running_names);
                find_chromium_profiles(
                    &chrome_user_data,
                    "chrome",
                    "Google Chrome",
                    is_running,
                    &mut profiles,
                );
            }
        }

        // 2. Microsoft Edge
        if !local_app_data.is_empty() {
            let edge_user_data = PathBuf::from(&local_app_data).join(r"Microsoft\Edge\User Data");
            if edge_user_data.exists() {
                let is_running = Self::check_running_exe("msedge.exe", &running_names);
                find_chromium_profiles(
                    &edge_user_data,
                    "edge",
                    "Microsoft Edge",
                    is_running,
                    &mut profiles,
                );
            }
        }

        // 3. Brave Browser
        if !local_app_data.is_empty() {
            let brave_user_data =
                PathBuf::from(&local_app_data).join(r"BraveSoftware\Brave-Browser\User Data");
            if brave_user_data.exists() {
                let is_running = Self::check_running_exe("brave.exe", &running_names);
                find_chromium_profiles(
                    &brave_user_data,
                    "brave",
                    "Brave Browser",
                    is_running,
                    &mut profiles,
                );
            }
        }

        // 4. Vivaldi
        if !local_app_data.is_empty() {
            let vivaldi_user_data = PathBuf::from(&local_app_data).join(r"Vivaldi\User Data");
            if vivaldi_user_data.exists() {
                let is_running = Self::check_running_exe("vivaldi.exe", &running_names);
                find_chromium_profiles(
                    &vivaldi_user_data,
                    "vivaldi",
                    "Vivaldi",
                    is_running,
                    &mut profiles,
                );
            }
        }

        // 5. Arc Browser
        if !local_app_data.is_empty() {
            let arc_user_data =
                PathBuf::from(&local_app_data).join(r"The Browser Company\Arc\User Data");
            if arc_user_data.exists() {
                let is_running = Self::check_running_exe("arc.exe", &running_names);
                find_chromium_profiles(
                    &arc_user_data,
                    "arc",
                    "Arc Browser",
                    is_running,
                    &mut profiles,
                );
            }
        }

        // 6. Chromium Developer Build
        if !local_app_data.is_empty() {
            let chromium_user_data = PathBuf::from(&local_app_data).join(r"Chromium\User Data");
            if chromium_user_data.exists() {
                let is_running = Self::check_running_exe("chrome.exe", &running_names)
                    || Self::check_running_exe("chromium.exe", &running_names);
                find_chromium_profiles(
                    &chromium_user_data,
                    "chromium",
                    "Chromium",
                    is_running,
                    &mut profiles,
                );
            }
        }

        // 7. Mozilla Firefox
        if !app_data.is_empty() {
            let firefox_profiles = PathBuf::from(&app_data).join(r"Mozilla\Firefox\Profiles");
            if firefox_profiles.exists() {
                let is_running = Self::check_running_exe("firefox.exe", &running_names);
                find_gecko_profiles(
                    &firefox_profiles,
                    "firefox",
                    "Mozilla Firefox",
                    is_running,
                    &mut profiles,
                );
            }
        }

        // 8. LibreWolf (Hardened Firefox)
        if !app_data.is_empty() {
            let librewolf_profiles = PathBuf::from(&app_data).join(r"librewolf\Profiles");
            if librewolf_profiles.exists() {
                let is_running = Self::check_running_exe("librewolf.exe", &running_names);
                find_gecko_profiles(
                    &librewolf_profiles,
                    "librewolf",
                    "LibreWolf",
                    is_running,
                    &mut profiles,
                );
            }
        }

        // 9. Floorp (Firefox derivative)
        if !app_data.is_empty() {
            let floorp_profiles = PathBuf::from(&app_data).join(r"Floorp\Profiles");
            if floorp_profiles.exists() {
                let is_running = Self::check_running_exe("floorp.exe", &running_names);
                find_gecko_profiles(
                    &floorp_profiles,
                    "floorp",
                    "Floorp",
                    is_running,
                    &mut profiles,
                );
            }
        }

        // 10. Waterfox
        if !app_data.is_empty() {
            let waterfox_profiles = PathBuf::from(&app_data).join(r"Waterfox\Profiles");
            if waterfox_profiles.exists() {
                let is_running = Self::check_running_exe("waterfox.exe", &running_names);
                find_gecko_profiles(
                    &waterfox_profiles,
                    "waterfox",
                    "Waterfox",
                    is_running,
                    &mut profiles,
                );
            }
        }

        // 11. Opera Stable
        if !app_data.is_empty() {
            let opera_dir = PathBuf::from(&app_data).join(r"Opera Software\Opera Stable");
            if opera_dir.exists() {
                let is_running = Self::check_running_exe("opera.exe", &running_names);
                profiles.push(RawBrowserProfile {
                    browser_id: "opera".to_string(),
                    browser_name: "Opera Stable".to_string(),
                    profile_name: "Default".to_string(),
                    profile_path: opera_dir,
                    is_running,
                });
            }
        }

        // 12. Opera GX
        if !app_data.is_empty() {
            let opera_gx_dir = PathBuf::from(&app_data).join(r"Opera Software\Opera GX Stable");
            if opera_gx_dir.exists() {
                let is_running = Self::check_running_exe("opera.exe", &running_names)
                    || Self::check_running_exe("operagx.exe", &running_names);
                profiles.push(RawBrowserProfile {
                    browser_id: "opera_gx".to_string(),
                    browser_name: "Opera GX".to_string(),
                    profile_name: "Default".to_string(),
                    profile_path: opera_gx_dir,
                    is_running,
                });
            }
        }

        Ok(profiles)
    }

    fn clean_clipboard(&self) -> Result<u64, PlatformError> {
        unsafe {
            use windows_sys::Win32::System::DataExchange::{
                CloseClipboard, EmptyClipboard, OpenClipboard,
            };
            if OpenClipboard(std::ptr::null_mut()) != 0 {
                EmptyClipboard();
                CloseClipboard();
                Ok(4096)
            } else {
                Ok(0)
            }
        }
    }

    #[allow(clippy::permissions_set_readonly_false)]
    fn clean_system_activity_traces(&self) -> Result<u64, PlatformError> {
        let mut bytes_reclaimed = 0u64;
        let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();

        // 1. Clean Recent Documents & Jump Lists: %APPDATA%\Microsoft\Windows\Recent
        if let Ok(app_data) = std::env::var("APPDATA") {
            let recent_dir = PathBuf::from(&app_data).join(r"Microsoft\Windows\Recent");
            if recent_dir.exists() {
                if let Ok(entries) = std::fs::read_dir(&recent_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_file() {
                            if let Ok(meta) = path.metadata() {
                                bytes_reclaimed += meta.len();
                                let mut perms = meta.permissions();
                                if perms.readonly() {
                                    perms.set_readonly(false);
                                    let _ = std::fs::set_permissions(&path, perms);
                                }
                            }
                            let _ = std::fs::remove_file(&path);
                        } else if path.is_dir() {
                            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                            if name == "AutomaticDestinations" || name == "CustomDestinations" {
                                if let Ok(sub_entries) = std::fs::read_dir(&path) {
                                    for sub in sub_entries.flatten() {
                                        let sp = sub.path();
                                        if sp.is_file() {
                                            if let Ok(sm) = sp.metadata() {
                                                bytes_reclaimed += sm.len();
                                                let mut perms = sm.permissions();
                                                if perms.readonly() {
                                                    perms.set_readonly(false);
                                                    let _ = std::fs::set_permissions(&sp, perms);
                                                }
                                            }
                                            let _ = std::fs::remove_file(&sp);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        // 2. Shell Bags Purge (Folder View History on local, external USB, and network drives)
        let shell_settings_path =
            r"Software\Classes\Local Settings\Software\Microsoft\Windows\Shell";
        if let Ok(shell_key) = hkcu.open_subkey_with_flags(
            shell_settings_path,
            winreg::enums::KEY_READ | winreg::enums::KEY_WRITE,
        ) {
            let _ = shell_key.delete_subkey_all("Bags");
            let _ = shell_key.delete_subkey_all("BagMRU");
            let _ = shell_key.create_subkey("Bags");
            let _ = shell_key.create_subkey("BagMRU");
        }

        // 3. UserAssist ROT13 Engine & Comprehensive Execution Purge
        const USER_ASSIST_GUIDS: &[&str] = &[
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist\{5E6AB780-7743-11CF-A12B-00AA004AE837}\Count",
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist\{75048700-EF1F-11D0-9888-006097DEACF9}\Count",
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist\{CEBFF5CD-ACE2-4F4F-9178-9926F41749EA}\Count",
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist\{F4E57C4B-2036-45F0-A9AB-443BCFE33D9F}\Count",
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist\{BCB48336-4FF6-45C5-8648-932C37F88C60}\Count",
        ];
        for guid_path in USER_ASSIST_GUIDS {
            clear_registry_subkey_tree(&hkcu, guid_path);
        }

        // 4. OpenSaveMRU, OpenSavePidlMRU, WordWheelQuery, SearchHistory & Explorer MRUs
        const EXPLORER_AND_DIALOG_MRUS: &[&str] = &[
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\ComDlg32\OpenSaveMRU",
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\ComDlg32\OpenSavePidlMRU",
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\ComDlg32\LastVisitedMRU",
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\ComDlg32\LastVisitedPidlMRU",
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\WordWheelQuery",
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\RecentDocs",
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\RunMRU",
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\TypedPaths",
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\SearchHistory",
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\Map Network Drive MRU",
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\FindComputerMRU",
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\PrnPortsMRU",
            r"Software\Microsoft\Windows\CurrentVersion\Applets\Paint\Recent File List",
            r"Software\Microsoft\Windows\CurrentVersion\Applets\Wordpad\Recent File List",
            r"Software\Microsoft\Windows\CurrentVersion\Applets\Regedit\Favorites",
            r"Software\Microsoft\Windows\CurrentVersion\Applets\Regedit\LastKey",
            r"Software\Microsoft\Internet Explorer\TypedURLs",
            r"Software\Microsoft\Terminal Server Client\Default",
            r"Software\Microsoft\Terminal Server Client\Servers",
            r"Software\7-Zip\Compression\ArcHistory",
            r"Software\7-Zip\Extraction\PathHistory",
            r"Software\WinRAR\ArcHistory",
            r"Software\WinRAR\DialogEditHistory",
            r"Software\Microsoft\MediaPlayer\Player\RecentFileList",
            r"Software\Microsoft\MediaPlayer\Player\RecentURLList",
            r"Software\Daum\PotPlayerMini64\RecentlyFileList",
        ];
        for key_path in EXPLORER_AND_DIALOG_MRUS {
            clear_registry_subkey_tree(&hkcu, key_path);
        }

        // 5. Microsoft Office Recent Documents MRU (Word, Excel, PowerPoint)
        for version in &["14.0", "15.0", "16.0"] {
            for app in &["Word", "Excel", "PowerPoint", "Access"] {
                let file_mru = format!(r"Software\Microsoft\Office\{}\{}\File MRU", version, app);
                clear_registry_subkey_tree(&hkcu, &file_mru);

                let user_mru = format!(r"Software\Microsoft\Office\{}\{}\User MRU", version, app);
                clear_registry_subkey_tree(&hkcu, &user_mru);
            }
        }

        // 6. Clear Media Players History (VLC, Notepad++)
        if let Ok(app_data) = std::env::var("APPDATA") {
            clean_vlc_history(&app_data);
            clean_notepad_plus_plus_history(&app_data);
        }

        // 7. Clear Windows Clipboard via Win32 API
        let _ = self.clean_clipboard();

        // 8. Clean Windows Timeline Activity Store (%LOCALAPPDATA%\ConnectedDevicesPlatform)
        if !local_app_data.is_empty() {
            let cdp_dir = PathBuf::from(&local_app_data).join("ConnectedDevicesPlatform");
            if cdp_dir.exists() {
                if let Ok(entries) = std::fs::read_dir(&cdp_dir) {
                    for entry in entries.flatten() {
                        let sub_p = entry.path();
                        if sub_p.is_dir() {
                            let act_db = sub_p.join("ActivitiesCache.db");
                            if act_db.exists() {
                                if let Ok(meta) = act_db.metadata() {
                                    bytes_reclaimed += meta.len();
                                }
                                let _ = std::fs::remove_file(&act_db);
                                let _ = std::fs::remove_file(act_db.with_extension("db-wal"));
                                let _ = std::fs::remove_file(act_db.with_extension("db-shm"));
                            }
                        }
                    }
                }
            }
        }

        // 9. Clean Windows Error Reporting (WER) Diagnostics & Crash Dumps
        if !local_app_data.is_empty() {
            let crash_dumps = PathBuf::from(&local_app_data).join("CrashDumps");
            bytes_reclaimed += purge_directory_files_only(&crash_dumps);

            let wer_archive =
                PathBuf::from(&local_app_data).join(r"Microsoft\Windows\WER\ReportArchive");
            bytes_reclaimed += purge_directory_recursive(&wer_archive);

            let wer_queue =
                PathBuf::from(&local_app_data).join(r"Microsoft\Windows\WER\ReportQueue");
            bytes_reclaimed += purge_directory_recursive(&wer_queue);

            let d3d_cache = PathBuf::from(&local_app_data).join("D3DSCache");
            bytes_reclaimed += purge_directory_recursive(&d3d_cache);
        }

        // 10. Clean VSCode workspace and recent file traces
        if let Ok(app_data) = std::env::var("APPDATA") {
            let ws_storage = PathBuf::from(&app_data).join(r"Code\User\workspaceStorage");
            bytes_reclaimed += purge_directory_recursive(&ws_storage);
        }

        // 11. Broadcast Shell Association & Setting Change to refresh Explorer
        unsafe {
            use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
            SHChangeNotify(
                SHCNE_ASSOCCHANGED as i32,
                SHCNF_IDLIST,
                std::ptr::null(),
                std::ptr::null(),
            );
        }

        Ok(bytes_reclaimed)
    }
}

fn purge_directory_files_only(dir: &Path) -> u64 {
    let mut reclaimed = 0u64;
    if dir.exists() {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() {
                    if let Ok(meta) = p.metadata() {
                        reclaimed += meta.len();
                    }
                    let _ = std::fs::remove_file(&p);
                }
            }
        }
    }
    reclaimed
}

fn purge_directory_recursive(dir: &Path) -> u64 {
    let mut reclaimed = 0u64;
    if dir.exists() {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() {
                    if let Ok(meta) = p.metadata() {
                        reclaimed += meta.len();
                    }
                    let _ = std::fs::remove_file(&p);
                } else if p.is_dir() {
                    reclaimed += purge_directory_recursive(&p);
                    let _ = std::fs::remove_dir(&p);
                }
            }
        }
    }
    reclaimed
}

fn find_gecko_profiles(
    profiles_dir: &Path,
    browser_id: &str,
    browser_name: &str,
    is_running: bool,
    profiles: &mut Vec<RawBrowserProfile>,
) {
    if let Ok(entries) = std::fs::read_dir(profiles_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let profile_name = entry.file_name().to_string_lossy().to_string();
                profiles.push(RawBrowserProfile {
                    browser_id: browser_id.to_string(),
                    browser_name: browser_name.to_string(),
                    profile_name,
                    profile_path: path,
                    is_running,
                });
            }
        }
    }
}

fn find_chromium_profiles(
    user_data_dir: &Path,
    browser_id: &str,
    browser_name: &str,
    is_running: bool,
    profiles: &mut Vec<RawBrowserProfile>,
) {
    if let Ok(entries) = std::fs::read_dir(user_data_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name == "Default" || name.starts_with("Profile ") {
                    profiles.push(RawBrowserProfile {
                        browser_id: browser_id.to_string(),
                        browser_name: browser_name.to_string(),
                        profile_name: name,
                        profile_path: path,
                        is_running,
                    });
                }
            }
        }
    }
}

/// ROT13 decoder/encoder for Windows UserAssist entries
pub fn rot13(input: &str) -> String {
    input
        .chars()
        .map(|c| match c {
            'a'..='m' | 'A'..='M' => ((c as u8) + 13) as char,
            'n'..='z' | 'N'..='Z' => ((c as u8) - 13) as char,
            other => other,
        })
        .collect()
}

fn clear_registry_subkey_tree(parent: &RegKey, subkey_path: &str) {
    if let Ok(key) = parent.open_subkey_with_flags(
        subkey_path,
        winreg::enums::KEY_READ | winreg::enums::KEY_WRITE,
    ) {
        let val_names: Vec<String> = key
            .enum_values()
            .filter_map(|r| r.ok())
            .map(|(name, _)| name)
            .collect();
        for name in val_names {
            let _ = key.delete_value(&name);
        }

        let child_keys: Vec<String> = key.enum_keys().filter_map(|r| r.ok()).collect();
        for child in child_keys {
            let _ = key.delete_subkey_all(&child);
        }
    }
}

fn clean_vlc_history(app_data: &str) {
    let vlc_ini = PathBuf::from(app_data).join(r"vlc\vlc-qt-interface.ini");
    if vlc_ini.exists() {
        if let Ok(content) = std::fs::read_to_string(&vlc_ini) {
            let mut new_lines = Vec::new();
            let mut in_recents = false;
            for line in content.lines() {
                if line.trim().eq_ignore_ascii_case("[RecentsMRL]") {
                    in_recents = true;
                    continue;
                }
                if in_recents {
                    if line.trim().starts_with('[') {
                        in_recents = false;
                        new_lines.push(line.to_string());
                    }
                } else {
                    new_lines.push(line.to_string());
                }
            }
            let _ = std::fs::write(&vlc_ini, new_lines.join("\r\n"));
        }
    }
}

fn clean_notepad_plus_plus_history(app_data: &str) {
    let npp_xml = PathBuf::from(app_data).join(r"Notepad++\config.xml");
    if npp_xml.exists() {
        if let Ok(content) = std::fs::read_to_string(&npp_xml) {
            let mut new_lines = Vec::new();
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("<File filename=") && trimmed.contains("history") {
                    continue;
                }
                new_lines.push(line.to_string());
            }
            let _ = std::fs::write(&npp_xml, new_lines.join("\r\n"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rot13_userassist_codec() {
        assert_eq!(rot13("HRZR_EHACNGU:"), "UEME_RUNPATH:");
        assert_eq!(rot13("UEME_RUNPATH:"), "HRZR_EHACNGU:");
        assert_eq!(
            rot13("C:\\Windows\\notepad.exe"),
            "P:\\Jvaqbjf\\abgrcnq.rkr"
        );
        assert_eq!(
            rot13(&rot13("C:\\Windows\\notepad.exe")),
            "C:\\Windows\\notepad.exe"
        );
    }
}
