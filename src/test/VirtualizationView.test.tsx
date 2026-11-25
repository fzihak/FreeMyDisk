import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { VirtualizationView, VirtualizationOverview } from "@/components/optimization/VirtualizationView";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}));

const mockOverview: VirtualizationOverview = {
  wsl_installed: true,
  wsl_distributions: [
    {
      name: "Ubuntu",
      vhdx_path: "C:\\WSL\\Ubuntu\\ext4.vhdx",
      vhdx_actual_bytes: 12884901888, // ~12 GB
      vhdx_virtual_bytes: 25769803776, // ~24 GB
      reclaimable_estimate: 5368709120, // ~5 GB
      state: "Stopped",
      is_default: true,
      version: 2,
    },
  ],
  total_wsl_bytes: 12884901888,
  total_wsl_reclaimable: 5368709120,
  docker: {
    is_installed: true,
    is_running: true,
    server_version: "25.0.3",
    storage_driver: "overlay2",
    data_root: "\\\\wsl$\\docker-desktop-data\\data",
    total_space_bytes: 3221225472, // ~3 GB
    total_reclaimable_bytes: 1073741824, // ~1 GB
    categories: [
      {
        category: "Images",
        total_count: 5,
        active_count: 2,
        size_bytes: 2147483648,
        reclaimable_bytes: 1073741824,
      },
    ],
  },
  hyperv_disks: [
    {
      vm_name: "DevVM",
      disk_path: "C:\\VMs\\DevVM\\Virtual Disks\\disk.vhdx",
      size_bytes: 21474836480, // ~20 GB
      format: "VHDX",
    },
  ],
  total_vm_bytes: 21474836480,
};

describe("VirtualizationView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders virtualization overview with WSL, Docker, and Hyper-V data", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "get_virtualization_overview") {
        return mockOverview;
      }
      return null;
    });

    render(<VirtualizationView />);

    await waitFor(() => {
      expect(screen.getByText("Ubuntu")).toBeInTheDocument();
    });

    expect(screen.getByText("DevVM")).toBeInTheDocument();
    expect(screen.getByText(/Docker Engine/i)).toBeInTheDocument();
  });

  it("handles compaction trigger when Compact button is clicked", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "get_virtualization_overview") {
        return mockOverview;
      }
      if (cmd === "compact_wsl_distribution") {
        return {
          target_name: "Ubuntu",
          path: "C:\\WSL\\Ubuntu\\ext4.vhdx",
          before_bytes: 12884901888,
          after_bytes: 8589934592,
          freed_bytes: 4294967296,
          success: true,
          message: "Compaction completed",
        };
      }
      return null;
    });

    render(<VirtualizationView />);

    await waitFor(() => {
      expect(screen.getByText("Ubuntu")).toBeInTheDocument();
    });

    const compactBtn = screen.getByRole("button", { name: /compact vhdx/i });
    expect(compactBtn).toBeInTheDocument();

    fireEvent.click(compactBtn);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("compact_wsl_distribution", {
        distroName: "Ubuntu",
      });
    });
  });
});
