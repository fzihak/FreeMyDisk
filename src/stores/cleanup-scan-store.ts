import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { RuleScanSummary } from "@/types/cleanup";

/** Results older than this are re-scanned when a page opens. */
const MAX_AGE_MS = 10 * 60 * 1000;

interface CleanupScanState {
  summaries: RuleScanSummary[] | null;
  scannedAt: number | null;
  /** Runs a cleanup-rule scan. Concurrent callers share one scan. */
  scan: () => Promise<RuleScanSummary[]>;
  /** Last results if they are recent enough to reuse, otherwise null. */
  fresh: () => RuleScanSummary[] | null;
}

let inFlight: Promise<RuleScanSummary[]> | null = null;

/**
 * Cleanup scan results shared by the Dashboard and Cleanup pages, so opening a
 * page reuses a recent scan instead of walking every rule again.
 */
export const useCleanupScanStore = create<CleanupScanState>((set, get) => ({
  summaries: null,
  scannedAt: null,

  scan: () => {
    if (!inFlight) {
      inFlight = invoke<RuleScanSummary[]>("scan_cleanup_rules")
        .then((summaries) => {
          set({ summaries, scannedAt: Date.now() });
          return summaries;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  },

  fresh: () => {
    const { summaries, scannedAt } = get();
    if (!summaries || scannedAt === null) return null;
    return Date.now() - scannedAt < MAX_AGE_MS ? summaries : null;
  },
}));
