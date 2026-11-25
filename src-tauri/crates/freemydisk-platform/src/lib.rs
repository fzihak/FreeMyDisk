pub mod traits;

#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub mod fallback;

pub use traits::*;

#[cfg(target_os = "windows")]
pub type CurrentPlatform = windows::WindowsPlatform;

#[cfg(target_os = "macos")]
pub type CurrentPlatform = macos::MacosPlatform;

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub type CurrentPlatform = fallback::FallbackPlatform;

pub fn get_platform() -> CurrentPlatform {
    CurrentPlatform::new()
}
