import { useEffect, useRef, useState } from "react";
import { clipflow } from "../lib/bridge";
import type {
  AppSettings,
  CaptureProfile,
  EngineStats,
  ForegroundGame,
  MonitorInfo,
  ProfileMapEntry,
  UpdateProgress,
} from "../lib/types";
import { formatBytes } from "../lib/format";
import { cn } from "../utils/cn";

interface Props {
  settings: AppSettings;
  stats: EngineStats;
  monitors: MonitorInfo[];
  version: string;
  onChange: (patch: Partial<AppSettings>) => void;
  onRestartEngine: () => void;
  onOpenFolder: () => void;
  onChooseFolder: () => void;
  foreground: ForegroundGame | null;
  activeProfileId: string | null;
  onApplyProfile: (profileId: string) => void;
  /** Resolves true when the profile was persisted successfully. */
  onSaveProfile: (profile: CaptureProfile) => Promise<boolean>;
  onDeleteProfile: (profileId: string) => void;
  onSetProfileMap: (map: ProfileMapEntry[]) => void;
  onRefreshForeground: () => void;
  updateProgress?: UpdateProgress | null;
  onCheckForUpdates: () => void;
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
const PROFILE_BUFFER_PRESETS = [15, 30, 60, 120, 300];
const PROFILE_FPS_PRESETS = [30, 60, 120, 144];

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** One profile row: name, summary, APPLY / EDIT / DELETE. */
function ProfileCard({
  profile,
  active,
  canDelete,
  onApply,
  onEdit,
  onDelete,
}: {
  profile: CaptureProfile;
  active: boolean;
  canDelete: boolean;
  onApply: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 transition",
        active
          ? "border-lime-300/50 bg-lime-400/10"
          : "border-white/8 bg-black/25 hover:border-white/20",
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-slate-100">
            {profile.name}
          </span>
          {active && (
            <span className="rounded border border-lime-300/50 bg-lime-400/15 px-1.5 py-0.5 font-mono text-[9px] tracking-[0.14em] text-lime-200">
              ACTIVE
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate font-mono text-[10px] text-slate-500">
          {profile.bufferSeconds >= 60
            ? `${profile.bufferSeconds / 60}m`
            : `${profile.bufferSeconds}s`}{" "}
          buffer · {profile.targetFps} fps · {(profile.bitrateKbps / 1000).toFixed(0)} Mb/s ·{" "}
          {profile.codec.toUpperCase()}
        </div>
      </div>
      <div className="flex shrink-0 gap-1.5">
        <button
          onClick={onApply}
          className="rounded-md border border-lime-300/40 bg-lime-400/10 px-2.5 py-1 font-mono text-[10px] tracking-[0.12em] text-lime-100 transition hover:bg-lime-400/20"
        >
          {active ? "RE-APPLY" : "APPLY"}
        </button>
        <button
          onClick={onEdit}
          title="Edit profile"
          className="rounded-md border border-white/10 px-2 py-1 font-mono text-[10px] text-slate-300 transition hover:border-white/30 hover:text-slate-100"
        >
          EDIT
        </button>
        <button
          onClick={onDelete}
          disabled={!canDelete}
          title="Delete profile"
          className="rounded-md border border-rose-500/30 px-2 py-1 font-mono text-[10px] text-rose-300/90 transition hover:border-rose-400/60 hover:bg-rose-500/10 disabled:opacity-30"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/** Create / edit form for one profile. */
function ProfileEditor({
  profile,
  onSave,
  onCancel,
}: {
  profile: CaptureProfile;
  onSave: (p: CaptureProfile) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(profile.name);
  const [bufferSeconds, setBufferSeconds] = useState(profile.bufferSeconds || 60);
  const [targetFps, setTargetFps] = useState(profile.targetFps || 60);
  const [bitrateKbps, setBitrateKbps] = useState(profile.bitrateKbps || 12_000);
  const [codec, setCodec] = useState<"h264" | "hevc">(profile.codec || "h264");

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave({
      id: profile.id || slugify(trimmed) || `profile-${Date.now()}`,
      name: trimmed,
      bufferSeconds,
      targetFps,
      bitrateKbps,
      codec,
    });
  };

  const selectCls =
    "rounded-md border border-white/10 bg-black/50 px-2 py-1 font-mono text-[11px] text-slate-200 outline-none focus:border-lime-300/50";

  return (
    <div className="mt-2 rounded-xl border border-lime-300/25 bg-lime-400/5 p-3">
      <div className="flex items-center gap-2">
        <input
          name="profile-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Profile name"
          className="flex-1 rounded-md border border-white/10 bg-black/50 px-2.5 py-1.5 font-mono text-[12px] text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-lime-300/50"
        />
        {profile.id && (
          <span className="shrink-0 font-mono text-[9px] tracking-[0.12em] text-slate-600">
            {profile.id}
          </span>
        )}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.12em] text-slate-500">
          BUFFER
          <select
            name="profile-buffer"
            value={bufferSeconds}
            onChange={(e) => setBufferSeconds(Number(e.target.value))}
            className={selectCls}
          >
            {PROFILE_BUFFER_PRESETS.map((s) => (
              <option key={s} value={s} className="bg-[#0a0d1a]">
                {s >= 60 ? `${s / 60}m` : `${s}s`}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.12em] text-slate-500">
          FPS
          <select
            name="profile-fps"
            value={targetFps}
            onChange={(e) => setTargetFps(Number(e.target.value))}
            className={selectCls}
          >
            {PROFILE_FPS_PRESETS.map((f) => (
              <option key={f} value={f} className="bg-[#0a0d1a]">
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.12em] text-slate-500">
          CODEC
          <select
            name="profile-codec"
            value={codec}
            onChange={(e) => setCodec(e.target.value as "h264" | "hevc")}
            className={selectCls}
          >
            <option value="h264" className="bg-[#0a0d1a]">H.264</option>
            <option value="hevc" className="bg-[#0a0d1a]">HEVC</option>
          </select>
        </label>
        <label className="flex items-center gap-2 font-mono text-[10px] tracking-[0.12em] text-slate-500">
          <span className="w-14">{(bitrateKbps / 1000).toFixed(0)} Mb/s</span>
          <input
            type="range"
            className="cf-range w-28"
            min={3000}
            max={60000}
            step={1000}
            value={bitrateKbps}
            onChange={(e) => setBitrateKbps(Number(e.target.value))}
          />
        </label>
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-lg border border-white/10 px-3 py-1.5 font-mono text-[11px] tracking-[0.14em] text-slate-300 transition hover:border-white/30 hover:text-slate-100"
        >
          CANCEL
        </button>
        <button
          onClick={save}
          disabled={!name.trim()}
          className="rounded-lg border border-lime-300/50 bg-lime-400/15 px-3 py-1.5 font-mono text-[11px] font-semibold tracking-[0.14em] text-lime-100 transition hover:bg-lime-400/25 disabled:opacity-40"
        >
          SAVE PROFILE
        </button>
      </div>
    </div>
  );
}

/** One game→profile mapping row. Commits on blur / Enter / select change. */
function MapRow({
  entry,
  index,
  profiles,
  onChange,
  onRemove,
}: {
  entry: ProfileMapEntry;
  index: number;
  profiles: CaptureProfile[];
  onChange: (index: number, patch: Partial<ProfileMapEntry>) => void;
  onRemove: (index: number) => void;
}) {
  const [draft, setDraft] = useState(entry.exeName);
  useEffect(() => setDraft(entry.exeName), [entry.exeName]);

  const commitExe = () => {
    const exe = draft.trim().toLowerCase();
    if (!exe) return;
    onChange(index, { exeName: exe });
  };

  return (
    <div className="flex items-center gap-1.5">
      <input
        name="map-exe"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitExe}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        placeholder="game.exe"
        className="w-28 rounded-md border border-white/10 bg-black/50 px-2.5 py-1.5 font-mono text-[11px] text-slate-200 outline-none transition placeholder:text-slate-600 focus:border-lime-300/50"
      />
      <span className="text-slate-600">→</span>
      <select
        name="map-profile"
        value={entry.profileId}
        onChange={(e) => {
          const exe = draft.trim().toLowerCase();
          onChange(index, { profileId: e.target.value, ...(exe ? { exeName: exe } : {}) });
        }}
        className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/50 px-2.5 py-1.5 font-mono text-[11px] text-slate-200 outline-none focus:border-lime-300/50"
      >
        {profiles.map((p) => (
          <option key={p.id} value={p.id} className="bg-[#0a0d1a]">
            {p.name}
          </option>
        ))}
      </select>
      <button
        onClick={() => onRemove(index)}
        title="Remove mapping"
        className="rounded-md border border-rose-500/30 px-2 py-1.5 font-mono text-[11px] text-rose-300/90 transition hover:border-rose-400/60 hover:bg-rose-500/10"
      >
        ✕
      </button>
    </div>
  );
}

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
  onChange,
  onRestartEngine,
  onOpenFolder,
  onChooseFolder,
  foreground,
  activeProfileId,
  onApplyProfile,
  onSaveProfile,
  onDeleteProfile,
  onSetProfileMap,
  onRefreshForeground,
  updateProgress,
  onCheckForUpdates,
  onSimulateDeviceLoss,
  native,
}: Props) {
  const [bitrate, setBitrate] = useState(settings.bitrateKbps);
  const [recording, setRecording] = useState<"save" | "toggle" | null>(null);
  const [editing, setEditing] = useState<CaptureProfile | null>(null);

  const commitMap = (index: number, patch: Partial<ProfileMapEntry>) => {
    const map = settings.profileMap.map((m, i) => (i === index ? { ...m, ...patch } : m));
    onSetProfileMap(map);
  };
  const removeMapRow = (index: number) => {
    onSetProfileMap(settings.profileMap.filter((_, i) => i !== index));
  };
  const addMapRow = () => {
    const firstId = settings.profiles[0]?.id ?? "default";
    onSetProfileMap([...settings.profileMap, { profileId: firstId, exeName: "" }]);
  };

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
        <h3 className="font-mono text-[11px] tracking-[0.24em] text-lime-300">
          CAPTURE PROFILES
        </h3>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
          Like Spotify playlists: make a few generic profiles and map the games
          that matter to them — everything else uses <span className="text-slate-300">Default</span>.
          Applying a profile changes the buffer live; fps, bitrate and codec apply
          on the next engine start.
        </p>

        <Row
          label="Auto-switch by foreground game"
          hint="ClipFlow watches which window has focus and applies the mapped profile. Unmapped games and the desktop fall back to Default."
        >
          <Toggle
            on={settings.autoSwitchProfiles}
            onClick={() => onChange({ autoSwitchProfiles: !settings.autoSwitchProfiles })}
          />
        </Row>

        <Row
          label="Detected foreground"
          hint={foreground ? `${foreground.title}` : "Desktop or unknown window — Default applies."}
        >
          <div className="flex items-center gap-1.5">
            <span className="rounded-md border border-cyan-300/30 bg-cyan-400/10 px-2.5 py-1.5 font-mono text-[11px] tracking-[0.1em] text-cyan-100">
              {foreground ? foreground.exe : "—"}
            </span>
            <button
              onClick={onRefreshForeground}
              title="Re-check the focused window now"
              className="rounded-md border border-white/10 px-2 py-1.5 font-mono text-[10px] tracking-[0.12em] text-slate-300 transition hover:border-white/30 hover:text-slate-100"
            >
              REFRESH
            </button>
          </div>
        </Row>

        <div className="mt-3 space-y-2">
          {settings.profiles.map((p) => (
            <ProfileCard
              key={p.id}
              profile={p}
              active={activeProfileId === p.id}
              canDelete={settings.profiles.length > 1}
              onApply={() => onApplyProfile(p.id)}
              onEdit={() => setEditing({ ...p })}
              onDelete={() => onDeleteProfile(p.id)}
            />
          ))}
        </div>

        {editing && (
          <ProfileEditor
            profile={editing}
            onSave={async (p) => {
              const ok = await onSaveProfile(p);
              if (ok) setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        )}

        <button
          onClick={() =>
            setEditing({
              id: "",
              name: "",
              bufferSeconds: 60,
              targetFps: 60,
              bitrateKbps: 12_000,
              codec: "h264",
            })
          }
          className="mt-2 w-full rounded-lg border border-lime-300/40 bg-lime-400/10 px-3 py-2 font-mono text-[11px] tracking-[0.16em] text-lime-100 transition hover:bg-lime-400/20"
        >
          + NEW PROFILE
        </button>

        <div className="mt-4 border-t border-white/5 pt-3">
          <div className="font-mono text-[10px] tracking-[0.2em] text-slate-500">
            GAME MAPPINGS
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
            Map a foreground executable (e.g. <span className="font-mono text-slate-400">cs2.exe</span>) to
            a profile. The exe name is shown by the Detected row above — type it
            as-is, lowercase.
          </p>
          <div className="mt-2 space-y-2">
            {settings.profileMap.map((m, i) => (
              <MapRow
                key={`${m.exeName}-${i}`}
                entry={m}
                index={i}
                profiles={settings.profiles}
                onChange={commitMap}
                onRemove={removeMapRow}
              />
            ))}
            <button
              onClick={addMapRow}
              className="w-full rounded-lg border border-white/10 px-3 py-2 font-mono text-[11px] tracking-[0.16em] text-slate-300 transition hover:border-lime-300/40 hover:text-lime-200"
            >
              + ADD MAPPING
            </button>
          </div>
        </div>
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
