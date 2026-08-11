import { describe, expect, it } from "vitest";
import { colsForWidth, computeVisibleRows, gapFor } from "./useVirtualGrid";

describe("colsForWidth", () => {
  it("uses a single column below the sm breakpoint", () => {
    expect(colsForWidth(0, false)).toBe(1);
    expect(colsForWidth(639, false)).toBe(1);
    expect(colsForWidth(639, true)).toBe(1);
  });

  it("uses 2 columns from 640px up to the xl breakpoint", () => {
    expect(colsForWidth(640, false)).toBe(2);
    expect(colsForWidth(1279, false)).toBe(2);
    expect(colsForWidth(1279, true)).toBe(2);
  });

  it("uses 3 (normal) or 4 (compact) columns at xl and wider", () => {
    expect(colsForWidth(1280, false)).toBe(3);
    expect(colsForWidth(1280, true)).toBe(4);
    expect(colsForWidth(2560, true)).toBe(4);
  });
});

describe("gapFor", () => {
  it("mirrors gap-4 (normal) vs gap-3 (compact)", () => {
    expect(gapFor(false)).toBe(16);
    expect(gapFor(true)).toBe(12);
  });
});

describe("computeVisibleRows", () => {
  const base = { rowPitch: 200, rowCount: 50, overscan: 2 };

  it("returns an empty window when there are no rows", () => {
    expect(
      computeVisibleRows({ ...base, rowCount: 0, scrollTop: 0, viewportHeight: 800 }),
    ).toEqual({ startRow: 0, endRow: 0 });
  });

  it("treats a non-positive row pitch as empty", () => {
    expect(
      computeVisibleRows({ ...base, rowPitch: 0, scrollTop: 0, viewportHeight: 800 }),
    ).toEqual({ startRow: 0, endRow: 0 });
  });

  it("treats a zero viewport as empty", () => {
    expect(
      computeVisibleRows({ ...base, scrollTop: 0, viewportHeight: 0 }),
    ).toEqual({ startRow: 0, endRow: 0 });
  });

  it("covers the viewport plus overscan from the top", () => {
    // viewport 0..800 → rows 0..4, +2 overscan below → end 6
    expect(computeVisibleRows({ ...base, scrollTop: 0, viewportHeight: 800 })).toEqual({
      startRow: 0,
      endRow: 6,
    });
  });

  it("windows around a mid-list scroll position", () => {
    // scrollTop 1000 → first visible row 5 (−2 → 3); bottom 1800 → row 9 (+2 → 11)
    expect(
      computeVisibleRows({ ...base, scrollTop: 1000, viewportHeight: 800 }),
    ).toEqual({ startRow: 3, endRow: 11 });
  });

  it("never goes below zero when overscan would underflow", () => {
    // ceil(900/200) = 5, +2 overscan → 7; startRow clamped to 0
    expect(computeVisibleRows({ ...base, scrollTop: 100, viewportHeight: 800 })).toEqual({
      startRow: 0,
      endRow: 7,
    });
  });

  it("clamps to the last row near the bottom", () => {
    const r = computeVisibleRows({ ...base, scrollTop: 9900, viewportHeight: 800 });
    expect(r.endRow).toBe(50);
    expect(r.startRow).toBeGreaterThan(0);
    expect(r.startRow).toBeLessThan(50);
  });

  it("clamps startRow when scrolled past the content", () => {
    expect(
      computeVisibleRows({ ...base, scrollTop: 99999, viewportHeight: 800 }),
    ).toEqual({ startRow: 50, endRow: 50 });
  });

  it("handles a partial last row", () => {
    // 9 items in 2 columns → 5 rows; scrolled to the last row
    expect(
      computeVisibleRows({
        rowPitch: 100,
        rowCount: 5,
        overscan: 0,
        scrollTop: 400,
        viewportHeight: 50,
      }),
    ).toEqual({ startRow: 4, endRow: 5 });
  });

  it("supports overscan 0 for an exact window", () => {
    expect(
      computeVisibleRows({
        rowPitch: 100,
        rowCount: 10,
        overscan: 0,
        scrollTop: 0,
        viewportHeight: 300,
      }),
    ).toEqual({ startRow: 0, endRow: 3 });
  });
});
