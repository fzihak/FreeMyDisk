import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18nStore } from "@/i18n";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { Page, PageHeader, Card, StatCard, Badge, FilterTabs, EmptyState } from "@/components/ui";
import {
  History20Regular,
  Delete20Regular,
  Clock20Regular,
  CheckmarkCircle20Filled,
  CheckmarkCircle20Regular,
  Warning20Filled,
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

type StatusFilter = "all" | "completed" | "failed";

const isSuccessStatus = (status: string) => status === "completed" || status === "resolved_manual";
const isFailedStatus = (status: string) => status.startsWith("failed");

export const HistoryPage: React.FC = () => {
  const { t } = useI18nStore();
  const [historyRecords, setHistoryRecords] = useState<HistoryRecord[]>([]);
  const [pendingReboots, setPendingReboots] = useState<PendingRebootItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

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
      setActionMessage(t.history.clearFailed);
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
      setActionMessage(t.history.cancelRebootFailed);
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
  const failedCount = historyRecords.filter((r) => isFailedStatus(r.status)).length;
  const successCount = historyRecords.filter((r) => isSuccessStatus(r.status)).length;

  const visibleRecords = useMemo(
    () =>
      historyRecords.filter((r) =>
        statusFilter === "completed"
          ? isSuccessStatus(r.status)
          : statusFilter === "failed"
          ? isFailedStatus(r.status)
          : true
      ),
    [historyRecords, statusFilter]
  );

  const actionIsError = actionMessage !== null && actionMessage !== t.common.success;

  const statusBadge = (status: string) =>
    isSuccessStatus(status) ? (
      <Badge tone="success">{t.history.statusCompleted}</Badge>
    ) : isFailedStatus(status) ? (
      <Badge tone="danger">{t.history.statusFailed}</Badge>
    ) : (
      <Badge>{status.replace(/_/g, " ")}</Badge>
    );

  const thClass = "sticky top-0 z-[1] bg-[var(--bg-card)] px-4 py-2.5 text-xs font-medium text-[var(--text-secondary)] border-b border-[var(--border-divider)]";

  return (
    <Page className="select-none">
      <PageHeader
        icon={<History20Regular />}
        title={t.history.title}
        description={t.history.pageDesc}
        actions={
          <>
            {historyRecords.length > 0 && (
              <WinUIButton
                variant="subtle"
                onClick={() => setConfirmClearOpen(true)}
                disabled={clearing || loading}
                className="!text-[var(--danger)]"
                icon={<Delete20Regular className="w-4 h-4" />}
              >
                {clearing ? t.history.clearing : t.history.clearHistory}
              </WinUIButton>
            )}
            <WinUIButton
              variant="standard"
              onClick={fetchAll}
              disabled={loading}
              icon={<ArrowClockwise20Regular className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />}
            >
              {loading ? t.common.scanning : t.common.refresh}
            </WinUIButton>
          </>
        }
      />

      {actionMessage && (
        <Card className="py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            {actionIsError ? (
              <Warning20Filled className="w-4 h-4 shrink-0 text-[var(--danger)]" />
            ) : (
              <CheckmarkCircle20Filled className="w-4 h-4 shrink-0 text-[var(--success)]" />
            )}
            <span
              className={`text-sm truncate ${actionIsError ? "text-[var(--danger)]" : "text-[var(--text-primary)]"}`}
              title={actionMessage}
            >
              {actionMessage}
            </span>
          </div>
          <WinUIButton variant="subtle" size="sm" onClick={() => setActionMessage(null)}>
            {t.common.close}
          </WinUIButton>
        </Card>
      )}

      {/* Stat row */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label={t.history.statRecords}
          value={historyRecords.length}
          hint={t.history.sqliteJournalBadge}
          icon={<DocumentText20Regular />}
        />
        <StatCard
          label={t.history.statusCompleted}
          value={completedCount}
          hint={
            failedCount > 0
              ? t.history.failedHint.replace("{count}", String(failedCount))
              : t.history.allCleanHint
          }
          icon={<CheckmarkCircle20Regular />}
          tone={failedCount > 0 ? "warning" : "neutral"}
        />
        <StatCard
          label={t.history.statPending}
          value={pendingReboots.length}
          hint={t.history.lockedQueueBadge}
          icon={<Clock20Regular />}
        />
      </div>

      {/* Pending reboot deletions */}
      {pendingReboots.length > 0 && (
        <Card padded={false} className="overflow-hidden">
          <div className="px-4 py-3 flex items-start justify-between gap-3 border-b border-[var(--border-divider)]">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t.history.pendingRebootTitle}</h2>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">{t.history.pendingRebootDesc}</p>
            </div>
            <Badge tone="warning">{t.history.queuedCount.replace("{count}", String(pendingReboots.length))}</Badge>
          </div>
          <div className="divide-y divide-[var(--border-divider)]">
            {pendingReboots.map((item, idx) => {
              const display = formatDisplayPath(item.path);
              return (
                <div
                  key={idx}
                  className="px-4 py-3 flex items-center gap-3 hover:bg-[var(--fill-subtle)] transition-colors"
                >
                  <div
                    className="flex-1 min-w-0 font-code text-xs text-[var(--text-secondary)] truncate select-all"
                    title={display}
                  >
                    {display}
                  </div>
                  <span className="w-20 shrink-0 text-right text-xs text-[var(--text-secondary)] font-ibm-mono">
                    {item.size_bytes ? `${Math.round(item.size_bytes / 1024)} KB` : "—"}
                  </span>
                  <span title={t.history.cancelRebootAction}>
                    <WinUIButton
                      variant="subtle"
                      size="sm"
                      onClick={() => handleCancelRebootDeletion(item.path)}
                      className="!text-[var(--danger)]"
                      aria-label={t.history.cancelRebootAction}
                    >
                      {t.common.cancel}
                    </WinUIButton>
                  </span>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Cleanup history */}
      {historyRecords.length === 0 ? (
        <EmptyState
          icon={<History20Regular />}
          title={t.history.noHistoryFound}
          description={t.history.noHistoryDesc}
        />
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <FilterTabs<StatusFilter>
              items={[
                { id: "all", label: t.history.filterAll, count: historyRecords.length },
                { id: "completed", label: t.history.statusCompleted, count: successCount },
                { id: "failed", label: t.history.statusFailed, count: failedCount },
              ]}
              value={statusFilter}
              onChange={setStatusFilter}
              className="min-w-0"
            />
          </div>

          <Card padded={false} className="overflow-hidden">
            <div className="max-h-[560px] overflow-auto">
              <table className="w-full table-fixed text-left">
                <colgroup>
                  <col className="w-[150px]" />
                  <col />
                  <col className="w-[150px]" />
                  <col className="w-[120px]" />
                </colgroup>
                <thead>
                  <tr>
                    <th className={thClass}>{t.history.timestamp}</th>
                    <th className={thClass}>{t.history.targetPath}</th>
                    <th className={thClass}>{t.history.plannedAction}</th>
                    <th className={`${thClass} text-right`}>{t.history.status}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-divider)]">
                  {visibleRecords.map((rec) => {
                    const display = formatDisplayPath(rec.target_path);
                    return (
                      <tr key={rec.id} className="hover:bg-[var(--fill-subtle)] transition-colors">
                        <td className="px-4 py-3 text-xs text-[var(--text-muted)] whitespace-nowrap font-ibm-mono">
                          {formatDate(rec.timestamp)}
                        </td>
                        <td className="px-4 py-3 min-w-0">
                          <div
                            className="font-code text-xs text-[var(--text-secondary)] truncate select-all"
                            title={display}
                          >
                            {display}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <Badge className="max-w-full overflow-hidden">
                            <span className="truncate">{rec.planned_action.replace(/_/g, " ")}</span>
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-right">{statusBadge(rec.status)}</td>
                      </tr>
                    );
                  })}
                  {visibleRecords.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-4 py-8 text-center text-sm text-[var(--text-secondary)]">
                        {t.history.noFilterMatch}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {/* Clear confirmation */}
      {confirmClearOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fadeIn">
          <Card className="max-w-md w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] flex items-center justify-center text-[var(--danger)] shrink-0">
                <Warning20Filled className="w-5 h-5" />
              </div>
              <div className="space-y-1 min-w-0">
                <h3 className="text-base font-semibold text-[var(--text-primary)]">{t.history.clearHistory}</h3>
                <p className="text-sm text-[var(--text-secondary)]">{t.history.clearConfirmText}</p>
              </div>
            </div>
            <p className="text-sm text-[var(--text-secondary)]">{t.history.clearConfirmWarning}</p>
            <div className="flex justify-end gap-2 pt-1">
              <WinUIButton variant="standard" onClick={() => setConfirmClearOpen(false)} disabled={clearing}>
                {t.common.cancel}
              </WinUIButton>
              <WinUIButton
                variant="danger"
                onClick={handleClearHistory}
                disabled={clearing}
                icon={<Delete20Regular className="w-4 h-4" />}
              >
                {clearing ? t.history.clearing : t.history.clearHistory}
              </WinUIButton>
            </div>
          </Card>
        </div>
      )}
    </Page>
  );
};

export default HistoryPage;
