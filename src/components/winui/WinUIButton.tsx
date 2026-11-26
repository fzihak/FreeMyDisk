import React from "react";

interface WinUIButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "standard" | "subtle" | "danger";
  size?: "sm" | "md" | "lg";
  icon?: React.ReactNode;
  children?: React.ReactNode;
}

/**
 * Windows 11 Native WinUI 3 Button Control
 * Features 4px corner radius, authentic Windows blue accent, and click micro-animations.
 */
export const WinUIButton: React.FC<WinUIButtonProps> = ({
  variant = "standard",
  size = "md",
  icon,
  children,
  className = "",
  disabled,
  ...props
}) => {
  const sizeClasses = {
    sm: "h-7 px-2.5 text-[11px] gap-1.5",
    md: "h-8 px-3.5 text-xs gap-2",
    lg: "h-9 px-4 text-xs gap-2",
  }[size];

  const variantClasses = {
    primary:
      "bg-[#0067c0] hover:bg-[#187bd1] active:bg-[#005fb8] text-white border-transparent shadow-sm font-medium",
    standard:
      "bg-white/[0.06] hover:bg-white/[0.1] active:bg-white/[0.04] text-[var(--text-primary)] border-white/10 hover:border-white/20 shadow-sm",
    subtle:
      "bg-transparent hover:bg-white/[0.06] active:bg-white/[0.03] text-[var(--text-primary)] border-transparent",
    danger:
      "bg-[#c42b1c] hover:bg-[#b32719] active:bg-[#a22316] text-white border-transparent shadow-sm font-medium",
  }[variant];

  return (
    <button
      disabled={disabled}
      className={`inline-flex items-center justify-center whitespace-nowrap rounded-[4px] border font-normal transition-all duration-100 select-none cursor-pointer active:scale-[0.98] ${sizeClasses} ${variantClasses} ${
        disabled ? "opacity-40 cursor-not-allowed pointer-events-none" : ""
      } ${className}`}
      {...props}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      {children && <span>{children}</span>}
    </button>
  );
};
