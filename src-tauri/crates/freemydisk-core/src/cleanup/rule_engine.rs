use crate::cleanup::matchers::{glob_match, is_subpath_protected};
use crate::cleanup::protected_paths::ProtectedPathRegistry;
use crate::cleanup::rule_schema::CleanupRuleDefinition;
use crate::shared::errors::CoreError;
use crate::shared::paths::expand_path_variables;
use crate::shared::progress::CancellationToken;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuleScanCandidate {
    pub path: PathBuf,
    pub size_bytes: u64,
    pub is_dir: bool,
    pub rule_id: String,
    pub rule_name: String,
    pub category: String,
    pub risk: String,
    pub verified_rebuildable: bool,
    pub default_action: String,
    pub protect_subpaths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleScanSummary {
    pub rule_id: String,
    pub rule_name: String,
    pub category: String,
    pub risk: String,
    pub verified_rebuildable: bool,
    pub default_action: String,
    pub default_selected: bool,
    pub total_bytes: u64,
    pub total_items: usize,
    pub candidates: Vec<RuleScanCandidate>,
    #[serde(default)]
    pub is_locked_by_process: bool,
    #[serde(default)]
    pub locking_process_name: Option<String>,
}

pub struct RuleEngine {
    rules: Vec<CleanupRuleDefinition>,
}

impl Default for RuleEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl RuleEngine {
    pub fn new() -> Self {
        let mut engine = Self { rules: Vec::new() };
        engine.load_builtin_rules();
        engine
    }

    pub fn with_rules(rules: Vec<CleanupRuleDefinition>) -> Self {
        Self { rules }
    }

    pub fn rules(&self) -> &[CleanupRuleDefinition] {
        &self.rules
    }

    pub fn add_rule(&mut self, rule: CleanupRuleDefinition) {
        self.rules.push(rule);
    }

    pub fn parse_rule_toml(toml_str: &str) -> Result<CleanupRuleDefinition, CoreError> {
        let rule: CleanupRuleDefinition = toml::from_str(toml_str)
            .map_err(|e| CoreError::RuleValidation(format!("TOML syntax error: {}", e)))?;
        Ok(rule)
    }

    pub fn load_builtin_rules(&mut self) {
        const BUILTIN_TOMLS: &[&str] = &[
            include_str!("../../rules/filesystem/windows/ai/chatgpt_desktop.toml"),
            include_str!("../../rules/filesystem/windows/ai/claude_code.toml"),
            include_str!("../../rules/filesystem/windows/ai/codex.toml"),
            include_str!("../../rules/filesystem/windows/ai/comfyui.toml"),
            include_str!("../../rules/filesystem/windows/ai/copilot.toml"),
            include_str!("../../rules/filesystem/windows/ai/cursor.toml"),
            include_str!("../../rules/filesystem/windows/ai/gemini.toml"),
            include_str!("../../rules/filesystem/windows/ai/huggingface.toml"),
            include_str!("../../rules/filesystem/windows/ai/huggingface_xet.toml"),
            include_str!("../../rules/filesystem/windows/ai/lmstudio.toml"),
            include_str!("../../rules/filesystem/windows/ai/ollama.toml"),
            include_str!("../../rules/filesystem/windows/ai/openwebui.toml"),
            include_str!("../../rules/filesystem/windows/application/adobe.toml"),
            include_str!("../../rules/filesystem/windows/application/battle_net.toml"),
            include_str!("../../rules/filesystem/windows/application/chatgpt.toml"),
            include_str!("../../rules/filesystem/windows/application/creative_cloud.toml"),
            include_str!("../../rules/filesystem/windows/application/discord.toml"),
            include_str!("../../rules/filesystem/windows/application/discord_canary.toml"),
            include_str!("../../rules/filesystem/windows/application/dropbox.toml"),
            include_str!("../../rules/filesystem/windows/application/ea_app.toml"),
            include_str!("../../rules/filesystem/windows/application/electron_apps.toml"),
            include_str!("../../rules/filesystem/windows/application/electron_updater.toml"),
            include_str!("../../rules/filesystem/windows/application/epic_games.toml"),
            include_str!("../../rules/filesystem/windows/application/figma.toml"),
            include_str!("../../rules/filesystem/windows/application/gog.toml"),
            include_str!("../../rules/filesystem/windows/application/google_drive.toml"),
            include_str!("../../rules/filesystem/windows/application/itchio.toml"),
            include_str!("../../rules/filesystem/windows/application/linear.toml"),
            include_str!("../../rules/filesystem/windows/application/notion.toml"),
            include_str!("../../rules/filesystem/windows/application/obs.toml"),
            include_str!("../../rules/filesystem/windows/application/obsidian.toml"),
            include_str!("../../rules/filesystem/windows/application/onedrive.toml"),
            include_str!("../../rules/filesystem/windows/application/outlook_new.toml"),
            include_str!("../../rules/filesystem/windows/application/postman.toml"),
            include_str!("../../rules/filesystem/windows/application/signal.toml"),
            include_str!("../../rules/filesystem/windows/application/skype.toml"),
            include_str!("../../rules/filesystem/windows/application/slack.toml"),
            include_str!("../../rules/filesystem/windows/application/spotify.toml"),
            include_str!("../../rules/filesystem/windows/application/spotify_offline.toml"),
            include_str!("../../rules/filesystem/windows/application/steam.toml"),
            include_str!("../../rules/filesystem/windows/application/sublime_text.toml"),
            include_str!("../../rules/filesystem/windows/application/teams.toml"),
            include_str!("../../rules/filesystem/windows/application/telegram.toml"),
            include_str!("../../rules/filesystem/windows/application/thunderbird.toml"),
            include_str!("../../rules/filesystem/windows/application/todoist.toml"),
            include_str!("../../rules/filesystem/windows/application/twitch.toml"),
            include_str!("../../rules/filesystem/windows/application/vlc.toml"),
            include_str!("../../rules/filesystem/windows/application/vscode.toml"),
            include_str!("../../rules/filesystem/windows/application/vscode_insiders.toml"),
            include_str!("../../rules/filesystem/windows/application/wechat.toml"),
            include_str!("../../rules/filesystem/windows/application/whatsapp.toml"),
            include_str!("../../rules/filesystem/windows/application/wps.toml"),
            include_str!("../../rules/filesystem/windows/application/zoom.toml"),
            include_str!("../../rules/filesystem/windows/browser/arc.toml"),
            include_str!("../../rules/filesystem/windows/browser/brave.toml"),
            include_str!("../../rules/filesystem/windows/browser/brave_offline.toml"),
            include_str!("../../rules/filesystem/windows/browser/chrome.toml"),
            include_str!("../../rules/filesystem/windows/browser/chrome_offline.toml"),
            include_str!("../../rules/filesystem/windows/browser/chromium.toml"),
            include_str!("../../rules/filesystem/windows/browser/duckduckgo.toml"),
            include_str!("../../rules/filesystem/windows/browser/edge.toml"),
            include_str!("../../rules/filesystem/windows/browser/edge_offline.toml"),
            include_str!("../../rules/filesystem/windows/browser/firefox.toml"),
            include_str!("../../rules/filesystem/windows/browser/floorp.toml"),
            include_str!("../../rules/filesystem/windows/browser/librewolf.toml"),
            include_str!("../../rules/filesystem/windows/browser/opera.toml"),
            include_str!("../../rules/filesystem/windows/browser/opera_gx.toml"),
            include_str!("../../rules/filesystem/windows/browser/samsung_internet.toml"),
            include_str!("../../rules/filesystem/windows/browser/tor.toml"),
            include_str!("../../rules/filesystem/windows/browser/vivaldi.toml"),
            include_str!("../../rules/filesystem/windows/browser/waterfox.toml"),
            include_str!("../../rules/filesystem/windows/browser/yandex.toml"),
            include_str!("../../rules/filesystem/windows/container/docker.toml"),
            include_str!("../../rules/filesystem/windows/container/docker_build_cache.toml"),
            include_str!("../../rules/filesystem/windows/container/podman.toml"),
            include_str!("../../rules/filesystem/windows/container/rancher.toml"),
            include_str!("../../rules/filesystem/windows/development/android.toml"),
            include_str!("../../rules/filesystem/windows/development/build_accelerator.toml"),
            include_str!("../../rules/filesystem/windows/development/bun.toml"),
            include_str!("../../rules/filesystem/windows/development/cargo.toml"),
            include_str!("../../rules/filesystem/windows/development/ccache.toml"),
            include_str!("../../rules/filesystem/windows/development/chocolatey_cache.toml"),
            include_str!("../../rules/filesystem/windows/development/composer.toml"),
            include_str!("../../rules/filesystem/windows/development/conda.toml"),
            include_str!("../../rules/filesystem/windows/development/copilot_cli.toml"),
            include_str!("../../rules/filesystem/windows/development/dart.toml"),
            include_str!("../../rules/filesystem/windows/development/deno.toml"),
            include_str!("../../rules/filesystem/windows/development/devcontainer.toml"),
            include_str!("../../rules/filesystem/windows/development/flutter.toml"),
            include_str!("../../rules/filesystem/windows/development/golang.toml"),
            include_str!("../../rules/filesystem/windows/development/gradle.toml"),
            include_str!("../../rules/filesystem/windows/development/jetbrains.toml"),
            include_str!("../../rules/filesystem/windows/development/localwp.toml"),
            include_str!("../../rules/filesystem/windows/development/maven.toml"),
            include_str!("../../rules/filesystem/windows/development/npm.toml"),
            include_str!("../../rules/filesystem/windows/development/nuget.toml"),
            include_str!("../../rules/filesystem/windows/development/php_composer_vcs.toml"),
            include_str!("../../rules/filesystem/windows/development/pip.toml"),
            include_str!("../../rules/filesystem/windows/development/playwright.toml"),
            include_str!("../../rules/filesystem/windows/development/pnpm.toml"),
            include_str!("../../rules/filesystem/windows/development/rider.toml"),
            include_str!("../../rules/filesystem/windows/development/ruby.toml"),
            include_str!("../../rules/filesystem/windows/development/rustup_tmp.toml"),
            include_str!("../../rules/filesystem/windows/development/sccache.toml"),
            include_str!("../../rules/filesystem/windows/development/scoop_cache.toml"),
            include_str!("../../rules/filesystem/windows/development/uv.toml"),
            include_str!("../../rules/filesystem/windows/development/visual_studio.toml"),
            include_str!("../../rules/filesystem/windows/development/yarn.toml"),
            include_str!("../../rules/filesystem/windows/system/crash_dumps.toml"),
            include_str!("../../rules/filesystem/windows/system/d3d_shaders.toml"),
            include_str!("../../rules/filesystem/windows/system/delivery_optimization.toml"),
            include_str!("../../rules/filesystem/windows/system/event_logs.toml"),
            include_str!("../../rules/filesystem/windows/system/font_cache.toml"),
            include_str!("../../rules/filesystem/windows/system/installer_cache.toml"),
            include_str!("../../rules/filesystem/windows/system/search_index_temp.toml"),
            include_str!("../../rules/filesystem/windows/system/shader_cache.toml"),
            include_str!("../../rules/filesystem/windows/system/stale_downloads.toml"),
            include_str!("../../rules/filesystem/windows/system/temp.toml"),
            include_str!("../../rules/filesystem/windows/system/thumbnails.toml"),
            include_str!("../../rules/filesystem/windows/system/updaters.toml"),
            include_str!("../../rules/filesystem/windows/system/windows_error_reporting.toml"),
            include_str!("../../rules/filesystem/windows/system/windows_update_cache.toml"),
        ];

        for &raw in BUILTIN_TOMLS {
            if let Ok(rule) = Self::parse_rule_toml(raw) {
                self.rules.push(rule);
            }
        }
    }

    pub fn load_custom_rules_from_dir(&mut self, dir: &Path) -> Result<usize, CoreError> {
        if !dir.exists() {
            return Ok(0);
        }

        let mut count = 0;
        let entries = fs::read_dir(dir)?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("toml") {
                if let Ok(content) = fs::read_to_string(&path) {
                    if let Ok(rule) = Self::parse_rule_toml(&content) {
                        self.rules.push(rule);
                        count += 1;
                    }
                }
            }
        }

        Ok(count)
    }

    pub fn is_applicable(rule: &CleanupRuleDefinition) -> bool {
        let platform = rule.rule.platform.to_ascii_lowercase();
        #[cfg(target_os = "windows")]
        {
            if platform == "macos" {
                return false;
            }
        }
        #[cfg(target_os = "macos")]
        {
            if platform == "windows" {
                return false;
            }
        }

        for condition in &rule.applicability.conditions {
            if condition.condition_type == "path_exists" {
                if let Some(path_tmpl) = &condition.path {
                    let expanded = expand_path_variables(path_tmpl);
                    if !expanded.exists() {
                        return false;
                    }
                }
            }
        }

        true
    }

    pub fn scan_rule(
        rule: &CleanupRuleDefinition,
        cancel: &CancellationToken,
    ) -> Result<RuleScanSummary, CoreError> {
        if cancel.is_cancelled() {
            return Err(CoreError::Cancelled);
        }

        if !Self::is_applicable(rule) {
            return Ok(RuleScanSummary {
                rule_id: rule.rule.id.clone(),
                rule_name: rule.rule.name.clone(),
                category: rule.rule.category.clone(),
                risk: rule.rule.risk.clone(),
                verified_rebuildable: rule.rule.verified_rebuildable,
                default_action: rule.disposal.default_action.clone(),
                default_selected: rule.rule.default_selected,
                total_bytes: 0,
                total_items: 0,
                candidates: Vec::new(),
                is_locked_by_process: false,
                locking_process_name: None,
            });
        }

        let mut candidates = Vec::new();
        let mut total_bytes = 0u64;
        let mut total_items = 0usize;
        // Preview is capped to avoid excessive memory use.
        // total_bytes and total_items are always exact (not capped).
        // The frontend should show "+N more" when total_items > candidates.len().
        const MAX_PREVIEW_CANDIDATES: usize = 500;

        for target in &rule.targets.paths {
            if cancel.is_cancelled() {
                return Err(CoreError::Cancelled);
            }

            let expanded = expand_path_variables(&target.path);
            let target_str = expanded.to_string_lossy().to_string();

            if target_str.contains('*') {
                let first_star = target_str.find('*').unwrap();
                let prefix = &target_str[..first_star];
                let base_dir = match prefix.rfind(['/', '\\']) {
                    Some(idx) => PathBuf::from(&prefix[..idx]),
                    None => PathBuf::from("."),
                };

                if base_dir.exists() {
                    let base_dir_str = base_dir.to_string_lossy();
                    let rel_pattern = if target_str.len() > base_dir_str.len() {
                        &target_str[base_dir_str.len()..]
                    } else {
                        ""
                    };
                    let segment_count = rel_pattern
                        .split(['/', '\\'])
                        .filter(|s| !s.is_empty())
                        .count();
                    let max_depth = (segment_count + 3).clamp(4, 8);

                    let walk = walkdir::WalkDir::new(&base_dir)
                        .min_depth(1)
                        .max_depth(max_depth)
                        .into_iter();

                    let mut matched_dirs: Vec<PathBuf> = Vec::new();

                    for entry in walk.flatten() {
                        if cancel.is_cancelled() {
                            return Err(CoreError::Cancelled);
                        }

                        let path = entry.path();

                        if matched_dirs.iter().any(|d| path.starts_with(d)) {
                            continue;
                        }

                        let is_dir = entry.file_type().is_dir();
                        let path_str = path.to_string_lossy();

                        let is_match = glob_match(&target_str, &path_str)
                            || (is_dir
                                && (target_str.ends_with("/*") || target_str.ends_with(r"\*"))
                                && path != base_dir
                                && glob_match(&target_str[..target_str.len() - 2], &path_str));

                        if is_match {
                            if is_subpath_protected(path, &rule.disposal.protect_subpaths) {
                                continue;
                            }

                            if ProtectedPathRegistry::is_protected(path) {
                                continue;
                            }

                            if is_dir {
                                matched_dirs.push(path.to_path_buf());
                            }

                            let (size, count) = if is_dir {
                                calculate_dir_size_with_filter(
                                    path,
                                    &rule.disposal.protect_subpaths,
                                )
                            } else {
                                (entry.metadata().map(|m| m.len()).unwrap_or(0), 1)
                            };

                            total_bytes += size;
                            total_items += count.max(1);

                            if candidates.len() < MAX_PREVIEW_CANDIDATES {
                                candidates.push(RuleScanCandidate {
                                    path: path.to_path_buf(),
                                    size_bytes: size,
                                    is_dir,
                                    rule_id: rule.rule.id.clone(),
                                    rule_name: rule.rule.name.clone(),
                                    category: rule.rule.category.clone(),
                                    risk: rule.rule.risk.clone(),
                                    verified_rebuildable: rule.rule.verified_rebuildable,
                                    default_action: rule.disposal.default_action.clone(),
                                    protect_subpaths: rule.disposal.protect_subpaths.clone(),
                                });
                            }
                        }
                    }
                }
            } else if expanded.exists()
                && !is_subpath_protected(&expanded, &rule.disposal.protect_subpaths)
                && !ProtectedPathRegistry::is_protected(&expanded)
            {
                let is_dir = expanded.is_dir();
                let (size, count) = if is_dir {
                    calculate_dir_size_with_filter(&expanded, &rule.disposal.protect_subpaths)
                } else {
                    (expanded.metadata().map(|m| m.len()).unwrap_or(0), 1)
                };

                total_bytes += size;
                total_items += count.max(1);

                if candidates.len() < MAX_PREVIEW_CANDIDATES {
                    candidates.push(RuleScanCandidate {
                        path: expanded,
                        size_bytes: size,
                        is_dir,
                        rule_id: rule.rule.id.clone(),
                        rule_name: rule.rule.name.clone(),
                        category: rule.rule.category.clone(),
                        risk: rule.rule.risk.clone(),
                        verified_rebuildable: rule.rule.verified_rebuildable,
                        default_action: rule.disposal.default_action.clone(),
                        protect_subpaths: rule.disposal.protect_subpaths.clone(),
                    });
                }
            }
        }

        Ok(RuleScanSummary {
            rule_id: rule.rule.id.clone(),
            rule_name: rule.rule.name.clone(),
            category: rule.rule.category.clone(),
            risk: rule.rule.risk.clone(),
            verified_rebuildable: rule.rule.verified_rebuildable,
            default_action: rule.disposal.default_action.clone(),
            default_selected: rule.rule.default_selected,
            total_bytes,
            total_items,
            candidates,
            is_locked_by_process: false,
            locking_process_name: None,
        })
    }

    pub fn scan_all_with_progress<F>(
        &self,
        cancel: &CancellationToken,
        mut on_progress: F,
    ) -> Result<Vec<RuleScanSummary>, CoreError>
    where
        F: FnMut(&str, usize, usize, u64),
    {
        let total = self.rules.len();
        let mut summaries = Vec::with_capacity(total);
        let mut cumulative_bytes = 0u64;

        for (idx, rule) in self.rules.iter().enumerate() {
            if cancel.is_cancelled() {
                return Err(CoreError::Cancelled);
            }
            let summary = Self::scan_rule(rule, cancel)?;
            cumulative_bytes += summary.total_bytes;
            on_progress(&rule.rule.name, idx + 1, total, cumulative_bytes);
            summaries.push(summary);
        }

        Ok(summaries)
    }

    pub fn scan_all(&self, cancel: &CancellationToken) -> Result<Vec<RuleScanSummary>, CoreError> {
        self.scan_all_with_progress(cancel, |_, _, _, _| {})
    }

    pub fn scan_all_candidates(
        &self,
        rule_ids: &[String],
        cancel: &CancellationToken,
    ) -> Result<Vec<RuleScanCandidate>, CoreError> {
        let rule_id_set: std::collections::HashSet<&str> =
            rule_ids.iter().map(|s| s.as_str()).collect();
        let target_rules: Vec<&CleanupRuleDefinition> = self
            .rules
            .iter()
            .filter(|r| rule_id_set.is_empty() || rule_id_set.contains(r.rule.id.as_str()))
            .collect();

        let mut all_candidates = Vec::new();

        for rule in target_rules {
            if cancel.is_cancelled() {
                return Err(CoreError::Cancelled);
            }
            if !Self::is_applicable(rule) {
                continue;
            }

            for target in &rule.targets.paths {
                if cancel.is_cancelled() {
                    return Err(CoreError::Cancelled);
                }

                let expanded = expand_path_variables(&target.path);
                let target_str = expanded.to_string_lossy().to_string();

                if target_str.contains('*') {
                    let first_star = target_str.find('*').unwrap();
                    let prefix = &target_str[..first_star];
                    let base_dir = match prefix.rfind(['/', '\\']) {
                        Some(idx) => PathBuf::from(&prefix[..idx]),
                        None => PathBuf::from("."),
                    };

                    if base_dir.exists() {
                        let base_dir_str = base_dir.to_string_lossy();
                        let rel_pattern = if target_str.len() > base_dir_str.len() {
                            &target_str[base_dir_str.len()..]
                        } else {
                            ""
                        };
                        let segment_count = rel_pattern
                            .split(['/', '\\'])
                            .filter(|s| !s.is_empty())
                            .count();
                        let max_depth = (segment_count + 3).clamp(4, 8);

                        let walk = walkdir::WalkDir::new(&base_dir)
                            .min_depth(1)
                            .max_depth(max_depth)
                            .into_iter();

                        let mut matched_dirs: Vec<PathBuf> = Vec::new();

                        for entry in walk.flatten() {
                            if cancel.is_cancelled() {
                                return Err(CoreError::Cancelled);
                            }

                            let path = entry.path();

                            if matched_dirs.iter().any(|d| path.starts_with(d)) {
                                continue;
                            }

                            let is_dir = entry.file_type().is_dir();
                            let path_str = path.to_string_lossy();

                            let is_match = glob_match(&target_str, &path_str)
                                || (is_dir
                                    && (target_str.ends_with("/*") || target_str.ends_with(r"\*"))
                                    && path != base_dir
                                    && glob_match(&target_str[..target_str.len() - 2], &path_str));

                            if is_match {
                                if is_subpath_protected(path, &rule.disposal.protect_subpaths) {
                                    continue;
                                }

                                if ProtectedPathRegistry::is_protected(path) {
                                    continue;
                                }

                                if is_dir {
                                    matched_dirs.push(path.to_path_buf());
                                }

                                let (size, _) = if is_dir {
                                    calculate_dir_size_with_filter(
                                        path,
                                        &rule.disposal.protect_subpaths,
                                    )
                                } else {
                                    (entry.metadata().map(|m| m.len()).unwrap_or(0), 1)
                                };

                                all_candidates.push(RuleScanCandidate {
                                    path: path.to_path_buf(),
                                    size_bytes: size,
                                    is_dir,
                                    rule_id: rule.rule.id.clone(),
                                    rule_name: rule.rule.name.clone(),
                                    category: rule.rule.category.clone(),
                                    risk: rule.rule.risk.clone(),
                                    verified_rebuildable: rule.rule.verified_rebuildable,
                                    default_action: rule.disposal.default_action.clone(),
                                    protect_subpaths: rule.disposal.protect_subpaths.clone(),
                                });
                            }
                        }
                    }
                } else if expanded.exists()
                    && !is_subpath_protected(&expanded, &rule.disposal.protect_subpaths)
                    && !ProtectedPathRegistry::is_protected(&expanded)
                {
                    let is_dir = expanded.is_dir();
                    let (size, _) = if is_dir {
                        calculate_dir_size_with_filter(&expanded, &rule.disposal.protect_subpaths)
                    } else {
                        (expanded.metadata().map(|m| m.len()).unwrap_or(0), 1)
                    };

                    all_candidates.push(RuleScanCandidate {
                        path: expanded,
                        size_bytes: size,
                        is_dir,
                        rule_id: rule.rule.id.clone(),
                        rule_name: rule.rule.name.clone(),
                        category: rule.rule.category.clone(),
                        risk: rule.rule.risk.clone(),
                        verified_rebuildable: rule.rule.verified_rebuildable,
                        default_action: rule.disposal.default_action.clone(),
                        protect_subpaths: rule.disposal.protect_subpaths.clone(),
                    });
                }
            }
        }

        Ok(all_candidates)
    }
}

fn calculate_dir_size_with_filter(dir: &Path, protect_patterns: &[String]) -> (u64, usize) {
    let mut total = 0u64;
    let mut count = 0usize;
    let walk = walkdir::WalkDir::new(dir).min_depth(1).into_iter();
    for entry in walk.flatten() {
        let p = entry.path();
        if is_subpath_protected(p, protect_patterns) || ProtectedPathRegistry::is_protected(p) {
            continue;
        }
        if entry.file_type().is_file() {
            total += entry.metadata().map(|m| m.len()).unwrap_or(0);
            count += 1;
        }
    }
    (total, count)
}
