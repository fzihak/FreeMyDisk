import React, { useEffect, useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18nStore } from "@/i18n";
import { WinUICard } from "@/components/winui/WinUICard";
import { WinUIButton } from "@/components/winui/WinUIButton";
import {
  Wrench24Filled,
  Wrench20Regular,
  Play20Filled,
  ArrowClockwise20Regular,
  Sparkle20Filled,
  CheckmarkCircle20Filled,
  Warning20Filled,
  ShieldCheckmark20Regular,
  Globe20Regular,
  Image20Regular,
  Search20Regular,
  Database20Regular,
  Pulse20Regular,
  Clock20Regular,
  DocumentText20Regular,
  Flash20Filled,
} from "@fluentui/react-icons";

export interface MaintenanceTask {
  id: string;
  title: string;
  description: string;
  category: string;
  risk_level: "Safe" | "Caution";
  recommended: boolean;
}

export interface TaskExecutionResult {
  task_id: string;
  success: boolean;
  message: string;
  duration_ms: number;
}

export const SystemMaintenancePage: React.FC = () => {
  const { t } = useI18nStore();
  const [tasks, setTasks] = useState<MaintenanceTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [results, setResults] = useState<Record<string, TaskExecutionResult>>({});

  const loadTasks = async () => {
    setLoading(true);
    try {
      const res = await invoke<MaintenanceTask[]>("get_maintenance_tasks");
      setTasks(res);
    } catch (e) {
      console.error("Failed to load maintenance tasks:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTasks();
  }, []);

  const handleRunTask = async (taskId: string) => {
    setRunningTaskId(taskId);
    try {
      const res = await invoke<TaskExecutionResult>("run_maintenance_task", { taskId });
      setResults((prev) => ({ ...prev, [taskId]: res }));
    } catch (e) {
      console.error(`Failed to execute task ${taskId}:`, e);
      setResults((prev) => ({
        ...prev,
        [taskId]: {
          task_id: taskId,
          success: false,
          message: `Execution failed: ${e}`,
          duration_ms: 0,
        },
      }));
    } finally {
      setRunningTaskId(null);
    }
  };

  const handleRunAllRecommended = async () => {
    const recommendedTasks = tasks.filter((t) => t.recommended);
    if (recommendedTasks.length === 0) return;

    setBatchRunning(true);
    try {
      for (const task of recommendedTasks) {
        setRunningTaskId(task.id);
        const res = await invoke<TaskExecutionResult>("run_maintenance_task", { taskId: task.id });
        setResults((prev) => ({ ...prev, [task.id]: res }));
      }
    } catch (e) {
      console.error("Batch maintenance execution failed:", e);
    } finally {
      setRunningTaskId(null);
      setBatchRunning(false);
    }
  };

  const getTaskIcon = (id: string) => {
    switch (id) {
      case "icon_cache":
        return <Image20Regular className="w-5 h-5 text-cyan-400" />;
      case "dns_flush":
        return <Globe20Regular className="w-5 h-5 text-emerald-400" />;
      case "search_index":
        return <Search20Regular className="w-5 h-5 text-amber-400" />;
      case "update_cache":
        return <Database20Regular className="w-5 h-5 text-purple-400" />;
      case "network_reset":
        return <ShieldCheckmark20Regular className="w-5 h-5 text-rose-400" />;
      case "print_queue":
        return <DocumentText20Regular className="w-5 h-5 text-indigo-400" />;
      case "audio_service":
        return <Flash20Filled className="w-5 h-5 text-yellow-400" />;
      case "time_sync":
        return <Clock20Regular className="w-5 h-5 text-teal-400" />;
      case "store_cache":
        return <Sparkle20Filled className="w-5 h-5 text-pink-400" />;
      case "system_integrity":
        return <Pulse20Regular className="w-5 h-5 text-emerald-400" />;
      default:
        return <Wrench20Regular className="w-5 h-5 text-[var(--text-muted)]" />;
    }
  };

  const safeCount = useMemo(() => tasks.filter((t) => t.risk_level === "Safe").length, [tasks]);
  const recommendedCount = useMemo(() => tasks.filter((t) => t.recommended).length, [tasks]);
  const executedResults = Object.values(results);
  const executedCount = executedResults.length;
  const failedCount = executedResults.filter((r) => !r.success).length;
  const allRecommendedDone =
    recommendedCount > 0 &&
    tasks.filter((task) => task.recommended).every((task) => results[task.id]?.success);
  const executedSubtitle =
    executedCount === 0
      ? t.maintenance.noTasksRunYet
      : failedCount > 0
      ? `${executedCount - failedCount} ${t.maintenance.tasksSucceeded} · ${failedCount} ${t.maintenance.tasksFailed}`
      : allRecommendedDone
      ? t.maintenance.allCompleted
      : `${executedCount} ${t.maintenance.tasksSucceeded}`;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-4 select-none font-sans text-[var(--text-primary)] pb-24">
      {/* WinUI 3 Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-[4px] bg-white/[0.04] border border-[var(--border-subtle)] flex items-center justify-center text-emerald-400 shrink-0">
            <Wrench24Filled className="w-6 h-6" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">
                {t.maintenance.title}
              </h1>
              <span className="px-2 py-0.5 rounded-[4px] text-xs font-ibm-mono uppercase tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                Windows Tools
              </span>
            </div>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">
              {t.maintenance.subtitle}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <WinUIButton
            variant="standard"
            onClick={loadTasks}
            disabled={loading}
            title={t.common.refresh}
            aria-label={t.common.refresh}
          >
            <ArrowClockwise20Regular className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </WinUIButton>

          <WinUIButton
            variant="primary"
            onClick={handleRunAllRecommended}
            disabled={batchRunning || runningTaskId !== null}
            className="flex items-center gap-1.5 whitespace-nowrap shrink-0 bg-emerald-600 hover:bg-emerald-500 text-white"
          >
            <Sparkle20Filled className={`w-3.5 h-3.5 ${batchRunning ? "animate-spin" : ""}`} />
            <span>{batchRunning ? t.maintenance.runningBatch : t.maintenance.runAllRecommended}</span>
          </WinUIButton>
        </div>
      </div>

      {/* 3-Tile Stat Strip with Generous Spacing */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 font-ibm-mono">
        <WinUICard className="p-5 flex flex-col justify-between space-y-3">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] font-sans">
            <span className="font-medium">{t.maintenance.availableTasks}</span>
            <Wrench20Regular className="w-4 h-4 text-emerald-400 shrink-0" />
          </div>
          <div>
            <div className="text-2xl font-bold text-[var(--text-primary)] tabular-nums">{tasks.length}</div>
            <div className="text-xs text-[var(--text-muted)] mt-1 font-sans">Windows Diagnostic & Repair Modules</div>
          </div>
        </WinUICard>

        <WinUICard className="p-5 flex flex-col justify-between space-y-3">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] font-sans">
            <span className="font-medium">{t.maintenance.recommendedBadge}</span>
            <ShieldCheckmark20Regular className="w-4 h-4 text-cyan-400 shrink-0" />
          </div>
          <div>
            <div className="text-2xl font-bold text-cyan-400 tabular-nums">
              {recommendedCount} / {tasks.length}
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-1 font-sans">
              {safeCount} / {tasks.length} {t.maintenance.riskSafe}
            </div>
          </div>
        </WinUICard>

        <WinUICard className="p-5 flex flex-col justify-between space-y-3">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] font-sans">
            <span className="font-medium">{t.maintenance.tasksRun}</span>
            <Pulse20Regular className="w-4 h-4 text-purple-400 shrink-0" />
          </div>
          <div>
            <div className="text-2xl font-bold text-purple-400 tabular-nums">
              {executedCount}
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-1 font-sans">{executedSubtitle}</div>
          </div>
        </WinUICard>
      </div>

      {/* Spacious Full-Width Maintenance Tasks List */}
      <div className="space-y-3 pt-2">
        <h2 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider px-1">
          Maintenance & Repair Actions
        </h2>

        <WinUICard className="divide-y divide-[var(--border-divider)]">
          {tasks.map((task) => {
            const isRunning = runningTaskId === task.id || (batchRunning && task.recommended);
            const result = results[task.id];

            return (
              <div
                key={task.id}
                className="p-5 flex flex-col md:flex-row md:items-center justify-between gap-5 hover:bg-white/[0.015] transition-colors"
              >
                <div className="flex items-start gap-4 flex-1 min-w-0">
                  <div className="w-10 h-10 rounded-lg bg-black/20 border border-[var(--border-card)] flex items-center justify-center shrink-0 mt-0.5">
                    {getTaskIcon(task.id)}
                  </div>
                  <div className="space-y-1.5 flex-1 min-w-0">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <h3 className="font-semibold text-[var(--text-primary)] text-sm">
                        {task.title}
                      </h3>
                      <span
                        className={`text-xs font-ibm-mono px-2 py-0.5 rounded font-medium uppercase tracking-wider ${
                          task.risk_level === "Safe"
                            ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                            : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                        }`}
                      >
                        {task.risk_level === "Safe" ? t.maintenance.riskSafe : t.maintenance.riskCaution}
                      </span>
                      {task.recommended && (
                        <span className="text-xs font-ibm-mono px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 uppercase font-medium">
                          {t.maintenance.recommendedBadge}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[var(--text-secondary)] leading-relaxed max-w-2xl">
                      {task.description}
                    </p>

                    {/* Status Output Banner */}
                    {result && (
                      <div
                        className={`p-3 rounded-lg border text-xs font-ibm-mono flex items-start gap-2.5 mt-2 animate-fadeIn ${
                          result.success
                            ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                            : "bg-rose-500/10 border-rose-500/30 text-rose-400"
                        }`}
                      >
                        {result.success ? (
                          <CheckmarkCircle20Filled className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                        ) : (
                          <Warning20Filled className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                        )}
                        <span className="leading-relaxed break-words">{result.message}</span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="shrink-0 self-end md:self-center">
                  <WinUIButton
                    variant="standard"
                    onClick={() => handleRunTask(task.id)}
                    disabled={isRunning}
                    className="flex items-center gap-2 px-4 py-2 text-xs"
                  >
                    {isRunning ? (
                      <>
                        <ArrowClockwise20Regular className="w-3.5 h-3.5 animate-spin text-cyan-400" />
                        <span>{t.maintenance.runningTask}</span>
                      </>
                    ) : (
                      <>
                        <Play20Filled className="w-3.5 h-3.5 text-emerald-400" />
                        <span>{t.maintenance.runTask}</span>
                      </>
                    )}
                  </WinUIButton>
                </div>
              </div>
            );
          })}
        </WinUICard>
      </div>
    </div>
  );
};

export default SystemMaintenancePage;
