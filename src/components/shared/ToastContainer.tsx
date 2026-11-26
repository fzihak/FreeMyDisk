import React from 'react';
import { useToastStore, ToastItem } from '../../stores/toast-store';
import {
  CheckmarkCircle20Filled,
  DismissCircle20Filled,
  Warning20Filled,
  Info20Filled,
  Dismiss16Regular,
} from '@fluentui/react-icons';

const icons = {
  success: <CheckmarkCircle20Filled className="w-5 h-5 text-[var(--success)] shrink-0" />,
  error: <DismissCircle20Filled className="w-5 h-5 text-[var(--danger)] shrink-0" />,
  warning: <Warning20Filled className="w-5 h-5 text-[var(--brand-amber)] shrink-0" />,
  info: <Info20Filled className="w-5 h-5 text-[var(--accent-text)] shrink-0" />,
};

/** Windows-style notification toasts, stacked at the bottom right. Timing lives in the toast store. */
export const ToastContainer: React.FC = () => {
  const { toasts, removeToast } = useToastStore();

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-2 max-w-sm w-full pointer-events-none select-none font-sans"
      aria-live="polite"
    >
      {toasts.map((t: ToastItem) => (
        <div
          key={t.id}
          role="status"
          className="pointer-events-auto flex items-start gap-3 p-3 rounded-lg border border-[var(--border-card)] bg-[var(--bg-card)] shadow-lg animate-in fade-in slide-in-from-bottom-3"
        >
          {icons[t.type]}
          <div className="flex-1 min-w-0 pt-px">
            <h4 className="text-sm font-semibold text-[var(--text-primary)] leading-5">{t.title}</h4>
            {t.message && (
              <p className="text-xs text-[var(--text-secondary)] mt-0.5 break-words">{t.message}</p>
            )}
          </div>
          <button
            onClick={() => removeToast(t.id)}
            className="w-6 h-6 -mr-1 -mt-0.5 flex items-center justify-center rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--fill-subtle)] transition-colors shrink-0 cursor-pointer"
            aria-label="Dismiss"
          >
            <Dismiss16Regular className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );
};

export default ToastContainer;
