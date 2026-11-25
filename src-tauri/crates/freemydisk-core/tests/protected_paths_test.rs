use freemydisk_core::cleanup::protected_paths::{ProtectedPathRegistry, CRITICAL_PATHS_WINDOWS};
use std::path::Path;

#[test]
fn test_protected_paths_rejection_windows() {
    for &crit in CRITICAL_PATHS_WINDOWS {
        let path = Path::new(crit);
        assert!(
            ProtectedPathRegistry::is_protected(path),
            "Critical path '{}' must be protected",
            crit
        );
        assert!(
            ProtectedPathRegistry::assert_safe_for_disposal(path).is_err(),
            "Disposal assertion must fail for '{}'",
            crit
        );

        // Case insensitivity test
        let lower = crit.to_ascii_lowercase();
        let lower_path = Path::new(&lower);
        assert!(
            ProtectedPathRegistry::is_protected(lower_path),
            "Lowercase critical path '{}' must be protected",
            lower
        );
    }
}

#[test]
fn test_subpaths_inside_critical_system_are_protected() {
    let sub = Path::new(r"C:\Windows\System32\drivers\etc");
    assert!(ProtectedPathRegistry::is_protected(sub));

    let prog = Path::new(r"C:\Program Files\Common Files\System");
    assert!(ProtectedPathRegistry::is_protected(prog));
}

#[test]
fn test_safe_user_paths_are_not_protected() {
    let safe_temp = std::env::temp_dir().join("freemydisk_test_safe_target");
    assert!(!ProtectedPathRegistry::is_protected(&safe_temp));
    assert!(ProtectedPathRegistry::assert_safe_for_disposal(&safe_temp).is_ok());
}

#[test]
fn test_self_preservation_blocks_internal_assets() {
    let self_db = Path::new(r"C:\Users\test\AppData\Roaming\FreeMyDisk\freemydisk.db");
    assert!(ProtectedPathRegistry::is_self_asset(self_db));
    assert!(ProtectedPathRegistry::assert_safe_for_disposal(self_db).is_err());

    let journal_db = Path::new(r"C:\Users\test\AppData\Roaming\FreeMyDisk\journal.db");
    assert!(ProtectedPathRegistry::is_self_asset(journal_db));
    assert!(ProtectedPathRegistry::assert_safe_for_disposal(journal_db).is_err());

    let exe = Path::new(r"C:\Program Files\FreeMyDisk\freemydisk.exe");
    assert!(ProtectedPathRegistry::is_self_asset(exe));
    assert!(ProtectedPathRegistry::assert_safe_for_disposal(exe).is_err());
}

#[cfg(target_os = "windows")]
#[test]
fn test_volume_roots_and_profile_folders_cannot_be_disposed() {
    use std::path::PathBuf;

    let profile = PathBuf::from(std::env::var("USERPROFILE").expect("USERPROFILE"));
    let users_root = profile.parent().expect("profile parent").to_path_buf();

    let blocked = [
        PathBuf::from(r"D:\"),
        PathBuf::from(r"Z:"),
        PathBuf::from(r"\\server\share"),
        users_root.clone(),
        users_root.join("SomeOtherUser"),
        profile.clone(),
        profile.join("Desktop"),
        profile.join("Documents"),
        profile.join(r"AppData\Local"),
    ];
    for path in &blocked {
        assert!(
            ProtectedPathRegistry::assert_safe_for_disposal(path).is_err(),
            "{} must be protected",
            path.display()
        );
    }

    let allowed = [
        profile.join(r"Desktop\old-report.pdf"),
        profile.join(r"Downloads\setup.exe"),
        PathBuf::from(r"D:\Projects\app\node_modules"),
    ];
    for path in &allowed {
        assert!(
            ProtectedPathRegistry::assert_safe_for_disposal(path).is_ok(),
            "{} must stay disposable",
            path.display()
        );
    }
}

#[cfg(target_os = "windows")]
#[test]
fn test_rule_approved_system_caches_are_disposable_but_their_folders_are_not() {
    use std::path::PathBuf;

    let win = PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into()));
    let download = win.join(r"SoftwareDistribution\Download");

    assert!(!ProtectedPathRegistry::is_protected(
        &download.join("a1b2c3")
    ));
    assert!(!ProtectedPathRegistry::is_protected(
        &win.join(r"System32\winevt\Logs\Archive-Application-2026.evtx")
    ));
    assert!(!ProtectedPathRegistry::is_protected(
        &win.join("MEMORY.DMP")
    ));

    assert!(ProtectedPathRegistry::is_protected(&download));
    assert!(ProtectedPathRegistry::is_protected(
        &win.join(r"System32\winevt\Logs\Security.evtx")
    ));
    assert!(ProtectedPathRegistry::is_protected(
        &win.join(r"SoftwareDistribution\DataStore")
    ));
    assert!(ProtectedPathRegistry::is_protected(
        &download.join(r"..\..\System32")
    ));
}

#[cfg(unix)]
#[test]
fn test_unix_system_and_home_folders_are_protected() {
    use std::path::PathBuf;

    for p in [
        "/",
        "/usr",
        "/usr/bin/ls",
        "/System/Library",
        "/etc/hosts",
        "/Applications",
    ] {
        assert!(
            ProtectedPathRegistry::is_protected(Path::new(p)),
            "{} must be protected",
            p
        );
    }

    let home = PathBuf::from(std::env::var("HOME").expect("HOME"));
    assert!(ProtectedPathRegistry::is_protected(&home));
    assert!(ProtectedPathRegistry::is_protected(&home.join("Documents")));
    assert!(!ProtectedPathRegistry::is_protected(
        &home.join("Documents").join("old-report.pdf")
    ));
}
