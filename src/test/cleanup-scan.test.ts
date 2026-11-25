import { describe, it, expect, vi, beforeEach } from "vitest";
import { en } from "@/i18n/locales/en";
import { describeDisposal } from "@/utils/disposal";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const fmt = (b: number) => `${b} B`;

describe("describeDisposal", () => {
  it("keeps freed space apart from space moved to the Recycle Bin", () => {
    const text = describeDisposal({ total_freed_bytes: 10, recycled_bytes: 30 }, en, fmt);
    expect(text).toBe(`${en.cleanup.reclaimedSpace}: 10 B · ${en.cleanup.movedToRecycleBin}: 30 B`);
  });

  it("does not claim freed space for a Recycle Bin-only cleanup", () => {
    const text = describeDisposal({ total_freed_bytes: 0, recycled_bytes: 30 }, en, fmt);
    expect(text).toBe(`${en.cleanup.movedToRecycleBin}: 30 B`);
  });
});

describe("cleanup scan store", () => {
  beforeEach(() => {
    vi.resetModules();
    invokeMock.mockReset();
  });

  it("shares one scan between callers and reuses recent results", async () => {
    let resolve: (v: unknown) => void = () => {};
    invokeMock.mockReturnValue(new Promise((r) => (resolve = r)));
    const { useCleanupScanStore } = await import("@/stores/cleanup-scan-store");
    const store = useCleanupScanStore.getState();

    expect(store.fresh()).toBeNull();
    const first = store.scan();
    const second = store.scan();
    resolve([{ rule_id: "temp" }]);
    await Promise.all([first, second]);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(useCleanupScanStore.getState().fresh()).toEqual([{ rule_id: "temp" }]);
  });

  it("treats results older than ten minutes as stale", async () => {
    const { useCleanupScanStore } = await import("@/stores/cleanup-scan-store");
    useCleanupScanStore.setState({
      summaries: [],
      scannedAt: Date.now() - 11 * 60 * 1000,
    });
    expect(useCleanupScanStore.getState().fresh()).toBeNull();
  });
});
