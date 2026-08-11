import { describe, expect, it } from "vitest";
import {
  EMPTY_SELECTION,
  isSelected,
  selectionCount,
  selectionReducer,
  type SelectionState,
} from "./selection";

const ORDER = ["/a.mp4", "/b.mp4", "/c.mp4", "/d.mp4", "/e.mp4"];

function click(
  state: SelectionState,
  path: string,
  opts: { ctrl?: boolean; shift?: boolean; order?: string[] } = {},
): SelectionState {
  return selectionReducer(state, {
    type: "click",
    path,
    order: opts.order ?? ORDER,
    ctrl: opts.ctrl ?? false,
    shift: opts.shift ?? false,
  });
}

describe("selectionReducer", () => {
  it("plain click selects just that clip and sets the anchor", () => {
    const s = click(EMPTY_SELECTION, "/b.mp4");
    expect(s.anchor).toBe("/b.mp4");
    expect(s.selected).toEqual(["/b.mp4"]);
    expect(selectionCount(s)).toBe(1);
  });

  it("plain click replaces any previous selection", () => {
    const s1 = click(EMPTY_SELECTION, "/a.mp4");
    const s2 = click(s1, "/c.mp4");
    expect(s2.selected).toEqual(["/c.mp4"]);
    expect(s2.anchor).toBe("/c.mp4");
  });

  it("ctrl click toggles a clip into and out of the selection", () => {
    const s1 = click(EMPTY_SELECTION, "/a.mp4", { ctrl: true });
    expect(s1.selected).toEqual(["/a.mp4"]);
    const s2 = click(s1, "/a.mp4", { ctrl: true });
    expect(s2.selected).toEqual([]);
    expect(s2.anchor).toBe("/a.mp4");
  });

  it("ctrl click accumulates distinct clips", () => {
    const s1 = click(EMPTY_SELECTION, "/a.mp4", { ctrl: true });
    const s2 = click(s1, "/c.mp4", { ctrl: true });
    const s3 = click(s2, "/e.mp4", { ctrl: true });
    expect(s3.selected).toEqual(["/a.mp4", "/c.mp4", "/e.mp4"]);
  });

  it("shift click selects the forward range from the anchor", () => {
    const s1 = click(EMPTY_SELECTION, "/b.mp4");
    const s2 = click(s1, "/d.mp4", { shift: true });
    expect(s2.selected).toEqual(["/b.mp4", "/c.mp4", "/d.mp4"]);
    // The anchor moves to the last clicked clip for chained ranges.
    expect(s2.anchor).toBe("/d.mp4");
  });

  it("shift click selects the backward range", () => {
    const s1 = click(EMPTY_SELECTION, "/d.mp4");
    const s2 = click(s1, "/b.mp4", { shift: true });
    expect(s2.selected).toEqual(["/b.mp4", "/c.mp4", "/d.mp4"]);
  });

  it("ctrl+shift unions the range with the existing selection", () => {
    const s1 = click(EMPTY_SELECTION, "/a.mp4", { ctrl: true });
    const s2 = click(s1, "/c.mp4", { ctrl: true }); // a + c
    const s3 = click(s2, "/d.mp4", { ctrl: true, shift: true }); // union c..d
    expect(s3.selected).toEqual(["/a.mp4", "/c.mp4", "/d.mp4"]);
  });

  it("shift click with no anchor falls back to a plain selection", () => {
    const s = click(EMPTY_SELECTION, "/c.mp4", { shift: true });
    expect(s.selected).toEqual(["/c.mp4"]);
  });

  it("shift click with a filtered-out anchor falls back to a plain selection", () => {
    const s1 = click(EMPTY_SELECTION, "/z.mp4"); // not in the visible order
    const s2 = click(s1, "/d.mp4", { shift: true });
    expect(s2.selected).toEqual(["/d.mp4"]);
  });

  it("clear empties everything", () => {
    const s1 = click(EMPTY_SELECTION, "/a.mp4", { ctrl: true });
    const s2 = selectionReducer(s1, { type: "clear" });
    expect(s2).toEqual(EMPTY_SELECTION);
  });

  it("remove prunes paths and drops the anchor if it was removed", () => {
    const s1 = click(EMPTY_SELECTION, "/b.mp4");
    const s2 = click(s1, "/d.mp4", { shift: true }); // b..d
    const s3 = selectionReducer(s2, { type: "remove", paths: ["/c.mp4", "/b.mp4"] });
    expect(s3.selected).toEqual(["/d.mp4"]);
    // Anchor (/d.mp4) survives; a removed anchor would be nulled.
    expect(s3.anchor).toBe("/d.mp4");
    const s4 = selectionReducer(s2, { type: "remove", paths: ["/b.mp4", "/d.mp4"] });
    expect(s4.anchor).toBeNull();
    expect(s4.selected).toEqual(["/c.mp4"]);
  });

  it("select-all action selects every visible clip in order", () => {
    const s = selectionReducer(EMPTY_SELECTION, { type: "select-all", order: ORDER });
    expect(s.selected).toEqual(ORDER);
    expect(s.anchor).toBe("/a.mp4");
    expect(isSelected(s, "/e.mp4")).toBe(true);
  });

  it("select-all on an empty order yields an empty selection", () => {
    const s = selectionReducer(EMPTY_SELECTION, { type: "select-all", order: [] });
    expect(s.selected).toEqual([]);
    expect(s.anchor).toBeNull();
  });
});
