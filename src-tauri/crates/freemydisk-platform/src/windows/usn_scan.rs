use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct UsnFileNode {
    pub frn: u64,
    pub parent_frn: u64,
    pub name: String,
    pub is_dir: bool,
    pub is_hidden_or_system: bool,
}

pub struct UsnVolumeIndex {
    pub drive_letter: char,
    pub nodes: HashMap<u64, UsnFileNode>,
}

impl UsnVolumeIndex {
    /// Attempts high-throughput direct MFT/USN Change Journal enumeration for an entire NTFS volume.
    ///
    /// When available (under elevated rights on NTFS), reads millions of filesystem records
    /// directly from disk metadata in seconds.
    ///
    /// If the volume is non-NTFS, network-mounted, or the caller does not have volume read rights,
    /// returns `None` so the caller can gracefully fall back to parallel Win32 directory traversal.
    #[cfg(target_os = "windows")]
    pub fn try_enumerate_volume(drive_letter: char) -> Option<Self> {
        use std::ffi::OsString;
        use std::os::windows::ffi::OsStringExt;
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::Storage::FileSystem::{
            CreateFileW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_SYSTEM,
            FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        };
        use windows_sys::Win32::System::Ioctl::{FSCTL_ENUM_USN_DATA, MFT_ENUM_DATA_V0};
        use windows_sys::Win32::System::IO::DeviceIoControl;

        let path_str = format!(r"\\.\{}:", drive_letter.to_ascii_uppercase());
        let wide_path: Vec<u16> = path_str.encode_utf16().chain(Some(0)).collect();

        let handle = unsafe {
            CreateFileW(
                wide_path.as_ptr(),
                0x80000000, // GENERIC_READ
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            )
        };

        if handle == INVALID_HANDLE_VALUE {
            return None;
        }

        let mut med = MFT_ENUM_DATA_V0 {
            StartFileReferenceNumber: 0,
            LowUsn: 0,
            HighUsn: i64::MAX,
        };

        // 64 KB buffer for streaming USN records
        const BUF_SIZE: usize = 65536;
        let mut out_buf = vec![0u8; BUF_SIZE];
        let mut nodes = HashMap::with_capacity(32768);

        loop {
            let mut bytes_returned = 0u32;
            let success = unsafe {
                DeviceIoControl(
                    handle,
                    FSCTL_ENUM_USN_DATA,
                    &med as *const _ as *const _,
                    std::mem::size_of::<MFT_ENUM_DATA_V0>() as u32,
                    out_buf.as_mut_ptr() as *mut _,
                    BUF_SIZE as u32,
                    &mut bytes_returned,
                    std::ptr::null_mut(),
                )
            };

            if success == 0 || bytes_returned < 8 {
                break;
            }

            // The first 8 bytes contains the next StartFileReferenceNumber
            let next_frn = u64::from_le_bytes(out_buf[0..8].try_into().unwrap_or([0; 8]));
            let mut offset = 8usize;

            while offset + 60 <= bytes_returned as usize {
                // Parse USN_RECORD_V2 header
                let record_len =
                    u32::from_le_bytes(out_buf[offset..offset + 4].try_into().unwrap_or([0; 4]))
                        as usize;
                if record_len == 0 || offset + record_len > bytes_returned as usize {
                    break;
                }

                let frn = u64::from_le_bytes(
                    out_buf[offset + 8..offset + 16]
                        .try_into()
                        .unwrap_or([0; 8]),
                );
                let parent_frn = u64::from_le_bytes(
                    out_buf[offset + 16..offset + 24]
                        .try_into()
                        .unwrap_or([0; 8]),
                );
                let file_attr = u32::from_le_bytes(
                    out_buf[offset + 52..offset + 56]
                        .try_into()
                        .unwrap_or([0; 4]),
                );
                let name_len = u16::from_le_bytes(
                    out_buf[offset + 56..offset + 58]
                        .try_into()
                        .unwrap_or([0; 2]),
                ) as usize;
                let name_offset = u16::from_le_bytes(
                    out_buf[offset + 58..offset + 60]
                        .try_into()
                        .unwrap_or([0; 2]),
                ) as usize;

                if offset + name_offset + name_len <= bytes_returned as usize && name_len >= 2 {
                    let u16_slice = unsafe {
                        std::slice::from_raw_parts(
                            out_buf.as_ptr().add(offset + name_offset) as *const u16,
                            name_len / 2,
                        )
                    };
                    let name = OsString::from_wide(u16_slice).to_string_lossy().to_string();
                    let is_dir = (file_attr & FILE_ATTRIBUTE_DIRECTORY) != 0;
                    let is_hidden_or_system =
                        (file_attr & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM)) != 0;

                    nodes.insert(
                        frn,
                        UsnFileNode {
                            frn,
                            parent_frn,
                            name,
                            is_dir,
                            is_hidden_or_system,
                        },
                    );
                }

                offset += record_len;
            }

            if next_frn == 0 || next_frn == med.StartFileReferenceNumber {
                break;
            }
            med.StartFileReferenceNumber = next_frn;
        }

        unsafe { CloseHandle(handle) };

        if nodes.is_empty() {
            None
        } else {
            Some(Self {
                drive_letter,
                nodes,
            })
        }
    }

    #[cfg(not(target_os = "windows"))]
    pub fn try_enumerate_volume(_drive_letter: char) -> Option<Self> {
        None
    }

    /// Resolves the full path of an entry from its FRN by walking parent links.
    pub fn resolve_path(&self, frn: u64) -> Option<PathBuf> {
        let mut parts = Vec::new();
        let mut curr_frn = frn;
        let mut depth = 0;

        while let Some(node) = self.nodes.get(&curr_frn) {
            depth += 1;
            if depth > 128 {
                // Guard against cyclic reparse graphs
                break;
            }
            if node.name.is_empty() || node.name == "." || node.name == ".." {
                break;
            }
            parts.push(node.name.clone());
            if node.parent_frn == curr_frn || node.parent_frn == 0 {
                break;
            }
            curr_frn = node.parent_frn;
        }

        if parts.is_empty() {
            return None;
        }

        parts.reverse();
        let mut path = PathBuf::from(format!(r"{}:\", self.drive_letter));
        for p in parts {
            path.push(p);
        }
        Some(path)
    }

    /// Finds all nodes whose names match a target pattern (e.g., "node_modules", "target", "*.cache").
    pub fn find_by_name(&self, target_name: &str) -> Vec<(u64, &UsnFileNode)> {
        self.nodes
            .iter()
            .filter(|(_, node)| node.name.eq_ignore_ascii_case(target_name))
            .map(|(&frn, node)| (frn, node))
            .collect()
    }
}
