pub mod confidence;
pub mod filesystem;
pub mod models;
pub mod registry;
pub mod scanner;

pub use confidence::ConfidenceScorer;
pub use filesystem::FilesystemLeftoverScanner;
pub use models::{
    ApplicationLeftover, LeftoverCandidate, LeftoverConfidence, LeftoverGroup, LeftoverKind,
};
pub use registry::RegistryLeftoverScanner;
pub use scanner::LeftoverScanner;
