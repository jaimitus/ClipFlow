import { useEffect, useState } from "react";
import { clipflow } from "../lib/bridge";
import type { EngineStats } from "../lib/types";
import { formatDuration } from "../lib/format";
import { cn } from "../utils/cn";

/**
 * The always-on-top recording indicator. Runs inside the dedicated transparent
 * "hud" window (index.html?hud=1); the main deck shows/hides that window and
 * keeps it click-through, so this component only has to render the pill.
 */
export default function HudOverlay() {
  const [stats, setStats] = useState<EngineStats | null>(null);

  useEffect(() => {
    let off: (() => void) | undefined;
    void clipflow.onStats((s) => setStats(s)).then((u) => (off = u));
    return () => off?.();
  }, []);

  const armed = !!stats && (stats.state === "buffering" || stats.state === "flushing");
  const buffered = stats?.buffered_seconds ?? 0;

  return (
    <div className="flex h-screen w-screen items-center justify-center overflow-hidden bg-transparent font-mono">
      <div
        className={cn(
          "flex h-[40px] items-center gap-2 rounded-full border px-4",
          armed
            ? "border-rose-400/70 bg-[#0a0a12]/85 shadow-[0_0_18px_-2px_rgba(255,70,90,0.55)]"
            : "border-white/15 bg-[#0a0a12]/70",
        )}
      >
        <span
          className={cn(
            "h-2.5 w-2.5 rounded-full",
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
        {armed && (
          <span className="text-[11px] tracking-[0.12em] text-slate-300">
            {formatDuration(buffered)}s
          </span>
        )}
      </div>
    </div>
  );
}
