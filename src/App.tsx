import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BufferStatusCard from "./components/BufferStatusCard";
import ClipTrimmerModal from "./components/ClipTrimmerModal";
import GalleryGrid from "./components/GalleryGrid";
import SettingsPanel from "./components/SettingsPanel";
import TitleBar from "./components/TitleBar";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { DEFAULT_SETTINGS, clipflow } from "./lib/bridge";
import { formatBytes, formatDuration } from "./lib/format";
import { playSaveSound } from "./lib/sound";
import type {
  AppSettings,
  ClipMetadata,
  ClipSavedPayload,
  EngineStats,
  MonitorInfo,
} from "./lib/types";
import { cn } from "./utils/cn";

const APP_VERSION = "1.1.0";

const IDLE_STATS: EngineStats = {
  state: "idle",
  encoder: {
    vendor: "unavailable",
    friendly_name: "Not initialised",
    codec: "H.264",
    hardware: false,
    adapter_name: "—",
    dedicated_vram_mb: 0,
  },
  width: 0,
  height: 0,
  target_fps: 60,
  capture_fps: 0,
  buffer_seconds: 60,
  buffered_seconds: 0,
  ring_bytes: 0,
  ring_frames: 0,
  process_rss_bytes: 17 * 1024 * 1024,
  encode_ms_avg: 0,
  gpu_submit_ms_avg: 0,
  dropped_frames: 0,
  device_resets: 0,
  audio_system: true,
  audio_mic: false,
  audio_drift_ms: 0,
  uptime_seconds: 0,
  last_error: null,
};

type ToastTone = "ok" | "warn" | "err" | "info";
interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
}

const TONE_STYLES: Record<ToastTone, string> = {
  ok: "border-lime-400/40 bg-lime-400/10 text-lime-100",
  warn: "border-amber-400/40 bg-amber-400/10 text-amber-100",
  err: "border-rose-500/40 bg-rose-500/10 text-rose-100",
  info: "border-cyan-300/40 bg-cyan-400/10 text-cyan-100",
};

type SortKey = "newest" | "oldest" | "largest" | "smallest" | "longest" | "shortest";

export default function App() {
  const [stats, setStats] = useState<EngineStats>(IDLE_STATS);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [clips, setClips] = useState<ClipMetadata[]>([]);
  const [loadingClips, setLoadingClips] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"library" | "settings">("library");
  const [activeClip, setActiveClip] = useState<ClipMetadata | null>(null);
  const [activeFlushMs, setActiveFlushMs] = useState<number | undefined>(undefined);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [flushHistory, setFlushHistory] = useState<number[]>([]);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("newest");
  const [audioOnly, setAudioOnly] = useState(false);
  const [compact, setCompact] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [onboarding, setOnboarding] = useState<boolean>(() => {
    try {
      return localStorage.getItem("clipflow.onboarding.seen") !== "1";
    } catch {
      return false;
    }
  });

  const native = clipflow.isTauri();
  const toastId = useRef(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const pushToast = useCallback((tone: ToastTone, title: string, body?: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, tone, title, body }].slice(-4));
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const refreshClips = useCallback(async () => {
    try {
      const list = await clipflow.getClips(true);
      setClips(list);
    } catch (e) {
      pushToast("err", "Could not read clips folder", String(e));
    } finally {
      setLoadingClips(false);
    }
  }, [pushToast]);

  // ------------------------------------------------------------- bootstrap
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, st, mons] = await Promise.all([
          clipflow.getSettings(),
          clipflow.getStats(),
          clipflow.getMonitors(),
        ]);
        if (cancelled) return;
        setSettings(s);
        setStats(st);
        setMonitors(mons);
      } catch {
        /* keep defaults */
      }
      await refreshClips();

      // Silent auto-update probe (native only): no toast unless a newer
      // GitHub release actually exists. Never blocks startup.
      if (clipflow.isTauri()) {
        try {
          const update = await check();
          if (update && !cancelled) {
            pushToast(
              "info",
              `Update v${update.version} available`,
              "Open Settings → About & Updates → CHECK FOR UPDATES to install.",
            );
          }
        } catch {
          /* updater unreachable — ignore */
        }
      }

      // In the browser the Rust autostart does not exist — arm the simulated
      // engine so the deck is alive immediately.
      if (!clipflow.isTauri()) {
        try {
          const st = await clipflow.startBuffer(
            DEFAULT_SETTINGS.bufferSeconds,
            DEFAULT_SETTINGS.targetFps,
          );
          if (!cancelled) setStats(st);
        } catch {
          /* ignore */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshClips]);

  // -------------------------------------------------------------- events
  useEffect(() => {
    const offs: Array<() => void> = [];
    let disposed = false;
    const attach = (p: Promise<() => void>) => {
      void p.then((off) => {
        if (disposed) off();
        else offs.push(off);
      });
    };

    attach(Promise.resolve(clipflow.onStats((s) => setStats(s))));
    attach(Promise.resolve(clipflow.onBufferState((s) => setStats(s))));
    attach(
      Promise.resolve(
        clipflow.onClipSaved((payload: ClipSavedPayload) => {
          setClips((prev) => [payload.clip, ...prev.filter((c) => c.path !== payload.clip.path)]);
          setFlushHistory((h) => [...h.slice(-19), payload.flushMs]);
          if (settingsRef.current.playSaveSound) playSaveSound();
          pushToast(
            "ok",
            `Clip saved in ${payload.flushMs.toFixed(1)} ms`,
            `${payload.clip.file_name} · ${formatDuration(payload.clip.duration_seconds)} · ${formatBytes(
              payload.clip.size_bytes,
            )}`,
          );
          if (settingsRef.current.openTrimmerAfterSave) {
            setActiveClip(payload.clip);
            setActiveFlushMs(payload.flushMs);
          }
        }),
      ),
    );
    attach(
      Promise.resolve(clipflow.onError((msg) => pushToast("err", "Engine error", String(msg)))),
    );
    attach(
      Promise.resolve(
        clipflow.onHotkey((accel) => pushToast("info", `${accel} triggered`)),
      ),
    );

    return () => {
      disposed = true;
      offs.forEach((off) => off());
    };
  }, [pushToast]);

  // ------------------------------------------------------------- actions
  const handleSave = useCallback(
    async (maxSeconds?: number) => {
      setBusy(true);
      try {
        const clip = await clipflow.saveInstantReplay(maxSeconds, "ui");
        if (!native) return; // the sim already emitted clip-saved
        setClips((prev) => [clip, ...prev.filter((c) => c.path !== clip.path)]);
        if (settingsRef.current.openTrimmerAfterSave) setActiveClip(clip);
      } catch (e) {
        pushToast("err", "Save failed", String(e));
      } finally {
        setBusy(false);
      }
    },
    [native, pushToast],
  );

  const handleToggle = useCallback(async () => {
    setBusy(true);
    try {
      const armed = stats.state === "buffering" || stats.state === "flushing";
      const next = armed
        ? await clipflow.stopBuffer()
        : await clipflow.startBuffer(settings.bufferSeconds, settings.targetFps);
      setStats(next);
      pushToast(armed ? "warn" : "ok", armed ? "Buffer disarmed" : "Buffer armed", 
        armed ? "Rolling history released from RAM." : `${settings.bufferSeconds}s rolling window is live.`);
    } catch (e) {
      pushToast("err", "Engine failed to start", String(e));
    } finally {
      setBusy(false);
    }
  }, [stats.state, settings.bufferSeconds, settings.targetFps, pushToast]);

  // Browser shim for the global hotkey (Tauri registers the real one in Rust).
  useEffect(() => {
    if (clipflow.isTauri()) return;
    const save = settings.hotkeySave.split("+").map((s) => s.trim().toLowerCase());
    const toggle = settings.hotkeyToggle.split("+").map((s) => s.trim().toLowerCase());
    const onKey = (e: KeyboardEvent) => {
      if (clipflow.isTauri()) return;
      const pressed = (k: string[]) =>
        k.length >= 2 &&
        k.includes("alt") === e.altKey &&
        k.includes("ctrl") === e.ctrlKey &&
        k.includes("shift") === e.shiftKey &&
        k.includes("win") === e.metaKey &&
        k.some((t) => e.key.toLowerCase() === t || e.code.toLowerCase() === t);
      if (pressed(save)) {
        e.preventDefault();
        clipflow.emitLocalHotkey(settings.hotkeySave);
        void handleSave();
      } else if (pressed(toggle)) {
        e.preventDefault();
        clipflow.emitLocalHotkey(settings.hotkeyToggle);
        void handleToggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleSave, handleToggle, settings.hotkeySave, settings.hotkeyToggle]);

  const patchSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      try {
        const next = await clipflow.updateSettings(patch);
        setSettings(next);
        if (patch.bufferSeconds) await clipflow.setBufferSeconds(patch.bufferSeconds);
      } catch (e) {
        pushToast("err", "Could not persist settings", String(e));
      }
    },
    [pushToast],
  );

  const checkForUpdates = useCallback(async () => {
    if (!native) {
      // Browser preview has no updater — fall back to the Releases page.
      await clipflow.openReleasesPage();
      return;
    }
    setBusy(true);
    try {
      const update = await check();
      if (!update) {
        pushToast("ok", "Up to date", `ClipFlow v${APP_VERSION} is the latest release.`);
        return;
      }
      pushToast(
        "info",
        `Update v${update.version} available`,
        "Downloading & installing — ClipFlow will restart.",
      );
      await update.downloadAndInstall();
      pushToast("ok", "Update installed", "Restarting ClipFlow…");
      await relaunch();
    } catch (e) {
      pushToast("err", "Update check failed", String(e));
    } finally {
      setBusy(false);
    }
  }, [native, pushToast]);

  const restartEngine = useCallback(async () => {
    setBusy(true);
    try {
      await clipflow.stopBuffer();
      const next = await clipflow.startBuffer(settings.bufferSeconds, settings.targetFps);
      setStats(next);
      pushToast("ok", "Engine restarted", `${next.encoder.friendly_name}`);
    } catch (e) {
      pushToast("err", "Restart failed", String(e));
    } finally {
      setBusy(false);
    }
  }, [settings.bufferSeconds, settings.targetFps, pushToast]);

  const copyClip = useCallback(
    async (clip: ClipMetadata) => {
      try {
        await clipflow.copyClip(clip.path);
        pushToast(
          "ok",
          native ? "Video copied to clipboard" : "Path copied",
          native ? "Paste it straight into Discord or Explorer." : clip.path,
        );
      } catch (e) {
        pushToast("err", "Clipboard failed", String(e));
      }
    },
    [native, pushToast],
  );

  const revealClip = useCallback(
    async (clip: ClipMetadata) => {
      try {
        await clipflow.revealClip(clip.path);
        if (!native) pushToast("info", "Path copied", clip.path);
      } catch (e) {
        pushToast("err", "Could not open Explorer", String(e));
      }
    },
    [native, pushToast],
  );

  const deleteClip = useCallback(
    async (clip: ClipMetadata) => {
      try {
        await clipflow.deleteClip(clip.path);
        setClips((prev) => prev.filter((c) => c.path !== clip.path));
        if (activeClip?.path === clip.path) setActiveClip(null);
        pushToast("warn", "Clip deleted", clip.file_name);
      } catch (e) {
        pushToast("err", "Delete failed", String(e));
      }
    },
    [activeClip, pushToast],
  );

  const saveTrimmed = useCallback(
    async (start: number, end: number) => {
      if (!activeClip) return;
      setBusy(true);
      try {
        const result = await clipflow.trimClip(activeClip.path, start, end, false);
        pushToast(
          "ok",
          `Trimmed in ${result.elapsed_ms.toFixed(0)} ms`,
          `${result.file_name} · ${formatDuration(result.duration_seconds)} · stream copy`,
        );
        setActiveClip(null);
        await refreshClips();
      } catch (e) {
        pushToast("err", "Trim failed", String(e));
      } finally {
        setBusy(false);
      }
    },
    [activeClip, pushToast, refreshClips],
  );

  const renameClip = useCallback(
    async (clip: ClipMetadata, newName: string) => {
      if (!newName.trim() || newName.trim() === clip.file_name) return;
      try {
        const path = await clipflow.renameClip(clip.path, newName.trim());
        const file_name = path.split(/[\\/]/).pop() ?? newName.trim();
        setActiveClip((c) =>
          c?.path === clip.path
            ? {
                ...c,
                path,
                file_name,
                title: file_name.replace(/\.mp4$/i, "").replace(/_/g, " "),
              }
            : c,
        );
        await refreshClips();
        pushToast("ok", "Clip renamed", file_name);
      } catch (e) {
        pushToast("err", "Rename failed", String(e));
      }
    },
    [pushToast, refreshClips],
  );

  const openExternalClip = useCallback(
    async (clip: ClipMetadata) => {
      try {
        await clipflow.openClip(clip.path);
        if (!native) pushToast("info", "No external player in browser preview", clip.path);
      } catch (e) {
        pushToast("err", "Could not open clip", String(e));
      }
    },
    [native, pushToast],
  );

  const snapshotClip = useCallback(
    async (clip: ClipMetadata, pngBase64: string) => {
      try {
        const base = clip.file_name.replace(/\.mp4$/i, "").replace(/_/g, " ");
        const path = await clipflow.snapshotToOutput(pngBase64, base);
        pushToast(
          "ok",
          "Frame saved as PNG",
          native ? path : "Snapshot downloaded",
        );
      } catch (e) {
        pushToast("err", "Snapshot failed", String(e));
      }
    },
    [native, pushToast],
  );

  const clearLibrary = useCallback(async () => {
    setConfirmClear(false);
    setBusy(true);
    try {
      const deleted = await clipflow.deleteAllClips();
      await refreshClips();
      if (activeClip) setActiveClip(null);
      pushToast(
        "warn",
        deleted > 0 ? `Deleted ${deleted} clip${deleted === 1 ? "" : "s"}` : "Library is already empty",
      );
    } catch (e) {
      pushToast("err", "Could not clear library", String(e));
    } finally {
      setBusy(false);
    }
  }, [activeClip, pushToast, refreshClips]);

  // ---------------------------------------------------------------- derived
  const armed = stats.state === "buffering" || stats.state === "flushing";
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = clips.filter((c) => {
      const matchesQuery =
        !q || c.title.toLowerCase().includes(q) || c.file_name.toLowerCase().includes(q);
      const matchesAudio = !audioOnly || c.has_audio;
      return matchesQuery && matchesAudio;
    });
    const sorted = [...list];
    switch (sortKey) {
      case "oldest":
        sorted.sort((a, b) => a.created_unix_ms - b.created_unix_ms);
        break;
      case "largest":
        sorted.sort((a, b) => b.size_bytes - a.size_bytes);
        break;
      case "smallest":
        sorted.sort((a, b) => a.size_bytes - b.size_bytes);
        break;
      case "longest":
        sorted.sort((a, b) => b.duration_seconds - a.duration_seconds);
        break;
      case "shortest":
        sorted.sort((a, b) => a.duration_seconds - b.duration_seconds);
        break;
      default:
        sorted.sort((a, b) => b.created_unix_ms - a.created_unix_ms);
    }
    return sorted;
  }, [clips, query, audioOnly, sortKey]);

  const totalBytes = useMemo(
    () => clips.reduce((acc, c) => acc + c.size_bytes, 0),
    [clips],
  );

  const flushStats = useMemo(() => {
    const h = flushHistory;
    if (h.length === 0) return null;
    const avg = h.reduce((a, b) => a + b, 0) / h.length;
    return {
      last: h[h.length - 1],
      avg,
      best: Math.min(...h),
    };
  }, [flushHistory]);

  return (
    <div className="bg-aurora relative flex h-screen w-screen flex-col overflow-hidden bg-[#05060d]">
      <div className="bg-grid pointer-events-none absolute inset-0 opacity-60" />

      <TitleBar armed={armed} native={native} version={APP_VERSION} />

      <main className="relative z-10 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-[1400px] gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_380px]">
          {/* -------------------------------------------------- main column */}
          <div className="space-y-5">
            <BufferStatusCard
              stats={stats}
              hotkey={settings.hotkeySave}
              busy={busy}
              onToggle={handleToggle}
              onSave={() => void handleSave()}
            />

            <section className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <h2 className="font-mono text-[12px] tracking-[0.28em] text-slate-300">
                    CLIP LIBRARY
                  </h2>
                  <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[10px] text-slate-500">
                    {clips.length} clips · {formatBytes(totalBytes)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    name="clip-filter"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filter clips…"
                    className="w-40 rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 font-mono text-[11px] text-slate-200 outline-none transition placeholder:text-slate-600 focus:border-cyan-300/50"
                  />
                  <select
                    value={sortKey}
                    onChange={(e) => setSortKey(e.target.value as SortKey)}
                    title="Sort clips"
                    className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 font-mono text-[11px] text-slate-300 outline-none transition hover:border-white/25 focus:border-cyan-300/50"
                  >
                    <option value="newest" className="bg-[#0a0d1a]">NEWEST</option>
                    <option value="oldest" className="bg-[#0a0d1a]">OLDEST</option>
                    <option value="largest" className="bg-[#0a0d1a]">LARGEST</option>
                    <option value="smallest" className="bg-[#0a0d1a]">SMALLEST</option>
                    <option value="longest" className="bg-[#0a0d1a]">LONGEST</option>
                    <option value="shortest" className="bg-[#0a0d1a]">SHORTEST</option>
                  </select>
                  <button
                    onClick={() => setAudioOnly((v) => !v)}
                    title="Only clips with audio"
                    className={cn(
                      "rounded-lg border px-2.5 py-1.5 font-mono text-[11px] tracking-[0.12em] transition",
                      audioOnly
                        ? "border-lime-300/60 bg-lime-400/15 text-lime-100"
                        : "border-white/10 text-slate-400 hover:border-white/25 hover:text-slate-200",
                    )}
                  >
                    ♪ AUDIO
                  </button>
                  <button
                    onClick={() => setCompact((v) => !v)}
                    title="Compact grid"
                    className={cn(
                      "rounded-lg border px-2.5 py-1.5 font-mono text-[11px] tracking-[0.12em] transition",
                      compact
                        ? "border-cyan-300/60 bg-cyan-400/15 text-cyan-100"
                        : "border-white/10 text-slate-400 hover:border-white/25 hover:text-slate-200",
                    )}
                  >
                    ▦ COMPACT
                  </button>
                  <button
                    onClick={() => setConfirmClear(true)}
                    disabled={clips.length === 0}
                    title="Delete every clip"
                    className="rounded-lg border border-rose-500/30 px-2.5 py-1.5 font-mono text-[11px] tracking-[0.12em] text-rose-300/90 transition hover:border-rose-400/60 hover:bg-rose-500/10 disabled:opacity-35"
                  >
                    ✕ CLEAR
                  </button>
                  <button
                    onClick={() => void refreshClips()}
                    className="rounded-lg border border-white/10 px-3 py-1.5 font-mono text-[11px] tracking-[0.14em] text-slate-300 transition hover:border-cyan-300/40 hover:text-cyan-200"
                  >
                    RESCAN
                  </button>
                  <button
                    onClick={() => void clipflow.openOutputFolder()}
                    className="rounded-lg border border-white/10 px-3 py-1.5 font-mono text-[11px] tracking-[0.14em] text-slate-300 transition hover:border-cyan-300/40 hover:text-cyan-200"
                  >
                    FOLDER
                  </button>
                </div>
              </div>

              <GalleryGrid
                clips={filtered}
                loading={loadingClips}
                compact={compact}
                onOpen={(c) => {
                  setActiveClip(c);
                  setActiveFlushMs(undefined);
                }}
                onCopy={(c) => void copyClip(c)}
                onReveal={(c) => void revealClip(c)}
                onOpenExternal={(c) => void openExternalClip(c)}
                onDelete={(c) => void deleteClip(c)}
              />
            </section>
          </div>

          {/* ----------------------------------------------------- side rail */}
          <aside className="space-y-4">
            <section className="panel scanlines relative overflow-hidden rounded-2xl p-4">
              <div className="flex items-center justify-between">
                <h3 className="font-mono text-[11px] tracking-[0.24em] text-cyan-300">
                  INSTANT REPLAY
                </h3>
                <div className="flex items-center gap-1.5 font-mono text-[9px] tracking-[0.1em]">
                  {flushStats ? (
                    <>
                      <span className="rounded border border-lime-400/30 bg-lime-400/10 px-1.5 py-0.5 text-lime-200">
                        LAST {flushStats.last.toFixed(1)} MS
                      </span>
                      <span className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-slate-400">
                        AVG {flushStats.avg.toFixed(1)} MS
                      </span>
                      <span className="rounded border border-fuchsia-400/30 bg-fuchsia-500/10 px-1.5 py-0.5 text-fuchsia-200">
                        BEST {flushStats.best.toFixed(1)} MS
                      </span>
                    </>
                  ) : (
                    <span className="text-slate-600">NO FLUSHES THIS SESSION</span>
                  )}
                </div>
              </div>

              <button
                onClick={() => void handleSave()}
                disabled={!armed || busy}
                className={cn(
                  "group mt-3 w-full rounded-xl border border-fuchsia-400/40 bg-gradient-to-br from-fuchsia-500/25 to-cyan-400/15 px-4 py-4 text-left transition",
                  armed && !busy
                    ? "hover:border-fuchsia-300/70 hover:from-fuchsia-500/35"
                    : "cursor-not-allowed opacity-45",
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[13px] font-semibold tracking-[0.2em] text-fuchsia-100">
                    SAVE LAST {settings.bufferSeconds}s
                  </span>
                  <kbd className="rounded border border-white/20 bg-black/50 px-2 py-0.5 font-mono text-[10px] tracking-[0.14em] text-slate-200">
                    {settings.hotkeySave}
                  </kbd>
                </div>
                <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
                  Flushes the GPU-encoded ring buffer straight to MP4 — target under 50 ms,
                  no re-encode, no stutter.
                </p>
              </button>

              <div className="mt-3 grid grid-cols-3 gap-2">
                {[15, 30, 60].map((s) => (
                  <button
                    key={s}
                    disabled={!armed || busy}
                    onClick={() => void handleSave(s)}
                    className="rounded-lg border border-white/10 bg-black/30 px-2 py-2 font-mono text-[11px] text-slate-300 transition hover:border-cyan-300/40 hover:text-cyan-200 disabled:opacity-40"
                  >
                    LAST {s}s
                  </button>
                ))}
              </div>
            </section>

            <div className="flex gap-2">
              {(["library", "settings"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn(
                    "flex-1 rounded-lg border px-3 py-2 font-mono text-[11px] tracking-[0.18em] transition",
                    tab === t
                      ? "border-cyan-300/50 bg-cyan-400/15 text-cyan-100"
                      : "border-white/10 text-slate-400 hover:border-white/25 hover:text-slate-200",
                  )}
                >
                  {t === "library" ? "PIPELINE" : "SETTINGS"}
                </button>
              ))}
            </div>

            {tab === "settings" ? (
              <SettingsPanel
                settings={settings}
                stats={stats}
                monitors={monitors}
                version={APP_VERSION}
                native={native}
                onChange={(p) => void patchSettings(p)}
                onRestartEngine={() => void restartEngine()}
                onOpenFolder={() => void clipflow.openOutputFolder()}
                onCheckForUpdates={() => void checkForUpdates()}
                onSimulateDeviceLoss={() => {
                  clipflow.simulateDeviceLoss();
                  pushToast("warn", "Simulating DXGI_ERROR_ACCESS_LOST", "Rebuilding D3D11 device + duplication…");
                }}
              />
            ) : (
              <PipelinePanel stats={stats} />
            )}
          </aside>
        </div>
      </main>

      {/* Toasts */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "animate-toast pointer-events-auto rounded-xl border px-3.5 py-2.5 backdrop-blur-lg",
              TONE_STYLES[t.tone],
            )}
          >
            <div className="font-mono text-[11px] font-semibold tracking-[0.12em]">
              {t.title}
            </div>
            {t.body && (
              <div className="mt-1 break-words font-mono text-[10px] opacity-70">{t.body}</div>
            )}
          </div>
        ))}
      </div>

      {activeClip && (
        <ClipTrimmerModal
          clip={activeClip}
          flushMs={activeFlushMs}
          busy={busy}
          onClose={() => setActiveClip(null)}
          onCopy={() => copyClip(activeClip)}
          onReveal={() => revealClip(activeClip)}
          onOpenExternal={() => void openExternalClip(activeClip)}
          onRename={(name) => void renameClip(activeClip, name)}
          onSnapshot={(png) => void snapshotClip(activeClip, png)}
          onDiscard={async () => {
            await deleteClip(activeClip);
            setActiveClip(null);
          }}
          onSaveTrimmed={saveTrimmed}
        />
      )}

      {/* Clear-library confirm */}
      {confirmClear && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center p-4">
          <div
            className="animate-fade absolute inset-0 bg-[#04050c]/80 backdrop-blur-sm"
            onClick={() => setConfirmClear(false)}
          />
          <div className="animate-pop panel relative z-10 w-full max-w-sm rounded-2xl p-5">
            <div className="font-mono text-[12px] font-semibold tracking-[0.2em] text-rose-300">
              DELETE EVERYTHING?
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
              This permanently removes all {clips.length} clip
              {clips.length === 1 ? "" : "s"} from the ClipFlow folder. This cannot
              be undone.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmClear(false)}
                className="rounded-lg border border-white/10 px-3 py-1.5 font-mono text-[11px] tracking-[0.14em] text-slate-300 transition hover:border-white/30 hover:text-slate-100"
              >
                CANCEL
              </button>
              <button
                onClick={() => void clearLibrary()}
                disabled={busy}
                className="rounded-lg border border-rose-500/50 bg-rose-500/15 px-3 py-1.5 font-mono text-[11px] font-semibold tracking-[0.14em] text-rose-100 transition hover:bg-rose-500/25 disabled:opacity-50"
              >
                DELETE ALL
              </button>
            </div>
          </div>
        </div>
      )}

      {/* First-run onboarding */}
      {onboarding && (
        <OnboardingOverlay
          hotkeySave={settings.hotkeySave}
          hotkeyToggle={settings.hotkeyToggle}
          onDismiss={() => {
            setOnboarding(false);
            try {
              localStorage.setItem("clipflow.onboarding.seen", "1");
            } catch {
              /* ignore */
            }
          }}
        />
      )}
    </div>
  );
}

/** Live view of the capture → encode → buffer → mux pipeline. */
function PipelinePanel({ stats }: { stats: EngineStats }) {
  const armed = stats.state === "buffering" || stats.state === "flushing";
  const stages = [
    {
      name: "DXGI Desktop Duplication",
      detail: `${stats.width || "—"}×${stats.height || "—"} BGRA · ${stats.gpu_submit_ms_avg.toFixed(2)} ms acquire`,
      ok: armed,
    },
    {
      name: "D3D11 Video Processor",
      detail: "BGRA → NV12 · GPU colour convert, zero copy",
      ok: armed,
    },
    {
      name: `${stats.encoder.codec} hardware MFT`,
      detail: `${stats.encoder.friendly_name} · ${stats.encode_ms_avg.toFixed(2)} ms/frame`,
      ok: armed,
    },
    {
      name: "Rolling ring buffer",
      detail: `${formatDuration(stats.buffered_seconds)} · ${formatBytes(stats.ring_bytes)} · GOP-aligned eviction`,
      ok: stats.ring_bytes > 0,
    },
    {
      name: "WASAPI loopback + AAC",
      detail: stats.audio_system
        ? `48 kHz stereo · drift ${stats.audio_drift_ms.toFixed(2)} ms`
        : "disabled",
      ok: stats.audio_system && armed,
    },
    {
      name: "MP4 sink writer",
      detail: "Pass-through mux on Alt+C · < 50 ms target",
      ok: armed,
    },
  ];

  return (
    <section className="panel rounded-2xl p-4">
      <h3 className="font-mono text-[11px] tracking-[0.24em] text-lime-300">
        LIVE PIPELINE
      </h3>
      <ol className="mt-3 space-y-2.5">
        {stages.map((s, i) => (
          <li key={s.name} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  "mt-1 h-2 w-2 shrink-0 rounded-full transition",
                  s.ok ? "bg-lime-400 shadow-[0_0_10px_#76ff9c]" : "bg-slate-700",
                )}
              />
              {i < stages.length - 1 && (
                <span
                  className={cn(
                    "mt-1 w-px flex-1",
                    s.ok ? "bg-lime-400/30" : "bg-slate-800",
                  )}
                />
              )}
            </div>
            <div className="min-w-0 pb-1.5">
              <div className="text-[12px] font-medium text-slate-200">{s.name}</div>
              <div className="truncate font-mono text-[10px] text-slate-500">{s.detail}</div>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-[10px]">
        <div className="rounded-lg border border-white/5 bg-black/25 px-3 py-2">
          <div className="tracking-[0.16em] text-slate-600">RING FRAMES</div>
          <div className="mt-1 text-slate-200">{stats.ring_frames}</div>
        </div>
        <div className="rounded-lg border border-white/5 bg-black/25 px-3 py-2">
          <div className="tracking-[0.16em] text-slate-600">DEVICE RESETS</div>
          <div className="mt-1 text-slate-200">{stats.device_resets}</div>
        </div>
      </div>
    </section>
  );
}

/** First-run overlay: teaches the two hotkeys before the user alt-tabs away. */
function OnboardingOverlay({
  hotkeySave,
  hotkeyToggle,
  onDismiss,
}: {
  hotkeySave: string;
  hotkeyToggle: string;
  onDismiss: () => void;
}) {
  const steps = [
    {
      kbd: hotkeySave,
      title: "Save the last moments",
      body: "Flushes the GPU-encoded ring buffer to an MP4 in under 50 ms — mid-game, without alt-tabbing.",
      tone: "border-cyan-300/40 text-cyan-200",
    },
    {
      kbd: hotkeyToggle,
      title: "Arm / disarm the buffer",
      body: "Toggles the rolling history in RAM. Leave it armed while you play; it costs under 100 MB.",
      tone: "border-lime-300/40 text-lime-200",
    },
    {
      kbd: "Videos\\ClipFlow",
      title: "Everything lands in one folder",
      body: "Clips, trims and snapshots are stored in %USERPROFILE%\\Videos\\ClipFlow. No cloud, no account.",
      tone: "border-fuchsia-300/40 text-fuchsia-200",
    },
  ];

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="animate-fade absolute inset-0 bg-[#04050c]/92 backdrop-blur-xl" />
      <div className="animate-pop panel noise relative z-10 w-full max-w-lg rounded-2xl p-6">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-cyan-400 to-fuchsia-500 shadow-[0_0_24px_-4px_#5eeaff]">
            <svg viewBox="0 0 24 24" className="h-5 w-5 text-black" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
          <div>
            <div className="font-mono text-sm font-semibold tracking-[0.24em] text-slate-100">
              CLIPFLOW 1.1
            </div>
            <div className="mt-0.5 font-mono text-[10px] tracking-[0.18em] text-slate-500">
              INSTANT REPLAY · THREE MOVES
            </div>
          </div>
        </div>

        <div className="mt-5 space-y-3">
          {steps.map((s, i) => (
            <div
              key={s.title}
              className="flex items-start gap-3 rounded-xl border border-white/8 bg-black/30 p-3"
            >
              <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border border-white/15 font-mono text-[10px] text-slate-400">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-slate-100">{s.title}</div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{s.body}</div>
              </div>
              <kbd className={cn("shrink-0 rounded border bg-black/50 px-2 py-1 font-mono text-[10px] tracking-[0.12em]", s.tone)}>
                {s.kbd}
              </kbd>
            </div>
          ))}
        </div>

        <button
          onClick={onDismiss}
          className="mt-5 w-full rounded-xl border border-cyan-300/50 bg-cyan-400/15 py-2.5 font-mono text-[11px] font-semibold tracking-[0.2em] text-cyan-100 transition hover:bg-cyan-400/25"
        >
          GOT IT — START CLIPPING
        </button>
      </div>
    </div>
  );
}
