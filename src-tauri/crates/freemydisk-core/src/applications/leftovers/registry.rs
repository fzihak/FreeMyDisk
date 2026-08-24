use super::models::{LeftoverCandidate, LeftoverConfidence, LeftoverKind};

pub struct RegistryLeftoverScanner;

impl RegistryLeftoverScanner {
    /// Whitelist of system registry keys under Software that should never be flagged
    #[cfg(target_os = "windows")]
    fn get_registry_whitelist() -> std::collections::HashSet<&'static str> {
        [
            "microsoft",
            "classes",
            "policies",
            "registeredapplications",
            "windows",
            "clients",
            "intel",
            "nvidia",
            "amd",
            "freemydisk",
            "wow6432node",
            "oem",
            "device",
        ]
        .into_iter()
        .collect()
    }

    /// Scans for residual registry keys belonging to an uninstalled application
    pub fn scan_for_app(app_name: &str, publisher: Option<&str>) -> Vec<LeftoverCandidate> {
        #[cfg(target_os = "windows")]
        {
            Self::scan_for_app_windows(app_name, publisher)
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (app_name, publisher);
            Vec::new()
        }
    }

    #[cfg(target_os = "windows")]
    fn scan_for_app_windows(app_name: &str, publisher: Option<&str>) -> Vec<LeftoverCandidate> {
        use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
        use winreg::RegKey;

        let mut results = Vec::new();
        let app_lower = app_name.to_lowercase();
        let roots = [
            (HKEY_CURRENT_USER, "HKCU", r"Software"),
            (HKEY_CURRENT_USER, "HKCU", r"Software\WOW6432Node"),
            (HKEY_LOCAL_MACHINE, "HKLM", r"SOFTWARE"),
            (HKEY_LOCAL_MACHINE, "HKLM", r"SOFTWARE\WOW6432Node"),
        ];

        for (hkey, hkey_name, subpath) in roots {
            let root = RegKey::predef(hkey);
            let key = match root.open_subkey_with_flags(subpath, KEY_READ) {
                Ok(k) => k,
                Err(_) => continue,
            };

            // 1. Direct App Subkey
            if let Ok(app_key) = key.open_subkey_with_flags(app_name, KEY_READ) {
                let subkey_count = app_key.enum_keys().count() as u64;
                let val_count = app_key.enum_values().count() as u64;
                let full_path = format!(r"{}\{}\{}", hkey_name, subpath, app_name);

                results.push(LeftoverCandidate {
                    id: format!("reg:{}", full_path),
                    path_or_key: full_path,
                    kind: LeftoverKind::Registry,
                    size_bytes: (subkey_count + val_count).max(1) * 1024,
                    item_count: (subkey_count + val_count).max(1),
                    confidence: LeftoverConfidence::High,
                    description: "Application configuration registry hive".to_string(),
                });
            }

            // 2. Publisher Subkey (e.g. Software\Publisher\App)
            if let Some(pub_name) = publisher {
                if let Ok(pub_key) = key.open_subkey_with_flags(pub_name, KEY_READ) {
                    if let Ok(app_in_pub) = pub_key.open_subkey_with_flags(app_name, KEY_READ) {
                        let subkey_count = app_in_pub.enum_keys().count() as u64;
                        let val_count = app_in_pub.enum_values().count() as u64;
                        let full_path =
                            format!(r"{}\{}\{}\{}", hkey_name, subpath, pub_name, app_name);

                        results.push(LeftoverCandidate {
                            id: format!("reg:{}", full_path),
                            path_or_key: full_path,
                            kind: LeftoverKind::Registry,
                            size_bytes: (subkey_count + val_count).max(1) * 1024,
                            item_count: (subkey_count + val_count).max(1),
                            confidence: LeftoverConfidence::High,
                            description: "Publisher application configuration registry hive"
                                .to_string(),
                        });
                    }
                }
            }

            // 3. Scan subkeys for close name matches
            for key_name in key.enum_keys().flatten() {
                let lower_name = key_name.to_lowercase();
                if Self::get_registry_whitelist().contains(lower_name.as_str()) {
                    continue;
                }
                if lower_name == app_lower
                    || (app_lower.len() >= 4 && lower_name.contains(&app_lower))
                {
                    let full_path = format!(r"{}\{}\{}", hkey_name, subpath, key_name);
                    if results.iter().all(|r| r.path_or_key != full_path) {
                        if let Ok(matched_key) = key.open_subkey_with_flags(&key_name, KEY_READ) {
                            let subkey_count = matched_key.enum_keys().count() as u64;
                            let val_count = matched_key.enum_values().count() as u64;

                            results.push(LeftoverCandidate {
                                id: format!("reg:{}", full_path),
                                path_or_key: full_path,
                                kind: LeftoverKind::Registry,
                                size_bytes: (subkey_count + val_count).max(1) * 1024,
                                item_count: (subkey_count + val_count).max(1),
                                confidence: LeftoverConfidence::Medium,
                                description: "Residual matching registry key".to_string(),
                            });
                        }
                    }
                }
            }
        }

        results
    }

    /// Safely deletes a leftover registry subkey tree
    pub fn clean_registry_key(key_path: &str) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            match Self::clean_registry_key_windows(key_path) {
                Ok(()) => Ok(()),
                Err(e) => {
                    if key_path.starts_with("HKLM\\")
                        && !freemydisk_platform::windows::is_elevated_windows()
                    {
                        let payload = serde_json::json!({
                            "key_path": key_path
                        })
                        .to_string();
                        match crate::system_maintenance::ElevatedClient::execute_action(
                            "clean_hklm_registry_leftover",
                            &payload,
                        ) {
                            Ok(res) if res.success => Ok(()),
                            Ok(res) => Err(res.message),
                            Err(elev_err) => Err(format!("Elevation failed: {}", elev_err)),
                        }
                    } else {
                        Err(e)
                    }
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = key_path;
            Ok(())
        }
    }

    #[cfg(target_os = "windows")]
    fn clean_registry_key_windows(key_path: &str) -> Result<(), String> {
        use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_ALL_ACCESS};
        use winreg::RegKey;

        let trimmed = key_path.trim();
        let (root_hkey, remaining) = if let Some(stripped) = trimmed.strip_prefix("HKCU\\") {
            (HKEY_CURRENT_USER, stripped)
        } else if let Some(stripped) = trimmed.strip_prefix("HKLM\\") {
            (HKEY_LOCAL_MACHINE, stripped)
        } else {
            return Err(format!("Unsupported registry root in path: {}", key_path));
        };

        // Split into parent path and child key name to delete
        let (parent_path, child_name) = match remaining.rfind('\\') {
            Some(idx) => (&remaining[..idx], &remaining[idx + 1..]),
            None => {
                return Err(format!(
                    "Cannot delete top-level registry hive: {}",
                    key_path
                ));
            }
        };

        // Safety verification: never delete root hives or system keys
        let child_lower = child_name.to_lowercase();
        if Self::get_registry_whitelist().contains(child_lower.as_str()) {
            return Err(format!(
                "Refusing to delete whitelisted system key: {}",
                child_name
            ));
        }

        let root = RegKey::predef(root_hkey);
        let parent = root
            .open_subkey_with_flags(parent_path, KEY_ALL_ACCESS)
            .map_err(|e| format!("Failed to open registry parent '{}': {}", parent_path, e))?;

        parent
            .delete_subkey_all(child_name)
            .map_err(|e| format!("Failed to delete registry key '{}': {}", key_path, e))
    }
}
