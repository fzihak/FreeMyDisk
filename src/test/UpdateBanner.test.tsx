import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { UpdateBanner } from "@/components/shared/UpdateBanner";
import { useUpdaterStore } from "@/stores/updater-store";
import * as updaterPlugin from "@tauri-apps/plugin-updater";

describe("UpdateBanner (Addendum A & Section 14.1 Test Matrix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUpdaterStore.setState({
      updateAvailable: false,
      version: "",
      releaseNotes: "",
      dismissedThisSession: false,
      isDownloading: false,
      downloadProgress: 0,
      updateReady: false,
      errorMessage: null,
    });
  });

  it("(a) shows banner when update is available", async () => {
    useUpdaterStore.setState({
      updateAvailable: true,
      version: "1.2.0",
      releaseNotes: "Performance upgrades",
    });

    render(<UpdateBanner />);
    expect(
      screen.getByText(/A new version of FreeMyDisk is available/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/\(v1.2.0\)/i)).toBeInTheDocument();
    expect(screen.getByText(/\[See what's new\]/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Update Now/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Not now/i })).toBeInTheDocument();
  });

  it("(b) does not show banner when up to date", async () => {
    vi.mocked(updaterPlugin.check).mockResolvedValueOnce({
      available: false,
      version: "1.0.0",
    } as any);

    await useUpdaterStore.getState().checkForUpdates();

    render(<UpdateBanner />);
    expect(
      screen.queryByText(/A new version of FreeMyDisk is available/i)
    ).not.toBeInTheDocument();
  });

  it("(c) hides banner for current session when dismissed", () => {
    useUpdaterStore.setState({
      updateAvailable: true,
      version: "1.2.0",
      dismissedThisSession: false,
    });

    render(<UpdateBanner />);
    const notNowBtn = screen.getByRole("button", { name: /Not now/i });
    fireEvent.click(notNowBtn);

    expect(
      screen.queryByText(/A new version of FreeMyDisk is available/i)
    ).not.toBeInTheDocument();
    expect(useUpdaterStore.getState().dismissedThisSession).toBe(true);
  });

  it("(d) banner reappears on next simulated launch while still outdated", () => {
    // Session 1: dismiss
    useUpdaterStore.setState({
      updateAvailable: true,
      version: "1.2.0",
      dismissedThisSession: false,
    });
    useUpdaterStore.getState().dismissBanner();
    expect(useUpdaterStore.getState().dismissedThisSession).toBe(true);

    // Simulated launch 2 (new session state resets in-memory dismissedThisSession)
    useUpdaterStore.setState({
      updateAvailable: true,
      version: "1.2.0",
      dismissedThisSession: false, // strictly in-memory reset
    });

    render(<UpdateBanner />);
    expect(
      screen.getByText(/A new version of FreeMyDisk is available/i)
    ).toBeInTheDocument();
  });

  it("(e) offline / failed check fails 100% silently with zero UI side effects", async () => {
    vi.mocked(updaterPlugin.check).mockRejectedValueOnce(
      new Error("Network timeout / offline")
    );

    // Should not throw, should not set error state visible to user
    await expect(useUpdaterStore.getState().checkForUpdates()).resolves.toBeUndefined();

    render(<UpdateBanner />);
    expect(
      screen.queryByText(/A new version of FreeMyDisk is available/i)
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
  });
});
