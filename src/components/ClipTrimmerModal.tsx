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
  onDiscard: () => Promise<void> | void;
  onClose: () => void;
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
  onDiscard,
  onClose,
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

  const src = clip.preview_url ?? assetUrl(clip.path);
  const hasVideo = src.length > 0;

  // ------------------------------------------------------------- metadata
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
  }, [nameDraft, clip.file_name, onRename]);

  const handleLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    // Non-finalised WebM (browser simulation) reports Infinity; fall back to
    // the duration the engine reported.
    const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : clip.duration_seconds;
    const safe = Math.max(d, 0.1);
    setDuration(safe);
    setEnd((prev) => (prev <= 0.11 || prev > safe ? safe : prev));
  }, [clip.duration_seconds]);

  // ------------------------------------------------------- playback loop
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let raf = 0;
    const tick = () => {
      if (!videoRef.current) return;
      const t = videoRef.current.currentTime;
      setPlayhead(t);
      if (t >= end - 0.02) {
        videoRef.current.currentTime = start;
        if (!videoRef.current.paused) void videoRef.current.play().catch(() => undefined);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [start, end]);

  const seek = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    try {
      v.currentTime = t;
    } catch {
      /* seeking a streaming blob can throw before it is seekable */
    }
    setPlayhead(t);
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime < start || v.currentTime > end) v.currentTime = start;
      void v.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      v.pause();
      setPlaying(false);
    }
  }, [start, end]);

  // ------------------------------------------------------- thumb dragging
  const positionFromEvent = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return 0;
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      return ratio * duration;
    },
    [duration],
  );

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const t = positionFromEvent(e.clientX);
      if (dragging === "start") {
        const next = clamp(t, 0, end - 0.2);
        setStart(next);
        seek(next);
      } else if (dragging === "end") {
        const next = clamp(t, start + 0.2, duration);
        setEnd(next);
        seek(Math.max(start, next - 0.15));
      } else {
        seek(clamp(t, start, end));
      }
    };
    const up = () => setDragging(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [dragging, positionFromEvent, start, end, duration, seek]);

  // ------------------------------------------------------------- shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never hijack keys while the rename input (or any other field) is focused.
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

  /** Grabs the current frame (hardware decode on native; canvas in browser). */
  const takeSnapshot = () => {
    const v = videoRef.current;
    if (!v) return;
    void run("Capturing frame…", () =>
      clipflow
        .extractFramePng(clip.path, playhead, 0)
        .then((png) => onSnapshot(png)),
    );
  };

  // Ticks every ~1/10 of the timeline.
  const ticks = useMemo(() => {
    const count = 10;
    return Array.from({ length: count + 1 }, (_, i) => (duration * i) / count);
  }, [duration]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="animate-fade absolute inset-0 bg-[#04050c]/85 backdrop-blur-md"
        onClick={onClose}
      />

      <div className="animate-pop panel scanlines relative z-10 flex w-full max-w-4xl flex-col overflow-hidden rounded-2xl ring-glow">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/5 px-5 py-3">
          <div className="flex items-center gap-3">
            <span className="h-2.5 w-2.5 rounded-full bg-fuchsia-400 shadow-[0_0_14px_#ff4fd8]" />
            <div>
              <div className="font-mono text-[11px] font-semibold tracking-[0.24em] text-fuchsia-200">
                QUICK TRIM
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
                  className="mt-0.5 w-full max-w-[42ch] rounded border border-cyan-300/50 bg-black/50 px-1.5 py-0.5 font-mono text-[11px] text-cyan-100 outline-none"
                  spellCheck={false}
                />
              ) : (
                <button
                  onClick={() => {
                    setNameDraft(clip.file_name);
                    setRenaming(true);
                  }}
                  title="Rename clip"
                  className="group mt-0.5 max-w-[46ch] truncate font-mono text-[11px] text-slate-500 transition hover:text-cyan-200"
                >
                  {clip.file_name}
                  <span className="ml-2 text-[9px] tracking-[0.14em] text-slate-700 transition group-hover:text-cyan-300">
                    RENAME ↵
                  </span>
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {typeof flushMs === "number" && (
              <span className="rounded-full border border-lime-400/30 bg-lime-400/10 px-2.5 py-1 font-mono text-[10px] tracking-[0.14em] text-lime-200">
                FLUSHED IN {flushMs.toFixed(1)} MS
              </span>
            )}
            <button
              onClick={onClose}
              className="no-drag grid h-7 w-7 place-items-center rounded-md border border-white/10 text-slate-400 transition hover:border-rose-400/40 hover:text-rose-300"
              aria-label="Close trimmer"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Player */}
        <div className="relative aspect-video w-full bg-black">
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
                <div className="font-mono text-sm text-slate-400">NO PREVIEW STREAM</div>
                <div className="mt-1 font-mono text-[11px] text-slate-600">{clip.path}</div>
              </div>
            </div>
          )}

          {/* Overlay HUD */}
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between p-3 font-mono text-[10px] tracking-[0.14em] text-slate-300">
            <span className="rounded bg-black/55 px-2 py-1">
              {clip.width}×{clip.height} · {clip.fps} FPS · {clip.has_audio ? "AAC 48 kHz" : "NO AUDIO"}
            </span>
            <span className="rounded bg-black/55 px-2 py-1">{formatBytes(clip.size_bytes)}</span>
          </div>

          <button
            onClick={togglePlay}
            className={cn(
              "absolute inset-0 grid place-items-center transition",
              playing ? "opacity-0 hover:opacity-100" : "opacity-100",
            )}
          >
            <span className="grid h-14 w-14 place-items-center rounded-full border border-cyan-300/50 bg-black/55 text-xl text-cyan-200 backdrop-blur">
              {playing ? "❚❚" : "▶"}
            </span>
          </button>
        </div>

        {/* Timeline */}
        <div className="space-y-3 px-5 pt-4">
          <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">
            <span>
              in <span className="text-cyan-300">{formatTimecode(start)}</span>
            </span>
            <span className="text-slate-400">
              selection{" "}
              <span className="text-lime-300">{formatTimecode(selectionSeconds)}</span> ·{" "}
              <span className="text-slate-300">~{formatBytes(estimatedBytes)}</span>
            </span>
            <span>
              out <span className="text-fuchsia-300">{formatTimecode(end)}</span>
            </span>
          </div>

          <div
            ref={trackRef}
            className="relative h-16 cursor-pointer select-none rounded-xl border border-white/8 bg-black/45"
            onPointerDown={(e) => {
              const t = positionFromEvent(e.clientX);
              setDragging("playhead");
              seek(clamp(t, start, end));
            }}
          >
            {/* Waveform-ish density bars derived deterministically from the id */}
            <div className="pointer-events-none absolute inset-0 flex items-end gap-[2px] overflow-hidden rounded-xl px-1 pb-1 opacity-45">
              {Array.from({ length: 120 }).map((_, i) => {
                const seed = (i * 9301 + clip.id.length * 49297) % 233280;
                const h = 12 + ((seed / 233280) * 78);
                return (
                  <span
                    key={i}
                    className="flex-1 rounded-sm bg-gradient-to-t from-cyan-500/40 to-fuchsia-400/40"
                    style={{ height: `${h}%` }}
                  />
                );
              })}
            </div>

            {/* Dimmed outside-selection regions */}
            <div
              className="pointer-events-none absolute inset-y-0 left-0 rounded-l-xl bg-[#05060d]/78"
              style={{ width: pct(start) }}
            />
            <div
              className="pointer-events-none absolute inset-y-0 right-0 rounded-r-xl bg-[#05060d]/78"
              style={{ width: `${clamp(((duration - end) / duration) * 100, 0, 100)}%` }}
            />

            {/* Selection band */}
            <div
              className="pointer-events-none absolute inset-y-0 border-y-2 border-cyan-300/70 bg-cyan-400/10"
              style={{ left: pct(start), width: pct(end - start) }}
            />

            {/* Ticks */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-between px-1 font-mono text-[8px] text-slate-600">
              {ticks.map((t, i) => (
                <span key={i}>{t.toFixed(0)}s</span>
              ))}
            </div>

            {/* Playhead */}
            <div
              className="pointer-events-none absolute inset-y-0 w-px bg-white shadow-[0_0_10px_#fff]"
              style={{ left: pct(playhead) }}
            />

            {/* Thumbs */}
            <button
              onPointerDown={(e) => {
                e.stopPropagation();
                setDragging("start");
              }}
              className="absolute top-0 h-full cursor-ew-resize rounded-l-md border border-cyan-300/80 bg-cyan-400/25 backdrop-blur-sm transition hover:bg-cyan-400/45"
              style={{ left: `calc(${pct(start)} - ${HANDLE_W / 2}px)`, width: HANDLE_W }}
              aria-label="Trim start"
            >
              <span className="mx-auto block h-6 w-px bg-cyan-100" />
            </button>
            <button
              onPointerDown={(e) => {
                e.stopPropagation();
                setDragging("end");
              }}
              className="absolute top-0 h-full cursor-ew-resize rounded-r-md border border-fuchsia-300/80 bg-fuchsia-400/25 backdrop-blur-sm transition hover:bg-fuchsia-400/45"
              style={{ left: `calc(${pct(end)} - ${HANDLE_W / 2}px)`, width: HANDLE_W }}
              aria-label="Trim end"
            >
              <span className="mx-auto block h-6 w-px bg-fuchsia-100" />
            </button>
          </div>

          {/* Micro controls */}
          <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] text-slate-500">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                onClick={() => setStart(clamp(playhead, 0, end - 0.2))}
                className="rounded border border-white/10 px-2 py-1 tracking-[0.12em] text-slate-300 transition hover:border-cyan-300/50 hover:text-cyan-200"
              >
                SET IN · I
              </button>
              <button
                onClick={() => setEnd(clamp(playhead, start + 0.2, duration))}
                className="rounded border border-white/10 px-2 py-1 tracking-[0.12em] text-slate-300 transition hover:border-fuchsia-300/50 hover:text-fuchsia-200"
              >
                SET OUT · O
              </button>
              {[5, 10, 15, 30].map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    const nextStart = clamp(duration - s, 0, Math.max(duration - 0.2, 0));
                    setStart(nextStart);
                    setEnd(duration);
                    seek(nextStart);
                  }}
                  className="rounded border border-white/10 px-2 py-1 tracking-[0.12em] transition hover:border-lime-300/50 hover:text-lime-200"
                >
                  LAST {s}s
                </button>
              ))}
              <button
                onClick={() => {
                  setStart(0);
                  setEnd(duration);
                  seek(0);
                }}
                className="rounded border border-white/10 px-2 py-1 tracking-[0.12em] transition hover:border-white/30 hover:text-slate-200"
              >
                RESET
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setMuted((m) => !m)}
                className="rounded border border-white/10 px-2 py-1 tracking-[0.12em] transition hover:border-white/30 hover:text-slate-200"
              >
                {muted ? "UNMUTE" : "MUTE"}
              </button>
              <span>SPACE play · ←/→ frame step · ESC close</span>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/5 bg-black/25 px-5 py-4">
          <div className="font-mono text-[10px] tracking-[0.14em] text-slate-500">
            {status ? (
              <span className="text-cyan-300">{status}</span>
            ) : (
              <>STREAM COPY · NO RE-ENCODE · KEY-FRAME SNAP</>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => run("Discarding…", onDiscard)}
              disabled={busy}
              className="no-drag rounded-lg border border-white/10 px-3.5 py-2 font-mono text-[11px] tracking-[0.14em] text-slate-300 transition hover:border-rose-400/50 hover:text-rose-200 disabled:opacity-50"
            >
              DISCARD
            </button>
            <button
              onClick={() => run("Revealing in Explorer…", onReveal)}
              disabled={busy}
              className="no-drag rounded-lg border border-white/10 px-3.5 py-2 font-mono text-[11px] tracking-[0.14em] text-slate-300 transition hover:border-cyan-300/50 hover:text-cyan-200 disabled:opacity-50"
            >
              OPEN FOLDER
            </button>
            <button
              onClick={() => run("Opening in player…", onOpenExternal)}
              disabled={busy}
              className="no-drag rounded-lg border border-white/10 px-3.5 py-2 font-mono text-[11px] tracking-[0.14em] text-slate-300 transition hover:border-white/30 hover:text-slate-100 disabled:opacity-50"
            >
              ▶ PLAY
            </button>
            <button
              onClick={takeSnapshot}
              disabled={busy}
              className="no-drag rounded-lg border border-white/10 px-3.5 py-2 font-mono text-[11px] tracking-[0.14em] text-slate-300 transition hover:border-amber-300/50 hover:text-amber-200 disabled:opacity-50"
            >
              ◉ SNAPSHOT PNG
            </button>
            <button
              onClick={() => run("Copying to clipboard…", onCopy)}
              disabled={busy}
              className="no-drag rounded-lg border border-fuchsia-300/50 bg-fuchsia-500/15 px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.14em] text-fuchsia-100 transition hover:bg-fuchsia-500/25 disabled:opacity-50"
            >
              COPY VIDEO
            </button>
            <button
              onClick={() => run("Splitting at playhead…", () => onSplit(playhead))}
              disabled={busy || playhead < 0.2 || playhead > duration - 0.2}
              title="Cut the clip in two at the playhead (stream copy, no re-encode)"
              className="no-drag rounded-lg border border-amber-300/50 bg-amber-400/10 px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.14em] text-amber-100 transition hover:bg-amber-400/20 disabled:opacity-50"
            >
              ✂ SPLIT AT PLAYHEAD
            </button>
            <button
              onClick={() => run("Trimming (stream copy)…", () => onSaveTrimmed(start, end))}
              disabled={busy || selectionSeconds < 0.2}
              className="no-drag rounded-lg border border-cyan-300/60 bg-cyan-400/20 px-4 py-2 font-mono text-[11px] font-semibold tracking-[0.14em] text-cyan-50 transition hover:bg-cyan-400/30 disabled:opacity-50"
            >
              SAVE TRIMMED
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
