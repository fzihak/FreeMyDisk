import React from "react";
import { useUpdaterStore } from "@/stores/updater-store";
import { useI18nStore } from "@/i18n";
import { APP_VERSION } from "@/version";
import { WinUIButton } from "@/components/winui/WinUIButton";
import { Badge, ProgressBar } from "@/components/ui";
import {
  ArrowDownload20Regular,
  ArrowSync20Regular,
  Dismiss16Regular,
  ErrorCircle20Regular,
  ShieldCheckmark20Regular,
  Sparkle20Filled,
} from "@fluentui/react-icons";

const fill = (template: string, vars: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));

const formatBytes = (bytes: number): string => {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

/**
 * Renders release notes written in simple Markdown (headings, bullet lists,
 * bold, inline code) as plain React elements. No HTML from the server is ever
 * injected into the page.
 */
const ReleaseNotes: React.FC<{ text: string }> = ({ text }) => {
  const inline = (line: string, key: number) => {
    const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
    return (
      <React.Fragment key={key}>
        {parts.map((p, i) =>
          p.startsWith("**") ? (
            <strong key={i} className="font-semibold text-[var(--text-primary)]">
              {p.slice(2, -2)}
            </strong>
          ) : p.startsWith("`") ? (
            <code key={i} className="font-code text-xs px-1 rounded bg-[var(--fill-subtle)]">
              {p.slice(1, -1)}
            </code>
          ) : (
            <React.Fragment key={i}>{p}</React.Fragment>
          )
        )}
      </React.Fragment>
    );
  };

  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) {
      blocks.push(
        <ul key={`l${blocks.length}`} className="list-disc pl-5 space-y-1">
          {list.map((item, i) => (
            <li key={i}>{inline(item, i)}</li>
          ))}
        </ul>
      );
      list = [];
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(">")) {
      flush();
      continue;
    }
    if (/^[-*] /.test(line)) {
      list.push(line.slice(2));
    } else if (/^#{1,6} /.test(line)) {
      flush();
      blocks.push(
        <div key={`h${blocks.length}`} className="pt-2 text-sm font-semibold text-[var(--text-primary)]">
          {line.replace(/^#+ /, "")}
        </div>
      );
    } else {
      flush();
      blocks.push(<p key={`p${blocks.length}`}>{inline(line, 0)}</p>);
    }
  }
  flush();
  return <div className="space-y-2 text-sm text-[var(--text-secondary)]">{blocks}</div>;
};

/** Details of an available update, with download progress and install. */
export const UpdateDialog: React.FC = () => {
  const { t } = useI18nStore();
  const {
    dialogOpen,
    status,
    version,
    releaseNotes,
    releaseDate,
    downloadedBytes,
    totalBytes,
    downloadProgress,
    errorMessage,
    closeDialog,
    dismissBanner,
    skipThisVersion,
    downloadAndInstall,
  } = useUpdaterStore();

  if (!dialogOpen) return null;

  const busy = status === "downloading" || status === "installing";
  const date = releaseDate ? new Date(releaseDate) : null;

  if (status === "upToDate") {
    return (
      <Overlay onClose={closeDialog}>
        <div className="flex items-center gap-3">
          <ShieldCheckmark20Regular className="w-6 h-6 text-[var(--success)]" />
          <div>
            <div className="text-base font-semibold">{t.layout.updateUpToDate}</div>
            <div className="text-sm text-[var(--text-secondary)]">v{APP_VERSION}</div>
          </div>
        </div>
        <div className="flex justify-end">
          <WinUIButton onClick={closeDialog}>{t.layout.updateClose}</WinUIButton>
        </div>
      </Overlay>
    );
  }

  return (
    <Overlay onClose={busy ? undefined : closeDialog}>
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 shrink-0 rounded-lg bg-[var(--fill-subtle)] flex items-center justify-center">
          <img src="/logo.png" alt="" className="w-6 h-6" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold">{fill(t.layout.updateAvailableTitle, { version })}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
            <Badge>
              {t.layout.updateCurrentVersion} v{APP_VERSION}
            </Badge>
            <span className="text-[var(--text-muted)]">→</span>
            <Badge tone="accent">
              <Sparkle20Filled className="w-3 h-3" />
              {t.layout.updateNewVersion} v{version}
            </Badge>
            {date && !Number.isNaN(date.getTime()) && (
              <span className="text-[var(--text-muted)]">
                {fill(t.layout.updateReleased, { date: date.toLocaleDateString() })}
              </span>
            )}
          </div>
        </div>
        {!busy && (
          <button
            onClick={closeDialog}
            aria-label={t.layout.updateClose}
            className="w-8 h-8 shrink-0 rounded-md flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--fill-subtle)]"
          >
            <Dismiss16Regular className="w-4 h-4" />
          </button>
        )}
      </div>

      <div>
        <div className="text-sm font-semibold mb-2">{t.layout.updateWhatsNew}</div>
        <div className="max-h-64 overflow-y-auto rounded-md border border-[var(--border-card)] bg-[var(--bg-input)] p-3">
          <ReleaseNotes text={releaseNotes} />
        </div>
      </div>

      {status === "downloading" && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-sm">
            <span>{t.layout.updateDownloading}</span>
            <span className="text-xs text-[var(--text-muted)] font-ibm-mono">
              {totalBytes > 0
                ? `${fill(t.layout.updateDownloadedOf, {
                    done: formatBytes(downloadedBytes),
                    total: formatBytes(totalBytes),
                  })} · ${downloadProgress}%`
                : formatBytes(downloadedBytes)}
            </span>
          </div>
          <ProgressBar value={Math.max(2, downloadProgress)} />
        </div>
      )}

      {status === "installing" && (
        <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          <ArrowSync20Regular className="w-4 h-4 animate-spin text-[var(--accent-text)]" />
          {t.layout.updateInstalling}
        </div>
      )}

      {status === "error" && (
        <div className="flex items-start gap-2 rounded-md border border-[color-mix(in_srgb,var(--danger)_40%,transparent)] p-3 text-sm">
          <ErrorCircle20Regular className="w-4 h-4 shrink-0 mt-0.5 text-[var(--danger)]" />
          <div className="min-w-0">
            <div className="font-semibold text-[var(--danger)]">{t.layout.updateFailed}</div>
            {errorMessage && <div className="text-xs text-[var(--text-secondary)] break-words">{errorMessage}</div>}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
        <ShieldCheckmark20Regular className="w-4 h-4 shrink-0" />
        {t.layout.updateVerifiedNote}
      </div>

      <div className="flex items-center justify-between gap-2 pt-1">
        <WinUIButton variant="subtle" size="md" onClick={skipThisVersion} disabled={busy}>
          {t.layout.updateSkip}
        </WinUIButton>
        <div className="flex items-center gap-2">
          <WinUIButton variant="standard" size="md" onClick={dismissBanner} disabled={busy}>
            {t.layout.updateLater}
          </WinUIButton>
          <WinUIButton
            variant="primary"
            size="md"
            onClick={downloadAndInstall}
            disabled={busy}
            icon={
              status === "error" ? (
                <ArrowSync20Regular className="w-4 h-4" />
              ) : (
                <ArrowDownload20Regular className="w-4 h-4" />
              )
            }
          >
            {status === "error" ? t.layout.updateRetry : t.layout.updateAndRestart}
          </WinUIButton>
        </div>
      </div>
    </Overlay>
  );
};

const Overlay: React.FC<{ children: React.ReactNode; onClose?: () => void }> = ({ children, onClose }) => (
  <div
    className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4"
    onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose?.();
    }}
    role="dialog"
    aria-modal="true"
  >
    <div className="w-full max-w-lg bg-[var(--bg-card)] border border-[var(--border-card)] rounded-lg shadow-2xl p-5 space-y-4 text-[var(--text-primary)]">
      {children}
    </div>
  </div>
);

export default UpdateDialog;
