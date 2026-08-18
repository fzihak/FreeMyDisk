# FreeMyDisk

<div align="center">
  <img src="FMD_Icon.png" width="128" height="128" alt="FreeMyDisk Logo" />
  <h1>FreeMyDisk</h1>
  <p><strong>Next-Generation, Safe Disk Cleaning & Storage Optimization for Windows & macOS</strong></p>
  <p>Created & Developed by <a href="https://github.com/fzihak"><strong>Foysal Zihak</strong></a></p>

  <p>
    <a href="https://github.com/fzihak/FreeMyDisk"><img src="https://img.shields.io/badge/GitHub-fzihak%2FFreeMyDisk-181717?style=flat-square&logo=github" alt="GitHub Repository" /></a>
    <a href="https://github.com/fzihak/FreeMyDisk/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-GPL--3.0-blue?style=flat-square" alt="License: GPL-3.0" /></a>
    <img src="https://img.shields.io/badge/Rust-1.85%2B-orange?style=flat-square&logo=rust" alt="Rust 1.85+" />
    <img src="https://img.shields.io/badge/Tauri-v2-24C8DB?style=flat-square&logo=tauri" alt="Tauri v2" />
    <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react" alt="React 19" />
    <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS-0078D4?style=flat-square&logo=windows" alt="Windows & macOS" />
  </p>
</div>

---

## ⚡ Overview

**FreeMyDisk** is a high-performance system maintenance and storage optimization utility designed with uncompromising safety standards. It bridges the gap between deep system decluttering and risk-free operation, featuring declarative cache scanners, Canvas-accelerated disk treemaps, 4-phase duplicate detection with physical block identity awareness, application leftover hunters, and privacy clean engines.

---

## 🛡️ Core Safety Invariants

FreeMyDisk guarantees that user data is protected against accidental loss, unexpected crashes, and race conditions through strict invariants:

1. **Trash-First by Default**: All user-facing deletions move items to the OS Recycle Bin / Trash with 100% rollback capability.
2. **Zero Automatic Fallback**: If Trash disposal fails (e.g. non-supported volume or permission error), FreeMyDisk **NEVER** silently falls back to permanent deletion. The file is preserved and flagged.
3. **Write-Ahead Log (WAL) Crash Recovery Journal**: Deletion intents are logged to an embedded SQLite WAL database before filesystem modifications. Interrupted sessions are automatically cleaned or rolled back.
4. **Hardlink & Physical Block Identity (0-Savings)**: Duplicate detection inspects filesystem device IDs and file indices. Files pointing to identical physical disk blocks contribute **0 bytes** to potential savings calculations.
5. **Canonical Path Deduplication**: Cleanup plans deduplicate targets by physical canonical path, ensuring zero redundant deletions or duplicate size metrics.
6. **Subpath & Critical Directory Protection**: Kernel system directories (e.g. `C:\Windows`, `/System`, system user hives) are strictly protected by a non-bypassable path registry.
7. **Active Browser Process Protection**: Scans detect active browser processes (Chrome, Edge, Firefox, Brave) and skip locked SQLite databases to prevent browser crashes.

---

## 🏗️ Architecture

```
┌───────────────────────────────────────────────────────────────┐
│              FreeMyDisk Desktop Frontend (React 19)           │
│        Clarity Engine • Canvas Treemap • TailwindCSS v4       │
└───────────────────────────────┬───────────────────────────────┘
                                │ Tauri v2 IPC
┌───────────────────────────────▼───────────────────────────────┐
│               Tauri Host Application (src-tauri)              │
│       State Management • Permission Dispatch • Updater        │
└───────────────┬───────────────────────────────┬───────────────┘
                │                               │
┌───────────────▼──────────────┐ ┌──────────────▼──────────────┐
│  freemydisk-core (Rust)      │ │ freemydisk-cli (Rust CLI)    │
│  • RuleEngine (TOML)         │ │ Headless terminal execution  │
│  • DuplicateDetector (BLAKE3)│ │ Tabular / JSON / CSV output  │
│  • LargeFilesScanner         │ └──────────────────────────────┘
│  • StorageAnalyzer (Canvas)  │
│  • CrashRecoveryJournal(WAL) │
│  • DisposalEngine & Planner  │
└───────────────┬──────────────┘
                │ Platform Traits
┌───────────────▼───────────────────────────────────────────────┐
│               freemydisk-platform (Rust)                      │
│     WindowsPlatform (Win32 / WinReg) • MacosPlatform          │
└───────────────────────────────┬───────────────────────────────┘
                                │ IPC Pipe (Named Pipe / UAC)
┌───────────────────────────────▼───────────────────────────────┐
│           freemydisk-elevated Helper Service                  │
│    Allowlisted privileged actions (DISM, SFC, System Temp)    │
└───────────────────────────────────────────────────────────────┘
```

---

## 📦 System Modules & Features

| Module | Features & Capabilities |
| :--- | :--- |
| **Dashboard** | Real-time storage gauges, quick system health overview, one-click safe cleanup. |
| **Cleanup** | Declarative TOML-based rule scanning across System, Browser, Development, and AI model caches. |
| **Storage (Treemap)** | Canvas-rendered Squarified D3 treemap with memory spillover store and hierarchical zoom. |
| **Large Files** | Multi-root traversal discovering large files with extension classification (Media, Archives, Documents, Binaries). |
| **Duplicates** | 4-phase deduplication engine (Size → Identity → Sample Hash → BLAKE3 Full Hash) with smart heuristic selection. |
| **Privacy** | Cleans browser history, download cache, and cookies with configurable cookie whitelist domain protection. |
| **Applications** | Lists installed software, tracks disk consumption, and cleans post-uninstall leftover artifacts. |
| **Startup** | Analyzes startup software with calculated boot impact ratings and protected system guards. |
| **Maintenance** | Diagnostics: Icon & Thumbnail cache reset, DNS resolver flush, Search Index rebuild, Windows Update cache purge, Network reset. |
| **Optimization** | Hibernation file management (`hiberfil.sys`), Storage Sense automated toggling, and Delivery Optimization cache purge. |
| **History** | Audit log of all completed cleanup sessions with recovered bytes and execution logs. |
| **Settings** | Extra-safe global Trash override, auto-updater configuration, and telemetry preferences. |

---

## 💻 Headless CLI (`freemydisk`)

FreeMyDisk includes a full-featured headless CLI binary for automation, scripts, and terminal power users.

### Global Installation / Build
```bash
cargo build --release -p freemydisk-cli
# Executable located at: target/release/freemydisk-cli
```

### CLI Command Reference

#### 1. Scan verified caches
```bash
# Scan all caches with rich tabular output
freemydisk scan

# Filter by category (system, browser, development, application, ai)
freemydisk scan --category browser

# Output in JSON or CSV for scripting
freemydisk scan --format json
freemydisk scan --format csv
```

#### 2. Safe cleanup execution
```bash
# Dry-run simulation (no files are deleted or modified)
freemydisk clean --dry-run

# Interactive cleanup with Recycle Bin / Trash default
freemydisk clean

# Automated non-interactive cleanup for cron/scripts
freemydisk clean --yes

# Filter cleanup by category
freemydisk clean --category system --yes
```

#### 3. Duplicate file detection
```bash
# Scan current directory for duplicates >= 10 MB
freemydisk duplicates --min-size 10

# Scan multiple specific directories
freemydisk duplicates --roots "C:\Projects" "D:\Downloads" --min-size 5
```

#### 4. Large files discovery
```bash
# Find files larger than 500 MB (top 50)
freemydisk large-files --min-size 500 --limit 50
```

#### 5. Storage analysis tree
```bash
# Print hierarchical storage breakdown tree (depth 3)
freemydisk analyze --path "C:\Users\foysa" --depth 3
```

#### 6. System maintenance & repair
```bash
# List available diagnostic repair tasks
freemydisk maintenance --list

# Run a specific task by ID
freemydisk maintenance --task dns_flush

# Run all recommended safe repair tasks
freemydisk maintenance --all
```

#### 7. Startup application impact
```bash
# Display registered startup software and boot impact scores
freemydisk startup
```

---

## 🧪 Testing & Verification

The FreeMyDisk codebase is test-gated across all backend crates and frontend components:

```bash
# Run all 36+ Rust workspace tests (domain logic, platform traits, journals, CLI)
cargo test --workspace

# Run frontend test suite (Vitest + React Testing Library)
pnpm test

# Build production bundle
pnpm build
```

---

## 👨‍💻 Author & Credits

FreeMyDisk is designed and engineered by **Foysal Zihak** ([@fzihak](https://github.com/fzihak)).

- **GitHub Repository**: [https://github.com/fzihak/FreeMyDisk](https://github.com/fzihak/FreeMyDisk)
- **Author Profile**: [https://github.com/fzihak](https://github.com/fzihak)
- **Bug Tracker & Issues**: [https://github.com/fzihak/FreeMyDisk/issues](https://github.com/fzihak/FreeMyDisk/issues)
- **Release Downloads**: [https://github.com/fzihak/FreeMyDisk/releases](https://github.com/fzihak/FreeMyDisk/releases)

---

## 📜 License

FreeMyDisk is open-source software licensed under the **[GNU General Public License v3.0](LICENSE)** (GPL-3.0-only).  
Trademarks, product naming, and visual identity are governed under **[TRADEMARK.md](TRADEMARK.md)**.
