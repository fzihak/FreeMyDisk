use freemydisk_platform::{get_platform, PlatformFilesystem, PlatformPrivacy, RawBrowserProfile};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrivacyCategoryKind {
    Cache,
    History,
    Downloads,
    Cookies,
    Sessions,
    SystemActivity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrivacyItem {
    pub id: String,
    pub browser_id: String,
    pub browser_name: String,
    pub profile_name: String,
    pub category: PrivacyCategoryKind,
    pub title: String,
    pub description: String,
    pub size_bytes: u64,
    pub item_count: u64,
    pub is_locked: bool,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrivacyScanResult {
    pub items: Vec<PrivacyItem>,
    pub total_size_bytes: u64,
    pub running_browsers: Vec<String>,
}

pub struct PrivacyService {
    platform: Box<dyn PlatformPrivacy>,
    fs_platform: Box<dyn PlatformFilesystem>,
}

impl PrivacyService {
    pub fn new() -> Self {
        Self {
            platform: Box::new(get_platform()),
            fs_platform: Box::new(get_platform()),
        }
    }

    pub fn with_platform(
        platform: Box<dyn PlatformPrivacy>,
        fs_platform: Box<dyn PlatformFilesystem>,
    ) -> Self {
        Self {
            platform,
            fs_platform,
        }
    }

    pub fn scan_privacy_items(&self) -> Result<PrivacyScanResult, String> {
        self.scan_privacy_items_with_progress(|_| {})
    }

    pub fn scan_privacy_items_with_progress<F>(&self, mut on_progress: F) -> Result<PrivacyScanResult, String>
    where
        F: FnMut(crate::shared::progress::AppScanProgress),
    {
        on_progress(crate::shared::progress::AppScanProgress {
            scan_type: "privacy".to_string(),
            stage: "Discovering browser profiles...".to_string(),
            percent: 5,
            items_scanned: 0,
            current_path: String::new(),
            bytes_found: 0,
            is_complete: false,
        });

        let profiles = self
            .platform
            .list_browser_profiles()
            .map_err(|e| e.to_string())?;

        let total_profiles = profiles.len();
        let mut items = Vec::new();
        let mut running_browsers = HashSet::new();

        for (idx, prof) in profiles.into_iter().enumerate() {
            let pct = (5 + ((idx as f32 / total_profiles.max(1) as f32) * 80.0) as u8).min(85);
            on_progress(crate::shared::progress::AppScanProgress {
                scan_type: "privacy".to_string(),
                stage: format!("Analyzing {} profile ({})", prof.browser_name, prof.profile_name),
                percent: pct,
                items_scanned: items.len() as u64,
                current_path: prof.profile_path.to_string_lossy().to_string(),
                bytes_found: items.iter().map(|i: &PrivacyItem| i.size_bytes).sum(),
                is_complete: false,
            });

            if prof.is_running {
                running_browsers.insert(prof.browser_name.clone());
            }

            if prof.browser_id == "firefox"
                || prof.browser_id == "librewolf"
                || prof.browser_id == "floorp"
                || prof.browser_id == "waterfox"
            {
                self.inspect_firefox_profile(&prof, &mut items);
            } else {
                self.inspect_chromium_profile(&prof, &mut items);
            }
        }

        on_progress(crate::shared::progress::AppScanProgress {
            scan_type: "privacy".to_string(),
            stage: "Analyzing system activity traces...".to_string(),
            percent: 90,
            items_scanned: items.len() as u64,
            current_path: "Windows Activity Traces".to_string(),
            bytes_found: items.iter().map(|i| i.size_bytes).sum(),
            is_complete: false,
        });

        // System Activity Traces
        self.inspect_system_activity(&mut items);

        let total_size_bytes = items.iter().map(|i| i.size_bytes).sum();
        let mut running_list: Vec<String> = running_browsers.into_iter().collect();
        running_list.sort();

        on_progress(crate::shared::progress::AppScanProgress {
            scan_type: "privacy".to_string(),
            stage: "Scan complete".to_string(),
            percent: 100,
            items_scanned: items.len() as u64,
            current_path: String::new(),
            bytes_found: total_size_bytes,
            is_complete: true,
        });

        Ok(PrivacyScanResult {
            items,
            total_size_bytes,
            running_browsers: running_list,
        })
    }

    pub fn clean_privacy_items(
        &self,
        item_ids: &[String],
        whitelist_domains: &[String],
    ) -> Result<u64, String> {
        self.clean_privacy_items_with_progress(item_ids, whitelist_domains, |_| {})
    }

    pub fn clean_privacy_items_with_progress<F>(
        &self,
        item_ids: &[String],
        whitelist_domains: &[String],
        mut on_progress: F,
    ) -> Result<u64, String>
    where
        F: FnMut(crate::shared::progress::AppScanProgress),
    {
        on_progress(crate::shared::progress::AppScanProgress {
            scan_type: "privacy".to_string(),
            stage: "Preparing privacy items for cleaning...".to_string(),
            percent: 5,
            items_scanned: 0,
            current_path: String::new(),
            bytes_found: 0,
            is_complete: false,
        });

        let scan_result = self.scan_privacy_items()?;
        let id_set: HashSet<&str> = item_ids.iter().map(|s| s.as_str()).collect();
        let matched_items: Vec<_> = scan_result
            .items
            .into_iter()
            .filter(|i| id_set.contains(i.id.as_str()))
            .collect();
        let total_count = matched_items.len().max(1);
        let mut total_reclaimed = 0u64;

        for (idx, item) in matched_items.into_iter().enumerate() {
            let pct = (10 + ((idx as f32 / total_count as f32) * 85.0) as u8).min(95);
            on_progress(crate::shared::progress::AppScanProgress {
                scan_type: "privacy".to_string(),
                stage: format!("Cleaning {}", item.title),
                percent: pct,
                items_scanned: (idx + 1) as u64,
                current_path: item.paths.first().cloned().unwrap_or_default(),
                bytes_found: total_reclaimed,
                is_complete: false,
            });

            // If browser is running and locks SQLite DBs, skip locked database items safely
            if item.is_locked
                && (item.category == PrivacyCategoryKind::History
                    || item.category == PrivacyCategoryKind::Cookies)
            {
                continue;
            }

            // CRITICAL BOOKMARK PROTECTION: Firefox & Gecko Browsers History
            // Never trash places.sqlite directly as it holds user bookmarks!
            if item.category == PrivacyCategoryKind::History
                && (item.browser_id == "firefox"
                    || item.browser_id == "librewolf"
                    || item.browser_id == "floorp"
                    || item.browser_id == "waterfox")
            {
                for p_str in &item.paths {
                    let path = Path::new(p_str);
                    if path.exists() {
                        total_reclaimed += clean_firefox_places_history_safely(path);
                    }
                }
                continue;
            }

            // Cookie Whitelist preservation
            if item.category == PrivacyCategoryKind::Cookies && !whitelist_domains.is_empty() {
                let reclaimed = self.clean_cookies_with_whitelist(&item.paths, whitelist_domains);
                total_reclaimed += reclaimed;
                continue;
            }

            for p_str in &item.paths {
                let path = Path::new(p_str);
                if !path.exists() {
                    continue;
                }

                let (size, _) = calculate_path_metrics(path);
                // Trash-First invariant
                if self.fs_platform.trash_path(path).is_ok() {
                    total_reclaimed += size;
                } else if item.category == PrivacyCategoryKind::Cache {
                    // For rebuildable cache folders and files, fall back to tolerant removal
                    let cancel = crate::shared::progress::CancellationToken::new();
                    let (freed, _) =
                        crate::cleanup::disposal::execute_tolerant_permanent_delete(path, &cancel);
                    total_reclaimed += if freed > 0 { freed } else { size };
                }
            }
        }

        // Discrete clipboard vs system activity dispatch
        if id_set.contains("system:clipboard") {
            let reclaimed = self.platform.clean_clipboard().unwrap_or(0);
            total_reclaimed += reclaimed;
        }

        if id_set.contains("system:recent_activity") {
            let reclaimed = self.platform.clean_system_activity_traces().unwrap_or(0);
            total_reclaimed += reclaimed;
        }

        on_progress(crate::shared::progress::AppScanProgress {
            scan_type: "privacy".to_string(),
            stage: "Privacy cleaning completed".to_string(),
            percent: 100,
            items_scanned: total_count as u64,
            current_path: String::new(),
            bytes_found: total_reclaimed,
            is_complete: true,
        });

        Ok(total_reclaimed)
    }

    fn inspect_chromium_profile(&self, prof: &RawBrowserProfile, items: &mut Vec<PrivacyItem>) {
        let p = &prof.profile_path;

        // 1. Browser Cache (inclusive of disk cache, GPU cache, Code cache, Shader cache)
        let mut cache_paths = Vec::new();
        let possible_caches = [
            p.join("Cache"),
            p.join("GPUCache"),
            p.join("Code Cache"),
            p.join("DawnGraphiteCache"),
            p.join("DawnWebGPUCache"),
            p.join("ShaderCache"),
            p.join(r"Service Worker\CacheStorage"),
            p.join(r"Service Worker\ScriptCache"),
            p.join("blob_storage"),
        ];
        for c in &possible_caches {
            if c.exists() {
                cache_paths.push(c.clone());
            }
        }

        // Special handling for Opera / Opera GX: Cache is stored in LOCALAPPDATA
        if prof.browser_id.starts_with("opera") {
            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                let opera_local = if prof.browser_id == "opera_gx" {
                    PathBuf::from(local).join(r"Opera Software\Opera GX Stable")
                } else {
                    PathBuf::from(local).join(r"Opera Software\Opera Stable")
                };
                for sub in &["Cache", "GPUCache", "Code Cache", "ShaderCache"] {
                    let cp = opera_local.join(sub);
                    if cp.exists() && !cache_paths.contains(&cp) {
                        cache_paths.push(cp);
                    }
                }
            }
        }

        if !cache_paths.is_empty() {
            let (size, count) = sum_path_metrics(&cache_paths);
            if size > 0 {
                items.push(PrivacyItem {
                    id: format!("{}:{}:cache", prof.browser_id, prof.profile_name),
                    browser_id: prof.browser_id.clone(),
                    browser_name: prof.browser_name.clone(),
                    profile_name: prof.profile_name.clone(),
                    category: PrivacyCategoryKind::Cache,
                    title: format!("{} Cache ({})", prof.browser_name, prof.profile_name),
                    description:
                        "Cached web resources, images, v8 compiled scripts, and GPU shaders."
                            .to_string(),
                    size_bytes: size,
                    item_count: count,
                    is_locked: false,
                    paths: cache_paths
                        .iter()
                        .map(|p| p.to_string_lossy().to_string())
                        .collect(),
                });
            }
        }

        // 2. Browsing History & Companion WAL Files
        let hist = p.join("History");
        if hist.exists() {
            let mut hist_paths = vec![hist.clone()];
            for ext in &[
                "History-wal",
                "History-shm",
                "History-journal",
                "Top Sites",
                "Top Sites-wal",
                "Top Sites-shm",
                "Shortcuts",
                "Shortcuts-wal",
            ] {
                let extra = p.join(ext);
                if extra.exists() {
                    hist_paths.push(extra);
                }
            }
            let (size, count) = sum_path_metrics(&hist_paths);
            items.push(PrivacyItem {
                id: format!("{}:{}:history", prof.browser_id, prof.profile_name),
                browser_id: prof.browser_id.clone(),
                browser_name: prof.browser_name.clone(),
                profile_name: prof.profile_name.clone(),
                category: PrivacyCategoryKind::History,
                title: format!(
                    "{} Browsing History ({})",
                    prof.browser_name, prof.profile_name
                ),
                description:
                    "Visited URL records, page titles, search keywords, and visit timestamps."
                        .to_string(),
                size_bytes: size,
                item_count: count.max(1),
                is_locked: prof.is_running,
                paths: hist_paths
                    .iter()
                    .map(|p| p.to_string_lossy().to_string())
                    .collect(),
            });
        }

        // 3. Cookies & Storage with Companion WAL Files
        let cookies = p.join(r"Network\Cookies");
        let cookies_target = if cookies.exists() {
            cookies
        } else {
            p.join("Cookies")
        };
        if cookies_target.exists() {
            let mut cookie_paths = vec![cookies_target.clone()];
            let parent = cookies_target.parent().unwrap_or(p);
            for ext in &["Cookies-wal", "Cookies-shm", "Cookies-journal"] {
                let extra = parent.join(ext);
                if extra.exists() {
                    cookie_paths.push(extra);
                }
            }
            let (size, count) = sum_path_metrics(&cookie_paths);
            items.push(PrivacyItem {
                id: format!("{}:{}:cookies", prof.browser_id, prof.profile_name),
                browser_id: prof.browser_id.clone(),
                browser_name: prof.browser_name.clone(),
                profile_name: prof.profile_name.clone(),
                category: PrivacyCategoryKind::Cookies,
                title: format!(
                    "{} Cookies & Sessions ({})",
                    prof.browser_name, prof.profile_name
                ),
                description: "Website cookies, session tokens, and local web storage.".to_string(),
                size_bytes: size,
                item_count: count.max(1),
                is_locked: prof.is_running,
                paths: cookie_paths
                    .iter()
                    .map(|p| p.to_string_lossy().to_string())
                    .collect(),
            });
        }

        // 4. Session State & Tabs
        let sessions_dir = p.join("Sessions");
        if sessions_dir.exists() {
            let (size, count) = calculate_path_metrics(&sessions_dir);
            if size > 0 {
                items.push(PrivacyItem {
                    id: format!("{}:{}:sessions", prof.browser_id, prof.profile_name),
                    browser_id: prof.browser_id.clone(),
                    browser_name: prof.browser_name.clone(),
                    profile_name: prof.profile_name.clone(),
                    category: PrivacyCategoryKind::Sessions,
                    title: format!(
                        "{} Tab & Session Restores ({})",
                        prof.browser_name, prof.profile_name
                    ),
                    description: "Saved window and tab state data for session recovery."
                        .to_string(),
                    size_bytes: size,
                    item_count: count,
                    is_locked: prof.is_running,
                    paths: vec![sessions_dir.to_string_lossy().to_string()],
                });
            }
        }
    }

    fn inspect_firefox_profile(&self, prof: &RawBrowserProfile, items: &mut Vec<PrivacyItem>) {
        let p = &prof.profile_path;

        // Firefox & Gecko Web Cache in LOCALAPPDATA
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let vendor_folder = match prof.browser_id.as_str() {
                "librewolf" => r"librewolf\Profiles",
                "floorp" => r"Floorp\Profiles",
                "waterfox" => r"Waterfox\Profiles",
                _ => r"Mozilla\Firefox\Profiles",
            };
            let ff_cache = PathBuf::from(local)
                .join(vendor_folder)
                .join(&prof.profile_name)
                .join("cache2");
            if ff_cache.exists() {
                let (size, count) = calculate_path_metrics(&ff_cache);
                if size > 0 {
                    items.push(PrivacyItem {
                        id: format!("{}:{}:cache", prof.browser_id, prof.profile_name),
                        browser_id: prof.browser_id.clone(),
                        browser_name: prof.browser_name.clone(),
                        profile_name: prof.profile_name.clone(),
                        category: PrivacyCategoryKind::Cache,
                        title: format!("{} Web Cache ({})", prof.browser_name, prof.profile_name),
                        description: "Temporary offline images, scripts, and stylesheet cache."
                            .to_string(),
                        size_bytes: size,
                        item_count: count,
                        is_locked: false,
                        paths: vec![ff_cache.to_string_lossy().to_string()],
                    });
                }
            }
        }

        // Firefox & Gecko Browsing History (places.sqlite)
        let places = p.join("places.sqlite");
        if places.exists() {
            let (size, _) = calculate_path_metrics(&places);
            items.push(PrivacyItem {
                id: format!("{}:{}:history", prof.browser_id, prof.profile_name),
                browser_id: prof.browser_id.clone(),
                browser_name: prof.browser_name.clone(),
                profile_name: prof.profile_name.clone(),
                category: PrivacyCategoryKind::History,
                title: format!("{} Browsing History & Visits ({})", prof.browser_name, prof.profile_name),
                description: "Browsing visits, URL history, and download logs (bookmarks are safely preserved).".to_string(),
                size_bytes: size,
                item_count: 1,
                is_locked: prof.is_running,
                paths: vec![places.to_string_lossy().to_string()],
            });
        }

        // Firefox & Gecko Cookies
        let ff_cookies = p.join("cookies.sqlite");
        if ff_cookies.exists() {
            let (size, _) = calculate_path_metrics(&ff_cookies);
            items.push(PrivacyItem {
                id: format!("{}:{}:cookies", prof.browser_id, prof.profile_name),
                browser_id: prof.browser_id.clone(),
                browser_name: prof.browser_name.clone(),
                profile_name: prof.profile_name.clone(),
                category: PrivacyCategoryKind::Cookies,
                title: format!("{} Cookies ({})", prof.browser_name, prof.profile_name),
                description: "Website cookies and site authentication state in cookies.sqlite."
                    .to_string(),
                size_bytes: size,
                item_count: 1,
                is_locked: prof.is_running,
                paths: vec![ff_cookies.to_string_lossy().to_string()],
            });
        }
    }

    fn inspect_system_activity(&self, items: &mut Vec<PrivacyItem>) {
        if let Ok(app_data) = std::env::var("APPDATA") {
            let recent_dir = PathBuf::from(&app_data).join(r"Microsoft\Windows\Recent");
            if recent_dir.exists() {
                let (size, count) = calculate_path_metrics(&recent_dir);
                items.push(PrivacyItem {
                    id: "system:recent_activity".to_string(),
                    browser_id: "system".to_string(),
                    browser_name: "Windows System".to_string(),
                    profile_name: "Explorer & Shell".to_string(),
                    category: PrivacyCategoryKind::SystemActivity,
                    title: "Windows Activity Traces & Jump Lists".to_string(),
                    description: "Shortcuts, Run history, Explorer search queries, Open/Save dialog MRUs, Timeline activity, and UserAssist app tracking.".to_string(),
                    size_bytes: size.max(1024),
                    item_count: count.max(1),
                    is_locked: false,
                    paths: vec![recent_dir.to_string_lossy().to_string()],
                });
            }

            // Clipboard Memory Item
            items.push(PrivacyItem {
                id: "system:clipboard".to_string(),
                browser_id: "system".to_string(),
                browser_name: "Windows System".to_string(),
                profile_name: "Clipboard".to_string(),
                category: PrivacyCategoryKind::SystemActivity,
                title: "Windows Clipboard Memory Buffer".to_string(),
                description: "Purges currently copied sensitive text, images, and credentials from volatile clipboard memory.".to_string(),
                size_bytes: 4096,
                item_count: 1,
                is_locked: false,
                paths: Vec::new(),
            });

            // VSCode Recent Workspaces & State
            let ws_storage = PathBuf::from(&app_data).join(r"Code\User\workspaceStorage");
            if ws_storage.exists() {
                let (size, count) = calculate_path_metrics(&ws_storage);
                if count > 0 {
                    items.push(PrivacyItem {
                        id: "vscode:workspace_history".to_string(),
                        browser_id: "vscode".to_string(),
                        browser_name: "Visual Studio Code".to_string(),
                        profile_name: "Workspaces".to_string(),
                        category: PrivacyCategoryKind::History,
                        title: "VS Code Recent Workspaces & File States".to_string(),
                        description: "Cached workspace session states, file scroll positions, and recent folder links.".to_string(),
                        size_bytes: size,
                        item_count: count,
                        is_locked: false,
                        paths: vec![ws_storage.to_string_lossy().to_string()],
                    });
                }
            }
        }
    }

    fn clean_cookies_with_whitelist(&self, paths: &[String], whitelist: &[String]) -> u64 {
        let mut reclaimed = 0u64;
        let white_set: HashSet<String> = whitelist.iter().map(|d| d.to_lowercase()).collect();

        for p_str in paths {
            let path = Path::new(p_str);
            if !path.exists() {
                continue;
            }

            // Try opening SQLite database and delete non-whitelisted cookies
            if let Ok(conn) = rusqlite::Connection::open(path) {
                let table_info: Option<(String, String)> = conn
                    .query_row(
                        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('cookies', 'moz_cookies') LIMIT 1",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .ok()
                    .map(|tbl| {
                        if tbl == "moz_cookies" {
                            ("moz_cookies".to_string(), "host".to_string())
                        } else {
                            ("cookies".to_string(), "host_key".to_string())
                        }
                    });

                if let Some((table, col)) = table_info {
                    let mut where_clauses = Vec::new();
                    for domain in &white_set {
                        let clean_domain = domain.trim_start_matches('.').replace('\'', "''");
                        where_clauses.push(format!(
                            "({} NOT LIKE '%{}' AND {} != '{}')",
                            col, clean_domain, col, clean_domain
                        ));
                    }

                    if !where_clauses.is_empty() {
                        let query = format!(
                            "DELETE FROM {} WHERE {}",
                            table,
                            where_clauses.join(" AND ")
                        );
                        if let Ok(affected) = conn.execute(&query, []) {
                            if affected > 0 {
                                let _ = conn.execute("PRAGMA wal_checkpoint(TRUNCATE);", []);
                                let _ = conn.execute("VACUUM;", []);
                                reclaimed += affected as u64 * 128; // approximate bytes
                            }
                        }
                    }
                }
            }
        }

        reclaimed
    }
}

/// Safely cleans Firefox / Gecko places.sqlite history without ever deleting user bookmarks.
fn clean_firefox_places_history_safely(places_path: &Path) -> u64 {
    if !places_path.exists() {
        return 0;
    }
    let initial_size = places_path.metadata().map(|m| m.len()).unwrap_or(0);

    if let Ok(conn) = rusqlite::Connection::open(places_path) {
        // 1. Purge history visits, input history, annotations
        let _ = conn.execute("DELETE FROM moz_historyvisits;", []);
        let _ = conn.execute("DELETE FROM moz_inputhistory;", []);
        let _ = conn.execute("DELETE FROM moz_annos;", []);

        // 2. Delete history places that are NOT in user bookmarks!
        let _ = conn.execute(
            "DELETE FROM moz_places WHERE id NOT IN (SELECT fk FROM moz_bookmarks WHERE fk IS NOT NULL);",
            [],
        );

        // 3. Truncate WAL and vacuum database
        let _ = conn.execute("PRAGMA wal_checkpoint(TRUNCATE);", []);
        let _ = conn.execute("VACUUM;", []);
    }

    // Also clean companion favicons.sqlite (icon cache of visited sites)
    let favicons = places_path.with_file_name("favicons.sqlite");
    if favicons.exists() {
        if let Ok(conn) = rusqlite::Connection::open(&favicons) {
            let _ = conn.execute(
                "DELETE FROM moz_icons WHERE id NOT IN (SELECT icon_id FROM moz_icons_to_pages WHERE page_id IN (SELECT fk FROM moz_bookmarks WHERE fk IS NOT NULL));",
                [],
            );
            let _ = conn.execute("PRAGMA wal_checkpoint(TRUNCATE);", []);
            let _ = conn.execute("VACUUM;", []);
        }
    }

    let after_size = places_path.metadata().map(|m| m.len()).unwrap_or(0);
    initial_size.saturating_sub(after_size).max(1024)
}

fn calculate_path_metrics(path: &Path) -> (u64, u64) {
    if path.is_file() {
        return (path.metadata().map(|m| m.len()).unwrap_or(0), 1);
    }

    let mut size = 0u64;
    let mut count = 0u64;

    for entry in WalkDir::new(path)
        .min_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        count += 1;
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                size += meta.len();
            }
        }
    }

    (size, count)
}

fn sum_path_metrics(paths: &[PathBuf]) -> (u64, u64) {
    let mut total_size = 0u64;
    let mut total_count = 0u64;

    for p in paths {
        let (s, c) = calculate_path_metrics(p);
        total_size += s;
        total_count += c;
    }

    (total_size, total_count)
}

impl Default for PrivacyService {
    fn default() -> Self {
        Self::new()
    }
}
