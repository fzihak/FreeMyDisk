import React from "react";

interface PlaceholderModuleProps {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  actionText?: string;
  onAction?: () => void;
}

export const ModulePlaceholder: React.FC<PlaceholderModuleProps> = ({
  title,
  description,
  icon: Icon,
  actionText = "Start Scan",
  onAction,
}) => {
  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto overflow-y-auto h-full">
      <div className="border-b border-border-subtle pb-4">
        <h2 className="text-xl font-semibold text-text-primary flex items-center gap-2">
          <Icon className="w-5 h-5 text-accent" />
          {title}
        </h2>
        <p className="text-xs text-text-secondary mt-1">{description}</p>
      </div>

      <div className="fluent-mica-card p-12 text-center space-y-4">
        <div className="w-12 h-12 rounded-full bg-accent/10 border border-accent/30 text-accent flex items-center justify-center mx-auto">
          <Icon className="w-6 h-6" />
        </div>
        <div className="max-w-md mx-auto space-y-1">
          <h3 className="text-sm font-semibold text-text-primary">Ready to Scan</h3>
          <p className="text-xs text-text-secondary">
            Powered by the FreeMyDisk Rust core traversal and inspection engines.
          </p>
        </div>
        <button
          onClick={onAction}
          className="fluent-btn fluent-btn-primary px-4 py-2 rounded-lg text-xs font-semibold cursor-pointer"
        >
          {actionText}
        </button>
      </div>
    </div>
  );
};
