import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18nStore } from "@/i18n";
import { APP_VERSION } from "@/version";
import { useUpdaterStore } from "@/stores/updater-store";
import {
  Home20Regular,
  Home20Filled,
  Delete20Regular,
  Delete20Filled,
  Storage20Regular,
  Storage20Filled,
  DocumentFolder20Regular,
  DocumentFolder20Filled,
  DocumentCopy20Regular,
  DocumentCopy20Filled,
  ShieldCheckmark20Regular,
  ShieldCheckmark20Filled,
  Apps20Regular,
  Apps20Filled,
  Flash20Regular,
  Flash20Filled,
  Wrench20Regular,
  Wrench20Filled,
  Gauge20Regular,
  Gauge20Filled,
  History20Regular,
  History20Filled,
  Settings20Regular,
  Settings20Filled,
  Navigation20Regular,
} from "@fluentui/react-icons";

export type NavTab =
  | "dashboard"
  | "cleanup"
  | "storage"
  | "large_files"
  | "duplicates"
  | "privacy"
  | "applications"
  | "startup"
  | "maintenance"
  | "optimization"
  | "history"
  | "settings";

interface SidebarProps {
  currentTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

interface NavItem {
  id: NavTab;
  label: string;
  iconRegular: React.ComponentType<{ className?: string }>;
  iconFilled: React.ComponentType<{ className?: string }>;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

interface SystemVitals {
  total_ram_bytes: number;
  available_ram_bytes: number;
  used_ram_bytes: number;
  memory_load_percent: number;
  os_name: string;
  computer_name: string;
  cpu_cores: number;
}

const focusRing =
  "outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent-text)]";

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onSelectTab,
  collapsed,
  onToggleCollapse,
}) => {
  const { t } = useI18nStore();
  const updateStatus = useUpdaterStore((s) => s.status);
  const updateVersion = useUpdaterStore((s) => s.version);
  const openUpdateDialog = useUpdaterStore((s) => s.openDialog);
  const hasUpdate = ["available", "downloading", "installing", "error"].includes(updateStatus) && !!updateVersion;
  const [vitals, setVitals] = useState<SystemVitals | null>(null);

  const navSections: NavSection[] = [
    {
      title: t.nav.storageSection,
      items: [
        {
          id: "dashboard",
          label: t.nav.dashboard,
          iconRegular: Home20Regular,
          iconFilled: Home20Filled,
        },
        {
          id: "cleanup",
          label: t.nav.cleanup,
          iconRegular: Delete20Regular,
          iconFilled: Delete20Filled,
        },
        {
          id: "storage",
          label: t.nav.storage,
          iconRegular: Storage20Regular,
          iconFilled: Storage20Filled,
        },
        {
          id: "large_files",
          label: t.nav.largeFiles,
          iconRegular: DocumentFolder20Regular,
          iconFilled: DocumentFolder20Filled,
        },
        {
          id: "duplicates",
          label: t.nav.duplicates,
          iconRegular: DocumentCopy20Regular,
          iconFilled: DocumentCopy20Filled,
        },
      ],
    },
    {
      title: t.nav.privacySection,
      items: [
        {
          id: "privacy",
          label: t.nav.privacy,
          iconRegular: ShieldCheckmark20Regular,
          iconFilled: ShieldCheckmark20Filled,
        },
        {
          id: "applications",
          label: t.nav.applications,
          iconRegular: Apps20Regular,
          iconFilled: Apps20Filled,
        },
        {
          id: "startup",
          label: t.nav.startup,
          iconRegular: Flash20Regular,
          iconFilled: Flash20Filled,
        },
      ],
    },
    {
      title: t.nav.systemSection,
      items: [
        {
          id: "maintenance",
          label: t.nav.maintenance,
          iconRegular: Wrench20Regular,
          iconFilled: Wrench20Filled,
        },
        {
          id: "optimization",
          label: t.nav.optimization,
          iconRegular: Gauge20Regular,
          iconFilled: Gauge20Filled,
        },
        {
          id: "history",
          label: t.nav.history,
          iconRegular: History20Regular,
          iconFilled: History20Filled,
        },
      ],
    },
  ];

  useEffect(() => {
    // Non-blocking quick query of system vitals
    const fetchVitals = async () => {
      try {
        const v = await invoke<SystemVitals>("get_system_vitals").catch(() => null);
        if (v) setVitals(v);
      } catch (e) {
        console.error("Vitals query error:", e);
      }
    };
    fetchVitals();
    const interval = setInterval(fetchVitals, 8000);
    return () => clearInterval(interval);
  }, []);

  const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  const ramColor =
    vitals && vitals.memory_load_percent > 85
      ? "bg-[var(--danger-fill)]"
      : vitals && vitals.memory_load_percent > 70
      ? "bg-[var(--brand-amber)]"
      : "bg-[var(--accent)]";

  const openGitHub = async () => {
    try {
      await openUrl("https://github.com/fzihak/FreeMyDisk");
    } catch {
      window.open("https://github.com/fzihak/FreeMyDisk", "_blank");
    }
  };

  const navButton = (
    id: NavTab,
    label: string,
    IconRegular: React.ComponentType<{ className?: string }>,
    IconFilled: React.ComponentType<{ className?: string }>
  ) => {
    const isActive = currentTab === id;
    const Icon = isActive ? IconFilled : IconRegular;
    return (
      <button
        key={id}
        onClick={() => onSelectTab(id)}
        title={collapsed ? label : undefined}
        aria-current={isActive ? "page" : undefined}
        className={`w-full h-9 relative flex items-center rounded-md text-sm transition-colors ${focusRing} ${
          collapsed ? "justify-center" : "gap-3 px-3"
        } ${
          isActive
            ? "bg-[var(--fill-subtle)] text-[var(--text-primary)]"
            : "text-[var(--text-secondary)] hover:bg-[var(--fill-subtle)] hover:text-[var(--text-primary)]"
        }`}
      >
        {isActive && (
          <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-full bg-[var(--accent-text)]" />
        )}
        <Icon
          className={`w-5 h-5 shrink-0 ${isActive ? "text-[var(--accent-text)]" : "text-[var(--text-secondary)]"}`}
        />
        {!collapsed && <span className="truncate">{label}</span>}
      </button>
    );
  };

  return (
    <aside
      className={`h-full flex flex-col bg-[var(--bg-shell)] select-none transition-[width] duration-200 shrink-0 ${
        collapsed ? "w-[60px]" : "w-60"
      }`}
    >
      {/* Top row: menu button and app name, level with the window buttons.
          The empty part of the row drags the window. */}
      <div
        data-tauri-drag-region
        className={`h-12 flex items-center gap-2 shrink-0 ${collapsed ? "justify-center px-2" : "px-2"}`}
      >
        <button
          onClick={onToggleCollapse}
          title={collapsed ? t.layout.expandSidebar : t.layout.collapseSidebar}
          aria-label={collapsed ? t.layout.expandSidebar : t.layout.collapseSidebar}
          aria-expanded={!collapsed}
          className={`w-10 h-9 shrink-0 rounded-md flex items-center justify-center text-[var(--text-primary)] hover:bg-[var(--fill-subtle)] active:bg-[var(--fill-subtle-hover)] transition-colors ${focusRing}`}
        >
          <Navigation20Regular className="w-5 h-5" />
        </button>
        {!collapsed && (
          <button
            onClick={() => onSelectTab("dashboard")}
            title={t.layout.goToDashboard}
            className={`flex items-center gap-2.5 min-w-0 h-9 pr-2 rounded-md ${focusRing}`}
          >
            <img src="/logo.png" alt="" className="w-5 h-5 shrink-0 object-contain" />
            <span className="text-sm font-semibold text-[var(--text-primary)] truncate">FreeMyDisk</span>
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {navSections.map((section, sIdx) => (
          <div key={sIdx} className={sIdx > 0 ? "mt-4" : ""}>
            {!collapsed ? (
              <h3 className="px-3 pb-1 text-xs font-semibold text-[var(--text-muted)] truncate">{section.title}</h3>
            ) : sIdx > 0 ? (
              <div className="h-px bg-[var(--border-divider)] mx-2 mb-2" />
            ) : null}
            <div className="space-y-0.5">
              {section.items.map((item) => navButton(item.id, item.label, item.iconRegular, item.iconFilled))}
            </div>
          </div>
        ))}
      </nav>

      <div className="px-2 pb-2 pt-2 space-y-1 shrink-0 border-t border-[var(--border-divider)]">
        {vitals &&
          (!collapsed ? (
            <div className="px-3 py-2 space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[var(--text-secondary)]">{t.layout.physicalRam}</span>
                <span className="font-ibm-mono text-[var(--text-primary)]">
                  {gb(vitals.used_ram_bytes || 0)} / {gb(vitals.total_ram_bytes || 0)} GB
                </span>
              </div>
              <div className="w-full h-1 rounded-full bg-[var(--fill-subtle)] overflow-hidden">
                <div
                  style={{ width: `${vitals.memory_load_percent}%` }}
                  className={`h-full rounded-full transition-all duration-500 ${ramColor}`}
                />
              </div>
            </div>
          ) : (
            <div
              title={`${t.layout.physicalRam}: ${vitals.memory_load_percent}%`}
              className="h-9 flex flex-col items-center justify-center gap-1"
            >
              <span className="text-xs font-ibm-mono text-[var(--text-secondary)]">{vitals.memory_load_percent}%</span>
              <div className="w-6 h-1 rounded-full bg-[var(--fill-subtle)] overflow-hidden">
                <div style={{ width: `${vitals.memory_load_percent}%` }} className={`h-full ${ramColor}`} />
              </div>
            </div>
          ))}

        {navButton("settings", t.nav.settings, Settings20Regular, Settings20Filled)}

        {hasUpdate && (
          <button
            onClick={openUpdateDialog}
            title={`${t.layout.updateAvailableShort}: v${updateVersion}`}
            className={`w-full h-8 flex items-center rounded-md text-xs text-[var(--accent-text)] hover:bg-[var(--fill-subtle)] transition-colors ${focusRing} ${
              collapsed ? "justify-center" : "gap-3 px-3"
            }`}
          >
            <span className="relative flex w-4 h-4 items-center justify-center shrink-0">
              <span className="absolute w-2 h-2 rounded-full bg-[var(--accent-text)] animate-ping opacity-60" />
              <span className="w-2 h-2 rounded-full bg-[var(--accent-text)]" />
            </span>
            {!collapsed && (
              <>
                <span className="flex-1 text-left font-medium">{t.layout.updateAvailableShort}</span>
                <span className="font-ibm-mono">v{updateVersion}</span>
              </>
            )}
          </button>
        )}

        <button
          onClick={openGitHub}
          title={`FreeMyDisk v${APP_VERSION} on GitHub`}
          className={`w-full h-8 flex items-center rounded-md text-xs text-[var(--text-muted)] hover:bg-[var(--fill-subtle)] hover:text-[var(--text-primary)] transition-colors ${
            collapsed ? "justify-center" : "gap-3 px-3"
          }`}
        >
          <GitHubMark className="w-4 h-4 shrink-0" />
          {!collapsed && (
            <>
              <span className="flex-1 text-left">GitHub</span>
              <span className="font-ibm-mono">v{APP_VERSION}</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
};

const GitHubMark: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
  </svg>
);

export default Sidebar;
