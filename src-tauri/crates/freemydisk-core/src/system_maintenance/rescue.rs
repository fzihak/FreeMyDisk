//! Emergency Rescue: frees space fast without bypassing the cleanup safety net.
//!
//! Temporary files, crash dumps, error reports and shader caches go through the
//! same rule scan and disposal pipeline as a normal cleanup, so protected paths
//! and the crash-recovery journal apply. On top of the rules, Emergency Rescue
//! keeps anything changed in the last [`RESCUE_MIN_AGE_HOURS`] hours and any
//! file another program has open.

use crate::cleanup::disposal::{DisposalEngine, DisposalSummary};
use crate::cleanup::plan::CleanupPlan;
use crate::cleanup::rule_engine::{RuleEngine, RuleScanCandidate};
use crate::cleanup::rule_schema::{
    Applicability, ApplicabilityCondition, CleanupRuleDefinition, DisposalConfig, RuleMetadata,
    TargetPath, Targets,
};
use crate::filesystem::journal::CrashRecoveryJournal;
use crate::shared::errors::CoreError;
use crate::shared::progress::CancellationToken;
use freemydisk_platform::traits::PlatformFilesystem;
use freemydisk_platform::{RescueStepOutcome, RescueStepStatus};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Built-in cleanup rules Emergency Rescue runs.
pub const RESCUE_RULE_IDS: &[&str] = &[
    "windows_system_temp",
    "windows_system_crash_dumps",
    "windows_system_wer",
    "windows_system_shader_cache",
];

/// Id of the extra rule for `%WINDIR%\Temp`, which has no built-in rule.
pub const RESCUE_WINDOWS_TEMP_RULE_ID: &str = "rescue_windows_temp";

/// Items changed more recently than this are kept; they may belong to a running app.
pub const RESCUE_MIN_AGE_HOURS: u64 = 24;

/// Step ids in the order Emergency Rescue runs them.
pub const RESCUE_STEPS: &[&str] = &["recycle_bin", "temp_files", "hibernation", "wsl"];

/// What Emergency Rescue did, step by step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmergencyRescueReport {
    pub total_bytes_reclaimed: u64,
    pub hibernation_disabled: bool,
    pub recycle_bin_emptied: bool,
    pub temp_cleaned_bytes: u64,
    pub wsl_shutdown: bool,
    pub actions_performed: Vec<String>,
    pub steps: Vec<RescueStepOutcome>,
}

impl EmergencyRescueReport {
    pub fn from_steps(steps: Vec<RescueStepOutcome>) -> Self {
        let is_done = |id: &str| {
            steps
                .iter()
                .any(|s| s.step == id && s.status == RescueStepStatus::Done)
        };
        Self {
            total_bytes_reclaimed: steps.iter().map(|s| s.bytes_reclaimed).sum(),
            hibernation_disabled: is_done("hibernation"),
            recycle_bin_emptied: is_done("recycle_bin"),
            temp_cleaned_bytes: steps
                .iter()
                .filter(|s| s.step == "temp_files")
                .map(|s| s.bytes_reclaimed)
                .sum(),
            wsl_shutdown: is_done("wsl"),
            actions_performed: steps.iter().map(|s| s.message.clone()).collect(),
            steps,
        }
    }
}

/// Progress of a running Emergency Rescue.
#[derive(Debug, Clone)]
pub struct RescueProgress {
    /// Step id from [`RESCUE_STEPS`].
    pub step: &'static str,
    /// 1-based position of the step.
    pub step_index: usize,
    pub total_steps: usize,
    pub detail: String,
    pub bytes_so_far: u64,
    pub is_complete: bool,
}

/// What the rescue needs from the app to dispose of files safely.
pub struct RescueContext<'a> {
    pub platform: &'a dyn PlatformFilesystem,
    pub journal: &'a CrashRecoveryJournal,
    pub lock_dir: &'a Path,
    pub cancel: &'a CancellationToken,
    pub is_elevated: bool,
}

/// Rule for `%WINDIR%\Temp`, kept to items older than [`RESCUE_MIN_AGE_HOURS`].
pub fn windows_temp_rule() -> CleanupRuleDefinition {
    CleanupRuleDefinition {
        rule: RuleMetadata {
            id: RESCUE_WINDOWS_TEMP_RULE_ID.to_string(),
            name: "Windows System Temp".to_string(),
            category: "system".to_string(),
            risk: "safe".to_string(),
            verified_rebuildable: true,
            verified_at: "2026-11-26".to_string(),
            author: "FreeMyDisk Team".to_string(),
            description: "Temporary files in the Windows folder".to_string(),
            platform: "windows".to_string(),
            default_selected: false,
            locking_processes: Vec::new(),
        },
        applicability: Applicability {
            conditions: vec![ApplicabilityCondition {
                condition_type: "path_exists".to_string(),
                path: Some("${win_dir}/Temp".to_string()),
            }],
        },
        targets: Targets {
            paths: vec![TargetPath {
                path: "${win_dir}/Temp/*".to_string(),
                matcher: "glob".to_string(),
            }],
            min_age_hours: Some(RESCUE_MIN_AGE_HOURS),
        },
        disposal: DisposalConfig {
            default_action: "permanent".to_string(),
            protect_subpaths: Vec::new(),
        },
    }
}

/// Picks the rescue rules out of `available` (plus the Windows Temp rule) and
/// makes each one keep items changed in the last [`RESCUE_MIN_AGE_HOURS`] hours.
pub fn rescue_rules(available: &[CleanupRuleDefinition]) -> Vec<CleanupRuleDefinition> {
    let mut rules: Vec<CleanupRuleDefinition> = available
        .iter()
        .filter(|r| RESCUE_RULE_IDS.contains(&r.rule.id.as_str()))
        .cloned()
        .collect();
    rules.push(windows_temp_rule());
    for rule in &mut rules {
        rule.targets.min_age_hours = Some(
            rule.targets
                .min_age_hours
                .unwrap_or(0)
                .max(RESCUE_MIN_AGE_HOURS),
        );
    }
    rules
}

/// Folders where deleting files needs administrator rights.
fn admin_only_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(windir) = std::env::var("SystemRoot").or_else(|_| std::env::var("windir")) {
        roots.push(PathBuf::from(windir));
    }
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(p) = std::env::var(var) {
            roots.push(PathBuf::from(p));
        }
    }
    if let Ok(pd) = std::env::var("ProgramData") {
        roots.push(PathBuf::from(pd).join("Microsoft"));
    }
    roots
}

fn is_under_any(path: &Path, roots: &[PathBuf]) -> bool {
    let p = path.to_string_lossy().replace('/', "\\").to_lowercase();
    roots.iter().any(|root| {
        let r = root
            .to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase();
        !r.is_empty() && (p == r || p.starts_with(&format!("{}\\", r)))
    })
}

/// True when deleting `path` needs administrator rights (it lies under the
/// Windows folder, Program Files or ProgramData\Microsoft).
pub fn path_requires_admin(path: &Path) -> bool {
    is_under_any(path, &admin_only_roots())
}

/// True when another program has the file open, so deleting it would fail or
/// break that program. Folders are not checked; their deletion fails safely.
pub fn is_file_in_use(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // No sharing: the open fails while any other handle to the file exists.
        options.share_mode(0);
    }
    options.open(path).is_err()
}

/// Rescue candidates split into those that can be cleaned now and those kept.
#[derive(Debug, Default)]
pub struct RescueCandidates {
    pub ready: Vec<RuleScanCandidate>,
    pub kept_in_use: usize,
    pub kept_needs_admin: usize,
}

/// Drops items that are in use, and items that need administrator rights when
/// the app is not elevated.
pub fn filter_rescue_candidates(
    candidates: Vec<RuleScanCandidate>,
    is_elevated: bool,
    admin_roots: &[PathBuf],
) -> RescueCandidates {
    let mut out = RescueCandidates::default();
    for c in candidates {
        if !is_elevated && is_under_any(&c.path, admin_roots) {
            out.kept_needs_admin += 1;
        } else if !c.is_dir && is_file_in_use(&c.path) {
            out.kept_in_use += 1;
        } else {
            out.ready.push(c);
        }
    }
    out
}

/// Scans `rules` and returns what can be cleaned now.
pub fn collect_rescue_candidates(
    rules: &[CleanupRuleDefinition],
    is_elevated: bool,
    admin_roots: &[PathBuf],
    cancel: &CancellationToken,
) -> Result<RescueCandidates, CoreError> {
    let mut all = Vec::new();
    for rule in rules {
        all.extend(RuleEngine::scan_rule(rule, cancel)?.all_candidates);
    }
    Ok(filter_rescue_candidates(all, is_elevated, admin_roots))
}

/// Cleans temporary files, dumps and caches through the disposal pipeline.
pub fn clean_rescue_files<F>(
    rules: &[CleanupRuleDefinition],
    ctx: &RescueContext<'_>,
    admin_roots: &[PathBuf],
    mut on_item: F,
) -> RescueStepOutcome
where
    F: FnMut(usize, usize, &Path, u64),
{
    const STEP: &str = "temp_files";
    let found = match collect_rescue_candidates(rules, ctx.is_elevated, admin_roots, ctx.cancel) {
        Ok(f) => f,
        Err(e) => return RescueStepOutcome::failed(STEP, format!("Scan failed: {}", e)),
    };

    let kept_note = kept_note(found.kept_in_use, found.kept_needs_admin);
    if found.ready.is_empty() {
        return RescueStepOutcome::skipped(
            STEP,
            format!(
                "No temporary files older than {} h to remove{}",
                RESCUE_MIN_AGE_HOURS, kept_note
            ),
        );
    }

    let plan = CleanupPlan::from_candidates(found.ready);
    let summary: DisposalSummary = match DisposalEngine::execute_plan_with_progress(
        &plan.items,
        ctx.platform,
        ctx.journal,
        ctx.lock_dir,
        false,
        ctx.cancel,
        &mut on_item,
    ) {
        Ok(s) => s,
        Err(e) => return RescueStepOutcome::failed(STEP, format!("Cleanup failed: {}", e)),
    };

    let freed = summary.total_freed_bytes;
    let failed_note = if summary.failed_items > 0 {
        format!(", {} could not be removed", summary.failed_items)
    } else {
        String::new()
    };
    let message = format!(
        "Removed {} temporary items ({}){}{}",
        summary.successful_items,
        format_size(freed),
        failed_note,
        kept_note
    );
    if summary.successful_items == 0 && summary.failed_items > 0 {
        let mut outcome = RescueStepOutcome::failed(STEP, message);
        outcome.bytes_reclaimed = freed;
        outcome
    } else {
        RescueStepOutcome::done(STEP, freed, message)
    }
}

fn kept_note(in_use: usize, needs_admin: usize) -> String {
    let mut parts = Vec::new();
    if in_use > 0 {
        parts.push(format!("{} in use", in_use));
    }
    if needs_admin > 0 {
        parts.push(format!("{} need administrator", needs_admin));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("; kept {}", parts.join(", "))
    }
}

fn platform_step(step: &'static str) -> RescueStepOutcome {
    #[cfg(target_os = "windows")]
    {
        use freemydisk_platform::windows::maintenance::WindowsSystemMaintenanceHandler as H;
        match step {
            "recycle_bin" => H::rescue_empty_recycle_bin(),
            "hibernation" => H::rescue_disable_hibernation(),
            "wsl" => H::rescue_shutdown_wsl(),
            _ => RescueStepOutcome::skipped(step, "Not supported"),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        RescueStepOutcome::skipped(step, "Not supported on this system")
    }
}

/// Runs every Emergency Rescue step in order and reports each one.
/// `available_rules` are the loaded cleanup rules (built-in and custom).
pub fn run_emergency_rescue<P>(
    available_rules: &[CleanupRuleDefinition],
    ctx: &RescueContext<'_>,
    mut on_progress: P,
) -> EmergencyRescueReport
where
    P: FnMut(RescueProgress),
{
    let total_steps = RESCUE_STEPS.len();
    let rules = rescue_rules(available_rules);
    let admin_roots = admin_only_roots();
    let mut steps: Vec<RescueStepOutcome> = Vec::with_capacity(total_steps);
    let mut bytes_so_far = 0u64;

    for (idx, &step) in RESCUE_STEPS.iter().enumerate() {
        if ctx.cancel.is_cancelled() {
            steps.push(RescueStepOutcome::skipped(step, "Cancelled"));
            continue;
        }
        on_progress(RescueProgress {
            step,
            step_index: idx + 1,
            total_steps,
            detail: String::new(),
            bytes_so_far,
            is_complete: false,
        });
        let outcome = if step == "temp_files" {
            let base = bytes_so_far;
            clean_rescue_files(&rules, ctx, &admin_roots, |_, _, path, freed| {
                on_progress(RescueProgress {
                    step,
                    step_index: idx + 1,
                    total_steps,
                    detail: path.to_string_lossy().to_string(),
                    bytes_so_far: base + freed,
                    is_complete: false,
                });
            })
        } else {
            platform_step(step)
        };
        bytes_so_far += outcome.bytes_reclaimed;
        steps.push(outcome);
    }

    on_progress(RescueProgress {
        step: RESCUE_STEPS[total_steps - 1],
        step_index: total_steps,
        total_steps,
        detail: String::new(),
        bytes_so_far,
        is_complete: true,
    });
    EmergencyRescueReport::from_steps(steps)
}

fn format_size(bytes: u64) -> String {
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    let b = bytes as f64;
    if b >= GB {
        format!("{:.2} GB", b / GB)
    } else if b >= MB {
        format!("{:.2} MB", b / MB)
    } else if bytes >= 1024 {
        format!("{:.2} KB", b / 1024.0)
    } else {
        format!("{} B", bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{Duration, SystemTime};

    fn rule_for(dir: &Path, min_age_hours: Option<u64>) -> CleanupRuleDefinition {
        let mut rule = windows_temp_rule();
        rule.rule.id = "windows_system_temp".to_string();
        rule.applicability.conditions.clear();
        rule.targets.paths = vec![TargetPath {
            path: format!("{}/*", dir.to_string_lossy()),
            matcher: "glob".to_string(),
        }];
        rule.targets.min_age_hours = min_age_hours;
        rule
    }

    fn make_old(path: &Path) {
        let old = SystemTime::now() - Duration::from_secs(3 * 24 * 3600);
        let mut options = fs::OpenOptions::new();
        if path.is_dir() {
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                // FILE_FLAG_BACKUP_SEMANTICS lets a folder be opened as a file.
                options.write(true).custom_flags(0x0200_0000);
            }
            #[cfg(not(windows))]
            options.read(true);
        } else {
            options.write(true);
        }
        options.open(path).unwrap().set_modified(old).unwrap();
    }

    fn names(c: &[RuleScanCandidate]) -> Vec<String> {
        let mut n: Vec<String> = c
            .iter()
            .map(|c| c.path.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        n.sort();
        n
    }

    #[test]
    fn rescue_rules_enforce_minimum_age_and_add_windows_temp() {
        let available = vec![
            rule_for(Path::new("x"), None),
            rule_for(Path::new("y"), Some(168)),
        ];
        let rules = rescue_rules(&available);
        assert!(rules
            .iter()
            .any(|r| r.rule.id == RESCUE_WINDOWS_TEMP_RULE_ID));
        assert!(rules
            .iter()
            .all(|r| r.targets.min_age_hours.unwrap() >= RESCUE_MIN_AGE_HOURS));
        // A longer age from the rule itself is kept.
        assert!(rules.iter().any(|r| r.targets.min_age_hours == Some(168)));
    }

    #[test]
    fn rescue_rules_ignore_unrelated_rules() {
        let mut other = rule_for(Path::new("z"), None);
        other.rule.id = "chrome_cache".to_string();
        let rules = rescue_rules(&[other]);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].rule.id, RESCUE_WINDOWS_TEMP_RULE_ID);
    }

    #[test]
    fn recent_files_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.tmp");
        let recent = dir.path().join("recent.tmp");
        fs::write(&old, b"old").unwrap();
        fs::write(&recent, b"new").unwrap();
        make_old(&old);

        let rules = rescue_rules(&[rule_for(dir.path(), None)])
            .into_iter()
            .filter(|r| r.rule.id == "windows_system_temp")
            .collect::<Vec<_>>();
        let found =
            collect_rescue_candidates(&rules, true, &[], &CancellationToken::new()).unwrap();
        assert_eq!(names(&found.ready), vec!["old.tmp".to_string()]);
    }

    #[test]
    fn folders_with_recent_files_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let stale = dir.path().join("stale");
        let active = dir.path().join("active");
        fs::create_dir(&stale).unwrap();
        fs::create_dir(&active).unwrap();
        fs::write(stale.join("a.bin"), b"a").unwrap();
        make_old(&stale.join("a.bin"));
        fs::write(active.join("b.bin"), b"b").unwrap();
        make_old(&active.join("b.bin"));
        fs::write(active.join("fresh.bin"), b"c").unwrap();
        // Writing into a folder updates its own time, so age both folders after.
        make_old(&stale);
        make_old(&active);

        let rules = vec![rescue_rules(&[rule_for(dir.path(), None)])
            .into_iter()
            .find(|r| r.rule.id == "windows_system_temp")
            .unwrap()];
        let found =
            collect_rescue_candidates(&rules, true, &[], &CancellationToken::new()).unwrap();
        assert_eq!(names(&found.ready), vec!["stale".to_string()]);
    }

    #[cfg(windows)]
    #[test]
    fn files_in_use_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let busy = dir.path().join("busy.tmp");
        let idle = dir.path().join("idle.tmp");
        fs::write(&busy, b"busy").unwrap();
        fs::write(&idle, b"idle").unwrap();
        make_old(&busy);
        make_old(&idle);
        let _handle = fs::File::open(&busy).unwrap();

        assert!(is_file_in_use(&busy));
        assert!(!is_file_in_use(&idle));

        let rules = vec![rescue_rules(&[rule_for(dir.path(), None)])
            .into_iter()
            .find(|r| r.rule.id == "windows_system_temp")
            .unwrap()];
        let found =
            collect_rescue_candidates(&rules, true, &[], &CancellationToken::new()).unwrap();
        assert_eq!(names(&found.ready), vec!["idle.tmp".to_string()]);
        assert_eq!(found.kept_in_use, 1);
    }

    #[test]
    fn clean_removes_only_old_files_and_is_journaled() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("temp");
        fs::create_dir(&target).unwrap();
        let old = target.join("old.log");
        let recent = target.join("recent.log");
        fs::write(&old, vec![0u8; 2048]).unwrap();
        fs::write(&recent, b"keep").unwrap();
        make_old(&old);

        let state = dir.path().join("state");
        fs::create_dir(&state).unwrap();
        let journal = CrashRecoveryJournal::open(&state.join("journal.db")).unwrap();
        let platform = freemydisk_platform::get_platform();
        let cancel = CancellationToken::new();
        let ctx = RescueContext {
            platform: &platform,
            journal: &journal,
            lock_dir: &state,
            cancel: &cancel,
            is_elevated: false,
        };
        let rules = vec![rescue_rules(&[rule_for(&target, None)])
            .into_iter()
            .find(|r| r.rule.id == "windows_system_temp")
            .unwrap()];

        let outcome = clean_rescue_files(&rules, &ctx, &[], |_, _, _, _| {});
        assert_eq!(
            outcome.status,
            RescueStepStatus::Done,
            "{}",
            outcome.message
        );
        assert_eq!(outcome.bytes_reclaimed, 2048);
        assert!(!old.exists());
        assert!(recent.exists());
        assert!(!journal.list_recent_history(10).unwrap().is_empty());
    }

    #[test]
    fn admin_paths_are_kept_unless_elevated() {
        let dir = tempfile::tempdir().unwrap();
        let admin_root = dir.path().join("Windows");
        fs::create_dir(&admin_root).unwrap();
        let candidate = |path: PathBuf| RuleScanCandidate {
            path,
            size_bytes: 1,
            is_dir: true,
            rule_id: "r".to_string(),
            rule_name: "r".to_string(),
            category: "system".to_string(),
            risk: "safe".to_string(),
            verified_rebuildable: true,
            default_action: "permanent".to_string(),
            protect_subpaths: Vec::new(),
        };
        let roots = vec![admin_root.clone()];
        let items = || {
            vec![
                candidate(admin_root.join("Temp")),
                candidate(dir.path().join("user")),
            ]
        };

        let user = filter_rescue_candidates(items(), false, &roots);
        assert_eq!(user.ready.len(), 1);
        assert_eq!(user.kept_needs_admin, 1);

        let admin = filter_rescue_candidates(items(), true, &roots);
        assert_eq!(admin.ready.len(), 2);
        assert_eq!(admin.kept_needs_admin, 0);
    }

    #[test]
    fn admin_root_matching_respects_folder_boundaries() {
        let roots = vec![PathBuf::from(r"C:\Windows")];
        assert!(is_under_any(Path::new(r"C:\Windows\Temp\a"), &roots));
        assert!(is_under_any(Path::new(r"c:/windows/temp"), &roots));
        assert!(!is_under_any(Path::new(r"C:\WindowsApps\x"), &roots));
        assert!(!is_under_any(Path::new(r"C:\Users\me\AppData"), &roots));
    }

    #[test]
    fn report_sums_steps() {
        let report = EmergencyRescueReport::from_steps(vec![
            RescueStepOutcome::done("recycle_bin", 100, "bin"),
            RescueStepOutcome::done("temp_files", 50, "temp"),
            RescueStepOutcome::skipped("hibernation", "Skipped – needs administrator"),
            RescueStepOutcome::skipped("wsl", "WSL is not installed"),
        ]);
        assert_eq!(report.total_bytes_reclaimed, 150);
        assert_eq!(report.temp_cleaned_bytes, 50);
        assert!(report.recycle_bin_emptied);
        assert!(!report.hibernation_disabled);
        assert!(!report.wsl_shutdown);
        assert_eq!(report.actions_performed.len(), 4);
    }
}
