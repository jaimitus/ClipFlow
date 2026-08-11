import { useCallback, useEffect, useRef, useState } from "react";

/** Horizontal/vertical gap between cards — mirrors `gap-4` (16px) / `gap-3` (12px). */
export function gapFor(compact: boolean): number {
  return compact ? 12 : 16;
}

/** Column count for a gallery width — mirrors the Tailwind `sm:`/`xl:` breakpoints. */
export function colsForWidth(width: number, compact: boolean): number {
  if (width < 640) return 1;
  if (width < 1280) return 2;
  return compact ? 4 : 3;
}

export interface VisibleRows {
  startRow: number;
  endRow: number; // exclusive
}

/**
 * Pure windowing math: which rows are inside (or near) the scroll viewport.
 *
 * `scrollTop` is the container's *local* scroll offset (already shifted by the
 * container's position inside the scroll parent). `rowPitch` is the row height
 * plus the vertical gap. Rows outside the window are not rendered at all, so a
 * gallery with thousands of clips keeps only a viewport-full in the DOM.
 */
export function computeVisibleRows(opts: {
  scrollTop: number;
  viewportHeight: number;
  rowPitch: number;
  rowCount: number;
  overscan: number;
}): VisibleRows {
  const { scrollTop, viewportHeight, rowPitch, rowCount, overscan } = opts;
  if (rowCount <= 0 || rowPitch <= 0 || viewportHeight <= 0) {
    return { startRow: 0, endRow: 0 };
  }
  const startRow = Math.min(
    rowCount,
    Math.max(0, Math.floor(scrollTop / rowPitch) - overscan),
  );
  const endRow = Math.min(
    rowCount,
    Math.max(startRow, Math.ceil((scrollTop + viewportHeight) / rowPitch) + overscan),
  );
  return { startRow, endRow };
}

const DEFAULT_OVERSCAN = 3;

/**
 * Footer estimate (px) until the first row is measured — thumbnail is
 * aspect-video. Deliberately overshot: a couple of px of invisible gap is fine,
 * an undershot pitch would overlap rows while the estimate is in use, and the
 * measurement correction then shrinks the scrollbar slightly instead of
 * growing it by thousands of px in a big library.
 */
const FOOTER_ESTIMATE = { compact: 84, normal: 88 } as const;

export interface VirtualGrid {
  /** Attach to the grid container (`position: relative`, height = totalHeight). */
  containerRef: (el: HTMLDivElement | null) => void;
  /** Attach to the first rendered row; measures the real row height. */
  rowRef: (el: HTMLDivElement | null) => void;
  cols: number;
  rowPitch: number;
  totalHeight: number;
  startRow: number;
  endRow: number;
}

/**
 * Virtualised grid windowing for the clip gallery.
 *
 * - Window math is pure (`computeVisibleRows`) and unit-tested.
 * - The scroll parent is found by walking up to the nearest `overflow-y` node;
 *   a capture-phase `window` scroll listener sees every scroller in the app.
 * - An IntersectionObserver refreshes the window when the grid becomes visible
 *   again (tab back, layout change) and lets the updates idle while the grid is
 *   far off-screen.
 * - Row height is measured once from the first rendered row (uniform footer)
 *   and reused; width changes (resize / compact toggle) re-measure.
 */
export function useVirtualGrid(opts: {
  itemCount: number;
  compact: boolean;
  overscan?: number;
}): VirtualGrid {
  const { itemCount, compact } = opts;
  const overscan = opts.overscan ?? DEFAULT_OVERSCAN;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const measuredForCols = useRef<number | null>(null);
  const [width, setWidth] = useState(0);
  const [scroll, setScroll] = useState({
    scrollTop: 0,
    viewportHeight: 0,
    containerTop: 0,
  });
  const [rowHeight, setRowHeight] = useState<number | null>(null);

  const gap = gapFor(compact);
  const cols = colsForWidth(width, compact);

  const attachContainer = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
  }, []);

  // Container width drives the column count.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Scroll parent + visibility: window scroll (capture) sees every scroller,
  // IO re-windows when the grid re-enters the visible area.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let raf = 0;
    let scroller: HTMLElement | null = null;

    const detectScroller = () => {
      let p = el.parentElement;
      while (p) {
        const oy = getComputedStyle(p).overflowY;
        if (/(auto|scroll|overlay)/.test(oy) && p.scrollHeight > p.clientHeight + 1) {
          scroller = p;
          return;
        }
        p = p.parentElement;
      }
      scroller = null;
    };

    const update = () => {
      raf = 0;
      if (!containerRef.current) return;
      // Re-detect when there is no scroller yet (content may have grown since
      // mount) or the cached one stopped overflowing (layout change).
      if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 1) {
        detectScroller();
      }
      const rect = containerRef.current.getBoundingClientRect();
      const top = scroller ? scroller.scrollTop : window.scrollY;
      const height = scroller ? scroller.clientHeight : window.innerHeight;
      const containerTop = scroller
        ? rect.top - scroller.getBoundingClientRect().top + top
        : rect.top + top;
      setScroll((prev) =>
        prev.scrollTop === top &&
        prev.viewportHeight === height &&
        prev.containerTop === containerTop
          ? prev
          : { scrollTop: top, viewportHeight: height, containerTop },
      );
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };

    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) schedule();
      },
      { root: scroller ?? null, rootMargin: "1000px" },
    );
    io.observe(el);

    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    schedule();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  // Measure the real row height from the first rendered row. The callback is
  // re-created when the column count changes so React re-attaches it (null then
  // el) and the new layout gets re-measured immediately.
  const roForRow = useRef<ResizeObserver | null>(null);
  const rowRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return;
      const measure = () => {
        measuredForCols.current = cols;
        const h = el.offsetHeight;
        setRowHeight((prev) => (prev === h ? prev : h));
      };
      measure();
      roForRow.current?.disconnect();
      roForRow.current = new ResizeObserver(measure);
      roForRow.current.observe(el);
    },
    [cols],
  );
  useEffect(() => () => roForRow.current?.disconnect(), []);

  const rowCount = Math.max(0, Math.ceil(itemCount / cols));
  const cardWidth = width > 0 ? Math.max(0, (width - gap * (cols - 1)) / cols) : 0;
  const footerEstimate = compact ? FOOTER_ESTIMATE.compact : FOOTER_ESTIMATE.normal;
  const thumbEstimate = cardWidth > 0 ? Math.round(cardWidth * (9 / 16)) : 0;
  const estimate = Math.max(120, thumbEstimate + footerEstimate);
  const rh = measuredForCols.current === cols && rowHeight ? rowHeight : estimate;
  const rowPitch = rh + gap;
  // Subtract the trailing gap so the container ends exactly at the last row.
  const totalHeight = rowCount > 0 ? rowCount * rowPitch - gap : 0;

  const localTop = Math.max(0, scroll.scrollTop - scroll.containerTop);
  const { startRow, endRow } = computeVisibleRows({
    scrollTop: localTop,
    viewportHeight: scroll.viewportHeight,
    rowPitch,
    rowCount,
    overscan,
  });

  return { containerRef: attachContainer, rowRef, cols, rowPitch, totalHeight, startRow, endRow };
}
