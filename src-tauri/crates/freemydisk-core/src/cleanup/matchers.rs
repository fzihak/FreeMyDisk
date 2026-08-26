use std::path::{Path, PathBuf};

/// Simple, robust glob pattern matching supporting '*' wildcards.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let p_norm = pattern.replace('\\', "/").to_ascii_lowercase();
    let t_norm = text.replace('\\', "/").to_ascii_lowercase();

    let parts: Vec<&str> = p_norm.split('*').collect();
    if parts.is_empty() {
        return true;
    }

    if parts.len() == 1 {
        return t_norm == parts[0];
    }

    let mut pos = 0;

    // Check prefix
    if !parts[0].is_empty() {
        if !t_norm.starts_with(parts[0]) {
            return false;
        }
        pos = parts[0].len();
    }

    // Check inner parts
    for &part in &parts[1..parts.len() - 1] {
        if part.is_empty() {
            continue;
        }
        match t_norm[pos..].find(part) {
            Some(idx) => pos += idx + part.len(),
            None => return false,
        }
    }

    // Check suffix
    let last = parts[parts.len() - 1];
    if !last.is_empty() {
        t_norm[pos..].ends_with(last)
    } else {
        true
    }
}

/// Evaluates whether a candidate path matches any of the rule's protect_subpaths patterns.
pub fn is_subpath_protected(path: &Path, protect_patterns: &[String]) -> bool {
    let path_str = path.to_string_lossy();
    for pattern in protect_patterns {
        if glob_match(pattern, &path_str) {
            return true;
        }
    }
    false
}

/// Hard filter: strictly excises any candidate path matching protect_subpaths before disposal.
pub fn filter_protected_subpaths(
    candidates: Vec<PathBuf>,
    protect_patterns: &[String],
) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut allowed = Vec::new();
    let mut protected = Vec::new();

    for path in candidates {
        if is_subpath_protected(&path, protect_patterns) {
            protected.push(path);
        } else {
            allowed.push(path);
        }
    }

    (allowed, protected)
}
