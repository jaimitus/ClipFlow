import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BufferStatusCard from "./components/BufferStatusCard";
import ClipTrimmerModal from "./components/ClipTrimmerModal";
import GalleryGrid from "./components/GalleryGrid";
import SettingsPanel from "./components/SettingsPanel";
import TitleBar from "./components/TitleBar";
import { DEFAULT_SETTINGS, clipflow } from "./lib/bridge";
import { formatBytes, formatDuration } from "./lib/format";
import type {
  AppSettings,
  ClipMetadata,
  ClipSavedPayload,
  EngineStats,
  MonitorInfo,
} from "./lib/types";
import { cn } from "./utils/cn";

const APP_VERSION = "1.0.0";

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
  const [lastFlushMs, setLastFlushMs] = useState<number | null>(null);
  const [query, setQuery] = useState("");

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
          setLastFlushMs(payload.flushMs);
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
    const onKey = (e: KeyboardEvent) => {
      if (clipflow.isTauri()) return;
      if (e.altKey && !e.ctrlKey && (e.key === "c" || e.key === "C" || e.code === "KeyC")) {
        e.preventDefault();
        if (e.shiftKey) void handleToggle();
        else {
          clipflow.emitLocalHotkey("Alt+C");
          void handleSave();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleSave, handleToggle]);

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

  // ---------------------------------------------------------------- derived
  const armed = stats.state === "buffering" || stats.state === "flushing";
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return clips;
    return clips.filter(
      (c) => c.title.toLowerCase().includes(q) || c.file_name.toLowerCase().includes(q),
    );
  }, [clips, query]);

  const totalBytes = useMemo(
    () => clips.reduce((acc, c) => acc + c.size_bytes, 0),
    [clips],
  );

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
                <div className="flex items-center gap-2">
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filter clips…"
                    className="w-44 rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 font-mono text-[11px] text-slate-200 outline-none transition placeholder:text-slate-600 focus:border-cyan-300/50"
                  />
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
                onOpen={(c) => {
                  setActiveClip(c);
                  setActiveFlushMs(undefined);
                }}
                onCopy={(c) => void copyClip(c)}
                onReveal={(c) => void revealClip(c)}
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
                {lastFlushMs !== null && (
                  <span className="font-mono text-[10px] text-lime-300">
                    last flush {lastFlushMs.toFixed(1)} ms
                  </span>
                )}
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
                native={native}
                onChange={(p) => void patchSettings(p)}
                onRestartEngine={() => void restartEngine()}
                onOpenFolder={() => void clipflow.openOutputFolder()}
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
          onDiscard={async () => {
            await deleteClip(activeClip);
            setActiveClip(null);
          }}
          onSaveTrimmed={saveTrimmed}
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
