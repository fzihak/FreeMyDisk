import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface AppScanProgress {
  scanType: string;
  stage: string;
  percent: number;
  itemsScanned: number;
  currentPath: string;
  bytesFound: number;
  isComplete: boolean;
  lastUpdated: number;
}

export type ScanTypeKey =
  | "cleanup"
  | "large_files"
  | "duplicates"
  | "storage"
  | "heavy_folders"
  | "projects"
  | "disposal"
  | "privacy"
  | "rescue"
  | "recycle_bin";

interface ScanProgressStore {
  progressByScanType: Record<string, AppScanProgress>;
  activeScanType: string | null;
  isListening: boolean;
  updateProgress: (payload: Omit<AppScanProgress, "lastUpdated">) => void;
  resetProgress: (scanType?: string) => void;
  initProgressListener: () => Promise<UnlistenFn>;
}

const defaultProgress = (scanType: string): AppScanProgress => ({
  scanType,
  stage: "Initializing...",
  percent: 0,
  itemsScanned: 0,
  currentPath: "",
  bytesFound: 0,
  isComplete: false,
  lastUpdated: Date.now(),
});

let listenerPromise: Promise<void> | null = null;

export const useScanProgressStore = create<ScanProgressStore>((set, get) => ({
  progressByScanType: {},
  activeScanType: null,
  isListening: false,

  updateProgress: (payload) => {
    const item: AppScanProgress = {
      ...payload,
      lastUpdated: Date.now(),
    };
    set((state) => ({
      progressByScanType: {
        ...state.progressByScanType,
        [payload.scanType]: item,
      },
      activeScanType: payload.isComplete ? null : payload.scanType,
    }));
  },

  resetProgress: (scanType) => {
    if (scanType) {
      set((state) => ({
        progressByScanType: {
          ...state.progressByScanType,
          [scanType]: defaultProgress(scanType),
        },
        activeScanType: state.activeScanType === scanType ? null : state.activeScanType,
      }));
    } else {
      set({
        progressByScanType: {},
        activeScanType: null,
      });
    }
  },

  initProgressListener: async () => {
    // One app-wide subscription. Components share it and never tear it down, so a
    // page unmounting cannot stop progress updates for the rest of the app.
    if (!listenerPromise) {
      listenerPromise = listen<Omit<AppScanProgress, "lastUpdated">>("scan-progress", (event) => {
        if (event.payload && event.payload.scanType) {
          get().updateProgress(event.payload);
        }
      })
        .then(() => {
          set({ isListening: true });
        })
        .catch((err) => {
          listenerPromise = null;
          console.warn("Failed to attach scan-progress listener (non-Tauri environment?):", err);
        });
    }
    await listenerPromise;
    return () => {};
  },
}));

/**
 * Convenient React hook to get progress for a specific scan type
 */
export function useScanProgress(scanType: string): AppScanProgress {
  const progress = useScanProgressStore(
    (state) => state.progressByScanType[scanType]
  );
  return progress ?? defaultProgress(scanType);
}
