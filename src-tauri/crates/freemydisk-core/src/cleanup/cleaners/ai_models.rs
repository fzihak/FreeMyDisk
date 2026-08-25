use crate::shared::errors::CoreError;
use freemydisk_platform::traits::PlatformFilesystem;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiModelInfo {
    pub id: String,
    pub name: String,
    pub provider: String, // "ollama", "lmstudio", "huggingface", "gpt4all", "jan", "claudecode", "gemini"
    pub path: String,
    pub size_bytes: u64,
    pub modified_at: Option<u64>,
    pub description: Option<String>,
    pub is_directory: bool,
}

pub struct AiModelAnalyzer;

impl AiModelAnalyzer {
    /// Scans well-known AI model repositories, GGUF downloads, and AI session caches.
    pub fn scan() -> Vec<AiModelInfo> {
        let mut results = Vec::new();

        // 1. Ollama models
        Self::scan_ollama(&mut results);

        // 2. LM Studio models
        Self::scan_lm_studio(&mut results);

        // 3. HuggingFace Hub cached models
        Self::scan_huggingface(&mut results);

        // 4. GPT4All models
        Self::scan_gpt4all(&mut results);

        // 5. Jan AI models
        Self::scan_jan(&mut results);

        // 6. Claude Code session artifacts
        Self::scan_claude_code(&mut results);

        // 7. Gemini & coding assistant caches
        Self::scan_gemini_artifacts(&mut results);

        // Sort descending by size (largest reclaimable caches first)
        results.sort_by_key(|a| std::cmp::Reverse(a.size_bytes));
        results
    }

    fn scan_ollama(results: &mut Vec<AiModelInfo>) {
        let home = match std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
            Ok(h) => PathBuf::from(h),
            Err(_) => return,
        };

        let ollama_dir = std::env::var("OLLAMA_MODELS")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join(".ollama").join("models"));

        if !ollama_dir.exists() {
            return;
        }

        let manifests_dir = ollama_dir.join("manifests");
        let blobs_dir = ollama_dir.join("blobs");

        if manifests_dir.exists() {
            // Walk manifest files: manifests/registry.ollama.ai/library/<model>/<tag>
            for entry in WalkDir::new(&manifests_dir).into_iter().flatten() {
                if entry.file_type().is_file() {
                    let path = entry.path();
                    let relative = path.strip_prefix(&manifests_dir).unwrap_or(path);
                    let comps: Vec<String> = relative
                        .iter()
                        .filter_map(|c| c.to_str().map(|s| s.to_string()))
                        .collect();

                    // Model name usually library/<model>/<tag> or <org>/<model>/<tag>
                    let model_name = if comps.len() >= 2 {
                        let tag = comps.last().cloned().unwrap_or_default();
                        let name = comps[comps.len() - 2].clone();
                        format!("{}:{}", name, tag)
                    } else {
                        comps.join(":")
                    };

                    let size_bytes = Self::calculate_ollama_manifest_size(path, &blobs_dir);
                    let modified_at = entry
                        .metadata()
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs());

                    results.push(AiModelInfo {
                        id: format!("ollama:{}", model_name),
                        name: model_name,
                        provider: "ollama".to_string(),
                        path: path.to_string_lossy().to_string(),
                        size_bytes,
                        modified_at,
                        description: Some("Ollama local model manifest and layers".to_string()),
                        is_directory: false,
                    });
                }
            }
        } else if blobs_dir.exists() {
            // If only blobs exist or manifests wasn't found, report the blobs directory
            let total_blobs_size = Self::calculate_dir_size(&blobs_dir);
            if total_blobs_size > 0 {
                results.push(AiModelInfo {
                    id: "ollama:all_blobs".to_string(),
                    name: "Ollama Model Blobs Store".to_string(),
                    provider: "ollama".to_string(),
                    path: blobs_dir.to_string_lossy().to_string(),
                    size_bytes: total_blobs_size,
                    modified_at: None,
                    description: Some(
                        "Cached layer blobs for all downloaded Ollama models".to_string(),
                    ),
                    is_directory: true,
                });
            }
        }
    }

    fn calculate_ollama_manifest_size(manifest_path: &Path, _blobs_dir: &Path) -> u64 {
        if let Ok(content) = fs::read_to_string(manifest_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                let mut size = 0u64;
                if let Some(layers) = json.get("layers").and_then(|l| l.as_array()) {
                    for layer in layers {
                        if let Some(s) = layer.get("size").and_then(|v| v.as_u64()) {
                            size += s;
                        }
                    }
                }
                if let Some(config_size) = json
                    .get("config")
                    .and_then(|c| c.get("size"))
                    .and_then(|v| v.as_u64())
                {
                    size += config_size;
                }
                if size > 0 {
                    return size;
                }
            }
        }
        // Fallback: file size
        manifest_path.metadata().map(|m| m.len()).unwrap_or(0)
    }

    fn scan_lm_studio(results: &mut Vec<AiModelInfo>) {
        let home = match std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
            Ok(h) => PathBuf::from(h),
            Err(_) => return,
        };

        let possible_dirs = [
            home.join(".cache").join("lm-studio").join("models"),
            home.join(".lmstudio").join("models"),
        ];

        for base in &possible_dirs {
            if !base.exists() {
                continue;
            }

            for entry in WalkDir::new(base).into_iter().flatten() {
                let path = entry.path();
                if entry.file_type().is_file() {
                    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                    if ext.eq_ignore_ascii_case("gguf") || ext.eq_ignore_ascii_case("bin") {
                        let filename = path
                            .file_name()
                            .and_then(|f| f.to_str())
                            .unwrap_or("model.gguf");
                        let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
                        let modified_at = entry
                            .metadata()
                            .ok()
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs());

                        results.push(AiModelInfo {
                            id: format!("lmstudio:{}", path.to_string_lossy()),
                            name: filename.to_string(),
                            provider: "lmstudio".to_string(),
                            path: path.to_string_lossy().to_string(),
                            size_bytes,
                            modified_at,
                            description: Some("LM Studio GGUF Quantized Model".to_string()),
                            is_directory: false,
                        });
                    }
                }
            }
        }
    }

    fn scan_huggingface(results: &mut Vec<AiModelInfo>) {
        let hf_hub = if let Ok(val) = std::env::var("HF_HOME") {
            PathBuf::from(val).join("hub")
        } else if let Ok(val) = std::env::var("HUGGINGFACE_HUB_CACHE") {
            PathBuf::from(val)
        } else {
            let home = match std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
                Ok(h) => PathBuf::from(h),
                Err(_) => return,
            };
            home.join(".cache").join("huggingface").join("hub")
        };

        if !hf_hub.exists() {
            return;
        }

        let entries = match fs::read_dir(&hf_hub) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let dirname = match path.file_name().and_then(|n| n.to_str()) {
                    Some(n) => n,
                    None => continue,
                };

                if dirname.starts_with("models--") {
                    // Convert models--meta-llama--Meta-Llama-3-8B -> meta-llama/Meta-Llama-3-8B
                    let raw = dirname.trim_start_matches("models--");
                    let model_name = raw.replacen("--", "/", 1);

                    let size_bytes = Self::calculate_dir_size(&path);
                    let modified_at = entry
                        .metadata()
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs());

                    results.push(AiModelInfo {
                        id: format!("hf:{}", model_name),
                        name: model_name,
                        provider: "huggingface".to_string(),
                        path: path.to_string_lossy().to_string(),
                        size_bytes,
                        modified_at,
                        description: Some("HuggingFace Hub snapshot & cached weights".to_string()),
                        is_directory: true,
                    });
                }
            }
        }
    }

    fn scan_gpt4all(results: &mut Vec<AiModelInfo>) {
        let appdata = match std::env::var("LOCALAPPDATA") {
            Ok(a) => PathBuf::from(a),
            Err(_) => return,
        };

        let gpt4all_dir = appdata.join("nomic.ai").join("GPT4All");
        if !gpt4all_dir.exists() {
            return;
        }

        for entry in WalkDir::new(&gpt4all_dir).into_iter().flatten() {
            let path = entry.path();
            if entry.file_type().is_file() {
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
                if ext.eq_ignore_ascii_case("gguf") || ext.eq_ignore_ascii_case("bin") {
                    let filename = path
                        .file_name()
                        .and_then(|f| f.to_str())
                        .unwrap_or("model.gguf");
                    let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    let modified_at = entry
                        .metadata()
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs());

                    results.push(AiModelInfo {
                        id: format!("gpt4all:{}", path.to_string_lossy()),
                        name: filename.to_string(),
                        provider: "gpt4all".to_string(),
                        path: path.to_string_lossy().to_string(),
                        size_bytes,
                        modified_at,
                        description: Some("GPT4All downloaded local model".to_string()),
                        is_directory: false,
                    });
                }
            }
        }
    }

    fn scan_jan(results: &mut Vec<AiModelInfo>) {
        let home = match std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
            Ok(h) => PathBuf::from(h),
            Err(_) => return,
        };

        let candidates = [
            home.join("jan").join("models"),
            home.join("AppData")
                .join("Local")
                .join("Jan")
                .join("models"),
            home.join("AppData")
                .join("Roaming")
                .join("Jan")
                .join("models"),
        ];

        for models_dir in &candidates {
            if !models_dir.exists() {
                continue;
            }

            if let Ok(entries) = fs::read_dir(models_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        let name = path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("jan_model");
                        let size_bytes = Self::calculate_dir_size(&path);
                        let modified_at = entry
                            .metadata()
                            .ok()
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs());

                        results.push(AiModelInfo {
                            id: format!("jan:{}", name),
                            name: name.to_string(),
                            provider: "jan".to_string(),
                            path: path.to_string_lossy().to_string(),
                            size_bytes,
                            modified_at,
                            description: Some("Jan AI Model Weights & Metadata".to_string()),
                            is_directory: true,
                        });
                    }
                }
            }
        }
    }

    fn scan_claude_code(results: &mut Vec<AiModelInfo>) {
        let home = match std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
            Ok(h) => PathBuf::from(h),
            Err(_) => return,
        };

        let claude_dir = home.join(".claude");
        if !claude_dir.exists() {
            return;
        }

        // Check project sessions
        let projects_dir = claude_dir.join("projects");
        if projects_dir.exists() {
            let size = Self::calculate_dir_size(&projects_dir);
            if size > 1_000_000 {
                // Only flag if > 1MB
                results.push(AiModelInfo {
                    id: "claudecode:projects".to_string(),
                    name: "Claude Code Project Session Histories".to_string(),
                    provider: "claudecode".to_string(),
                    path: projects_dir.to_string_lossy().to_string(),
                    size_bytes: size,
                    modified_at: None,
                    description: Some(
                        "Cached subagent transcripts and project execution state".to_string(),
                    ),
                    is_directory: true,
                });
            }
        }

        // Check telemetry/cache
        let cache_dir = claude_dir.join("cache");
        if cache_dir.exists() {
            let size = Self::calculate_dir_size(&cache_dir);
            if size > 500_000 {
                results.push(AiModelInfo {
                    id: "claudecode:cache".to_string(),
                    name: "Claude Code Prompt & API Cache".to_string(),
                    provider: "claudecode".to_string(),
                    path: cache_dir.to_string_lossy().to_string(),
                    size_bytes: size,
                    modified_at: None,
                    description: Some("API cache and intermediate completion buffers".to_string()),
                    is_directory: true,
                });
            }
        }
    }

    fn scan_gemini_artifacts(results: &mut Vec<AiModelInfo>) {
        let home = match std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
            Ok(h) => PathBuf::from(h),
            Err(_) => return,
        };

        let gemini_recordings = home.join(".gemini").join("browser_recordings");
        if gemini_recordings.exists() {
            let size = Self::calculate_dir_size(&gemini_recordings);
            if size > 1_000_000 {
                results.push(AiModelInfo {
                    id: "gemini:recordings".to_string(),
                    name: "Gemini / Coding Assistant Browser Recordings".to_string(),
                    provider: "gemini".to_string(),
                    path: gemini_recordings.to_string_lossy().to_string(),
                    size_bytes: size,
                    modified_at: None,
                    description: Some(
                        "WebP screen recordings from browser automation runs".to_string(),
                    ),
                    is_directory: true,
                });
            }
        }
    }

    /// Safely cleans an AI model or session cache by sending it to Recycle Bin.
    /// Invariant: Trash-First default. Never permanently deletes without explicit override.
    pub fn clean_model(
        path_str: &str,
        platform: &dyn PlatformFilesystem,
    ) -> Result<u64, CoreError> {
        let path = Path::new(path_str);
        if !path.exists() {
            return Ok(0);
        }

        // Security check: Ensure target path belongs to a recognized AI model/cache directory
        if !Self::is_safe_ai_path(path) {
            return Err(CoreError::Validation(format!(
                "Path is not a recognized AI model or cache path: {}",
                path_str
            )));
        }

        let size_freed = if path.is_file() {
            path.metadata().map(|m| m.len()).unwrap_or(0)
        } else {
            Self::calculate_dir_size(path)
        };

        platform.trash_path(path).map_err(CoreError::Platform)?;

        Ok(size_freed)
    }

    /// Verifies whether the path is located inside safe AI storage directories.
    pub fn is_safe_ai_path(path: &Path) -> bool {
        let path_str = path.to_string_lossy().to_lowercase();

        let safe_fragments = [
            ".ollama\\models",
            ".ollama/models",
            ".cache\\lm-studio\\models",
            ".cache/lm-studio/models",
            ".lmstudio\\models",
            ".lmstudio/models",
            ".cache\\huggingface\\hub",
            ".cache/huggingface/hub",
            "nomic.ai\\gpt4all",
            "nomic.ai/gpt4all",
            "jan\\models",
            "jan/models",
            ".claude\\projects",
            ".claude/projects",
            ".claude\\cache",
            ".claude/cache",
            ".gemini\\browser_recordings",
            ".gemini/browser_recordings",
        ];

        safe_fragments.iter().any(|frag| path_str.contains(frag))
    }

    pub fn calculate_dir_size(dir: &Path) -> u64 {
        WalkDir::new(dir)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .filter_map(|e| e.metadata().ok())
            .map(|m| m.len())
            .sum()
    }
}
