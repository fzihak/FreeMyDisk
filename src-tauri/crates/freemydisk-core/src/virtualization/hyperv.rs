use super::models::HyperVDisk;
use std::path::{Path, PathBuf};

pub struct HyperVScanner;

impl HyperVScanner {
    /// Discovers Hyper-V, VirtualBox, and VMware disk images across standard system directories.
    pub fn scan_vm_disks() -> Vec<HyperVDisk> {
        let mut disks = Vec::new();
        let mut search_dirs = Vec::new();

        // 1. Hyper-V default directories
        if let Ok(progdata) = std::env::var("PROGRAMDATA") {
            search_dirs.push(
                PathBuf::from(progdata).join(r"Microsoft\Windows\Hyper-V\Virtual Hard Disks"),
            );
        }
        if let Ok(public) = std::env::var("PUBLIC") {
            search_dirs.push(PathBuf::from(public).join(r"Documents\Hyper-V\Virtual Hard Disks"));
        }

        // 2. VirtualBox and VMware user directories
        if let Ok(userprofile) = std::env::var("USERPROFILE") {
            let up = PathBuf::from(userprofile);
            search_dirs.push(up.join("VirtualBox VMs"));
            search_dirs.push(up.join(r"Documents\Virtual Machines"));
        }

        for dir in search_dirs {
            if !dir.exists() {
                continue;
            }
            Self::traverse_disks(&dir, &mut disks, 0);
        }

        disks.sort_by_key(|d| std::cmp::Reverse(d.size_bytes));
        disks
    }

    fn traverse_disks(dir: &Path, list: &mut Vec<HyperVDisk>, depth: usize) {
        if depth > 4 {
            return;
        }

        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                Self::traverse_disks(&path, list, depth + 1);
            } else if path.is_file() {
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    let ext_lower = ext.to_lowercase();
                    let format = match ext_lower.as_str() {
                        "vhdx" => Some("VHDX"),
                        "vhd" => Some("VHD"),
                        "vdi" => Some("VDI"),
                        "vmdk" => Some("VMDK"),
                        _ => None,
                    };

                    if let Some(fmt) = format {
                        let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
                        if size_bytes >= 100 * 1024 * 1024 {
                            // Only list disks >= 100 MB
                            let vm_name = path
                                .parent()
                                .and_then(|p| p.file_name())
                                .map(|n| n.to_string_lossy().to_string())
                                .unwrap_or_else(|| "Virtual Machine".to_string());

                            list.push(HyperVDisk {
                                vm_name,
                                disk_path: path,
                                size_bytes,
                                format: fmt.to_string(),
                            });
                        }
                    }
                }
            }
        }
    }
}
