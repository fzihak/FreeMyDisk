use freemydisk_core::virtualization::{
    get_virtualization_overview, DockerManager, HyperVScanner, WslManager,
};

#[test]
fn test_wsl_distribution_discovery() {
    let distros = WslManager::list_distributions();
    assert!(distros.is_ok());

    if let Ok(d_list) = distros {
        for d in &d_list {
            assert!(!d.name.is_empty());
            assert!(
                d.vhdx_path.to_string_lossy().ends_with(".vhdx")
                    || !d.vhdx_path.as_os_str().is_empty()
            );
        }
    }
}

#[test]
fn test_docker_info_resilience() {
    // Must return cleanly and never panic regardless of whether Docker is installed or daemon is stopped
    let info = DockerManager::get_docker_info();
    if !info.is_installed || !info.is_running {
        assert_eq!(info.categories.len(), 0);
    }
}

#[test]
fn test_hyperv_scanner() {
    let disks = HyperVScanner::scan_vm_disks();
    for disk in disks {
        assert!(!disk.vm_name.is_empty());
        assert!(disk.disk_path.exists());
    }
}

#[test]
fn test_virtualization_overview_aggregation() {
    let overview = get_virtualization_overview();
    if overview.wsl_installed {
        assert!(!overview.wsl_distributions.is_empty());
        assert!(overview.total_wsl_bytes > 0);
    }
}

#[test]
fn test_wsl_compaction_validation_guards() {
    // 1. Empty string must fail gracefully with descriptive error
    let res_empty = WslManager::compact_distribution("");
    assert!(res_empty.is_err());
    assert!(res_empty
        .unwrap_err()
        .to_string()
        .contains("cannot be empty"));

    // 2. Whitespace-only string must also fail gracefully
    let res_spaces = WslManager::compact_distribution("   ");
    assert!(res_spaces.is_err());
    assert!(res_spaces
        .unwrap_err()
        .to_string()
        .contains("cannot be empty"));

    // 3. Nonexistent distro name must cleanly report not found without panicking
    let res_fake = WslManager::compact_distribution("__fmd_nonexistent_distro_xyz123__");
    assert!(res_fake.is_err());
    let err_msg = res_fake.unwrap_err().to_string();
    assert!(err_msg.contains("not found"));
}
