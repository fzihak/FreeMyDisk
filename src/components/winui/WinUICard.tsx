import React, { useState } from "react";
import { ChevronDown16Regular, ChevronRight16Regular } from "@fluentui/react-icons";

interface WinUICardProps {
  children: React.ReactNode;
  className?: string;
  id?: string;
  onClick?: () => void;
}

/**
 * Windows 11 Native WinUI 3 Card Container
 * Subtle 8px rounded container with 1px border and neutral elevation.
 */
export const WinUICard: React.FC<WinUICardProps> = ({ children, className = "", id, onClick }) => {
  return (
    <div
      id={id}
      onClick={onClick}
      className={`bg-[var(--bg-card)] border border-[var(--border-card)] rounded-lg overflow-hidden shadow-[var(--shadow-card)] transition-all ${className}`}
    >
      {children}
    </div>
  );
};

interface WinUISettingRowProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  onClick?: () => void;
  divided?: boolean;
  className?: string;
  badge?: React.ReactNode;
}

/**
 * Windows 11 Native WinUI 3 Setting Row
 * Standard 60px row with 36x36 icon squircle, title/description, and right control.
 */
export const WinUISettingRow: React.FC<WinUISettingRowProps> = ({
  icon,
  title,
  subtitle,
  action,
  onClick,
  divided = true,
  className = "",
  badge,
}) => {
  const isClickable = !!onClick;

  return (
    <div
      onClick={onClick}
      className={`px-4 py-3.5 flex items-center justify-between gap-4 transition-colors ${
        divided ? "border-t border-[var(--border-divider)] first:border-t-0" : ""
      } ${
        isClickable
          ? "cursor-pointer hover:bg-[var(--fill-subtle)] active:bg-[var(--fill-subtle-hover)]"
          : ""
      } ${className}`}
    >
      {/* Left: Icon + Title + Description */}
      <div className="flex items-center gap-3.5 min-w-0 flex-1">
        {icon && (
          <div className="w-8 h-8 rounded-md bg-[var(--fill-subtle)] flex items-center justify-center text-[var(--text-secondary)] shrink-0">
            {icon}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm text-[var(--text-primary)] truncate">
              {title}
            </span>
            {badge}
          </div>
          {subtitle && (
            <p className="text-xs text-[var(--text-secondary)] mt-0.5 leading-snug">
              {subtitle}
            </p>
          )}
        </div>
      </div>

      {/* Right: Controls, Buttons, or Chevron */}
      {action && <div className="shrink-0 flex items-center gap-2">{action}</div>}
    </div>
  );
};

interface WinUIExpanderProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  badge?: React.ReactNode;
  defaultExpanded?: boolean;
  children: React.ReactNode;
  className?: string;
  headerAction?: React.ReactNode;
}

/**
 * Windows 11 Native WinUI 3 Expander Card
 * Header row with expand/collapse chevron and inner content list.
 */
export const WinUIExpander: React.FC<WinUIExpanderProps> = ({
  icon,
  title,
  subtitle,
  badge,
  defaultExpanded = false,
  children,
  className = "",
  headerAction,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div
      className={`bg-[var(--bg-card)] border border-[var(--border-card)] rounded-lg overflow-hidden shadow-[var(--shadow-card)] transition-all ${className}`}
    >
      {/* Expander Header */}
      <div
        onClick={() => setExpanded(!expanded)}
        className="px-4 py-3.5 flex items-center justify-between gap-4 cursor-pointer hover:bg-[var(--fill-subtle)] transition-colors select-none"
      >
        <div className="flex items-center gap-3.5 min-w-0 flex-1">
          {icon && (
            <div className="w-8 h-8 rounded-md bg-[var(--fill-subtle)] flex items-center justify-center text-[var(--text-secondary)] shrink-0">
              {icon}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm text-[var(--text-primary)]">
                {title}
              </span>
              {badge}
            </div>
            {subtitle && (
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                {subtitle}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {headerAction && (
            <div onClick={(e) => e.stopPropagation()}>{headerAction}</div>
          )}
          <div className="p-1 rounded-md text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
            {expanded ? (
              <ChevronDown16Regular className="w-4 h-4" />
            ) : (
              <ChevronRight16Regular className="w-4 h-4" />
            )}
          </div>
        </div>
      </div>

      {/* Expander Body */}
      {expanded && (
        <div className="border-t border-[var(--border-divider)]">
          {children}
        </div>
      )}
    </div>
  );
};
