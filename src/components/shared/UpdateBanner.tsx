import React, { useState } from "react";
import { useUpdaterStore } from "@/stores/updater-store";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { ProgressBar } from "@/components/ui";
import {
  Sparkle20Filled,
  Dismiss16Regular,
  ArrowDownload20Regular,
  ArrowClockwise20Regular,
} from "@fluentui/react-icons";

export const UpdateBanner: React.FC = () => {
  const {
    updateAvailable,
    version,
    releaseNotes,
    dismissedThisSession,
    isDownloading,
    downloadProgress,
    updateReady,
    dismissBanner,
    downloadAndInstall,
    restartApp,
  } = useUpdaterStore();

  const [showNotes, setShowNotes] = useState(false);

  if (!updateAvailable || dismissedThisSession) {
    return null;
  }

  return (
    <div className="px-4 pt-3 select-none">
      <div className="rounded-lg border border-[var(--border-card)] bg-[color-mix(in_srgb,var(--accent)_10%,var(--bg-card))] px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0 text-sm text-[var(--text-primary)]">
            <Sparkle20Filled className="w-4 h-4 text-[var(--accent-text)] shrink-0" />
            <span className="truncate">
              A new version of FreeMyDisk is available{" "}
              <span className="font-semibold font-ibm-mono">({version ? `v${version}` : "Update"})</span>.
            </span>
            <button
              onClick={() => setShowNotes(!showNotes)}
              className="text-xs text-[var(--accent-text)] hover:underline cursor-pointer shrink-0"
            >
              [See what's new]
            </button>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {updateReady ? (
              <WinUIButton
                variant="primary"
                size="sm"
                onClick={restartApp}
                icon={<ArrowClockwise20Regular className="w-3.5 h-3.5" />}
              >
                Restart FreeMyDisk
              </WinUIButton>
            ) : isDownloading ? (
              <div className="flex items-center gap-2">
                <ProgressBar value={downloadProgress} className="w-24" />
                <span className="text-xs text-[var(--text-secondary)] font-ibm-mono">{downloadProgress}%</span>
              </div>
            ) : (
              <WinUIButton
                variant="primary"
                size="sm"
                onClick={downloadAndInstall}
                icon={<ArrowDownload20Regular className="w-3.5 h-3.5" />}
              >
                Update Now
              </WinUIButton>
            )}

            <WinUIButton variant="subtle" size="sm" onClick={dismissBanner}>
              Not now
            </WinUIButton>

            <button
              onClick={dismissBanner}
              aria-label="Close banner"
              className="w-7 h-7 flex items-center justify-center rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--fill-subtle)] transition-colors cursor-pointer"
            >
              <Dismiss16Regular className="w-4 h-4" />
            </button>
          </div>
        </div>

        {showNotes && (
          <div className="mt-2 rounded-md border border-[var(--border-card)] bg-[var(--bg-card)] p-3 text-xs text-[var(--text-secondary)]">
            <p className="font-semibold text-[var(--text-primary)] mb-1">Release Highlights:</p>
            <p className="whitespace-pre-line">{releaseNotes}</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default UpdateBanner;
