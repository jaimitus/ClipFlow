import { useEffect, useState } from "react";
import { clipflow } from "../lib/bridge";
import type { EngineStats } from "../lib/types";
import { cn } from "../utils/cn";

/**
 * The always-on-top recording indicator. Runs inside the dedicated transparent
 * "hud" window (index.html?hud=1). The main deck shows/hides the window; this
 * component renders the pill and makes the whole surface draggable — the
 * window has no chrome, so a drag anywhere moves it, and the Rust side
 * persists the position across launches (settings.hudPosition).
 */
export default function HudOverlay() {
  const [stats, setStats] = useState<EngineStats | null>(null);

  useEffect(() => {
    let off: (() => void) | undefined;
    void clipflow.onStats((s) => setStats(s)).then((u) => (off = u));
    return () => off?.();
  }, []);

  const armed = !!stats && (stats.state === "buffering" || stats.state === "flushing");
  const buffered = Math.floor(stats?.buffered_seconds ?? 0);
  const total = stats?.buffer_seconds ?? 60;
  const fps = stats?.capture_fps ?? stats?.target_fps ?? 0;
  const res =
    stats && stats.width > 0 ? `${stats.height}p${fps > 0 ? fps : ""}` : null;

  return (
    <div
      // Drag anywhere on the HUD to move it (left button only).
      onMouseDown={(e) => {
        if (e.button === 0) void clipflow.startDragging();
      }}
      className="flex h-screen w-screen select-none items-center justify-center overflow-hidden bg-transparent font-mono"
      style={{ cursor: "grab" }}
    >
      <div
        className={cn(
          "flex h-[48px] items-center gap-2.5 rounded-2xl border px-4 shadow-xl",
          armed
            ? "border-rose-400/60 bg-[#0a0a12]/90 shadow-[0_0_22px_-2px_rgba(255,70,90,0.6)]"
            : "border-white/15 bg-[#0a0a12]/75",
        )}
      >
        <span
          className={cn(
            "h-2.5 w-2.5 shrink-0 rounded-full",
            armed
              ? "animate-rec bg-rose-400 shadow-[0_0_10px_#ff4d5e]"
              : "bg-slate-600",
          )}
        />
        <span
          className={cn(
            "text-[13px] font-semibold tracking-[0.18em]",
            armed ? "text-rose-100" : "text-slate-400",
          )}
        >
          {armed ? "REC" : "STANDBY"}
        </span>

        <span className="text-[12px] tracking-[0.1em] text-slate-300">
          {armed ? `${buffered}s/${total}s` : `${total}s buffer`}
        </span>

        {armed && res && (
          <>
            <span className="text-[10px] text-slate-600">·</span>
            <span className="text-[11px] tracking-[0.08em] text-slate-400">
              {res}
            </span>
          </>
        )}

        {stats?.privacy_active && (
          <span className="rounded-md border border-amber-300/50 bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.14em] text-amber-200">
            🔒 PRIV
          </span>
        )}
      </div>
    </div>
  );
}
