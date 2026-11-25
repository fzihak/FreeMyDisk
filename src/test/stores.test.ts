import { describe, it, expect, vi, beforeEach } from "vitest";

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
