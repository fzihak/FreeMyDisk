import React from "react";

interface WinUIToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  labelOn?: string;
  labelOff?: string;
  showLabel?: boolean;
  id?: string;
  className?: string;
}

/**
 * Windows 11 Native WinUI 3 ToggleSwitch Control
 * Matches the exact 40px x 20px capsule toggle with authentic sliding thumb & label.
 */
export const WinUIToggle: React.FC<WinUIToggleProps> = ({
  checked,
  onChange,
  disabled = false,
  labelOn = "On",
  labelOff = "Off",
  showLabel = true,
  id,
  className = "",
}) => {
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!disabled) {
      onChange(!checked);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === " " || e.key === "Enter") && !disabled) {
      e.preventDefault();
      e.stopPropagation();
      onChange(!checked);
    }
  };

  return (
    <div
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      id={id}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={`inline-flex items-center gap-2.5 select-none ${
        disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
      } ${className}`}
    >
      {/* 40x20px WinUI 3 capsule track */}
      <div
        className={`relative w-10 h-5 rounded-full transition-all duration-150 ease-out ${
          checked
            ? "bg-[var(--accent)] hover:bg-[var(--accent-hover)] border border-transparent"
            : "bg-transparent hover:bg-[var(--fill-subtle)] border border-[var(--text-secondary)]"
        }`}
      >
        {/* Sliding thumb knob */}
        <span
          className={`absolute top-1/2 -translate-y-1/2 rounded-full transition-all duration-150 ease-out ${
            checked
              ? "left-[22px] w-3.5 h-3.5 bg-white"
              : "left-[3px] w-3 h-3 bg-[var(--text-secondary)]"
          }`}
        />
      </div>

      {showLabel && (
        <span className="text-xs text-[var(--text-secondary)] font-normal min-w-[24px]">
          {checked ? labelOn : labelOff}
        </span>
      )}
    </div>
  );
};
