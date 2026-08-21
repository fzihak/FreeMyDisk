pub mod docker;
pub mod hyperv;
pub mod models;
pub mod wsl;

pub use docker::DockerManager;
pub use hyperv::HyperVScanner;
pub use models::*;
pub use wsl::WslManager;

/// Aggregates space and state telemetry across WSL2 distributions, Docker Desktop, and VM disks.
pub fn get_virtualization_overview() -> VirtualizationOverview {
    let wsl_distributions = WslManager::list_distributions().unwrap_or_default();
    let wsl_installed = !wsl_distributions.is_empty();

    let total_wsl_bytes = wsl_distributions.iter().map(|d| d.vhdx_actual_bytes).sum();
    let total_wsl_reclaimable = wsl_distributions
        .iter()
        .map(|d| d.reclaimable_estimate)
        .sum();

    let docker = DockerManager::get_docker_info();

    let hyperv_disks = HyperVScanner::scan_vm_disks();
    let total_vm_bytes = hyperv_disks.iter().map(|d| d.size_bytes).sum();

    VirtualizationOverview {
        wsl_installed,
        wsl_distributions,
        total_wsl_bytes,
        total_wsl_reclaimable,
        docker,
        hyperv_disks,
        total_vm_bytes,
    }
}
