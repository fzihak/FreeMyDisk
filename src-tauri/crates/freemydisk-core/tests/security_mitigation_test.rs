use freemydisk_core::cleanup::protected_paths::ProtectedPathRegistry;
use freemydisk_core::cleanup::shredder::{secure_shred_directory, secure_shred_file, ShredOptions};
use freemydisk_core::shared::errors::CoreError;
use freemydisk_core::shared::progress::CancellationToken;
use freemydisk_core::system_maintenance::{ElevatedRequest, ElevatedResponse};
use std::fs;
use std::path::Path;
use tempfile::tempdir;

#[test]
fn test_reparse_point_detection() {
    let dir = tempdir().expect("tempdir failed");
    let target_dir = dir.path().join("real_target_dir");
    fs::create_dir(&target_dir).expect("create target dir failed");
    let target_file = target_dir.join("sensitive_doc.txt");
    fs::write(&target_file, b"SENSITIVE OS SYSTEM DATA").expect("write target file failed");

    // Regular directory is not a reparse point
    assert!(!ProtectedPathRegistry::is_reparse_point(&target_dir));
    assert!(!ProtectedPathRegistry::is_directory_junction(&target_dir));

    #[cfg(target_os = "windows")]
    {
        // Try creating a directory symlink or junction if running with sufficient privileges
        let link_path = dir.path().join("junction_pointer");
        if std::os::windows::fs::symlink_dir(&target_dir, &link_path).is_ok() {
            assert!(
                ProtectedPathRegistry::is_reparse_point(&link_path),
                "Directory symlink must be identified as a reparse point"
            );

            // Shredder should only unlink the mount point, leaving real_target_dir intact
            let result = secure_shred_file(&link_path, None);
            assert!(result.is_ok());

            // Target directory and its contents MUST be unharmed
            assert!(target_dir.exists(), "Target directory must not be deleted");
            assert!(target_file.exists(), "Target file must not be wiped");
            let content = fs::read_to_string(&target_file).expect("read file failed");
            assert_eq!(content, "SENSITIVE OS SYSTEM DATA");
        }
    }
}

#[test]
fn test_8_3_short_names_and_relative_escapes_blocked() {
    // 8.3 Short name bypass attempts
    let short_names = [
        r"C:\PROGRA~1",
        r"C:\PROGRA~2",
        r"C:\WINDOW~1",
        r"c:\progra~1",
        r"c:\window~1",
    ];

    for &short in &short_names {
        let p = Path::new(short);
        assert!(
            ProtectedPathRegistry::is_protected(p),
            "8.3 representation '{}' must be blocked as protected",
            short
        );
        assert!(
            ProtectedPathRegistry::assert_safe_for_disposal(p).is_err(),
            "Disposal of 8.3 representation '{}' must be prohibited",
            short
        );
    }

    // Relative escape paths (e.g. escaping out of temp or user folder into Windows)
    let temp_escape = Path::new(r"C:\Users\Default\..\..\Windows");
    assert!(
        ProtectedPathRegistry::is_protected(temp_escape),
        "Relative path escaping into Windows root must be blocked"
    );
    assert!(
        ProtectedPathRegistry::assert_safe_for_disposal(temp_escape).is_err(),
        "Disposal of relative path escaping into Windows must be prohibited"
    );
}

#[test]
fn test_comprehensive_critical_system_paths_blacklisted() {
    let critical_paths = [
        r"C:\Windows",
        r"C:\Windows\System32",
        r"C:\Windows\SysWOW64",
        r"C:\ProgramData\Microsoft\Windows",
        r"C:\Boot",
        r"C:\Recovery",
        r"C:\System Volume Information",
        r"C:\$Recycle.Bin",
        r"C:\pagefile.sys",
        r"C:\swapfile.sys",
        r"C:\hiberfil.sys",
        r"C:\DumpStack.log",
        r"C:\Program Files",
        r"C:\Program Files (x86)",
    ];

    for crit in critical_paths {
        let path = Path::new(crit);
        assert!(
            ProtectedPathRegistry::is_protected(path),
            "Critical path '{}' must be strictly protected",
            crit
        );
        match ProtectedPathRegistry::assert_safe_for_disposal(path) {
            Err(CoreError::ProtectedPath(_)) => {}
            other => panic!(
                "Expected ProtectedPath error for '{}', got {:?}",
                crit, other
            ),
        }
    }
}

#[test]
fn test_dynamic_self_preservation_registration() {
    // Internal files: everything in the app's data folder, plus its binaries anywhere
    let data_dir = freemydisk_core::shared::paths::app_data_dir().expect("app data dir");
    let internal_files = [
        data_dir.join("journal.db"),
        data_dir.join("journal.db-wal"),
        data_dir.join("hash_cache.db"),
        data_dir.join("locks").join("freemydisk_disposal.lock"),
        std::path::PathBuf::from(r"C:\Program Files\FreeMyDisk\freemydisk.exe"),
        std::path::PathBuf::from(r"C:\Program Files\FreeMyDisk\freemydisk-elevated.exe"),
        std::path::PathBuf::from(r"C:\Program Files\FreeMyDisk\freemydisk_lib.dll"),
    ];

    for f in &internal_files {
        let p = f.as_path();
        assert!(ProtectedPathRegistry::is_self_asset(p));
        match ProtectedPathRegistry::assert_safe_for_disposal(p) {
            Err(CoreError::SelfPreservationViolation(_)) => {}
            other => panic!(
                "Expected SelfPreservationViolation for '{}', got {:?}",
                f.display(),
                other
            ),
        }
    }

    // Dynamic registration
    let dir = tempdir().expect("tempdir failed");
    let dynamic_path = dir.path().join("custom_app_database.db");
    fs::write(&dynamic_path, b"test").expect("write failed");

    // Initially not protected
    assert!(!ProtectedPathRegistry::is_self_asset(&dynamic_path));

    // Register
    ProtectedPathRegistry::register_protected_path(dynamic_path.clone());
    assert!(
        ProtectedPathRegistry::is_self_asset(&dynamic_path),
        "Dynamically registered path must be recognized as self-asset"
    );
    assert!(ProtectedPathRegistry::assert_safe_for_disposal(&dynamic_path).is_err());

    // Clean up registry
    ProtectedPathRegistry::clear_dynamic_paths();
}

#[test]
fn test_secure_shred_file_three_pass() {
    let dir = tempdir().expect("tempdir failed");
    let file_path = dir.path().join("sensitive_api_keys.env");

    let secret_payload = b"OPENAI_API_KEY=sk-proj-supersecretkey1234567890abcdef";
    fs::write(&file_path, secret_payload).expect("write failed");

    assert!(file_path.exists());
    let initial_size = fs::metadata(&file_path).unwrap().len();
    assert_eq!(initial_size, secret_payload.len() as u64);

    let options = ShredOptions {
        passes: 3,
        force_hdd_mode: true,
        strip_ads: true,
        rename_before_delete: true,
    };

    let shredded_bytes =
        secure_shred_file(&file_path, Some(options)).expect("secure_shred_file failed");

    assert_eq!(shredded_bytes, secret_payload.len() as u64);
    assert!(!file_path.exists(), "File must be deleted after shredding");
}

#[test]
fn test_secure_shred_directory_recursive() {
    let dir = tempdir().expect("tempdir failed");
    let sub = dir.path().join("nested_cache");
    fs::create_dir(&sub).expect("create_dir failed");

    let file1 = sub.join("token.json");
    let file2 = sub.join("session.dat");
    fs::write(&file1, b"{\"token\": \"xyz123\"}").expect("write failed");
    fs::write(&file2, vec![0x42; 1024]).expect("write failed");

    let cancel = CancellationToken::new();
    let (freed_bytes, files_count) = secure_shred_directory(
        &sub,
        Some(ShredOptions {
            passes: 2,
            force_hdd_mode: true,
            strip_ads: false,
            rename_before_delete: false,
        }),
        &cancel,
    )
    .expect("secure_shred_directory failed");

    assert_eq!(files_count, 2);
    assert_eq!(freed_bytes, 19 + 1024);
    assert!(!sub.exists(), "Directory must be removed after shredding");
}

#[test]
fn test_shredder_refuses_protected_system_paths() {
    let crit = Path::new(r"C:\Windows\System32");
    let res = secure_shred_file(crit, None);
    assert!(
        res.is_err(),
        "Shredder must refuse critical system directory"
    );

    let self_asset = freemydisk_core::shared::paths::app_data_dir()
        .expect("app data dir")
        .join("journal.db");
    let res2 = secure_shred_file(&self_asset, None);
    assert!(res2.is_err(), "Shredder must refuse FreeMyDisk database");
}

#[test]
fn test_elevated_request_token_serialization() {
    let req = ElevatedRequest {
        operation: "clean_software_distribution".to_string(),
        payload: String::new(),
        token: Some("d8f349c2-5b91-4e78-9e12-32a104b29c91".to_string()),
    };

    let serialized = serde_json::to_string(&req).expect("serialize failed");
    assert!(serialized.contains("d8f349c2-5b91-4e78-9e12-32a104b29c91"));

    let deserialized: ElevatedRequest =
        serde_json::from_str(&serialized).expect("deserialize failed");
    assert_eq!(deserialized.operation, "clean_software_distribution");
    assert_eq!(
        deserialized.token.as_deref(),
        Some("d8f349c2-5b91-4e78-9e12-32a104b29c91")
    );

    let resp = ElevatedResponse {
        success: true,
        message: "Cleaned 12 items from SoftwareDistribution cache.".to_string(),
    };
    let resp_json = serde_json::to_string(&resp).expect("serialize response failed");
    let parsed_resp: ElevatedResponse =
        serde_json::from_str(&resp_json).expect("deserialize response failed");
    assert!(parsed_resp.success);
}
