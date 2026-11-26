# FreeMyDisk 1.0.0 – hands-on QA report

Tested on 2026-11-26. Build: v1.0.0 release (`272ec86`). Machine: Windows 11 25H2, 8 cores, 8 GB RAM, 5 drives (C: 89% full). Chrome was running. The app was not elevated.

## Critical

| # | Area | Problem | Evidence |
|---|------|---------|----------|
| C1 | Emergency Rescue | It looks frozen because it runs several slow steps on one thread. The UI shows no progress, and the user cannot cancel. The steps are: `SHEmptyRecycleBinW` on the whole bin (25.5 GB / 669 items here), a recursive `calc_dir_bytes` plus `remove_dir_all` over all of `%TEMP%` and `%WINDIR%\Temp`, and `wsl --shutdown` / `powercfg` through `Command::output()`. Neither command has a timeout. | `platform/src/windows/maintenance.rs` `execute_emergency_rescue`, `clean_target_dir` |
| C2 | Emergency Rescue | It permanently deletes everything in `%TEMP%`, `%WINDIR%\Temp`, CrashDumps, WER and D3DSCache. It skips the Recycle Bin, the journal, protected-path checks and the "skip recently modified temp files" rule. This includes temp files that running apps are using. It breaks the app's own trash-first and journal guarantees. | same |
| C3 | Emergency Rescue | The bytes freed by emptying the Recycle Bin are not counted in `total_bytes_reclaimed`, so the success toast under-reports. `powercfg /hibernate off` needs admin and fails silently when not elevated. | same |
| C4 | Clean Now (Dashboard) | The quick-clean set includes rules that cannot succeed. `C:\Windows\SoftwareDistribution\Download` needs admin: 12/12 items failed in both runs. Chrome Cache and GPUCache are locked while Chrome runs. The "339.5 MB reclaimable" headline counts these bytes, so most of the promised space is never freed. | Audit log: 37 of 100 records failed, all from Clean Now |
| C5 | Clean Now (Dashboard) | After cleaning, the card resets to "0 B · 0 categories inspected" and the button turns into "Scan for Junk Files". It never shows how much was freed or what failed. Users think nothing happened. | Screenshot after clean |

## High

| # | Area | Problem |
|---|------|---------|
| H1 | Dashboard | Opening the app starts a full 122-rule scan automatically. A full rescan takes ~27 s. Hot spots: "EA Desktop Cache" (~7.5 s), "Brave Browser Service Worker Cache" (~7 s), "Windows Explorer Thumbnail Cache" (~5 s). |
| H2 | Dashboard | During the scan the headline says "Ready", while the button says "Scanning Rule 56/122". "123 categories inspected", but there are 122 rules. |
| H3 | Large Files | A scan of all drives took 269 s. `pagefile.sys` (a system file) is listed with a delete button. |
| H4 | Duplicates | A scan of all drives at ≥10 MB took 390 s (6.5 min). |
| H5 | Audit Log | Paths mix separators (`C:\WINDOWS/SoftwareDistribution/Download\…`, `C:\Users\foysa/.claude/cache`). A pending reboot deletion shows the raw MoveFileEx form `*1!\??\C:\ProgramData\…`. |
| H6 | Deep Cleanup | The header says files go "to Recycle Bin by default", but the Dashboard's Clean Now uses `force_permanent: !alwaysTrashOverride`. Rows are not sorted by size: 0 B rules come before rules with data. The button reads "Clean Now (0 B)" when nothing is selected. |

## UI / text

- Dashboard: "Local Disk (C:) (C:\)" repeats the drive letter. The Duplicates card says "SHA-256", but the engine uses BLAKE3.
- Large Files and Duplicates: stat labels are lowercase ("files", "duplicate sets discovered") and show "—". "0 All" and "0 categories selected" make no sense. The drive chip text "21.3 GB / 189.8 GB" doesn't say whether it is free or used. The filter tab bars show a visible horizontal scrollbar. The drive subtitles are cut off.
- Privacy: the banner text ends in ".:" ("…to avoid conflicts.: Google Chrome"). "All Browsers (35)" counts entries, not browsers. The filter rows show scrollbars.
- Apps: the header tab "Leftover Hunter" wraps onto a second line.
- Startup: stat cards repeat their own title as the subtitle ("High Impact / High Impact").
- System Maintenance: "Run All Recommended Tasks" wraps inside its button. One stat card repeats the page title. "0 Executed" sits next to "All recommended maintenance tasks finished successfully." The badges say "8 / 10 recommended" but "7 Safe".
- Space Visualizer: the "GB" unit wraps onto its own line in the drive cards.
- Settings: "System Default" has the subtitle "OLED Night". "Check for Updates" has the description "Interface preferences and update configurations."
- Page widths differ: Startup, Maintenance and Optimizer use a wider container and a different header layout from the other pages.
