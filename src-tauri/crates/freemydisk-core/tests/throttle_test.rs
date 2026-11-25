use freemydisk_platform::traits::{PlatformError, PlatformIoPriority};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

struct MockIoPriority {
    simulated_idle_seconds: Arc<AtomicU64>,
    current_priority: Arc<std::sync::Mutex<String>>,
}

impl MockIoPriority {
    fn new(initial_idle_seconds: u64) -> Self {
        Self {
            simulated_idle_seconds: Arc::new(AtomicU64::new(initial_idle_seconds)),
            current_priority: Arc::new(std::sync::Mutex::new("Normal".to_string())),
        }
    }

    fn set_idle_seconds(&self, seconds: u64) {
        self.simulated_idle_seconds.store(seconds, Ordering::SeqCst);
    }
}

impl PlatformIoPriority for MockIoPriority {
    fn set_background_idle_priority(&self) -> Result<(), PlatformError> {
        *self.current_priority.lock().unwrap() = "Idle".to_string();
        Ok(())
    }

    fn set_below_normal_priority(&self) -> Result<(), PlatformError> {
        *self.current_priority.lock().unwrap() = "BelowNormal".to_string();
        Ok(())
    }

    fn set_normal_priority(&self) -> Result<(), PlatformError> {
        *self.current_priority.lock().unwrap() = "Normal".to_string();
        Ok(())
    }

    fn seconds_since_last_input(&self) -> Result<u64, PlatformError> {
        Ok(self.simulated_idle_seconds.load(Ordering::SeqCst))
    }
}

#[test]
fn test_mock_io_priority_operations() {
    let platform = MockIoPriority::new(10);
    assert_eq!(platform.seconds_since_last_input().unwrap(), 10);
    assert_eq!(*platform.current_priority.lock().unwrap(), "Normal");

    platform.set_background_idle_priority().unwrap();
    assert_eq!(*platform.current_priority.lock().unwrap(), "Idle");

    platform.set_below_normal_priority().unwrap();
    assert_eq!(*platform.current_priority.lock().unwrap(), "BelowNormal");

    platform.set_normal_priority().unwrap();
    assert_eq!(*platform.current_priority.lock().unwrap(), "Normal");

    platform.set_idle_seconds(42);
    assert_eq!(platform.seconds_since_last_input().unwrap(), 42);
}
