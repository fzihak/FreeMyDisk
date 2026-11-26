use std::path::{Path, PathBuf};

/// Splits a path or pattern into lowercase segments; `\` and `/` are equivalent.
fn segments(s: &str) -> Vec<String> {
    s.replace('\\', "/")
        .to_ascii_lowercase()
        .split('/')
        .filter(|seg| !seg.is_empty())
        .map(str::to_string)
        .collect()
}

/// Matches one path segment against a pattern segment where `*` matches any
/// run of characters inside that segment.
fn segment_match(pattern: &str, text: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == text;
    }

    let first = parts[0];
    let last = parts[parts.len() - 1];
    // Both checks pass only on UTF-8 boundaries, which keeps the slicing below
    // safe for non-ASCII names.
    if text.len() < first.len() + last.len() || !text.starts_with(first) || !text.ends_with(last) {
        return false;
    }

    let mut pos = first.len();
    let end = text.len() - last.len();
    for part in &parts[1..parts.len() - 1] {
        if part.is_empty() {
            continue;
        }
        match text[pos..end].find(part) {
            Some(idx) => pos += idx + part.len(),
            None => return false,
        }
    }
    true
}

fn match_segments(pattern: &[String], text: &[String]) -> bool {
    match pattern.split_first() {
        None => text.is_empty(),
        Some((head, rest)) if head == "**" => {
            (0..=text.len()).any(|skip| match_segments(rest, &text[skip..]))
        }
        Some((head, rest)) => {
            !text.is_empty() && segment_match(head, &text[0]) && match_segments(rest, &text[1..])
        }
    }
}

/// Case-insensitive path glob. `*` matches within a single path segment and
/// `**` matches any number of segments, so a rule cannot reach deeper folders
/// than its pattern names.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    match_segments(&segments(pattern), &segments(text))
}

/// True when some path strictly below `text` could still match `pattern`, so a
/// walker must descend into `text` to find every match.
fn could_match_below(pattern: &[String], text: &[String]) -> bool {
    match pattern.split_first() {
        None => false,
        Some((head, _)) if head == "**" => true,
        Some(_) if text.is_empty() => true,
        Some((head, rest)) => segment_match(head, &text[0]) && could_match_below(rest, &text[1..]),
    }
}

/// A glob split into segments once, for matching many paths against it.
#[derive(Debug, Clone)]
pub struct CompiledGlob {
    segs: Vec<String>,
}

impl CompiledGlob {
    pub fn new(pattern: &str) -> Self {
        Self {
            segs: segments(pattern),
        }
    }

    /// Same result as [`glob_match`] with this pattern.
    pub fn matches(&self, path: &Path) -> bool {
        match_segments(&self.segs, &segments(&path.to_string_lossy()))
    }

    /// False when nothing below `dir` can match, so a walker can skip the folder.
    pub fn could_match_below(&self, dir: &Path) -> bool {
        could_match_below(&self.segs, &segments(&dir.to_string_lossy()))
    }
}

/// A rule's `protect_subpaths` list, compiled once for walking a matched folder.
#[derive(Debug, Clone)]
pub struct CompiledProtect {
    patterns: Vec<Vec<String>>,
}

impl CompiledProtect {
    pub fn new(protect_patterns: &[String]) -> Self {
        Self {
            patterns: protect_patterns
                .iter()
                .map(|p| protect_pattern(p))
                .collect(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.patterns.is_empty()
    }

    /// True when the full path matches a pattern. Unlike [`is_subpath_protected`]
    /// the parent folders are not checked: a walker that skips protected folders
    /// has already checked them.
    pub fn matches_leaf(&self, path: &Path) -> bool {
        if self.patterns.is_empty() {
            return false;
        }
        let text = segments(&path.to_string_lossy());
        self.patterns.iter().any(|pat| match_segments(pat, &text))
    }
}

/// Normalises a `protect_subpaths` pattern into an unanchored glob.
/// `*/name` means "a segment called name anywhere"; a pattern without a
/// separator (such as `*.msi`) is matched against single segments.
fn protect_pattern(pattern: &str) -> Vec<String> {
    let mut segs = segments(pattern);
    if segs.first().map(String::as_str) == Some("*") {
        segs.remove(0);
    }
    if segs.first().map(String::as_str) != Some("**") {
        segs.insert(0, "**".to_string());
    }
    if segs.last().map(String::as_str) == Some("*") {
        segs.pop();
    }
    segs
}

/// True when the path, or any folder above it, matches one of the rule's
/// `protect_subpaths` patterns.
pub fn is_subpath_protected(path: &Path, protect_patterns: &[String]) -> bool {
    if protect_patterns.is_empty() {
        return false;
    }
    let text = segments(&path.to_string_lossy());
    protect_patterns.iter().any(|pattern| {
        let pat = protect_pattern(pattern);
        (1..=text.len()).any(|len| match_segments(&pat, &text[..len]))
    })
}

/// True when `dir` contains at least one entry protected by `protect_patterns`.
pub fn contains_protected_subpath(dir: &Path, protect_patterns: &[String]) -> bool {
    if protect_patterns.is_empty() || !dir.is_dir() {
        return false;
    }
    walkdir::WalkDir::new(dir)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .any(|entry| is_subpath_protected(entry.path(), protect_patterns))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn star_stays_inside_one_segment() {
        let pattern = "C:/Users/u/AppData/Local/Google/Chrome/User Data/*/Cache/*";
        assert!(glob_match(
            pattern,
            r"C:\Users\u\AppData\Local\Google\Chrome\User Data\Default\Cache\f_01"
        ));
        assert!(!glob_match(
            pattern,
            r"C:\Users\u\AppData\Local\Google\Chrome\User Data\Default\Extensions\abc\1.0\Cache\x"
        ));
        assert!(glob_match("C:/a/*.part", r"C:\a\file.part"));
        assert!(!glob_match("C:/a/*.part", r"C:\a\sub\file.part"));
    }

    #[test]
    fn non_ascii_names_do_not_panic() {
        assert!(glob_match("C:/t/*", "C:/t/বাংলা ফাইল.txt"));
        assert!(!glob_match("C:/t/*.part", "C:/t/বাংলা"));
        assert!(glob_match("C:/t/*.txt", "C:/t/日本語.txt"));
    }

    #[test]
    fn double_star_spans_segments() {
        assert!(glob_match("C:/a/**/x.log", r"C:\a\b\c\x.log"));
        assert!(glob_match("C:/a/**/x.log", r"C:\a\x.log"));
    }

    #[test]
    fn walker_pruning_only_skips_dead_branches() {
        let g = CompiledGlob::new("C:/u/Local/*/GPUCache/*");
        assert!(g.could_match_below(Path::new(r"C:\u\Local\App")));
        assert!(g.could_match_below(Path::new(r"C:\u\Local\App\GPUCache")));
        assert!(!g.could_match_below(Path::new(r"C:\u\Local\App\Other")));
        assert!(!g.could_match_below(Path::new(r"C:\u\Local\App\GPUCache\f")));
        assert!(g.matches(Path::new(r"C:\u\Local\App\GPUCache\f")));

        let deep = CompiledGlob::new("C:/a/**/x.log");
        assert!(deep.could_match_below(Path::new(r"C:\a\b\c\d")));
        assert!(!deep.could_match_below(Path::new(r"C:\z")));
    }

    #[test]
    fn compiled_protect_matches_like_subpath_check_for_leaves() {
        let patterns = vec!["*/Sessions/*".to_string(), "*/cookies*".to_string()];
        let compiled = CompiledProtect::new(&patterns);
        for p in [
            r"C:\p\Default\Sessions",
            r"C:\p\Default\Cookies-journal",
            r"C:\p\Default\Cache\f",
        ] {
            assert_eq!(
                compiled.matches_leaf(Path::new(p)),
                is_subpath_protected(Path::new(p), &patterns),
                "{p}"
            );
        }
    }

    #[test]
    fn protect_patterns_cover_descendants() {
        let patterns = vec!["*/Sessions/*".to_string(), "*.msi".to_string()];
        assert!(is_subpath_protected(
            Path::new(r"C:\p\Default\Sessions"),
            &patterns
        ));
        assert!(is_subpath_protected(
            Path::new(r"C:\p\Default\Sessions\Tabs_1"),
            &patterns
        ));
        assert!(is_subpath_protected(
            Path::new(r"C:\Windows\Installer\a.msi"),
            &patterns
        ));
        assert!(!is_subpath_protected(
            Path::new(r"C:\p\Default\Cache\f"),
            &patterns
        ));
    }
}
