use crate::cleanup::project_artifacts::detector::ProjectDetector;
use crate::cleanup::project_artifacts::models::{ProjectArtifact, ProjectMatch};
use crate::cleanup::protected_paths::ProtectedPathRegistry;
use crate::shared::errors::CoreError;
use crate::shared::progress::CancellationToken;
use freemydisk_platform::{get_platform, PlatformFilesystem};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub struct ProjectCrawler;

impl ProjectCrawler {
    /// Recursively crawls the provided root paths to discover developer projects and their build artifacts.
    pub fn crawl(
        roots: &[PathBuf],
        min_artifact_size: u64,
        cancel: &CancellationToken,
    ) -> Result<Vec<ProjectMatch>, CoreError> {
        let mut matches = Vec::new();

        for root in roots {
            if cancel.is_cancelled() {
                return Err(CoreError::Cancelled);
            }
            if !root.exists() {
                continue;
            }

            Self::crawl_directory(root, min_artifact_size, cancel, &mut matches)?;
        }

        Ok(matches)
    }

    fn crawl_directory(
        dir: &Path,
        min_artifact_size: u64,
        cancel: &CancellationToken,
        results: &mut Vec<ProjectMatch>,
    ) -> Result<(), CoreError> {
        if cancel.is_cancelled() {
            return Err(CoreError::Cancelled);
        }

        if ProtectedPathRegistry::is_protected(dir) || ProtectedPathRegistry::is_reparse_point(dir)
        {
            return Ok(());
        }

        let dir_name = dir.file_name().and_then(|n| n.to_str()).unwrap_or_default();

        // Prune version control and system internal directories immediately
        if dir_name.eq_ignore_ascii_case(".git")
            || dir_name.eq_ignore_ascii_case(".svn")
            || dir_name.eq_ignore_ascii_case(".hg")
            || dir_name.starts_with('$')
            || dir_name.eq_ignore_ascii_case("System Volume Information")
        {
            return Ok(());
        }

        let read_res = fs::read_dir(dir);
        let entries = match read_res {
            Ok(iter) => iter,
            Err(_) => return Ok(()), // Access denied or unreadable
        };

        let mut file_names = Vec::new();
        let mut subdir_names = Vec::new();
        let mut subdirs_to_recurse = Vec::new();

        for entry in entries.flatten() {
            let path = entry.path();
            let name = match entry.file_name().into_string() {
                Ok(n) => n,
                Err(_) => continue,
            };

            let file_type = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };

            if file_type.is_dir() {
                subdir_names.push(name.clone());
                subdirs_to_recurse.push(path);
            } else if file_type.is_file() {
                file_names.push(name);
            }
        }

        // Check if this directory is a project root
        if let Some(rule) = ProjectDetector::detect_project(dir, &file_names, &subdir_names) {
            let project_name = dir
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(&rule.project.name)
                .to_string();

            let mut found_artifacts = Vec::new();
            let mut total_reclaimable = 0u64;
            let mut most_recent_mtime = 0u64;

            for art_rule in &rule.artifacts {
                let art_path = dir.join(&art_rule.relative_path);
                if !art_path.exists() {
                    continue;
                }

                // Measure size, item count, and staleness
                let (size, count, latest_mtime) = Self::measure_path(&art_path, cancel)?;
                if size >= min_artifact_size {
                    let now_secs = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    let staleness_days = if latest_mtime > 0 && now_secs > latest_mtime {
                        ((now_secs - latest_mtime) / 86400) as u32
                    } else {
                        0
                    };

                    if latest_mtime > most_recent_mtime {
                        most_recent_mtime = latest_mtime;
                    }

                    total_reclaimable += size;
                    found_artifacts.push(ProjectArtifact {
                        path: art_path,
                        relative_path: art_rule.relative_path.clone(),
                        category: art_rule.category.clone(),
                        size_bytes: size,
                        item_count: count,
                        risk: art_rule.risk.clone(),
                        verified_rebuildable: art_rule.verified_rebuildable,
                        rebuild_command: art_rule.rebuild_command.clone(),
                        staleness_days,
                        selected: art_rule.verified_rebuildable && art_rule.risk == "safe",
                    });
                }
            }

            if !found_artifacts.is_empty() {
                let now_secs = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let last_modified_days_ago =
                    if most_recent_mtime > 0 && now_secs > most_recent_mtime {
                        ((now_secs - most_recent_mtime) / 86400) as u32
                    } else {
                        0
                    };

                results.push(ProjectMatch {
                    project_root: dir.to_path_buf(),
                    project_type: rule.project.id.clone(),
                    project_name,
                    artifacts: found_artifacts,
                    total_reclaimable_bytes: total_reclaimable,
                    last_modified_days_ago,
                });
            }

            // Exclude already-identified artifact directories from recursive crawling
            let artifact_set: std::collections::HashSet<String> = rule
                .artifacts
                .iter()
                .map(|a| a.relative_path.to_ascii_lowercase())
                .collect();

            for subdir in subdirs_to_recurse {
                let name = subdir
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase();

                // Do not crawl inside node_modules or target to look for nested projects!
                if !artifact_set.contains(&name) {
                    Self::crawl_directory(&subdir, min_artifact_size, cancel, results)?;
                }
            }
        } else {
            // Not a project root; keep searching deeper
            for subdir in subdirs_to_recurse {
                Self::crawl_directory(&subdir, min_artifact_size, cancel, results)?;
            }
        }

        Ok(())
    }

    /// Fast size, count and modification timestamp evaluator for an artifact directory or file.
    fn measure_path(
        path: &Path,
        cancel: &CancellationToken,
    ) -> Result<(u64, usize, u64), CoreError> {
        if cancel.is_cancelled() {
            return Err(CoreError::Cancelled);
        }

        let meta = match fs::symlink_metadata(path) {
            Ok(m) => m,
            Err(_) => return Ok((0, 0, 0)),
        };

        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        // If it's a file, return its size
        if meta.is_file() {
            return Ok((meta.len(), 1, mtime));
        }

        // If it's a reparse point (junction/symlink), do not follow
        if ProtectedPathRegistry::is_reparse_point(path) {
            return Ok((0, 0, mtime));
        }

        let platform = get_platform();
        if platform.is_cloud_placeholder(path).unwrap_or(false) {
            return Ok((0, 0, mtime));
        }

        let mut total_size = 0u64;
        let mut total_count = 0usize;
        let mut max_mtime = mtime;

        let mut stack = vec![path.to_path_buf()];

        while let Some(current) = stack.pop() {
            if cancel.is_cancelled() {
                return Err(CoreError::Cancelled);
            }

            if let Ok(entries) = fs::read_dir(&current) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if platform.is_cloud_placeholder(&p).unwrap_or(false) {
                        continue;
                    }
                    let m = match fs::symlink_metadata(&p) {
                        Ok(meta) => meta,
                        Err(_) => continue,
                    };

                    let entry_mtime = m
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);

                    if entry_mtime > max_mtime {
                        max_mtime = entry_mtime;
                    }

                    if m.is_dir() {
                        if !ProtectedPathRegistry::is_reparse_point(&p) {
                            stack.push(p);
                        }
                    } else {
                        total_size += m.len();
                        total_count += 1;
                    }
                }
            }
        }

        Ok((total_size, total_count, max_mtime))
    }
}
