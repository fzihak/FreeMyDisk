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

    paths
});

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

        // 1. Critical internal file signatures
        if path_str.ends_with("FREEMYDISK.DB")
            || path_str.ends_with("FREEMYDISK.DB-WAL")
            || path_str.ends_with("FREEMYDISK.DB-SHM")
            || path_str.ends_with("JOURNAL.DB")
            || path_str.ends_with("JOURNAL.DB-WAL")
            || path_str.ends_with("JOURNAL.DB-SHM")
            || path_str.ends_with("FREEMYDISK.EXE")
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

        // 3. User appdata / localappdata / programdata FreeMyDisk directories
        for env_var in &["APPDATA", "LOCALAPPDATA", "PROGRAMDATA"] {
            if let Ok(val) = std::env::var(env_var) {
                let fmd_dir = PathBuf::from(val).join("FreeMyDisk");
                let fmd_upper = fmd_dir.to_string_lossy().to_ascii_uppercase();
                if path_str == fmd_upper || path_str.starts_with(&format!(r"{}\", fmd_upper)) {
                    return true;
                }
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
        let path_str = path.to_string_lossy();
        let canonical = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let canonical_str = canonical.to_string_lossy();
        let expanded = Self::expand_8_3_short_path(path);
        let expanded_str = expanded.to_string_lossy();
        let lexical = Self::normalize_lexical(path);
        let lexical_str = lexical.to_string_lossy();

        let normalize = |s: &str| -> String {
            let mut upper = s.to_ascii_uppercase();
            if upper.starts_with(r"\\?\") {
                upper = upper[4..].to_string();
            }
            upper.trim_end_matches('\\').to_string()
        };

        let path_norm = normalize(&path_str);
        let canon_norm = normalize(&canonical_str);
        let exp_norm = normalize(&expanded_str);
        let lex_norm = normalize(&lexical_str);

        // Also check if final handle resolution reveals substitution
        let final_norm =
            Self::get_final_canonical_path(path).map(|p| normalize(&p.to_string_lossy()));

        let candidate_norms = [&path_norm, &canon_norm, &exp_norm, &lex_norm];

        let windir = std::env::var("SystemRoot")
            .or_else(|_| std::env::var("windir"))
            .unwrap_or_else(|_| r"C:\Windows".to_string());
        let windir_norm = normalize(&windir);

        for crit in DYNAMIC_SYSTEM_CRITICAL_PATHS.iter() {
            let crit_norm = normalize(&crit.to_string_lossy());

            for cand in candidate_norms {
                // Exact match on critical path itself
                if *cand == crit_norm {
                    return true;
                }

                // Path is inside protected directory
                if cand.starts_with(&format!(r"{}\", crit_norm)) {
                    if crit_norm == windir_norm || crit_norm == r"C:\WINDOWS" {
                        // Allow Windows Temp (handled by cleanup rules with safe guards)
                        if !cand.starts_with(&format!(r"{}\TEMP", windir_norm))
                            && !cand.starts_with(r"C:\WINDOWS\TEMP")
                        {
                            return true;
                        }
                    } else {
                        return true;
                    }
                }

                // Protected path is inside target (e.g. attempting to delete drive root)
                if crit_norm.starts_with(&format!(r"{}\", cand)) || crit_norm == *cand {
                    return true;
                }
            }

            if let Some(ref f_norm) = final_norm {
                if *f_norm == crit_norm || f_norm.starts_with(&format!(r"{}\", crit_norm)) {
                    if (crit_norm == windir_norm || crit_norm == r"C:\WINDOWS")
                        && (f_norm.starts_with(&format!(r"{}\TEMP", windir_norm))
                            || f_norm.starts_with(r"C:\WINDOWS\TEMP"))
                    {
                        // Allow
                    } else {
                        return true;
                    }
                }
            }
        }

        // Dynamic protected paths check
        let dyn_set = DYNAMIC_PROTECTED_PATHS.read();
        for dyn_path in dyn_set.iter() {
            let dyn_norm = normalize(&dyn_path.to_string_lossy());
            for cand in candidate_norms {
                if *cand == dyn_norm || cand.starts_with(&format!(r"{}\", dyn_norm)) {
                    return true;
                }
            }
        }

        false
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
