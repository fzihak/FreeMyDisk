import React, { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Subtract16Regular,
  Square16Regular,
  SquareMultiple16Regular,
  Dismiss16Regular,
} from "@fluentui/react-icons";

interface TitleBarProps {
  title?: string;
}

const isTauriWindowAvailable = (): boolean =>
  typeof window !== "undefined" &&
  Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);

const captionButton =
  "w-[46px] h-full flex items-center justify-center text-[var(--text-secondary)] " +
  "hover:text-[var(--text-primary)] hover:bg-[var(--fill-subtle-hover)] transition-colors";

/**
 * Windows 11 style title bar: app icon and name on the left, caption buttons on
 * the right, and the rest of the bar is a drag region. Language and GitHub live
 * in Settings and the sidebar footer.
 */
export const TitleBar: React.FC<TitleBarProps> = ({ title = "FreeMyDisk" }) => {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!isTauriWindowAvailable()) return;
    try {
      const appWindow = getCurrentWindow();
      appWindow.isMaximized().then(setIsMaximized).catch(() => {});
      const unlisten = appWindow.onResized(() => {
        appWindow.isMaximized().then(setIsMaximized).catch(() => {});
      });
      return () => {
        unlisten.then((fn) => fn && fn()).catch(() => {});
      };
    } catch (err) {
      console.warn("Could not bind Tauri window events:", err);
    }
  }, []);

  const run = (action: "minimize" | "toggleMaximize" | "close") => {
    try {
      getCurrentWindow()[action]().catch(() => {});
    } catch {
      /* not running inside Tauri */
    }
  };

  return (
    <div
      data-tauri-drag-region
      onDoubleClick={() => run("toggleMaximize")}
      className="h-10 flex items-center shrink-0 select-none bg-[var(--bg-shell)] z-50"
    >
      <div data-tauri-drag-region className="flex items-center gap-3 pl-4 pointer-events-none">
        <img src="/logo.png" alt="" className="w-4 h-4 object-contain" />
        <span className="text-xs text-[var(--text-secondary)]">{title}</span>
      </div>

      <div data-tauri-drag-region className="flex-1 h-full" />

      <div className="flex items-center h-full">
        <button onClick={() => run("minimize")} id="titlebar-minimize" title="Minimize" className={captionButton}>
          <Subtract16Regular className="w-4 h-4" />
        </button>
        <button
          onClick={() => run("toggleMaximize")}
          id="titlebar-maximize"
          title={isMaximized ? "Restore" : "Maximize"}
          className={captionButton}
        >
          {isMaximized ? (
            <SquareMultiple16Regular className="w-3.5 h-3.5" />
          ) : (
            <Square16Regular className="w-3.5 h-3.5" />
          )}
        </button>
        <button
          onClick={() => run("close")}
          id="titlebar-close"
          title="Close"
          className="w-[46px] h-full flex items-center justify-center text-[var(--text-secondary)] hover:text-white hover:bg-[#c42b1c] transition-colors"
        >
          <Dismiss16Regular className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};

export default TitleBar;
