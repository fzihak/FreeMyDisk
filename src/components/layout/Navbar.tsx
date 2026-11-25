import React from "react";
import { NavTab } from "./Sidebar";
import {
  Search20Regular,
  Grid20Regular,
  Settings20Regular,
  Alert20Regular,
  HardDrive20Regular,
} from "@fluentui/react-icons";

interface NavbarProps {
  currentTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
}

interface NavItem {
  id: NavTab;
  label: string;
}

const PRIMARY_NAV_ITEMS: NavItem[] = [
  { id: "dashboard", label: "My Overview" },
  { id: "cleanup", label: "Clean Caches" },
  { id: "storage", label: "Disk Treemap" },
  { id: "duplicates", label: "Duplicates" },
  { id: "large_files", label: "Large Files" },
  { id: "privacy", label: "Privacy Guard" },
  { id: "applications", label: "Applications" },
  { id: "startup", label: "Startup Boot" },
  { id: "maintenance", label: "Diagnostics" },
  { id: "optimization", label: "OS Swap Tuning" },
  { id: "history", label: "Audit Journal" },
];

export const Navbar: React.FC<NavbarProps> = ({ currentTab, onSelectTab }) => {
  return (
    <header className="h-16 bg-surface-card/80 backdrop-blur-md border-b border-border-subtle px-6 flex items-center justify-between shrink-0 z-30 select-none shadow-sm">
      {/* Left: Brand Identity */}
      <div
        onClick={() => onSelectTab("dashboard")}
        className="flex items-center gap-3 cursor-pointer group"
      >
        <div className="w-9 h-9 rounded-xl bg-accent text-white flex items-center justify-center shadow-md shadow-accent/20 group-hover:scale-105 transition-transform">
          <HardDrive20Regular className="w-5 h-5" />
        </div>
        <div>
          <div className="flex items-center gap-1.5">
            <span className="text-base font-bold text-text-primary tracking-tight">FreeMyDisk</span>
            <span className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-accent/15 text-accent border border-accent/20 font-ibm-mono">
              AI
            </span>
          </div>
          <p className="text-[10px] text-text-secondary font-medium -mt-0.5">
            AI-Powered Storage Intelligence
          </p>
        </div>
      </div>

      {/* Center: Pill Navigation Tabs */}
      <nav className="hidden md:flex items-center bg-surface-primary p-1 rounded-full border border-border-subtle overflow-x-auto max-w-2xl lg:max-w-4xl scrollbar-none">
        {PRIMARY_NAV_ITEMS.map((item) => {
          const isActive = currentTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onSelectTab(item.id)}
              className={`px-3.5 py-1.5 rounded-full text-xs transition-all whitespace-nowrap cursor-pointer ${
                isActive
                  ? "bg-accent text-white font-semibold shadow-sm"
                  : "text-text-secondary hover:text-text-primary font-medium"
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* Right: Quick Tools & Settings */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => onSelectTab("cleanup")}
          title="Quick Clean"
          className="p-2 text-text-secondary hover:text-text-primary hover:bg-surface-primary rounded-full transition-colors cursor-pointer"
        >
          <Search20Regular className="w-4 h-4" />
        </button>

        <button
          onClick={() => onSelectTab("storage")}
          title="Treemap View"
          className="p-2 text-text-secondary hover:text-text-primary hover:bg-surface-primary rounded-full transition-colors cursor-pointer"
        >
          <Grid20Regular className="w-4 h-4" />
        </button>

        <button
          onClick={() => onSelectTab("history")}
          title="System Notifications & Journal"
          className="p-2 text-text-secondary hover:text-text-primary hover:bg-surface-primary rounded-full transition-colors relative cursor-pointer"
        >
          <Alert20Regular className="w-4 h-4" />
          <span className="w-1.5 h-1.5 bg-accent rounded-full absolute top-2 right-2 ring-2 ring-surface-card" />
        </button>

        <div className="h-4 w-px bg-border-subtle mx-1" />

        <button
          onClick={() => onSelectTab("settings")}
          title="Governance & Safety Settings"
          className={`p-2 rounded-full transition-colors cursor-pointer ${
            currentTab === "settings"
              ? "bg-accent/15 text-accent"
              : "text-text-secondary hover:text-text-primary hover:bg-surface-primary"
          }`}
        >
          <Settings20Regular className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
