use super::crawler::ProjectCrawler;
use super::models::ProjectArtifactScanResult;
use crate::shared::errors::CoreError;
use crate::shared::progress::CancellationToken;
use std::path::PathBuf;
use std::time::Instant;

pub struct ProjectArtifactScanner;

impl ProjectArtifactScanner {
    pub fn scan(
        roots: &[PathBuf],
        min_artifact_size: Option<u64>,
        cancel: &CancellationToken,
    ) -> Result<ProjectArtifactScanResult, CoreError> {
        let start = Instant::now();
        let min_size = min_artifact_size.unwrap_or(1024 * 1024); // Default 1 MB threshold

        let effective_roots = if roots.is_empty() {
            Self::default_dev_roots()
        } else {
            roots.to_vec()
        };

        let mut projects = ProjectCrawler::crawl(&effective_roots, min_size, cancel)?;

        // Sort projects by total reclaimable size descending
        projects.sort_by_key(|p| std::cmp::Reverse(p.total_reclaimable_bytes));

        let total_projects = projects.len();
        let total_artifacts = projects.iter().map(|p| p.artifacts.len()).sum();
        let total_reclaimable_bytes = projects.iter().map(|p| p.total_reclaimable_bytes).sum();
        let scan_duration_ms = start.elapsed().as_millis() as u64;

        Ok(ProjectArtifactScanResult {
            total_projects,
            total_artifacts,
            total_reclaimable_bytes,
            projects,
            scan_duration_ms,
        })
    }

    /// Resolves common developer folders and user drives when no custom roots are supplied.
    pub fn default_dev_roots() -> Vec<PathBuf> {
        let mut roots = Vec::new();

        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            let user_path = PathBuf::from(&user_profile);
            let candidates = [
                user_path.join("Projects"),
                user_path.join("source").join("repos"),
                user_path.join("dev"),
                user_path.join("code"),
                user_path.join("workspace"),
                user_path.join("git"),
                user_path.join("Documents"),
                user_path.join("Desktop"),
            ];

            for cand in candidates {
                if cand.exists() {
                    roots.push(cand);
                }
            }
        }

        // On Windows, also include secondary drives (D:\, E:\, etc.)
        for letter in b'D'..=b'Z' {
            let drive_path = format!("{}:\\", letter as char);
            let pb = PathBuf::from(&drive_path);
            if pb.exists() {
                roots.push(pb);
            }
        }

        if roots.is_empty() {
            if let Ok(user_profile) = std::env::var("USERPROFILE") {
                roots.push(PathBuf::from(user_profile));
            } else {
                roots.push(PathBuf::from("C:\\"));
            }
        }

        roots
    }

    /// Trashes or safely disposes of the requested artifact paths.
    pub fn clean_artifacts(
        artifact_paths: &[PathBuf],
        platform: &dyn freemydisk_platform::traits::PlatformFilesystem,
        journal: &crate::filesystem::journal::CrashRecoveryJournal,
        lock_dir: &std::path::Path,
        cancel: &CancellationToken,
    ) -> Result<crate::cleanup::disposal::DisposalSummary, CoreError> {
        let mut items = Vec::new();
        for path in artifact_paths {
            if !path.exists()
                || crate::cleanup::protected_paths::ProtectedPathRegistry::is_protected(path)
            {
                continue;
            }
            let is_dir = path.is_dir();
            let size = if is_dir {
                0
            } else {
                path.metadata().map(|m| m.len()).unwrap_or(0)
            };
            let canon =
                dunce::canonicalize(path).unwrap_or_else(|_| dunce::simplified(path).to_path_buf());
            items.push(crate::cleanup::plan::CleanupPlanItem {
                original_path: path.clone(),
                canonical_path: canon,
                size_bytes: size,
                is_dir,
                matched_rules: vec!["project_artifacts".to_string()],
                default_action: "trash".to_string(),
                verified_rebuildable: true,
                protect_subpaths: Vec::new(),
                risk: "safe".to_string(),
            });
        }

        crate::cleanup::disposal::DisposalEngine::execute_plan(
            &items, platform, journal, lock_dir,
            true, // Always route through OS Recycle Bin for safety
            cancel,
        )
    }
}
