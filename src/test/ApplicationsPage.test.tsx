import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { ApplicationsPage, InstalledAppInfo, LeftoverGroup } from "@/pages/ApplicationsPage";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}));

const mockApps: InstalledAppInfo[] = [
  {
    id: "app-discord",
    name: "Discord",
    publisher: "Discord Inc.",
    display_version: "1.0.9000",
    install_location: "C:\\Users\\User\\AppData\\Local\\Discord",
    uninstall_string: "C:\\Users\\User\\AppData\\Local\\Discord\\Update.exe --uninstall",
    estimated_size_bytes: 250000000,
    install_date: "2026-01-01",
    is_running: true,
  },
  {
    id: "app-vlc",
    name: "VLC media player",
    publisher: "VideoLAN",
    display_version: "3.0.18",
    install_location: "C:\\Program Files\\VideoLAN\\VLC",
    uninstall_string: "C:\\Program Files\\VideoLAN\\VLC\\uninstall.exe",
    estimated_size_bytes: 180000000,
    install_date: "2025-12-01",
    is_running: false,
  },
];

const mockLeftoverGroups: LeftoverGroup[] = [
  {
    id: "group:Slack",
    app_name: "Slack",
    publisher: "Slack Technologies",
    total_size_bytes: 52428800, // ~50 MB
    overall_confidence: "high",
    items: [
      {
        id: "fs:slack-appdata",
        path_or_key: "C:\\Users\\User\\AppData\\Local\\Slack",
        kind: "filesystem",
        size_bytes: 52428800,
        item_count: 142,
        confidence: "high",
        description: "AppData Local Remnant (Slack)",
      },
      {
        id: "reg:slack-reg",
        path_or_key: "HKCU\\Software\\Slack",
        kind: "registry",
        size_bytes: 4096,
        item_count: 8,
        confidence: "high",
        description: "Application configuration registry hive",
      },
    ],
  },
];

describe("ApplicationsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders installed applications and displays running status", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "get_installed_applications") {
        return mockApps;
      }
      return [];
    });

    render(<ApplicationsPage />);

    await waitFor(() => {
      expect(screen.getByText("Discord")).toBeInTheDocument();
      expect(screen.getByText("VLC media player")).toBeInTheDocument();
    });

    expect(screen.getAllByText(/Active Process/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: /close app/i })).toBeInTheDocument();
  });

  it("terminates running process when Close App is clicked", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd, args: any) => {
      if (cmd === "get_installed_applications") {
        return mockApps;
      }
      if (cmd === "terminate_app_processes") {
        expect(args.appId).toBe("app-discord");
        return 1;
      }
      return [];
    });

    render(<ApplicationsPage />);

    await waitFor(() => {
      expect(screen.getByText("Discord")).toBeInTheDocument();
    });

    const closeBtn = screen.getByRole("button", { name: /close app/i });
    fireEvent.click(closeBtn);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("terminate_app_processes", {
        appId: "app-discord",
      });
    });
  });

  it("switches to leftovers tab and renders grouped residual items", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "get_installed_applications") {
        return mockApps;
      }
      if (cmd === "scan_deep_leftovers") {
        return mockLeftoverGroups;
      }
      return [];
    });

    render(<ApplicationsPage />);

    await waitFor(() => {
      expect(screen.getByText("Discord")).toBeInTheDocument();
    });

    const leftoversTabBtn = screen.getByRole("button", { name: /leftover hunter/i });
    fireEvent.click(leftoversTabBtn);

    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
      expect(screen.getByText(/HKCU\\Software\\Slack/i)).toBeInTheDocument();
    });
  });
});
