import { create } from "zustand";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

interface UpdaterState {
  updateAvailable: boolean;
  version: string;
  releaseNotes: string;
  dismissedThisSession: boolean;
  isChecking: boolean;
  isDownloading: boolean;
  downloadProgress: number;
  updateReady: boolean;
  errorMessage: string | null;

  checkForUpdates: (autoTriggered?: boolean) => Promise<void>;
  dismissBanner: () => void;
  downloadAndInstall: () => Promise<void>;
  restartApp: () => Promise<void>;
}

export const useUpdaterStore = create<UpdaterState>((set) => ({
  updateAvailable: false,
  version: "",
  releaseNotes: "",
  dismissedThisSession: false,
  isChecking: false,
  isDownloading: false,
  downloadProgress: 0,
  updateReady: false,
  errorMessage: null,

  checkForUpdates: async (autoTriggered = true) => {
    set({ isChecking: true });
    try {
      const update = await check();
      if (update && update.available) {
        set({
          updateAvailable: true,
          version: update.version,
          releaseNotes: update.body || "Bug fixes and performance improvements.",
          isChecking: false,
          // Never persist dismiss across launches; kept strictly in-memory
        });
      } else {
        set({ isChecking: false });
        if (!autoTriggered) {
          // Manual checks can log, but automatic checks are 100% silent
        }
      }
    } catch {
      set({ isChecking: false });
      // Per Section 12.2 & 15.4: Fail 100% silently — no toast, no error dialog.
      // The user should never see a failed-update-check error on startup.
    }
  },

  dismissBanner: () => {
    // Dismiss behavior: Hides banner for current session only.
    // Reappears on next launch if still un-updated.
    set({ dismissedThisSession: true });
  },

  downloadAndInstall: async () => {
    try {
      set({ isDownloading: true, downloadProgress: 0, errorMessage: null });
      const update = await check();
      if (!update || !update.available) {
        set({ isDownloading: false });
        return;
      }

      let downloaded = 0;
      let contentLength = 0;

      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            contentLength = event.data.contentLength || 0;
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            if (contentLength > 0) {
              set({ downloadProgress: Math.min(100, Math.round((downloaded / contentLength) * 100)) });
            }
            break;
          case "Finished":
            set({ downloadProgress: 100, updateReady: true, isDownloading: false });
            break;
        }
      });
    } catch (e: any) {
      set({
        isDownloading: false,
        errorMessage: e?.message || "Failed to download signed update.",
      });
    }
  },

  restartApp: async () => {
    try {
      await relaunch();
    } catch (e: any) {
      set({ errorMessage: e?.message || "Failed to restart. Please restart FreeMyDisk manually." });
    }
  },
}));
