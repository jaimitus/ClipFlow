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

/** LRU cap so scrolling through thousands of clips cannot balloon memory. */
const THUMB_CACHE_MAX = 400;
function cacheThumb(path: string, t: string) {
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
  title,
  onClick,
  danger,
  highlight,
  children,
}: {
  title: string;
  onClick: (e: React.MouseEvent) => void;
  danger?: boolean;
  highlight?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "grid h-7 w-7 place-items-center rounded-md border text-[11px] backdrop-blur-sm transition-colors duration-150",
        danger
          ? "border-red-500/30 bg-[#161a22]/90 text-red-300 hover:border-red-400/60 hover:bg-red-500/20"
          : highlight
            ? "border-amber-400/40 bg-[#161a22]/90 text-amber-300 hover:border-amber-400/70 hover:bg-amber-400/20"
            : "border-[#343e4f] bg-[#161a22]/90 text-[#b5c0d0] hover:border-blue-400/60 hover:bg-[#1f2633] hover:text-white",
      )}
    >
      {children}
    </button>
  );
}

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
        "panel panel-hover group relative cursor-pointer overflow-hidden rounded-xl transition-all duration-150",
        selected
          ? "border-blue-500 ring-2 ring-blue-500/40 bg-[#1a202a]"
          : "hover:border-[#384354]",
      )}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Thumbnail / Video Preview Viewport */}
      <div className="relative aspect-video w-full overflow-hidden bg-[#0c0e13]">
        {thumb ? (
          <img
            src={thumb}
            alt={clip.title}
            loading="lazy"
            decoding="async"
            className={cn(
              "h-full w-full object-cover transition-opacity duration-200",
              hovering ? "opacity-0" : "opacity-100",
            )}
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center bg-[#13161c]">
            <span className="font-mono text-[10px] text-[#5d6878]">DECODING FRAME…</span>
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
              "absolute inset-0 h-full w-full object-cover transition-opacity duration-200",
              hovering ? "opacity-100" : "opacity-0",
            )}
          />
        )}

        {/* Readability scrim */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#0e1117]/90 via-transparent to-transparent" />

        {/* Game badge */}
        {clip.game && (
          <span className="absolute left-2.5 top-2.5 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-wide text-white border border-white/10">
            {clip.game.toUpperCase()}
          </span>
        )}

        {/* Duration badge */}
        <span className="absolute bottom-2 left-2.5 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[11px] font-medium text-[#e6eaf0] border border-white/10">
          {formatDuration(clip.duration_seconds)}
        </span>

        {/* Format / resolution badge */}
        <span className="absolute bottom-2 right-2.5 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[10px] text-[#9ba6b6] border border-white/10">
          {clip.height}p{clip.fps}
        </span>

        {/* Favorite indicator */}
        {clip.favorite && (
          <span
            className="absolute left-2.5 top-8 rounded bg-amber-500/90 px-1.5 py-0.5 font-mono text-[9px] font-bold text-black"
            title="Favorited clip"
          >
            ★
          </span>
        )}

        {/* Action button overlay */}
        <div
          className={cn(
            "absolute right-2 top-2 flex items-center gap-1 transition-opacity duration-150",
            selectMode ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          {(selectMode || selected) && (
            <IconButton
              title={selected ? "Deselect clip" : "Select clip"}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(clip, { ctrl: true, shift: false });
              }}
            >
              <span className="font-mono text-[12px]">{selected ? "✓" : "☐"}</span>
            </IconButton>
          )}

          <IconButton
            title={clip.favorite ? "Remove from favorites" : "Add to favorites"}
            highlight={clip.favorite}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(clip);
            }}
          >
            <span>{clip.favorite ? "★" : "☆"}</span>
          </IconButton>

          <IconButton
            title="Open in external player"
            onClick={(e) => {
              e.stopPropagation();
              onOpenExternal(clip);
            }}
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3 fill-current">
              <path d="M4 3.5v9l8-4.5-8-4.5z" />
            </svg>
          </IconButton>

          <IconButton
            title="Copy video file to clipboard"
            onClick={(e) => {
              e.stopPropagation();
              onCopy(clip);
            }}
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3 fill-none stroke-current" strokeWidth="1.5">
              <rect x="5" y="5" width="8" height="8" rx="1.5" />
              <path d="M3 11V3a1 1 0 0 1 1-1h8" />
            </svg>
          </IconButton>

          <IconButton
            title="Reveal in Explorer"
            onClick={(e) => {
              e.stopPropagation();
              onReveal(clip);
            }}
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3 fill-none stroke-current" strokeWidth="1.5">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5L14 14" />
            </svg>
          </IconButton>

          <IconButton
            title="Delete clip"
            danger
            onClick={(e) => {
              e.stopPropagation();
              onDelete(clip);
            }}
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3 fill-none stroke-current" strokeWidth="1.5">
              <path d="M3 4h10M6 4V2.5A1.5 1.5 0 0 1 7.5 1h1A1.5 1.5 0 0 1 10 2.5V4M5 4v9a1.5 1.5 0 0 0 1.5 1.5h3A1.5 1.5 0 0 0 11 13V4" />
            </svg>
          </IconButton>
        </div>
      </div>

      {/* Card Content Footer */}
      <div className={compact ? "px-2.5 py-2" : "px-3 py-2.5"}>
        <div className="h-5 truncate text-[13px] font-medium text-[#e2e7ef]">{clip.title}</div>
        <div className="mt-1 flex h-4 items-center gap-1 overflow-hidden">
          {clip.tags.length > 0 && (
            <>
              {clip.tags.slice(0, 3).map((t) => (
                <span
                  key={t}
                  className="shrink-0 rounded border border-[#2f3846] bg-[#1e242f] px-1.5 py-px font-mono text-[9px] text-[#9ca7b6]"
                >
                  #{t}
                </span>
              ))}
              {clip.tags.length > 3 && (
                <span className="shrink-0 font-mono text-[9px] text-[#6d798a]">
                  +{clip.tags.length - 3}
                </span>
              )}
            </>
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] text-[#7d8a9c]">
          <span>{formatRelativeTime(clip.created_unix_ms)}</span>
          <span>{formatBytes(clip.size_bytes)}</span>
        </div>
      </div>
    </article>
  );
});

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

  let content: React.ReactNode;
  if (loading) {
    content = (
      <div className={gridClass}>
        {Array.from({ length: compact ? 8 : 6 }).map((_, i) => (
          <div key={i} className="panel h-[190px] animate-pulse rounded-xl bg-[#171b22]" />
        ))}
      </div>
    );
  } else if (clips.length === 0) {
    content = (
      <div className="panel flex flex-col items-center justify-center gap-3 rounded-xl px-6 py-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-[#2b3342] bg-[#1e242f] text-[#8692a3]">
          <svg viewBox="0 0 24 24" className="h-6 w-6 fill-none stroke-current" strokeWidth="1.5">
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="M7 4v16M17 4v16M2 12h20M2 8h5M2 16h5M17 8h5M17 16h5" />
          </svg>
        </div>
        <div className="font-mono text-[13px] font-semibold tracking-wider text-[#d4dae3]">
          NO CLIPS RECORDED YET
        </div>
        <p className="max-w-sm text-[12px] leading-relaxed text-[#8692a3]">
          The rolling buffer is running in memory. Press{" "}
          <kbd className="rounded border border-[#3b4556] bg-[#1e242f] px-1.5 py-0.5 font-mono text-[11px] text-[#e6eaf0]">
            Alt + C
          </kbd>{" "}
          at any time while playing to save the last replay moments instantly.
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
