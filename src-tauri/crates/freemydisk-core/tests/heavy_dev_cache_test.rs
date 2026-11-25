use freemydisk_core::cleanup::cleaners::ai_models::AiModelAnalyzer;
use freemydisk_core::cleanup::cleaners::conda::CondaCleaner;
use freemydisk_core::cleanup::cleaners::rust_toolchains::RustToolchainCleaner;
use freemydisk_platform::traits::{
    FileIdentity, PlatformError, PlatformFilesystem, StorageVolumeInfo,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tempfile::tempdir;

struct MockFilesystem {
    trashed: Arc<Mutex<Vec<PathBuf>>>,
}

impl MockFilesystem {
    fn new() -> Self {
        Self {
            trashed: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl PlatformFilesystem for MockFilesystem {
    fn trash_path(&self, path: &Path) -> Result<(), PlatformError> {
        self.trashed.lock().unwrap().push(path.to_path_buf());
        if path.is_file() {
            let _ = fs::remove_file(path);
        } else if path.is_dir() {
            let _ = fs::remove_dir_all(path);
        }
        Ok(())
    }

    fn is_cloud_placeholder(&self, _path: &Path) -> Result<bool, PlatformError> {
        Ok(false)
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
        Ok(Box::new(()))
    }

    fn list_volumes(&self) -> Result<Vec<StorageVolumeInfo>, PlatformError> {
        Ok(Vec::new())
    }
}

#[test]
fn test_ai_model_path_safety_validation() {
    let dir = tempdir().unwrap();
    let models = dir.path().join(".ollama").join("models");
    let cache = dir.path().join(".claude").join("cache");
    let projects = dir.path().join(".claude").join("projects");
    let documents = dir.path().join("Documents");
    for d in [&models, &cache, &projects, &documents] {
        fs::create_dir_all(d).unwrap();
    }
    let blob = models.join("blobs");
    fs::create_dir_all(&blob).unwrap();
    fs::write(documents.join("report.docx"), b"doc").unwrap();

    let model_roots = vec![dunce::canonicalize(&models).unwrap()];
    let cache_roots = vec![dunce::canonicalize(&cache).unwrap()];
    let allowed = |p: &Path| AiModelAnalyzer::is_within_roots(p, &model_roots, &cache_roots);

    // Entries inside a model store, and a whole cache folder, are allowed.
    assert!(allowed(&blob));
    assert!(allowed(&cache));

    // The model store itself, user data next to it and '..' escapes are rejected.
    assert!(!allowed(&models));
    assert!(!allowed(&projects));
    assert!(!allowed(&documents.join("report.docx")));
    assert!(!allowed(
        &blob.join("..").join("..").join("..").join("Documents")
    ));
    assert!(!allowed(Path::new(r"C:\Windows\System32")));
}

#[test]
fn test_ai_model_clean_mock() {
    let dir = tempdir().unwrap();
    let models_root = dir.path().join(".ollama").join("models");
    let mock_ollama_path = models_root.join("blobs");
    fs::create_dir_all(&mock_ollama_path).unwrap();

    let model_file = mock_ollama_path.join("sha256-testblob");
    fs::write(&model_file, vec![0u8; 1024 * 1024]).unwrap(); // 1MB

    // clean_model only accepts paths inside the configured model store.
    std::env::set_var("OLLAMA_MODELS", &models_root);
    let mock_fs = MockFilesystem::new();
    let freed = AiModelAnalyzer::clean_model(model_file.to_str().unwrap(), &mock_fs).unwrap();
    assert_eq!(freed, 1024 * 1024);
    assert_eq!(mock_fs.trashed.lock().unwrap().len(), 1);

    let outside = dir.path().join("outside.bin");
    fs::write(&outside, b"x").unwrap();
    assert!(AiModelAnalyzer::clean_model(outside.to_str().unwrap(), &mock_fs).is_err());
}

#[test]
fn test_rust_toolchain_active_protection() {
    let dir = tempdir().unwrap();
    let toolchains_dir = dir.path().join("toolchains");
    let active_dir = toolchains_dir.join("stable-x86_64-pc-windows-msvc");
    let old_dir = toolchains_dir.join("nightly-2023-01-01-x86_64-pc-windows-msvc");

    fs::create_dir_all(&active_dir).unwrap();
    fs::create_dir_all(&old_dir).unwrap();
    fs::write(active_dir.join("rustc.exe"), b"mock").unwrap();
    fs::write(old_dir.join("rustc.exe"), b"mock").unwrap();

    // Toolchains are resolved inside RUSTUP_HOME only.
    std::env::set_var("RUSTUP_HOME", dir.path());
    let mock_fs = MockFilesystem::new();

    // Cleaning the inactive old toolchain should succeed
    let freed =
        RustToolchainCleaner::clean_toolchain(old_dir.to_str().unwrap(), false, &mock_fs).unwrap();
    assert!(freed > 0);
    // Removed either by `rustup toolchain uninstall` (when rustup is installed) or
    // through the Recycle Bin fallback.
    let trashed = mock_fs.trashed.lock().unwrap().len();
    assert!(trashed == 1 || !old_dir.exists());
    assert!(active_dir.exists(), "The active toolchain must be kept");

    // Paths outside RUSTUP_HOME/toolchains and traversal names are rejected.
    let elsewhere = dir.path().join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    assert!(
        RustToolchainCleaner::clean_toolchain(elsewhere.to_str().unwrap(), false, &mock_fs)
            .is_err()
    );
    assert!(RustToolchainCleaner::clean_toolchain("..", false, &mock_fs).is_err());
}

#[test]
fn test_cleaners_scan_smoke_test() {
    // Ensure all cleaners execute without panic on host system
    let models = AiModelAnalyzer::scan();
    println!("Discovered {} AI models/sessions on host", models.len());

    let rust_result = RustToolchainCleaner::scan();
    assert!(rust_result.is_ok());
    let r = rust_result.unwrap();
    println!(
        "Discovered {} Rust toolchains, active: {:?}",
        r.toolchains.len(),
        r.active_toolchain
    );

    let conda_info = CondaCleaner::scan();
    println!(
        "Conda found: {}, pkgs: {}",
        conda_info.found, conda_info.package_count
    );
}
