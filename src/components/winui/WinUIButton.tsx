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
    sm: "h-7 px-2.5 text-xs gap-1.5",
    md: "h-8 px-3 text-sm gap-2",
    lg: "h-9 px-4 text-sm gap-2",
  }[size];

  const variantClasses = {
    primary:
      "bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white border-transparent font-medium",
    standard:
      "bg-[var(--fill-subtle)] hover:bg-[var(--fill-subtle-hover)] text-[var(--text-primary)] border-[var(--border-card)]",
    subtle:
      "bg-transparent hover:bg-[var(--fill-subtle)] text-[var(--text-primary)] border-transparent",
    danger:
      "bg-[var(--danger-fill)] hover:brightness-110 text-white border-transparent font-medium",
  }[variant];

  return (
    <button
      disabled={disabled}
      className={`inline-flex items-center justify-center whitespace-nowrap rounded-md border transition-colors duration-100 select-none cursor-pointer active:opacity-80 ${sizeClasses} ${variantClasses} ${
        disabled ? "opacity-50 cursor-not-allowed pointer-events-none" : ""
      } ${className}`}
      {...props}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      {children && <span>{children}</span>}
    </button>
  );
};
