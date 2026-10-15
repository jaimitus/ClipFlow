import { useEffect, useRef, useState } from "react";
import { clipflow } from "../lib/bridge";
import type {
  AppSettings,
  AudioDevice,
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
  else return null;

  if (mods.length === 0) return null;
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
      type="button"
      onClick={onStart}
      disabled={recording}
      title="Click, then press the new key combination"
      className={cn(
        "relative rounded border px-3 py-1 font-mono text-[11px] font-semibold tracking-wider transition-colors",
        recording
          ? "border-blue-400 bg-blue-500/20 text-blue-200"
          : "border-[#313a49] bg-[#14171e] text-[#e6eaf0] hover:border-blue-400/60 hover:bg-[#1a202a]",
      )}
    >
      {recording ? (
        <>
          <span className="mr-1.5 inline-block h-1.5 w-1.5 animate-rec rounded-full bg-blue-400 align-middle" />
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
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([]);
  const [scanningDevices, setScanningDevices] = useState(false);

  const refreshAudioDevices = async () => {
    setScanningDevices(true);
    try {
      const devs = await clipflow.getAudioInputDevices();
      setAudioDevices(devs);
    } catch {
      // Best-effort device enumeration
    } finally {
      setScanningDevices(false);
    }
  };

  useEffect(() => {
    void refreshAudioDevices();
  }, []);

  useEffect(() => setBitrate(settings.bitrateKbps), [settings.bitrateKbps]);

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
      {/* ---------------- Capture Engine Section ---------------- */}
      <section className="panel rounded-xl p-4">
        <h3 className="font-mono text-[11px] font-semibold tracking-wider text-[#9aa5b5]">
          CAPTURE ENGINE
        </h3>

        <div className="mt-2.5">
          <Row label="Buffer duration" hint="Continuous recording history kept in memory.">
            <div className="flex gap-1">
              {BUFFER_PRESETS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onChange({ bufferSeconds: s })}
                  className={cn(
                    "rounded border px-2.5 py-1 font-mono text-[11px] transition-colors",
                    settings.bufferSeconds === s
                      ? "border-blue-500 bg-blue-600 text-white font-semibold"
                      : "border-[#2b3342] bg-[#14171e] text-[#8692a3] hover:text-white",
                  )}
                >
                  {s >= 60 ? `${s / 60}m` : `${s}s`}
                </button>
              ))}
            </div>
          </Row>

          <Row label="Target frame rate" hint="Paced capture rate with sub-millisecond precision.">
            <div className="flex gap-1">
              {FPS_PRESETS.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => onChange({ targetFps: f })}
                  className={cn(
                    "rounded border px-2.5 py-1 font-mono text-[11px] transition-colors",
                    settings.targetFps === f
                      ? "border-blue-500 bg-blue-600 text-white font-semibold"
                      : "border-[#2b3342] bg-[#14171e] text-[#8692a3] hover:text-white",
                  )}
                >
                  {f}
                </button>
              ))}
            </div>
          </Row>

          <Row
            label="Video codec"
            hint="HEVC halves file size on supported hardware. Requires engine restart."
          >
            <div className="flex gap-1">
              {(["h264", "hevc"] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => onChange({ codec: c })}
                  className={cn(
                    "rounded border px-2.5 py-1 font-mono text-[11px] transition-colors",
                    settings.codec === c
                      ? "border-blue-500 bg-blue-600 text-white font-semibold"
                      : "border-[#2b3342] bg-[#14171e] text-[#8692a3] hover:text-white",
                  )}
                >
                  {c === "h264" ? "H.264" : "HEVC"}
                </button>
              ))}
            </div>
          </Row>

          <Row
            label={`Bitrate: ${(bitrate / 1000).toFixed(0)} Mb/s`}
            hint={`Buffer memory footprint ceiling: ~${formatBytes(projectedRam)}`}
          >
            <input
              type="range"
              className="cf-range w-44"
              min={3000}
              max={60000}
              step={1000}
              value={bitrate}
              onChange={(e) => setBitrate(Number(e.target.value))}
              onPointerUp={() => onChange({ bitrateKbps: bitrate })}
              onKeyUp={() => onChange({ bitrateKbps: bitrate })}
            />
          </Row>

          <Row label="Source display" hint="DXGI output monitor adapter.">
            <select
              value={settings.monitorIndex}
              onChange={(e) => onChange({ monitorIndex: Number(e.target.value) })}
              className="rounded border border-[#2b3342] bg-[#11141a] px-2.5 py-1.5 font-mono text-[11px] text-[#e2e7ef] outline-none focus:border-blue-400"
            >
              {monitors.map((m) => (
                <option key={m.index} value={m.index} className="bg-[#111318]">
                  {m.name} ({m.width}×{m.height}) {m.primary ? "- Primary" : ""}
                </option>
              ))}
            </select>
          </Row>

          <Row label="Game audio (WASAPI loopback)" hint="Captured in exact synchronization with video frames.">
            <Toggle
              on={settings.captureSystemAudio}
              onClick={() => onChange({ captureSystemAudio: !settings.captureSystemAudio })}
            />
          </Row>

          {settings.captureSystemAudio && (
            <Row label={`Game audio level: ${settings.gameVolume}%`}>
              <input
                type="range"
                className="cf-range w-44"
                min={0}
                max={100}
                step={5}
                value={settings.gameVolume}
                onChange={(e) => onChange({ gameVolume: Number(e.target.value) })}
              />
            </Row>
          )}

          <Row label="Microphone capture" hint="Records your voice input into the mix.">
            <Toggle
              on={settings.captureMicrophone}
              onClick={() => onChange({ captureMicrophone: !settings.captureMicrophone })}
            />
          </Row>

          {settings.captureMicrophone && (
            <>
              <Row
                label="Input device / Microphone"
                hint="Choose which microphone ClipFlow captures into the clip audio."
              >
                <div className="flex items-center gap-2">
                  <select
                    className="max-w-[240px] truncate rounded border border-[#313a49] bg-[#14171e] px-2.5 py-1.5 font-mono text-[11px] text-[#e6eaf0] focus:border-blue-400 focus:outline-none"
                    value={settings.micDeviceId || "default"}
                    onChange={(e) => {
                      const val = e.target.value;
                      onChange({ micDeviceId: val === "default" ? null : val });
                    }}
                  >
                    <option value="default">
                      Default ({audioDevices.find((d) => d.isDefault)?.name || "System Default"})
                    </option>
                    {audioDevices.map((dev) => (
                      <option key={dev.id} value={dev.id}>
                        {dev.name} {dev.isDefault ? "(Default)" : ""}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => void refreshAudioDevices()}
                    title="Rescan microphones"
                    disabled={scanningDevices}
                    className="flex h-7 w-7 items-center justify-center rounded border border-[#313a49] bg-[#14171e] text-[#8e9bb0] transition-colors hover:border-blue-400/60 hover:text-white disabled:opacity-50"
                  >
                    <svg
                      className={cn("h-3.5 w-3.5", scanningDevices && "animate-spin")}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                      />
                    </svg>
                  </button>
                </div>
              </Row>

              <Row label={`Microphone level: ${settings.micVolume}%`}>
                <input
                  type="range"
                  className="cf-range w-44"
                  min={0}
                  max={100}
                  step={5}
                  value={settings.micVolume}
                  onChange={(e) => onChange({ micVolume: Number(e.target.value) })}
                />
              </Row>

              <div className="mt-1 rounded-lg border border-[#232934] bg-[#14171e] px-3.5 py-2.5 text-[11px] text-[#8692a3] space-y-1">
                <div className="flex items-center justify-between font-mono text-[10px] tracking-wider text-[#7e8b9d]">
                  <span>MIC DIAGNOSTICS & PRIVACY</span>
                  <span className={cn(stats.audio_mic ? "text-emerald-400 font-medium" : "text-[#7a8799]")}>
                    {stats.audio_mic ? "CAPTURE ACTIVE" : "IDLE"}
                  </span>
                </div>
                <div className="text-[11px] text-[#d6dbe4]">
                  Active source:{" "}
                  <span className="font-semibold text-white">
                    {settings.micDeviceId
                      ? audioDevices.find((d) => d.id === settings.micDeviceId)?.name || "Custom Device"
                      : `Default (${audioDevices.find((d) => d.isDefault)?.name || "System Default"})`}
                  </span>
                </div>
                <p className="text-[10px] text-[#717d90]">
                  Tip: If your microphone isn't recording, check that Windows allows desktop apps in <span className="text-[#a1adb9]">Settings &gt; Privacy &amp; security &gt; Microphone</span>, or select your specific device above (e.g. WO Mic or Headset).
                </p>
              </div>
            </>
          )}
        </div>

        <div className="mt-3.5 flex flex-wrap gap-2 border-t border-[#232934] pt-3">
          <button
            type="button"
            onClick={onRestartEngine}
            className="rounded border border-blue-500/50 bg-blue-500/15 px-3 py-1.5 font-mono text-[11px] font-semibold tracking-wider text-blue-200 transition-colors hover:bg-blue-500/25"
          >
            APPLY & RESTART ENGINE
          </button>
          <button
            type="button"
            onClick={onSimulateDeviceLoss}
            className="rounded border border-[#2b3342] bg-[#14171e] px-3 py-1.5 font-mono text-[11px] text-[#8692a3] transition-colors hover:text-white"
          >
            SIMULATE DEVICE RESET
          </button>
        </div>
      </section>

      {/* ---------------- Adaptive Capture (ECO) ---------------- */}
      <section className="panel rounded-xl p-4">
        <h3 className="font-mono text-[11px] font-semibold tracking-wider text-[#9aa5b5]">
          ADAPTIVE CAPTURE (ECO)
        </h3>

        <div className="mt-2.5">
          <Row
            label="Automatic resource conservation"
            hint="Temporarily reduces buffer size when on low battery or under physical RAM pressure."
          >
            <Toggle
              on={settings.adaptiveEco}
              onClick={() => onChange({ adaptiveEco: !settings.adaptiveEco })}
            />
          </Row>

          {settings.adaptiveEco && (
            <>
              <Row
                label={`Battery trigger: ≤ ${settings.ecoBatteryThresholdPct}%`}
                hint="Triggers ECO mode when remaining battery falls to this level."
              >
                <input
                  type="range"
                  className="cf-range w-44"
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
                label={`RAM trigger: < ${settings.ecoRamFreeGbs} GiB free`}
                hint="Triggers ECO mode when system memory becomes constrained."
              >
                <input
                  type="range"
                  className="cf-range w-44"
                  min={1}
                  max={16}
                  step={1}
                  value={settings.ecoRamFreeGbs}
                  onChange={(e) => onChange({ ecoRamFreeGbs: Number(e.target.value) })}
                />
              </Row>

              <div className="mt-2 rounded-lg border border-[#232934] bg-[#14171e] px-3.5 py-2.5">
                <div className="flex items-center justify-between font-mono text-[10px] tracking-wider text-[#7e8b9d]">
                  <span>SYSTEM METRICS</span>
                  {power ? (
                    <span className={cn("font-medium", power.onBattery ? "text-amber-300" : "text-emerald-400")}>
                      {power.onBattery ? `Battery ${power.batteryPercent}%` : "AC Power"}
                    </span>
                  ) : (
                    <span>Reading sensors…</span>
                  )}
                </div>
                <div className="mt-1 font-mono text-[11px] text-[#e2e7ef]">
                  {power
                    ? `${formatBytes(power.availableRamBytes)} free of ${formatBytes(power.totalRamBytes)}`
                    : "—"}
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      {/* ---------------- Workflow Section ---------------- */}
      <section className="panel rounded-xl p-4">
        <h3 className="font-mono text-[11px] font-semibold tracking-wider text-[#9aa5b5]">
          WORKFLOW & SHORTCUTS
        </h3>

        <div className="mt-2.5">
          <Row label="Save replay hotkey" hint="Global shortcut that works inside full-screen games.">
            <HotkeyRecorder
              value={settings.hotkeySave}
              recording={recording === "save"}
              onStart={() => setRecording("save")}
            />
          </Row>

          <Row label="Arm / disarm hotkey" hint="Toggles continuous memory buffering on or off.">
            <HotkeyRecorder
              value={settings.hotkeyToggle}
              recording={recording === "toggle"}
              onStart={() => setRecording("toggle")}
            />
          </Row>

          <Row label="Open trimmer after saving" hint="Displays the quick-trim modal immediately upon saving.">
            <Toggle
              on={settings.openTrimmerAfterSave}
              onClick={() => onChange({ openTrimmerAfterSave: !settings.openTrimmerAfterSave })}
            />
          </Row>

          <Row label="Minimize to system tray" hint="Allows the application to run quietly in background.">
            <Toggle
              on={settings.minimizeToTray}
              onClick={() => onChange({ minimizeToTray: !settings.minimizeToTray })}
            />
          </Row>

          <Row label="Arm buffer on startup">
            <Toggle
              on={settings.autostartBuffer}
              onClick={() => onChange({ autostartBuffer: !settings.autostartBuffer })}
            />
          </Row>

          <Row label="Play sound on clip save" hint="Provides a quiet audio click when hotkey is triggered.">
            <Toggle
              on={settings.playSaveSound}
              onClick={() => onChange({ playSaveSound: !settings.playSaveSound })}
            />
          </Row>

          <Row label="Keep window on top" hint="Prevents the window from slipping behind game windows.">
            <Toggle
              on={settings.alwaysOnTop}
              onClick={() => onChange({ alwaysOnTop: !settings.alwaysOnTop })}
            />
          </Row>

          <Row label="Organize clips by game" hint="Groups saved clips into game-specific subfolders.">
            <Toggle
              on={settings.organizeByGame}
              onClick={() => onChange({ organizeByGame: !settings.organizeByGame })}
            />
          </Row>

          <Row label="Auto-save on game exit" hint="Flushes the last 30s buffer automatically when a game is closed.">
            <Toggle
              on={settings.autosaveOnGameExit}
              onClick={() => onChange({ autosaveOnGameExit: !settings.autosaveOnGameExit })}
            />
          </Row>

          <Row label="Show HUD overlay" hint="Compact always-on-top pill showing live recording status.">
            <Toggle
              on={settings.hudEnabled}
              onClick={() => onChange({ hudEnabled: !settings.hudEnabled })}
            />
          </Row>

          <Row label="Privacy mode" hint="Pauses capture and clears buffer when desktop or non-game apps have focus.">
            <Toggle
              on={settings.privacyPauseWhenUnfocused}
              onClick={() => onChange({ privacyPauseWhenUnfocused: !settings.privacyPauseWhenUnfocused })}
            />
          </Row>

          <Row label="Launch with Windows" hint="Starts ClipFlow minimized to tray on sign-in.">
            <Toggle
              on={settings.launchAtStartup}
              onClick={() => onChange({ launchAtStartup: !settings.launchAtStartup })}
            />
          </Row>

          <Row label="Automatic cleanup" hint="Removes clips older than threshold at startup.">
            <div className="flex gap-1">
              {CLEANUP_PRESETS.map((p) => (
                <button
                  key={p.days}
                  type="button"
                  onClick={() => onChange({ autoCleanupDays: p.days })}
                  className={cn(
                    "rounded border px-2.5 py-1 font-mono text-[11px] transition-colors",
                    settings.autoCleanupDays === p.days
                      ? "border-blue-500 bg-blue-600 text-white font-semibold"
                      : "border-[#2b3342] bg-[#14171e] text-[#8692a3] hover:text-white",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </Row>

          <Row label="Output directory" hint={settings.outputDir}>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={onOpenFolder}
                className="rounded border border-[#2b3342] bg-[#14171e] px-2.5 py-1 font-mono text-[11px] text-[#c3cddb] hover:text-white"
              >
                OPEN
              </button>
              <button
                type="button"
                onClick={onChooseFolder}
                className="rounded border border-[#2b3342] bg-[#14171e] px-2.5 py-1 font-mono text-[11px] text-[#c3cddb] hover:text-white"
              >
                CHANGE
              </button>
            </div>
          </Row>

          <Row label="Exit process" hint="Stops capture and closes ClipFlow completely.">
            <button
              type="button"
              onClick={() => void clipflow.quit()}
              className="rounded border border-red-500/40 bg-red-500/10 px-3 py-1 font-mono text-[11px] font-medium text-red-300 hover:border-red-400 hover:bg-red-500/20"
            >
              QUIT APPLICATION
            </button>
          </Row>
        </div>
      </section>

      {/* ---------------- About & System Information ---------------- */}
      <section className="panel rounded-xl p-4">
        <h3 className="font-mono text-[11px] font-semibold tracking-wider text-[#9aa5b5]">
          ABOUT & UPDATES
        </h3>

        <div className="mt-2.5">
          <Row label="Version" hint="Rust native core + Tauri v2 framework.">
            <span className="rounded border border-[#2b3342] bg-[#14171e] px-2.5 py-1 font-mono text-[11px] text-[#c3cddb]">
              v{version}
            </span>
          </Row>

          <Row label="Check for updates" hint="Verifies release integrity against official signed manifest.">
            <button
              type="button"
              onClick={onCheckForUpdates}
              className="rounded border border-blue-500/40 bg-blue-500/15 px-3 py-1 font-mono text-[11px] font-semibold text-blue-200 hover:bg-blue-500/25"
            >
              CHECK NOW
            </button>
          </Row>

          {updateProgress && (
            <div className="mt-3 space-y-1.5 rounded-lg border border-[#2b3342] bg-[#14171e] px-3 py-2">
              <div className="flex items-center justify-between font-mono text-[10px] text-[#8692a3]">
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
                <div className="h-1 overflow-hidden rounded-full bg-[#11141a]">
                  <div
                    className="h-full bg-blue-500 transition-all duration-200"
                    style={{
                      width: `${Math.min(100, (updateProgress.downloaded / updateProgress.total) * 100)}%`,
                    }}
                  />
                </div>
              )}
            </div>
          )}

          <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-[10px]">
            <div className="rounded border border-[#232934] bg-[#14171e] px-3 py-2">
              <div className="text-[#687383]">RUNTIME</div>
              <div className="mt-0.5 text-[#d4dae3]">
                {native ? "Tauri v2 · Rust · WebView2" : "Browser Preview"}
              </div>
            </div>
            <div className="rounded border border-[#232934] bg-[#14171e] px-3 py-2">
              <div className="text-[#687383]">PROCESS RSS</div>
              <div className="mt-0.5 text-[#d4dae3]">{formatBytes(stats.process_rss_bytes)}</div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- Privacy & Security ---------------- */}
      <section className="panel rounded-xl p-4">
        <h3 className="font-mono text-[11px] font-semibold tracking-wider text-[#9aa5b5]">
          PRIVACY & INTEGRITY
        </h3>
        <ul className="mt-2.5 space-y-2 text-[12px] leading-relaxed text-[#8692a3]">
          <li className="flex items-center gap-2">
            <span className="text-emerald-400">✓</span> Local-only: no user accounts, no cloud sync.
          </li>
          <li className="flex items-center gap-2">
            <span className="text-emerald-400">✓</span> Zero telemetry: no outbound analytical sockets.
          </li>
          <li className="flex items-center gap-2">
            <span className="text-emerald-400">✓</span> No background services or scheduled telemetry tasks.
          </li>
          <li className="flex items-center gap-2">
            <span className="text-emerald-400">✓</span> Self-contained portable binary with configuration stored in JSON.
          </li>
        </ul>
      </section>
    </div>
  );
}
