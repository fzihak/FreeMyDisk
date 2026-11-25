import { create } from "zustand";

type Theme = "dark" | "night" | "light";

interface PersistedSettings {
  autoCheckUpdates: boolean;
  alwaysTrashOverride: boolean;
  largeFileThresholdMb: number;
  confirmBeforeDelete: boolean;
  theme: Theme;
}

interface SettingsState extends PersistedSettings {
  setAutoCheckUpdates: (val: boolean) => void;
  setAlwaysTrashOverride: (val: boolean) => void;
  setLargeFileThresholdMb: (val: number) => void;
  setConfirmBeforeDelete: (val: boolean) => void;
  setTheme: (val: Theme) => void;
}

const STORAGE_KEY = "freemydisk_settings";

const DEFAULTS: PersistedSettings = {
  autoCheckUpdates: true,
  alwaysTrashOverride: true,
  largeFileThresholdMb: 500,
  confirmBeforeDelete: true,
  theme: "dark",
};

/** Reads saved settings, ignoring missing, corrupt or wrongly typed values. */
function loadSettings(): PersistedSettings {
  let saved: Record<string, unknown> = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object") saved = parsed as Record<string, unknown>;
  } catch {
    saved = {};
  }

  const bool = (key: keyof PersistedSettings) =>
    typeof saved[key] === "boolean" ? (saved[key] as boolean) : (DEFAULTS[key] as boolean);

  return {
    autoCheckUpdates: bool("autoCheckUpdates"),
    alwaysTrashOverride: bool("alwaysTrashOverride"),
    confirmBeforeDelete: bool("confirmBeforeDelete"),
    largeFileThresholdMb:
      typeof saved.largeFileThresholdMb === "number" && saved.largeFileThresholdMb > 0
        ? saved.largeFileThresholdMb
        : DEFAULTS.largeFileThresholdMb,
    theme:
      saved.theme === "light" || saved.theme === "night" || saved.theme === "dark"
        ? saved.theme
        : DEFAULTS.theme,
  };
}

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.classList.toggle("dark", theme !== "light");
}

export const useSettingsStore = create<SettingsState>((set, get) => {
  const initial = loadSettings();
  applyTheme(initial.theme);

  /** Applies a change and saves the full current settings, so earlier changes are kept. */
  const update = (patch: Partial<PersistedSettings>) => {
    set(patch);
    const { autoCheckUpdates, alwaysTrashOverride, largeFileThresholdMb, confirmBeforeDelete, theme } =
      get();
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          autoCheckUpdates,
          alwaysTrashOverride,
          largeFileThresholdMb,
          confirmBeforeDelete,
          theme,
        })
      );
    } catch {
      // Storage can be unavailable (quota, private mode); the in-memory value still applies.
    }
  };

  return {
    ...initial,
    setAutoCheckUpdates: (val) => update({ autoCheckUpdates: val }),
    setAlwaysTrashOverride: (val) => update({ alwaysTrashOverride: val }),
    setLargeFileThresholdMb: (val) => update({ largeFileThresholdMb: val }),
    setConfirmBeforeDelete: (val) => update({ confirmBeforeDelete: val }),
    setTheme: (val) => {
      applyTheme(val);
      update({ theme: val });
    },
  };
});
