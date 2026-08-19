// IdleThrottleMonitor has been intentionally removed.
//
// Previously this module called SetPriorityClass(handle, IDLE_PRIORITY_CLASS) which
// throttled the ENTIRE process — starving the WebView rendering engine, V8 JS runtime,
// and DOM event loop whenever other processes were active.
//
// FreeMyDisk now always runs at NORMAL_PRIORITY_CLASS (the OS default).
// Background I/O is made non-blocking via tauri::async_runtime::spawn_blocking
// so heavy scans never block the Tauri IPC or UI rendering thread.
