use crate::shared::errors::CoreError;
use parking_lot::RwLock;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

pub const CRITICAL_SYSTEM_PATHS: &[&str] = &[
    r"C:\Windows",
    r"C:\Windows\System32",
    r"C:\Windows\SysWOW64",
    r"C:\ProgramData\Microsoft\Windows",
    r"C:\Boot",
    r"C:\Recovery",
    r"C:\System Volume Information",
    r"C:\$Recycle.Bin",
    r"C:\pagefile.sys",
    r"C:\swapfile.sys",
    r"C:\hiberfil.sys",
    r"C:\DumpStack.log",
    r"C:\Program Files",
    r"C:\Program Files (x86)",
    r"C:\PROGRA~1",
    r"C:\PROGRA~2",
    r"C:\WINDOW~1",
];

pub const CRITICAL_PATHS_WINDOWS: &[&str] = CRITICAL_SYSTEM_PATHS;

static DYNAMIC_PROTECTED_PATHS: LazyLock<RwLock<HashSet<PathBuf>>> =
    LazyLock::new(|| RwLock::new(HashSet::new()));

static DYNAMIC_SYSTEM_CRITICAL_PATHS: LazyLock<Vec<PathBuf>> = LazyLock::new(|| {
    let mut paths = Vec::new();

    // 1. Static base list (ensures standard default protection)
    for &p in CRITICAL_SYSTEM_PATHS {
        paths.push(PathBuf::from(p));
    }

    // 2. Discover active Windows system root and system drive dynamically
    let sys_root = std::env::var("SystemRoot")
        .or_else(|_| std::env::var("windir"))
        .unwrap_or_else(|_| r"C:\Windows".to_string());
    let sys_root_pb = PathBuf::from(&sys_root);
    paths.push(sys_root_pb.clone());
    paths.push(sys_root_pb.join("System32"));
    paths.push(sys_root_pb.join("SysWOW64"));

    // Discover SystemDrive (e.g. C:, D:, E:)
    let sys_drive = std::env::var("SystemDrive").unwrap_or_else(|_| {
        sys_root_pb
            .components()
            .next()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .unwrap_or_else(|| "C:".to_string())
    });
    let sys_drive_root = format!(r"{}\", sys_drive.trim_end_matches('\\'));
    let sys_drive_pb = PathBuf::from(&sys_drive_root);

    paths.push(sys_drive_pb.join("Boot"));
    paths.push(sys_drive_pb.join("Recovery"));
    paths.push(sys_drive_pb.join("System Volume Information"));
    paths.push(sys_drive_pb.join("$Recycle.Bin"));
    paths.push(sys_drive_pb.join("pagefile.sys"));
    paths.push(sys_drive_pb.join("swapfile.sys"));
    paths.push(sys_drive_pb.join("hiberfil.sys"));
    paths.push(sys_drive_pb.join("DumpStack.log"));

    // Discover ProgramData, ProgramFiles, and 32/64-bit variants
    if let Ok(pd) = std::env::var("ProgramData") {
        let pd_pb = PathBuf::from(&pd);
        paths.push(pd_pb.clone());
        paths.push(pd_pb.join("Microsoft").join("Windows"));
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        paths.push(PathBuf::from(&pf));
    }
    if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
        paths.push(PathBuf::from(&pf86));
    }
    if let Ok(pfw64) = std::env::var("ProgramW6432") {
        paths.push(PathBuf::from(&pfw64));
    }

    // macOS and Linux system folders.
    #[cfg(not(target_os = "windows"))]
    for p in [
        "/System",
        "/Library",
        "/Applications",
        "/bin",
        "/sbin",
        "/usr",
        "/etc",
        "/private",
        "/var",
        "/opt",
        "/cores",
        "/dev",
        "/boot",
        "/lib",
        "/lib64",
        "/proc",
        "/sys",
        "/snap",
    ] {
        paths.push(PathBuf::from(p));
    }

    paths
});

/// Cache locations inside protected system folders that built-in rules are allowed
/// to clean. Each entry is a glob relative to the Windows or ProgramData folder;
/// the cache folders themselves stay protected, only their contents are released.
static SYSTEM_CLEANABLE_PATTERNS: LazyLock<Vec<String>> = LazyLock::new(|| {
    let win_dir = std::env::var("SystemRoot")
        .or_else(|_| std::env::var("windir"))
        .unwrap_or_else(|_| r"C:\Windows".to_string());
    let program_data =
        std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".to_string());

    let windows = [
        "SoftwareDistribution/Download/*/**",
        "SoftwareDistribution/DeliveryOptimization/*/**",
        "Minidump/*/**",
        "Installer/$PatchCache$/*/**",
        "System32/winevt/Logs/Archive-*.evtx",
        "MEMORY.DMP",
    ];
    let program_data_entries = [
        "Microsoft/Search/Data/Temp/*/**",
        "Battle.net/Agent/data/cache/*/**",
        "GOG.com/Galaxy/logs/*/**",
    ];

    windows
        .iter()
        .map(|p| format!("{}/{}", win_dir, p))
        .chain(
            program_data_entries
                .iter()
                .map(|p| format!("{}/{}", program_data, p)),
        )
        .collect()
});

fn is_system_cleanable(norm: &str) -> bool {
    SYSTEM_CLEANABLE_PATTERNS
        .iter()
        .any(|pattern| crate::cleanup::matchers::glob_match(pattern, norm))
}

/// Folders that directly hold user profiles; each child is a profile root.
static USERS_ROOTS: LazyLock<Vec<String>> = LazyLock::new(|| {
    let sys_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
    let mut roots = vec![
        format!(r"{}\Users", sys_drive.trim_end_matches('\\')),
        "/Users".to_string(),
        "/home".to_string(),
    ];
    for var in ["USERPROFILE", "HOME"] {
        if let Some(parent) = std::env::var(var)
            .ok()
            .and_then(|v| PathBuf::from(v).parent().map(Path::to_path_buf))
        {
            roots.push(parent.to_string_lossy().to_string());
        }
    }
    roots
        .iter()
        .map(|r| normalize_upper(r))
        .filter(|r| !r.is_empty())
        .collect()
});

/// Folders that must never be deleted themselves, although files inside them may be.
/// Covers the users root, each profile root and the standard profile folders.
static CONTAINER_PATHS: LazyLock<Vec<String>> = LazyLock::new(|| {
    let mut paths: Vec<PathBuf> = Vec::new();

    let sys_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
    let users_root = PathBuf::from(format!(r"{}\Users", sys_drive.trim_end_matches('\\')));
    paths.push(users_root);

    for var in ["USERPROFILE", "PUBLIC", "OneDrive", "TEMP", "TMP"] {
        if let Ok(v) = std::env::var(var) {
            paths.push(PathBuf::from(v));
        }
    }

    if let Ok(profile) = std::env::var("USERPROFILE") {
        let profile = PathBuf::from(profile);
        if let Some(parent) = profile.parent() {
            paths.push(parent.to_path_buf());
        }
        for sub in [
            "Desktop",
            "Documents",
            "Downloads",
            "Pictures",
            "Music",
            "Videos",
            "Favorites",
            "Contacts",
            "Saved Games",
            "OneDrive",
            "AppData",
            r"AppData\Local",
            r"AppData\LocalLow",
            r"AppData\Roaming",
            r"AppData\Local\Temp",
        ] {
            paths.push(profile.join(sub));
        }
    }

    for var in ["APPDATA", "LOCALAPPDATA"] {
        if let Ok(v) = std::env::var(var) {
            paths.push(PathBuf::from(v));
        }
    }

    // macOS and Linux home folders.
    if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);
        paths.push(home.clone());
        for sub in [
            "Desktop",
            "Documents",
            "Downloads",
            "Pictures",
            "Music",
            "Movies",
            "Videos",
            "Library",
            ".config",
            ".local",
            ".local/share",
        ] {
            paths.push(home.join(sub));
        }
    }
    paths.push(PathBuf::from("/Volumes"));
    paths.push(PathBuf::from("/media"));
    paths.push(PathBuf::from("/mnt"));

    paths
        .iter()
        .map(|p| normalize_upper(&p.to_string_lossy()))
        .filter(|s| !s.is_empty())
        .collect()
});

fn normalize_upper(s: &str) -> String {
    let mut upper = s.replace('/', r"\").to_ascii_uppercase();
    if let Some(stripped) = upper.strip_prefix(r"\\?\UNC\") {
        upper = format!(r"\\{}", stripped);
    } else if let Some(stripped) = upper.strip_prefix(r"\\?\") {
        upper = stripped.to_string();
    }
    upper.trim_end_matches('\\').to_string()
}

/// True for a drive or share root such as `D:`, `D:\` or `\\server\share`.
fn is_volume_root(norm: &str) -> bool {
    if norm.is_empty() {
        return true;
    }
    let bytes = norm.as_bytes();
    if bytes.len() == 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return true;
    }
    if let Some(rest) = norm.strip_prefix(r"\\") {
        return rest.split('\\').filter(|s| !s.is_empty()).count() <= 2;
    }
    !norm.contains('\\') && norm.starts_with('/') && norm.trim_matches('/').is_empty()
}

/// True when `norm` is a container folder, an ancestor of one, or a profile root
/// directly under the users folder.
fn is_container_or_ancestor(norm: &str) -> bool {
    if is_volume_root(norm) {
        return true;
    }
    for users_root in USERS_ROOTS.iter() {
        if norm == users_root {
            return true;
        }
        if let Some(rest) = norm.strip_prefix(&format!(r"{}\", users_root)) {
            if !rest.is_empty() && !rest.contains('\\') {
                return true;
            }
        }
    }
    CONTAINER_PATHS
        .iter()
        .any(|c| c == norm || c.starts_with(&format!(r"{}\", norm)))
}

pub struct ProtectedPathRegistry;

impl ProtectedPathRegistry {
    /// Dynamically registers a runtime-protected path (such as application data, database, or locks).
    pub fn register_protected_path(path: PathBuf) {
        let mut set = DYNAMIC_PROTECTED_PATHS.write();
        set.insert(path);
    }

    /// Clears dynamically registered paths (primarily for testing).
    pub fn clear_dynamic_paths() {
        let mut set = DYNAMIC_PROTECTED_PATHS.write();
        set.clear();
    }

    /// Returns true if the path points to an internal FreeMyDisk executable, database, lock, or staging directory.
    pub fn is_self_asset(path: &Path) -> bool {
        let path_str = path.to_string_lossy().to_ascii_uppercase();

        // 1. The app's own binaries and in-progress staging folders, wherever they are
        if path_str.ends_with("FREEMYDISK.EXE")
            || path_str.ends_with("FREEMYDISK-ELEVATED.EXE")
            || path_str.ends_with("FREEMYDISK_LIB.DLL")
            || path_str.ends_with("FREEMYDISK_DISPOSAL.LOCK")
            || (path_str.ends_with(".LOCK") && path_str.contains("FREEMYDISK"))
            || path_str.contains(".FMD-STAGING-")
        {
            return true;
        }

        // 2. Current running executable
        if let Ok(exe_path) = std::env::current_exe() {
            let exe_upper = exe_path.to_string_lossy().to_ascii_uppercase();
            if path_str == exe_upper {
                return true;
            }
        }

        // 3. The app's data folder (journal, locks, caches) and its log/crash folder
        let own_dirs = crate::shared::paths::app_data_dir()
            .into_iter()
            .chain(std::env::var_os("LOCALAPPDATA").map(|v| PathBuf::from(v).join("FreeMyDisk")));
        for dir in own_dirs {
            let dir_upper = dir.to_string_lossy().to_ascii_uppercase();
            if path_str == dir_upper || path_str.starts_with(&format!(r"{}\", dir_upper)) {
                return true;
            }
        }

        // 4. Dynamic protected set
        let dyn_set = DYNAMIC_PROTECTED_PATHS.read();
        for protected in dyn_set.iter() {
            let prot_upper = protected.to_string_lossy().to_ascii_uppercase();
            if path_str == prot_upper || path_str.starts_with(&format!(r"{}\", prot_upper)) {
                return true;
            }
        }

        false
    }

    /// Detects whether a path is an NTFS reparse point (junction, symlink, or cloud sync stub)
    /// without following the link into the target directory.
    pub fn is_reparse_point(path: &Path) -> bool {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x00000400;
            if let Ok(meta) = std::fs::symlink_metadata(path) {
                return (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            if let Ok(meta) = std::fs::symlink_metadata(path) {
                return meta.file_type().is_symlink();
            }
        }
        false
    }

    /// Detects whether a path is a directory junction specifically.
    pub fn is_directory_junction(path: &Path) -> bool {
        #[cfg(not(target_os = "windows"))]
        let _ = path;
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x00000010;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x00000400;
            if let Ok(meta) = std::fs::symlink_metadata(path) {
                let attrs = meta.file_attributes();
                return (attrs & FILE_ATTRIBUTE_DIRECTORY != 0)
                    && (attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0);
            }
        }
        false
    }

    /// Expands 8.3 short-name components on Windows into their long-name equivalents.
    pub fn expand_8_3_short_path(path: &Path) -> PathBuf {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::ffi::{OsStrExt, OsStringExt};
            let wide: Vec<u16> = path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let mut buffer = vec![0u16; 1024];
            let len = unsafe {
                windows_sys::Win32::Storage::FileSystem::GetLongPathNameW(
                    wide.as_ptr(),
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                )
            };
            if len > 0 && len < buffer.len() as u32 {
                let os_str = std::ffi::OsString::from_wide(&buffer[..len as usize]);
                return PathBuf::from(os_str);
            }
        }
        path.to_path_buf()
    }

    /// Resolves the true final canonical DOS path of an open handle via `GetFinalPathNameByHandleW`
    /// to mitigate TOCTOU symlink substitution races.
    pub fn get_final_canonical_path(path: &Path) -> Option<PathBuf> {
        #[cfg(not(target_os = "windows"))]
        let _ = path;
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::ffi::{OsStrExt, OsStringExt};
            use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
            use windows_sys::Win32::Storage::FileSystem::{
                CreateFileW, GetFinalPathNameByHandleW, FILE_FLAG_BACKUP_SEMANTICS,
                FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
                VOLUME_NAME_DOS,
            };

            let wide: Vec<u16> = path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    0, // Query access only (does not lock or require write privileges)
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS,
                    0 as _,
                )
            };

            if handle == INVALID_HANDLE_VALUE {
                return None;
            }

            let mut buffer = vec![0u16; 1024];
            let len = unsafe {
                GetFinalPathNameByHandleW(
                    handle,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    VOLUME_NAME_DOS,
                )
            };

            unsafe {
                CloseHandle(handle);
            }

            if len > 0 && len < buffer.len() as u32 {
                let raw = std::ffi::OsString::from_wide(&buffer[..len as usize]);
                let mut s = raw.to_string_lossy().to_string();
                if s.starts_with(r"\\?\") {
                    s = s[4..].to_string();
                }
                return Some(PathBuf::from(s));
            }
        }
        None
    }

    /// Normalizes relative directory components (such as .. and .) lexically
    /// to prevent directory traversal bypasses even when target subpaths do not yet exist.
    pub fn normalize_lexical(path: &Path) -> PathBuf {
        use std::path::Component;
        let mut out = Vec::new();
        for comp in path.components() {
            match comp {
                Component::ParentDir => {
                    if let Some(Component::Normal(_)) = out.last() {
                        out.pop();
                    }
                }
                Component::CurDir => {}
                _ => out.push(comp),
            }
        }
        out.into_iter().collect()
    }

    /// Returns true if the path points to, or is an ancestor of, a protected system path,
    /// or if the path is identical to a critical protected path.
    pub fn is_protected(path: &Path) -> bool {
        let canonical = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let expanded = Self::expand_8_3_short_path(path);
        let lexical = Self::normalize_lexical(path);

        let candidates = [
            normalize_upper(&path.to_string_lossy()),
            normalize_upper(&canonical.to_string_lossy()),
            normalize_upper(&expanded.to_string_lossy()),
            normalize_upper(&lexical.to_string_lossy()),
        ];
        // Also check if final handle resolution reveals substitution
        let final_norm =
            Self::get_final_canonical_path(path).map(|p| normalize_upper(&p.to_string_lossy()));

        Self::is_protected_forms(&candidates, final_norm.as_deref())
    }

    /// Path-only variant of [`is_protected`](Self::is_protected) for read-only scans.
    /// It makes no file-system calls, so it is cheap enough to run for every file a
    /// scan visits. Disposal always re-checks with the full version, which also
    /// resolves links, short names and the final path of an open handle.
    /// System folders and files (plus runtime-registered paths) that must never be
    /// cleaned. Unlike [`Self::is_protected_lexical`] this list holds no user
    /// containers such as `C:\Users`, so a file scan can use it to decide which
    /// folders to skip while still entering the user's own folders.
    pub fn system_critical_paths() -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = DYNAMIC_SYSTEM_CRITICAL_PATHS.clone();
        out.extend(DYNAMIC_PROTECTED_PATHS.read().iter().cloned());
        out
    }

    pub fn is_protected_lexical(path: &Path) -> bool {
        let lexical = Self::normalize_lexical(path);
        let candidates = [
            normalize_upper(&path.to_string_lossy()),
            normalize_upper(&lexical.to_string_lossy()),
        ];
        Self::is_protected_forms(&candidates, None)
    }

    fn is_protected_forms(candidates: &[String], final_norm: Option<&str>) -> bool {
        if candidates
            .iter()
            .map(String::as_str)
            .chain(final_norm)
            .any(is_container_or_ancestor)
        {
            return true;
        }

        let windir = std::env::var("SystemRoot")
            .or_else(|_| std::env::var("windir"))
            .unwrap_or_else(|_| r"C:\Windows".to_string());
        let windir_norm = normalize_upper(&windir);
        let in_windows_temp = |p: &str| {
            p.starts_with(&format!(r"{}\TEMP", windir_norm)) || p.starts_with(r"C:\WINDOWS\TEMP")
        };

        // Rule-approved caches inside system folders skip the system-folder check only
        // when every resolved form of the path (including the final target of any
        // link) stays inside an approved location.
        let system_cleanable = candidates.iter().all(|c| is_system_cleanable(c))
            && final_norm.is_none_or(is_system_cleanable);

        if !system_cleanable {
            for crit in DYNAMIC_SYSTEM_CRITICAL_PATHS.iter() {
                let crit_norm = normalize_upper(&crit.to_string_lossy());
                let is_windows_dir = crit_norm == windir_norm || crit_norm == r"C:\WINDOWS";

                for cand in candidates.iter().map(String::as_str).chain(final_norm) {
                    if cand == crit_norm {
                        return true;
                    }
                    // Inside a protected folder (Windows Temp is cleaned by rules).
                    if cand.starts_with(&format!(r"{}\", crit_norm))
                        && !(is_windows_dir && in_windows_temp(cand))
                    {
                        return true;
                    }
                    // A protected folder inside the target, e.g. a drive root.
                    if crit_norm.starts_with(&format!(r"{}\", cand)) {
                        return true;
                    }
                }
            }
        }

        let dyn_set = DYNAMIC_PROTECTED_PATHS.read();
        dyn_set.iter().any(|dyn_path| {
            let dyn_norm = normalize_upper(&dyn_path.to_string_lossy());
            candidates
                .iter()
                .any(|c| *c == dyn_norm || c.starts_with(&format!(r"{}\", dyn_norm)))
        })
    }

    /// Enforces that a path is safe for disposal. Returns Ok(()) if safe,
    /// or Err(CoreError::ProtectedPath) / Err(CoreError::SelfPreservationViolation) if prohibited.
    pub fn assert_safe_for_disposal(path: &Path) -> Result<(), CoreError> {
        if Self::is_self_asset(path) {
            return Err(CoreError::SelfPreservationViolation(path.to_path_buf()));
        }
        if Self::is_protected(path) {
            return Err(CoreError::ProtectedPath(path.to_path_buf()));
        }
        Ok(())
    }
}
