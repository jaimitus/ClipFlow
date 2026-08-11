import { memo, useCallback, useEffect, useRef, useState } from "react";
import { assetUrl, clipflow } from "../lib/bridge";
import type { ClipMetadata } from "../lib/types";
import { formatBytes, formatDuration, formatRelativeTime } from "../lib/format";
import { cn } from "../utils/cn";
import { gapFor, useVirtualGrid } from "../hooks/useVirtualGrid";

/**
 * Shared thumbnail cache keyed by clip path. The gallery scan returns clips
 * WITHOUT thumbnails (the native probe cache keeps it instant at thousands of
 * clips); each visible card decodes its own thumbnail lazily via
 * `get_clip_thumbnail` and caches it here so re-scans / re-mounts are free.
 */
const thumbCache = new Map<string, string>();

/** LRU cap so scrolling through thousands of clips can't balloon memory. */
const THUMB_CACHE_MAX = 400;
function cacheThumb(path: string, t: string) {
  // Map preserves insertion order — re-inserting refreshes recency, and the
  // oldest entry is evicted first when the budget is exceeded.
  if (thumbCache.has(path)) thumbCache.delete(path);
  thumbCache.set(path, t);
  if (thumbCache.size > THUMB_CACHE_MAX) {
    const oldest = thumbCache.keys().next().value;
    if (oldest !== undefined) thumbCache.delete(oldest);
  }
}

interface Props {
  clips: ClipMetadata[];
  loading?: boolean;
  compact?: boolean;
  /** Paths currently selected (multi-select), as a Set for O(1) lookups. */
  selectedPaths?: ReadonlySet<string>;
  /** When on, a plain card click selects instead of opening the trimmer. */
  selectMode?: boolean;
  onOpen: (clip: ClipMetadata) => void;
  onSelect: (clip: ClipMetadata, mods: { ctrl: boolean; shift: boolean }) => void;
  onCopy: (clip: ClipMetadata) => void;
  onReveal: (clip: ClipMetadata) => void;
  onOpenExternal: (clip: ClipMetadata) => void;
  onDelete: (clip: ClipMetadata) => void;
  onToggleFavorite: (clip: ClipMetadata) => void;
}

function IconButton({
  label,
  title,
  onClick,
  tone = "cyan",
}: {
  label: string;
  title: string;
  onClick: (e: React.MouseEvent) => void;
  tone?: "cyan" | "magenta" | "rose" | "slate";
}) {
  const tones = {
    cyan: "hover:border-cyan-300/60 hover:text-cyan-200",
    magenta: "hover:border-fuchsia-300/60 hover:text-fuchsia-200",
    rose: "hover:border-rose-400/60 hover:text-rose-300",
    slate: "hover:border-white/30 hover:text-slate-100",
  } as const;
  return (
    <button
      title={title}
      onClick={onClick}
      className={cn(
        "grid h-7 w-7 place-items-center rounded-md border border-white/12 bg-black/60 text-[11px] text-slate-300 backdrop-blur transition",
        tones[tone],
      )}
    >
      {label}
    </button>
  );
}

/**
 * Plays the clip inline on hover, exactly like the native gallery does.
 *
 * Memoised: App passes stable useCallback handlers and `clips` comes from a
 * `useMemo`, so a card only re-renders when its own clip (or `compact`)
 * actually changes — not on the 2 s stats poll or toast churn.
 *
 * The footer reserves a fixed tag line so every card in a row has the exact
 * same height — that's what lets the virtualised grid place rows at a uniform
 * pitch without overlap.
 */
const ClipCard = memo(function ClipCard({
  clip,
  compact,
  selected,
  selectMode,
  onOpen,
  onSelect,
  onCopy,
  onReveal,
  onOpenExternal,
  onDelete,
  onToggleFavorite,
}: {
  clip: ClipMetadata;
  compact?: boolean;
  selected: boolean;
  selectMode: boolean;
  onOpen: (c: ClipMetadata) => void;
  onSelect: (c: ClipMetadata, mods: { ctrl: boolean; shift: boolean }) => void;
  onCopy: (c: ClipMetadata) => void;
  onReveal: (c: ClipMetadata) => void;
  onOpenExternal: (c: ClipMetadata) => void;
  onDelete: (c: ClipMetadata) => void;
  onToggleFavorite: (c: ClipMetadata) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [hovering, setHovering] = useState(false);
  const [thumb, setThumb] = useState(clip.thumbnail);
  const src = clip.preview_url ?? assetUrl(clip.path);

  // Lazy thumbnail: the card only mounts when it is (near) visible thanks to
  // the virtualised grid, so requesting here means thumbnails decode on scroll
  // — never thousands up front. Cached per path so re-scans are free.
  useEffect(() => {
    if (clip.thumbnail) {
      setThumb(clip.thumbnail);
      return;
    }
    const cached = thumbCache.get(clip.path);
    if (cached) {
      setThumb(cached);
      return;
    }
    let alive = true;
    void clipflow
      .getClipThumbnail(clip.path, 1)
      .then((t) => {
        if (!alive || !t) return;
        cacheThumb(clip.path, t);
        setThumb(t);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [clip.path, clip.thumbnail]);

  // Stable handlers: the hover closures are re-created once instead of every render.
  const handleMouseEnter = useCallback(() => {
    setHovering(true);
    const v = videoRef.current;
    if (v) {
      v.currentTime = 0;
      void v.play().catch(() => undefined);
    }
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHovering(false);
    videoRef.current?.pause();
  }, []);

  // Primary click: in select mode (or with a keyboard modifier) the card
  // selects; otherwise it opens the trimmer, exactly as before.
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
      if (selectMode || mods.ctrl || mods.shift) {
        onSelect(clip, mods);
      } else {
        onOpen(clip);
      }
    },
    [clip, onOpen, onSelect, selectMode],
  );

  return (
    <article
      className={cn(
        "panel panel-hover group relative cursor-pointer overflow-hidden rounded-xl transition-colors",
        selected && "border-cyan-300/70 ring-2 ring-cyan-300/60",
      )}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="relative aspect-video w-full overflow-hidden bg-black">
        {thumb ? (
          <img
            src={thumb}
            alt={clip.title}
            loading="lazy"
            decoding="async"
            className={cn(
              "h-full w-full object-cover transition duration-300",
              hovering ? "scale-105 opacity-0" : "opacity-100",
            )}
          />
        ) : (
          <div className="bg-grid absolute inset-0 grid place-items-center bg-[#080b16]">
            <span className="animate-pulse font-mono text-[10px] tracking-[0.2em] text-slate-600">
              LOADING THUMBNAIL…
            </span>
          </div>
        )}

        {src && (
          <video
            ref={videoRef}
            src={src}
            muted
            loop
            playsInline
            preload="none"
            className={cn(
              "absolute inset-0 h-full w-full object-cover transition-opacity duration-300",
              hovering ? "opacity-100" : "opacity-0",
            )}
          />
        )}

        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#05060d] via-transparent to-transparent" />

        {clip.game && (
          <span className="absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[9px] tracking-wide text-lime-200">
            {clip.game.toUpperCase()}
          </span>
        )}

        <span className="absolute bottom-2 left-2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-cyan-200">
          {formatDuration(clip.duration_seconds)}
        </span>
        <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-slate-300">
          {clip.height}p{clip.fps}
        </span>

        {clip.favorite && (
          <span className="absolute left-2 top-8 rounded bg-amber-400/90 px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wide text-black">
            ★
          </span>
        )}

        <div
          className={cn(
            "absolute right-2 top-2 flex gap-1.5 transition",
            selectMode ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          {(selectMode || selected) && (
            <IconButton
              label={selected ? "✓" : "☐"}
              title={selected ? "Deselect clip" : "Select clip"}
              tone="slate"
              onClick={(e) => {
                e.stopPropagation();
                onSelect(clip, { ctrl: true, shift: false });
              }}
            />
          )}
          <IconButton
            label={clip.favorite ? "★" : "☆"}
            title={clip.favorite ? "Remove from favourites" : "Add to favourites"}
            tone="slate"
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(clip);
            }}
          />
          <IconButton
            label="▶"
            title="Open in external player"
            tone="slate"
            onClick={(e) => {
              e.stopPropagation();
              onOpenExternal(clip);
            }}
          />
          <IconButton
            label="⧉"
            title="Copy video to clipboard"
            tone="magenta"
            onClick={(e) => {
              e.stopPropagation();
              onCopy(clip);
            }}
          />
          <IconButton
            label="⌕"
            title="Reveal in Explorer"
            tone="cyan"
            onClick={(e) => {
              e.stopPropagation();
              onReveal(clip);
            }}
          />
          <IconButton
            label="✕"
            title="Delete clip"
            tone="rose"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(clip);
            }}
          />
        </div>
      </div>

      {/* Fixed heights throughout so every card in a row is identical in size. */}
      <div className={compact ? "px-2.5 py-2" : "px-3 py-2.5"}>
        <div className="h-5 truncate text-[13px] font-medium text-slate-100">{clip.title}</div>
        <div className="mt-1 flex h-4 items-center gap-1 overflow-hidden">
          {clip.tags.length > 0 && (
            <>
              {clip.tags.slice(0, 3).map((t) => (
                <span
                  key={t}
                  className="shrink-0 rounded-full border border-fuchsia-300/25 bg-fuchsia-500/10 px-1.5 py-px font-mono text-[9px] text-fuchsia-200/90"
                >
                  #{t}
                </span>
              ))}
              {clip.tags.length > 3 && (
                <span className="shrink-0 font-mono text-[9px] text-slate-600">
                  +{clip.tags.length - 3}
                </span>
              )}
            </>
          )}
        </div>
        <div className="mt-1 flex items-center justify-between font-mono text-[10px] text-slate-500">
          <span>{formatRelativeTime(clip.created_unix_ms)}</span>
          <span>{formatBytes(clip.size_bytes)}</span>
        </div>
      </div>
    </article>
  );
});

/**
 * Virtualised grid: only the rows inside (or near) the scroll viewport are
 * mounted, so thousands of clips keep a handful of cards in the DOM. All props
 * are stable (useCallback handlers + useMemo clips), so unrelated App state
 * (stats poll, toasts, tab switches) skips the whole reconciliation.
 */
const GalleryGrid = memo(function GalleryGrid({
  clips,
  loading,
  compact,
  selectedPaths,
  selectMode,
  onOpen,
  onSelect,
  onCopy,
  onReveal,
  onOpenExternal,
  onDelete,
  onToggleFavorite,
}: Props) {
  const gap = gapFor(!!compact);
  const { cols, rowPitch, totalHeight, startRow, endRow, containerRef, rowRef } =
    useVirtualGrid({ itemCount: clips.length, compact: !!compact });

  const gridClass = compact
    ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
    : "grid gap-4 sm:grid-cols-2 xl:grid-cols-3";

  // The container is ALWAYS mounted (even while loading / empty) so the
  // virtual-grid hook's ResizeObserver/scroll wiring exists from the very
  // first render — when the first clips land, the window is already live.
  let content: React.ReactNode;
  if (loading) {
    content = (
      <div className={gridClass}>
        {Array.from({ length: compact ? 8 : 6 }).map((_, i) => (
          <div key={i} className="panel h-[190px] animate-pulse rounded-xl opacity-50" />
        ))}
      </div>
    );
  } else if (clips.length === 0) {
    content = (
      <div className="panel bg-grid flex flex-col items-center justify-center gap-3 rounded-2xl px-6 py-16 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl border border-cyan-300/30 bg-cyan-400/10 text-2xl">
          🎬
        </div>
        <div className="font-mono text-sm tracking-[0.18em] text-slate-300">
          NO CLIPS YET
        </div>
        <p className="max-w-sm text-[13px] leading-relaxed text-slate-500">
          The rolling buffer is filling up in memory. Hit{" "}
          <span className="font-mono text-cyan-300">Alt + C</span> at any moment and the
          last seconds of gameplay land here instantly.
        </p>
      </div>
    );
  } else {
    const rows: React.ReactNode[] = [];
  for (let r = startRow; r < endRow; r++) {
    const from = r * cols;
    rows.push(
      <div
        key={r}
        ref={r === startRow ? rowRef : undefined}
        className="absolute left-0 right-0 grid"
        style={{
          top: r * rowPitch,
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gap: `${gap}px`,
        }}
      >
        {clips.slice(from, from + cols).map((clip) => (
          <ClipCard
            key={clip.id}
            clip={clip}
            compact={compact}
            selected={selectedPaths?.has(clip.path) ?? false}
            selectMode={!!selectMode}
            onOpen={onOpen}
            onSelect={onSelect}
            onCopy={onCopy}
            onReveal={onReveal}
            onOpenExternal={onOpenExternal}
            onDelete={onDelete}
            onToggleFavorite={onToggleFavorite}
          />
        ))}
      </div>,
    );
    }
    content = rows;
  }

  return (
    <div ref={containerRef} className="relative" style={{ height: totalHeight || undefined }}>
      {content}
    </div>
  );
});

export default GalleryGrid;
