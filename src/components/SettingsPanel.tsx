import { useEffect, useState } from "react";
import type { AppSettings, EngineStats, MonitorInfo } from "../lib/types";
import { formatBytes } from "../lib/format";
import { cn } from "../utils/cn";

interface Props {
  settings: AppSettings;
  stats: EngineStats;
  monitors: MonitorInfo[];
  onChange: (patch: Partial<AppSettings>) => void;
  onRestartEngine: () => void;
  onOpenFolder: () => void;
  onSimulateDeviceLoss: () => void;
  native: boolean;
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
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

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative h-6 w-11 rounded-full border transition",
        on
          ? "border-cyan-300/60 bg-cyan-400/25"
          : "border-white/10 bg-white/5",
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

const BUFFER_PRESETS = [15, 30, 60, 120, 300];
const FPS_PRESETS = [30, 60, 120, 144];

export default function SettingsPanel({
  settings,
  stats,
  monitors,
  onChange,
  onRestartEngine,
  onOpenFolder,
  onSimulateDeviceLoss,
  native,
}: Props) {
  const [bitrate, setBitrate] = useState(settings.bitrateKbps);

  useEffect(() => setBitrate(settings.bitrateKbps), [settings.bitrateKbps]);

  const projectedRam =
    (settings.bufferSeconds * settings.bitrateKbps * 1000) / 8 * 1.6;

  return (
    <div className="space-y-4">
      <section className="panel rounded-2xl p-4">
        <h3 className="font-mono text-[11px] tracking-[0.24em] text-cyan-300">
          CAPTURE ENGINE
        </h3>

        <Row label="Rolling buffer" hint="How much history lives in RAM at all times.">
          <div className="flex gap-1.5">
            {BUFFER_PRESETS.map((s) => (
              <button
                key={s}
                onClick={() => onChange({ bufferSeconds: s })}
                className={cn(
                  "rounded-md border px-2.5 py-1 font-mono text-[11px] transition",
                  settings.bufferSeconds === s
                    ? "border-cyan-300/60 bg-cyan-400/20 text-cyan-100"
                    : "border-white/10 text-slate-400 hover:border-white/25 hover:text-slate-200",
                )}
              >
                {s >= 60 ? `${s / 60}m` : `${s}s`}
              </button>
            ))}
          </div>
        </Row>

        <Row label="Target frame rate" hint="Capture is frame-paced with sub-millisecond jitter.">
          <div className="flex gap-1.5">
            {FPS_PRESETS.map((f) => (
              <button
                key={f}
                onClick={() => onChange({ targetFps: f })}
                className={cn(
                  "rounded-md border px-2.5 py-1 font-mono text-[11px] transition",
                  settings.targetFps === f
                    ? "border-lime-300/60 bg-lime-400/20 text-lime-100"
                    : "border-white/10 text-slate-400 hover:border-white/25 hover:text-slate-200",
                )}
              >
                {f}
              </button>
            ))}
          </div>
        </Row>

        <Row
          label={`Bitrate — ${(bitrate / 1000).toFixed(0)} Mb/s`}
          hint={`Projected buffer ceiling ≈ ${formatBytes(projectedRam)} of RAM.`}
        >
          <input
            type="range"
            className="cf-range w-48"
            min={3000}
            max={60000}
            step={1000}
            value={bitrate}
            onChange={(e) => setBitrate(Number(e.target.value))}
            onPointerUp={() => onChange({ bitrateKbps: bitrate })}
            onKeyUp={() => onChange({ bitrateKbps: bitrate })}
          />
        </Row>

        <Row label="Source display" hint="DXGI Desktop Duplication output.">
          <select
            value={settings.monitorIndex}
            onChange={(e) => onChange({ monitorIndex: Number(e.target.value) })}
            className="rounded-md border border-white/10 bg-black/50 px-2.5 py-1.5 font-mono text-[11px] text-slate-200 outline-none focus:border-cyan-300/50"
          >
            {monitors.map((m) => (
              <option key={m.index} value={m.index} className="bg-[#0a0d1a]">
                {m.name} · {m.width}×{m.height}
                {m.primary ? " (primary)" : ""}
              </option>
            ))}
          </select>
        </Row>

        <Row label="System audio (WASAPI loopback)" hint="Captured on the same QPC clock as video.">
          <Toggle
            on={settings.captureSystemAudio}
            onClick={() => onChange({ captureSystemAudio: !settings.captureSystemAudio })}
          />
        </Row>

        <Row label="Microphone" hint="Mixed at −3 dB into the loopback stream.">
          <Toggle
            on={settings.captureMicrophone}
            onClick={() => onChange({ captureMicrophone: !settings.captureMicrophone })}
          />
        </Row>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={onRestartEngine}
            className="rounded-lg border border-cyan-300/40 bg-cyan-400/10 px-3 py-1.5 font-mono text-[11px] tracking-[0.14em] text-cyan-100 transition hover:bg-cyan-400/20"
          >
            APPLY & RESTART ENGINE
          </button>
          <button
            onClick={onSimulateDeviceLoss}
            className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 font-mono text-[11px] tracking-[0.14em] text-amber-100 transition hover:bg-amber-400/20"
          >
            TEST DEVICE-LOSS RECOVERY
          </button>
        </div>
      </section>

      <section className="panel rounded-2xl p-4">
        <h3 className="font-mono text-[11px] tracking-[0.24em] text-fuchsia-300">
          WORKFLOW
        </h3>

        <Row label="Save hotkey" hint="Registered globally — works inside full-screen games.">
          <span className="rounded-md border border-fuchsia-300/40 bg-fuchsia-500/10 px-3 py-1.5 font-mono text-[12px] tracking-[0.14em] text-fuchsia-100">
            {settings.hotkeySave}
          </span>
        </Row>

        <Row label="Arm / disarm hotkey">
          <span className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 font-mono text-[12px] tracking-[0.14em] text-slate-300">
            {settings.hotkeyToggle}
          </span>
        </Row>

        <Row label="Open trimmer after save" hint="Floating quick-trim modal pops up instantly.">
          <Toggle
            on={settings.openTrimmerAfterSave}
            onClick={() => onChange({ openTrimmerAfterSave: !settings.openTrimmerAfterSave })}
          />
        </Row>

        <Row label="Close to tray" hint="The buffer keeps rolling while the window is hidden.">
          <Toggle
            on={settings.minimizeToTray}
            onClick={() => onChange({ minimizeToTray: !settings.minimizeToTray })}
          />
        </Row>

        <Row label="Arm buffer at launch">
          <Toggle
            on={settings.autostartBuffer}
            onClick={() => onChange({ autostartBuffer: !settings.autostartBuffer })}
          />
        </Row>

        <Row label="Output folder" hint={settings.outputDir}>
          <button
            onClick={onOpenFolder}
            className="rounded-lg border border-white/10 px-3 py-1.5 font-mono text-[11px] tracking-[0.14em] text-slate-300 transition hover:border-cyan-300/40 hover:text-cyan-200"
          >
            OPEN
          </button>
        </Row>

        <Row label="Exit application" hint="Completely stops the GPU buffer and exits process.">
          <button
            onClick={() => void clipflow.quit()}
            className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 font-mono text-[11px] tracking-[0.14em] text-rose-200 transition hover:bg-rose-500/25"
          >
            QUIT CLIPFLOW
          </button>
        </Row>
      </section>

      <section className="panel rounded-2xl p-4">
        <h3 className="font-mono text-[11px] tracking-[0.24em] text-lime-300">
          PRIVACY & FOOTPRINT
        </h3>
        <ul className="mt-3 space-y-2 text-[12px] leading-relaxed text-slate-400">
          <li className="flex gap-2">
            <span className="text-lime-400">✓</span> No account, no login, no cloud upload.
          </li>
          <li className="flex gap-2">
            <span className="text-lime-400">✓</span> Zero telemetry — the process never opens
            an outbound socket.
          </li>
          <li className="flex gap-2">
            <span className="text-lime-400">✓</span> No background updater service or
            scheduled task.
          </li>
          <li className="flex gap-2">
            <span className="text-lime-400">✓</span> Single portable executable; settings live
            in one JSON file.
          </li>
        </ul>
        <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-[10px] text-slate-500">
          <div className="rounded-lg border border-white/5 bg-black/25 px-3 py-2">
            <div className="tracking-[0.16em] text-slate-600">RUNTIME</div>
            <div className="mt-1 text-slate-300">
              {native ? "Tauri v2 · Rust · WebView2" : "Browser preview"}
            </div>
          </div>
          <div className="rounded-lg border border-white/5 bg-black/25 px-3 py-2">
            <div className="tracking-[0.16em] text-slate-600">PROCESS RSS</div>
            <div className="mt-1 text-slate-300">{formatBytes(stats.process_rss_bytes)}</div>
          </div>
        </div>
      </section>
    </div>
  );
}
