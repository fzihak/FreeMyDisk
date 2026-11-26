#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriveMedia {
    Ssd,
    Hdd,
    Unknown,
}

/// Detects whether the specified drive is an SSD (Solid State Drive) or HDD (Rotational Media)
/// using Windows IOCTL_STORAGE_QUERY_PROPERTY and StorageDeviceSeekPenaltyProperty.
#[cfg(target_os = "windows")]
pub fn detect_drive_media(drive_letter: char) -> DriveMedia {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Ioctl::{
        PropertyStandardQuery, StorageDeviceSeekPenaltyProperty, DEVICE_SEEK_PENALTY_DESCRIPTOR,
        IOCTL_STORAGE_QUERY_PROPERTY, STORAGE_PROPERTY_QUERY,
    };
    use windows_sys::Win32::System::IO::DeviceIoControl;

    let path_str = format!(r"\\.\{}:", drive_letter.to_ascii_uppercase());
    let wide_path: Vec<u16> = path_str.encode_utf16().chain(Some(0)).collect();

    let handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            0, // Query access only (does not require administrator elevation)
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };

    if handle == INVALID_HANDLE_VALUE {
        return DriveMedia::Unknown;
    }

    let mut query = unsafe { std::mem::zeroed::<STORAGE_PROPERTY_QUERY>() };
    query.PropertyId = StorageDeviceSeekPenaltyProperty;
    query.QueryType = PropertyStandardQuery;

    let mut descriptor = unsafe { std::mem::zeroed::<DEVICE_SEEK_PENALTY_DESCRIPTOR>() };
    let mut bytes_returned = 0u32;

    let result = unsafe {
        DeviceIoControl(
            handle,
            IOCTL_STORAGE_QUERY_PROPERTY,
            &query as *const _ as *const _,
            std::mem::size_of::<STORAGE_PROPERTY_QUERY>() as u32,
            &mut descriptor as *mut _ as *mut _,
            std::mem::size_of::<DEVICE_SEEK_PENALTY_DESCRIPTOR>() as u32,
            &mut bytes_returned,
            std::ptr::null_mut(),
        )
    };

    unsafe { CloseHandle(handle) };

    if result != 0 {
        // IncursSeekPenalty == 0 -> SSD (No seek penalty)
        // IncursSeekPenalty == 1 -> HDD (Has mechanical seek penalty)
        if descriptor.IncursSeekPenalty == 0 {
            DriveMedia::Ssd
        } else {
            DriveMedia::Hdd
        }
    } else {
        DriveMedia::Unknown
    }
}

#[cfg(not(target_os = "windows"))]
pub fn detect_drive_media(_drive_letter: char) -> DriveMedia {
    DriveMedia::Unknown
}

/// Triggers background Windows storage optimization (TRIM on SSDs)
/// after large batch cleanup sessions to ensure optimal flash wear-leveling.
pub fn trigger_background_trim_if_ssd(drive_letter: char) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        if detect_drive_media(drive_letter) == DriveMedia::Ssd {
            let _ = std::process::Command::new("defrag.exe")
                .args(&[format!("{}:", drive_letter), "/O".to_string()])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn();
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = drive_letter;
}
