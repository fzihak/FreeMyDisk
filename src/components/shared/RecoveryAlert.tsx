import React, { useEffect, useState } from "react";
import { Warning20Filled, Dismiss16Regular } from "@fluentui/react-icons";
import { invoke } from "@tauri-apps/api/core";
import { useI18nStore } from "@/i18n";
import { WinUIButton } from "@/components/winui/WinUIButton";

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
    <div className="px-4 pt-3 select-none font-sans">
      <div className="rounded-lg border border-[var(--border-card)] bg-[color-mix(in_srgb,var(--brand-amber)_10%,var(--bg-card))] px-3 py-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0 text-sm text-[var(--text-primary)]">
          <Warning20Filled className="w-4 h-4 text-[var(--brand-amber)] shrink-0" />
          <span className="truncate">
            {t.layout.recoveryMessage}{" "}
            <span className="font-semibold font-ibm-mono">
              {status.interrupted_count} {t.cleanup.itemsSelected}.
            </span>
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <WinUIButton variant="standard" size="sm" onClick={handleRestoreNow}>
            {t.layout.recoveryRestore}
          </WinUIButton>
          <WinUIButton variant="subtle" size="sm" onClick={onNavigateToHistory}>
            {t.history.title}
          </WinUIButton>
          <WinUIButton variant="subtle" size="sm" onClick={handleDismiss}>
            {t.common.dismiss}
          </WinUIButton>
          <button
            onClick={handleDismiss}
            aria-label="Close recovery banner"
            className="w-7 h-7 flex items-center justify-center rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--fill-subtle)] transition-colors cursor-pointer"
          >
            <Dismiss16Regular className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default RecoveryAlert;
