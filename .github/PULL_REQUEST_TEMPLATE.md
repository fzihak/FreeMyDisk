## What does this change?

<!-- One or two sentences. Link the issue it fixes: "Fixes #123". -->

## Why?

<!-- The problem it solves for people using FreeMyDisk. -->

## How did you test it?

<!-- Commands you ran, what you clicked, which Windows version. -->

## Screenshots

<!-- UI changes: before / after, in dark and light theme. Delete if not a UI change. -->

## Checklist

- [ ] `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings` are clean
- [ ] `cargo test --workspace` and `pnpm test` pass
- [ ] `npx tsc --noEmit` passes (if UI changed)
- [ ] New user-visible text is added to **all** locale files
- [ ] Nothing here weakens a [safety rule](../CONTRIBUTING.md#6-the-safety-rules-non-negotiable) (Recycle Bin first, journal, protected paths, no network)
- [ ] Tests for new behaviour use temp folders, never real user data
- [ ] Commits are signed off (`git commit -s`)
