use freemydisk_core::system_maintenance::MaintenanceService;
use freemydisk_platform::{MaintenanceTaskKind, PlatformError, PlatformSystemMaintenance};
use std::sync::{Arc, Mutex};

struct MockMaintenancePlatform {
    executed_tasks: Arc<Mutex<Vec<MaintenanceTaskKind>>>,
}

impl PlatformSystemMaintenance for MockMaintenancePlatform {
    fn execute_maintenance_task(&self, task: MaintenanceTaskKind) -> Result<String, PlatformError> {
        self.executed_tasks.lock().unwrap().push(task);
        Ok(format!("Successfully executed task: {:?}", task))
    }

    fn execute_emergency_rescue(
        &self,
    ) -> Result<freemydisk_platform::EmergencyRescueSummary, PlatformError> {
        Ok(freemydisk_platform::EmergencyRescueSummary {
            total_bytes_reclaimed: 1024 * 1024 * 1024,
            hibernation_disabled: true,
            recycle_bin_emptied: true,
            temp_cleaned_bytes: 512 * 1024 * 1024,
            wsl_shutdown: true,
            actions_performed: vec!["Mock rescue executed".to_string()],
        })
    }
}

#[test]
fn test_maintenance_catalog_and_execution() {
    let executed = Arc::new(Mutex::new(Vec::new()));
    let platform = Box::new(MockMaintenancePlatform {
        executed_tasks: Arc::clone(&executed),
    });

    let service = MaintenanceService::with_platform(platform);
    let tasks = service.list_tasks();

    assert_eq!(tasks.len(), 10);
    assert!(tasks.iter().any(|t| t.id == "icon_cache" && t.recommended));
    assert!(tasks.iter().any(|t| t.id == "dns_flush" && t.recommended));
    assert!(tasks
        .iter()
        .any(|t| t.id == "search_index" && t.recommended));
    assert!(tasks
        .iter()
        .any(|t| t.id == "update_cache" && t.recommended));
    assert!(tasks
        .iter()
        .any(|t| t.id == "network_reset" && !t.recommended));
    assert!(tasks.iter().any(|t| t.id == "print_queue" && t.recommended));
    assert!(tasks
        .iter()
        .any(|t| t.id == "audio_service" && t.recommended));
    assert!(tasks.iter().any(|t| t.id == "time_sync" && t.recommended));
    assert!(tasks.iter().any(|t| t.id == "store_cache" && t.recommended));
    assert!(tasks
        .iter()
        .any(|t| t.id == "system_integrity" && !t.recommended));

    // Execute single task
    let res = service.execute_task("dns_flush");
    assert!(res.success);
    assert!(res.message.contains("DnsCacheFlush"));
    assert_eq!(executed.lock().unwrap().len(), 1);
    assert_eq!(
        executed.lock().unwrap()[0],
        MaintenanceTaskKind::DnsCacheFlush
    );

    // Execute all recommended (8 tasks)
    executed.lock().unwrap().clear();
    let batch_res = service.execute_all_recommended();
    assert_eq!(batch_res.len(), 8);
    assert!(batch_res.iter().all(|r| r.success));
    assert_eq!(executed.lock().unwrap().len(), 8);
}
