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
      className="drag-region flex h-10 shrink-0 select-none items-center justify-between border-b border-[#232934] bg-[#111318] px-3.5"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest(".no-drag")) return;
        void clipflow.startDragging();
      }}
    >
      <div className="flex items-center gap-3">
        {/* App Mark */}
        <div className="flex h-5 w-5 items-center justify-center rounded bg-[#1e242f] text-blue-400 border border-[#2b3342]">
          <svg viewBox="0 0 16 16" className="h-3 w-3 fill-current" aria-hidden="true">
            <path d="M4 3.5v9l8-4.5-8-4.5z" />
          </svg>
        </div>

        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold tracking-wide text-[#e6eaf0]">
            ClipFlow
          </span>
          <span className="font-mono text-[10px] text-[#6d798a]">
            v{version}
          </span>
        </div>

        <span
          className={cn(
            "flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10px] font-medium tracking-wider",
            armed
              ? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
              : "border border-[#2a323f] bg-[#171b22] text-[#8692a3]",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              armed ? "bg-emerald-400 animate-rec" : "bg-[#556172]",
            )}
          />
          {armed ? "LIVE BUFFER" : "DISARMED"}
        </span>

        {!native && (
          <span className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] text-amber-300">
            SIMULATED PREVIEW
          </span>
        )}
      </div>

      <div className="no-drag flex items-center gap-0.5">
        <button
          onClick={() => void clipflow.minimize()}
          className="grid h-7 w-8 place-items-center rounded text-[#8d98a8] transition-colors hover:bg-[#1f2632] hover:text-[#e6eaf0]"
          title="Minimize"
          aria-label="Minimize"
        >
          <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25">
            <line x1="2" y1="6" x2="10" y2="6" />
          </svg>
        </button>
        <button
          onClick={() => void clipflow.toggleMaximize()}
          className="grid h-7 w-8 place-items-center rounded text-[#8d98a8] transition-colors hover:bg-[#1f2632] hover:text-[#e6eaf0]"
          title="Maximize"
          aria-label="Maximize"
        >
          <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25">
            <rect x="2.5" y="2.5" width="7" height="7" rx="0.5" />
          </svg>
        </button>
        <button
          onClick={() => void clipflow.hideToTray()}
          className="grid h-7 w-8 place-items-center rounded text-[#8d98a8] transition-colors hover:bg-[#1f2632] hover:text-[#e6eaf0]"
          title="Hide to tray (keeps recording in background)"
          aria-label="Hide to tray"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.25">
            <path d="M3 4l4 4 4-4" />
            <line x1="2" y1="11" x2="12" y2="11" />
          </svg>
        </button>
        <button
          onClick={() => void clipflow.quit()}
          className="grid h-7 w-8 place-items-center rounded text-[#8d98a8] transition-colors hover:bg-red-500/20 hover:text-red-300"
          title="Quit ClipFlow"
          aria-label="Quit"
        >
          <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25">
            <line x1="2.5" y1="2.5" x2="9.5" y2="9.5" />
            <line x1="9.5" y1="2.5" x2="2.5" y2="9.5" />
          </svg>
        </button>
      </div>
    </header>
  );
}
