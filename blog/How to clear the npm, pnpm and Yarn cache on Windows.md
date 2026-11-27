---
title: "How to clear the npm, pnpm and Yarn cache on Windows"
description: "JavaScript package managers keep a copy of every package you have ever installed. Here is where those caches live on Windows, how big they get, and the safe commands that shrink them."
date: 2026-11-27
author: "FreeMyDisk Team"
tags: ["guide", "developers", "windows"]
---

Every time you run `npm install`, `pnpm install` or `yarn`, the package manager keeps a copy of each downloaded package in a cache, so the next install is faster. The cache is never cleaned up on its own. After a year of side projects it is common to find 5–20 GB of old package versions you will never use again.

All of these caches are **safe to clear**. Nothing in your projects is deleted: the next install simply downloads what it needs again.

> **Before you start** Close your editor and stop any running `dev` servers. A package manager that is writing to its cache while you clean it can leave a half-written entry behind.

## Find out how much space they use

Run this in PowerShell to see the size of every cache in one go:

```powershell
$paths = @(
  "$env:LOCALAPPDATA\npm-cache",
  "$env:LOCALAPPDATA\pnpm\store",
  "$env:LOCALAPPDATA\Yarn\Cache",
  "$env:LOCALAPPDATA\Yarn\Berry\cache"
)
foreach ($p in $paths) {
  if (Test-Path $p) {
    $gb = (Get-ChildItem $p -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1GB
    "{0,8:N2} GB  {1}" -f $gb, $p
  }
}
```

The paths above are the defaults. If you changed them, ask the tool itself, as shown in each section below.

## npm

npm keeps its cache in `%LocalAppData%\npm-cache`. To confirm the location on your machine:

```powershell
npm config get cache
```

To check the cache and remove anything that is corrupted or no longer needed:

```powershell
npm cache verify
```

To empty it completely:

```powershell
npm cache clean --force
```

npm asks for `--force` only because it wants you to know the next install will be slower. Clearing the cache does not touch `node_modules` in any project.

## pnpm

pnpm works differently: it keeps one **content-addressable store**, and every project's `node_modules` links into it. That is why pnpm uses so little space per project.

Find the store:

```powershell
pnpm store path
```

Remove every package that no project on this machine references any more:

```powershell
pnpm store prune
```

This is the right command for pnpm. It only removes packages that are not linked from any project, so your existing projects keep working without a reinstall.

> **Good to know** You can also empty the whole store. Existing projects keep working, because on the same drive their files are hard links to the store, but pnpm downloads every package again on the next install. `pnpm store prune` frees the same unused space without that cost.

## Yarn

The command depends on which Yarn you use. Check with `yarn --version`.

### Yarn 1 (classic)

```powershell
yarn cache dir      # shows where the cache is
yarn cache clean    # empties it
```

### Yarn 2 and later (Berry)

Modern Yarn keeps a per-project cache in `.yarn/cache` and can also keep a global one. To clear both for the current project:

```powershell
yarn cache clean --all
```

If your project uses **Zero-Installs** (the `.yarn/cache` folder is committed to Git), leave that folder alone. It belongs to the repository, not to your machine.

## What not to delete

| Folder | Why |
| --- | --- |
| `node_modules` in a project you are working on | Your project needs it to run; reinstalling takes time |
| `.yarn/cache` in a Zero-Installs repository | It is part of the repository |
| `%AppData%\npm` | Your globally installed command-line tools live here, not the cache |

## Do it in one click

FreeMyDisk has cleanup rules for the npm, pnpm and Yarn 1 caches in their default locations. Its Deep Cleanup page shows how big each one is, and moves the contents to the Recycle Bin instead of deleting them, so you can still undo it.

## Summary

- Package manager caches only make installs faster. Clearing them is safe.
- npm: `npm cache clean --force`.
- pnpm: `pnpm store prune` removes only what no project uses.
- Yarn 1: `yarn cache clean`. Yarn 2 and later: `yarn cache clean --all`.
