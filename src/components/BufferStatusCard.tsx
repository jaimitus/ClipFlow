import { useEffect, useMemo, useRef } from "react";
import type { EngineStats } from "../lib/types";
import { VENDOR_LABEL } from "../lib/types";
import { formatBytes, formatDuration } from "../lib/format";
import { cn } from "../utils/cn";

interface Props {
  stats: EngineStats;
  hotkey: string;
  busy?: boolean;
  /** Adaptive capture (ECO) status, when active. */
  eco?: { active: boolean; reason: "battery" | "ram" | "off" } | null;
  onToggle: () => void;
  onSave: () => void;
}

const STATE_META: Record<
  EngineStats["state"],
  { label: string; tone: string; dot: string; desc: string }
> = {
  idle: {
    label: "BUFFER DISARMED",
    tone: "text-[#8d98a8]",
    dot: "bg-[#556172]",
    desc: "Memory ring buffer is inactive. Arm to start continuous replay capture.",
  },
  starting: {
    label: "STARTING ENGINE",
    tone: "text-blue-400",
    dot: "bg-blue-400 animate-rec",
    desc: "Allocating D3D11 staging textures and spinning up hardware encoder.",
  },
  buffering: {
    label: "BUFFER RECORDING",
    tone: "text-emerald-400",
    dot: "bg-emerald-400",
    desc: "Continuously encoding display frames to rolling memory buffer.",
  },
  flushing: {
    label: "SAVING CLIP TO MP4",
    tone: "text-amber-300",
    dot: "bg-amber-400 animate-rec",
    desc: "Muxing cached keyframes straight to output folder.",
  },
  recovering: {
    label: "GPU RECOVERY IN PROGRESS",
    tone: "text-amber-300",
    dot: "bg-amber-400 animate-rec",
    desc: "DXGI access lost. Reinitializing D3D11 swapchain without crash.",
  },
  error: {
    label: "ENGINE FAULT",
    tone: "text-red-400",
    dot: "bg-red-400",
    desc: "Capture pipeline failed. Check device status in Settings.",
  },
};

/** Minimalist, crisp sparkline of per-frame encode cost. */
function EncodeSparkline({ value }: { value: number }) {
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
    const max = Math.max(3.0, ...data) * 1.15;

    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / Math.max(data.length - 1, 1)) * w;
      const y = h - (v / max) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "rgba(56, 189, 248, 0.18)");
    grad.addColorStop(1, "rgba(56, 189, 248, 0.0)");
    ctx.fillStyle = grad;
    ctx.fill();
  }, [value]);

  return <canvas ref={ref} className="h-8 w-full" aria-label="Encode latency sparkline" />;
}

function Metric({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-lg border border-[#232934] bg-[#14171e] px-3 py-2.5">
      <div className="font-mono text-[10px] font-medium uppercase tracking-wider text-[#7e8b9d]">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 font-mono text-[16px] font-semibold leading-none",
          highlight ? "text-amber-400" : "text-[#e6eaf0]",
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-[11px] text-[#717d8e]">{sub}</div>}
    </div>
  );
}

export default function BufferStatusCard({ stats, hotkey, busy, eco, onToggle, onSave }: Props) {
  const meta = STATE_META[stats.state];
  const armed = stats.state === "buffering" || stats.state === "flushing";

  const fill = useMemo(
    () => Math.min(1, stats.buffered_seconds / Math.max(stats.buffer_seconds, 1)),
    [stats.buffered_seconds, stats.buffer_seconds],
  );

  const radius = 60;
  const circumference = 2 * Math.PI * radius;

  return (
    <section className="panel rounded-xl p-5">
      {/* Header with primary status and action controls */}
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[#232934] pb-4">
        <div className="flex items-center gap-3">
          <span className={cn("h-3 w-3 rounded-full shrink-0", meta.dot)} />
          <div>
            <div className="flex items-center gap-2.5">
              <span className={cn("font-mono text-[13px] font-semibold tracking-wider", meta.tone)}>
                {meta.label}
              </span>
              {eco?.active && (
                <span
                  title="Adaptive capture active: rolling buffer size is scaled down to conserve resources."
                  className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-mono text-[10px] font-medium text-amber-300"
                >
                  ECO ({eco.reason === "battery" ? "BATTERY" : "RAM"})
                </span>
              )}
            </div>
            {stats.privacy_active ? (
              <div className="mt-0.5 font-mono text-[11px] text-amber-400">
                Privacy paused: desktop focused, buffer empty
              </div>
            ) : (
              <div className="mt-0.5 font-mono text-[11px] text-[#8692a3]">
                {stats.width > 0 ? `${stats.width}×${stats.height}` : "Display ready"} ·{" "}
                {stats.target_fps} fps target · {stats.capture_fps.toFixed(0)} fps live
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onToggle}
            disabled={busy}
            className={cn(
              "rounded-lg border px-3.5 py-2 font-mono text-[11px] font-semibold tracking-wider transition-colors duration-150",
              armed
                ? "border-[#3b4556] bg-[#1a202a] text-[#d4dae3] hover:border-red-500/50 hover:bg-red-500/10 hover:text-red-300"
                : "border-blue-500/40 bg-blue-500/10 text-blue-300 hover:border-blue-400 hover:bg-blue-500/20",
              busy && "cursor-wait opacity-60",
            )}
          >
            {armed ? "DISARM BUFFER" : "ARM BUFFER"}
          </button>

          <button
            type="button"
            onClick={onSave}
            disabled={!armed || busy}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-4 py-2 font-mono text-[11px] font-semibold tracking-wider transition-colors duration-150",
              armed && !busy
                ? "border-blue-500 bg-blue-600 text-white shadow-sm hover:bg-blue-500 hover:border-blue-400 active:bg-blue-700"
                : "cursor-not-allowed border-[#28303d] bg-[#14171e] text-[#556172]",
            )}
          >
            <span>SAVE CLIP</span>
            <kbd className="rounded border border-white/20 bg-black/30 px-1.5 py-0.5 font-mono text-[10px] text-white/90">
              {hotkey.toUpperCase()}
            </kbd>
          </button>
        </div>
      </header>

      {/* Main card body: Circular progress dial on left, telemetry and hardware on right */}
      <div className="mt-5 grid gap-5 lg:grid-cols-[164px_1fr]">
        {/* Rolling buffer circular dial */}
        <div className="flex flex-col items-center justify-center rounded-lg border border-[#232934] bg-[#14171e] p-3 text-center">
          <div className="relative grid h-[132px] w-[132px] place-items-center">
            <svg className="absolute inset-0 -rotate-90" viewBox="0 0 140 140" aria-hidden="true">
              <circle
                cx="70"
                cy="70"
                r={radius}
                fill="none"
                stroke="#202632"
                strokeWidth="8"
              />
              <circle
                cx="70"
                cy="70"
                r={radius}
                fill="none"
                stroke="#38bdf8"
                strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - fill)}
                style={{ transition: "stroke-dashoffset 200ms linear" }}
              />
            </svg>
            <div className="text-center">
              <div className="font-mono text-2xl font-bold tracking-tight text-[#e6eaf0]">
                {formatDuration(stats.buffered_seconds)}
              </div>
              <div className="mt-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-[#8d98a8]">
                of {stats.buffer_seconds}s
              </div>
            </div>
          </div>
          <div className="mt-1 font-mono text-[11px] text-[#8692a3]">
            {formatBytes(stats.ring_bytes)} in RAM
          </div>
        </div>

        {/* Telemetry and metrics */}
        <div className="space-y-3">
          {/* Encoder Hardware Card */}
          <div className="rounded-lg border border-[#232934] bg-[#14171e] p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="flex h-2 w-2 rounded-full bg-blue-400" />
                <span className="font-mono text-[12px] font-semibold text-[#e6eaf0]">
                  {VENDOR_LABEL[stats.encoder.vendor]}
                </span>
                <span className="rounded border border-[#2f3846] bg-[#1a202a] px-1.5 py-0.5 font-mono text-[10px] text-[#8d98a8]">
                  {stats.encoder.hardware ? "GPU HARDWARE" : "CPU SOFTWARE"} · {stats.encoder.codec}
                </span>
              </div>
              <span className="truncate font-mono text-[11px] text-[#717d8e]">
                {stats.encoder.adapter_name}
              </span>
            </div>

            <div className="mt-1 truncate font-mono text-[11px] text-[#8692a3]">
              {stats.encoder.friendly_name}
            </div>

            <div className="mt-2">
              <EncodeSparkline value={stats.encode_ms_avg} />
            </div>

            <div className="mt-1 flex items-center justify-between font-mono text-[10px] text-[#8692a3]">
              <span>Encode latency</span>
              <span className="font-medium text-[#38bdf8]">{stats.encode_ms_avg.toFixed(2)} ms / frame</span>
            </div>
          </div>

          {/* Metric cards */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <Metric
              label="Memory"
              value={formatBytes(stats.process_rss_bytes, 0)}
              sub={stats.state === "idle" ? "idle process" : "buffer + ring"}
            />
            <Metric
              label="GPU Acquire"
              value={`${stats.gpu_submit_ms_avg.toFixed(2)} ms`}
              sub="acquire to blit"
            />
            <Metric
              label="Dropped"
              value={String(stats.dropped_frames)}
              sub={`${stats.device_resets} reset${stats.device_resets === 1 ? "" : "s"}`}
              highlight={stats.dropped_frames > 0}
            />
            <Metric
              label="Global Hotkey"
              value={hotkey.toUpperCase()}
              sub="works in full-screen"
            />
          </div>

          {/* Audio, drift, and uptime status */}
          <div className="flex flex-wrap items-center gap-2 font-mono text-[10px]">
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 tracking-wider",
                stats.audio_system && !stats.audio_error
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                  : "border-[#2c3543] bg-[#14171e] text-[#7e8b9d]",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  stats.audio_system && !stats.audio_error ? "bg-emerald-400" : "bg-[#556172]",
                )}
              />
              GAME AUDIO {stats.audio_system ? "ON" : "OFF"}
            </span>

            <span
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 tracking-wider",
                stats.audio_mic
                  ? "border-blue-500/30 bg-blue-500/10 text-blue-300"
                  : "border-[#2c3543] bg-[#14171e] text-[#7e8b9d]",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  stats.audio_mic ? "bg-blue-400" : "bg-[#556172]",
                )}
              />
              MIC {stats.audio_mic ? "ON" : "OFF"}
            </span>

            <span className="rounded-full border border-[#28303d] bg-[#14171e] px-2.5 py-1 tracking-wider text-[#8692a3]">
              A/V DRIFT {stats.audio_drift_ms.toFixed(2)} ms
            </span>

            <span className="rounded-full border border-[#28303d] bg-[#14171e] px-2.5 py-1 tracking-wider text-[#8692a3]">
              UPTIME {formatDuration(stats.uptime_seconds)}
            </span>
          </div>
        </div>
      </div>

      {stats.last_error && (
        <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 font-mono text-[11px] text-red-200">
          <span className="font-semibold text-red-100">Engine fault: </span>
          {stats.last_error}
        </div>
      )}
    </section>
  );
}
