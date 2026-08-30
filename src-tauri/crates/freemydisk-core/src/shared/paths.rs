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

    PathBuf::from(resolved)
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
