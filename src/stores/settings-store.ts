import { create } from "zustand";

interface SettingsState {
  autoCheckUpdates: boolean;
  alwaysTrashOverride: boolean;
  largeFileThresholdMb: number;
  confirmBeforeDelete: boolean;
  theme: "dark" | "night" | "light";

  setAutoCheckUpdates: (val: boolean) => void;
  setAlwaysTrashOverride: (val: boolean) => void;
  setLargeFileThresholdMb: (val: number) => void;
  setConfirmBeforeDelete: (val: boolean) => void;
  setTheme: (val: "dark" | "night" | "light") => void;
}

export const useSettingsStore = create<SettingsState>((set) => {
  const savedSettings = localStorage.getItem("freemydisk_settings");
  const parsed = savedSettings ? JSON.parse(savedSettings) : {};
  const initialTheme: "dark" | "night" | "light" =
    parsed.theme === "light" || parsed.theme === "night" || parsed.theme === "dark"
      ? parsed.theme
      : "dark";

  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", initialTheme);
    if (initialTheme === "light") {
      document.documentElement.classList.remove("dark");
    } else {
      document.documentElement.classList.add("dark");
    }
  }

  return {
    autoCheckUpdates: parsed.autoCheckUpdates ?? true,
    alwaysTrashOverride: parsed.alwaysTrashOverride ?? true,
    largeFileThresholdMb: parsed.largeFileThresholdMb ?? 500,
    confirmBeforeDelete: parsed.confirmBeforeDelete ?? true,
    theme: initialTheme,

    setAutoCheckUpdates: (val: boolean) => {
      set({ autoCheckUpdates: val });
      localStorage.setItem(
        "freemydisk_settings",
        JSON.stringify({ ...parsed, autoCheckUpdates: val })
      );
    },

    setAlwaysTrashOverride: (val: boolean) => {
      set({ alwaysTrashOverride: val });
      localStorage.setItem(
        "freemydisk_settings",
        JSON.stringify({ ...parsed, alwaysTrashOverride: val })
      );
    },

    setLargeFileThresholdMb: (val: number) => {
      set({ largeFileThresholdMb: val });
      localStorage.setItem(
        "freemydisk_settings",
        JSON.stringify({ ...parsed, largeFileThresholdMb: val })
      );
    },

    setConfirmBeforeDelete: (val: boolean) => {
      set({ confirmBeforeDelete: val });
      localStorage.setItem(
        "freemydisk_settings",
        JSON.stringify({ ...parsed, confirmBeforeDelete: val })
      );
    },

    setTheme: (val: "dark" | "night" | "light") => {
      set({ theme: val });
      if (typeof document !== "undefined") {
        document.documentElement.setAttribute("data-theme", val);
        if (val === "light") {
          document.documentElement.classList.remove("dark");
        } else {
          document.documentElement.classList.add("dark");
        }
      }
      localStorage.setItem(
        "freemydisk_settings",
        JSON.stringify({ ...parsed, theme: val })
      );
    },
  };
});

