import { useEffect, useMemo, useRef } from "react";
import type { EngineStats } from "../lib/types";
import { VENDOR_ACCENT, VENDOR_LABEL } from "../lib/types";
import { formatBytes, formatDuration } from "../lib/format";
import { cn } from "../utils/cn";

interface Props {
  stats: EngineStats;
  hotkey: string;
  busy?: boolean;
  onToggle: () => void;
  onSave: () => void;
}

const STATE_META: Record<
  EngineStats["state"],
  { label: string; tone: string; dot: string }
> = {
  idle: { label: "BUFFER DISARMED", tone: "text-slate-400", dot: "bg-slate-500" },
  starting: { label: "SPINNING UP", tone: "text-cyan-300", dot: "bg-cyan-400" },
  buffering: { label: "RECORDING BUFFER", tone: "text-lime-300", dot: "bg-lime-400" },
  flushing: { label: "FLUSHING TO DISK", tone: "text-amber-300", dot: "bg-amber-400" },
  recovering: { label: "GPU DEVICE RESET", tone: "text-amber-300", dot: "bg-amber-400" },
  error: { label: "ENGINE FAULT", tone: "text-rose-300", dot: "bg-rose-500" },
};

/** Rolling sparkline of per-frame encode cost. */
function EncodeSparkline({ value, accent }: { value: number; accent: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const history = useRef<number[]>([]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    history.current.push(value);
    if (history.current.length > 72) history.current.shift();

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const data = history.current;
    const max = Math.max(2.5, ...data) * 1.15;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / Math.max(data.length - 1, 1)) * w;
      const y = h - (v / max) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 8;
    ctx.stroke();

    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.shadowBlur = 0;
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, `${accent}44`);
    grad.addColorStop(1, `${accent}00`);
    ctx.fillStyle = grad;
    ctx.fill();
  }, [value, accent]);

  return <canvas ref={ref} className="h-10 w-full" />;
}

function Metric({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-xl border border-white/5 bg-black/25 px-3 py-2.5">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">
        {label}
      </div>
      <div
        className="mt-1 font-mono text-lg leading-none font-semibold"
        style={{ color: accent ?? "#e6ecff" }}
      >
        {value}
      </div>
      {sub && <div className="mt-1 font-mono text-[10px] text-slate-500">{sub}</div>}
    </div>
  );
}

export default function BufferStatusCard({ stats, hotkey, busy, onToggle, onSave }: Props) {
  const meta = STATE_META[stats.state];
  const accent = VENDOR_ACCENT[stats.encoder.vendor] ?? "#5eeaff";
  const armed = stats.state === "buffering" || stats.state === "flushing";

  const fill = useMemo(
    () => Math.min(1, stats.buffered_seconds / Math.max(stats.buffer_seconds, 1)),
    [stats.buffered_seconds, stats.buffer_seconds],
  );

  const radius = 62;
  const circumference = 2 * Math.PI * radius;

  return (
    <section className="panel noise relative overflow-hidden rounded-2xl p-5">
      {armed && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px overflow-hidden">
          <div className="animate-sweep h-px w-1/3 bg-gradient-to-r from-transparent via-cyan-300 to-transparent" />
        </div>
      )}

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "h-2.5 w-2.5 rounded-full",
              meta.dot,
              armed && "animate-rec",
            )}
          />
          <div>
            <div
              className={cn(
                "font-mono text-sm font-semibold tracking-[0.22em]",
                meta.tone,
              )}
            >
              {meta.label}
            </div>
            {stats.privacy_active ? (
              <div className="mt-0.5 font-mono text-[11px] text-amber-300/90">
                🔒 PRIVACY PAUSED — no game focused · buffer empty
              </div>
            ) : (
              <div className="mt-0.5 font-mono text-[11px] text-slate-500">
                {stats.width || 0}×{stats.height || 0} · {stats.target_fps} fps target ·{" "}
                {stats.capture_fps.toFixed(0)} fps actual
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onToggle}
            disabled={busy}
            className={cn(
              "no-drag rounded-lg border px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.14em] transition",
              armed
                ? "border-rose-400/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20"
                : "border-lime-400/40 bg-lime-400/10 text-lime-200 hover:bg-lime-400/20",
              busy && "cursor-wait opacity-60",
            )}
          >
            {armed ? "DISARM" : "ARM BUFFER"}
          </button>
          <button
            onClick={onSave}
            disabled={!armed || busy}
            className={cn(
              "no-drag rounded-lg border border-cyan-300/50 bg-cyan-400/15 px-3.5 py-2 font-mono text-[11px] font-semibold tracking-[0.14em] text-cyan-100 transition hover:bg-cyan-400/25",
              (!armed || busy) && "cursor-not-allowed opacity-40",
            )}
          >
            SAVE CLIP · {hotkey.toUpperCase()}
          </button>
        </div>
      </header>

      <div className="mt-5 grid gap-5 lg:grid-cols-[168px_1fr]">
        {/* Rolling buffer dial */}
        <div className="relative mx-auto grid h-[168px] w-[168px] place-items-center">
          <svg className="absolute inset-0 -rotate-90" viewBox="0 0 160 160">
            <circle
              cx="80"
              cy="80"
              r={radius}
              fill="none"
              stroke="#1e2545"
              strokeWidth="9"
            />
            <circle
              cx="80"
              cy="80"
              r={radius}
              fill="none"
              stroke="url(#bufferGrad)"
              strokeWidth="9"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - fill)}
              style={{ transition: "stroke-dashoffset 220ms linear" }}
            />
            <defs>
              <linearGradient id="bufferGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#5eeaff" />
                <stop offset="60%" stopColor="#76ff9c" />
                <stop offset="100%" stopColor="#ff4fd8" />
              </linearGradient>
            </defs>
          </svg>
          <div className="text-center">
            <div className="font-mono text-3xl font-bold text-white text-glow-cyan">
              {formatDuration(stats.buffered_seconds)}
            </div>
            <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">
              of {stats.buffer_seconds}s window
            </div>
            <div className="mt-2 font-mono text-[10px] text-slate-500">
              {formatBytes(stats.ring_bytes)} in RAM
            </div>
          </div>
        </div>

        {/* Telemetry */}
        <div className="space-y-3">
          <div className="rounded-xl border border-white/5 bg-black/25 p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: accent, boxShadow: `0 0 12px ${accent}` }}
                />
                <span
                  className="font-mono text-xs font-semibold tracking-[0.14em]"
                  style={{ color: accent }}
                >
                  {VENDOR_LABEL[stats.encoder.vendor]}
                </span>
                <span className="rounded border border-white/10 px-1.5 py-0.5 font-mono text-[9px] tracking-widest text-slate-400">
                  {stats.encoder.hardware ? "GPU" : "CPU"} · {stats.encoder.codec}
                </span>
              </div>
              <span className="font-mono text-[10px] text-slate-500">
                {stats.encoder.adapter_name}
              </span>
            </div>
            <div className="mt-2 truncate font-mono text-[10px] text-slate-500">
              {stats.encoder.friendly_name}
            </div>
            <EncodeSparkline value={stats.encode_ms_avg} accent={accent} />
            <div className="flex items-center justify-between font-mono text-[10px] text-slate-500">
              <span>encode cost / frame</span>
              <span style={{ color: accent }}>{stats.encode_ms_avg.toFixed(2)} ms</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric
              label="RAM"
              value={formatBytes(stats.process_rss_bytes, 0)}
              sub={stats.state === "idle" ? "idle footprint" : "engine + ring"}
              accent="#76ff9c"
            />
            <Metric
              label="GPU submit"
              value={`${stats.gpu_submit_ms_avg.toFixed(2)} ms`}
              sub="DXGI acquire→blt"
              accent="#5eeaff"
            />
            <Metric
              label="Dropped"
              value={String(stats.dropped_frames)}
              sub={`${stats.device_resets} device reset${stats.device_resets === 1 ? "" : "s"}`}
              accent={stats.dropped_frames > 0 ? "#ffc94f" : "#e6ecff"}
            />
            <Metric
              label="Hotkey"
              value={hotkey.toUpperCase()}
              sub="global · works in-game"
              accent="#ff4fd8"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 font-mono text-[10px]">
            <span
              className={cn(
                "rounded-full border px-2.5 py-1 tracking-[0.12em]",
                stats.audio_system
                  ? "border-lime-400/30 bg-lime-400/10 text-lime-200"
                  : "border-white/10 bg-white/5 text-slate-500",
              )}
            >
              WASAPI LOOPBACK {stats.audio_system ? "ON" : "OFF"}
            </span>
            <span
              className={cn(
                "rounded-full border px-2.5 py-1 tracking-[0.12em]",
                stats.audio_mic
                  ? "border-fuchsia-400/30 bg-fuchsia-500/10 text-fuchsia-200"
                  : "border-white/10 bg-white/5 text-slate-500",
              )}
            >
              MIC {stats.audio_mic ? "ON" : "OFF"}
            </span>
            <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 tracking-[0.12em] text-slate-400">
              A/V DRIFT {stats.audio_drift_ms.toFixed(2)} MS
            </span>
            <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 tracking-[0.12em] text-slate-400">
              UPTIME {formatDuration(stats.uptime_seconds)}
            </span>
          </div>
        </div>
      </div>

      {stats.last_error && (
        <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 font-mono text-[11px] text-rose-200">
          {stats.last_error}
        </div>
      )}
    </section>
  );
}
