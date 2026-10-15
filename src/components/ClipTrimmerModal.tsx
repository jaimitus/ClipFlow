import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { assetUrl, clipflow } from "../lib/bridge";
import type { ClipMetadata } from "../lib/types";
import { clamp, formatBytes, formatTimecode } from "../lib/format";
import { cn } from "../utils/cn";

type Thumb = "start" | "end" | "playhead" | null;

export interface TrimmerAction {
  type: "copy" | "save" | "discard" | "reveal";
}

interface Props {
  clip: ClipMetadata;
  flushMs?: number;
  busy?: boolean;
  /** Trim + save. Resolves once the backend stream-copy finishes. */
  onSaveTrimmed: (start: number, end: number) => Promise<void> | void;
  onCopy: () => Promise<void> | void;
  onReveal: () => Promise<void> | void;
  onOpenExternal: () => Promise<void> | void;
  onRename: (newName: string) => Promise<void> | void;
  /** Current frame → PNG data URL (hardware decode on native). */
  onSnapshot: (pngBase64: string) => Promise<void> | void;
  /** Cuts the clip in two at the playhead (two stream-copy trims). */
  onSplit: (splitSeconds: number) => Promise<void> | void;
  /** Exports the selection as an animated GIF (native; errors toast in App). */
  onExportGif: (start: number, end: number, width: number, fps: number) => Promise<void> | void;
  onDiscard: () => Promise<void> | void;
  onClose: () => void;
  /** Stars / unstars this clip (persisted in the local sidecar store). */
  onToggleFavorite: () => Promise<void> | void;
  /** Replaces this clip's custom tags. */
  onUpdateTags: (tags: string[]) => Promise<void> | void;
}

const HANDLE_W = 14;

export default function ClipTrimmerModal({
  clip,
  flushMs,
  busy,
  onSaveTrimmed,
  onCopy,
  onReveal,
  onOpenExternal,
  onRename,
  onSnapshot,
  onSplit,
  onExportGif,
  onDiscard,
  onClose,
  onToggleFavorite,
  onUpdateTags,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  const [duration, setDuration] = useState(Math.max(clip.duration_seconds, 0.1));
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(Math.max(clip.duration_seconds, 0.1));
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [dragging, setDragging] = useState<Thumb>(null);
  const [muted, setMuted] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(clip.file_name);
  const [tagDraft, setTagDraft] = useState("");
  const [gifOpen, setGifOpen] = useState(false);
  const [gifWidth, setGifWidth] = useState(480);
  const [gifFps, setGifFps] = useState(15);

  const src = clip.preview_url ?? assetUrl(clip.path);
  const hasVideo = src.length > 0;

  useEffect(() => {
    setStart(0);
    setEnd(Math.max(clip.duration_seconds, 0.1));
    setPlayhead(0);
    setDuration(Math.max(clip.duration_seconds, 0.1));
    setNameDraft(clip.file_name);
    setRenaming(false);
  }, [clip.id, clip.duration_seconds, clip.file_name]);

  const commitRename = useCallback(() => {
    const next = nameDraft.trim();
    if (!next || next === clip.file_name) {
      setNameDraft(clip.file_name);
      setRenaming(false);
      return;
    }
    void run("Renaming…", async () => {
      try {
        await onRename(next);
      } finally {
        setRenaming(false);
      }
    });
  }, [clip.file_name, nameDraft, onRename]);

  const handleLoadedMetadata = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.duration && !Number.isNaN(v.duration)) {
      setDuration(v.duration);
      setEnd((cur) => (cur > v.duration ? v.duration : cur));
    }
  };

  const seek = useCallback(
    (time: number) => {
      const clamped = clamp(time, 0, duration);
      setPlayhead(clamped);
      const v = videoRef.current;
      if (v) v.currentTime = clamped;
    },
    [duration],
  );

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime >= end) v.currentTime = start;
      void v.play().catch(() => undefined);
    } else {
      v.pause();
    }
  }, [end, start]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let raf: number;
    const loop = () => {
      if (!v.paused) {
        const cur = v.currentTime;
        setPlayhead(cur);
        if (cur >= end) {
          v.pause();
          v.currentTime = start;
          setPlayhead(start);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [end, start]);

  const positionFromEvent = useCallback(
    (clientX: number): number => {
      const el = trackRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const ratio = (clientX - rect.left) / rect.width;
      return clamp(ratio * duration, 0, duration);
    },
    [duration],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const t = positionFromEvent(e.clientX);
      if (dragging === "start") {
        const nextStart = clamp(t, 0, end - 0.2);
        setStart(nextStart);
        seek(nextStart);
      } else if (dragging === "end") {
        const nextEnd = clamp(t, start + 0.2, duration);
        setEnd(nextEnd);
        seek(nextEnd);
      } else if (dragging === "playhead") {
        seek(clamp(t, start, end));
      }
    };
    const onUp = () => setDragging(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, duration, end, positionFromEvent, seek, start]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "i" || e.key === "I") {
        setStart(clamp(playhead, 0, end - 0.2));
      } else if (e.key === "o" || e.key === "O") {
        setEnd(clamp(playhead, start + 0.2, duration));
      } else if (e.key === "ArrowLeft") {
        seek(clamp(playhead - (e.shiftKey ? 1 : 1 / 60), start, end));
      } else if (e.key === "ArrowRight") {
        seek(clamp(playhead + (e.shiftKey ? 1 : 1 / 60), start, end));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, togglePlay, playhead, start, end, duration, seek]);

  const selectionSeconds = Math.max(end - start, 0);
  const estimatedBytes = useMemo(
    () =>
      clip.duration_seconds > 0
        ? Math.round(clip.size_bytes * (selectionSeconds / clip.duration_seconds))
        : clip.size_bytes,
    [clip.size_bytes, clip.duration_seconds, selectionSeconds],
  );

  const pct = (t: number) => `${clamp((t / duration) * 100, 0, 100)}%`;

  const run = async (label: string, fn: () => Promise<void> | void) => {
    setStatus(label);
    try {
      await fn();
    } finally {
      setStatus(null);
    }
  };

  const takeSnapshot = () => {
    const v = videoRef.current;
    if (!v) return;
    void run("Capturing frame…", () =>
      clipflow
        .extractFramePng(clip.path, playhead, 0)
        .then((png) => onSnapshot(png)),
    );
  };

  const ticks = useMemo(() => {
    const count = 10;
    return Array.from({ length: count + 1 }, (_, i) => (duration * i) / count);
  }, [duration]);

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto p-4">
      <div
        className="animate-fade fixed inset-0 bg-[#0d0f14]/85 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="relative flex min-h-full items-center justify-center">
        <div className="animate-pop panel-elevated relative z-10 flex w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-[#313a49] bg-[#171b22]">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-[#232934] px-5 py-3">
            <div className="flex items-center gap-3">
              <span className="h-2.5 w-2.5 rounded-full bg-blue-400" />
              <div>
                <div className="font-mono text-[11px] font-semibold tracking-wider text-[#d4dae3]">
                  CLIP TRIMMER
                </div>
                {renaming ? (
                  <input
                    name="clip-rename"
                    autoFocus
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename();
                      } else if (e.key === "Escape") {
                        setNameDraft(clip.file_name);
                        setRenaming(false);
                      }
                    }}
                    onBlur={commitRename}
                    className="mt-0.5 w-full max-w-[42ch] rounded border border-blue-400/50 bg-[#14171e] px-2 py-0.5 font-mono text-[11px] text-[#e6eaf0] outline-none"
                    spellCheck={false}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setNameDraft(clip.file_name);
                      setRenaming(true);
                    }}
                    title="Rename clip"
                    className="group mt-0.5 flex items-center gap-1.5 font-mono text-[11px] text-[#8692a3] transition hover:text-[#d4dae3]"
                  >
                    <span className="max-w-[44ch] truncate">{clip.file_name}</span>
                    <span className="text-[10px] text-[#556172] group-hover:text-blue-400">
                      [Rename]
                    </span>
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              {typeof flushMs === "number" && (
                <span className="rounded border border-[#2f3846] bg-[#14171e] px-2 py-1 font-mono text-[10px] text-[#8692a3]">
                  FLUSHED IN {flushMs.toFixed(1)} MS
                </span>
              )}
              <button
                type="button"
                onClick={() => void onToggleFavorite()}
                title={clip.favorite ? "Remove from favorites" : "Add to favorites"}
                className={cn(
                  "grid h-7 w-7 place-items-center rounded-md border text-[13px] transition-colors",
                  clip.favorite
                    ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
                    : "border-[#2c3543] bg-[#14171e] text-[#8692a3] hover:text-white",
                )}
              >
                {clip.favorite ? "★" : "☆"}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="grid h-7 w-7 place-items-center rounded-md border border-[#2c3543] bg-[#14171e] text-[#8692a3] transition-colors hover:border-red-400/50 hover:text-red-300"
                aria-label="Close trimmer"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Tags bar */}
          <div className="flex flex-wrap items-center gap-1.5 border-b border-[#232934] bg-[#13161c] px-5 py-2">
            <span className="font-mono text-[10px] tracking-wider text-[#6d798a]">TAGS</span>
            {clip.tags.map((t) => (
              <span
                key={t}
                className="flex items-center gap-1 rounded border border-[#2c3543] bg-[#1a202a] px-2 py-0.5 font-mono text-[10px] text-[#b5c0d0]"
              >
                #{t}
                <button
                  type="button"
                  onClick={() => void onUpdateTags(clip.tags.filter((x) => x !== t))}
                  title={`Remove tag ${t}`}
                  className="text-[#6d798a] hover:text-red-300"
                >
                  ✕
                </button>
              </span>
            ))}
            <input
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const tag = tagDraft.trim();
                if (!tag || clip.tags.includes(tag)) {
                  setTagDraft("");
                  return;
                }
                void onUpdateTags([...clip.tags, tag]);
                setTagDraft("");
              }}
              placeholder="+ add tag…"
              spellCheck={false}
              className="w-24 rounded border border-[#2c3543] bg-[#171b22] px-2 py-0.5 font-mono text-[10px] text-[#e6eaf0] outline-none placeholder:text-[#556172] focus:border-blue-400"
            />
          </div>

          {/* Player Viewport */}
          <div className="relative aspect-video w-full bg-[#0a0c10]">
            {hasVideo ? (
              <video
                ref={videoRef}
                src={src}
                className="h-full w-full object-contain"
                onLoadedMetadata={handleLoadedMetadata}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onClick={togglePlay}
                muted={muted}
                playsInline
                autoPlay
                loop={false}
              />
            ) : (
              <div className="grid h-full w-full place-items-center text-center">
                <div>
                  <div className="font-mono text-[13px] text-[#8692a3]">NO PREVIEW STREAM</div>
                  <div className="mt-1 font-mono text-[11px] text-[#556172]">{clip.path}</div>
                </div>
              </div>
            )}

            {/* Overlay Specs */}
            <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between p-3 font-mono text-[10px] text-[#c3cddb]">
              <span className="rounded bg-black/75 px-2 py-1 border border-white/10">
                {clip.width}×{clip.height} · {clip.fps} FPS · {clip.has_audio ? "AAC 48 kHz" : "NO AUDIO"}
              </span>
              <span className="rounded bg-black/75 px-2 py-1 border border-white/10">{formatBytes(clip.size_bytes)}</span>
            </div>

            <button
              type="button"
              onClick={togglePlay}
              className={cn(
                "absolute inset-0 grid place-items-center transition-opacity duration-150",
                playing ? "opacity-0 hover:opacity-100" : "opacity-100",
              )}
            >
              <span className="grid h-12 w-12 place-items-center rounded-full border border-white/20 bg-black/60 text-lg text-white backdrop-blur-sm">
                {playing ? "❚❚" : "▶"}
              </span>
            </button>
          </div>

          {/* Timeline and scrubber */}
          <div className="space-y-2.5 px-5 pt-3.5 pb-2">
            <div className="flex items-center justify-between font-mono text-[10px] tracking-wider text-[#8692a3]">
              <span>
                IN <span className="text-blue-300 font-semibold">{formatTimecode(start)}</span>
              </span>
              <span>
                SELECTION{" "}
                <span className="text-[#e6eaf0] font-semibold">{formatTimecode(selectionSeconds)}</span> ·{" "}
                <span className="text-[#8692a3]">~{formatBytes(estimatedBytes)}</span>
              </span>
              <span>
                OUT <span className="text-blue-300 font-semibold">{formatTimecode(end)}</span>
              </span>
            </div>

            {/* Clean timeline track */}
            <div
              ref={trackRef}
              className="relative h-12 cursor-pointer select-none rounded-lg border border-[#2b3342] bg-[#11141a]"
              onPointerDown={(e) => {
                const t = positionFromEvent(e.clientX);
                setDragging("playhead");
                seek(clamp(t, start, end));
              }}
            >
              {/* Ruler ticks background */}
              <div className="pointer-events-none absolute inset-0 flex justify-between px-2 pt-1">
                {ticks.map((t, i) => (
                  <div key={i} className="flex flex-col items-center">
                    <span className="h-2 w-px bg-[#262e3b]" />
                    <span className="mt-1 font-mono text-[8px] text-[#4f5a6b]">{t.toFixed(0)}s</span>
                  </div>
                ))}
              </div>

              {/* Dimmed outside selection regions */}
              <div
                className="pointer-events-none absolute inset-y-0 left-0 rounded-l-lg bg-black/70"
                style={{ width: pct(start) }}
              />
              <div
                className="pointer-events-none absolute inset-y-0 right-0 rounded-r-lg bg-black/70"
                style={{ width: `${clamp(((duration - end) / duration) * 100, 0, 100)}%` }}
              />

              {/* Selection band */}
              <div
                className="pointer-events-none absolute inset-y-0 border-y-2 border-blue-400 bg-blue-500/15"
                style={{ left: pct(start), width: pct(end - start) }}
              />

              {/* Playhead */}
              <div
                className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow-sm"
                style={{ left: pct(playhead) }}
              />

              {/* In Handle */}
              <button
                type="button"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setDragging("start");
                }}
                className="absolute top-0 h-full cursor-ew-resize rounded-l border-y border-l border-blue-400 bg-blue-500/40 transition hover:bg-blue-400/60"
                style={{ left: `calc(${pct(start)} - ${HANDLE_W / 2}px)`, width: HANDLE_W }}
                aria-label="Trim start"
              >
                <span className="mx-auto block h-5 w-0.5 bg-white/90" />
              </button>

              {/* Out Handle */}
              <button
                type="button"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setDragging("end");
                }}
                className="absolute top-0 h-full cursor-ew-resize rounded-r border-y border-r border-blue-400 bg-blue-500/40 transition hover:bg-blue-400/60"
                style={{ left: `calc(${pct(end)} - ${HANDLE_W / 2}px)`, width: HANDLE_W }}
                aria-label="Trim end"
              >
                <span className="mx-auto block h-5 w-0.5 bg-white/90" />
              </button>
            </div>

            {/* Micro controls */}
            <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-[#717d8e]">
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setStart(clamp(playhead, 0, end - 0.2))}
                  className="rounded border border-[#2b3342] bg-[#14171e] px-2 py-1 text-[#b5c0d0] hover:border-blue-400 hover:text-white"
                >
                  SET IN [I]
                </button>
                <button
                  type="button"
                  onClick={() => setEnd(clamp(playhead, start + 0.2, duration))}
                  className="rounded border border-[#2b3342] bg-[#14171e] px-2 py-1 text-[#b5c0d0] hover:border-blue-400 hover:text-white"
                >
                  SET OUT [O]
                </button>
                {[5, 10, 15, 30].map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      const nextStart = clamp(duration - s, 0, Math.max(duration - 0.2, 0));
                      setStart(nextStart);
                      setEnd(duration);
                      seek(nextStart);
                    }}
                    className="rounded border border-[#2b3342] bg-[#14171e] px-2 py-1 text-[#8692a3] hover:border-[#3f4a5c] hover:text-[#e6eaf0]"
                  >
                    LAST {s}s
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setStart(0);
                    setEnd(duration);
                    seek(0);
                  }}
                  className="rounded border border-[#2b3342] bg-[#14171e] px-2 py-1 text-[#8692a3] hover:text-white"
                >
                  RESET
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setMuted((m) => !m)}
                  className="rounded border border-[#2b3342] bg-[#14171e] px-2 py-1 text-[#8692a3] hover:text-white"
                >
                  {muted ? "UNMUTE" : "MUTE"}
                </button>
                <span>SPACE: Play · ←/→: Step · ESC: Close</span>
              </div>
            </div>
          </div>

          {/* Action footer */}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-[#232934] bg-[#13161c] px-5 py-3">
            <div className="font-mono text-[11px] text-[#717d8e]">
              {status ? (
                <span className="text-blue-400 font-semibold">{status}</span>
              ) : (
                <span>Stream copy: keyframe snap, lossless, under 50 ms</span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => run("Discarding…", onDiscard)}
                disabled={busy}
                className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 font-mono text-[11px] font-medium text-red-300 hover:border-red-400 hover:bg-red-500/20 disabled:opacity-40"
              >
                DISCARD
              </button>

              <button
                type="button"
                onClick={() => run("Opening in player…", onOpenExternal)}
                disabled={busy}
                className="rounded-lg border border-[#2b3342] bg-[#171b22] px-3 py-1.5 font-mono text-[11px] text-[#c3cddb] hover:border-[#3d495b] hover:text-white disabled:opacity-40"
              >
                PLAY
              </button>

              <button
                type="button"
                onClick={() => run("Revealing file…", onReveal)}
                disabled={busy}
                title="Show in Windows Explorer"
                className="rounded-lg border border-[#2b3342] bg-[#171b22] px-3 py-1.5 font-mono text-[11px] text-[#c3cddb] hover:border-[#3d495b] hover:text-white disabled:opacity-40"
              >
                REVEAL
              </button>

              <button
                type="button"
                onClick={takeSnapshot}
                disabled={busy}
                className="rounded-lg border border-[#2b3342] bg-[#171b22] px-3 py-1.5 font-mono text-[11px] text-[#c3cddb] hover:border-[#3d495b] hover:text-white disabled:opacity-40"
              >
                SNAPSHOT
              </button>

              <div className="relative">
                <button
                  type="button"
                  onClick={() => setGifOpen((v) => !v)}
                  disabled={busy}
                  className={cn(
                    "rounded-lg border px-3 py-1.5 font-mono text-[11px] transition-colors disabled:opacity-40",
                    gifOpen
                      ? "border-blue-400 bg-blue-500/20 text-blue-200"
                      : "border-[#2b3342] bg-[#171b22] text-[#c3cddb] hover:border-[#3d495b] hover:text-white",
                  )}
                >
                  GIF
                </button>
                {gifOpen && (
                  <div className="animate-pop absolute bottom-full right-0 z-20 mb-2 w-60 rounded-xl border border-[#313a49] bg-[#171b22] p-3 shadow-xl">
                    <div className="font-mono text-[10px] font-semibold tracking-wider text-[#8692a3]">
                      EXPORT GIF
                    </div>
                    <div className="mt-2">
                      <div className="font-mono text-[9px] text-[#6d798a]">WIDTH</div>
                      <div className="mt-1 flex gap-1">
                        {[320, 480, 720].map((w) => (
                          <button
                            key={w}
                            type="button"
                            onClick={() => setGifWidth(w)}
                            className={cn(
                              "flex-1 rounded border px-1 py-1 font-mono text-[10px]",
                              gifWidth === w
                                ? "border-blue-400 bg-blue-500/20 text-blue-200"
                                : "border-[#2b3342] bg-[#14171e] text-[#8692a3] hover:text-white",
                            )}
                          >
                            {w}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="mt-2">
                      <div className="font-mono text-[9px] text-[#6d798a]">FPS</div>
                      <div className="mt-1 flex gap-1">
                        {[10, 15, 20].map((f) => (
                          <button
                            key={f}
                            type="button"
                            onClick={() => setGifFps(f)}
                            className={cn(
                              "flex-1 rounded border px-1 py-1 font-mono text-[10px]",
                              gifFps === f
                                ? "border-blue-400 bg-blue-500/20 text-blue-200"
                                : "border-[#2b3342] bg-[#14171e] text-[#8692a3] hover:text-white",
                            )}
                          >
                            {f}
                          </button>
                        ))}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setGifOpen(false);
                        void run(
                          "Exporting GIF…",
                          () => onExportGif(start, end, gifWidth, gifFps),
                        );
                      }}
                      disabled={selectionSeconds < 0.2}
                      className="mt-3 w-full rounded border border-blue-500 bg-blue-600 px-3 py-1.5 font-mono text-[11px] font-semibold text-white hover:bg-blue-500 disabled:opacity-40"
                    >
                      EXPORT {selectionSeconds.toFixed(1)}s → GIF
                    </button>
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => run("Copying to clipboard…", onCopy)}
                disabled={busy}
                className="rounded-lg border border-[#2b3342] bg-[#171b22] px-3.5 py-1.5 font-mono text-[11px] text-[#c3cddb] hover:border-blue-400 hover:text-white disabled:opacity-40"
              >
                COPY VIDEO
              </button>

              <button
                type="button"
                onClick={() => run("Splitting at playhead…", () => onSplit(playhead))}
                disabled={busy || playhead < 0.2 || playhead > duration - 0.2}
                title="Cut the clip in two at the playhead without re-encoding"
                className="rounded-lg border border-[#2b3342] bg-[#171b22] px-3 py-1.5 font-mono text-[11px] text-[#c3cddb] hover:border-amber-400 hover:text-amber-200 disabled:opacity-40"
              >
                SPLIT
              </button>

              <button
                type="button"
                onClick={() => run("Trimming…", () => onSaveTrimmed(start, end))}
                disabled={busy || selectionSeconds < 0.2}
                className="rounded-lg border border-blue-500 bg-blue-600 px-4 py-1.5 font-mono text-[11px] font-semibold text-white shadow-sm hover:bg-blue-500 hover:border-blue-400 disabled:opacity-40"
              >
                SAVE TRIMMED
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
