---
title: "How to free up disk space on your Windows laptop or PC"
description: "The complete, no-nonsense guide: where your gigabytes really went, what's safe to delete, what you should never touch, and the commands that reclaim the most space on Windows 10 and 11."
date: 2026-11-27
author: "FreeMyDisk Team"
tags: ["guide", "windows", "storage"]
featured: true
---

Your drive didn't fill up because of one big mistake. It filled up because of thousands of small, reasonable decisions made by the apps you use: a browser keeping yesterday's images, Windows keeping old update files "just in case", a game launcher caching shaders, a developer tool keeping every package version it ever downloaded.

Most of that data can be rebuilt automatically, so removing it costs you nothing. Some of it absolutely cannot. This guide walks through both — from the five-minute wins to the deep, technical cleanups — and tells you exactly what each step does, so you never have to delete something you don't understand.

> **Before you start** Make sure your important files are backed up. None of the steps below touch your documents, photos or projects, but a full drive is also a good moment to check that your backup actually works.

## 1. First, find out where the space went

Deleting things at random is how people lose files. Spend two minutes looking first.

### Use the built-in Storage page

Open **Settings → System → Storage**. Windows breaks your drive into categories: *Apps & features*, *Temporary files*, *Documents*, *Pictures*, *Other*, and so on. Click **Show more categories** to see all of them.

Two categories deserve special attention:

- **Temporary files** — usually the fastest win, covered in the next section.
- **Other** and **System & reserved** — big numbers here usually mean caches, hibernation, restore points or developer tools, all covered later in this guide.

### Look at a map of the drive, not a list

The Storage page tells you *categories*; a treemap tells you *folders*. In a treemap every rectangle is a folder or file, sized by how much space it uses, so the three or four folders responsible for most of your problem become obvious at a glance.

FreeMyDisk's **Space Visualizer** draws one for any drive or folder, and its **Large Files** tool lists the biggest individual files across every drive. If you prefer to stay in File Explorer, open a drive, type `size:gigantic` in the search box (files over 4 GB) or `size:huge` (1–4 GB), and sort by size.

## 2. The quick wins (about ten minutes)

These are safe for everyone and often free several gigabytes.

### Empty the Recycle Bin

Deleted files keep using space until the Recycle Bin is emptied. Right-click it on the desktop and choose **Empty Recycle Bin** — but have a quick look inside first, because this step *is* permanent.

A Recycle Bin that holds a few deleted folders can contain tens of thousands of files, which is why emptying it sometimes takes minutes: Windows removes every file one at a time.

### Clean temporary files with Windows itself

Go to **Settings → System → Storage → Temporary files**. Windows scans and shows a list with checkboxes. Generally safe to select:

| Item | What it is | Safe? |
| :--- | :--- | :--- |
| **Temporary files** | Leftovers apps were supposed to delete | ✅ |
| **Windows Update Cleanup** | Old versions of updated system files | ✅ (you can no longer uninstall those updates) |
| **Delivery Optimization Files** | Update pieces shared with other PCs | ✅ |
| **Thumbnails** | Preview images; rebuilt when you browse | ✅ |
| **DirectX Shader Cache** | Compiled graphics shaders; rebuilt by games | ✅ (first game launch may be slower) |
| **Previous Windows installation(s)** | `Windows.old` after a major upgrade | ✅ — but you lose the option to roll back |
| **Downloads** | Your actual Downloads folder | ⚠️ **Don't tick this blindly** |

That last row matters: the *Downloads* checkbox deletes your Downloads folder. Go through it by hand instead.

### Sort your Downloads folder by size

Open Downloads, switch to **Details** view, and sort by **Size**. Installers you've already run (`.exe`, `.msi`), ISO images and old ZIP archives are the usual suspects. Anything you can download again in a minute doesn't need to live on your drive.

## 3. The hidden giants

These items don't show up as "files you made", but they routinely take 10–40 GB.

### Hibernation file (`hiberfil.sys`)

When your PC hibernates, it writes the contents of memory to `C:\hiberfil.sys`. On Windows 10 and 11, the same file also powers **Fast Startup**. It is typically sized at a large fraction of your RAM — on a 32 GB laptop that can be 12 GB or more.

You have two choices, both from an administrator Command Prompt or Terminal:

```powershell
# Shrink it: keeps Fast Startup, removes full hibernation
powercfg /h /type reduced

# Remove it completely: disables hibernation AND Fast Startup
powercfg /hibernate off
```

If you never use **Hibernate** from the power menu, the reduced type is a good compromise. Turn it back on any time with `powercfg /hibernate on`.

### The page file (`pagefile.sys`)

You'll find a large `pagefile.sys` at the root of one or more drives. **Leave it alone.** It's Windows' virtual memory; deleting or disabling it can crash apps and stops Windows from writing crash dumps. If it's huge, the right fix is more RAM or letting Windows manage its size (**System → About → Advanced system settings → Performance → Advanced → Virtual memory**).

### System Restore points

Restore points are snapshots of system files that let you roll back a bad driver or update. They can quietly grow to 5–10% of your drive.

Check how much they use:

```powershell
vssadmin list shadowstorage
```

To cap them, open **Create a restore point** from the Start menu, select your drive, click **Configure**, and lower **Max Usage** to something like 3–5%. Keep restore points enabled — they're cheap insurance.

### Old Windows Update downloads

Windows keeps downloaded update packages in `C:\Windows\SoftwareDistribution\Download`. The Temporary files page usually cleans them, but if an update got stuck, this folder can stay large. To clear it manually from an administrator terminal:

```powershell
net stop wuauserv
net stop bits
Remove-Item "C:\Windows\SoftwareDistribution\Download\*" -Recurse -Force
net start bits
net start wuauserv
```

This only removes *downloaded packages*; Windows will download whatever it still needs.

### The component store (`WinSxS`)

`C:\Windows\WinSxS` looks enormous in File Explorer, but much of that size is counted twice because of hard links. **Never delete anything in it by hand** — that breaks Windows Update and can make the system unbootable. Let Windows trim it:

```powershell
# See how much can actually be reclaimed
Dism.exe /Online /Cleanup-Image /AnalyzeComponentStore

# Remove superseded components
Dism.exe /Online /Cleanup-Image /StartComponentCleanup
```

There's also a `/ResetBase` option that frees a bit more, but it makes every installed update permanent (you can't uninstall them afterwards). Only use it if you understand that trade-off.

### Crash dumps and error reports

When Windows or an app crashes, it can leave memory dumps behind: `C:\Windows\MEMORY.DMP` (sometimes many gigabytes), `C:\Windows\Minidump`, and per-app dumps in `%LOCALAPPDATA%\CrashDumps`. Error reports pile up in `%PROGRAMDATA%\Microsoft\Windows\WER`. Unless you're actively troubleshooting a crash, these are safe to remove.

## 4. App caches: the silent majority

Almost every modern app keeps a cache. Each one is small; together they add up fast.

### Browsers

Chrome, Edge, Firefox and Brave keep image and script caches, code caches and GPU shader caches — often 1–3 GB each, per profile. Clear them from the browser itself: **Settings → Privacy → Clear browsing data**, choose *Cached images and files*, and pick a time range.

Be deliberate about the other checkboxes: clearing **cookies** signs you out of websites, and clearing **history** removes your autocomplete. If you only want space back, the cache alone is enough.

### Chat, music and meeting apps

Microsoft Teams, Slack, Discord, Spotify and WhatsApp Desktop are built on Electron or similar frameworks and each keep their own browser-style caches, sometimes several gigabytes. Most offer a *Clear cache* option in their settings; otherwise, quitting the app and clearing its `Cache`, `Code Cache` and `GPUCache` folders under `%APPDATA%` is safe.

> **Rule of thumb** Delete *caches*, never *data*. A folder called `Cache` will be rebuilt. A folder called `Local Storage`, `IndexedDB` or `Sessions` holds things you'll miss, like logins and offline messages.

### Games and launchers

Steam, Epic, Battle.net and the EA app keep download caches and shader caches. Steam can clear its download cache in **Settings → Downloads → Clear Download Cache**. The biggest wins, though, are games you no longer play — sort your library by size and uninstall from the launcher.

## 5. For developers: the biggest offenders

If you write code, developer caches are very likely your largest reclaimable category. All of the following are rebuilt on demand.

```powershell
npm cache clean --force           # npm
pnpm store prune                  # pnpm: removes packages no project uses
yarn cache clean                  # Yarn
dotnet nuget locals all --clear   # NuGet
pip cache purge                   # Python
gradle --stop                     # stop daemons before clearing %USERPROFILE%\.gradle\caches
```

And don't forget the build output inside your projects: old `node_modules`, Rust `target`, `.gradle` and `build` folders in projects you haven't opened in months. Each can be hundreds of megabytes, and they come back with a single install or build command. FreeMyDisk's **Developer Projects** view finds these across your drives and shows which projects have been dormant the longest.

### Docker and WSL

Docker Desktop's disk usage hides inside a virtual disk, so deleting images doesn't always give space back to Windows. First, see what Docker is using, then clean:

```powershell
docker system df          # what's using space
docker builder prune      # build cache (usually the biggest)
docker image prune -a     # images not used by any container
```

WSL 2 distributions live in a virtual disk (`ext4.vhdx`) that grows but never shrinks on its own. After cleaning files *inside* Linux, shut WSL down and compact the disk. On recent WSL versions you can make it shrink automatically:

```powershell
wsl --shutdown
wsl --manage <DistroName> --set-sparse true
```

### AI models

Local AI tools download models that are several gigabytes each. Hugging Face caches them under `%USERPROFILE%\.cache\huggingface`; review and remove old ones with `huggingface-cli delete-cache`. For Ollama, `ollama list` shows what you have and `ollama rm <model>` removes one.

## 6. Large files and duplicates

After caches, the next big category is usually *your own* files — things you forgot you had.

- **Large files:** video exports, disk images, old backups, virtual machine disks. Sort by size and ask of each: *do I still need this here, or could it live on an external drive or in the cloud?*
- **Duplicates:** the same photo imported twice, the same installer downloaded three times, a project copied "just in case". A good duplicate finder compares file *contents*, not names — two files called `IMG_0001.jpg` are often different photos.

> **Careful** Always keep at least one copy of anything you delete as a duplicate, and be wary of duplicates inside program or system folders — apps sometimes rely on identical files in different places.

## 7. Apps you don't use

Open **Settings → Apps → Installed apps** and sort by **Size**. Uninstall what you don't recognise *after* searching its name, and what you haven't opened in months. Many apps leave folders behind in `%APPDATA%`, `%LOCALAPPDATA%` and `C:\ProgramData` after uninstalling; those leftovers are safe to remove once the app is gone.

## 8. Let the cloud hold what you rarely open

If you use OneDrive, turn on **Files On-Demand**. Right-click a folder you rarely open and choose **Free up space**: the files stay visible in File Explorer but are downloaded only when you open them. It's the single biggest win for photo and video libraries.

## 9. Make it automatic

Windows has a built-in janitor called **Storage Sense** (**Settings → System → Storage → Storage Sense**). It can delete temporary files, empty the Recycle Bin after a set number of days, and make unused OneDrive files online-only. Turn it on and set the Recycle Bin period to 30 days — you'll rarely run out of space unexpectedly again.

## 10. What you should never delete

When a guide, forum post or "optimizer" suggests deleting any of these, close the tab.

| Never delete | Why |
| :--- | :--- |
| `C:\Windows\System32`, `C:\Windows\SysWOW64` | Core of Windows. The PC won't boot. |
| `C:\Windows\WinSxS` (by hand) | Breaks updates and repairs. Use DISM instead. |
| `C:\Windows\Installer` | Needed to repair or uninstall software. |
| `pagefile.sys` | Virtual memory; apps crash without it. |
| `C:\Program Files`, `C:\Program Files (x86)` | Uninstall apps properly instead. |
| The whole `AppData` folder | Holds settings, logins and data for every app. Clean specific `Cache` folders only. |
| `C:\ProgramData` (in bulk) | Shared app data and licences. |
| Registry "cleaners" | Gain almost no space and can break apps. |

## How FreeMyDisk does all of this

We built FreeMyDisk because doing the steps above by hand is slow and easy to get wrong. It knows where 122 apps and Windows components keep data they can rebuild, and it applies the same caution this guide does:

- everything goes to the **Recycle Bin** by default;
- every deletion is written to a **crash-safe journal** before anything is touched;
- system folders, files in use and anything changed in the last 24 hours are **left alone**;
- it tells you when something needs administrator rights or a closed app, instead of silently failing.

It's free and open source. If it helps you, the [source is on GitHub](https://github.com/fzihak/FreeMyDisk) — and pull requests that teach it about more apps are very welcome.

## FAQ

### How much free space should I keep?

Aim for at least 10–15% of the drive. Windows needs room for updates, the page file and temporary files, and SSDs perform best when they aren't completely full.

### Is it safe to delete everything in the Temp folder?

Mostly, but not while apps are running — an installer might be using its temp files right now. The safest approach is to skip files modified in the last day, which is exactly what Windows' own cleanup and FreeMyDisk do.

### Will clearing caches make my PC faster?

Not directly. Caches exist to make things *faster*; clearing them frees space, and the first launch of each app afterwards may be slightly slower while it rebuilds. The real speed benefit comes from not running out of space.

### Why didn't my free space go up after deleting files?

Three common reasons: the files went to the **Recycle Bin** (empty it), they were inside a **virtual disk** (Docker or WSL — compact it), or a **restore point** still references them (they'll be freed when the restore point ages out).

### Are "PC cleaner" apps safe?

Some are, many aren't. Be wary of anything that promises speed boosts from registry cleaning, shows scary numbers of "problems", or won't say exactly what it's going to delete. A good tool tells you what each item is, lets you review it first, and can undo its work.
