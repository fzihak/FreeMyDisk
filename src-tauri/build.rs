fn main() {
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=windows/hooks.nsh");
    println!("cargo:rerun-if-changed=resources/freemydisk-elevated.exe");

    // Ensure resources directory exists
    let resources_dir = std::path::Path::new("resources");
    let _ = std::fs::create_dir_all(resources_dir);

    // Sync freemydisk-elevated.exe from target if needed
    let elevated_candidates = [
        "../target/release/freemydisk-elevated.exe",
        "../target/debug/freemydisk-elevated.exe",
    ];
    for src in &elevated_candidates {
        let src_path = std::path::Path::new(src);
        let dest_path = resources_dir.join("freemydisk-elevated.exe");
        if src_path.exists() && !dest_path.exists() {
            let _ = std::fs::copy(src_path, dest_path);
            break;
        }
    }

    // Sync freemydisk-cli.exe from target if needed
    let cli_candidates = [
        "../target/release/freemydisk-cli.exe",
        "../target/debug/freemydisk-cli.exe",
    ];
    for src in &cli_candidates {
        let src_path = std::path::Path::new(src);
        let dest_path = resources_dir.join("freemydisk-cli.exe");
        if src_path.exists() && !dest_path.exists() {
            let _ = std::fs::copy(src_path, dest_path);
            break;
        }
    }

    tauri_build::build()
}
