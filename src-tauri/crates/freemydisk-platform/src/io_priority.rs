#[cfg(target_os = "windows")]
use windows_sys::Win32::System::Threading::{
    GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN, THREAD_MODE_BACKGROUND_END,
};

/// A RAII guard that lowers thread CPU scheduling priority and thread I/O priority
/// to background level while active, and restores normal priority on drop.
///
/// Unlike setting process-level priority (which starves the GUI, WebView2 renderer, and JS event loop),
/// THREAD_MODE_BACKGROUND_BEGIN only throttles the worker thread, ensuring the UI remains 60fps responsive.
pub struct BackgroundExecutionGuard {
    active: bool,
}

impl BackgroundExecutionGuard {
    pub fn enter() -> Self {
        #[cfg(target_os = "windows")]
        {
            let success =
                unsafe { SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN) != 0 };
            Self { active: success }
        }
        #[cfg(not(target_os = "windows"))]
        {
            Self { active: false }
        }
    }

    pub fn is_active(&self) -> bool {
        self.active
    }
}

impl Drop for BackgroundExecutionGuard {
    fn drop(&mut self) {
        #[cfg(target_os = "windows")]
        if self.active {
            unsafe {
                SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_END);
            }
        }
    }
}

/// Executes a closure inside a background priority thread context.
pub fn with_background_priority<F, R>(f: F) -> R
where
    F: FnOnce() -> R,
{
    let _guard = BackgroundExecutionGuard::enter();
    f()
}
