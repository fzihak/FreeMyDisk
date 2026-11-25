import { describe, it, expect } from "vitest";
import { en } from "@/i18n/locales/en";
import { describeDisposal } from "@/utils/disposal";

const fmt = (b: number) => `${b} B`;

describe("describeDisposal", () => {
  it("keeps freed space apart from space moved to the Recycle Bin", () => {
    const text = describeDisposal({ total_freed_bytes: 10, recycled_bytes: 30 }, en, fmt);
    expect(text).toBe(`${en.cleanup.reclaimedSpace}: 10 B · ${en.cleanup.movedToRecycleBin}: 30 B`);
  });

  it("does not claim freed space for a Recycle Bin-only cleanup", () => {
    const text = describeDisposal({ total_freed_bytes: 0, recycled_bytes: 30 }, en, fmt);
    expect(text).toBe(`${en.cleanup.movedToRecycleBin}: 30 B`);
  });
});
