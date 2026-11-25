import React, { useEffect, useState, Suspense } from "react";
import { Sidebar, NavTab } from "@/components/layout/Sidebar";
import { TitleBar } from "@/components/layout/TitleBar";
import { UpdateBanner } from "@/components/shared/UpdateBanner";
import { RecoveryAlert } from "@/components/shared/RecoveryAlert";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { ToastContainer } from "@/components/shared/ToastContainer";
import { DashboardPage } from "@/pages/DashboardPage";
import { useUpdaterStore } from "@/stores/updater-store";
import { useSettingsStore } from "@/stores/settings-store";

// Lazy-loaded secondary pages to minimize cold start footprint and RAM usage
const HistoryPage = React.lazy(() => import("@/pages/HistoryPage").then((m) => ({ default: m.HistoryPage })));
const SettingsPage = React.lazy(() => import("@/pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const CleanupPage = React.lazy(() => import("@/pages/CleanupPage").then((m) => ({ default: m.CleanupPage })));
const StoragePage = React.lazy(() => import("@/pages/StoragePage").then((m) => ({ default: m.StoragePage })));
const LargeFilesPage = React.lazy(() => import("@/pages/LargeFilesPage").then((m) => ({ default: m.LargeFilesPage })));
const DuplicatesPage = React.lazy(() => import("@/pages/DuplicatesPage").then((m) => ({ default: m.DuplicatesPage })));
const StartupPage = React.lazy(() => import("@/pages/StartupPage").then((m) => ({ default: m.StartupPage })));
const ApplicationsPage = React.lazy(() => import("@/pages/ApplicationsPage").then((m) => ({ default: m.ApplicationsPage })));
const SystemMaintenancePage = React.lazy(() => import("@/pages/SystemMaintenancePage").then((m) => ({ default: m.SystemMaintenancePage })));
const PrivacyPage = React.lazy(() => import("@/pages/PrivacyPage").then((m) => ({ default: m.PrivacyPage })));
const OptimizationPage = React.lazy(() => import("@/pages/OptimizationPage").then((m) => ({ default: m.OptimizationPage })));

const PageLoadingFallback: React.FC = () => (
  <div className="flex flex-col items-center justify-center h-full min-h-[360px] text-[var(--text-secondary)] space-y-3">
    <div className="w-7 h-7 rounded-full border-2 border-[#0078d4]/30 border-t-[#0078d4] animate-spin" />
    <span className="text-xs font-medium tracking-wide opacity-80">Loading module...</span>
  </div>
);

export const App: React.FC = () => {
  const [currentTab, setCurrentTab] = useState<NavTab>("dashboard");
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);

  const { checkForUpdates } = useUpdaterStore();
  const { autoCheckUpdates } = useSettingsStore();

  useEffect(() => {
    if (autoCheckUpdates) {
      checkForUpdates(true);
    }
  }, [autoCheckUpdates, checkForUpdates]);

  const renderContent = () => {
    switch (currentTab) {
      case "dashboard":
        return <DashboardPage onNavigate={setCurrentTab} />;
      case "history":
        return <HistoryPage />;
      case "settings":
        return <SettingsPage />;
      case "cleanup":
        return <CleanupPage />;
      case "storage":
        return <StoragePage />;
      case "large_files":
        return <LargeFilesPage />;
      case "duplicates":
        return <DuplicatesPage />;
      case "privacy":
        return <PrivacyPage />;
      case "applications":
        return <ApplicationsPage />;
      case "startup":
        return <StartupPage />;
      case "maintenance":
        return <SystemMaintenancePage />;
      case "optimization":
        return <OptimizationPage />;
      default:
        return <DashboardPage onNavigate={setCurrentTab} />;
    }
  };

  return (
    <ErrorBoundary onReset={() => setCurrentTab("dashboard")}>
      <div className="flex flex-col h-screen bg-[var(--bg-page)] text-[var(--text-primary)] font-sans overflow-hidden select-none transition-colors duration-200">
        {/* Native-style custom titlebar with drag region and window controls */}
        <TitleBar title="FreeMyDisk" />

        {/* App Body: Sidebar + Content */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Collapsible Navigation Sidebar */}
          <Sidebar
            currentTab={currentTab}
            onSelectTab={setCurrentTab}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
          />

          {/* Main Content Column */}
          <div className="flex-1 flex flex-col min-w-0">
            <UpdateBanner />
            <RecoveryAlert onNavigateToHistory={() => setCurrentTab("history")} />

            {/* Page Content */}
            <main className="flex-1 min-h-0 bg-[var(--bg-page)] overflow-auto relative">
              <Suspense fallback={<PageLoadingFallback />}>
                {renderContent()}
              </Suspense>
            </main>
          </div>
        </div>
        <ToastContainer />
      </div>
    </ErrorBoundary>
  );
};

export default App;
