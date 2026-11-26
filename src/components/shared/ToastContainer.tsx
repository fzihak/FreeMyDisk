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
  success: <CheckmarkCircle20Filled className="w-5 h-5 text-emerald-400 shrink-0" />,
  error: <DismissCircle20Filled className="w-5 h-5 text-rose-400 shrink-0" />,
  warning: <Warning20Filled className="w-5 h-5 text-amber-400 shrink-0" />,
  info: <Info20Filled className="w-5 h-5 text-sky-400 shrink-0" />,
};

const borderColors = {
  success: 'border-emerald-500/30 bg-emerald-950/70 text-emerald-100',
  error: 'border-rose-500/30 bg-rose-950/70 text-rose-100',
  warning: 'border-amber-500/30 bg-amber-950/70 text-amber-100',
  info: 'border-sky-500/30 bg-sky-950/70 text-sky-100',
};

export const ToastContainer: React.FC = () => {
  const { toasts, removeToast } = useToastStore();

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-2.5 max-w-sm w-full pointer-events-none select-none font-sans"
      aria-live="polite"
    >
      {toasts.map((t: ToastItem) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-3 p-3.5 rounded-xl border fluent-acrylic shadow-2xl transition-all duration-200 animate-in fade-in slide-in-from-bottom-3 ${borderColors[t.type]}`}
        >
          {icons[t.type]}
          <div className="flex-1 min-w-0 pr-1">
            <h4 className="text-xs font-semibold tracking-wide leading-tight">{t.title}</h4>
            {t.message && (
              <p className="text-xs opacity-80 mt-1 leading-snug break-words font-ibm-mono">
                {t.message}
              </p>
            )}
          </div>
          <button
            onClick={() => removeToast(t.id)}
            className="text-white/40 hover:text-white/90 p-0.5 rounded transition-colors shrink-0 cursor-pointer"
            aria-label="Dismiss"
          >
            <Dismiss16Regular className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
};

export default ToastContainer;
