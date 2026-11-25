//! Rules for which registry keys may be removed as application leftovers.
//!
//! Shared by the app and the elevated helper so both enforce the same limits.
//! Allowed shapes mirror what the leftover scanner reports:
//! `HKCU|HKLM\Software[\WOW6432Node]\<App>` and
//! `HKCU|HKLM\Software[\WOW6432Node]\<Publisher>\<App>`.

/// Vendor and system keys that are never removed, at any level.
const PROTECTED_SEGMENTS: &[&str] = &[
    "microsoft",
    "classes",
    "policies",
    "registeredapplications",
    "windows",
    "windows nt",
    "clients",
    "intel",
    "nvidia",
    "amd",
    "freemydisk",
    "wow6432node",
    "oem",
    "device",
];

/// Returns `Ok(())` when `key_path` is a leftover key the app is allowed to delete.
pub fn validate_leftover_key(key_path: &str) -> Result<(), String> {
    let reject = || {
        Err(format!(
            "Registry key is outside the allowed leftover locations: {key_path}"
        ))
    };

    let segments: Vec<&str> = key_path.trim().split('\\').collect();
    if segments
        .iter()
        .any(|s| s.is_empty() || *s == "." || *s == "..")
    {
        return reject();
    }

    let hive = segments[0].to_ascii_uppercase();
    if hive != "HKCU" && hive != "HKLM" {
        return reject();
    }
    if segments.len() < 3 || !segments[1].eq_ignore_ascii_case("Software") {
        return reject();
    }

    let mut rest = &segments[2..];
    if rest
        .first()
        .is_some_and(|s| s.eq_ignore_ascii_case("WOW6432Node"))
    {
        rest = &rest[1..];
    }
    if rest.is_empty() || rest.len() > 2 {
        return reject();
    }

    let protected = rest
        .iter()
        .any(|s| PROTECTED_SEGMENTS.contains(&s.to_ascii_lowercase().as_str()));
    if protected {
        return reject();
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_leftover_key;

    #[test]
    fn accepts_app_and_publisher_keys() {
        assert!(validate_leftover_key(r"HKCU\Software\SomeApp").is_ok());
        assert!(validate_leftover_key(r"HKLM\SOFTWARE\WOW6432Node\Vendor\SomeApp").is_ok());
    }

    #[test]
    fn rejects_system_and_deep_keys() {
        assert!(
            validate_leftover_key(r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer")
                .is_err()
        );
        assert!(validate_leftover_key(r"HKLM\SOFTWARE\Microsoft\Windows NT").is_err());
        assert!(validate_leftover_key(r"HKCU\Software\Vendor\App\Sub").is_err());
        assert!(validate_leftover_key(r"HKCU\Software").is_err());
        assert!(validate_leftover_key(r"HKCU\Software\..\System").is_err());
        assert!(validate_leftover_key(r"HKLM\SYSTEM\CurrentControlSet").is_err());
        assert!(validate_leftover_key(r"HKCR\Software\App").is_err());
    }
}
