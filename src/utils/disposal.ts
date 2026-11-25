import type { TranslationSchema } from "@/i18n/types";

/** Totals every disposal command returns. */
export interface DisposalTotals {
  /** Bytes actually removed from disk. */
  total_freed_bytes: number;
  /** Bytes moved to the Recycle Bin; still on the same drive until it is emptied. */
  recycled_bytes?: number;
}

/**
 * One-line outcome of a cleanup, keeping space that was freed apart from space
 * that was only moved to the Recycle Bin.
 */
export function describeDisposal(
  totals: DisposalTotals,
  t: TranslationSchema,
  formatBytes: (bytes: number) => string
): string {
  const parts: string[] = [];
  if (totals.total_freed_bytes > 0 || !totals.recycled_bytes) {
    parts.push(`${t.cleanup.reclaimedSpace}: ${formatBytes(totals.total_freed_bytes)}`);
  }
  if (totals.recycled_bytes) {
    parts.push(`${t.cleanup.movedToRecycleBin}: ${formatBytes(totals.recycled_bytes)}`);
  }
  return parts.join(" · ");
}
