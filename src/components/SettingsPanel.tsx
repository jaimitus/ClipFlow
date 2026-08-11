import { useEffect, useRef, useState } from "react";
import { clipflow } from "../lib/bridge";
import type {
  AppSettings,
  EngineStats,
  MonitorInfo,
  PowerState,
  UpdateProgress,
} from "../lib/types";
import { formatBytes } from "../lib/format";
import { cn } from "../utils/cn";
import { Row, Toggle } from "./ui";

interface Props {
  settings: AppSettings;
  stats: EngineStats;
  monitors: MonitorInfo[];
  version: string;
  /** Live battery/RAM snapshot for the ECO telemetry row (null = not read yet). */
  power?: PowerState | null;
  onChange: (patch: Partial<AppSettings>) => void;
  onRestartEngine: () => void;
  onOpenFolder: () => void;
  onChooseFolder: () => void;
  updateProgress?: UpdateProgress | null;
  onCheckForUpdates: () => void;
  onSimulateDeviceLoss: () => void;
  native: boolean;
}

const BUFFER_PRESETS = [15, 30, 60, 120, 300];
const FPS_PRESETS = [30, 60, 120, 144];
const CLEANUP_PRESETS = [
  { days: 0, label: "OFF" },
  { days: 7, label: "7 D" },
  { days: 14, label: "14 D" },
  { days: 30, label: "30 D" },
  { days: 60, label: "60 D" },
];

/**
 * Turns a raw keydown into a global-shortcut accelerator string, or null when
 * the combo is not a valid global hotkey (no modifier, or a modifier key alone).
 */
function acceleratorFromEvent(e: KeyboardEvent): string | null {
  if (e.key === "Escape") return "__cancel__";
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Win");

  const key = e.key;
  if (["Control", "Alt", "Shift", "Meta", "CapsLock", "Tab"].includes(key)) return null;

  let token: string | null = null;
  if (/^[a-z0-9]$/i.test(key)) token = key.toUpperCase();
  else if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(key)) token = key.toUpperCase();
  else if (key === " ") token = "Space";
  else return null; // arrows/media keys are allowed only as bare keys → rejected below

  if (mods.length === 0) return null; // Windows reserves bare keys for typing
  return [...mods, token].join("+");
}

/** Click-to-record hotkey badge. */
function HotkeyRecorder({
  value,
  recording,
  onStart,
}: {
  value: string;
  recording: boolean;
  onStart: () => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!recording) return;
    ref.current?.focus();
  }, [recording]);
  return (
    <button
      ref={ref}
      onClick={onStart}
      disabled={recording}
      title="Click, then press the new key combination"
      className={cn(
        "relative rounded-md border px-3 py-1.5 font-mono text-[12px] tracking-[0.14em] transition",
        recording
          ? "animate-pulse border-lime-300/70 bg-lime-400/15 text-lime-100"
          : "border-fuchsia-300/40 bg-fuchsia-500/10 text-fuchsia-100 hover:border-fuchsia-300/80 hover:bg-fuchsia-500/20",
      )}
    >
      {recording ? (
        <>
          <span className="mr-1.5 inline-block h-1.5 w-1.5 animate-rec rounded-full bg-lime-300 align-middle" />
          PRESS KEYS…
        </>
      ) : (
        <>{value.toUpperCase()}</>
      )}
    </button>
  );
}

export default function SettingsPanel({
  settings,
  stats,
  monitors,
  version,
  power,
  onChange,
  onRestartEngine,
  onOpenFolder,
  onChooseFolder,
  updateProgress,
  onCheckForUpdates,
  onSimulateDeviceLoss,
  native,
}: Props) {
  const [bitrate, setBitrate] = useState(settings.bitrateKbps);
  const [recording, setRecording] = useState<"save" | "toggle" | null>(null);

  useEffect(() => setBitrate(settings.bitrateKbps), [settings.bitrateKbps]);

  // Global key capture while a hotkey badge is in "record" mode.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const accel = acceleratorFromEvent(e);
      if (accel === "__cancel__") {
        setRecording(null);
        return;
      }
      if (!accel) return;
      const patch = recording === "save" ? { hotkeySave: accel } : { hotkeyToggle: accel };
      onChange(patch);
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onChange]);

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
          label="Video codec"
          hint="HEVC (H.265) roughly halves file size. Applies after APPLY & RESTART ENGINE."
        >
          <div className="flex gap-1.5">
            {(["h264", "hevc"] as const).map((c) => (
              <button
                key={c}
                onClick={() => onChange({ codec: c })}
                className={cn(
                  "rounded-md border px-2.5 py-1 font-mono text-[11px] transition",
                  settings.codec === c
                    ? "border-cyan-300/60 bg-cyan-400/20 text-cyan-100"
                    : "border-white/10 text-slate-400 hover:border-white/25 hover:text-slate-200",
                )}
              >
                {c === "h264" ? "H.264" : "HEVC"}
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

        <Row label="Microphone" hint="Adds your voice to the mix.">
          <Toggle
            on={settings.captureMicrophone}
            onClick={() => onChange({ captureMicrophone: !settings.captureMicrophone })}
          />
        </Row>

        <Row label={`Game audio — ${settings.gameVolume}%`} hint="System/loopback volume in the mix. Applies live, no restart.">
          <input
            type="range"
            className="cf-range w-48"
            min={0}
            max={100}
            step={5}
            value={settings.gameVolume}
            onChange={(e) => onChange({ gameVolume: Number(e.target.value) })}
          />
        </Row>

        <Row label={`Microphone — ${settings.micVolume}%`} hint="Your voice volume in the mix. Applies live, no restart.">
          <input
            type="range"
            className="cf-range w-48"
            min={0}
            max={100}
            step={5}
            value={settings.micVolume}
            onChange={(e) => onChange({ micVolume: Number(e.target.value) })}
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
        <h3 className="font-mono text-[11px] tracking-[0.24em] text-lime-300">
          ADAPTIVE CAPTURE (ECO)
        </h3>

        <Row
          label="ECO mode"
          hint="On battery or low RAM the rolling buffer shrinks to 30 s live (and fps caps at 30 on the next engine start) — ClipFlow steps out of the way when the machine is under pressure, then restores itself automatically."
        >
          <Toggle
            on={settings.adaptiveEco}
            onClick={() => onChange({ adaptiveEco: !settings.adaptiveEco })}
          />
        </Row>

        {settings.adaptiveEco && (
          <>
            <Row
              label={`Battery trigger — ≤ ${settings.ecoBatteryThresholdPct}%`}
              hint="While on battery, ECO activates when the remaining charge drops to this level."
            >
              <input
                type="range"
                className="cf-range w-48"
                min={5}
                max={100}
                step={5}
                value={settings.ecoBatteryThresholdPct}
                onChange={(e) =>
                  onChange({ ecoBatteryThresholdPct: Number(e.target.value) })
                }
              />
            </Row>
            <Row
              label={`RAM trigger — < ${settings.ecoRamFreeGbs} GiB free`}
              hint="ECO activates when available physical memory drops below this threshold."
            >
              <input
                type="range"
                className="cf-range w-48"
                min={1}
                max={16}
                step={1}
                value={settings.ecoRamFreeGbs}
                onChange={(e) => onChange({ ecoRamFreeGbs: Number(e.target.value) })}
              />
            </Row>

            {/* Live telemetry so the panel always shows what the machine is
                actually doing (battery/AC + free RAM), even while ECO is off. */}
            <div className="mt-2 rounded-xl border border-white/8 bg-black/30 px-3 py-2.5">
              <div className="flex items-center justify-between font-mono text-[10px] tracking-[0.14em]">
                <span className="text-slate-500">LIVE TELEMETRY</span>
                {power ? (
                  <span className={cn("font-semibold", power.onBattery ? "text-amber-300" : "text-lime-300")}>
                    {power.onBattery ? `🔋 BATTERY ${power.batteryPercent}%` : "🔌 AC POWER"}
                  </span>
                ) : (
                  <span className="animate-pulse text-slate-600">READING…</span>
                )}
              </div>
              <div className="mt-1.5 font-mono text-[11px] text-slate-300">
                {power
                  ? `${formatBytes(power.availableRamBytes)} free of ${formatBytes(power.totalRamBytes)}`
                  : "—"}
              </div>
            </div>
          </>
        )}
      </section>

      <section className="panel rounded-2xl p-4">
        <h3 className="font-mono text-[11px] tracking-[0.24em] text-fuchsia-300">
          WORKFLOW
        </h3>

        <Row label="Save hotkey" hint="Click the badge and press the new combo. Must include a modifier; works inside full-screen games.">
          <HotkeyRecorder
            value={settings.hotkeySave}
            recording={recording === "save"}
            onStart={() => setRecording("save")}
          />
        </Row>

        <Row label="Arm / disarm hotkey" hint="Click the badge and press the new combo.">
          <HotkeyRecorder
            value={settings.hotkeyToggle}
            recording={recording === "toggle"}
            onStart={() => setRecording("toggle")}
          />
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

        <Row label="Play sound on save" hint="A short shutter blip confirms Alt+C — no audio files, generated locally.">
          <Toggle
            on={settings.playSaveSound}
            onClick={() => onChange({ playSaveSound: !settings.playSaveSound })}
          />
        </Row>

        <Row label="Pin window on top" hint="Keeps the deck visible over full-screen games.">
          <Toggle
            on={settings.alwaysOnTop}
            onClick={() => onChange({ alwaysOnTop: !settings.alwaysOnTop })}
          />
        </Row>

        <Row label="Organize clips by game" hint="Saves clips into Videos/ClipFlow/<game>/ subfolders and tags them with the game in focus.">
          <Toggle
            on={settings.organizeByGame}
            onClick={() => onChange({ organizeByGame: !settings.organizeByGame })}
          />
        </Row>

        <Row label="Auto-save when a game closes" hint="When the focused game leaves the foreground, the last 30 s are saved automatically and tagged with that game.">
          <Toggle
            on={settings.autosaveOnGameExit}
            onClick={() => onChange({ autosaveOnGameExit: !settings.autosaveOnGameExit })}
          />
        </Row>

        <Row label="Overlay HUD" hint="A small always-on-top indicator (● REC) appears while the buffer is armed. Click-through, never steals focus.">
          <Toggle
            on={settings.hudEnabled}
            onClick={() => onChange({ hudEnabled: !settings.hudEnabled })}
          />
        </Row>

        <Row label="Privacy mode" hint="Pauses capture whenever the desktop or ClipFlow is focused, so the buffer only ever holds gameplay. Works with the game in the foreground (elevated games included).">
          <Toggle
            on={settings.privacyPauseWhenUnfocused}
            onClick={() => onChange({ privacyPauseWhenUnfocused: !settings.privacyPauseWhenUnfocused })}
          />
        </Row>

        <Row label="Launch at startup" hint="Starts ClipFlow hidden to tray when you sign in to Windows.">
          <Toggle
            on={settings.launchAtStartup}
            onClick={() => onChange({ launchAtStartup: !settings.launchAtStartup })}
          />
        </Row>

        <Row label="Auto cleanup" hint="Deletes clips older than the chosen age at every launch to keep the folder tidy.">
          <div className="flex gap-1.5">
            {CLEANUP_PRESETS.map((p) => (
              <button
                key={p.days}
                onClick={() => onChange({ autoCleanupDays: p.days })}
                className={cn(
                  "rounded-md border px-2.5 py-1 font-mono text-[11px] transition",
                  settings.autoCleanupDays === p.days
                    ? "border-lime-300/60 bg-lime-400/20 text-lime-100"
                    : "border-white/10 text-slate-400 hover:border-white/25 hover:text-slate-200",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </Row>

        <Row label="Output folder" hint={settings.outputDir}>
          <div className="flex gap-1.5">
            <button
              onClick={onOpenFolder}
              className="rounded-lg border border-white/10 px-3 py-1.5 font-mono text-[11px] tracking-[0.14em] text-slate-300 transition hover:border-cyan-300/40 hover:text-cyan-200"
            >
              OPEN
            </button>
            <button
              onClick={onChooseFolder}
              className="rounded-lg border border-fuchsia-300/40 bg-fuchsia-500/10 px-3 py-1.5 font-mono text-[11px] tracking-[0.14em] text-fuchsia-100 transition hover:bg-fuchsia-500/20"
            >
              CHANGE
            </button>
          </div>
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
        <h3 className="font-mono text-[11px] tracking-[0.24em] text-fuchsia-300">
          ABOUT & UPDATES
        </h3>

        <Row label="Version" hint="Built on Rust + Tauri v2 — single portable binary.">
          <span className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 font-mono text-[12px] tracking-[0.14em] text-slate-300">
            v{version}
          </span>
        </Row>

        <Row label="Check for updates" hint="Fetches the newest GitHub release and installs it automatically — signed updates, still no background updater.">
          <button
            onClick={onCheckForUpdates}
            className="rounded-lg border border-cyan-300/40 bg-cyan-400/10 px-3 py-1.5 font-mono text-[11px] tracking-[0.14em] text-cyan-100 transition hover:bg-cyan-400/20"
          >
            CHECK UPDATE
          </button>
        </Row>

        {updateProgress && (
          <div className="mt-3 space-y-1.5 rounded-lg border border-cyan-300/20 bg-cyan-400/5 px-3 py-2">
            <div className="flex items-center justify-between font-mono text-[10px] tracking-[0.14em] text-cyan-200">
              <span>
                {updateProgress.phase === "DOWNLOADING" ? "DOWNLOADING UPDATE" : updateProgress.phase}
              </span>
              {updateProgress.total > 0 && (
                <span>
                  {formatBytes(updateProgress.downloaded)} / {formatBytes(updateProgress.total)}
                </span>
              )}
            </div>
            {updateProgress.total > 0 && (
              <div className="h-1 overflow-hidden rounded-full bg-black/40">
                <div
                  className="h-full bg-gradient-to-r from-cyan-400 to-fuchsia-500 transition-all duration-200"
                  style={{
                    width: `${Math.min(100, (updateProgress.downloaded / updateProgress.total) * 100)}%`,
                  }}
                />
              </div>
            )}
          </div>
        )}

        <div className="mt-1 grid grid-cols-2 gap-2 font-mono text-[10px] text-slate-500">
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
