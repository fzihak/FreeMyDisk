use freemydisk_core::startup::{StartupImpact, StartupService};
use freemydisk_platform::{PlatformError, PlatformStartup, RawStartupEntry};
use std::sync::{Arc, Mutex};

struct MockStartupPlatform {
    entries: Arc<Mutex<Vec<RawStartupEntry>>>,
}

impl PlatformStartup for MockStartupPlatform {
    fn list_startup_entries(&self) -> Result<Vec<RawStartupEntry>, PlatformError> {
        Ok(self.entries.lock().unwrap().clone())
    }

    fn set_startup_entry_state(&self, entry_id: &str, enable: bool) -> Result<(), PlatformError> {
        let mut list = self.entries.lock().unwrap();
        if let Some(item) = list.iter_mut().find(|e| e.id == entry_id) {
            item.enabled = enable;
            Ok(())
        } else {
            Err(PlatformError::OperationFailed(format!(
                "Not found: {}",
                entry_id
            )))
        }
    }

    fn delete_startup_entry(&self, entry_id: &str) -> Result<(), PlatformError> {
        let mut list = self.entries.lock().unwrap();
        list.retain(|e| e.id != entry_id);
        Ok(())
    }
}

#[test]
fn test_startup_impact_and_critical_protection() {
    let mock_entries = vec![
        RawStartupEntry {
            id: "hkcu:run:Spotify".to_string(),
            name: "Spotify".to_string(),
            command: r#""C:\Users\foysa\AppData\Roaming\Spotify\Spotify.exe" --minimized"#
                .to_string(),
            location: r"HKCU\Run".to_string(),
            enabled: true,
            target_path: Some(r"C:\Users\foysa\AppData\Roaming\Spotify\Spotify.exe".to_string()),
        },
        RawStartupEntry {
            id: "hkcu:run:Discord".to_string(),
            name: "Discord".to_string(),
            command: r#""C:\Users\foysa\AppData\Local\Discord\app-1.0.9000\Discord.exe""#
                .to_string(),
            location: r"HKCU\Run".to_string(),
            enabled: true,
            target_path: Some(
                r"C:\Users\foysa\AppData\Local\Discord\app-1.0.9000\Discord.exe".to_string(),
            ),
        },
        RawStartupEntry {
            id: "hklm:run:WindowsDefender".to_string(),
            name: "SecurityHealthHost".to_string(),
            command: r"C:\Windows\System32\SecurityHealthSystray.exe".to_string(),
            location: r"HKLM\Run".to_string(),
            enabled: true,
            target_path: Some(r"C:\Windows\System32\SecurityHealthSystray.exe".to_string()),
        },
        RawStartupEntry {
            id: "folder:user:MyUtility.lnk".to_string(),
            name: "MyUtility".to_string(),
            command: r"C:\Tools\utility.exe".to_string(),
            location: "User Startup Folder".to_string(),
            enabled: true,
            target_path: Some(r"C:\Tools\utility.exe".to_string()),
        },
    ];

    let platform = Box::new(MockStartupPlatform {
        entries: Arc::new(Mutex::new(mock_entries)),
    });

    let service = StartupService::with_platform(platform);
    let items = service
        .list_startup_items()
        .expect("Failed to list startup items");

    assert_eq!(items.len(), 4);

    let spotify = items.iter().find(|i| i.name == "Spotify").unwrap();
    assert_eq!(spotify.impact, StartupImpact::High);
    assert!(!spotify.is_critical);

    let discord = items.iter().find(|i| i.name == "Discord").unwrap();
    assert_eq!(discord.impact, StartupImpact::High);

    let defender = items
        .iter()
        .find(|i| i.name == "SecurityHealthHost")
        .unwrap();
    assert!(defender.is_critical);

    let utility = items.iter().find(|i| i.name == "MyUtility").unwrap();
    assert_eq!(utility.impact, StartupImpact::Low);
    assert!(!utility.is_critical);

    // Test safety invariant: critical system items CANNOT be disabled
    let disable_res = service.toggle_startup_item("hklm:run:WindowsDefender", false);
    assert!(disable_res.is_err());
    assert!(disable_res
        .unwrap_err()
        .contains("Refusing to disable critical system startup entry"));

    // Non-critical items CAN be disabled
    assert!(service
        .toggle_startup_item("hkcu:run:Spotify", false)
        .is_ok());
    let updated_items = service.list_startup_items().unwrap();
    let updated_spotify = updated_items.iter().find(|i| i.name == "Spotify").unwrap();
    assert!(!updated_spotify.enabled);

    // Non-critical items CAN be deleted
    assert!(service.delete_startup_item("hkcu:run:Discord").is_ok());
    let remaining_items = service.list_startup_items().unwrap();
    assert_eq!(remaining_items.len(), 3);
    assert!(remaining_items.iter().all(|i| i.name != "Discord"));
}
