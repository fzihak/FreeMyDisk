use std::path::{Path, PathBuf};

pub fn expand_path_variables(template: &str) -> PathBuf {
    let mut resolved = template.to_string();

    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());

    let local_app_data =
        std::env::var("LOCALAPPDATA").unwrap_or_else(|_| format!("{}/AppData/Local", home));

    let app_data = std::env::var("APPDATA").unwrap_or_else(|_| format!("{}/AppData/Roaming", home));

    let temp_dir = std::env::temp_dir().to_string_lossy().to_string();
    let program_data =
        std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".to_string());
    let win_dir = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());

    resolved = resolved.replace("${home}", &home);
    resolved = resolved.replace("${user_profile}", &home);
    resolved = resolved.replace("${userprofile}", &home);
    resolved = resolved.replace("${local_app_data}", &local_app_data);
    resolved = resolved.replace("${localappdata}", &local_app_data);
    resolved = resolved.replace("${app_data}", &app_data);
    resolved = resolved.replace("${appdata}", &app_data);
    resolved = resolved.replace("${temp}", &temp_dir);
    resolved = resolved.replace("${program_data}", &program_data);
    resolved = resolved.replace("${programdata}", &program_data);
    resolved = resolved.replace("${win_dir}", &win_dir);
    resolved = resolved.replace("${windir}", &win_dir);
    resolved = resolved.replace("${systemroot}", &win_dir);

    PathBuf::from(to_platform_separators(&resolved))
}

/// Rewrites `/` to the platform separator so a rule template such as
/// `${win_dir}/SoftwareDistribution/Download` never yields a mixed path like
/// `C:\WINDOWS/SoftwareDistribution/Download\f1ba`. Backslashes are left alone, so
/// UNC (`\\server\share`) and verbatim (`\\?\C:\...`) prefixes keep their form.
/// On other platforms the string is returned unchanged.
pub fn to_platform_separators(path: &str) -> String {
    if cfg!(windows) {
        path.replace('/', r"\")
    } else {
        path.to_string()
    }
}

/// Bundle identifier of the desktop app; its data folder is named after it.
pub const APP_IDENTIFIER: &str = "app.freemydisk.desktop";

/// Data folder shared by the desktop app and the CLI. Matches Tauri's
/// `app_data_dir()` for [`APP_IDENTIFIER`], so both use the same journal and lock.
pub fn app_data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join("Library").join("Application Support"));
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share"))
        });
    base.map(|b| b.join(APP_IDENTIFIER))
}

pub fn normalize_path(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| dunce::simplified(path).to_path_buf())
}

/// Prepends \\?\ extended-length prefix if path length exceeds Windows MAX_PATH (240+ chars)
/// to prevent path-too-long I/O failures across deeply nested directory structures (node_modules, etc.).
pub fn to_extended_path(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if s.len() > 240 && !s.starts_with(r"\\?\") {
        if let Some(stripped) = s.strip_prefix(r"\\") {
            PathBuf::from(format!(r"\\?\UNC\{}", stripped))
        } else {
            PathBuf::from(format!(r"\\?\{}", s))
        }
    } else {
        path.to_path_buf()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn expanded_paths_use_backslashes_only() {
        for template in [
            "${win_dir}/SoftwareDistribution/Download/*",
            "${home}/.claude/cache/model-catalog",
            r"${local_app_data}\Temp/sub\file.tmp",
        ] {
            let expanded = expand_path_variables(template);
            let s = expanded.to_string_lossy();
            assert!(!s.contains('/'), "mixed separators in {s}");
            assert!(!s.contains('$'), "unexpanded variable in {s}");
        }
    }

    #[test]
    #[cfg(windows)]
    fn unc_and_verbatim_prefixes_survive() {
        assert_eq!(
            to_platform_separators(r"\\server\share/dir/file"),
            r"\\server\share\dir\file"
        );
        assert_eq!(
            to_platform_separators(r"\\?\C:\Users/u/cache"),
            r"\\?\C:\Users\u\cache"
        );
        assert_eq!(
            to_platform_separators(r"\\?\UNC\server\share\x"),
            r"\\?\UNC\server\share\x"
        );
        assert_eq!(to_platform_separators("C:/a/b"), r"C:\a\b");
    }

    #[test]
    #[cfg(not(windows))]
    fn non_windows_paths_are_unchanged() {
        assert_eq!(to_platform_separators("/home/u/.cache"), "/home/u/.cache");
    }
}
