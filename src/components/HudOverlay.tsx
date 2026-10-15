import { useEffect, useRef, useState } from "react";
import { clipflow } from "../lib/bridge";
import type { EngineStats } from "../lib/types";
import { cn } from "../utils/cn";

type SaveState = "idle" | "saving" | "ok" | "err";

/**
 * The always-on-top overlay. Runs inside the dedicated transparent "hud" window
 * (index.html?hud=1) and doubles as a control panel: save a clip, arm/disarm
 * the buffer. Draggable anywhere except the buttons.
 */
export default function HudOverlay() {
  const [stats, setStats] = useState<EngineStats | null>(null);
  const [save, setSave] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [hotkeys, setHotkeys] = useState<{ save: string; toggle: string } | null>(null);
  const resetTimer = useRef<number | undefined>(undefined);
  const errTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let off: (() => void) | undefined;
    void clipflow.onStats((s) => setStats(s)).then((u) => (off = u));
    void clipflow
      .getSettings()
      .then((s) => setHotkeys({ save: s.hotkeySave, toggle: s.hotkeyToggle }))
      .catch(() => undefined);
    return () => {
      off?.();
      window.clearTimeout(resetTimer.current);
      window.clearTimeout(errTimer.current);
    };
  }, []);

  const armed = !!stats && (stats.state === "buffering" || stats.state === "flushing");
  const buffered = Math.floor(stats?.buffered_seconds ?? 0);
  const total = stats?.buffer_seconds ?? 60;
  const fps = stats?.capture_fps ?? stats?.target_fps ?? 0;
  const res = stats && stats.width > 0 ? `${stats.height}p${fps > 0 ? fps : ""}` : null;
  const mbps =
    stats && stats.bitrate_kbps > 0 ? `${Math.round(stats.bitrate_kbps / 1000)}Mb/s` : null;

  const canSave = armed && !stats?.privacy_active;

  const handleSave = async () => {
    if (!canSave || save === "saving" || toggling) return;
    setSave("saving");
    setSaveError(null);
    try {
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

  const handleToggle = async () => {
    if (toggling) return;
    setToggling(true);
    setToggleError(null);
    try {
      if (armed) {
        await clipflow.stopBuffer();
      } else {
        const s = await clipflow.getSettings();
        await clipflow.startBuffer(s.bufferSeconds, s.targetFps);
      }
    } catch (e) {
      setToggleError(String(e));
    } finally {
      setToggling(false);
      window.clearTimeout(errTimer.current);
      errTimer.current = window.setTimeout(() => setToggleError(null), 3000);
    }
  };

  return (
    <div
      onMouseDown={(e) => {
        if (e.button === 0) void clipflow.startDragging();
      }}
      className="flex h-screen w-screen select-none items-center justify-center overflow-hidden bg-transparent font-mono"
      style={{ cursor: "grab" }}
    >
      <div
        className={cn(
          "flex h-[44px] items-center gap-2.5 rounded-full border px-4 shadow-xl backdrop-blur-md transition-all duration-150",
          armed
            ? "border-[#3b4759] bg-[#141820]/95 shadow-black/80"
            : "border-[#2b3342] bg-[#11141a]/90",
        )}
      >
        <span
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            armed ? "bg-red-500 animate-rec" : "bg-[#556172]",
          )}
        />
        <span
          className={cn(
            "text-[12px] font-semibold tracking-wider",
            armed ? "text-[#f0f4f9]" : "text-[#7e8b9d]",
          )}
        >
          {armed ? "REC" : "STANDBY"}
        </span>

        <span className="text-[12px] text-[#8692a3]">
          {armed ? `${buffered}s / ${total}s` : `${total}s buffer`}
        </span>

        {armed && res && (
          <>
            <span className="text-[10px] text-[#4f5a6b]">·</span>
            <span className="text-[11px] text-[#8692a3]">{res}</span>
          </>
        )}
        {armed && mbps && (
          <>
            <span className="text-[10px] text-[#4f5a6b]">·</span>
            <span className="text-[11px] text-[#8692a3]">{mbps}</span>
          </>
        )}

        {stats?.privacy_active && (
          <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-300">
            PRIVACY
          </span>
        )}

        <div className="h-4 w-px bg-[#2b3342]" />

        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => void handleToggle()}
          aria-disabled={toggling}
          title={
            toggleError ??
            (armed
              ? "Disarm the buffer"
              : `Arm the rolling buffer (${hotkeys?.toggle ?? "Alt+Shift+C"})`)
          }
          className={cn(
            "rounded border px-2.5 py-1 text-[10px] font-semibold tracking-wider transition-colors",
            toggleError
              ? "border-red-500/40 bg-red-500/20 text-red-200"
              : armed
                ? "border-[#384354] bg-[#1d232e] text-[#c3cddb] hover:border-red-400 hover:text-red-300"
                : "border-[#384354] bg-[#1d232e] text-[#c3cddb] hover:border-blue-400 hover:text-white",
            toggling && "cursor-wait opacity-60",
          )}
        >
          {toggling ? "…" : armed ? "STOP" : "ARM"}
        </button>

        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => void handleSave()}
          aria-disabled={!canSave}
          title={
            !armed
              ? "Arm the buffer first"
              : stats?.privacy_active
                ? "Privacy mode: no game is focused"
                : saveError ?? `Save the last replay (${hotkeys?.save ?? "Alt+C"})`
          }
          className={cn(
            "rounded border px-2.5 py-1 text-[10px] font-semibold tracking-wider transition-colors",
            save === "ok"
              ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-200"
              : save === "err"
                ? "border-red-500/60 bg-red-500/20 text-red-200"
                : !canSave || save === "saving" || toggling
                  ? "cursor-not-allowed border-[#28313e] bg-[#14171e] text-[#556172]"
                  : "border-blue-500 bg-blue-600 text-white hover:bg-blue-500",
          )}
        >
          {save === "saving" ? "SAVING…" : save === "ok" ? "SAVED" : save === "err" ? "FAILED" : "SAVE"}
        </button>
      </div>
    </div>
  );
}
