import { clipflow } from "../lib/bridge";
import { cn } from "../utils/cn";

interface Props {
  armed: boolean;
  native: boolean;
  version: string;
}

export default function TitleBar({ armed, native, version }: Props) {
  return (
    <header
      className="drag-region flex h-11 shrink-0 items-center justify-between border-b border-white/5 bg-[#070a14]/85 px-3 backdrop-blur"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest(".no-drag")) return;
        void clipflow.startDragging();
      }}
    >
      <div className="flex items-center gap-3">
        <div className="grid h-6 w-6 place-items-center rounded-md bg-gradient-to-br from-cyan-400 to-fuchsia-500 shadow-[0_0_18px_-4px_#5eeaff]">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-black" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
        <span className="font-mono text-[12px] font-semibold tracking-[0.26em] text-slate-200">
          CLIPFLOW
        </span>
        <span className="font-mono text-[10px] tracking-[0.14em] text-slate-600">
          v{version}
        </span>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 font-mono text-[9px] tracking-[0.16em]",
            armed
              ? "border-lime-400/40 bg-lime-400/10 text-lime-300"
              : "border-white/10 bg-white/5 text-slate-500",
          )}
        >
          {armed ? "● BUFFER LIVE" : "○ IDLE"}
        </span>
        {!native && (
          <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 font-mono text-[9px] tracking-[0.16em] text-amber-200">
            WEB PREVIEW — SIMULATED ENGINE
          </span>
        )}
      </div>

      <div className="no-drag flex items-center gap-1">
        <button
          onClick={() => void clipflow.minimize()}
          className="grid h-7 w-9 place-items-center rounded text-slate-400 transition hover:bg-white/5 hover:text-slate-100"
          title="Minimize"
        >
          –
        </button>
        <button
          onClick={() => void clipflow.toggleMaximize()}
          className="grid h-7 w-9 place-items-center rounded text-slate-400 transition hover:bg-white/5 hover:text-slate-100"
          title="Maximize"
        >
          ▢
        </button>
        <button
          onClick={() => void clipflow.hideToTray()}
          className="grid h-7 w-9 place-items-center rounded text-slate-400 transition hover:bg-rose-500/20 hover:text-rose-200"
          title="Hide to tray (buffer keeps running)"
        >
          ✕
        </button>
      </div>
    </header>
  );
}
