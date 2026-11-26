import React, { useState } from "react";
import {
  Settings24Filled,
  ShieldCheckmark20Regular,
  ArrowClockwise20Regular,
  CheckmarkCircle20Filled,
  HardDrive20Regular,
  Color20Regular,
  WeatherSunny20Regular,
  WeatherMoon20Regular,
  Sparkle20Filled,
  Open20Regular,
  Info20Regular,
  Delete20Regular,
} from "@fluentui/react-icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useSettingsStore } from "@/stores/settings-store";
import { useUpdaterStore } from "@/stores/updater-store";
import { useI18nStore, SUPPORTED_LANGUAGES } from "@/i18n";
import { WinUICard, WinUISettingRow } from "@/components/winui/WinUICard";
import { WinUIToggle } from "@/components/winui/WinUIToggle";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { APP_VERSION } from "@/version";

export const SettingsPage: React.FC = () => {
  const { locale, setLocale, t } = useI18nStore();
  const {
    autoCheckUpdates,
    alwaysTrashOverride,
    largeFileThresholdMb,
    confirmBeforeDelete,
    theme,
    setAutoCheckUpdates,
    setAlwaysTrashOverride,
    setLargeFileThresholdMb,
    setConfirmBeforeDelete,
    setTheme,
  } = useSettingsStore();

  const { checkForUpdates, isChecking, updateAvailable, version } = useUpdaterStore();
  const [manualCheckMsg, setManualCheckMsg] = useState<string | null>(null);

  const handleCheckUpdates = async () => {
    setManualCheckMsg(null);
    await checkForUpdates(false);
    // Read fresh store state: the `updateAvailable` captured by this closure is stale after the await.
    if (!useUpdaterStore.getState().updateAvailable) {
      setManualCheckMsg(`You are using the latest version of FreeMyDisk (v${APP_VERSION}).`);
      setTimeout(() => setManualCheckMsg(null), 5000);
    }
  };

  const handleOpenLink = async (url: string) => {
    try {
      await openUrl(url);
    } catch (e) {
      console.warn("Tauri opener failed, using fallback:", e);
      try {
        window.open(url, "_blank", "noopener,noreferrer");
      } catch (err) {
        console.error("Window open fallback failed:", err);
      }
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4 select-none font-sans text-[var(--text-primary)]">
      {/* Header Bar */}
      <div className="flex items-center gap-3.5 pb-2">
        <div className="w-10 h-10 rounded-[4px] bg-white/[0.04] border border-[var(--border-subtle)] flex items-center justify-center text-[#0078d4] shrink-0">
          <Settings24Filled className="w-6 h-6" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-[var(--text-primary)] tracking-tight">
              {t.settings.title}
            </h1>
            <span className="px-1.5 py-0.2 rounded-[4px] text-[10px] font-ibm-mono bg-white/[0.06] text-[var(--text-secondary)] border border-[var(--border-subtle)]">
              v{APP_VERSION}
            </span>
          </div>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">
            {t.settings.subtitle}
          </p>
        </div>
      </div>

      {/* Section 1: Appearance & Personalization */}
      <div className="space-y-1.5">
        <h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider px-1 flex items-center gap-1.5">
          <Color20Regular className="w-3.5 h-3.5 text-[#0078d4]" />
          <span>{t.settings.generalSection}</span>
        </h3>

        <WinUICard className="p-4 space-y-4">
          {/* Theme Picker */}
          <div className="space-y-2">
            <div>
              <label className="text-xs font-semibold text-[var(--text-primary)]">{t.settings.themeTitle}</label>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                {t.settings.themeDesc}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <button
                onClick={() => setTheme("dark")}
                className={`p-3 rounded-[4px] border flex items-center gap-3 transition-all cursor-pointer ${
                  theme === "dark"
                    ? "bg-[#0078d4]/15 border-[#0078d4] text-[var(--text-primary)] shadow-sm"
                    : "bg-white/[0.03] border-[var(--border-subtle)] hover:border-white/20 text-[var(--text-secondary)]"
                }`}
              >
                <div className="p-2 rounded-[4px] bg-black/20 text-[#0078d4]">
                  <WeatherMoon20Regular className="w-4 h-4" />
                </div>
                <div className="text-left">
                  <div className="text-xs font-semibold text-[var(--text-primary)]">{t.settings.themeDark}</div>
                  <div className="text-[10px] text-[var(--text-muted)]">Dark Slate</div>
                </div>
              </button>

              <button
                onClick={() => setTheme("night")}
                className={`p-3 rounded-[4px] border flex items-center gap-3 transition-all cursor-pointer ${
                  theme === "night"
                    ? "bg-[#0078d4]/15 border-[#0078d4] text-[var(--text-primary)] shadow-sm"
                    : "bg-white/[0.03] border-[var(--border-subtle)] hover:border-white/20 text-[var(--text-secondary)]"
                }`}
              >
                <div className="p-2 rounded-[4px] bg-black/20 text-[#4cc2ff]">
                  <Sparkle20Filled className="w-4 h-4" />
                </div>
                <div className="text-left">
                  <div className="text-xs font-semibold text-[var(--text-primary)]">{t.settings.themeSystem}</div>
                  <div className="text-[10px] text-[var(--text-muted)]">OLED Night</div>
                </div>
              </button>

              <button
                onClick={() => setTheme("light")}
                className={`p-3 rounded-[4px] border flex items-center gap-3 transition-all cursor-pointer ${
                  theme === "light"
                    ? "bg-[#0078d4]/15 border-[#0078d4] text-[var(--text-primary)] shadow-sm"
                    : "bg-white/[0.03] border-[var(--border-subtle)] hover:border-white/20 text-[var(--text-secondary)]"
                }`}
              >
                <div className="p-2 rounded-[4px] bg-black/20 text-[#d97706]">
                  <WeatherSunny20Regular className="w-4 h-4" />
                </div>
                <div className="text-left">
                  <div className="text-xs font-semibold text-[var(--text-primary)]">{t.settings.themeLight}</div>
                  <div className="text-[10px] text-[var(--text-muted)]">Light Mode</div>
                </div>
              </button>
            </div>
          </div>

          {/* Language Picker */}
          <div className="space-y-2 pt-3 border-t border-[var(--border-divider)]">
            <div>
              <label className="text-xs font-semibold text-[var(--text-primary)]">{t.settings.language}</label>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                {t.settings.languageDesc}
              </p>
            </div>

            <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-9 gap-2">
              {SUPPORTED_LANGUAGES.map((lang) => (
                <button
                  key={lang.code}
                  onClick={() => setLocale(lang.code)}
                  className={`p-2.5 rounded-[4px] border flex flex-col items-center justify-center gap-1 transition-all cursor-pointer ${
                    locale === lang.code
                      ? "bg-[#0078d4]/15 border-[#0078d4] text-[var(--text-primary)] font-semibold shadow-sm"
                      : "bg-white/[0.03] border-[var(--border-subtle)] hover:border-white/20 text-[var(--text-secondary)]"
                  }`}
                >
                  <span className="text-lg">{lang.flag}</span>
                  <span className="text-xs">{lang.nativeName}</span>
                  <span className="text-[9px] text-[var(--text-muted)] font-ibm-mono uppercase">{lang.code}</span>
                </button>
              ))}
            </div>
          </div>
        </WinUICard>

        {/* Toggles Card */}
        <WinUICard>
          <WinUISettingRow
            title={t.settings.checkForUpdates}
            subtitle={t.settings.generalDesc}
            action={
              <WinUIToggle
                checked={autoCheckUpdates}
                onChange={setAutoCheckUpdates}
              />
            }
          />
          <WinUISettingRow
            title={t.settings.confirmDelete}
            subtitle={t.settings.confirmDeleteDesc}
            action={
              <WinUIToggle
                checked={confirmBeforeDelete}
                onChange={setConfirmBeforeDelete}
              />
            }
          />
        </WinUICard>
      </div>

      {/* Section 2: Safety & Governance */}
      <div className="space-y-1.5">
        <h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider px-1 flex items-center gap-1.5">
          <ShieldCheckmark20Regular className="w-3.5 h-3.5 text-emerald-400" />
          <span>{t.settings.safetySection}</span>
        </h3>

        <WinUICard>
          <WinUISettingRow
            icon={<Delete20Regular className="w-4 h-4 text-emerald-400" />}
            title={t.settings.alwaysTrash}
            subtitle={t.settings.alwaysTrashDesc}
            action={
              <WinUIToggle
                checked={alwaysTrashOverride}
                onChange={setAlwaysTrashOverride}
              />
            }
          />

          {/* Large File Scan Threshold */}
          <div className="px-4 py-3.5 border-t border-[var(--border-divider)] space-y-2">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="text-[13px] font-semibold text-[var(--text-primary)]">
                  {t.largeFiles.minSize}
                </div>
                <div className="text-[12px] text-[var(--text-secondary)] mt-0.5">
                  {t.settings.safetyDesc}
                </div>
              </div>

              <div className="flex items-center gap-1.5 bg-black/20 p-0.5 rounded-[4px] border border-[var(--border-subtle)]">
                {[100, 250, 500, 1024].map((mb) => (
                  <button
                    key={mb}
                    onClick={() => setLargeFileThresholdMb(mb)}
                    className={`px-3 py-1 rounded-[3px] text-xs font-medium transition-all cursor-pointer font-ibm-mono ${
                      largeFileThresholdMb === mb
                        ? "bg-[#0078d4] text-white shadow-sm font-semibold"
                        : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {mb >= 1024 ? "≥ 1 GB" : `≥ ${mb} MB`}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </WinUICard>

        {/* Protected Exclusions Notice */}
        <div className="p-3.5 bg-black/20 rounded-[4px] border border-[var(--border-subtle)] flex items-start gap-3">
          <Info20Regular className="w-4 h-4 text-[#0078d4] shrink-0 mt-0.5" />
          <div className="text-xs text-[var(--text-secondary)] leading-relaxed font-sans">
            <strong className="text-[var(--text-primary)]">System Exclusions Active: </strong>
            Critical Windows directories (<code className="font-ibm-mono text-[var(--text-primary)]">C:\Windows</code>, <code className="font-ibm-mono text-[var(--text-primary)]">System32</code>, <code className="font-ibm-mono text-[var(--text-primary)]">WinSxS</code>, and system drivers) are hardcoded with protected status. FreeMyDisk will never delete these files even in deep cleaning mode.
          </div>
        </div>
      </div>

      {/* Section 3: About FreeMyDisk */}
      <div className="space-y-1.5">
        <h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider px-1 flex items-center gap-1.5">
          <HardDrive20Regular className="w-3.5 h-3.5 text-[#0078d4]" />
          <span>{t.settings.aboutSection}</span>
        </h3>

        <WinUICard className="p-4 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3.5">
              <img
                src="/logo.png"
                alt="FreeMyDisk Logo"
                className="w-12 h-12 object-contain rounded-lg p-1 bg-white/[0.04] border border-[var(--border-subtle)] shadow-sm shrink-0"
              />
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-[var(--text-primary)]">FreeMyDisk Desktop</span>
                  <span className="px-1.5 py-0.5 font-ibm-mono text-[10px] font-semibold rounded bg-[#0078d4]/15 text-[#0078d4] border border-[#0078d4]/30">
                    v1.0.0
                  </span>
                </div>
                <div className="text-xs text-[var(--text-secondary)] mt-0.5">
                  {t.settings.aboutDesc}
                </div>
                <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
                  Built with Tauri v2, Rust core, and React WinUI 3 Fluent 2.
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <WinUIButton
                variant="primary"
                onClick={handleCheckUpdates}
                disabled={isChecking}
                icon={<ArrowClockwise20Regular className={`w-3.5 h-3.5 ${isChecking ? "animate-spin" : ""}`} />}
              >
                {isChecking ? t.common.scanning : t.settings.checkForUpdates}
              </WinUIButton>
            </div>
          </div>

          {manualCheckMsg && (
            <div className="p-3 bg-emerald-950/30 border border-emerald-500/30 rounded-[4px] text-xs text-emerald-300 font-medium flex items-center gap-2">
              <CheckmarkCircle20Filled className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{manualCheckMsg}</span>
            </div>
          )}

          {updateAvailable && (
            <div className="p-3 bg-blue-950/30 border border-blue-500/30 rounded-[4px] text-xs text-blue-300 font-medium flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <CheckmarkCircle20Filled className="w-4 h-4 text-blue-400 shrink-0" />
                <span>Version {version} is available!</span>
              </div>
            </div>
          )}

          {/* Project Info Card */}
          <div className="p-3.5 rounded-lg bg-white/[0.02] border border-[var(--border-subtle)] space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <img src="/logo.png" alt="FreeMyDisk" className="w-8 h-8 object-contain select-none" />
                <div>
                  <div className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                    <span>FreeMyDisk</span>
                    <span className="font-ibm-mono text-[10px] font-normal text-[var(--text-secondary)]">v{APP_VERSION}</span>
                  </div>
                  <div className="text-[11px] text-[var(--text-muted)]">
                    Official Open-Source Project • Public Repository on GitHub
                  </div>
                </div>
              </div>

              <button
                onClick={() => handleOpenLink("https://github.com/fzihak/FreeMyDisk")}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-[4px] bg-[#0078d4]/10 hover:bg-[#0078d4]/20 border border-[#0078d4]/30 text-xs font-medium text-[#0078d4] transition-all cursor-pointer w-fit"
              >
                <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                </svg>
                <span>github.com/fzihak/FreeMyDisk</span>
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[var(--border-divider)] text-[11px] text-[var(--text-secondary)] font-ibm-mono">
              <span className="px-2 py-0.5 rounded bg-white/[0.04] border border-[var(--border-subtle)]">
                🛡️ Safety Invariants Active
              </span>
              <span className="px-2 py-0.5 rounded bg-white/[0.04] border border-[var(--border-subtle)]">
                ⚡ Rust Core & SQLite WAL
              </span>
              <span className="px-2 py-0.5 rounded bg-white/[0.04] border border-[var(--border-subtle)]">
                🔒 100% Offline & Private
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4 pt-2 border-t border-[var(--border-divider)] text-xs">
            <button
              onClick={() => handleOpenLink("https://github.com/fzihak/FreeMyDisk")}
              className="flex items-center gap-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
            >
              <Open20Regular className="w-3.5 h-3.5" />
              <span>{t.settings.repoLink}</span>
            </button>

            <button
              onClick={() => handleOpenLink("https://github.com/fzihak/FreeMyDisk/releases")}
              className="flex items-center gap-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
            >
              <Open20Regular className="w-3.5 h-3.5" />
              <span>Release Notes</span>
            </button>

            <button
              onClick={() => handleOpenLink("https://github.com/fzihak/FreeMyDisk/issues")}
              className="flex items-center gap-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
            >
              <Open20Regular className="w-3.5 h-3.5" />
              <span>Report an Issue</span>
            </button>

            <button
              onClick={() => handleOpenLink("https://github.com/fzihak/FreeMyDisk/blob/main/LICENSE")}
              className="flex items-center gap-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
            >
              <Open20Regular className="w-3.5 h-3.5" />
              <span>GNU General Public License v3.0 (GPL-3.0)</span>
            </button>
          </div>
        </WinUICard>
      </div>
    </div>
  );
};

export default SettingsPage;
