import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18nStore } from "@/i18n";
import { WinUICard } from "@/components/winui/WinUICard";
import { WinUIButton } from "@/components/winui/WinUIButton";
import {
  History24Filled,
  Delete20Regular,
  Clock20Regular,
  CheckmarkCircle20Filled,
  Warning20Filled,
  DismissCircle20Filled,
  Info20Filled,
  DocumentText20Regular,
  ArrowClockwise20Regular,
} from "@fluentui/react-icons";

export interface HistoryRecord {
  id: number;
  session_id: string;
  target_path: string;
  staging_path?: string | null;
  planned_action: string;
  status: string;
  timestamp: number;
}

export interface PendingRebootItem {
  path: string;
  size_bytes: number;
}

/**
 * Display form of a path recorded by the backend. Pending reboot deletions come
 * straight from the PendingFileRenameOperations registry value, whose entries look
 * like `*1!\??\C:\ProgramData\...`; strip the `*N!` marker and the NT `\??\`
 * prefix, and normalise mixed separators to backslashes for Windows-style paths.
 */
export const formatDisplayPath = (raw: string): string => {
  let path = raw.trim().replace(/^\*\d+!/, "");
  // NT object prefix `\??\` and Win32 long-path prefix `\\?\`
  path = path.replace(/^\\(?:\?\?|\\\?)\\/, "");
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")) {
    path = path.replace(/\//g, "\\");
  }
  return path;
};

export const HistoryPage: React.FC = () => {
  const { t } = useI18nStore();
  const [historyRecords, setHistoryRecords] = useState<HistoryRecord[]>([]);
  const [pendingReboots, setPendingReboots] = useState<PendingRebootItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [hist, reboots] = await Promise.all([
        invoke<HistoryRecord[]>("get_cleanup_history", { limit: 100 }),
        invoke<PendingRebootItem[]>("get_pending_reboot_deletions"),
      ]);
      setHistoryRecords(hist);
      setPendingReboots(reboots);
    } catch (e) {
      console.error("Failed to fetch history:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
  }, []);

  const handleClearHistory = async () => {
    setClearing(true);
    try {
      await invoke("clear_cleanup_history");
      setHistoryRecords([]);
      setConfirmClearOpen(false);
      setActionMessage(t.common.success);
      setTimeout(() => setActionMessage(null), 4000);
    } catch (e) {
      console.error("Failed to clear history:", e);
      setActionMessage("Failed to clear history.");
    } finally {
      setClearing(false);
    }
  };

  const handleCancelRebootDeletion = async (path: string) => {
    try {
      await invoke("cancel_reboot_deletion", { path });
      setPendingReboots((prev) => prev.filter((p) => p.path !== path));
      setActionMessage(t.common.success);
      setTimeout(() => setActionMessage(null), 4000);
    } catch (e) {
      console.error("Failed to cancel reboot deletion:", e);
      setActionMessage("Failed to cancel scheduled reboot deletion.");
    }
  };

  const formatDate = (timestampSecs: number) => {
    const date = new Date(timestampSecs * 1000);
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const completedCount = historyRecords.filter((r) => r.status === "completed").length;
  const failedCount = historyRecords.filter((r) => r.status.startsWith("failed")).length;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4 select-none font-sans text-[var(--text-primary)] pb-24">
      {/* WinUI 3 Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-[4px] bg-white/[0.04] border border-[var(--border-subtle)] flex items-center justify-center text-[#0078d4] shrink-0">
            <History24Filled className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">{t.history.title}</h1>
            <p className="text-xs text-[var(--text-secondary)]">
              {t.history.subtitle}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          {historyRecords.length > 0 && (
            <WinUIButton
              variant="subtle"
              onClick={() => setConfirmClearOpen(true)}
              disabled={clearing || loading}
              className="flex items-center gap-1.5 text-rose-400"
            >
              <Delete20Regular className="w-3.5 h-3.5" />
              <span>{clearing ? t.history.clearing : t.history.clearHistory}</span>
            </WinUIButton>
          )}

          <WinUIButton
            variant="primary"
            onClick={fetchAll}
            disabled={loading}
            className="flex items-center gap-1.5"
          >
            <ArrowClockwise20Regular className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            <span>{loading ? t.common.scanning : t.common.refresh}</span>
          </WinUIButton>
        </div>
      </div>

      {actionMessage && (
        <div className="p-3 bg-[#0078d4]/10 border border-[#0078d4]/30 rounded-[4px] flex items-center justify-between text-xs text-[#0078d4] animate-fadeIn">
          <span>{actionMessage}</span>
          <button onClick={() => setActionMessage(null)} className="text-[#0078d4] hover:underline cursor-pointer">
            {t.common.close}
          </button>
        </div>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 font-ibm-mono">
        <WinUICard className="p-3.5">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1 font-sans">
            <span className="font-medium text-xs">{t.history.journalTitle}</span>
            <DocumentText20Regular className="w-3.5 h-3.5 text-[#0078d4]" />
          </div>
          <div className="text-xl font-bold text-[var(--text-primary)] tabular-nums">{historyRecords.length}</div>
          <div className="text-xs text-[var(--text-muted)] mt-0.5 font-sans">Recorded in SQLite journal</div>
        </WinUICard>

        <WinUICard className="p-3.5">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1 font-sans">
            <span className="font-medium text-xs">{t.history.statusCompleted}</span>
            <CheckmarkCircle20Filled className="w-3.5 h-3.5 text-emerald-400" />
          </div>
          <div className="text-xl font-bold text-emerald-400 tabular-nums">{completedCount}</div>
          <div className="text-xs text-[var(--text-muted)] mt-0.5 font-sans">
            {failedCount > 0 ? `${failedCount} failed items` : "All files cleanly removed"}
          </div>
        </WinUICard>

        <WinUICard className="p-3.5">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] mb-1 font-sans">
            <span className="font-medium text-xs">{t.history.pendingRebootTitle}</span>
            <Clock20Regular className="w-3.5 h-3.5 text-amber-400" />
          </div>
          <div className="text-xl font-bold text-amber-400 tabular-nums">{pendingReboots.length}</div>
          <div className="text-xs text-[var(--text-muted)] mt-0.5 font-sans">Locked system files queue</div>
        </WinUICard>
      </div>

      {/* Section 1: Pending on Next Restart (if any) */}
      {pendingReboots.length > 0 && (
        <WinUICard className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-[4px] bg-amber-500/10 border border-amber-500/20 text-amber-400">
                <Warning20Filled className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-xs font-semibold text-[var(--text-primary)]">{t.history.pendingRebootTitle}</h2>
                <p className="text-xs text-[var(--text-secondary)]">
                  {t.history.pendingRebootDesc}
                </p>
              </div>
            </div>
            <span className="px-2 py-0.5 rounded-[3px] text-xs font-semibold bg-amber-500/10 border border-amber-500/30 text-amber-300 font-ibm-mono">
              {pendingReboots.length} queued
            </span>
          </div>

          <div className="rounded-[4px] overflow-hidden border border-[var(--border-card)]">
            <table className="w-full text-left text-xs font-ibm-mono">
              <thead className="bg-black/20 text-[var(--text-secondary)] uppercase tracking-wider text-xs">
                <tr>
                  <th className="p-2.5">{t.history.targetPath}</th>
                  <th className="p-2.5">{t.common.size}</th>
                  <th className="p-2.5 text-right">{t.history.plannedAction}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-divider)]">
                {pendingReboots.map((item, idx) => (
                  <tr key={idx} className="hover:bg-white/[0.02] transition-colors">
                    <td className="p-2.5 text-[var(--text-primary)] break-all text-xs select-all" title={item.path}>{formatDisplayPath(item.path)}</td>
                    <td className="p-2.5 text-[var(--text-secondary)] font-medium tabular-nums">
                      {item.size_bytes ? `${Math.round(item.size_bytes / 1024)} KB` : "—"}
                    </td>
                    <td className="p-2.5 text-right">
                      <WinUIButton
                        variant="subtle"
                        onClick={() => handleCancelRebootDeletion(item.path)}
                        className="text-xs text-rose-400 py-0.5 px-2"
                      >
                        {t.history.cancelRebootAction}
                      </WinUIButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </WinUICard>
      )}

      {/* Section 2: Recent Cleanup Timeline */}
      <WinUICard className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-[4px] bg-[#0078d4]/10 border border-[#0078d4]/20 text-[#0078d4]">
              <Clock20Regular className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-xs font-semibold text-[var(--text-primary)]">{t.history.journalTitle}</h2>
              <p className="text-xs text-[var(--text-secondary)]">{t.history.subtitle}</p>
            </div>
          </div>
          <span className="text-xs text-[var(--text-muted)] font-ibm-mono">
            {historyRecords.length} record{historyRecords.length === 1 ? "" : "s"}
          </span>
        </div>

        {historyRecords.length === 0 ? (
          <div className="p-10 text-center text-xs text-[var(--text-muted)] border border-dashed border-[var(--border-card)] rounded-[4px] bg-black/10 space-y-1.5">
            <CheckmarkCircle20Filled className="w-6 h-6 text-[var(--text-muted)] mx-auto" />
            <p className="font-semibold text-[var(--text-primary)]">{t.history.noHistoryFound}</p>
            <p className="text-xs text-[var(--text-secondary)] max-w-sm mx-auto">
              {t.history.noHistoryDesc}
            </p>
          </div>
        ) : (
          <div className="rounded-[4px] overflow-hidden border border-[var(--border-card)]">
            <table className="w-full text-left text-xs font-ibm-mono">
              <thead className="bg-black/20 text-[var(--text-secondary)] uppercase tracking-wider text-xs">
                <tr>
                  <th className="p-2.5">{t.history.timestamp}</th>
                  <th className="p-2.5">{t.history.targetPath}</th>
                  <th className="p-2.5">{t.history.plannedAction}</th>
                  <th className="p-2.5 text-right">{t.history.status}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-divider)]">
                {historyRecords.map((rec) => {
                  const isSuccess = rec.status === "completed" || rec.status === "resolved_manual";
                  const isFail = rec.status.startsWith("failed");

                  return (
                    <tr key={rec.id} className="hover:bg-white/[0.02] transition-colors">
                      <td className="p-2.5 text-[var(--text-secondary)] whitespace-nowrap text-xs font-medium tabular-nums">
                        {formatDate(rec.timestamp)}
                      </td>
                      <td className="p-2.5 text-[var(--text-primary)] text-xs break-all select-all">
                        {formatDisplayPath(rec.target_path)}
                      </td>
                      <td className="p-2.5 text-[var(--text-secondary)] whitespace-nowrap">
                        <span className="px-1.5 py-0.2 rounded-[3px] bg-black/20 text-xs uppercase font-ibm-mono text-[var(--text-secondary)]">
                          {rec.planned_action.replace(/_/g, " ")}
                        </span>
                      </td>
                      <td className="p-2.5 text-right whitespace-nowrap">
                        {isSuccess ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400 font-sans">
                            <CheckmarkCircle20Filled className="w-3.5 h-3.5" />
                            {t.history.statusCompleted}
                          </span>
                        ) : isFail ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-rose-400 font-sans">
                            <DismissCircle20Filled className="w-3.5 h-3.5" />
                            {t.history.statusFailed}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-400 font-sans">
                            <Info20Filled className="w-3.5 h-3.5" />
                            {rec.status}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </WinUICard>

      {/* Confirmation Modal */}
      {confirmClearOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fadeIn">
          <WinUICard className="p-5 max-w-md w-full shadow-2xl space-y-3">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-[4px] bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400 shrink-0">
                <Warning20Filled className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t.history.clearHistory}</h3>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">Are you sure you want to clear past cleanup logs?</p>
              </div>
            </div>
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              This action will permanently erase your audit trail of cleaned items and crash recovery journals. This cannot be undone.
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <WinUIButton
                variant="subtle"
                onClick={() => setConfirmClearOpen(false)}
                disabled={clearing}
              >
                {t.common.cancel}
              </WinUIButton>
              <WinUIButton
                variant="danger"
                onClick={handleClearHistory}
                disabled={clearing}
                className="flex items-center gap-1.5"
              >
                <Delete20Regular className="w-3.5 h-3.5" />
                <span>{clearing ? t.history.clearing : t.history.clearHistory}</span>
              </WinUIButton>
            </div>
          </WinUICard>
        </div>
      )}
    </div>
  );
};

export default HistoryPage;
