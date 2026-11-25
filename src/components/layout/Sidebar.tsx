import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18nStore } from "@/i18n";
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
  ChevronLeft16Regular,
  ChevronRight16Regular,
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
  tag?: string;
  tagColor?: string;
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

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onSelectTab,
  collapsed,
  onToggleCollapse,
}) => {
  const { t } = useI18nStore();
  const [vitals, setVitals] = useState<SystemVitals | null>(null);

  const navSections: NavSection[] = [
    {
      title: t.nav.storageSection.toUpperCase(),
      items: [
        {
          id: "dashboard",
          label: t.nav.dashboard,
          iconRegular: Home20Regular,
          iconFilled: Home20Filled,
          tag: "LIVE",
          tagColor: "bg-blue-500/15 text-blue-400 border-blue-500/25",
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
      title: t.nav.privacySection.toUpperCase(),
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
      title: t.nav.systemSection.toUpperCase(),
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

  return (
    <aside
      className={`h-full flex flex-col bg-[var(--bg-sidebar)] border-r border-[var(--border-divider)] select-none transition-all duration-200 relative z-30 shrink-0 ${
        collapsed ? "w-16" : "w-60"
      }`}
    >
      {/* Brand Header */}
      {!collapsed ? (
        <div className="h-14 border-b border-[var(--border-divider)] px-3 flex items-center justify-between shrink-0">
          <button
            onClick={() => onSelectTab("dashboard")}
            className="flex items-center gap-2.5 cursor-pointer overflow-hidden group min-w-0 text-left"
            title={t.layout.goToDashboard}
          >
            <div className="w-8 h-8 rounded-lg bg-white/[0.04] border border-white/10 flex items-center justify-center shadow-sm shrink-0 group-hover:scale-105 transition-transform p-1">
              <img src="/logo.png" alt="FreeMyDisk" className="w-full h-full object-contain" />
            </div>
            <div className="truncate min-w-0">
              <span className="text-[13px] font-semibold text-[var(--text-primary)] tracking-tight font-sans block truncate">
                FreeMyDisk
              </span>
              <p className="text-[10px] text-[var(--text-muted)] truncate -mt-0.5 font-sans">
                Disk Intelligence
              </p>
            </div>
          </button>

          <button
            onClick={onToggleCollapse}
            title={t.layout.collapseSidebar}
            className="w-7 h-7 rounded-[4px] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/[0.08] transition-colors cursor-pointer shrink-0"
          >
            <ChevronLeft16Regular className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div className="h-14 border-b border-[var(--border-divider)] flex items-center justify-center shrink-0 px-2">
          <button
            onClick={onToggleCollapse}
            title={t.layout.expandSidebar}
            className="w-10 h-10 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] hover:border-[#0078d4]/40 border border-white/10 flex items-center justify-center shadow-sm transition-all cursor-pointer group relative"
          >
            <img
              src="/logo.png"
              alt="FreeMyDisk"
              className="w-6 h-6 object-contain group-hover:scale-95 transition-transform"
            />
            {/* Subtle expand chevron indicator on hover */}
            <div className="absolute inset-0 rounded-lg bg-[#0078d4]/15 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
              <ChevronRight16Regular className="w-4 h-4 text-[#0078d4]" />
            </div>
          </button>
        </div>
      )}

      {/* WinUI 3 Navigation Sections */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-2 scrollbar-none">
        {navSections.map((section, sIdx) => (
          <div key={sIdx} className="space-y-0.5">
            {!collapsed ? (
              <h3 className="px-3 py-1 text-[10px] font-bold tracking-wider text-[var(--text-muted)] uppercase truncate">
                {section.title}
              </h3>
            ) : sIdx > 0 ? (
              <div className="w-7 h-[1px] bg-[var(--border-divider)] mx-auto my-1.5 opacity-50" />
            ) : null}
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const isActive = currentTab === item.id;
                const Icon = isActive ? item.iconFilled : item.iconRegular;
                return (
                  <button
                    key={item.id}
                    onClick={() => onSelectTab(item.id)}
                    title={collapsed ? item.label : undefined}
                    className={`w-full h-9 relative flex items-center rounded-[4px] text-[12.5px] font-normal transition-all cursor-pointer ${
                      collapsed ? "justify-center px-0" : "gap-2.5 px-3"
                    } ${
                      isActive
                        ? "bg-white/[0.06] text-[var(--text-primary)] font-medium"
                        : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/[0.04]"
                    }`}
                  >
                    {/* WinUI 3 Active 3px Pill Indicator */}
                    {isActive && (
                      <span
                        className={`absolute top-1/2 -translate-y-1/2 w-[3px] h-4 bg-[#0078d4] rounded-full ${
                          collapsed ? "left-1" : "left-0"
                        }`}
                      />
                    )}

                    <Icon
                      className={`w-4 h-4 shrink-0 transition-colors ${
                        isActive ? "text-[#0078d4]" : "text-[var(--text-muted)]"
                      }`}
                    />

                    {!collapsed && (
                      <span className="truncate flex-1 text-left">{item.label}</span>
                    )}

                    {!collapsed && item.tag && (
                      <span
                        className={`text-[9px] font-ibm-mono font-semibold px-1.5 py-0.2 rounded-[4px] border ${
                          item.tagColor || "bg-white/[0.04] text-[var(--text-muted)] border-[var(--border-subtle)]"
                        }`}
                      >
                        {item.tag}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Hardware Telemetry & Safety Footer */}
      <div className="p-2 border-t border-[var(--border-divider)] space-y-1.5 shrink-0">
        {/* RAM Telemetry (IBM Precision Specs) */}
        {vitals && (
          !collapsed ? (
            <div className="px-2.5 py-2 rounded-[4px] bg-white/[0.03] border border-[var(--border-subtle)] space-y-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <div className="flex items-center gap-1.5 text-[var(--text-secondary)] font-normal">
                  <Gauge20Regular className="w-3.5 h-3.5 text-[#0078d4]" />
                  <span>{t.layout.physicalRam}</span>
                </div>
                <span className="font-ibm-mono font-semibold text-[var(--text-primary)] text-[11px]">
                  {vitals.memory_load_percent}%
                </span>
              </div>
              <div className="w-full bg-black/20 h-1 rounded-full overflow-hidden">
                <div
                  style={{ width: `${vitals.memory_load_percent}%` }}
                  className={`h-full rounded-full transition-all duration-500 ${
                    vitals.memory_load_percent > 85
                      ? "bg-[#c42b1c]"
                      : vitals.memory_load_percent > 70
                      ? "bg-[#d97706]"
                      : "bg-[#0078d4]"
                  }`}
                />
              </div>
              <div className="flex justify-between text-[9px] text-[var(--text-muted)] font-ibm-mono">
                <span>Used: {((vitals.used_ram_bytes || 0) / (1024 * 1024 * 1024)).toFixed(1)} GB</span>
                <span>Total: {((vitals.total_ram_bytes || 0) / (1024 * 1024 * 1024)).toFixed(0)} GB</span>
              </div>
            </div>
          ) : (
            <div
              title={`${t.layout.physicalRam}: ${vitals.memory_load_percent}% (${((vitals.used_ram_bytes || 0) / (1024 * 1024 * 1024)).toFixed(1)} / ${((vitals.total_ram_bytes || 0) / (1024 * 1024 * 1024)).toFixed(0)} GB)`}
              className="w-full flex flex-col items-center justify-center py-1.5 rounded-[4px] bg-white/[0.03] border border-[var(--border-subtle)] cursor-default"
            >
              <Gauge20Regular className="w-3.5 h-3.5 text-[#0078d4]" />
              <span className="font-ibm-mono text-[9px] font-bold text-[var(--text-primary)] mt-0.5">
                {vitals.memory_load_percent}%
              </span>
            </div>
          )
        )}

        {/* Settings & Safe Guard */}
        <div className="flex items-center justify-between gap-1">
          <button
            onClick={() => onSelectTab("settings")}
            title={t.nav.settings}
            className={`flex items-center h-8 rounded-[4px] text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/[0.06] transition-all cursor-pointer flex-1 ${
              collapsed ? "justify-center px-0" : "gap-2 px-2.5"
            } ${
              currentTab === "settings" ? "bg-white/[0.08] text-[var(--text-primary)] font-medium" : ""
            }`}
          >
            {currentTab === "settings" ? (
              <Settings20Filled className="w-4 h-4 text-[#0078d4] shrink-0" />
            ) : (
              <Settings20Regular className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
            )}
            {!collapsed && <span className="truncate">{t.nav.settings}</span>}
          </button>

          {!collapsed && (
            <div
              title={t.layout.walSafeguard}
              className="p-1 rounded-[4px] bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 shrink-0"
            >
              <ShieldCheckmark20Filled className="w-3.5 h-3.5" />
            </div>
          )}
        </div>

        {/* Creator & GitHub Repo Credits */}
        {!collapsed ? (
          <button
            onClick={async () => {
              try {
                await openUrl("https://github.com/fzihak/FreeMyDisk");
              } catch {
                window.open("https://github.com/fzihak/FreeMyDisk", "_blank");
              }
            }}
            title={`FreeMyDisk ${t.layout.developedBy} - GitHub`}
            className="w-full flex items-center justify-between px-2 py-1.5 rounded-[4px] text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/[0.04] transition-all cursor-pointer group"
          >
            <div className="flex items-center gap-1.5 truncate">
              <svg className="w-3 h-3 fill-current opacity-70 group-hover:opacity-100 shrink-0 text-[var(--text-secondary)]" viewBox="0 0 24 24">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
              <span className="truncate">{t.layout.developedBy}</span>
            </div>
            <span className="font-ibm-mono text-[9px] text-[#0078d4] group-hover:underline">GitHub ↗</span>
          </button>
        ) : (
          <button
            onClick={async () => {
              try {
                await openUrl("https://github.com/fzihak/FreeMyDisk");
              } catch {
                window.open("https://github.com/fzihak/FreeMyDisk", "_blank");
              }
            }}
            title={`FreeMyDisk ${t.layout.developedBy} - GitHub`}
            className="w-full flex items-center justify-center h-8 rounded-[4px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-white/[0.06] transition-all cursor-pointer"
          >
            <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
            </svg>
          </button>
        )}
      </div>
    </aside>
  );
};

export default Sidebar;
