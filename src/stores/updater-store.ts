import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * In-app updates.
 *
 * Flow: the app checks GitHub's `latest.json` shortly after start and then every
 * few hours. When a newer version exists, a banner offers it; the user opens the
 * details dialog and chooses "Update and restart". The installer is downloaded
 * (its signature is verified by the updater against the public key built into
 * the app), installed in passive mode, and FreeMyDisk restarts on the new
 * version. Nothing is downloaded without the user's click.
 */

export type UpdateStatus =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "installing"
  | "error";

/** Hours between automatic checks while the app stays open. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** First automatic check waits until start-up work has settled. */
const FIRST_CHECK_DELAY_MS = 8_000;
const SKIP_KEY = "fmd.update.skippedVersion";

// The Update handle from the last successful check, reused for the download so
// the user installs exactly the release they were shown.
let pending: Update | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

const readSkipped = (): string | null => {
  try {
    return localStorage.getItem(SKIP_KEY);
  } catch {
    return null;
  }
};

interface UpdaterState {
  status: UpdateStatus;
  /** Latest version offered by the server, e.g. "1.1.0". */
  version: string;
  releaseNotes: string;
  releaseDate: string | null;
  downloadedBytes: number;
  totalBytes: number;
  /** 0–100 while downloading. */
  downloadProgress: number;
  errorMessage: string | null;
  lastCheckedAt: number | null;
  /** The banner was closed for this session ("Later"). */
  dismissedThisSession: boolean;
  dialogOpen: boolean;

  // Compatibility helpers used by older components and tests.
  updateAvailable: boolean;
  isChecking: boolean;
  isDownloading: boolean;
  updateReady: boolean;

  checkForUpdates: (autoTriggered?: boolean) => Promise<void>;
  startAutomaticChecks: () => () => void;
  openDialog: () => void;
  closeDialog: () => void;
  dismissBanner: () => void;
  skipThisVersion: () => void;
  downloadAndInstall: () => Promise<void>;
  restartApp: () => Promise<void>;
}

export const useUpdaterStore = create<UpdaterState>((set, get) => {
  /** Applies a status and keeps the compatibility flags in step. */
  const setStatus = (status: UpdateStatus, extra: Partial<UpdaterState> = {}) =>
    set({
      status,
      updateAvailable: ["available", "downloading", "installing"].includes(status),
      isChecking: status === "checking",
      isDownloading: status === "downloading",
      updateReady: status === "installing",
      ...extra,
    });

  return {
    status: "idle",
    version: "",
    releaseNotes: "",
    releaseDate: null,
    downloadedBytes: 0,
    totalBytes: 0,
    downloadProgress: 0,
    errorMessage: null,
    lastCheckedAt: null,
    dismissedThisSession: false,
    dialogOpen: false,
    updateAvailable: false,
    isChecking: false,
    isDownloading: false,
    updateReady: false,

    checkForUpdates: async (autoTriggered = true) => {
      const { status } = get();
      if (status === "checking" || status === "downloading" || status === "installing") return;
      setStatus("checking", { errorMessage: null });
      try {
        const update = await check();
        const now = Date.now();
        if (update && (update as Update & { available?: boolean }).available !== false) {
          pending = update;
          const skipped = autoTriggered && readSkipped() === update.version;
          setStatus(skipped ? "idle" : "available", {
            version: update.version,
            releaseNotes: update.body?.trim() || "Bug fixes and performance improvements.",
            releaseDate: update.date ?? null,
            lastCheckedAt: now,
            // A manual check always shows what it found.
            dismissedThisSession: autoTriggered ? get().dismissedThisSession : false,
            dialogOpen: autoTriggered ? get().dialogOpen : true,
          });
        } else {
          pending = null;
          setStatus(autoTriggered ? "idle" : "upToDate", { lastCheckedAt: now, dialogOpen: !autoTriggered });
        }
      } catch (e) {
        // Automatic checks fail silently (offline, GitHub down); manual checks say why.
        setStatus(autoTriggered ? "idle" : "error", {
          errorMessage: autoTriggered ? null : errorText(e, "Could not check for updates."),
        });
      }
    },

    startAutomaticChecks: () => {
      const first = setTimeout(() => get().checkForUpdates(true), FIRST_CHECK_DELAY_MS);
      if (timer) clearInterval(timer);
      timer = setInterval(() => get().checkForUpdates(true), CHECK_INTERVAL_MS);
      return () => {
        clearTimeout(first);
        if (timer) clearInterval(timer);
        timer = null;
      };
    },

    openDialog: () => set({ dialogOpen: true }),
    closeDialog: () => {
      // Closing the dialog never interrupts a running download or install.
      set({ dialogOpen: false });
    },

    dismissBanner: () => set({ dismissedThisSession: true, dialogOpen: false }),

    skipThisVersion: () => {
      try {
        localStorage.setItem(SKIP_KEY, get().version);
      } catch {
        /* storage unavailable: behaves like "Later" */
      }
      set({ dismissedThisSession: true, dialogOpen: false });
    },

    downloadAndInstall: async () => {
      const { status } = get();
      if (status === "downloading" || status === "installing") return;
      setStatus("downloading", { downloadedBytes: 0, totalBytes: 0, downloadProgress: 0, errorMessage: null });
      try {
        const update = pending ?? (await check());
        if (!update) {
          setStatus("upToDate");
          return;
        }
        pending = update;
        let downloaded = 0;
        // download() verifies the installer's signature before it returns.
        await update.download((event) => {
          if (event.event === "Started") {
            set({ totalBytes: event.data.contentLength ?? 0 });
          } else if (event.event === "Progress") {
            downloaded += event.data.chunkLength;
            const total = get().totalBytes;
            set({
              downloadedBytes: downloaded,
              downloadProgress: total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0,
            });
          }
        });
        setStatus("installing", { downloadProgress: 100 });
        // On Windows the installer closes FreeMyDisk, updates it and starts it again.
        await update.install();
        await relaunch();
      } catch (e) {
        setStatus("error", { errorMessage: errorText(e, "The update could not be installed.") });
      }
    },

    restartApp: async () => {
      try {
        await relaunch();
      } catch (e) {
        set({ errorMessage: errorText(e, "Failed to restart. Please restart FreeMyDisk manually.") });
      }
    },
  };
});

function errorText(e: unknown, fallback: string): string {
  if (typeof e === "string" && e.trim()) return e;
  if (e && typeof e === "object" && "message" in e && typeof (e as Error).message === "string") {
    return (e as Error).message || fallback;
  }
  return fallback;
}
