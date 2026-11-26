import React, { useEffect, useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18nStore } from "@/i18n";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { Page, PageHeader, SectionTitle, Card, StatCard, Badge, riskTone, EmptyState } from "@/components/ui";
import {
  Wrench20Regular,
  Play20Regular,
  ArrowClockwise20Regular,
  Sparkle20Regular,
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
  Flash20Regular,
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
        return <Image20Regular />;
      case "dns_flush":
        return <Globe20Regular />;
      case "search_index":
        return <Search20Regular />;
      case "update_cache":
        return <Database20Regular />;
      case "network_reset":
        return <ShieldCheckmark20Regular />;
      case "print_queue":
        return <DocumentText20Regular />;
      case "audio_service":
        return <Flash20Regular />;
      case "time_sync":
        return <Clock20Regular />;
      case "store_cache":
        return <Sparkle20Regular />;
      case "system_integrity":
        return <Pulse20Regular />;
      default:
        return <Wrench20Regular />;
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
    <Page className="select-none">
      <PageHeader
        icon={<Wrench20Regular />}
        title={t.maintenance.title}
        description={t.maintenance.subtitle}
        actions={
          <>
            <span title={t.common.refresh}>
              <WinUIButton
                variant="standard"
                className="w-8 !px-0"
                onClick={loadTasks}
                disabled={loading}
                aria-label={t.common.refresh}
                icon={<ArrowClockwise20Regular className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />}
              />
            </span>
            <WinUIButton
              variant="primary"
              onClick={handleRunAllRecommended}
              disabled={batchRunning || runningTaskId !== null}
              icon={<Sparkle20Regular className={`w-4 h-4 ${batchRunning ? "animate-spin" : ""}`} />}
            >
              {batchRunning ? t.maintenance.runningBatch : t.maintenance.runAllRecommended}
            </WinUIButton>
          </>
        }
      />

      {/* Stat row */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label={t.maintenance.availableTasks}
          value={tasks.length}
          hint={t.maintenance.availableTasksHint}
          icon={<Wrench20Regular />}
        />
        <StatCard
          label={t.maintenance.recommendedBadge}
          value={`${recommendedCount} / ${tasks.length}`}
          hint={`${safeCount} / ${tasks.length} ${t.maintenance.riskSafe}`}
          icon={<ShieldCheckmark20Regular />}
        />
        <StatCard
          label={t.maintenance.tasksRun}
          value={executedCount}
          hint={executedSubtitle}
          icon={<Pulse20Regular />}
          tone={failedCount > 0 ? "danger" : executedCount > 0 ? "success" : "neutral"}
        />
      </div>

      {/* Task list */}
      <SectionTitle>{t.maintenance.tasksListTitle}</SectionTitle>

      {tasks.length === 0 ? (
        <EmptyState icon={<Wrench20Regular />} title={loading ? t.common.scanning : t.maintenance.noTasksFound} />
      ) : (
        <Card padded={false} className="overflow-hidden">
          <div className="divide-y divide-[var(--border-divider)]">
            {tasks.map((task) => {
              const isRunning = runningTaskId === task.id || (batchRunning && task.recommended);
              const result = results[task.id];

              return (
                <div
                  key={task.id}
                  className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3 hover:bg-[var(--fill-subtle)] transition-colors"
                >
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <div className="w-9 h-9 rounded-md bg-[var(--fill-subtle)] border border-[var(--border-card)] flex items-center justify-center shrink-0 text-[var(--text-secondary)] [&_svg]:w-5 [&_svg]:h-5">
                      {getTaskIcon(task.id)}
                    </div>
                    <div className="flex-1 min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-[var(--text-primary)]">{task.title}</span>
                        <Badge tone={riskTone(task.risk_level === "Safe" ? "safe" : "caution")}>
                          {task.risk_level === "Safe" ? t.maintenance.riskSafe : t.maintenance.riskCaution}
                        </Badge>
                        {task.recommended && <Badge tone="accent">{t.maintenance.recommendedBadge}</Badge>}
                      </div>
                      <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{task.description}</p>

                      {result && (
                        <div className="flex items-start gap-2 pt-1.5 animate-fadeIn">
                          <Badge tone={result.success ? "success" : "danger"} className="shrink-0">
                            {result.success ? (
                              <CheckmarkCircle20Filled className="w-3 h-3" />
                            ) : (
                              <Warning20Filled className="w-3 h-3" />
                            )}
                            {result.success ? t.common.success : t.common.error}
                          </Badge>
                          <span
                            className={`text-xs leading-5 break-words select-text min-w-0 ${
                              result.success ? "text-[var(--text-secondary)]" : "text-[var(--danger)]"
                            }`}
                          >
                            {result.message}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="shrink-0 self-end sm:self-center">
                    <WinUIButton
                      variant="standard"
                      onClick={() => handleRunTask(task.id)}
                      disabled={isRunning}
                      className="min-w-[88px]"
                      icon={
                        isRunning ? (
                          <ArrowClockwise20Regular className="w-4 h-4 animate-spin" />
                        ) : (
                          <Play20Regular className="w-4 h-4" />
                        )
                      }
                    >
                      {isRunning ? t.maintenance.runningTask : t.maintenance.runTask}
                    </WinUIButton>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </Page>
  );
};

export default SystemMaintenancePage;
