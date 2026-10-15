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
        "flex items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 transition-colors duration-150",
        active
          ? "border-blue-500/50 bg-[#16202e]"
          : "border-[#232934] bg-[#14171e] hover:border-[#313a49]",
      )}
    >
      <div className="min-w-0 pr-2">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-[#e2e7ef]">
            {profile.name}
          </span>
          {active && (
            <span className="rounded border border-blue-500/30 bg-blue-500/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-wider text-blue-300">
              ACTIVE
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-[#7d8a9c]">
          {profile.bufferSeconds >= 60
            ? `${profile.bufferSeconds / 60}m`
            : `${profile.bufferSeconds}s`}{" "}
          buffer · {profile.targetFps} fps · {(profile.bitrateKbps / 1000).toFixed(0)} Mb/s ·{" "}
          {profile.codec.toUpperCase()}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onApply}
          className={cn(
            "rounded border px-2.5 py-1 font-mono text-[10px] font-semibold tracking-wider transition-colors",
            active
              ? "border-blue-500/60 bg-blue-500/20 text-blue-200 hover:bg-blue-500/30"
              : "border-[#313a49] bg-[#1a202a] text-[#c3cddb] hover:border-blue-400 hover:text-white",
          )}
        >
          {active ? "RE-APPLY" : "APPLY"}
        </button>
        <button
          type="button"
          onClick={onEdit}
          title="Edit profile parameters"
          className="rounded border border-[#313a49] bg-[#1a202a] px-2 py-1 font-mono text-[10px] text-[#8d98a8] hover:border-[#424e63] hover:text-white"
        >
          EDIT
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={!canDelete}
          title="Delete profile"
          className="rounded border border-[#313a49] bg-[#1a202a] px-2 py-1 font-mono text-[10px] text-[#8d98a8] hover:border-red-400/50 hover:text-red-300 disabled:opacity-30"
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
    "rounded border border-[#2b3342] bg-[#11141a] px-2 py-1 font-mono text-[11px] text-[#e2e7ef] outline-none focus:border-blue-400";

  return (
    <div className="mt-2.5 rounded-lg border border-[#313a49] bg-[#171c24] p-3.5">
      <div className="flex items-center gap-2">
        <input
          name="profile-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Profile name (e.g. Competitive FPS)"
          className="flex-1 rounded border border-[#2b3342] bg-[#11141a] px-2.5 py-1.5 font-mono text-[12px] text-[#e2e7ef] outline-none placeholder:text-[#556172] focus:border-blue-400"
        />
        {profile.id && (
          <span className="shrink-0 font-mono text-[10px] text-[#6d798a]">
            {profile.id}
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-1.5 font-mono text-[10px] tracking-wider text-[#7e8b9d]">
          BUFFER
          <select
            name="profile-buffer"
            value={bufferSeconds}
            onChange={(e) => setBufferSeconds(Number(e.target.value))}
            className={selectCls}
          >
            {[15, 30, 60, 120, 300].map((s) => (
              <option key={s} value={s} className="bg-[#111318]">
                {s >= 60 ? `${s / 60}m` : `${s}s`}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1.5 font-mono text-[10px] tracking-wider text-[#7e8b9d]">
          FPS
          <select
            name="profile-fps"
            value={targetFps}
            onChange={(e) => setTargetFps(Number(e.target.value))}
            className={selectCls}
          >
            {[30, 60, 120, 144].map((f) => (
              <option key={f} value={f} className="bg-[#111318]">
                {f}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1.5 font-mono text-[10px] tracking-wider text-[#7e8b9d]">
          CODEC
          <select
            name="profile-codec"
            value={codec}
            onChange={(e) => setCodec(e.target.value as "h264" | "hevc")}
            className={selectCls}
          >
            <option value="h264" className="bg-[#111318]">H.264</option>
            <option value="hevc" className="bg-[#111318]">HEVC</option>
          </select>
        </label>

        <label className="flex items-center gap-2 font-mono text-[10px] tracking-wider text-[#7e8b9d]">
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

      <div className="mt-3.5 flex justify-end gap-2 border-t border-[#232934] pt-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-[#2b3342] px-3 py-1 font-mono text-[11px] text-[#8692a3] hover:text-white"
        >
          CANCEL
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!name.trim()}
          className="rounded border border-blue-500 bg-blue-600 px-3 py-1 font-mono text-[11px] font-semibold text-white hover:bg-blue-500 disabled:opacity-40"
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
    <div className="flex items-center gap-2">
      <input
        name="map-exe"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitExe}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        placeholder="game.exe"
        className="w-32 rounded border border-[#2b3342] bg-[#11141a] px-2.5 py-1.5 font-mono text-[11px] text-[#e2e7ef] outline-none placeholder:text-[#556172] focus:border-blue-400"
      />
      <span className="text-[#556172]">→</span>
      <select
        name="map-profile"
        value={entry.profileId}
        onChange={(e) => {
          const exe = draft.trim().toLowerCase();
          onChange(index, { profileId: e.target.value, ...(exe ? { exeName: exe } : {}) });
        }}
        className="min-w-0 flex-1 rounded border border-[#2b3342] bg-[#11141a] px-2.5 py-1.5 font-mono text-[11px] text-[#e2e7ef] outline-none focus:border-blue-400"
      >
        {profiles.map((p) => (
          <option key={p.id} value={p.id} className="bg-[#111318]">
            {p.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => onRemove(index)}
        title="Remove mapping"
        className="rounded border border-[#2b3342] bg-[#1a202a] px-2 py-1.5 font-mono text-[11px] text-[#8692a3] hover:border-red-400/50 hover:text-red-300"
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
    <section className="panel rounded-xl p-4">
      <h3 className="font-mono text-[11px] font-semibold tracking-wider text-[#9aa5b5]">
        CAPTURE PROFILES
      </h3>
      <p className="mt-1 text-[12px] leading-relaxed text-[#7e8b9d]">
        Configure presets for different games. Changes to buffer size apply live; frame rate,
        bitrate, and codec apply on the next engine start.
      </p>

      <div className="mt-3 border-t border-[#232934]">
        <Row
          label="Auto-switch by focused game"
          hint="Automatically applies the mapped preset when a matching game is detected."
        >
          <Toggle
            on={settings.autoSwitchProfiles}
            onClick={() => onChange({ autoSwitchProfiles: !settings.autoSwitchProfiles })}
          />
        </Row>

        <Row
          label="Foreground window"
          hint={foreground ? foreground.title : "Desktop or unmapped window"}
        >
          <div className="flex items-center gap-2">
            <span className="rounded border border-[#2f3846] bg-[#14171e] px-2 py-1 font-mono text-[11px] text-[#c3cddb]">
              {foreground ? foreground.exe : "—"}
            </span>
            <button
              type="button"
              onClick={onRefreshForeground}
              title="Re-check the focused window now"
              className="rounded border border-[#2f3846] bg-[#14171e] px-2 py-1 font-mono text-[10px] text-[#8692a3] hover:text-white"
            >
              DETECT
            </button>
          </div>
        </Row>
      </div>

      <div className="mt-3.5 space-y-2">
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
        type="button"
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
        className="mt-3 w-full rounded-lg border border-[#2f3846] bg-[#14171e] px-3 py-2 font-mono text-[11px] font-medium tracking-wider text-[#c3cddb] transition-colors hover:border-blue-400/50 hover:bg-[#1a202a] hover:text-white"
      >
        + NEW PRESET
      </button>

      <div className="mt-5 border-t border-[#232934] pt-3.5">
        <div className="font-mono text-[10px] font-medium uppercase tracking-wider text-[#7e8b9d]">
          GAME DETECTION MAPPINGS
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-[#717d8e]">
          Map an executable file name (e.g. <span className="font-mono text-[#b5c0d0]">cs2.exe</span>) to
          a profile preset.
        </p>

        <div className="mt-3 space-y-2">
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
            type="button"
            onClick={addMapRow}
            className="w-full rounded border border-[#28313e] bg-[#14171e] px-3 py-1.5 font-mono text-[11px] text-[#8692a3] hover:border-[#384457] hover:text-white"
          >
            + ADD GAME MAPPING
          </button>
        </div>
      </div>
    </section>
  );
}
