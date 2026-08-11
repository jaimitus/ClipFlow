import { useEffect, useRef, useState } from "react";
import { clipflow } from "../lib/bridge";
import type { EngineStats } from "../lib/types";
import { cn } from "../utils/cn";

type SaveState = "idle" | "saving" | "ok" | "err";

/**
 * The always-on-top recording indicator. Runs inside the dedicated transparent
 * "hud" window (index.html?hud=1). The main deck shows/hides the window; this
 * component renders the pill, lets you save a clip straight from the overlay
 * (no alt-tab — same behaviour as the hotkey: never raises or focuses the
 * deck), shows the live state and is draggable anywhere except the button.
 */
export default function HudOverlay() {
  const [stats, setStats] = useState<EngineStats | null>(null);
  const [save, setSave] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let off: (() => void) | undefined;
    void clipflow.onStats((s) => setStats(s)).then((u) => (off = u));
    return () => {
      off?.();
      window.clearTimeout(resetTimer.current);
    };
  }, []);

  const armed = !!stats && (stats.state === "buffering" || stats.state === "flushing");
  const buffered = Math.floor(stats?.buffered_seconds ?? 0);
  const total = stats?.buffer_seconds ?? 60;
  const fps = stats?.capture_fps ?? stats?.target_fps ?? 0;
  const res = stats && stats.width > 0 ? `${stats.height}p${fps > 0 ? fps : ""}` : null;
  const mbps =
    stats && stats.bitrate_kbps > 0 ? `${Math.round(stats.bitrate_kbps / 1000)}Mb/s` : null;

  // The button is only useful (and safe) while a buffer is armed AND a game is
  // actually being captured — with privacy active the ring is empty.
  const canSave = armed && !stats?.privacy_active;

  const handleSave = async () => {
    // Not armed / privacy: the click stays silent — the hover title on the
    // button explains why (a real `disabled` attribute would hide that title
    // in WebView2, so the button is styled dimmed but still hoverable).
    if (!canSave || save === "saving") return;
    setSave("saving");
    setSaveError(null);
    try {
      // triggered_by "hud" behaves like the hotkey: the deck is never raised,
      // no trimmer opens, and the main window still toasts the saved clip.
      await clipflow.saveInstantReplay(undefined, "hud");
      setSave("ok");
    } catch (e) {
      setSaveError(String(e));
      setSave("err");
    } finally {
      window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setSave("idle"), 1800);
    }
  };

  return (
    <div
      // Drag anywhere on the HUD to move it (left button only). The save
      // button stops propagation so a click never turns into a drag.
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
            <span className="text-[11px] tracking-[0.08em] text-slate-400">{res}</span>
          </>
        )}
        {armed && mbps && (
          <>
            <span className="text-[10px] text-slate-600">·</span>
            <span className="text-[11px] tracking-[0.08em] text-slate-400">{mbps}</span>
          </>
        )}

        {stats?.privacy_active && (
          <span className="rounded-md border border-amber-300/50 bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.14em] text-amber-200">
            🔒 PRIV
          </span>
        )}

        <div className="h-5 w-px bg-white/15" />

        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => void handleSave()}
          aria-disabled={!canSave}
          title={
            !armed
              ? "Arm the buffer first"
              : stats?.privacy_active
                ? "Privacy mode: no game is focused, the ring is empty"
                : saveError ?? "Save the last moments (Alt+C)"
          }
          className={cn(
            "rounded-lg border px-2.5 py-1 text-[10px] font-semibold tracking-[0.14em] transition",
            save === "ok"
              ? "border-lime-300/70 bg-lime-400/20 text-lime-100"
              : save === "err"
                ? "border-rose-400/70 bg-rose-500/20 text-rose-100"
                : !canSave || save === "saving"
                  ? "cursor-not-allowed border-cyan-300/20 bg-cyan-400/[0.06] text-cyan-100/50"
                  : "border-cyan-300/40 bg-cyan-400/10 text-cyan-100 hover:bg-cyan-400/20 active:scale-[0.97]",
          )}
        >
          {save === "saving" ? "SAVING…" : save === "ok" ? "✓ SAVED" : save === "err" ? "✕ FAILED" : "⎙ SAVE"}
        </button>
      </div>
    </div>
  );
}
