pub mod elevation_client;
pub use elevation_client::{ElevatedClient, ElevatedRequest, ElevatedResponse};

use freemydisk_platform::{
    get_platform, EmergencyRescueSummary, MaintenanceTaskKind, PlatformSystemMaintenance,
};
use serde::{Deserialize, Serialize};

pub type EmergencyRescueResult = EmergencyRescueSummary;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaintenanceTask {
    pub id: String,
    pub title: String,
    pub description: String,
    pub kind: MaintenanceTaskKind,
    pub risk_level: String,
    pub recommended: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaintenanceResult {
    pub task_id: String,
    pub success: bool,
    pub message: String,
    #[serde(default)]
    pub duration_ms: u64,
}

pub struct MaintenanceService {
    platform: Box<dyn PlatformSystemMaintenance>,
}

impl MaintenanceService {
    pub fn new() -> Self {
        Self {
            platform: Box::new(get_platform()),
        }
    }

    pub fn with_platform(platform: Box<dyn PlatformSystemMaintenance>) -> Self {
        Self { platform }
    }

    pub fn list_tasks(&self) -> Vec<MaintenanceTask> {
        vec![
            MaintenanceTask {
                id: "icon_cache".to_string(),
                title: "Windows Icon & Thumbnail Cache Reset".to_string(),
                description: "Purges corrupted icon cache and thumbnail databases, restarting Windows Explorer to restore correct file icons.".to_string(),
                kind: MaintenanceTaskKind::IconCacheReset,
                risk_level: "Safe".to_string(),
                recommended: true,
            },
            MaintenanceTask {
                id: "dns_flush".to_string(),
                title: "DNS Resolver Cache Flush".to_string(),
                description: "Flushes the local DNS client cache to resolve domain resolution errors and stale network routing.".to_string(),
                kind: MaintenanceTaskKind::DnsCacheFlush,
                risk_level: "Safe".to_string(),
                recommended: true,
            },
            MaintenanceTask {
                id: "search_index".to_string(),
                title: "Windows Search Index Rebuilder".to_string(),
                description: "Resets the Windows Search database catalog (Windows.edb) to fix search indexing stalls and high background disk utilization.".to_string(),
                kind: MaintenanceTaskKind::SearchIndexRebuild,
                risk_level: "Safe".to_string(),
                recommended: true,
            },
            MaintenanceTask {
                id: "update_cache".to_string(),
                title: "Windows Update Download Cache Purge".to_string(),
                description: "Stops the update service and purges pending or corrupted SoftwareDistribution download files to free disk space.".to_string(),
                kind: MaintenanceTaskKind::WindowsUpdateCacheCleanup,
                risk_level: "Moderate".to_string(),
                recommended: true,
            },
            MaintenanceTask {
                id: "network_reset".to_string(),
                title: "TCP/IP & Winsock Stack Reset".to_string(),
                description: "Resets the Winsock catalog and TCP/IP stack configuration back to clean system defaults to recover from network protocol corruption.".to_string(),
                kind: MaintenanceTaskKind::NetworkStackReset,
                risk_level: "Moderate".to_string(),
                recommended: false,
            },
            MaintenanceTask {
                id: "print_queue".to_string(),
                title: "Print Spooler Stuck Jobs Reset".to_string(),
                description: "Purges orphaned spool files from Windows PRINTERS queue and restarts the Print Spooler service to fix stalled print queues.".to_string(),
                kind: MaintenanceTaskKind::PrintQueuePurge,
                risk_level: "Safe".to_string(),
                recommended: true,
            },
            MaintenanceTask {
                id: "audio_service".to_string(),
                title: "Windows Audio Engine Restarter".to_string(),
                description: "Restarts Audiosrv and AudioEndpointBuilder services to recover audio output from driver crashes or missing sound devices without rebooting.".to_string(),
                kind: MaintenanceTaskKind::AudioServiceReset,
                risk_level: "Safe".to_string(),
                recommended: true,
            },
            MaintenanceTask {
                id: "time_sync".to_string(),
                title: "Windows Clock Resynchronizer (NTP)".to_string(),
                description: "Ensures the Windows Time service is running and triggers an authoritative network time resync (/resync /force) to eliminate clock drift.".to_string(),
                kind: MaintenanceTaskKind::TimeServiceSync,
                risk_level: "Safe".to_string(),
                recommended: true,
            },
            MaintenanceTask {
                id: "store_cache".to_string(),
                title: "Microsoft Store Cache Reset (wsreset)".to_string(),
                description: "Executes wsreset to clear corrupt store manifest caches and repair stalled Microsoft Store app installations and updates.".to_string(),
                kind: MaintenanceTaskKind::StoreCacheReset,
                risk_level: "Safe".to_string(),
                recommended: true,
            },
            MaintenanceTask {
                id: "system_integrity".to_string(),
                title: "System Integrity Health Check (DISM & SFC)".to_string(),
                description: "Runs Windows DISM component store cleanup (/RestoreHealth) followed by SFC scan to detect and auto-repair corrupted OS binaries.".to_string(),
                kind: MaintenanceTaskKind::SystemIntegrityRepair,
                risk_level: "Moderate".to_string(),
                recommended: false,
            },
        ]
    }

    pub fn execute_task(&self, task_id: &str) -> MaintenanceResult {
        let tasks = self.list_tasks();
        let target = match tasks.into_iter().find(|t| t.id == task_id) {
            Some(t) => t,
            None => {
                return MaintenanceResult {
                    task_id: task_id.to_string(),
                    success: false,
                    message: format!("Unknown maintenance task ID: '{}'", task_id),
                    duration_ms: 0,
                }
            }
        };

        let start = std::time::Instant::now();
        let (success, message) = match self.platform.execute_maintenance_task(target.kind) {
            Ok(msg) => (true, msg),
            Err(e) => {
                let helper_op = match target.kind {
                    MaintenanceTaskKind::WindowsUpdateCacheCleanup => {
                        Some("clean_software_distribution")
                    }
                    MaintenanceTaskKind::SystemIntegrityRepair => Some("system_integrity_repair"),
                    MaintenanceTaskKind::NetworkStackReset => Some("network_reset"),
                    MaintenanceTaskKind::SearchIndexRebuild => Some("rebuild_search_index"),
                    MaintenanceTaskKind::PrintQueuePurge => Some("print_queue_purge"),
                    MaintenanceTaskKind::AudioServiceReset => Some("audio_service_reset"),
                    MaintenanceTaskKind::TimeServiceSync => Some("time_service_sync"),
                    _ => None,
                };

                if let Some(op) = helper_op {
                    match ElevatedClient::execute_action(op, "") {
                        Ok(resp) => (resp.success, resp.message),
                        Err(_) => (false, e.to_string()),
                    }
                } else {
                    (false, e.to_string())
                }
            }
        };
        let duration_ms = start.elapsed().as_millis() as u64;

        MaintenanceResult {
            task_id: task_id.to_string(),
            success,
            message,
            duration_ms,
        }
    }

    pub fn execute_all_recommended(&self) -> Vec<MaintenanceResult> {
        self.list_tasks()
            .into_iter()
            .filter(|t| t.recommended)
            .map(|t| self.execute_task(&t.id))
            .collect()
    }

    pub fn execute_emergency_rescue(&self) -> Result<EmergencyRescueSummary, String> {
        self.platform
            .execute_emergency_rescue()
            .map_err(|e| e.to_string())
    }
}

impl Default for MaintenanceService {
    fn default() -> Self {
        Self::new()
    }
}
