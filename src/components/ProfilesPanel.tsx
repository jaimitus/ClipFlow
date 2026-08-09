import { useEffect, useState } from "react";
import type {
  AppSettings,
  CaptureProfile,
  ForegroundGame,
  ProfileMapEntry,
} from "../lib/types";
import { cn } from "../utils/cn";
import { Row, Toggle } from "./ui";

interface Props {
  settings: AppSettings;
  foreground: ForegroundGame | null;
  activeProfileId: string | null;
  onChange: (patch: Partial<AppSettings>) => void;
  onApplyProfile: (profileId: string) => void;
  /** Resolves true when the profile was persisted successfully. */
  onSaveProfile: (profile: CaptureProfile) => Promise<boolean>;
  onDeleteProfile: (profileId: string) => void;
  onSetProfileMap: (map: ProfileMapEntry[]) => void;
  onRefreshForeground: () => void;
}

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
            {[15, 30, 60, 120, 300].map((s) => (
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
            {[30, 60, 120, 144].map((f) => (
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

export default function ProfilesPanel({
  settings,
  foreground,
  activeProfileId,
  onChange,
  onApplyProfile,
  onSaveProfile,
  onDeleteProfile,
  onSetProfileMap,
  onRefreshForeground,
}: Props) {
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

  return (
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
  );
}
