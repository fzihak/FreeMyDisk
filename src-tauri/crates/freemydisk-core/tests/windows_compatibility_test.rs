use freemydisk_core::cleanup::disposal::execute_tolerant_permanent_delete;
use freemydisk_core::shared::paths::to_extended_path;
use freemydisk_core::shared::progress::CancellationToken;
use freemydisk_core::storage::duplicates::DuplicateDetector;
use freemydisk_platform::get_platform;
use freemydisk_platform::traits::{FileIdentity, PlatformError, PlatformFilesystem};
use freemydisk_platform::windows::applications::{InstallerEngine, WindowsApplicationsHandler};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use tempfile::tempdir;

#[test]
fn test_extended_path_handling() {
    // 1. Short path under 240 chars: unchanged
    let short_path = Path::new(r"C:\Program Files\FreeMyDisk\bin\app.exe");
    assert_eq!(to_extended_path(short_path), short_path);

    // 2. Long path exceeding 240 chars: prepends \\?\
    let long_dir = "a".repeat(250);
    let long_drive_path = PathBuf::from(format!(r"C:\{}\file.txt", long_dir));
    let extended = to_extended_path(&long_drive_path);
    let ext_str = extended.to_string_lossy();
    assert!(
        ext_str.starts_with(r"\\?\C:\"),
        "Extended path must start with \\?\\C:\\: {}",
        ext_str
    );

    // 3. Long UNC path exceeding 240 chars: prepends \\?\UNC\
    let long_unc_path = PathBuf::from(format!(r"\\server\share\{}\file.txt", long_dir));
    let extended_unc = to_extended_path(&long_unc_path);
    let ext_unc_str = extended_unc.to_string_lossy();
    assert!(
        ext_unc_str.starts_with(r"\\?\UNC\server\share\"),
        "Extended UNC path must start with \\?\\UNC\\: {}",
        ext_unc_str
    );

    // 4. Already prefixed path: not doubled
    let already_prefixed = PathBuf::from(format!(r"\\?\C:\{}\file.txt", long_dir));
    let result = to_extended_path(&already_prefixed);
    assert_eq!(result, already_prefixed);
}

#[test]
fn test_installer_engine_detection_and_silent_args() {
    // 1. MSI
    let engine = WindowsApplicationsHandler::detect_installer_engine(
        "msiexec.exe",
        Some("/X{12345678-1234-1234-1234-123456789012}"),
    );
    assert_eq!(engine, InstallerEngine::Msi);
    let args = WindowsApplicationsHandler::prepare_silent_uninstall_args(
        engine,
        Some("/x {12345678-1234-1234-1234-123456789012}"),
        None,
    )
    .unwrap();
    assert!(args.to_lowercase().contains("/qn"));
    assert!(args.to_lowercase().contains("/norestart"));

    // 2. Inno Setup
    let engine = WindowsApplicationsHandler::detect_installer_engine(
        r"C:\Program Files\Example\unins000.exe",
        None,
    );
    assert_eq!(engine, InstallerEngine::InnoSetup);
    let args =
        WindowsApplicationsHandler::prepare_silent_uninstall_args(engine, None, None).unwrap();
    assert_eq!(args, "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-");

    // 3. NSIS
    let engine = WindowsApplicationsHandler::detect_installer_engine(
        r"C:\Program Files\Example\uninstall.exe",
        None,
    );
    assert_eq!(engine, InstallerEngine::Nsis);
    let args_with_dir = WindowsApplicationsHandler::prepare_silent_uninstall_args(
        engine,
        None,
        Some(r"C:\Program Files\Example"),
    )
    .unwrap();
    assert_eq!(args_with_dir, r"/S _?=C:\Program Files\Example");

    let args_no_dir =
        WindowsApplicationsHandler::prepare_silent_uninstall_args(engine, None, None).unwrap();
    assert_eq!(args_no_dir, "/S");

    // 4. InstallShield
    let engine = WindowsApplicationsHandler::detect_installer_engine(
        r"C:\Program Files\OldApp\_isuninst.exe",
        None,
    );
    assert_eq!(engine, InstallerEngine::InstallShield);
    let args =
        WindowsApplicationsHandler::prepare_silent_uninstall_args(engine, None, None).unwrap();
    assert_eq!(args, r#"/s /v"/qn /norestart""#);

    // 5. Squirrel / Electron
    let engine = WindowsApplicationsHandler::detect_installer_engine(
        r"C:\Users\Test\AppData\Local\Discord\Update.exe",
        Some("--uninstall -s"),
    );
    assert_eq!(engine, InstallerEngine::Squirrel);
    let args =
        WindowsApplicationsHandler::prepare_silent_uninstall_args(engine, None, None).unwrap();
    assert_eq!(args, "--uninstall -s");

    // 6. ClickOnce
    let engine = WindowsApplicationsHandler::detect_installer_engine(
        "rundll32 dfshim.dll,ShArpMaintain",
        None,
    );
    assert_eq!(engine, InstallerEngine::ClickOnce);

    // 7. Generic
    let engine =
        WindowsApplicationsHandler::detect_installer_engine("custom_cleanup.exe", Some("/silent"));
    assert_eq!(engine, InstallerEngine::Generic);
}

struct MockCloudSyncPlatform {
    cloud_file: PathBuf,
}

impl PlatformFilesystem for MockCloudSyncPlatform {
    fn trash_path(&self, _path: &Path) -> Result<(), PlatformError> {
        Ok(())
    }

    fn is_cloud_placeholder(&self, path: &Path) -> Result<bool, PlatformError> {
        Ok(path == self.cloud_file)
    }

    fn get_file_identity(&self, _path: &Path) -> Result<FileIdentity, PlatformError> {
        Ok(FileIdentity {
            device_id: 1,
            file_index: 100,
            link_count: 1,
            is_reparse_or_symlink: false,
        })
    }

    fn acquire_cross_process_lock(
        &self,
        _lock_path: &Path,
    ) -> Result<Box<dyn std::any::Any + Send + Sync>, PlatformError> {
        let temp_file = tempfile::NamedTempFile::new()?;
        Ok(Box::new(temp_file))
    }

    fn list_volumes(
        &self,
    ) -> Result<Vec<freemydisk_platform::traits::StorageVolumeInfo>, PlatformError> {
        Ok(Vec::new())
    }
}

#[test]
fn test_cloud_placeholder_skipping_in_duplicate_detector() {
    let temp = tempdir().unwrap();
    let file1 = temp.path().join("local_file1.dat");
    let file2 = temp.path().join("local_file2.dat");
    let cloud_file = temp.path().join("onedrive_stub.dat");

    // Write same content (same size)
    let content = b"FreeMyDisk duplicate content test";
    fs::write(&file1, content).unwrap();
    fs::write(&file2, content).unwrap();
    fs::write(&cloud_file, content).unwrap();

    let platform = MockCloudSyncPlatform {
        cloud_file: cloud_file.clone(),
    };

    let cancel = CancellationToken::new();
    let result =
        DuplicateDetector::scan_duplicates(&[temp.path().to_path_buf()], 1, &platform, &cancel)
            .unwrap();

    // Verify file1 and file2 were grouped as duplicates, but cloud_file was skipped
    let all_dup_paths: Vec<PathBuf> = result
        .groups
        .iter()
        .flat_map(|g| g.files.iter().map(|f| f.path.clone()))
        .collect();

    assert!(all_dup_paths.contains(&file1));
    assert!(all_dup_paths.contains(&file2));
    assert!(
        !all_dup_paths.contains(&cloud_file),
        "Cloud sync placeholder must be skipped to avoid network hydration!"
    );
}

#[test]
fn test_shell_refresh_execution() {
    let platform = get_platform();
    let res = platform.refresh_shell();
    assert!(res.is_ok(), "refresh_shell should succeed without error");
}

#[test]
fn test_tolerant_permanent_delete_on_temp_dir() {
    let temp = tempdir().unwrap();
    let sub = temp.path().join("test_tolerant_sub");
    fs::create_dir_all(&sub).unwrap();
    let test_file = sub.join("payload.bin");
    {
        let mut f = File::create(&test_file).unwrap();
        f.write_all(b"payload content for tolerant delete").unwrap();
    }
    assert!(test_file.exists());

    let cancel = CancellationToken::new();
    let (freed, err) = execute_tolerant_permanent_delete(&sub, &cancel);
    assert!(err.is_none(), "Deletion should succeed: {:?}", err);
    assert!(freed > 0, "Freed bytes should be greater than zero");
    assert!(!sub.exists(), "Subdirectory should no longer exist");
}
