import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import {
  AiAndToolchainsView,
  AiModelInfo,
  RustToolchainScanResult,
  CondaCacheInfo,
} from "@/components/cleanup/AiAndToolchainsView";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}));

const mockModels: AiModelInfo[] = [
  {
    id: "ollama:llama3:latest",
    name: "llama3:latest",
    provider: "ollama",
    path: "C:\\Users\\tester\\.ollama\\models\\manifests\\library\\llama3\\latest",
    size_bytes: 4700000000,
    modified_at: 1715000000,
    description: "Ollama local model manifest and layers",
    is_directory: false,
  },
  {
    id: "hf:deepseek-ai/DeepSeek-R1",
    name: "deepseek-ai/DeepSeek-R1",
    provider: "huggingface",
    path: "C:\\Users\\tester\\.cache\\huggingface\\hub\\models--deepseek-ai--DeepSeek-R1",
    size_bytes: 15000000000,
    modified_at: 1716000000,
    description: "HuggingFace Hub snapshot & cached weights",
    is_directory: true,
  },
];

const mockRust: RustToolchainScanResult = {
  toolchains: [
    {
      name: "stable-x86_64-pc-windows-msvc",
      path: "C:\\Users\\tester\\.rustup\\toolchains\\stable-x86_64-pc-windows-msvc",
      is_active: true,
      size_bytes: 2100000000,
      modified_at: 1715500000,
      channel: "stable",
    },
    {
      name: "nightly-2023-01-01-x86_64-pc-windows-msvc",
      path: "C:\\Users\\tester\\.rustup\\toolchains\\nightly-2023-01-01-x86_64-pc-windows-msvc",
      is_active: false,
      size_bytes: 1800000000,
      modified_at: 1680000000,
      channel: "nightly",
    },
  ],
  total_size_bytes: 3900000000,
  active_toolchain: "stable-x86_64-pc-windows-msvc",
  rustup_installed: true,
};

const mockConda: CondaCacheInfo = {
  found: true,
  conda_path: "C:\\Users\\tester\\miniconda3\\Scripts\\conda.exe",
  cache_dirs: ["C:\\Users\\tester\\miniconda3\\pkgs"],
  total_size_bytes: 8500000000,
  package_count: 42,
};

describe("AiAndToolchainsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (invoke as any).mockImplementation((cmd: string) => {
      if (cmd === "scan_ai_models") return Promise.resolve(mockModels);
      if (cmd === "scan_rust_toolchains") return Promise.resolve(mockRust);
      if (cmd === "scan_conda_cache") return Promise.resolve(mockConda);
      if (cmd === "clean_ai_model") return Promise.resolve(4700000000);
      if (cmd === "clean_rust_toolchain") return Promise.resolve(1800000000);
      if (cmd === "clean_conda_cache") return Promise.resolve(8500000000);
      return Promise.resolve(null);
    });
  });

  it("renders AI models by default and displays model sizes and badges", async () => {
    render(<AiAndToolchainsView />);

    await waitFor(() => {
      expect(screen.getByText("llama3:latest")).toBeDefined();
      expect(screen.getByText("deepseek-ai/DeepSeek-R1")).toBeDefined();
    });

    expect(screen.getByText("Ollama")).toBeDefined();
    expect(screen.getByText("Hugging Face")).toBeDefined();
  });

  it("switches to Rust Toolchains tab and identifies active default toolchain", async () => {
    render(<AiAndToolchainsView />);

    await waitFor(() => {
      expect(screen.getByText("llama3:latest")).toBeDefined();
    });

    // Click on Rust Toolchains tab button
    const rustTabBtn = screen.getByRole("button", { name: /Rust Toolchains/ });
    fireEvent.click(rustTabBtn);

    await waitFor(() => {
      expect(screen.getByText("stable-x86_64-pc-windows-msvc")).toBeDefined();
      expect(screen.getByText("nightly-2023-01-01-x86_64-pc-windows-msvc")).toBeDefined();
    });

    // Active toolchain badge
    expect(screen.getByText(/Active Default/)).toBeDefined();
  });

  it("switches to Conda Cache tab and can trigger cleanup confirmation", async () => {
    render(<AiAndToolchainsView />);

    await waitFor(() => {
      expect(screen.getByText("llama3:latest")).toBeDefined();
    });

    // Click on Conda tab
    const condaTabBtn = screen.getByRole("button", { name: /Conda/ });
    fireEvent.click(condaTabBtn);

    await waitFor(() => {
      expect(screen.getByText(/Conda & Miniconda Downloaded Package Tarballs/)).toBeDefined();
      expect(screen.getByText(/42 cached .conda and .tar.bz2 archives/)).toBeDefined();
    });
  });
});
