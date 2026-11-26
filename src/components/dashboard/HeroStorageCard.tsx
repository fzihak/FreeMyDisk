import React from "react";
import {
  ArrowRight20Regular,
  HardDrive20Regular,
  Settings20Regular,
  Alert20Regular,
  Power20Regular,
} from "@fluentui/react-icons";
import { NavTab } from "../layout/Sidebar";

interface HeroStorageCardProps {
  usedPercent: number;
  usedGb: string;
  totalGb: string;
  cleanableGb: string;
  inUseGb: string;
  criticalGb: string;
  totalReclaimedGb: string;
  onNavigate: (tab: NavTab) => void;
}

export const HeroStorageCard: React.FC<HeroStorageCardProps> = ({
  usedPercent = 78,
  usedGb = "4 653",
  totalGb = "5 952",
  cleanableGb = "498",
  inUseGb = "4 443",
  criticalGb = "167",
  totalReclaimedGb = "1 108",
  onNavigate,
}) => {
  // SVG Radial Ring calculation
  const radius = 64;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (usedPercent / 100) * circumference;

  return (
    <div className="hero-blue-gradient p-7 flex flex-col justify-between h-full min-h-[580px] w-full select-none relative overflow-hidden rounded-2xl shadow-xl">
      {/* Decorative ambient bubble glows */}
      <div className="absolute -right-16 -top-16 w-52 h-52 bg-white/10 rounded-full blur-2xl pointer-events-none" />
      <div className="absolute -left-16 -bottom-16 w-52 h-52 bg-blue-400/20 rounded-full blur-2xl pointer-events-none" />

      {/* Top: Hello User & Quick Action */}
      <div className="relative z-10">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-black text-white tracking-tight">
              Hello, System!
            </h2>
            <div className="text-xl font-bold text-white/95 mt-0.5">
              Explore storage
            </div>
          </div>
          <button
            onClick={() => onNavigate("cleanup")}
            title="Scan Cleanable Caches"
            className="w-10 h-10 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center text-white transition-all cursor-pointer shadow-sm hover:scale-105"
          >
            <ArrowRight20Regular className="w-5 h-5" />
          </button>
        </div>

        <p className="text-xs text-blue-100/90 mt-2 font-medium">
          Deploy AI storage intelligence.{" "}
          <button
            onClick={() => onNavigate("storage")}
            className="underline text-white font-semibold hover:text-blue-200 cursor-pointer"
          >
            Treemap view
          </button>
        </p>
      </div>

      {/* Center: Radial Ring Gauge */}
      <div className="flex flex-col items-center my-6 relative z-10">
        <div className="relative w-44 h-44 flex items-center justify-center">
          <svg className="w-44 h-44 -rotate-90 transform" viewBox="0 0 160 160">
            {/* Background circle track */}
            <circle
              cx="80"
              cy="80"
              r={radius}
              stroke="rgba(255, 255, 255, 0.2)"
              strokeWidth="10"
              fill="transparent"
            />
            {/* Active filled circular progress */}
            <circle
              cx="80"
              cy="80"
              r={radius}
              stroke="#ffffff"
              strokeWidth="10"
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
              strokeLinecap="round"
              fill="transparent"
              className="transition-all duration-1000 ease-out"
            />
          </svg>

          {/* Center text inside circle */}
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
            <span className="text-3xl font-black text-white tracking-tight font-ibm-mono tabular-nums">
              {usedPercent}%
            </span>
            <span className="text-xs font-medium text-blue-100/90 mt-0.5 font-ibm-mono tabular-nums">
              {usedGb} of {totalGb} GB
            </span>
          </div>
        </div>

        {/* Legend Dots under the circle */}
        <div className="flex items-center justify-center gap-6 mt-6 w-full text-center">
          <div>
            <div className="flex items-center justify-center gap-1.5 text-xs text-blue-100 font-medium">
              <span className="w-2 h-2 rounded-full bg-cyan-300" />
              <span>Cleanable</span>
            </div>
            <div className="text-sm font-bold text-white mt-0.5 font-ibm-mono tabular-nums">{cleanableGb} GB</div>
          </div>

          <div>
            <div className="flex items-center justify-center gap-1.5 text-xs text-blue-100 font-medium">
              <span className="w-2 h-2 rounded-full bg-white" />
              <span>In Use</span>
            </div>
            <div className="text-sm font-bold text-white mt-0.5 font-ibm-mono tabular-nums">{inUseGb} GB</div>
          </div>

          <div>
            <div className="flex items-center justify-center gap-1.5 text-xs text-blue-100 font-medium">
              <span className="w-2 h-2 rounded-full bg-amber-300" />
              <span>Critical</span>
            </div>
            <div className="text-sm font-bold text-white mt-0.5 font-ibm-mono tabular-nums">{criticalGb} GB</div>
          </div>
        </div>
      </div>

      {/* Lower Metrics Section */}
      <div className="relative z-10 pt-4 border-t border-white/15">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-blue-100/90">Total Reclaimed</div>
            <div className="flex items-baseline gap-1 mt-0.5 font-ibm-mono tabular-nums">
              <span className="text-3xl font-black text-white tracking-tight">
                {totalReclaimedGb}
              </span>
              <span className="text-sm font-bold text-blue-100">GB</span>
            </div>
          </div>
          <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center text-white shadow-sm">
            <HardDrive20Regular className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Bottom Profile / Workstation Strip */}
      <div className="flex items-center justify-between pt-6 border-t border-white/15 relative z-10">
        <div>
          <div className="text-xs font-bold text-white">Local Workstation</div>
          <div className="text-xs text-blue-100/80 font-ibm-mono">Windows 11 • NTFS Guard</div>
        </div>

        <div className="flex items-center gap-1 bg-white/10 backdrop-blur-sm px-2 py-1 rounded-xl border border-white/15">
          <button
            onClick={() => onNavigate("settings")}
            title="Settings"
            className="p-1 hover:text-blue-200 text-white transition-colors cursor-pointer"
          >
            <Settings20Regular className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onNavigate("history")}
            title="Notifications"
            className="p-1 hover:text-blue-200 text-white transition-colors cursor-pointer"
          >
            <Alert20Regular className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onNavigate("cleanup")}
            title="Quick Clean"
            className="p-1 hover:text-blue-200 text-white transition-colors cursor-pointer"
          >
            <Power20Regular className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};
