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
