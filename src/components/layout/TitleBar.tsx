import React, { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Subtract16Regular,
  Square16Regular,
  SquareMultiple16Regular,
  Dismiss16Regular,
  ChevronDown12Regular,
} from "@fluentui/react-icons";

import { useI18nStore, SUPPORTED_LANGUAGES } from "@/i18n";

interface TitleBarProps {
  title?: string;
}

const isTauriWindowAvailable = (): boolean => {
  return (
    typeof window !== "undefined" &&
    Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)
  );
};

export const TitleBar: React.FC<TitleBarProps> = ({ title = "FreeMyDisk" }) => {
  const [isMaximized, setIsMaximized] = useState(false);
  const [langDropdownOpen, setLangDropdownOpen] = useState(false);
  const { locale, setLocale } = useI18nStore();
  const currentLang = SUPPORTED_LANGUAGES.find((l) => l.code === locale) || SUPPORTED_LANGUAGES[0];

  useEffect(() => {
    if (!isTauriWindowAvailable()) {
      return;
    }

    try {
      const appWindow = getCurrentWindow();

      // Sync maximized state on mount
      appWindow.isMaximized().then(setIsMaximized).catch(() => {});

      // Listen for resize events to keep icon in sync
      const unlisten = appWindow.onResized(() => {
        appWindow.isMaximized().then(setIsMaximized).catch(() => {});
      });

      return () => {
        unlisten.then((fn) => fn && fn()).catch(() => {});
      };
    } catch (err) {
      console.warn("Could not bind Tauri window events:", err);
    }
  }, []);

  const handleMinimize = () => {
    try {
      getCurrentWindow().minimize().catch(() => {});
    } catch {}
  };

  const handleMaximize = () => {
    try {
      getCurrentWindow().toggleMaximize().catch(() => {});
    } catch {}
  };

  const handleClose = () => {
    try {
      getCurrentWindow().close().catch(() => {});
    } catch {}
  };

  return (
    <div
      data-tauri-drag-region
      onDoubleClick={handleMaximize}
      className="titlebar h-9 flex items-center justify-between shrink-0 select-none bg-[var(--bg-sidebar)] border-b border-[var(--border-divider)] px-3 z-50 transition-colors duration-200"
    >
      {/* App Brand - WinUI 3 Header */}
      <div
        data-tauri-drag-region
        className="flex items-center gap-2.5 pointer-events-none"
      >
        <img
          src="/logo.png"
          alt="FreeMyDisk"
          className="w-4 h-4 object-contain select-none"
        />
        <span className="text-[12px] font-medium text-[var(--text-primary)] tracking-tight font-sans">
          {title}
        </span>
      </div>

      {/* Drag Region Center */}
      <div data-tauri-drag-region className="flex-1 h-full" />

      {/* GitHub Repository Quick Link */}
      <button
        onClick={async () => {
          try {
            await openUrl("https://github.com/fzihak/FreeMyDisk");
          } catch {
            window.open("https://github.com/fzihak/FreeMyDisk", "_blank");
          }
        }}
        title="FreeMyDisk by Foysal Zihak on GitHub"
        className="flex items-center gap-1.5 px-2 py-1 rounded-[4px] text-[11px] font-medium bg-white/[0.04] hover:bg-white/[0.08] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-subtle)] mr-1.5 transition-all cursor-pointer"
      >
        <svg className="w-3.5 h-3.5 fill-current opacity-80" viewBox="0 0 24 24">
          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
        </svg>
        <span className="hidden sm:inline text-[10px] font-semibold text-[var(--text-secondary)]">GitHub</span>
      </button>

      {/* Fluent Pill Language Selector */}
      <div className="relative mr-2">
        <button
          onClick={() => setLangDropdownOpen(!langDropdownOpen)}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-[4px] text-[11px] font-medium bg-white/[0.04] hover:bg-white/[0.08] text-[var(--text-secondary)] border border-[var(--border-subtle)] transition-all cursor-pointer"
        >
          <span className="text-xs">{currentLang.flag}</span>
          <span className="font-ibm-mono text-[10px] uppercase font-bold tracking-wider">{currentLang.code}</span>
          <ChevronDown12Regular className="w-3 h-3 text-[var(--text-muted)]" />
        </button>
        {langDropdownOpen && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setLangDropdownOpen(false)}
            />
            <div className="absolute right-0 mt-1 py-1.5 w-48 bg-[var(--bg-card)] border border-[var(--border-card)] rounded-lg shadow-2xl z-50">
              {SUPPORTED_LANGUAGES.map((lang) => (
                <button
                  key={lang.code}
                  onClick={() => {
                    setLocale(lang.code);
                    setLangDropdownOpen(false);
                  }}
                  className={`w-full flex items-center justify-between px-3 py-1.5 text-xs text-left hover:bg-white/[0.08] transition-colors cursor-pointer ${
                    locale === lang.code ? "text-[#0078d4] font-bold bg-blue-500/10" : "text-[var(--text-secondary)]"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span>{lang.flag}</span>
                    <span>{lang.nativeName}</span>
                  </div>
                  <span className="text-[10px] text-[var(--text-muted)] font-ibm-mono uppercase">{lang.code}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Windows 11 Native Caption Buttons */}
      <div className="flex items-center h-full -mr-3">
        <button
          onClick={handleMinimize}
          id="titlebar-minimize"
          title="Minimize"
          className="w-[46px] h-9 flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/[0.06] transition-colors cursor-pointer"
        >
          <Subtract16Regular className="w-4 h-4" />
        </button>

        <button
          onClick={handleMaximize}
          id="titlebar-maximize"
          title={isMaximized ? "Restore" : "Maximize"}
          className="w-[46px] h-9 flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/[0.06] transition-colors cursor-pointer"
        >
          {isMaximized ? (
            <SquareMultiple16Regular className="w-3.5 h-3.5" />
          ) : (
            <Square16Regular className="w-3.5 h-3.5" />
          )}
        </button>

        <button
          onClick={handleClose}
          id="titlebar-close"
          title="Close"
          className="w-[46px] h-9 flex items-center justify-center text-[var(--text-secondary)] hover:text-white hover:bg-[#c42b1c] transition-colors cursor-pointer"
        >
          <Dismiss16Regular className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};

export default TitleBar;
