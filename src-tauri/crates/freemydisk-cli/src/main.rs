use clap::{Parser, Subcommand, ValueEnum};
use colored::*;
use comfy_table::modifiers::UTF8_ROUND_CORNERS;
use comfy_table::presets::UTF8_FULL;
use comfy_table::{Cell, Color, Table};
use freemydisk_core::applications::ApplicationService;
use freemydisk_core::cleanup::disposal::{DisposalEngine, DisposalSummary};
use freemydisk_core::cleanup::plan::CleanupPlan;
use freemydisk_core::cleanup::project_artifacts::ProjectArtifactScanner;
use freemydisk_core::cleanup::rule_engine::RuleEngine;
use freemydisk_core::filesystem::journal::CrashRecoveryJournal;
use freemydisk_core::privacy::{PrivacyCategoryKind, PrivacyService};
use freemydisk_core::shared::progress::CancellationToken;
use freemydisk_core::startup::StartupService;
use freemydisk_core::storage::analyzer::{StorageAnalyzer, StorageTreeNode};
use freemydisk_core::storage::duplicates::{DuplicateDetector, SelectionHeuristic};
use freemydisk_core::storage::heavy_folders::HeavyFoldersScanner;
use freemydisk_core::storage::large_files::LargeFilesScanner;
use freemydisk_core::system_maintenance::MaintenanceService;
use freemydisk_platform::get_platform;
use freemydisk_platform::traits::{PlatformApplications, PlatformFilesystem};
use serde::Serialize;
use std::io::{self, Write};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "freemydisk")]
#[command(author = "FreeMyDisk Team")]
#[command(version = "1.0.0")]
#[command(
    about = "FreeMyDisk Headless CLI — High-performance disk analysis and safe cleanup",
    long_about = None
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, ValueEnum, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    Text,
    Json,
    Csv,
}

#[derive(Subcommand)]
enum Commands {
    /// Scan verified application, browser, and system caches
    Scan {
        /// Optional category filter (e.g. system, browser, development, application, ai)
        #[arg(short, long)]
        category: Option<String>,

        /// Path to custom cleanup rules directory
        #[arg(short, long)]
        rules_path: Option<PathBuf>,

        /// Output format
        #[arg(short, long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },

    /// Clean verified caches with safe Trash-First disposal and WAL recovery journaling
    Clean {
        /// Optional category filter
        #[arg(short, long)]
        category: Option<String>,

        /// Dry-run simulation mode (do not delete or trash any files)
        #[arg(long, default_value_t = false)]
        dry_run: bool,

        /// Send files to OS Recycle Bin / Trash (Default: true)
        #[arg(long, default_value_t = true)]
        always_trash: bool,

        /// Permanently delete files (Overrides always-trash with atomic staging)
        #[arg(long, default_value_t = false)]
        permanent: bool,

        /// Automatically approve cleanup without interactive confirmation
        #[arg(short = 'y', long = "yes", default_value_t = false)]
        yes: bool,

        /// Output format
        #[arg(short, long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },

    /// Detect duplicate files across directories using 4-phase hashing and block identity detection
    Duplicates {
        /// Directories to scan (defaults to current directory if omitted)
        #[arg(short, long, value_delimiter = ' ')]
        roots: Vec<PathBuf>,

        /// Minimum file size in MB to consider (default: 1 MB)
        #[arg(short, long, default_value_t = 1)]
        min_size: u64,

        /// Clean and move duplicate copies to OS Recycle Bin (keeps original based on heuristic)
        #[arg(short, long, default_value_t = false)]
        clean: bool,

        /// Selection heuristic when cleaning (keep-oldest, keep-newest, keep-shortest, keep-longest)
        #[arg(long, default_value = "keep-oldest")]
        heuristic: String,

        /// Automatically approve duplicate disposal without interactive prompt
        #[arg(short = 'y', long = "yes", default_value_t = false)]
        yes: bool,

        /// Output format
        #[arg(short, long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },

    /// Scan for large space-consuming files with extension classification
    LargeFiles {
        /// Directories to scan (defaults to current directory if omitted)
        #[arg(short, long, value_delimiter = ' ')]
        roots: Vec<PathBuf>,

        /// Minimum file size in MB (default: 100 MB)
        #[arg(short, long, default_value_t = 100)]
        min_size: u64,

        /// Maximum number of items to display
        #[arg(short, long, default_value_t = 50)]
        limit: usize,

        /// Trash a specific large file path immediately
        #[arg(long)]
        trash: Option<PathBuf>,

        /// Trash all discovered large files meeting the criteria
        #[arg(long, default_value_t = false)]
        trash_all: bool,

        /// Automatically approve trashing without interactive prompt
        #[arg(short = 'y', long = "yes", default_value_t = false)]
        yes: bool,

        /// Output format
        #[arg(short, long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },

    /// Scan and safely clean developer build artifacts (node_modules, target, .venv, etc.)
    #[command(alias = "dev", alias = "dev-caches")]
    Artifacts {
        /// Root directories to search for projects (defaults to standard dev folders)
        #[arg(short, long, value_delimiter = ' ')]
        roots: Vec<PathBuf>,

        /// Minimum artifact size in MB (default: 1 MB)
        #[arg(short, long, default_value_t = 1)]
        min_size: u64,

        /// Filter projects inactive for at least N days
        #[arg(short, long)]
        inactive_days: Option<u32>,

        /// Safely trash discovered project artifacts to Recycle Bin
        #[arg(short, long, default_value_t = false)]
        clean: bool,

        /// Automatically approve cleanup without interactive confirmation
        #[arg(short = 'y', long = "yes", default_value_t = false)]
        yes: bool,

        /// Output format
        #[arg(short, long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },

    /// Analyze directory space distribution and build hierarchical utilization tree
    Analyze {
        /// Path to directory to analyze (default: current directory)
        #[arg(short, long, default_value = ".")]
        path: PathBuf,

        /// Maximum directory tree depth
        #[arg(short, long, default_value_t = 3)]
        depth: usize,

        /// Output format
        #[arg(short, long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },

    /// Run system diagnostic and maintenance repair tasks
    Maintenance {
        /// List all available maintenance tasks
        #[arg(short, long, default_value_t = false)]
        list: bool,

        /// Run a specific maintenance task by ID (e.g. icon_cache, dns_flush, search_index, update_cache)
        #[arg(short, long)]
        task: Option<String>,

        /// Run all recommended safe maintenance tasks
        #[arg(long, default_value_t = false)]
        all: bool,

        /// Output format
        #[arg(short, long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },

    /// List startup applications with boot impact ratings
    Startup {
        /// Output format
        #[arg(short, long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },

    /// Identify monster subfolders >= 1GB using bottom-up directory aggregation
    HeavyFolders {
        /// Root directory to inspect (default: current directory)
        #[arg(short, long, default_value = ".")]
        path: PathBuf,

        /// Minimum folder size in GB (default: 1 GB)
        #[arg(short, long, default_value_t = 1)]
        min_size_gb: u64,

        /// Maximum traversal depth (default: 6)
        #[arg(short, long, default_value_t = 6)]
        depth: usize,

        /// Output format
        #[arg(short, long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },

    /// List installed software applications, Windows Store apps, and leftovers
    Apps {
        /// Show leftovers for uninstalled software
        #[arg(short, long, default_value_t = false)]
        leftovers: bool,

        /// Clean all detected orphaned software leftovers
        #[arg(long, default_value_t = false)]
        clean_leftovers: bool,

        /// Automatically approve leftover cleanup without interactive confirmation
        #[arg(short = 'y', long = "yes", default_value_t = false)]
        yes: bool,

        /// Output format
        #[arg(short, long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },

    /// Scan browser traces, cookies, and system activity logs
    Privacy {
        /// Clean safe privacy traces (caches and activity logs)
        #[arg(short, long, default_value_t = false)]
        clean: bool,

        /// Clean all privacy items including cookies and history
        #[arg(long, default_value_t = false)]
        clean_all: bool,

        /// Filter by category (e.g. cache, history, cookies, downloads, sessions, system_activity)
        #[arg(long)]
        category: Option<String>,

        /// Terminate running browsers to release SQLite database locks before cleaning
        #[arg(long, default_value_t = false)]
        close_browsers: bool,

        /// Whitelist domain names to preserve cookies for (comma-separated)
        #[arg(long, value_delimiter = ',')]
        whitelist: Vec<String>,

        /// Automatically approve cleanup without interactive confirmation
        #[arg(short = 'y', long = "yes", default_value_t = false)]
        yes: bool,

        /// Output format
        #[arg(short, long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },

    /// Display system hardware vitals, memory utilization, and storage volumes
    Vitals {
        /// Output format
        #[arg(short, long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },

    /// Execute 1-click Emergency Disk Rescue to immediately free critical disk space
    Rescue {
        /// Skip interactive confirmation prompt
        #[arg(short = 'y', long, default_value_t = false)]
        yes: bool,

        /// Output format
        #[arg(short, long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },

    /// Manage and compact virtual machine storage (WSL2 distributions and Docker footprint)
    Virtualization {
        /// List all WSL2 distributions, VHDX physical sizes, and Docker status
        #[arg(short, long, default_value_t = false)]
        list: bool,

        /// Compact specified WSL2 distribution's VHDX virtual disk image
        #[arg(short, long)]
        compact: Option<String>,

        /// Output format
        #[arg(short, long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
}

pub fn format_bytes(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;
    const TB: f64 = GB * 1024.0;

    let b = bytes as f64;
    if b >= TB {
        format!("{:.2} TB", b / TB)
    } else if b >= GB {
        format!("{:.2} GB", b / GB)
    } else if b >= MB {
        format!("{:.2} MB", b / MB)
    } else if b >= KB {
        format!("{:.2} KB", b / KB)
    } else {
        format!("{} B", bytes)
    }
}

fn main() {
    let cli = Cli::parse();
    let cancel = CancellationToken::new();

    match cli.command {
        Commands::Scan {
            category,
            rules_path,
            format,
        } => {
            handle_scan(category, rules_path, format, &cancel);
        }
        Commands::Clean {
            category,
            dry_run,
            always_trash,
            permanent,
            yes,
            format,
        } => {
            handle_clean(
                category,
                dry_run,
                always_trash,
                permanent,
                yes,
                format,
                &cancel,
            );
        }
        Commands::Duplicates {
            roots,
            min_size,
            clean,
            heuristic,
            yes,
            format,
        } => {
            handle_duplicates(roots, min_size, clean, heuristic, yes, format, &cancel);
        }
        Commands::LargeFiles {
            roots,
            min_size,
            limit,
            trash,
            trash_all,
            yes,
            format,
        } => {
            handle_large_files(
                roots, min_size, limit, trash, trash_all, yes, format, &cancel,
            );
        }
        Commands::Artifacts {
            roots,
            min_size,
            inactive_days,
            clean,
            yes,
            format,
        } => {
            handle_artifacts(roots, min_size, inactive_days, clean, yes, format, &cancel);
        }
        Commands::Analyze {
            path,
            depth,
            format,
        } => {
            handle_analyze(path, depth, format, &cancel);
        }
        Commands::Maintenance {
            list,
            task,
            all,
            format,
        } => {
            handle_maintenance(list, task, all, format);
        }
        Commands::Startup { format } => {
            handle_startup(format);
        }
        Commands::HeavyFolders {
            path,
            min_size_gb,
            depth,
            format,
        } => {
            handle_heavy_folders(path, min_size_gb, depth, format, &cancel);
        }
        Commands::Apps {
            leftovers,
            clean_leftovers,
            yes,
            format,
        } => {
            handle_apps(leftovers, clean_leftovers, yes, format);
        }
        Commands::Privacy {
            clean,
            clean_all,
            category,
            close_browsers,
            whitelist,
            yes,
            format,
        } => {
            handle_privacy(
                clean,
                clean_all,
                category,
                close_browsers,
                whitelist,
                yes,
                format,
            );
        }
        Commands::Vitals { format } => {
            handle_vitals(format);
        }
        Commands::Rescue { yes, format } => {
            handle_rescue(yes, format);
        }
        Commands::Virtualization {
            list,
            compact,
            format,
        } => {
            handle_virtualization(list, compact, format);
        }
    }
}

fn handle_scan(
    category: Option<String>,
    rules_path: Option<PathBuf>,
    format: OutputFormat,
    cancel: &CancellationToken,
) {
    let mut engine = RuleEngine::new();
    if let Some(custom_dir) = rules_path {
        if let Err(e) = engine.load_custom_rules_from_dir(&custom_dir) {
            eprintln!(
                "{}: Failed to load custom rules: {}",
                "Error".red().bold(),
                e
            );
        }
    }

    let summaries = match engine.scan_all(cancel) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{}: Scan failed: {}", "Error".red().bold(), e);
            std::process::exit(1);
        }
    };

    let filtered: Vec<_> = summaries
        .into_iter()
        .filter(|s| {
            if let Some(cat) = &category {
                s.category.eq_ignore_ascii_case(cat)
            } else {
                true
            }
        })
        .collect();

    match format {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(&filtered).unwrap());
        }
        OutputFormat::Csv => {
            println!("RuleID,RuleName,Category,Risk,Rebuildable,ItemsCount,TotalBytes");
            for s in &filtered {
                println!(
                    "\"{}\",\"{}\",\"{}\",\"{}\",{},{},{}",
                    s.rule_id,
                    s.rule_name,
                    s.category,
                    s.risk,
                    s.verified_rebuildable,
                    s.total_items,
                    s.total_bytes
                );
            }
        }
        OutputFormat::Text => {
            println!(
                "{}",
                "FreeMyDisk — Cache & Artifact Scan Results".bold().cyan()
            );
            println!("{}", "═".repeat(65).dimmed());

            let mut table = Table::new();
            table
                .load_preset(UTF8_FULL)
                .apply_modifier(UTF8_ROUND_CORNERS)
                .set_header(vec![
                    Cell::new("Rule ID").fg(Color::Cyan),
                    Cell::new("Category").fg(Color::White),
                    Cell::new("Risk").fg(Color::Yellow),
                    Cell::new("Items").fg(Color::White),
                    Cell::new("Size").fg(Color::Green),
                ]);

            let mut grand_bytes = 0u64;
            let mut grand_items = 0usize;

            for s in &filtered {
                grand_bytes += s.total_bytes;
                grand_items += s.total_items;

                let risk_color = match s.risk.to_ascii_lowercase().as_str() {
                    "safe" => Color::Green,
                    "caution" => Color::Yellow,
                    _ => Color::Red,
                };

                table.add_row(vec![
                    Cell::new(&s.rule_id),
                    Cell::new(&s.category),
                    Cell::new(&s.risk).fg(risk_color),
                    Cell::new(s.total_items.to_string()),
                    Cell::new(format_bytes(s.total_bytes)),
                ]);
            }

            println!("{table}");
            println!();
            println!(
                "Summary: {} items found across {} rules, eligible to recover {}.",
                grand_items.to_string().cyan().bold(),
                filtered.len().to_string().bold(),
                format_bytes(grand_bytes).green().bold()
            );
        }
    }
}

fn handle_clean(
    category: Option<String>,
    dry_run: bool,
    always_trash: bool,
    permanent: bool,
    yes: bool,
    format: OutputFormat,
    cancel: &CancellationToken,
) {
    let engine = RuleEngine::new();
    let summaries = match engine.scan_all(cancel) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{}: Scan before clean failed: {}", "Error".red().bold(), e);
            std::process::exit(1);
        }
    };

    let candidates: Vec<_> = summaries
        .into_iter()
        .filter(|s| {
            if let Some(cat) = &category {
                s.category.eq_ignore_ascii_case(cat)
            } else {
                true
            }
        })
        .flat_map(|s| s.candidates)
        .collect();

    if candidates.is_empty() {
        if format == OutputFormat::Text {
            println!("{}", "No matching caches found to clean.".green().bold());
        } else if format == OutputFormat::Json {
            println!("[]");
        }
        return;
    }

    let plan = CleanupPlan::from_candidates(candidates);
    let effective_always_trash = if permanent { false } else { always_trash };

    if !yes && !dry_run {
        print!(
            "Found {} candidate items ({}). Proceed with {}? [y/N]: ",
            plan.total_items.to_string().cyan().bold(),
            format_bytes(plan.total_reclaimable_bytes).yellow().bold(),
            if effective_always_trash {
                "Recycle Bin / Trash disposal".green()
            } else {
                "PERMANENT DELETION".red().bold()
            }
        );
        io::stdout().flush().unwrap();
        let mut input = String::new();
        if io::stdin().read_line(&mut input).is_err() || !input.trim().eq_ignore_ascii_case("y") {
            println!("{}", "Cleanup cancelled by user.".yellow());
            return;
        }
    }

    if dry_run {
        match format {
            OutputFormat::Json => {
                println!("{}", serde_json::to_string_pretty(&plan).unwrap());
            }
            OutputFormat::Csv => {
                println!("OriginalPath,Size,IsDir,Risk,DefaultAction");
                for item in &plan.items {
                    println!(
                        "\"{}\",{},{},\"{}\",\"{}\"",
                        item.original_path.display(),
                        item.size_bytes,
                        item.is_dir,
                        item.risk,
                        item.default_action
                    );
                }
            }
            OutputFormat::Text => {
                println!(
                    "{} DRY RUN: Would remove {} items recovering {}.",
                    "[SIMULATION]".bold().yellow(),
                    plan.total_items.to_string().cyan(),
                    format_bytes(plan.total_reclaimable_bytes).green().bold()
                );
                for item in &plan.items {
                    println!(
                        "  {} {} ({})",
                        "•".dimmed(),
                        item.original_path.display(),
                        format_bytes(item.size_bytes).dimmed()
                    );
                }
            }
        }
        return;
    }

    let (journal, temp_dir) = get_cli_recovery_context();
    let platform = get_platform();
    let summary = match DisposalEngine::execute_plan(
        &plan.items,
        &platform,
        &journal,
        &temp_dir,
        effective_always_trash,
        cancel,
    ) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{}: Disposal execution failed: {}", "Error".red().bold(), e);
            std::process::exit(1);
        }
    };

    print_disposal_summary(&summary, format);
}

/// Journal and lock folder shared with the desktop app, so the two never dispose of
/// files at the same time and CLI runs appear in the app's history.
fn get_cli_recovery_context() -> (CrashRecoveryJournal, PathBuf) {
    let data_dir = freemydisk_core::shared::paths::app_data_dir()
        .unwrap_or_else(|| std::env::temp_dir().join("freemydisk_cli"));
    let lock_dir = data_dir.join("locks");
    let _ = std::fs::create_dir_all(&lock_dir);
    let journal_path = data_dir.join("journal.db");
    let journal = match CrashRecoveryJournal::open(&journal_path) {
        Ok(j) => j,
        Err(e) => {
            eprintln!(
                "{}: Failed to initialize SQLite WAL crash recovery journal: {}",
                "Error".red().bold(),
                e
            );
            std::process::exit(1);
        }
    };
    (journal, lock_dir)
}

fn print_disposal_summary(summary: &DisposalSummary, format: OutputFormat) {
    match format {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(summary).unwrap());
        }
        OutputFormat::Csv => {
            println!("Path,Success,BytesFreed,RouteUsed,Error");
            for r in &summary.results {
                println!(
                    "\"{}\",{},{},\"{}\",\"{}\"",
                    r.path.display(),
                    r.success,
                    r.bytes_freed,
                    r.route_used,
                    r.error.as_deref().unwrap_or("")
                );
            }
        }
        OutputFormat::Text => {
            println!("{}", "Disposal Summary:".bold().cyan());
            println!(
                "  • Requested Items: {}",
                summary.total_requested_items.to_string().bold()
            );
            println!(
                "  • Successfully Cleaned: {}",
                summary.successful_items.to_string().green().bold()
            );
            println!(
                "  • Failed: {}",
                if summary.failed_items > 0 {
                    summary.failed_items.to_string().red().bold()
                } else {
                    "0".green().bold()
                }
            );
            println!(
                "  • Space Recovered: {}",
                format_bytes(summary.total_freed_bytes).green().bold()
            );

            if !summary.failed_trash_paths.is_empty() {
                println!(
                    "\n{}: {} items failed Recycle Bin disposal and were NOT permanently deleted (Safety Invariant preserved).",
                    "Warning".yellow().bold(),
                    summary.failed_trash_paths.len()
                );
            }
        }
    }
}

fn terminate_running_browsers() -> usize {
    let platform = get_platform();
    let target_exes = [
        "chrome.exe",
        "msedge.exe",
        "brave.exe",
        "vivaldi.exe",
        "arc.exe",
        "chromium.exe",
        "firefox.exe",
        "librewolf.exe",
        "floorp.exe",
        "waterfox.exe",
        "opera.exe",
        "operagx.exe",
    ];
    let mut closed = 0;
    if let Ok(procs) = platform.list_running_processes() {
        for p in procs {
            let p_name = p.name.to_lowercase();
            if target_exes.iter().any(|&t| t == p_name) && platform.terminate_process(p.pid).is_ok()
            {
                closed += 1;
            }
        }
    }
    closed
}

fn handle_duplicates(
    roots: Vec<PathBuf>,
    min_size_mb: u64,
    clean: bool,
    heuristic: String,
    yes: bool,
    format: OutputFormat,
    cancel: &CancellationToken,
) {
    let resolved_roots = if roots.is_empty() {
        vec![std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))]
    } else {
        roots
    };

    let min_size_bytes = min_size_mb * 1024 * 1024;
    let platform = get_platform();

    let mut result = match DuplicateDetector::scan_duplicates(
        &resolved_roots,
        min_size_bytes,
        &platform,
        cancel,
    ) {
        Ok(res) => res,
        Err(e) => {
            eprintln!("{}: Duplicate scan failed: {}", "Error".red().bold(), e);
            std::process::exit(1);
        }
    };

    if clean {
        if result.groups.is_empty() {
            if format == OutputFormat::Text {
                println!(
                    "{}",
                    "No duplicate files found meeting criteria to clean.".green()
                );
            } else if format == OutputFormat::Json {
                println!("[]");
            }
            return;
        }

        let h = match heuristic.to_lowercase().replace('_', "-").as_str() {
            "keep-newest" => SelectionHeuristic::KeepNewest,
            "keep-shortest" | "keep-shortest-path" => SelectionHeuristic::KeepShortestPath,
            "keep-longest" | "keep-longest-path" => SelectionHeuristic::KeepLongestPath,
            _ => SelectionHeuristic::KeepOldest,
        };
        DuplicateDetector::apply_selection_heuristic(&mut result.groups, h);

        let mut selected_files = 0usize;
        let mut selected_bytes = 0u64;
        for g in &result.groups {
            for f in &g.files {
                if f.selected {
                    selected_files += 1;
                    selected_bytes += f.size_bytes;
                }
            }
        }

        if selected_files == 0 {
            if format == OutputFormat::Text {
                println!(
                    "{}",
                    "No duplicate copies selected for removal based on heuristic.".yellow()
                );
            } else if format == OutputFormat::Json {
                println!("[]");
            }
            return;
        }

        if !yes {
            print!(
                "Found {} duplicate copies ({}) across {} groups to move to Recycle Bin (preserving 1 original per group). Proceed? [y/N]: ",
                selected_files.to_string().cyan().bold(),
                format_bytes(selected_bytes).yellow().bold(),
                result.groups.len().to_string().bold()
            );
            let _ = io::stdout().flush();
            let mut input = String::new();
            if io::stdin().read_line(&mut input).is_err() || !input.trim().eq_ignore_ascii_case("y")
            {
                println!("{}", "Duplicate disposal cancelled by user.".yellow());
                return;
            }
        }

        let (journal, lock_dir) = get_cli_recovery_context();
        let summary = match DuplicateDetector::batch_trash_duplicates(
            &result.groups,
            &platform,
            &journal,
            &lock_dir,
            cancel,
        ) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("{}: Duplicate disposal failed: {}", "Error".red().bold(), e);
                std::process::exit(1);
            }
        };

        print_disposal_summary(&summary, format);
        return;
    }

    match format {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(&result).unwrap());
        }
        OutputFormat::Csv => {
            println!("GroupID,Hash,FileSize,FileCount,PotentialSavings,FilePath,IsHardlink");
            for g in &result.groups {
                for f in &g.files {
                    println!(
                        "\"{}\",\"{}\",{},{},{},\"{}\",{}",
                        g.group_id,
                        g.hash,
                        g.file_size,
                        g.files.len(),
                        g.potential_savings_bytes,
                        f.path.display(),
                        f.is_hardlink_or_clone
                    );
                }
            }
        }
        OutputFormat::Text => {
            println!(
                "{}",
                "FreeMyDisk — Duplicate File Detection Results"
                    .bold()
                    .cyan()
            );
            println!("{}", "═".repeat(65).dimmed());

            if result.groups.is_empty() {
                println!("{}", "No duplicate files found meeting criteria.".green());
                return;
            }

            let mut table = Table::new();
            table
                .load_preset(UTF8_FULL)
                .apply_modifier(UTF8_ROUND_CORNERS)
                .set_header(vec![
                    Cell::new("Hash (BLAKE3)").fg(Color::Cyan),
                    Cell::new("File Size").fg(Color::White),
                    Cell::new("Copies").fg(Color::Yellow),
                    Cell::new("Potential Savings").fg(Color::Green),
                ]);

            for g in &result.groups {
                let hash_preview = if g.hash.len() > 12 {
                    &g.hash[..12]
                } else {
                    &g.hash
                };

                table.add_row(vec![
                    Cell::new(hash_preview),
                    Cell::new(format_bytes(g.file_size)),
                    Cell::new(g.files.len().to_string()),
                    Cell::new(format_bytes(g.potential_savings_bytes)),
                ]);
            }

            println!("{table}");
            println!();
            println!(
                "Duplicate Summary: {} duplicate groups found ({} files). Potential savings: {}.",
                result.total_groups.to_string().cyan().bold(),
                result.total_duplicate_files.to_string().bold(),
                format_bytes(result.total_potential_savings).green().bold()
            );
            println!("Run with --clean to move non-original duplicate copies to the Recycle Bin.");
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_large_files(
    roots: Vec<PathBuf>,
    min_size_mb: u64,
    limit: usize,
    trash: Option<PathBuf>,
    trash_all: bool,
    yes: bool,
    format: OutputFormat,
    cancel: &CancellationToken,
) {
    let resolved_roots = if roots.is_empty() {
        vec![std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))]
    } else {
        roots
    };

    let platform = get_platform();

    if let Some(target_file) = trash {
        if !target_file.exists() {
            eprintln!(
                "{}: Target file '{}' does not exist.",
                "Error".red().bold(),
                target_file.display()
            );
            std::process::exit(1);
        }

        let file_size = target_file.metadata().map(|m| m.len()).unwrap_or(0);
        if !yes {
            print!(
                "Proceed with moving large file '{}' ({}) to Recycle Bin? [y/N]: ",
                target_file.display().to_string().cyan().bold(),
                format_bytes(file_size).yellow().bold()
            );
            let _ = io::stdout().flush();
            let mut input = String::new();
            if io::stdin().read_line(&mut input).is_err() || !input.trim().eq_ignore_ascii_case("y")
            {
                println!("{}", "Trashing cancelled by user.".yellow());
                return;
            }
        }

        let (journal, lock_dir) = get_cli_recovery_context();
        match LargeFilesScanner::trash_large_file(&target_file, &platform, &journal, &lock_dir) {
            Ok(res) => match format {
                OutputFormat::Json => {
                    println!("{}", serde_json::to_string_pretty(&res).unwrap());
                }
                OutputFormat::Csv => {
                    println!("Path,Success,BytesFreed,RouteUsed,Error");
                    println!(
                        "\"{}\",{},{},\"{}\",\"{}\"",
                        res.path.display(),
                        res.success,
                        res.bytes_freed,
                        res.route_used,
                        res.error.as_deref().unwrap_or("")
                    );
                }
                OutputFormat::Text => {
                    if res.success {
                        println!(
                            "{} Successfully moved '{}' to Recycle Bin (reclaimed {}).",
                            "✓".green().bold(),
                            res.path.display(),
                            format_bytes(res.bytes_freed).green().bold()
                        );
                    } else {
                        eprintln!(
                            "{} Failed to trash '{}': {}",
                            "✗".red().bold(),
                            res.path.display(),
                            res.error.as_deref().unwrap_or("Unknown error")
                        );
                        std::process::exit(1);
                    }
                }
            },
            Err(e) => {
                eprintln!(
                    "{}: Failed to trash large file: {}",
                    "Error".red().bold(),
                    e
                );
                std::process::exit(1);
            }
        }
        return;
    }

    let min_size_bytes = min_size_mb * 1024 * 1024;
    let mut scan_result =
        match LargeFilesScanner::scan_large_files(&resolved_roots, min_size_bytes, cancel) {
            Ok(res) => res,
            Err(e) => {
                eprintln!("{}: Large files scan failed: {}", "Error".red().bold(), e);
                std::process::exit(1);
            }
        };

    if trash_all {
        if scan_result.files.is_empty() {
            if format == OutputFormat::Text {
                println!(
                    "{}",
                    "No large files found above threshold to trash.".green()
                );
            } else if format == OutputFormat::Json {
                println!("[]");
            }
            return;
        }

        let paths: Vec<PathBuf> = scan_result.files.iter().map(|f| f.path.clone()).collect();
        if !yes {
            print!(
                "Found {} large file(s) totaling {}. Proceed with moving all to Recycle Bin? [y/N]: ",
                paths.len().to_string().cyan().bold(),
                format_bytes(scan_result.total_bytes).yellow().bold()
            );
            let _ = io::stdout().flush();
            let mut input = String::new();
            if io::stdin().read_line(&mut input).is_err() || !input.trim().eq_ignore_ascii_case("y")
            {
                println!(
                    "{}",
                    "Large file batch disposal cancelled by user.".yellow()
                );
                return;
            }
        }

        let (journal, lock_dir) = get_cli_recovery_context();
        let summary =
            match LargeFilesScanner::trash_large_files(&paths, &platform, &journal, &lock_dir) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("{}: Batch trashing failed: {}", "Error".red().bold(), e);
                    std::process::exit(1);
                }
            };

        print_disposal_summary(&summary, format);
        return;
    }

    scan_result
        .files
        .sort_by_key(|f| std::cmp::Reverse(f.size_bytes));
    if scan_result.files.len() > limit {
        scan_result.files.truncate(limit);
    }

    match format {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(&scan_result).unwrap());
        }
        OutputFormat::Csv => {
            println!("Path,Name,Size,Category,Extension");
            for f in &scan_result.files {
                println!(
                    "\"{}\",\"{}\",{},\"{:?}\",\"{}\"",
                    f.path.display(),
                    f.name,
                    f.size_bytes,
                    f.category,
                    f.extension
                );
            }
        }
        OutputFormat::Text => {
            println!("{}", "FreeMyDisk — Large Files Discovery".bold().cyan());
            println!("{}", "═".repeat(65).dimmed());

            if scan_result.files.is_empty() {
                println!("{}", "No large files found above threshold.".green());
                return;
            }

            let mut table = Table::new();
            table
                .load_preset(UTF8_FULL)
                .apply_modifier(UTF8_ROUND_CORNERS)
                .set_header(vec![
                    Cell::new("Name").fg(Color::Cyan),
                    Cell::new("Category").fg(Color::White),
                    Cell::new("Size").fg(Color::Green),
                    Cell::new("Path").fg(Color::DarkGrey),
                ]);

            for f in &scan_result.files {
                table.add_row(vec![
                    Cell::new(&f.name),
                    Cell::new(format!("{:?}", f.category)),
                    Cell::new(format_bytes(f.size_bytes)),
                    Cell::new(f.path.to_string_lossy()),
                ]);
            }

            println!("{table}");
            println!();
            println!(
                "Found {} large files totaling {}.",
                scan_result.files.len().to_string().cyan().bold(),
                format_bytes(scan_result.total_bytes).green().bold()
            );
            println!("Run with --trash <path> or --trash-all to move files to the Recycle Bin.");
        }
    }
}

fn handle_artifacts(
    roots: Vec<PathBuf>,
    min_size_mb: u64,
    inactive_days: Option<u32>,
    clean: bool,
    yes: bool,
    format: OutputFormat,
    cancel: &CancellationToken,
) {
    let effective_roots = if roots.is_empty() {
        ProjectArtifactScanner::default_dev_roots()
    } else {
        roots
    };

    let min_size_bytes = min_size_mb * 1024 * 1024;
    let mut scan_result =
        match ProjectArtifactScanner::scan(&effective_roots, Some(min_size_bytes), cancel) {
            Ok(res) => res,
            Err(e) => {
                eprintln!(
                    "{}: Developer artifacts scan failed: {}",
                    "Error".red().bold(),
                    e
                );
                std::process::exit(1);
            }
        };

    if let Some(days) = inactive_days {
        scan_result
            .projects
            .retain(|p| p.last_modified_days_ago >= days);
        scan_result.total_projects = scan_result.projects.len();
        scan_result.total_artifacts = scan_result.projects.iter().map(|p| p.artifacts.len()).sum();
        scan_result.total_reclaimable_bytes = scan_result
            .projects
            .iter()
            .map(|p| p.total_reclaimable_bytes)
            .sum();
    }

    if clean {
        let mut artifact_paths = Vec::new();
        for proj in &scan_result.projects {
            for art in &proj.artifacts {
                artifact_paths.push(art.path.clone());
            }
        }

        if artifact_paths.is_empty() {
            if format == OutputFormat::Text {
                println!(
                    "{}",
                    "No developer project artifacts found meeting criteria to clean.".green()
                );
            } else if format == OutputFormat::Json {
                println!("[]");
            }
            return;
        }

        if !yes {
            print!(
                "Found {} project artifact folder(s) ({}) across {} project(s). Proceed with moving to Recycle Bin? [y/N]: ",
                artifact_paths.len().to_string().cyan().bold(),
                format_bytes(scan_result.total_reclaimable_bytes).yellow().bold(),
                scan_result.total_projects.to_string().bold()
            );
            let _ = io::stdout().flush();
            let mut input = String::new();
            if io::stdin().read_line(&mut input).is_err() || !input.trim().eq_ignore_ascii_case("y")
            {
                println!("{}", "Artifact cleanup cancelled by user.".yellow());
                return;
            }
        }

        let (journal, lock_dir) = get_cli_recovery_context();
        let platform = get_platform();
        let summary = match ProjectArtifactScanner::clean_artifacts(
            &artifact_paths,
            &platform,
            &journal,
            &lock_dir,
            cancel,
        ) {
            Ok(s) => s,
            Err(e) => {
                eprintln!(
                    "{}: Developer artifact disposal failed: {}",
                    "Error".red().bold(),
                    e
                );
                std::process::exit(1);
            }
        };

        print_disposal_summary(&summary, format);
        return;
    }

    match format {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(&scan_result).unwrap());
        }
        OutputFormat::Csv => {
            println!("ProjectName,ProjectType,ProjectRoot,ArtifactRelativePath,ArtifactSize,ItemCount,InactiveDays,VerifiedRebuildable");
            for p in &scan_result.projects {
                for a in &p.artifacts {
                    println!(
                        "\"{}\",\"{}\",\"{}\",\"{}\",{},{},{},{}",
                        p.project_name,
                        p.project_type,
                        p.project_root.display(),
                        a.relative_path,
                        a.size_bytes,
                        a.item_count,
                        a.staleness_days,
                        a.verified_rebuildable
                    );
                }
            }
        }
        OutputFormat::Text => {
            println!(
                "{}",
                "FreeMyDisk — Developer Project Artifacts & Build Caches"
                    .bold()
                    .cyan()
            );
            println!("{}", "═".repeat(80).dimmed());

            if scan_result.projects.is_empty() {
                println!("{}", "No developer project build artifacts found.".green());
                return;
            }

            let mut table = Table::new();
            table
                .load_preset(UTF8_FULL)
                .apply_modifier(UTF8_ROUND_CORNERS)
                .set_header(vec![
                    Cell::new("Project").fg(Color::Cyan),
                    Cell::new("Type").fg(Color::White),
                    Cell::new("Artifact").fg(Color::Yellow),
                    Cell::new("Size").fg(Color::Green),
                    Cell::new("Inactive").fg(Color::White),
                    Cell::new("Project Path").fg(Color::DarkGrey),
                ]);

            for p in &scan_result.projects {
                for a in &p.artifacts {
                    table.add_row(vec![
                        Cell::new(&p.project_name),
                        Cell::new(&p.project_type),
                        Cell::new(&a.relative_path),
                        Cell::new(format_bytes(a.size_bytes)),
                        Cell::new(format!("{}d", a.staleness_days)),
                        Cell::new(p.project_root.display().to_string()),
                    ]);
                }
            }

            println!("{table}");
            println!();
            println!(
                "Discovered {} projects with {} artifact folders totaling {}.",
                scan_result.total_projects.to_string().cyan().bold(),
                scan_result.total_artifacts.to_string().bold(),
                format_bytes(scan_result.total_reclaimable_bytes)
                    .green()
                    .bold()
            );
            println!("Use --clean to safely move these artifacts to the OS Recycle Bin.");
        }
    }
}

fn handle_analyze(path: PathBuf, depth: usize, format: OutputFormat, cancel: &CancellationToken) {
    let platform = get_platform();
    let root_node = match StorageAnalyzer::scan_directory(&path, depth, &platform, cancel) {
        Ok(node) => node,
        Err(e) => {
            eprintln!("{}: Storage analysis failed: {}", "Error".red().bold(), e);
            std::process::exit(1);
        }
    };

    match format {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(&root_node).unwrap());
        }
        OutputFormat::Csv => {
            println!("Path,Name,Size,FileCount,DirCount,IsDir");
            fn dump_csv(node: &StorageTreeNode) {
                println!(
                    "\"{}\",\"{}\",{},{},{},{}",
                    node.path.display(),
                    node.name,
                    node.size_bytes,
                    node.file_count,
                    node.dir_count,
                    node.is_dir
                );
                for c in &node.children {
                    dump_csv(c);
                }
            }
            dump_csv(&root_node);
        }
        OutputFormat::Text => {
            println!(
                "{}",
                format!("Storage Utilization Tree: {}", path.display())
                    .bold()
                    .cyan()
            );
            println!("{}", "═".repeat(65).dimmed());
            print_tree_node(&root_node, "", true, 0, depth);
            println!();
            println!(
                "Total Size: {} ({} files, {} directories)",
                format_bytes(root_node.size_bytes).green().bold(),
                root_node.file_count.to_string().cyan(),
                root_node.dir_count.to_string().cyan()
            );
        }
    }
}

fn print_tree_node(
    node: &StorageTreeNode,
    prefix: &str,
    is_last: bool,
    depth: usize,
    max_depth: usize,
) {
    let branch = if depth == 0 {
        ""
    } else if is_last {
        "└── "
    } else {
        "├── "
    };

    let size_str = format_bytes(node.size_bytes);
    let name_str = if node.is_dir {
        node.name.bold().to_string()
    } else {
        node.name.clone()
    };

    println!(
        "{}{}{} ({} - {} items)",
        prefix,
        branch.green(),
        name_str,
        size_str.cyan().bold(),
        node.file_count + node.dir_count
    );

    if depth < max_depth && !node.children.is_empty() {
        let child_prefix = if depth == 0 {
            ""
        } else {
            &format!("{}{}", prefix, if is_last { "    " } else { "│   " })
        };
        let len = node.children.len();
        for (idx, child) in node.children.iter().enumerate() {
            print_tree_node(child, child_prefix, idx == len - 1, depth + 1, max_depth);
        }
    }
}

fn handle_maintenance(_list: bool, task: Option<String>, all: bool, format: OutputFormat) {
    let service = MaintenanceService::new();

    if let Some(task_id) = task {
        let res = service.execute_task(&task_id);
        match format {
            OutputFormat::Json => {
                println!("{}", serde_json::to_string_pretty(&res).unwrap());
            }
            OutputFormat::Csv => {
                println!("TaskID,Success,Message");
                println!("\"{}\",{},\"{}\"", res.task_id, res.success, res.message);
            }
            OutputFormat::Text => {
                if res.success {
                    println!(
                        "{} Task '{}' succeeded: {}",
                        "✓".green().bold(),
                        res.task_id.bold(),
                        res.message
                    );
                } else {
                    eprintln!(
                        "{} Task '{}' failed: {}",
                        "✗".red().bold(),
                        res.task_id.bold(),
                        res.message
                    );
                }
            }
        }
        return;
    }

    if all {
        let results = service.execute_all_recommended();
        match format {
            OutputFormat::Json => {
                println!("{}", serde_json::to_string_pretty(&results).unwrap());
            }
            OutputFormat::Csv => {
                println!("TaskID,Success,Message");
                for r in &results {
                    println!("\"{}\",{},\"{}\"", r.task_id, r.success, r.message);
                }
            }
            OutputFormat::Text => {
                println!(
                    "{}",
                    "Executed Recommended Maintenance Tasks:".bold().cyan()
                );
                for r in &results {
                    let mark = if r.success {
                        "✓".green().bold()
                    } else {
                        "✗".red().bold()
                    };
                    println!("  {} {}: {}", mark, r.task_id.bold(), r.message);
                }
            }
        }
        return;
    }

    // Default or --list:
    let tasks = service.list_tasks();
    match format {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(&tasks).unwrap());
        }
        OutputFormat::Csv => {
            println!("ID,Title,RiskLevel,Recommended,Description");
            for t in &tasks {
                println!(
                    "\"{}\",\"{}\",\"{}\",{},\"{}\"",
                    t.id, t.title, t.risk_level, t.recommended, t.description
                );
            }
        }
        OutputFormat::Text => {
            println!(
                "{}",
                "FreeMyDisk — Available System Maintenance Tasks"
                    .bold()
                    .cyan()
            );
            println!("{}", "═".repeat(65).dimmed());

            let mut table = Table::new();
            table
                .load_preset(UTF8_FULL)
                .apply_modifier(UTF8_ROUND_CORNERS)
                .set_header(vec![
                    Cell::new("ID").fg(Color::Cyan),
                    Cell::new("Task Title").fg(Color::White),
                    Cell::new("Risk").fg(Color::Yellow),
                    Cell::new("Recommended").fg(Color::Green),
                ]);

            for t in &tasks {
                table.add_row(vec![
                    Cell::new(&t.id),
                    Cell::new(&t.title),
                    Cell::new(&t.risk_level),
                    Cell::new(if t.recommended { "Yes" } else { "No" }),
                ]);
            }

            println!("{table}");
            println!("\nRun a task using: freemydisk maintenance --task <ID>");
            println!("Run all recommended tasks using: freemydisk maintenance --all");
        }
    }
}

fn handle_startup(format: OutputFormat) {
    let service = StartupService::new();
    let items = match service.list_startup_items() {
        Ok(it) => it,
        Err(e) => {
            eprintln!(
                "{}: Failed to read startup items: {}",
                "Error".red().bold(),
                e
            );
            std::process::exit(1);
        }
    };

    match format {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(&items).unwrap());
        }
        OutputFormat::Csv => {
            println!("ID,Name,Command,Location,Enabled,Impact,IsCritical");
            for it in &items {
                println!(
                    "\"{}\",\"{}\",\"{}\",\"{}\",{},\"{:?}\",{}",
                    it.id, it.name, it.command, it.location, it.enabled, it.impact, it.is_critical
                );
            }
        }
        OutputFormat::Text => {
            println!(
                "{}",
                "FreeMyDisk — Startup Software & Boot Impact Analysis"
                    .bold()
                    .cyan()
            );
            println!("{}", "═".repeat(65).dimmed());

            let mut table = Table::new();
            table
                .load_preset(UTF8_FULL)
                .apply_modifier(UTF8_ROUND_CORNERS)
                .set_header(vec![
                    Cell::new("Name").fg(Color::Cyan),
                    Cell::new("Status").fg(Color::White),
                    Cell::new("Boot Impact").fg(Color::Yellow),
                    Cell::new("Protected System").fg(Color::Red),
                    Cell::new("Location").fg(Color::DarkGrey),
                ]);

            for it in &items {
                let status_color = if it.enabled {
                    Color::Green
                } else {
                    Color::DarkGrey
                };
                let status_text = if it.enabled { "Enabled" } else { "Disabled" };

                let impact_color = match it.impact {
                    freemydisk_core::startup::StartupImpact::Low => Color::Green,
                    freemydisk_core::startup::StartupImpact::Medium => Color::Yellow,
                    freemydisk_core::startup::StartupImpact::High => Color::Red,
                };

                table.add_row(vec![
                    Cell::new(&it.name),
                    Cell::new(status_text).fg(status_color),
                    Cell::new(format!("{:?}", it.impact)).fg(impact_color),
                    Cell::new(if it.is_critical { "Protected" } else { "No" }),
                    Cell::new(&it.location),
                ]);
            }

            println!("{table}");
            println!(
                "\nTotal startup entries registered: {}",
                items.len().to_string().bold()
            );
        }
    }
}

fn handle_heavy_folders(
    path: PathBuf,
    min_size_gb: u64,
    depth: usize,
    format: OutputFormat,
    cancel: &CancellationToken,
) {
    let min_bytes = min_size_gb * 1024 * 1024 * 1024;
    let res = match HeavyFoldersScanner::scan_heavy_folders(&path, min_bytes, depth, cancel) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{}: Heavy folders scan failed: {}", "Error".red().bold(), e);
            std::process::exit(1);
        }
    };

    match format {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(&res).unwrap());
        }
        OutputFormat::Csv => {
            println!("Path,Name,Size,FileCount,FolderCount");
            for f in &res.heavy_folders {
                println!(
                    "\"{}\",\"{}\",{},{},{}",
                    f.path.display(),
                    f.name,
                    f.size_bytes,
                    f.file_count,
                    f.folder_count
                );
            }
        }
        OutputFormat::Text => {
            println!(
                "{}",
                "FreeMyDisk — Heavy Folders Inspector (>= 1GB)"
                    .bold()
                    .cyan()
            );
            println!("{}", "═".repeat(65).dimmed());

            if res.heavy_folders.is_empty() {
                println!(
                    "{}",
                    "No heavy folders discovered exceeding threshold.".green()
                );
                return;
            }

            let mut table = Table::new();
            table
                .load_preset(UTF8_FULL)
                .apply_modifier(UTF8_ROUND_CORNERS)
                .set_header(vec![
                    Cell::new("Folder Name").fg(Color::Cyan),
                    Cell::new("Size").fg(Color::Green),
                    Cell::new("Files").fg(Color::Yellow),
                    Cell::new("Path").fg(Color::DarkGrey),
                ]);

            for f in &res.heavy_folders {
                table.add_row(vec![
                    Cell::new(&f.name),
                    Cell::new(format_bytes(f.size_bytes)),
                    Cell::new(f.file_count.to_string()),
                    Cell::new(f.path.to_string_lossy()),
                ]);
            }

            println!("{table}");
            println!(
                "\nDiscovered {} heavy folder(s).",
                res.heavy_folders.len().to_string().cyan().bold()
            );
        }
    }
}

fn handle_apps(leftovers: bool, clean_leftovers: bool, yes: bool, format: OutputFormat) {
    let service = ApplicationService::new();
    if clean_leftovers {
        let items = match service.scan_leftovers() {
            Ok(it) => it,
            Err(e) => {
                eprintln!("{}: Leftover scan failed: {}", "Error".red().bold(), e);
                std::process::exit(1);
            }
        };

        if items.is_empty() {
            if format == OutputFormat::Text {
                println!(
                    "{}",
                    "No orphaned application leftovers found to clean.".green()
                );
            } else if format == OutputFormat::Json {
                println!("[]");
            }
            return;
        }

        // Folders that matched no installed app are reported but never cleaned
        // automatically: they may belong to portable apps or games.
        let skipped = items
            .iter()
            .filter(|l| l.confidence.eq_ignore_ascii_case("low"))
            .count();
        let items: Vec<_> = items
            .into_iter()
            .filter(|l| !l.confidence.eq_ignore_ascii_case("low"))
            .collect();
        if skipped > 0 && format == OutputFormat::Text {
            println!(
                "{} low-confidence item(s) skipped. Review them with `freemydisk apps --leftovers`.",
                skipped.to_string().yellow()
            );
        }
        if items.is_empty() {
            return;
        }

        let total_bytes: u64 = items.iter().map(|l| l.size_bytes).sum();
        let paths: Vec<String> = items.iter().map(|l| l.path.clone()).collect();

        if !yes {
            print!(
                "Found {} residual leftover item(s) ({}). Proceed with cleaning? [y/N]: ",
                items.len().to_string().cyan().bold(),
                format_bytes(total_bytes).yellow().bold()
            );
            let _ = io::stdout().flush();
            let mut input = String::new();
            if io::stdin().read_line(&mut input).is_err() || !input.trim().eq_ignore_ascii_case("y")
            {
                println!("{}", "Leftover cleanup cancelled by user.".yellow());
                return;
            }
        }

        let (journal, lock_dir) = get_cli_recovery_context();
        match service
            .clean_leftovers(&paths, &journal, &lock_dir)
            .map(|summary| summary.freed_bytes)
        {
            Ok(freed) => match format {
                OutputFormat::Json => {
                    #[derive(Serialize)]
                    struct LeftoverCleanResult {
                        items_cleaned: usize,
                        bytes_freed: u64,
                    }
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&LeftoverCleanResult {
                            items_cleaned: paths.len(),
                            bytes_freed: freed,
                        })
                        .unwrap()
                    );
                }
                OutputFormat::Csv => {
                    println!("ItemsCleaned,BytesFreed");
                    println!("{},{}", paths.len(), freed);
                }
                OutputFormat::Text => {
                    println!(
                        "{} Cleaned {} leftover items, reclaiming {}.",
                        "✓".green().bold(),
                        paths.len().to_string().cyan().bold(),
                        format_bytes(freed).green().bold()
                    );
                }
            },
            Err(e) => {
                eprintln!("{}: Leftover cleanup failed: {}", "Error".red().bold(), e);
                std::process::exit(1);
            }
        }
        return;
    }

    if leftovers {
        let items = match service.scan_leftovers() {
            Ok(it) => it,
            Err(e) => {
                eprintln!("{}: Leftover scan failed: {}", "Error".red().bold(), e);
                std::process::exit(1);
            }
        };

        match format {
            OutputFormat::Json => {
                println!("{}", serde_json::to_string_pretty(&items).unwrap());
            }
            OutputFormat::Csv => {
                println!("App,Size,Items,Confidence,Path");
                for l in &items {
                    println!(
                        "\"{}\",{},{},\"{}\",\"{}\"",
                        l.app_name, l.size_bytes, l.item_count, l.confidence, l.path
                    );
                }
            }
            OutputFormat::Text => {
                println!(
                    "{}",
                    "FreeMyDisk — Uninstalled Software Leftovers".bold().cyan()
                );
                println!("{}", "═".repeat(65).dimmed());
                if items.is_empty() {
                    println!("{}", "No orphaned application leftovers found.".green());
                    return;
                }
                let mut table = Table::new();
                table
                    .load_preset(UTF8_FULL)
                    .apply_modifier(UTF8_ROUND_CORNERS)
                    .set_header(vec![
                        Cell::new("App Name").fg(Color::Cyan),
                        Cell::new("Size").fg(Color::Green),
                        Cell::new("Item Count").fg(Color::Yellow),
                        Cell::new("Confidence").fg(Color::White),
                        Cell::new("Residual Path").fg(Color::DarkGrey),
                    ]);
                for l in &items {
                    table.add_row(vec![
                        Cell::new(&l.app_name),
                        Cell::new(format_bytes(l.size_bytes)),
                        Cell::new(l.item_count.to_string()),
                        Cell::new(&l.confidence),
                        Cell::new(&l.path),
                    ]);
                }
                println!("{table}");
                println!("\nRun with --clean-leftovers to remove these residual traces.");
            }
        }
    } else {
        let apps = match service.list_applications() {
            Ok(a) => a,
            Err(e) => {
                eprintln!(
                    "{}: Failed to list applications: {}",
                    "Error".red().bold(),
                    e
                );
                std::process::exit(1);
            }
        };

        match format {
            OutputFormat::Json => {
                println!("{}", serde_json::to_string_pretty(&apps).unwrap());
            }
            OutputFormat::Csv => {
                println!("Name,Version,Publisher,Size,InstallLocation");
                for a in &apps {
                    println!(
                        "\"{}\",\"{}\",\"{}\",{},\"{}\"",
                        a.name,
                        a.display_version.as_deref().unwrap_or(""),
                        a.publisher.as_deref().unwrap_or(""),
                        a.estimated_size_bytes.unwrap_or(0),
                        a.install_location.as_deref().unwrap_or("")
                    );
                }
            }
            OutputFormat::Text => {
                println!("{}", "FreeMyDisk — Installed Applications".bold().cyan());
                println!("{}", "═".repeat(65).dimmed());
                let mut table = Table::new();
                table
                    .load_preset(UTF8_FULL)
                    .apply_modifier(UTF8_ROUND_CORNERS)
                    .set_header(vec![
                        Cell::new("Name").fg(Color::Cyan),
                        Cell::new("Version").fg(Color::White),
                        Cell::new("Publisher").fg(Color::DarkGrey),
                        Cell::new("Estimated Size").fg(Color::Green),
                    ]);
                for a in &apps {
                    let sz = a
                        .estimated_size_bytes
                        .map(format_bytes)
                        .unwrap_or_else(|| "—".to_string());
                    table.add_row(vec![
                        Cell::new(&a.name),
                        Cell::new(a.display_version.as_deref().unwrap_or("—")),
                        Cell::new(a.publisher.as_deref().unwrap_or("—")),
                        Cell::new(sz),
                    ]);
                }
                println!("{table}");
                println!(
                    "\nTotal registered applications: {}",
                    apps.len().to_string().bold()
                );
            }
        }
    }
}

fn handle_privacy(
    clean: bool,
    clean_all: bool,
    category: Option<String>,
    close_browsers: bool,
    whitelist: Vec<String>,
    yes: bool,
    format: OutputFormat,
) {
    if close_browsers {
        let closed = terminate_running_browsers();
        if closed > 0 && format == OutputFormat::Text {
            println!(
                "{} Terminated {} running browser process(es) to release database locks.",
                "✓".green().bold(),
                closed
            );
        }
    }

    let service = PrivacyService::new();
    let scan_result = match service.scan_privacy_items() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{}: Privacy scan failed: {}", "Error".red().bold(), e);
            std::process::exit(1);
        }
    };

    let items_filtered: Vec<_> = if let Some(cat) = &category {
        let cat_clean = cat.to_lowercase().replace('-', "_");
        scan_result
            .items
            .into_iter()
            .filter(|it| {
                let c_str = format!("{:?}", it.category).to_lowercase();
                c_str.contains(&cat_clean) || (cat_clean == "activity" && c_str == "systemactivity")
            })
            .collect()
    } else {
        scan_result.items
    };

    if clean || clean_all {
        let target_items: Vec<_> = items_filtered
            .into_iter()
            .filter(|it| {
                if clean_all || category.is_some() {
                    true
                } else {
                    it.category == PrivacyCategoryKind::Cache
                        || it.category == PrivacyCategoryKind::SystemActivity
                }
            })
            .collect();

        if target_items.is_empty() {
            if format == OutputFormat::Text {
                println!("{}", "No matching privacy items found to clean.".green());
            } else if format == OutputFormat::Json {
                println!("[]");
            }
            return;
        }

        let target_size: u64 = target_items.iter().map(|it| it.size_bytes).sum();
        let target_ids: Vec<String> = target_items.iter().map(|it| it.id.clone()).collect();

        if !yes {
            print!(
                "Found {} privacy item(s) ({}). Proceed with cleanup? [y/N]: ",
                target_ids.len().to_string().cyan().bold(),
                format_bytes(target_size).yellow().bold()
            );
            let _ = io::stdout().flush();
            let mut input = String::new();
            if io::stdin().read_line(&mut input).is_err() || !input.trim().eq_ignore_ascii_case("y")
            {
                println!("{}", "Privacy cleanup cancelled by user.".yellow());
                return;
            }
        }

        match service.clean_privacy_items(&target_ids, &whitelist) {
            Ok(freed) => match format {
                OutputFormat::Json => {
                    #[derive(Serialize)]
                    struct PrivacyCleanResult {
                        items_cleaned: usize,
                        bytes_reclaimed: u64,
                    }
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&PrivacyCleanResult {
                            items_cleaned: target_ids.len(),
                            bytes_reclaimed: freed,
                        })
                        .unwrap()
                    );
                }
                OutputFormat::Csv => {
                    println!("ItemsCleaned,BytesReclaimed");
                    println!("{},{}", target_ids.len(), freed);
                }
                OutputFormat::Text => {
                    println!(
                        "{} Cleaned {} privacy traces, recovering {}.",
                        "✓".green().bold(),
                        target_ids.len().to_string().cyan().bold(),
                        format_bytes(freed).green().bold()
                    );
                }
            },
            Err(e) => {
                eprintln!("{}: Privacy cleanup failed: {}", "Error".red().bold(), e);
                std::process::exit(1);
            }
        }
        return;
    }

    match format {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(&items_filtered).unwrap());
        }
        OutputFormat::Csv => {
            println!("Browser,Category,Title,Size,ItemCount,Locked");
            for it in &items_filtered {
                println!(
                    "\"{}\",\"{:?}\",\"{}\",{},{},{}",
                    it.browser_name,
                    it.category,
                    it.title,
                    it.size_bytes,
                    it.item_count,
                    it.is_locked
                );
            }
        }
        OutputFormat::Text => {
            println!("{}", "FreeMyDisk — Browser & Privacy Cleaner".bold().cyan());
            println!("{}", "═".repeat(65).dimmed());

            if items_filtered.is_empty() {
                println!("{}", "No privacy or browser cache items found.".green());
                return;
            }

            let mut table = Table::new();
            table
                .load_preset(UTF8_FULL)
                .apply_modifier(UTF8_ROUND_CORNERS)
                .set_header(vec![
                    Cell::new("Browser / Source").fg(Color::Cyan),
                    Cell::new("Category").fg(Color::White),
                    Cell::new("Size").fg(Color::Green),
                    Cell::new("Items").fg(Color::Yellow),
                    Cell::new("Process Lock").fg(Color::Red),
                ]);

            let mut grand_bytes = 0u64;
            for it in &items_filtered {
                grand_bytes += it.size_bytes;
                table.add_row(vec![
                    Cell::new(&it.browser_name),
                    Cell::new(format!("{:?}", it.category)),
                    Cell::new(format_bytes(it.size_bytes)),
                    Cell::new(it.item_count.to_string()),
                    Cell::new(if it.is_locked {
                        "In Use (Locked)"
                    } else {
                        "Free"
                    }),
                ]);
            }
            println!("{table}");
            println!(
                "\nTotal recoverable privacy/cache data: {}",
                format_bytes(grand_bytes).green().bold()
            );
            println!("Run with --clean or --clean-all to safely reclaim this space.");
        }
    }
}

fn handle_vitals(format: OutputFormat) {
    let platform = get_platform();
    let vitals = platform.get_system_vitals();
    let volumes = platform.list_volumes().unwrap_or_default();

    #[derive(Serialize)]
    struct VitalsReport {
        vitals: Option<freemydisk_platform::traits::SystemVitals>,
        volumes: Vec<freemydisk_platform::traits::StorageVolumeInfo>,
    }

    let report = VitalsReport {
        vitals: vitals.ok(),
        volumes,
    };

    match format {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(&report).unwrap());
        }
        OutputFormat::Csv => {
            println!("MountPoint,VolumeName,TotalBytes,AvailableBytes,FileSystem");
            for v in &report.volumes {
                println!(
                    "\"{}\",\"{}\",{},{},\"{}\"",
                    v.mount_point, v.volume_name, v.total_bytes, v.available_bytes, v.file_system
                );
            }
        }
        OutputFormat::Text => {
            println!(
                "{}",
                "FreeMyDisk — System Vitals & Storage Volumes".bold().cyan()
            );
            println!("{}", "═".repeat(65).dimmed());

            if let Some(v) = &report.vitals {
                println!("  {} {}", "Operating System:".bold(), v.os_name);
                println!("  {} {}", "Computer Name:   ".bold(), v.computer_name);
                println!("  {} {}", "CPU Core Count:  ".bold(), v.cpu_cores);
                println!(
                    "  {} {} / {} ({}% load)",
                    "Physical Memory: ".bold(),
                    format_bytes(v.used_ram_bytes),
                    format_bytes(v.total_ram_bytes),
                    v.memory_load_percent
                );
            }

            println!("\n{}", "Mounted Storage Volumes:".bold().white());
            let mut table = Table::new();
            table
                .load_preset(UTF8_FULL)
                .apply_modifier(UTF8_ROUND_CORNERS)
                .set_header(vec![
                    Cell::new("Mount").fg(Color::Cyan),
                    Cell::new("Volume Name").fg(Color::White),
                    Cell::new("Total").fg(Color::Yellow),
                    Cell::new("Available").fg(Color::Green),
                    Cell::new("File System").fg(Color::DarkGrey),
                ]);

            for vol in &report.volumes {
                table.add_row(vec![
                    Cell::new(&vol.mount_point),
                    Cell::new(&vol.volume_name),
                    Cell::new(format_bytes(vol.total_bytes)),
                    Cell::new(format_bytes(vol.available_bytes)),
                    Cell::new(&vol.file_system),
                ]);
            }
            println!("{table}");
        }
    }
}

fn handle_rescue(yes: bool, format: OutputFormat) {
    if !yes {
        println!("{}", "WARNING: Emergency Disk Rescue Protocol".bold().red());
        println!("This will immediately perform all safe emergency disk recovery procedures:");
        println!("  - Disable and remove Windows Hibernation file (hiberfil.sys, saves 8GB-32GB)");
        println!("  - Clean Windows Recycle Bin across all local volumes");
        println!("  - Purge system and user temp directories");
        println!("  - Clear crash dumps (MEMORY.DMP & Minidumps)");
        println!("  - Reclaim DirectX shader and Delivery Optimization caches");
        println!("  - Free WSL virtual machine disk sparse allocations");
        println!();
        print!("Proceed with 1-Click Emergency Rescue? [y/N]: ");
        let _ = io::stdout().flush();

        let mut input = String::new();
        if io::stdin().read_line(&mut input).is_err() || !input.trim().eq_ignore_ascii_case("y") {
            println!("{}", "Operation cancelled by user.".yellow());
            return;
        }
    }

    let service = MaintenanceService::new();
    let res = match service.execute_emergency_rescue() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{}: Emergency rescue failed: {}", "Error".red().bold(), e);
            std::process::exit(1);
        }
    };

    match format {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(&res).unwrap());
        }
        OutputFormat::Csv => {
            println!("Action");
            for action in &res.actions_performed {
                println!("\"{}\"", action);
            }
        }
        OutputFormat::Text => {
            println!("{}", "Emergency Disk Rescue Complete!".bold().green());
            println!("{}", "═".repeat(65).dimmed());
            for action in &res.actions_performed {
                println!("  {} {}", "✓".green().bold(), action);
            }
            println!(
                "\nTotal storage space successfully reclaimed: {}",
                format_bytes(res.total_bytes_reclaimed).green().bold()
            );
        }
    }
}

fn handle_virtualization(_list: bool, compact: Option<String>, format: OutputFormat) {
    if let Some(distro) = compact {
        println!(
            "{}",
            format!("Compacting WSL distribution '{}'...", distro)
                .cyan()
                .bold()
        );
        match freemydisk_core::virtualization::WslManager::compact_distribution(&distro) {
            Ok(res) => match format {
                OutputFormat::Json => {
                    println!("{}", serde_json::to_string_pretty(&res).unwrap());
                }
                OutputFormat::Csv => {
                    println!("Target,BeforeBytes,AfterBytes,FreedBytes,Success,Message");
                    println!(
                        "\"{}\",{},{},{},{},\"{}\"",
                        res.target_name,
                        res.before_bytes,
                        res.after_bytes,
                        res.freed_bytes,
                        res.success,
                        res.message
                    );
                }
                OutputFormat::Text => {
                    if res.success {
                        println!("{}", "✓ Compaction completed successfully!".green().bold());
                        println!("  Distribution: {}", res.target_name.cyan());
                        println!("  Before Size : {}", format_bytes(res.before_bytes));
                        println!("  After Size  : {}", format_bytes(res.after_bytes));
                        println!(
                            "  Freed Space : {}",
                            format_bytes(res.freed_bytes).green().bold()
                        );
                        println!("  Details     : {}", res.message);
                    } else {
                        eprintln!("{}: {}", "Compaction Failed".red().bold(), res.message);
                        std::process::exit(1);
                    }
                }
            },
            Err(e) => {
                eprintln!("{}: {}", "Error".red().bold(), e);
                std::process::exit(1);
            }
        }
        return;
    }

    // Default or --list: display virtualization overview
    let overview = freemydisk_core::virtualization::get_virtualization_overview();
    match format {
        OutputFormat::Json => {
            println!("{}", serde_json::to_string_pretty(&overview).unwrap());
        }
        OutputFormat::Csv => {
            println!("Distribution,ActualBytes,ReclaimableBytes,State,Version,VHDX_Path");
            for d in &overview.wsl_distributions {
                println!(
                    "\"{}\",{},{},\"{}\",{},\"{}\"",
                    d.name,
                    d.vhdx_actual_bytes,
                    d.reclaimable_estimate,
                    d.state,
                    d.version,
                    d.vhdx_path.display()
                );
            }
        }
        OutputFormat::Text => {
            println!("{}", "Virtualization Storage Overview".bold().cyan());
            println!("{}", "═".repeat(80).dimmed());

            if !overview.wsl_installed || overview.wsl_distributions.is_empty() {
                println!("No WSL distributions detected on this system.");
            } else {
                let mut table = Table::new();
                table.load_preset(UTF8_ROUND_CORNERS);
                table.set_header(vec![
                    Cell::new("WSL Distribution").fg(Color::Cyan),
                    Cell::new("VHDX Size").fg(Color::Yellow),
                    Cell::new("Est. Reclaimable").fg(Color::Green),
                    Cell::new("State"),
                    Cell::new("Version"),
                    Cell::new("Path").fg(Color::DarkGrey),
                ]);

                for d in &overview.wsl_distributions {
                    table.add_row(vec![
                        Cell::new(&d.name).fg(Color::White),
                        Cell::new(format_bytes(d.vhdx_actual_bytes)),
                        Cell::new(format_bytes(d.reclaimable_estimate)).fg(Color::Green),
                        Cell::new(&d.state),
                        Cell::new(d.version.to_string()),
                        Cell::new(d.vhdx_path.to_string_lossy().to_string()).fg(Color::DarkGrey),
                    ]);
                }
                println!("{table}");
                println!(
                    "Total WSL Physical Storage: {} | Estimated Reclaimable: {}",
                    format_bytes(overview.total_wsl_bytes).bold(),
                    format_bytes(overview.total_wsl_reclaimable).bold().green()
                );
            }

            let d = &overview.docker;
            if d.is_installed {
                println!("\n{}", "Docker Container Footprint".bold().cyan());
                println!("{}", "═".repeat(80).dimmed());
                println!(
                    "Docker Status: {} | Total Reclaimable: {}",
                    if d.is_running {
                        "Running".green()
                    } else {
                        "Stopped".yellow()
                    },
                    format_bytes(d.total_reclaimable_bytes).bold().green()
                );
            }
        }
    }
}
