# Contributing to FreeMyDisk

First of all — thank you. FreeMyDisk exists to give everyone a disk cleaner they can actually trust, and that only works if it's built in the open, by the people who use it.

**You don't need to write Rust to make a real difference.** Using the app and telling us what broke, suggesting the cache of an app you use, fixing a translation or improving these docs are all valued contributions.

<table>
<tr><td>

**Contents**

1. [Ways to contribute](#1-ways-to-contribute)
2. [Your first contribution](#2-your-first-contribution)
3. [Ground rules](#3-ground-rules)
4. [Development setup](#4-development-setup)
5. [Project layout](#5-project-layout)
6. [The safety rules (non-negotiable)](#6-the-safety-rules-non-negotiable)
7. [Coding standards](#7-coding-standards)
8. [Adding a cleanup rule](#8-adding-a-cleanup-rule)
9. [Translations](#9-translations)
10. [Commits and sign-off](#10-commits-and-sign-off)
11. [Pull requests](#11-pull-requests)
12. [Reporting bugs and ideas](#12-reporting-bugs-and-ideas)
13. [Security issues](#13-security-issues)
14. [Recognition](#14-recognition)

</td></tr>
</table>

---

## 1. Ways to contribute

| You can… | How | Skills needed |
| :--- | :--- | :--- |
| 🧪 **Use it and report problems** | Run FreeMyDisk on your PC, then [open a bug report](https://github.com/fzihak/FreeMyDisk/issues/new?template=bug_report.yml) with what you did and what happened. | None |
| 💡 **Share ideas and feedback** | Something confusing, slow or missing? [Suggest a feature](https://github.com/fzihak/FreeMyDisk/issues/new?template=feature_request.yml). | None |
| 🧩 **Request or write a cleanup rule** | Tell us which app's cache we should clean ([rule request](https://github.com/fzihak/FreeMyDisk/issues/new?template=cleanup_rule.yml)), or write the rule yourself — it's ~20 lines of TOML. | Basic |
| 🌍 **Translate** | Improve one of the 9 included languages, or add a new one. | Basic |
| 📝 **Improve docs** | README, this guide, code comments, screenshots. | Basic |
| 🦀 **Write code** | Fix a bug or build a feature in Rust (engine) or React/TypeScript (UI). | Rust or TS |
| 👀 **Review and triage** | Reproduce reported bugs, test pull requests, help other users in issues. | Any |
| 🔐 **Find security issues** | Report privately — see [Security issues](#13-security-issues). | Security |

---

## 2. Your first contribution

1. Look for issues labelled [`good first issue`](https://github.com/fzihak/FreeMyDisk/labels/good%20first%20issue) or [`help wanted`](https://github.com/fzihak/FreeMyDisk/labels/help%20wanted).
2. Comment *"I'd like to work on this"* so nobody duplicates your effort. A maintainer will assign it to you.
3. Not sure where to start? A **cleanup rule** for an app you use every day is the perfect first PR — see [section 8](#8-adding-a-cleanup-rule).
4. Stuck? Ask in the issue. There are no silly questions here.

> **Before a large change** (a new tool, a new dependency, a UI redesign, anything touching deletion logic), open an issue first and describe the plan. It saves you from building something that can't be merged.

---

## 3. Ground rules

- **Be kind.** Everyone here follows our [Code of Conduct](CODE_OF_CONDUCT.md).
- **Safety beats features.** A cleaner that deletes the wrong file once has failed forever. Read [section 6](#6-the-safety-rules-non-negotiable) before you touch anything that removes files.
- **Privacy is a feature.** No telemetry, no analytics, no accounts, and no network requests except the user-approved update check. PRs that add any of these will not be merged.
- **Real code only.** No placeholder functions, `todo!()`, `unimplemented!()` or mock UI in `main`.
- **Tested before merged.** Behaviour changes come with tests.

---

## 4. Development setup

### Prerequisites

| Tool | Version | Notes |
| :--- | :--- | :--- |
| Windows | 10 or 11, 64-bit | The app targets Windows only for now. |
| [Rust](https://rustup.rs) | stable (≥ 1.85) | `rustup component add clippy rustfmt` |
| [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) | 2022 | "Desktop development with C++" workload |
| [Node.js](https://nodejs.org) | 20 LTS or newer | |
| [pnpm](https://pnpm.io/installation) | 9 or newer | `npm install -g pnpm` |

### Get running

```powershell
git clone https://github.com/<your-username>/FreeMyDisk.git
cd FreeMyDisk
pnpm install
pnpm tauri dev        # starts the app with hot reload for the UI
```

The first build compiles the Rust workspace and takes a few minutes; after that, UI changes appear instantly and Rust changes rebuild in seconds.

### Everyday commands

| Task | Command |
| :--- | :--- |
| Run the app | `pnpm tauri dev` |
| Rust tests | `cargo test --workspace` |
| Rust lint (must be clean) | `cargo clippy --workspace --all-targets -- -D warnings` |
| Rust format | `cargo fmt --all` |
| UI tests | `pnpm test` |
| UI type check | `npx tsc --noEmit` |
| UI production build | `pnpm build` |
| Try the CLI | `cargo run -p freemydisk-cli -- scan --category browser` |
| Build the installer | `pnpm build:bundle` |

> 💡 **Safe testing:** use `freemydisk-cli clean --dry-run` to see exactly what a cleanup would do without touching anything. When testing deletion in the app, keep **Settings → Always route to Recycle Bin** turned on.

---

## 5. Project layout

```
FreeMyDisk/
├─ src/                          React 19 + TypeScript UI
│  ├─ pages/                     One file per screen (Dashboard, Deep Cleanup, …)
│  ├─ components/ui/             Shared UI kit (PageHeader, Card, StatCard, …)
│  ├─ stores/                    Zustand stores (scan cache, settings, updater, …)
│  ├─ i18n/                      Translations: types.ts + locales/*.ts
│  └─ test/                      Vitest + Testing Library
├─ src-tauri/
│  ├─ src/lib.rs                 Tauri commands (the UI ↔ engine boundary)
│  ├─ crates/freemydisk-core/    The engine: rules, planner, disposal, journal, scanners
│  │  ├─ rules/                  Built-in cleanup rules (TOML)
│  │  └─ tests/                  Integration tests
│  ├─ crates/freemydisk-platform/ Windows APIs (Recycle Bin, processes, registry, …)
│  ├─ crates/freemydisk-cli/     The command-line tool
│  └─ helpers/freemydisk-elevated/ Allow-listed admin helper (runs behind UAC)
├─ docs/                         Media and reports
└─ .github/                      CI, release workflow, issue templates
```

---

## 6. The safety rules (non-negotiable)

These protect people's files. A PR that weakens any of them will be closed, however good the rest is.

1. **Recycle Bin first.** User-facing deletions go to the Recycle Bin by default. If that fails, keep the file and report it — **never** fall back to permanent deletion silently.
2. **Journal before you delete.** Every removal goes through `DisposalEngine`, which records it in the crash-recovery journal *before* touching the disk. Don't call `std::fs::remove_*` on user data directly.
3. **Respect protected paths.** Never bypass `ProtectedPathRegistry`. Never offer system files (`pagefile.sys`, `hiberfil.sys`, …), Windows, Program Files or app data folders for deletion.
4. **Leave things in use alone.** Skip files a running process has open, and declare `locking_processes` in rules.
5. **Least privilege.** The app runs as a normal user. Anything that needs admin is a new, validated operation in `freemydisk-elevated` — never a generic "run this command as admin".
6. **Ask before acting.** Destructive actions need an explicit user click, with a clear description of what will happen. Anything permanent says so.
7. **Measure honestly.** Never count bytes that won't actually be freed (hard links, locked files, admin-only items).
8. **No network.** The update check is the only network request.

---

## 7. Coding standards

### Rust

- `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings` must both be clean — CI enforces it.
- Return errors (`CoreError` / `PlatformError`); don't `unwrap()` or `expect()` on anything that depends on the file system, the user or the OS.
- Long-running work runs off the UI thread (`spawn_blocking`) and reports progress through the existing `scan-progress` events.
- Windows-only code is behind `#[cfg(target_os = "windows")]`.
- Every behaviour change gets a test in `crates/*/tests/` or a `#[cfg(test)]` module. Tests use `tempfile` directories — **never** real user folders.

### TypeScript / React

- `npx tsc --noEmit` and `pnpm test` must pass.
- Build screens from the shared kit in `src/components/ui` and the `WinUI*` components; use the colour tokens from `src/index.css` (`var(--accent)`, `var(--text-secondary)`, …) — no hard-coded colours.
- Every user-visible string goes through i18n (`t.section.key`) and is added to `src/i18n/types.ts` and **all** locale files (English text is fine in locales you can't translate).
- Never call Tauri commands that delete or modify things without a confirmation path in the UI.
- Check your change in **dark, light and OLED** themes and at the default window size (1150 × 760).

---

## 8. Adding a cleanup rule

Rules live in [`src-tauri/crates/freemydisk-core/rules/filesystem/windows/<category>/`](src-tauri/crates/freemydisk-core/rules/filesystem/windows) — one TOML file per app. Categories: `ai`, `application`, `browser`, `container`, `development`, `system`.

```toml
[rule]
id = "windows_application_spotify_cache"      # unique: windows_<category>_<app>_<what>
name = "Spotify Media & Storage Cache"
category = "application"
risk = "safe"                                 # safe · low · moderate · medium
verified_rebuildable = true                   # the app recreates this data by itself
verified_at = "2026-08-15"                    # date you verified it
author = "Your Name"
description = "Cached streamed audio chunks and offline artwork stored by Spotify"
platform = "windows"
locking_processes = ["spotify.exe"]           # skipped while these are running

[applicability]
conditions = [{ type = "path_exists", path = "${local_app_data}/Spotify/Data" }]

[targets]
paths = [{ path = "${local_app_data}/Spotify/Data/*", matcher = "glob" }]
# min_age_hours = 24                          # optional: keep recently changed files

[disposal]
default_action = "permanent"                  # "trash" for anything the user might miss
protect_subpaths = ["*/Users/*"]              # never touch these, even if matched
```

**Path variables:** `${local_app_data}`, `${app_data}`, `${program_data}`, `${user_profile}` / `${home}`, `${temp}`, `${win_dir}`.

**A good rule…**

- targets data the app **rebuilds automatically** (caches, logs, temp, crash dumps) — never documents, saves, settings, sessions or downloads;
- is as **narrow** as possible: prefer `App/Cache/*` over `App/*`;
- lists the app's processes in `locking_processes`;
- uses `risk = "safe"` only when deleting it has no visible effect except a slower first start.

**Test it before you open the PR:**

```powershell
# point the CLI at a folder holding just your new rule
cargo run -p freemydisk-cli -- scan --rules-path .\my-rules
cargo run -p freemydisk-cli -- clean --dry-run --category application
```

Then run `cargo test -p freemydisk-core --test rules_test`, which validates every built-in rule.

---

## 9. Translations

1. Open `src/i18n/locales/<lang>.ts` (e.g. `bn.ts`, `de.ts`). The keys mirror `en.ts`.
2. Translate values only — never keys or `{placeholders}`.
3. Keep it short: buttons and labels have limited space. Check the result in the app.
4. To add a language, copy `en.ts`, translate it, register it in `src/i18n/index.ts`, and open a PR.

---

## 10. Commits and sign-off

We use [Conventional Commits](https://www.conventionalcommits.org):

```
feat(rules): add Figma desktop cache
fix(duplicates): never select every copy in a group
docs(readme): explain the CLI dry run
```

Types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `ci`, `chore`. Write the subject in the imperative mood and explain the **why** in the body.

**Every commit needs a Developer Certificate of Origin sign-off.** It certifies that you wrote the change (or have the right to submit it) under the project's license — see the full text at [developercertificate.org](https://developercertificate.org). Just add `-s`:

```powershell
git commit -s -m "feat(rules): add Figma desktop cache"
```

This adds `Signed-off-by: Your Name <you@example.com>`. Forgot it? `git commit --amend -s` (last commit) or `git rebase --signoff main` (all commits on your branch).

---

## 11. Pull requests

1. Fork the repo and create a branch from `main`: `git checkout -b fix/duplicate-selection`.
2. Keep the PR **focused** — one fix or feature per PR. Small PRs get reviewed fast.
3. Run the checks locally (fmt, clippy, tests, tsc). CI runs them again on Windows.
4. Fill in the pull request template: what changed, why, how you tested it. **UI changes need before/after screenshots.**
5. A maintainer reviews within a few days. Expect questions — it's how we keep the safety bar high, not a judgement of you.
6. When it's approved and green, a maintainer merges it. 🎉

<details>
<summary><b>What reviewers look for</b></summary>
<br />

- Does it keep every [safety rule](#6-the-safety-rules-non-negotiable)?
- Is it tested, and do the tests use temp folders?
- Does the UI follow the design system and work in all three themes?
- Are all new strings translated (or at least present) in every locale?
- Is it the simplest change that solves the problem?

</details>

---

## 12. Reporting bugs and ideas

- **Bug:** use the [bug report form](https://github.com/fzihak/FreeMyDisk/issues/new?template=bug_report.yml). The FreeMyDisk version (Settings → About), your Windows version and exact steps help the most. Please blur personal file names in screenshots.
- **Idea or feedback:** use the [feature request form](https://github.com/fzihak/FreeMyDisk/issues/new?template=feature_request.yml) and describe the problem you want solved, not only the solution.
- **App cache to support:** use the [cleanup rule request form](https://github.com/fzihak/FreeMyDisk/issues/new?template=cleanup_rule.yml).

Search existing issues first — a 👍 on an existing issue helps us prioritise.

---

## 13. Security issues

**Please do not open a public issue for security problems.** Report them privately as described in [SECURITY.md](SECURITY.md). We respond quickly and credit reporters.

---

## 14. Recognition

Every merged contribution — code, rules, translations, docs or a well-reproduced bug — is credited in the release notes. Significant contributors are invited to help maintain the project.

By contributing, you agree that your contributions are licensed under the [GPL-3.0](LICENSE). The FreeMyDisk name and logo are covered by [TRADEMARK.md](TRADEMARK.md).

**Thank you for helping people get their disk space back — safely.** 💙
