import { describe, it, expect, vi, beforeEach } from "vitest";

const listenMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

describe("settings store", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("keeps earlier changes when a later setting is saved", async () => {
    const { useSettingsStore } = await import("@/stores/settings-store");
    useSettingsStore.getState().setAlwaysTrashOverride(false);
    useSettingsStore.getState().setTheme("light");

    const saved = JSON.parse(localStorage.getItem("freemydisk_settings") ?? "{}");
    expect(saved.alwaysTrashOverride).toBe(false);
    expect(saved.theme).toBe("light");
  });

  it("falls back to defaults when saved settings are corrupt", async () => {
    localStorage.setItem("freemydisk_settings", "{not json");
    const { useSettingsStore } = await import("@/stores/settings-store");
    expect(useSettingsStore.getState().alwaysTrashOverride).toBe(true);
    expect(useSettingsStore.getState().theme).toBe("dark");
  });
});

describe("scan progress store", () => {
  beforeEach(() => {
    vi.resetModules();
    listenMock.mockReset();
  });

  it("subscribes once and keeps receiving events after a component unmounts", async () => {
    let handler: ((e: { payload: unknown }) => void) | undefined;
    const unlisten = vi.fn();
    listenMock.mockImplementation(async (_name: string, cb: typeof handler) => {
      handler = cb;
      return unlisten;
    });

    const { useScanProgressStore } = await import("@/stores/scan-progress-store");
    const store = useScanProgressStore.getState();

    const [first, second] = await Promise.all([
      store.initProgressListener(),
      store.initProgressListener(),
    ]);
    first();
    second();

    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(unlisten).not.toHaveBeenCalled();

    handler?.({
      payload: {
        scanType: "duplicates",
        stage: "Phase 2",
        percent: 40,
        itemsScanned: 10,
        currentPath: "C:/x",
        bytesFound: 0,
        isComplete: false,
      },
    });
    expect(useScanProgressStore.getState().progressByScanType.duplicates?.percent).toBe(40);
  });
});
