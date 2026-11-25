import React, { useState } from "react";
import { useUpdaterStore } from "@/stores/updater-store";
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
    <div className="bg-gradient-to-r from-blue-950/80 via-slate-900/90 to-blue-950/80 border-b border-blue-500/30 px-4 py-2 text-xs shadow-lg backdrop-blur-md transition-all select-none">
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-slate-200">
          <Sparkle20Filled className="w-4 h-4 text-blue-400 shrink-0" />
          <span>
            A new version of FreeMyDisk is available{" "}
            <span className="font-semibold text-blue-300 font-ibm-mono">({version ? `v${version}` : "Update"})</span>.
          </span>
          <button
            onClick={() => setShowNotes(!showNotes)}
            className="text-blue-400 hover:text-blue-300 underline text-xs ml-1 cursor-pointer transition-colors"
          >
            [See what's new]
          </button>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {updateReady ? (
            <button
              onClick={restartApp}
              className="bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-semibold px-3 py-1 rounded-lg text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <ArrowClockwise20Regular className="w-3.5 h-3.5" />
              Restart FreeMyDisk
            </button>
          ) : isDownloading ? (
            <div className="flex items-center gap-2">
              <div className="w-24 bg-slate-800 rounded-full h-2 overflow-hidden border border-white/[0.08]">
                <div
                  className="bg-blue-500 h-full transition-all duration-300 rounded-full"
                  style={{ width: `${downloadProgress}%` }}
                />
              </div>
              <span className="text-xs text-blue-400 font-ibm-mono">{downloadProgress}%</span>
            </div>
          ) : (
            <button
              onClick={downloadAndInstall}
              className="bg-blue-600 hover:bg-blue-500 text-white font-semibold px-3 py-1 rounded-lg text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <ArrowDownload20Regular className="w-3.5 h-3.5" />
              Update Now
            </button>
          )}

          <button
            onClick={dismissBanner}
            className="text-slate-400 hover:text-slate-200 text-xs px-2 py-1 transition-colors cursor-pointer"
          >
            Not now
          </button>

          <button
            onClick={dismissBanner}
            aria-label="Close banner"
            className="text-slate-400 hover:text-slate-200 p-1 rounded-lg hover:bg-white/[0.08] transition-colors cursor-pointer"
          >
            <Dismiss16Regular className="w-4 h-4" />
          </button>
        </div>
      </div>

      {showNotes && (
        <div className="max-w-7xl mx-auto mt-2 p-3 bg-slate-950/90 rounded-xl border border-blue-500/20 text-xs text-slate-300 font-ibm-mono">
          <p className="font-semibold text-slate-200 mb-1 font-sans">Release Highlights:</p>
          <p className="whitespace-pre-line text-slate-300">{releaseNotes}</p>
        </div>
      )}
    </div>
  );
};

export default UpdateBanner;
