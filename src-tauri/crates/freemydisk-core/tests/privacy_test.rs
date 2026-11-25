use freemydisk_core::privacy::{PrivacyCategoryKind, PrivacyService};
use freemydisk_platform::{
    FileIdentity, PlatformError, PlatformFilesystem, PlatformPrivacy, RawBrowserProfile,
    StorageVolumeInfo,
};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

struct MockPrivacyPlatform {
    profiles: Vec<RawBrowserProfile>,
    cleaned_activity_called: Arc<Mutex<bool>>,
}

impl PlatformPrivacy for MockPrivacyPlatform {
    fn list_browser_profiles(&self) -> Result<Vec<RawBrowserProfile>, PlatformError> {
        Ok(self.profiles.clone())
    }

    fn clean_system_activity_traces(&self) -> Result<u64, PlatformError> {
        *self.cleaned_activity_called.lock().unwrap() = true;
        Ok(1024 * 1024)
    }
}

struct MockFsPlatform {
    trashed: Arc<Mutex<Vec<PathBuf>>>,
}

impl PlatformFilesystem for MockFsPlatform {
    fn trash_path(&self, path: &Path) -> Result<(), PlatformError> {
        self.trashed.lock().unwrap().push(path.to_path_buf());
        Ok(())
    }

    fn is_cloud_placeholder(&self, _path: &Path) -> Result<bool, PlatformError> {
        Ok(false)
    }

    fn get_file_identity(&self, _path: &Path) -> Result<FileIdentity, PlatformError> {
        Ok(FileIdentity {
            device_id: 1,
            file_index: 1,
            link_count: 1,
            is_reparse_or_symlink: false,
        })
    }

    fn acquire_cross_process_lock(
        &self,
        _lock_path: &Path,
    ) -> Result<Box<dyn std::any::Any + Send + Sync>, PlatformError> {
        Ok(Box::new(()))
    }

    fn list_volumes(&self) -> Result<Vec<StorageVolumeInfo>, PlatformError> {
        Ok(Vec::new())
    }
}

#[test]
fn test_privacy_scanning_and_cleaning() {
    let temp_dir = tempfile::tempdir().unwrap();
    let profile_dir = temp_dir.path().join("Default");
    let cache_dir = profile_dir.join(r"Cache\Cache_Data");
    std::fs::create_dir_all(&cache_dir).unwrap();
    std::fs::write(cache_dir.join("data_0"), "cached web content").unwrap();

    let history_file = profile_dir.join("History");
    std::fs::write(&history_file, "sqlite history data").unwrap();

    let mock_profiles = vec![RawBrowserProfile {
        browser_id: "chrome".to_string(),
        browser_name: "Google Chrome".to_string(),
        profile_name: "Default".to_string(),
        profile_path: profile_dir,
        is_running: false,
    }];

    let cleaned_activity = Arc::new(Mutex::new(false));
    let trashed_paths = Arc::new(Mutex::new(Vec::new()));

    let priv_platform = Box::new(MockPrivacyPlatform {
        profiles: mock_profiles,
        cleaned_activity_called: Arc::clone(&cleaned_activity),
    });
    let fs_platform = Box::new(MockFsPlatform {
        trashed: Arc::clone(&trashed_paths),
    });

    let service = PrivacyService::with_platform(priv_platform, fs_platform);
    let scan_res = service
        .scan_privacy_items()
        .expect("Scan privacy items should succeed");

    assert!(!scan_res.items.is_empty());
    let cache_item = scan_res
        .items
        .iter()
        .find(|i| i.category == PrivacyCategoryKind::Cache)
        .expect("Cache item should exist");
    assert_eq!(cache_item.browser_id, "chrome");
    assert!(cache_item.size_bytes > 0);

    let history_item = scan_res
        .items
        .iter()
        .find(|i| i.category == PrivacyCategoryKind::History)
        .expect("History item should exist");
    assert_eq!(history_item.profile_name, "Default");

    // Test clean privacy items
    let to_clean = vec![cache_item.id.clone(), "system:recent_activity".to_string()];
    let reclaimed = service
        .clean_privacy_items(&to_clean, &["google.com".to_string()])
        .expect("Clean should succeed");

    assert!(reclaimed > 0);
    assert!(*cleaned_activity.lock().unwrap());
    assert!(!trashed_paths.lock().unwrap().is_empty());
}

#[test]
fn test_firefox_places_bookmark_preservation() {
    let temp_dir = tempfile::tempdir().unwrap();
    let profile_dir = temp_dir.path().join("firefox_prof");
    std::fs::create_dir_all(&profile_dir).unwrap();

    let places_path = profile_dir.join("places.sqlite");
    {
        let conn = rusqlite::Connection::open(&places_path).unwrap();
        conn.execute(
            "CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT);",
            [],
        )
        .unwrap();
        conn.execute(
            "CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, fk INTEGER, title TEXT);",
            [],
        )
        .unwrap();
        conn.execute(
            "CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER);",
            [],
        )
        .unwrap();
        conn.execute(
            "CREATE TABLE moz_inputhistory (place_id INTEGER, input TEXT);",
            [],
        )
        .unwrap();
        conn.execute(
            "CREATE TABLE moz_annos (id INTEGER PRIMARY KEY, place_id INTEGER);",
            [],
        )
        .unwrap();

        // 1. Place 1 is bookmarked
        conn.execute(
            "INSERT INTO moz_places (id, url, title) VALUES (1, 'https://github.com', 'GitHub');",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO moz_bookmarks (id, fk, title) VALUES (10, 1, 'My Bookmark');",
            [],
        )
        .unwrap();

        // 2. Place 2 is an unbookmarked historical visit
        conn.execute(
            "INSERT INTO moz_places (id, url, title) VALUES (2, 'https://reddit.com', 'Reddit');",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO moz_historyvisits (id, place_id, visit_date) VALUES (100, 2, 1700000000);",
            [],
        )
        .unwrap();
    }

    let mock_profiles = vec![RawBrowserProfile {
        browser_id: "firefox".to_string(),
        browser_name: "Mozilla Firefox".to_string(),
        profile_name: "firefox_prof".to_string(),
        profile_path: profile_dir,
        is_running: false,
    }];

    let priv_platform = Box::new(MockPrivacyPlatform {
        profiles: mock_profiles,
        cleaned_activity_called: Arc::new(Mutex::new(false)),
    });
    let fs_platform = Box::new(MockFsPlatform {
        trashed: Arc::new(Mutex::new(Vec::new())),
    });

    let service = PrivacyService::with_platform(priv_platform, fs_platform);
    let scan = service.scan_privacy_items().unwrap();
    let history_item = scan
        .items
        .into_iter()
        .find(|i| i.category == PrivacyCategoryKind::History)
        .unwrap();

    let reclaimed = service
        .clean_privacy_items(&[history_item.id], &[])
        .unwrap();
    assert!(reclaimed > 0);

    // Verify places.sqlite still exists on disk (NEVER trashed!)
    assert!(places_path.exists());

    // Verify bookmark is still intact, but reddit history visit is gone
    let conn = rusqlite::Connection::open(&places_path).unwrap();
    let bookmark_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM moz_bookmarks;", [], |row| row.get(0))
        .unwrap();
    assert_eq!(bookmark_count, 1);

    let bookmarked_place: String = conn
        .query_row("SELECT url FROM moz_places WHERE id = 1;", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(bookmarked_place, "https://github.com");

    let unbookmarked_exists: i64 = conn
        .query_row("SELECT COUNT(*) FROM moz_places WHERE id = 2;", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(unbookmarked_exists, 0);

    let visits_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM moz_historyvisits;", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(visits_count, 0);
}
