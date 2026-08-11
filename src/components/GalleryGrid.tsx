import { useCallback, useRef, useState } from "react";
import { assetUrl } from "../lib/bridge";
import type { ClipMetadata } from "../lib/types";
import { formatBytes, formatDuration, formatRelativeTime } from "../lib/format";
import { cn } from "../utils/cn";

interface Props {
  clips: ClipMetadata[];
  loading?: boolean;
  compact?: boolean;
  onOpen: (clip: ClipMetadata) => void;
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

/** Plays the clip inline on hover, exactly like the native gallery does. */
function ClipCard({
  clip,
  compact,
  onOpen,
  onCopy,
  onReveal,
  onOpenExternal,
  onDelete,
  onToggleFavorite,
}: {
  clip: ClipMetadata;
  compact?: boolean;
  onOpen: (c: ClipMetadata) => void;
  onCopy: (c: ClipMetadata) => void;
  onReveal: (c: ClipMetadata) => void;
  onOpenExternal: (c: ClipMetadata) => void;
  onDelete: (c: ClipMetadata) => void;
  onToggleFavorite: (c: ClipMetadata) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [hovering, setHovering] = useState(false);
  const src = clip.preview_url ?? assetUrl(clip.path);

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

  return (
    <article
      className="panel panel-hover group relative cursor-pointer overflow-hidden rounded-xl"
      onClick={() => onOpen(clip)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="relative aspect-video w-full overflow-hidden bg-black">
        {clip.thumbnail ? (
          <img
            src={clip.thumbnail}
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
            <span className="font-mono text-[10px] tracking-[0.2em] text-slate-600">
              NO THUMBNAIL
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

        <div className="absolute right-2 top-2 flex gap-1.5 opacity-0 transition group-hover:opacity-100">
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

      <div className={compact ? "px-2.5 py-2" : "px-3 py-2.5"}>
        <div className="truncate text-[13px] font-medium text-slate-100">{clip.title}</div>
        {clip.tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {clip.tags.slice(0, 3).map((t) => (
              <span
                key={t}
                className="rounded-full border border-fuchsia-300/25 bg-fuchsia-500/10 px-1.5 py-px font-mono text-[9px] text-fuchsia-200/90"
              >
                #{t}
              </span>
            ))}
            {clip.tags.length > 3 && (
              <span className="font-mono text-[9px] text-slate-600">+{clip.tags.length - 3}</span>
            )}
          </div>
        )}
        <div className="mt-1 flex items-center justify-between font-mono text-[10px] text-slate-500">
          <span>{formatRelativeTime(clip.created_unix_ms)}</span>
          <span>{formatBytes(clip.size_bytes)}</span>
        </div>
      </div>
    </article>
  );
}

export default function GalleryGrid({
  clips,
  loading,
  compact,
  onOpen,
  onCopy,
  onReveal,
  onOpenExternal,
  onDelete,
  onToggleFavorite,
}: Props) {
  const gridClass = compact
    ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
    : "grid gap-4 sm:grid-cols-2 xl:grid-cols-3";

  if (loading) {
    return (
      <div className={gridClass}>
        {Array.from({ length: compact ? 8 : 6 }).map((_, i) => (
          <div key={i} className="panel h-[190px] animate-pulse rounded-xl opacity-50" />
        ))}
      </div>
    );
  }

  if (clips.length === 0) {
    return (
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
  }

  return (
    <div className={gridClass}>
      {clips.map((clip) => (
        <ClipCard
          key={clip.id}
          clip={clip}
          compact={compact}
          onOpen={onOpen}
          onCopy={onCopy}
          onReveal={onReveal}
          onOpenExternal={onOpenExternal}
          onDelete={onDelete}
          onToggleFavorite={onToggleFavorite}
        />
      ))}
    </div>
  );
}
