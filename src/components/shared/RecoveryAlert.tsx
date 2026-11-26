import React, { useEffect, useState } from "react";
import { Warning20Filled, Dismiss16Regular } from "@fluentui/react-icons";
import { invoke } from "@tauri-apps/api/core";
import { useI18nStore } from "@/i18n";

interface RecoveryStatus {
  has_interrupted: boolean;
  interrupted_count: number;
}

interface RecoveryAlertProps {
  onNavigateToHistory: () => void;
}

export const RecoveryAlert: React.FC<RecoveryAlertProps> = ({ onNavigateToHistory }) => {
  const { t } = useI18nStore();
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    async function checkRecovery() {
      try {
        const res = await invoke<RecoveryStatus>("get_recovery_status");
        setStatus(res);
      } catch {
        // Silent catch if Tauri backend is running in test/mock environment
      }
    }
    checkRecovery();
  }, []);

  if (!status || !status.has_interrupted || dismissed) {
    return null;
  }

  const handleDismiss = async () => {
    setDismissed(true);
    try {
      await invoke("acknowledge_recovery_banner");
    } catch (e) {
      console.error("Failed to acknowledge recovery banner:", e);
    }
  };

  const handleRestoreNow = async () => {
    try {
      await invoke("remediate_interrupted_session");
      await invoke("acknowledge_recovery_banner");
      setDismissed(true);
    } catch (e) {
      console.error("Failed to remediate session:", e);
    }
  };

  return (
    <div className="bg-amber-500/10 border-b border-amber-500/30 px-4 py-2 text-xs text-amber-300 backdrop-blur-md select-none font-sans">
      <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Warning20Filled className="w-4 h-4 text-amber-400 shrink-0" />
          <span>
            The previous cleanup session was interrupted unexpectedly.{" "}
            <span className="font-semibold text-amber-100 font-ibm-mono">
              {status.interrupted_count} {t.cleanup.itemsSelected}.
            </span>
          </span>
          <button
            onClick={handleRestoreNow}
            className="bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/30 px-2 py-0.5 rounded text-xs cursor-pointer ml-1 transition-colors"
          >
            Review & Restore
          </button>
          <button
            onClick={onNavigateToHistory}
            className="text-amber-300 hover:text-amber-100 underline text-xs ml-1 cursor-pointer"
          >
            [{t.history.title}]
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleDismiss}
            className="text-amber-400 hover:text-amber-200 text-xs px-2 py-1 cursor-pointer transition-colors"
          >
            {t.common.dismiss}
          </button>
          <button
            onClick={handleDismiss}
            aria-label="Close recovery banner"
            className="text-amber-400 hover:text-amber-200 p-1 rounded-lg hover:bg-white/[0.08] cursor-pointer transition-colors"
          >
            <Dismiss16Regular className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default RecoveryAlert;
