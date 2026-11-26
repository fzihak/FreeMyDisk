import React from "react";
import { useUpdaterStore } from "@/stores/updater-store";
import { useI18nStore } from "@/i18n";
import { APP_VERSION } from "@/version";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { ProgressBar } from "@/components/ui";
import { Sparkle20Filled, Dismiss16Regular, ArrowDownload20Regular } from "@fluentui/react-icons";

const fill = (template: string, vars: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));

/**
 * Slim notice at the top of the page when an update is available. "Update now"
 * opens the details dialog, where the user confirms; nothing downloads before that.
 */
export const UpdateBanner: React.FC = () => {
  const { t } = useI18nStore();
  const { status, version, downloadProgress, dismissedThisSession, openDialog, dismissBanner } = useUpdaterStore();

  const active = status === "available" || status === "downloading" || status === "installing" || status === "error";
  if (!active || !version || dismissedThisSession) return null;

  const busy = status === "downloading" || status === "installing";

  return (
    <div className="px-4 pt-3 select-none" role="status">
      <div className="rounded-lg border border-[var(--border-card)] bg-[color-mix(in_srgb,var(--accent)_10%,var(--bg-card))] px-3 py-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0 text-sm">
          <Sparkle20Filled className="w-4 h-4 text-[var(--accent-text)] shrink-0" />
          <span className="truncate">
            <span className="font-semibold">{fill(t.layout.updateAvailableTitle, { version })}</span>{" "}
            <span className="text-[var(--text-secondary)]">
              {fill(t.layout.updateAvailableDesc, { current: APP_VERSION })}
            </span>
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {busy ? (
            <button onClick={openDialog} className="flex items-center gap-2" title={t.layout.updateDetails}>
              <ProgressBar value={Math.max(2, downloadProgress)} className="w-24" />
              <span className="text-xs text-[var(--text-secondary)] font-ibm-mono">{downloadProgress}%</span>
            </button>
          ) : (
            <>
              <WinUIButton
                variant="primary"
                size="sm"
                onClick={openDialog}
                icon={<ArrowDownload20Regular className="w-3.5 h-3.5" />}
              >
                {t.layout.updateBannerAction}
              </WinUIButton>
              <WinUIButton variant="subtle" size="sm" onClick={dismissBanner}>
                {t.layout.updateLater}
              </WinUIButton>
              <button
                onClick={dismissBanner}
                aria-label={t.layout.updateClose}
                className="w-7 h-7 flex items-center justify-center rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--fill-subtle)] transition-colors"
              >
                <Dismiss16Regular className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default UpdateBanner;
