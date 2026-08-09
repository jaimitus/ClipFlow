import type { ReactNode } from "react";
import { cn } from "../utils/cn";

/** One labelled settings row: label + hint on the left, control on the right. */
export function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-white/5 py-3 last:border-0">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-slate-200">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "relative h-6 w-11 rounded-full border transition",
        on ? "border-cyan-300/60 bg-cyan-400/25" : "border-white/10 bg-white/5",
      )}
    >
      <span
        className={cn(
          "absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full transition-all",
          on ? "left-6 bg-cyan-200 shadow-[0_0_10px_#5eeaff]" : "left-1 bg-slate-500",
        )}
      />
    </button>
  );
}
