/** Facts used across the site. Keep them in sync with the app and README. */
export const SITE = {
  name: "FreeMyDisk",
  tagline: "Reclaim gigabytes on Windows — safely.",
  description:
    "FreeMyDisk is a free, open-source disk cleaner for Windows. Recycle-Bin-first cleaning, a crash-safe journal, 122 cleanup rules, large files and duplicates — built in Rust.",
  repo: "https://github.com/fzihak/FreeMyDisk",
  download: "https://github.com/fzihak/FreeMyDisk/releases/latest/download/FreeMyDisk-Setup-x64.exe",
  releases: "https://github.com/fzihak/FreeMyDisk/releases",
  version: "1.0.0",
  rules: 122,
  ogImage: "/media/social-preview.png",
};

export const formatDate = (d: Date) =>
  d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

/** Words per minute for reading-time estimates. */
export const readingMinutes = (text: string) =>
  Math.max(1, Math.round(text.split(/\s+/).filter(Boolean).length / 225));
