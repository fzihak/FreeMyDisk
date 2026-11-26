import React, { useState } from "react";
import {
  Settings20Regular,
  ShieldCheckmark20Regular,
  ArrowClockwise20Regular,
  ArrowSync20Regular,
  CheckmarkCircle20Filled,
  Color20Regular,
  LocalLanguage20Regular,
  Open20Regular,
  Info20Regular,
  Delete20Regular,
  DocumentSearch20Regular,
  QuestionCircle20Regular,
  Sparkle20Filled,
} from "@fluentui/react-icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useSettingsStore } from "@/stores/settings-store";
import { useUpdaterStore } from "@/stores/updater-store";
import { useI18nStore, SUPPORTED_LANGUAGES } from "@/i18n";
import { WinUIToggle } from "@/components/winui/WinUIToggle";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { Page, PageHeader, SectionTitle, Card, Badge } from "@/components/ui";
import { APP_VERSION } from "@/version";

const REPO_URL = "https://github.com/fzihak/FreeMyDisk";

type ThemeId = "dark" | "night" | "light";

/** One Windows 11 style setting row: icon tile, title and description, control on the right. */
const SettingRow: React.FC<{
  icon: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  control?: React.ReactNode;
  children?: React.ReactNode;
}> = ({ icon, title, description, control, children }) => (
  <div className="px-4 py-3">
    <div className="flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div className="w-8 h-8 shrink-0 rounded-md bg-[var(--fill-subtle)] flex items-center justify-center text-[var(--text-secondary)] [&_svg]:w-4 [&_svg]:h-4">
          {icon}
        </div>
        <div className="min-w-0">
          <div className="text-sm text-[var(--text-primary)]">{title}</div>
          {description && <div className="text-xs text-[var(--text-secondary)] mt-0.5">{description}</div>}
        </div>
      </div>
      {control && <div className="shrink-0 flex items-center gap-2 sm:pl-0 pl-11">{control}</div>}
    </div>
    {children && <div className="mt-3 sm:pl-11">{children}</div>}
  </div>
);

const selectableClass = (selected: boolean) =>
  `rounded-md border text-left transition-colors cursor-pointer ${
    selected
      ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]"
      : "border-[var(--border-card)] bg-[var(--fill-subtle)] hover:bg-[var(--fill-subtle-hover)]"
  }`;

/** Tiny window preview drawn with the theme's own tokens (scoped via data-theme). */
const ThemeSwatch: React.FC<{ theme: ThemeId }> = ({ theme }) => (
  <div
    data-theme={theme}
    className="h-14 w-full rounded border border-[var(--border-card)] bg-[var(--bg-shell)] p-1.5 flex gap-1.5 overflow-hidden"
  >
    <div className="w-5 rounded-sm bg-[var(--bg-sidebar)] flex flex-col gap-1 pt-1 items-center">
      <span className="w-3 h-1 rounded-full bg-[var(--accent)]" />
      <span className="w-3 h-1 rounded-full bg-[var(--fill-subtle-hover)]" />
      <span className="w-3 h-1 rounded-full bg-[var(--fill-subtle-hover)]" />
    </div>
    <div className="flex-1 rounded-sm bg-[var(--bg-page)] p-1.5 space-y-1">
      <div className="h-1.5 w-10 rounded-full bg-[var(--text-primary)] opacity-80" />
      <div className="h-4 rounded-sm bg-[var(--bg-card)] border border-[var(--border-card)]" />
    </div>
  </div>
);

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
      setManualCheckMsg(t.settings.upToDate.replace("{version}", APP_VERSION));
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

  const themes: { id: ThemeId; label: string; desc: string }[] = [
    { id: "dark", label: t.settings.themeDark, desc: t.settings.themeDarkDesc },
    { id: "night", label: t.settings.themeNight, desc: t.settings.themeNightDesc },
    { id: "light", label: t.settings.themeLight, desc: t.settings.themeLightDesc },
  ];

  const links: { label: string; url: string; icon: React.ReactNode }[] = [
    {
      label: t.settings.repoLink,
      url: REPO_URL,
      icon: (
        <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24" aria-hidden>
          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
        </svg>
      ),
    },
    { label: t.settings.releaseNotes, url: `${REPO_URL}/releases`, icon: <Open20Regular className="w-4 h-4" /> },
    { label: t.settings.reportIssue, url: `${REPO_URL}/issues`, icon: <QuestionCircle20Regular className="w-4 h-4" /> },
    { label: t.settings.license, url: `${REPO_URL}/blob/main/LICENSE`, icon: <Open20Regular className="w-4 h-4" /> },
  ];

  return (
    <Page className="select-none">
      <PageHeader
        icon={<Settings20Regular />}
        title={
          <span className="inline-flex items-center gap-3">
            {t.settings.title}
            <Badge className="font-ibm-mono">v{APP_VERSION}</Badge>
          </span>
        }
        description={t.settings.pageDesc}
      />

      {/* Appearance */}
      <div className="space-y-2">
        <SectionTitle>{t.settings.appearanceSection}</SectionTitle>
        <Card padded={false} className="divide-y divide-[var(--border-divider)]">
          <SettingRow icon={<Color20Regular />} title={t.settings.themeTitle} description={t.settings.themeDesc}>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {themes.map((th) => (
                <button
                  key={th.id}
                  onClick={() => setTheme(th.id)}
                  aria-pressed={theme === th.id}
                  className={`${selectableClass(theme === th.id)} p-2 space-y-2`}
                >
                  <ThemeSwatch theme={th.id} />
                  <div className="flex items-center justify-between gap-2 px-0.5">
                    <div className="min-w-0">
                      <div className="text-sm text-[var(--text-primary)] truncate">{th.label}</div>
                      <div className="text-xs text-[var(--text-muted)] truncate">{th.desc}</div>
                    </div>
                    {theme === th.id && <CheckmarkCircle20Filled className="w-4 h-4 shrink-0 text-[var(--accent-text)]" />}
                  </div>
                </button>
              ))}
            </div>
          </SettingRow>

          <SettingRow icon={<LocalLanguage20Regular />} title={t.settings.language} description={t.settings.languageDesc}>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
              {SUPPORTED_LANGUAGES.map((lang) => (
                <button
                  key={lang.code}
                  onClick={() => setLocale(lang.code)}
                  aria-pressed={locale === lang.code}
                  className={`${selectableClass(locale === lang.code)} h-10 px-3 flex items-center gap-2 min-w-0`}
                >
                  <span className="text-base leading-none">{lang.flag}</span>
                  <span className="text-sm text-[var(--text-primary)] truncate flex-1">{lang.nativeName}</span>
                  <span className="text-xs text-[var(--text-muted)] font-ibm-mono">{lang.code}</span>
                </button>
              ))}
            </div>
          </SettingRow>
        </Card>
      </div>

      {/* Updates */}
      <div className="space-y-2">
        <SectionTitle>{t.settings.updatesSection}</SectionTitle>
        <Card padded={false} className="divide-y divide-[var(--border-divider)]">
          <SettingRow
            icon={<ArrowSync20Regular />}
            title={t.settings.autoCheckTitle}
            description={t.settings.autoUpdateDesc}
            control={<WinUIToggle checked={autoCheckUpdates} onChange={setAutoCheckUpdates} />}
          />
          <SettingRow
            icon={<ArrowClockwise20Regular />}
            title={t.settings.checkForUpdates}
            description={t.settings.currentVersionDesc.replace("{version}", APP_VERSION)}
            control={
              <WinUIButton
                variant="standard"
                onClick={handleCheckUpdates}
                disabled={isChecking}
                icon={<ArrowClockwise20Regular className={`w-4 h-4 ${isChecking ? "animate-spin" : ""}`} />}
              >
                {isChecking ? t.common.scanning : t.settings.checkForUpdates}
              </WinUIButton>
            }
          >
            {(manualCheckMsg || updateAvailable) && (
              <div className="space-y-2">
                {manualCheckMsg && (
                  <div className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                    <CheckmarkCircle20Filled className="w-4 h-4 shrink-0 text-[var(--success)]" />
                    <span>{manualCheckMsg}</span>
                  </div>
                )}
                {updateAvailable && (
                  <div className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                    <Sparkle20Filled className="w-4 h-4 shrink-0 text-[var(--accent-text)]" />
                    <span>{t.settings.updateAvailableMsg.replace("{version}", version)}</span>
                  </div>
                )}
              </div>
            )}
          </SettingRow>
        </Card>
      </div>

      {/* Cleaning & safety */}
      <div className="space-y-2">
        <SectionTitle>{t.settings.safetySection}</SectionTitle>
        <Card padded={false} className="divide-y divide-[var(--border-divider)]">
          <SettingRow
            icon={<Delete20Regular />}
            title={t.settings.alwaysTrash}
            description={t.settings.alwaysTrashDesc}
            control={<WinUIToggle checked={alwaysTrashOverride} onChange={setAlwaysTrashOverride} />}
          />
          <SettingRow
            icon={<ShieldCheckmark20Regular />}
            title={t.settings.confirmDelete}
            description={t.settings.confirmDeleteDesc}
            control={<WinUIToggle checked={confirmBeforeDelete} onChange={setConfirmBeforeDelete} />}
          />
          <SettingRow
            icon={<DocumentSearch20Regular />}
            title={t.settings.thresholdTitle}
            description={t.settings.thresholdDesc}
            control={
              <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-[var(--bg-input)] border border-[var(--border-card)]">
                {[100, 250, 500, 1024].map((mb) => (
                  <button
                    key={mb}
                    onClick={() => setLargeFileThresholdMb(mb)}
                    aria-pressed={largeFileThresholdMb === mb}
                    className={`h-7 px-2.5 rounded text-xs font-ibm-mono transition-colors cursor-pointer ${
                      largeFileThresholdMb === mb
                        ? "bg-[var(--accent)] text-white font-medium"
                        : "text-[var(--text-secondary)] hover:bg-[var(--fill-subtle)] hover:text-[var(--text-primary)]"
                    }`}
                  >
                    {mb >= 1024 ? "≥ 1 GB" : `≥ ${mb} MB`}
                  </button>
                ))}
              </div>
            }
          />
          <SettingRow
            icon={<Info20Regular />}
            title={t.settings.exclusionsTitle}
            description={t.settings.exclusionsDesc}
            control={<Badge tone="success">{t.common.enabled}</Badge>}
          />
        </Card>
      </div>

      {/* About */}
      <div className="space-y-2">
        <SectionTitle>{t.settings.aboutSection}</SectionTitle>
        <Card padded={false} className="divide-y divide-[var(--border-divider)]">
          <div className="px-4 py-4 flex items-center gap-4">
            <img
              src="/logo.png"
              alt="FreeMyDisk"
              className="w-12 h-12 object-contain rounded-lg p-1 bg-[var(--fill-subtle)] border border-[var(--border-card)] shrink-0"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-[var(--text-primary)]">FreeMyDisk</span>
                <Badge tone="accent" className="font-ibm-mono">v{APP_VERSION}</Badge>
              </div>
              <div className="text-xs text-[var(--text-secondary)] mt-0.5">{t.settings.aboutDesc}</div>
              <div className="text-xs text-[var(--text-muted)] mt-0.5">{t.settings.builtWith}</div>
            </div>
          </div>
          <div className="px-4 py-3 flex flex-wrap items-center gap-2">
            <Badge>{t.settings.badgeSafety}</Badge>
            <Badge>{t.settings.badgeCore}</Badge>
            <Badge>{t.settings.badgeOffline}</Badge>
          </div>
          <div className="px-2 py-2 flex flex-wrap items-center gap-1">
            {links.map((l) => (
              <WinUIButton
                key={l.url}
                variant="subtle"
                onClick={() => handleOpenLink(l.url)}
                icon={<span className="text-[var(--accent-text)] flex">{l.icon}</span>}
              >
                {l.label}
              </WinUIButton>
            ))}
          </div>
        </Card>
      </div>
    </Page>
  );
};

export default SettingsPage;
