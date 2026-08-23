pub mod cleanup {
    pub mod cleaners;
    pub mod disposal;
    pub mod matchers;
    pub mod plan;
    pub mod project_artifacts;
    pub mod protected_paths;
    pub mod rule_engine;
    pub mod rule_schema;
    pub mod shredder;
}

pub mod filesystem {
    pub mod crash_report;
    pub mod journal;
}

pub mod shared {
    pub mod errors;
    pub mod ipc_errors;
    pub mod paths;
    pub mod progress;
    pub mod throttler;
}

pub mod storage {
    pub mod analyzer;
    pub mod duplicates;
    pub mod folder_agg;
    pub mod hash_cache;
    pub mod heavy_folders;
    pub mod large_files;
    pub mod spill_store;
    pub mod traversal;
}

pub mod applications;
pub mod optimization;
pub mod privacy;
pub mod startup;
pub mod system_maintenance;
pub mod virtualization;

pub fn init_performance_profile() {
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2)
        .clamp(1, 4);

    let _ = rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .thread_name(|i| format!("fmd-worker-{}", i))
        .build_global();
}
