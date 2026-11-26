import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { UpdateBanner } from "@/components/shared/UpdateBanner";
import { UpdateDialog } from "@/components/shared/UpdateDialog";
import { useUpdaterStore } from "@/stores/updater-store";
import * as updaterPlugin from "@tauri-apps/plugin-updater";
import * as processPlugin from "@tauri-apps/plugin-process";

const fakeUpdate = (version = "1.2.0") => {
  const update = {
    version,
    body: "## Improvements\n- Faster scans\n- **New** look",
    date: "2026-12-01T10:00:00Z",
    download: vi.fn(async (onEvent: (e: any) => void) => {
      onEvent({ event: "Started", data: { contentLength: 1000 } });
      onEvent({ event: "Progress", data: { chunkLength: 400 } });
      onEvent({ event: "Progress", data: { chunkLength: 600 } });
      onEvent({ event: "Finished" });
    }),
    install: vi.fn(async () => {}),
  };
  return update;
};

const reset = () =>
  useUpdaterStore.setState({
    status: "idle",
    version: "",
    releaseNotes: "",
    releaseDate: null,
    dismissedThisSession: false,
    dialogOpen: false,
    downloadedBytes: 0,
    totalBytes: 0,
    downloadProgress: 0,
    errorMessage: null,
    updateAvailable: false,
    isChecking: false,
    isDownloading: false,
    updateReady: false,
  });

describe("In-app updates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    reset();
  });

  it("shows the banner after an automatic check finds a newer version", async () => {
    vi.mocked(updaterPlugin.check).mockResolvedValueOnce(fakeUpdate() as any);
    await useUpdaterStore.getState().checkForUpdates(true);

    render(<UpdateBanner />);
    expect(screen.getByText(/FreeMyDisk 1\.2\.0 is available/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Update now/i })).toBeInTheDocument();
    // An automatic check never opens the dialog by itself.
    expect(useUpdaterStore.getState().dialogOpen).toBe(false);
  });

  it("stays silent when up to date or offline", async () => {
    vi.mocked(updaterPlugin.check).mockResolvedValueOnce(null);
    await useUpdaterStore.getState().checkForUpdates(true);
    vi.mocked(updaterPlugin.check).mockRejectedValueOnce(new Error("offline"));
    await expect(useUpdaterStore.getState().checkForUpdates(true)).resolves.toBeUndefined();

    render(<UpdateBanner />);
    expect(screen.queryByText(/is available/i)).not.toBeInTheDocument();
    expect(useUpdaterStore.getState().errorMessage).toBeNull();
  });

  it("a manual check reports errors and up-to-date in the dialog", async () => {
    vi.mocked(updaterPlugin.check).mockRejectedValueOnce(new Error("GitHub unreachable"));
    await useUpdaterStore.getState().checkForUpdates(false);
    expect(useUpdaterStore.getState().status).toBe("error");
    expect(useUpdaterStore.getState().errorMessage).toMatch(/GitHub unreachable/);

    vi.mocked(updaterPlugin.check).mockResolvedValueOnce(null);
    await useUpdaterStore.getState().checkForUpdates(false);
    expect(useUpdaterStore.getState().status).toBe("upToDate");
    expect(useUpdaterStore.getState().dialogOpen).toBe(true);
  });

  it("'Later' hides the banner for this session only", async () => {
    vi.mocked(updaterPlugin.check).mockResolvedValueOnce(fakeUpdate() as any);
    await useUpdaterStore.getState().checkForUpdates(true);
    render(<UpdateBanner />);
    fireEvent.click(screen.getByRole("button", { name: /^Later$/i }));
    expect(screen.queryByText(/is available/i)).not.toBeInTheDocument();
    expect(localStorage.getItem("fmd.update.skippedVersion")).toBeNull();
  });

  it("'Skip this version' silences automatic checks for that version only", async () => {
    vi.mocked(updaterPlugin.check).mockResolvedValueOnce(fakeUpdate("1.2.0") as any);
    await useUpdaterStore.getState().checkForUpdates(true);
    useUpdaterStore.getState().skipThisVersion();
    reset();

    vi.mocked(updaterPlugin.check).mockResolvedValueOnce(fakeUpdate("1.2.0") as any);
    await useUpdaterStore.getState().checkForUpdates(true);
    expect(useUpdaterStore.getState().status).toBe("idle");

    vi.mocked(updaterPlugin.check).mockResolvedValueOnce(fakeUpdate("1.3.0") as any);
    await useUpdaterStore.getState().checkForUpdates(true);
    expect(useUpdaterStore.getState().status).toBe("available");
  });

  it("downloads only after the user confirms, then installs and restarts", async () => {
    const update = fakeUpdate();
    vi.mocked(updaterPlugin.check).mockResolvedValueOnce(update as any);
    await useUpdaterStore.getState().checkForUpdates(true);
    expect(update.download).not.toHaveBeenCalled();

    act(() => useUpdaterStore.getState().openDialog());
    render(<UpdateDialog />);
    expect(screen.getByText(/Faster scans/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Update and restart/i }));
    });
    expect(update.download).toHaveBeenCalledTimes(1);
    expect(update.install).toHaveBeenCalledTimes(1);
    expect(processPlugin.relaunch).toHaveBeenCalled();
    expect(useUpdaterStore.getState().downloadProgress).toBe(100);
  });

  it("shows a retry when the download fails", async () => {
    const update = fakeUpdate();
    update.download.mockRejectedValueOnce(new Error("signature mismatch"));
    vi.mocked(updaterPlugin.check).mockResolvedValueOnce(update as any);
    await useUpdaterStore.getState().checkForUpdates(false);

    render(<UpdateDialog />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Update and restart/i }));
    });
    expect(update.install).not.toHaveBeenCalled();
    expect(screen.getByText(/signature mismatch/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Try again/i })).toBeInTheDocument();
  });
});
