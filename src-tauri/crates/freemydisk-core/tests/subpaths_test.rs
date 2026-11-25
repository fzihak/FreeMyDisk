use freemydisk_core::cleanup::matchers::{filter_protected_subpaths, is_subpath_protected};
use std::path::PathBuf;

#[test]
fn test_protect_subpaths_glob_matching() {
    let patterns = vec![
        "*/cookies*".to_string(),
        "*/history*".to_string(),
        "*/Sessions/*".to_string(),
        "*/Login Data*".to_string(),
    ];

    let cookie_file =
        PathBuf::from(r"C:\Users\foysa\AppData\Local\Google\Chrome\User Data\Default\cookies");
    assert!(is_subpath_protected(&cookie_file, &patterns));

    let history_journal = PathBuf::from(
        r"C:\Users\foysa\AppData\Local\Google\Chrome\User Data\Default\history-journal",
    );
    assert!(is_subpath_protected(&history_journal, &patterns));

    let session_file = PathBuf::from(
        r"C:\Users\foysa\AppData\Local\Google\Chrome\User Data\Default\Sessions\Tabs_123",
    );
    assert!(is_subpath_protected(&session_file, &patterns));

    let login_data = PathBuf::from(
        r"C:\Users\foysa\AppData\Local\Google\Chrome\User Data\Default\Login Data For Account",
    );
    assert!(is_subpath_protected(&login_data, &patterns));

    let cache_file = PathBuf::from(
        r"C:\Users\foysa\AppData\Local\Google\Chrome\User Data\Default\Cache\f_000123",
    );
    assert!(!is_subpath_protected(&cache_file, &patterns));
}

#[test]
fn test_filter_protected_subpaths_hard_exclusion() {
    let patterns = vec!["*/cookies*".to_string(), "*/history*".to_string()];

    let candidates = vec![
        PathBuf::from(r"C:\Chrome\Cache\data1"),
        PathBuf::from(r"C:\Chrome\Default\cookies"),
        PathBuf::from(r"C:\Chrome\Cache\data2"),
        PathBuf::from(r"C:\Chrome\Default\history.db"),
    ];

    let (allowed, protected) = filter_protected_subpaths(candidates, &patterns);

    assert_eq!(allowed.len(), 2);
    assert_eq!(protected.len(), 2);

    assert_eq!(allowed[0], PathBuf::from(r"C:\Chrome\Cache\data1"));
    assert_eq!(allowed[1], PathBuf::from(r"C:\Chrome\Cache\data2"));

    assert_eq!(protected[0], PathBuf::from(r"C:\Chrome\Default\cookies"));
    assert_eq!(protected[1], PathBuf::from(r"C:\Chrome\Default\history.db"));
}
