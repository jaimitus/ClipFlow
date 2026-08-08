/**
 * Single typed entry point for everything the UI needs from the backend.
 *
 * Under Tauri v2 (`withGlobalTauri: true`) it calls the Rust commands through
 * `window.__TAURI__`. In a plain browser it transparently drives `simEngine`,
 * so the exact same components run in both environments with no branching in
 * the view layer.
 */

import { simEngine } from "./simEngine";
import type {
  AppSettings,
  ClipMetadata,
  ClipSavedPayload,
  EngineStats,
  MonitorInfo,
  TrimResult,
} from "./types";

type TauriGlobal = {
  core: {
    invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    convertFileSrc?: (filePath: string, protocol?: string) => string;
  };
  event: {
    listen: <T>(
      event: string,
      handler: (e: { payload: T }) => void,
    ) => Promise<() => void>;
  };
  window?: {
    getCurrentWindow: () => {
      minimize: () => Promise<void>;
      toggleMaximize: () => Promise<void>;
      hide: () => Promise<void>;
      startDragging: () => Promise<void>;
    };
  };
};

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
    __TAURI_INTERNALS__?: unknown;
  }
}

export const isTauri = (): boolean =>
  typeof window !== "undefined" &&
  (typeof window.__TAURI__ !== "undefined" ||
    typeof window.__TAURI_INTERNALS__ !== "undefined");

function tauri(): TauriGlobal {
  const t = window.__TAURI__;
  if (!t) throw new Error("Tauri API unavailable");
  return t;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return tauri().core.invoke<T>(cmd, args);
}

/**
 * Converts an absolute Windows path into something the webview may load.
 * Under Tauri this is the `asset:` custom protocol (scoped to the ClipFlow
 * output folder in `tauri.conf.json`); in the browser there is no such thing,
 * so callers fall back to the simulated blob URL.
 */
export function assetUrl(path: string): string {
  if (!path) return "";
  if (isTauri()) {
    const convert = window.__TAURI__?.core.convertFileSrc;
    if (convert) return convert(path);
    return `http://asset.localhost/${encodeURIComponent(path)}`;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Browser-side event fan-out (mirrors the Rust `app.emit` channels)
// ---------------------------------------------------------------------------

type Handler<T> = (payload: T) => void;
const localBus = new Map<string, Set<Handler<unknown>>>();

function emitLocal<T>(channel: string, payload: T) {
  localBus.get(channel)?.forEach((h) => h(payload as unknown));
}

function onLocal<T>(channel: string, handler: Handler<T>): () => void {
  const set = localBus.get(channel) ?? new Set();
  set.add(handler as Handler<unknown>);
  localBus.set(channel, set);
  return () => set.delete(handler as Handler<unknown>);
}

async function listen<T>(channel: string, handler: Handler<T>): Promise<() => void> {
  if (isTauri()) {
    const unlisten = await tauri().event.listen<T>(channel, (e) => handler(e.payload));
    return unlisten;
  }
  return onLocal(channel, handler);
}

export const CHANNELS = {
  clipSaved: "clipflow://clip-saved",
  stats: "clipflow://stats",
  error: "clipflow://error",
  hotkey: "clipflow://hotkey",
  bufferState: "clipflow://buffer-state",
} as const;

// ---------------------------------------------------------------------------
// Default settings used before the backend answers (and in the browser)
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS: AppSettings = {
  bufferSeconds: 60,
  targetFps: 60,
  bitrateKbps: 12_000,
  codec: "h264",
  monitorIndex: 0,
  captureSystemAudio: true,
  captureMicrophone: false,
  outputDir: "C:\\Users\\You\\Videos\\ClipFlow",
  hotkeySave: "Alt+C",
  hotkeyToggle: "Alt+Shift+C",
  openTrimmerAfterSave: true,
  minimizeToTray: true,
  autostartBuffer: true,
  playSaveSound: true,
};

let browserSettings: AppSettings = { ...DEFAULT_SETTINGS };

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export const clipflow = {
  isTauri,

  async startBuffer(bufferSeconds: number, targetFps: number): Promise<EngineStats> {
    if (isTauri()) {
      return invoke<EngineStats>("start_replay_buffer", { bufferSeconds, targetFps });
    }
    const stats = await simEngine.start(bufferSeconds, targetFps);
    emitLocal(CHANNELS.bufferState, stats);
    return stats;
  },

  async stopBuffer(): Promise<EngineStats> {
    if (isTauri()) return invoke<EngineStats>("stop_replay_buffer");
    const stats = simEngine.stop();
    emitLocal(CHANNELS.bufferState, stats);
    return stats;
  },

  async getStats(): Promise<EngineStats> {
    if (isTauri()) return invoke<EngineStats>("get_engine_stats");
    return simEngine.stats();
  },

  async setBufferSeconds(seconds: number): Promise<void> {
    if (isTauri()) {
      await invoke("set_buffer_seconds", { seconds });
      return;
    }
    simEngine.setBufferSeconds(seconds);
    browserSettings = { ...browserSettings, bufferSeconds: seconds };
  },

  /** The Alt+C flush. Returns the freshly written clip. */
  async saveInstantReplay(
    maxSeconds?: number,
    triggeredBy: string = "ui",
  ): Promise<ClipMetadata> {
    if (isTauri()) {
      return invoke<ClipMetadata>("save_instant_replay", { maxSeconds, triggeredBy });
    }
    const { clip, flushMs } = await simEngine.save(maxSeconds);
    emitLocal<ClipSavedPayload>(CHANNELS.clipSaved, { clip, flushMs, triggeredBy });
    return clip;
  },

  async getClips(withThumbnails = true): Promise<ClipMetadata[]> {
    if (isTauri()) return invoke<ClipMetadata[]>("get_recorded_clips", { withThumbnails });
    return simEngine.list();
  },

  async trimClip(
    sourcePath: string,
    startTime: number,
    endTime: number,
    overwrite = false,
  ): Promise<TrimResult> {
    if (isTauri()) {
      return invoke<TrimResult>("trim_clip", {
        sourcePath,
        startTime,
        endTime,
        overwrite,
      });
    }
    const t0 = performance.now();
    const clip = simEngine.trim(sourcePath, startTime, endTime);
    return {
      path: clip.path,
      file_name: clip.file_name,
      duration_seconds: clip.duration_seconds,
      size_bytes: clip.size_bytes,
      elapsed_ms: performance.now() - t0,
      snapped_start_seconds: startTime,
    };
  },

  async deleteClip(path: string): Promise<void> {
    if (isTauri()) {
      await invoke("delete_clip", { path });
      return;
    }
    simEngine.delete(path);
  },

  async copyClip(path: string): Promise<void> {
    if (isTauri()) {
      await invoke("copy_clip_to_clipboard", { path });
      return;
    }
    // Browsers cannot put a file on the OS clipboard; copy the path instead so
    // the interaction still completes end to end.
    await navigator.clipboard?.writeText(path);
  },

  async revealClip(path: string): Promise<void> {
    if (isTauri()) {
      await invoke("reveal_clip_in_folder", { path });
      return;
    }
    await navigator.clipboard?.writeText(path);
  },

  async openOutputFolder(): Promise<void> {
    if (isTauri()) {
      await invoke("open_output_folder");
      return;
    }
    await navigator.clipboard?.writeText(browserSettings.outputDir);
  },

  async openClip(path: string): Promise<void> {
    if (isTauri()) {
      await invoke("open_clip_external", { path });
    }
  },

  async getSettings(): Promise<AppSettings> {
    if (isTauri()) return invoke<AppSettings>("get_settings");
    return browserSettings;
  },

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    if (isTauri()) return invoke<AppSettings>("update_settings", { patch });
    browserSettings = { ...browserSettings, ...patch };
    if (patch.bufferSeconds) simEngine.setBufferSeconds(patch.bufferSeconds);
    return browserSettings;
  },

  async getMonitors(): Promise<MonitorInfo[]> {
    if (isTauri()) return invoke<MonitorInfo[]>("get_monitors");
    return [
      {
        index: 0,
        name: "\\\\.\\DISPLAY1",
        width: 2560,
        height: 1440,
        refresh_hz: 165,
        primary: true,
        adapter: "Simulated RTX Adapter",
      },
      {
        index: 1,
        name: "\\\\.\\DISPLAY2",
        width: 1920,
        height: 1080,
        refresh_hz: 60,
        primary: false,
        adapter: "Simulated RTX Adapter",
      },
    ];
  },

  async setSaveHotkey(accelerator: string): Promise<string> {
    if (isTauri()) return invoke<string>("set_save_hotkey", { accelerator });
    browserSettings = { ...browserSettings, hotkeySave: accelerator };
    return accelerator;
  },

  async minimize(): Promise<void> {
    if (isTauri()) await tauri().window?.getCurrentWindow().minimize();
  },

  async toggleMaximize(): Promise<void> {
    if (isTauri()) await tauri().window?.getCurrentWindow().toggleMaximize();
  },

  async hideToTray(): Promise<void> {
    if (isTauri()) {
      await invoke("hide_main_window");
      return;
    }
  },

  async startDragging(): Promise<void> {
    if (isTauri()) await tauri().window?.getCurrentWindow().startDragging();
  },

  async quit(): Promise<void> {
    if (isTauri()) await invoke("quit_app");
  },

  simulateDeviceLoss(): void {
    if (isTauri()) {
      void invoke("simulate_device_loss");
      return;
    }
    simEngine.simulateDeviceLoss();
  },

  // ----------------------------------------------------------- listeners
  onStats(handler: Handler<EngineStats>) {
    if (isTauri()) return listen<EngineStats>(CHANNELS.stats, handler);
    const off = simEngine.onStats(handler);
    return Promise.resolve(off);
  },
  onClipSaved(handler: Handler<ClipSavedPayload>) {
    return listen<ClipSavedPayload>(CHANNELS.clipSaved, handler);
  },
  onError(handler: Handler<string>) {
    return listen<string>(CHANNELS.error, handler);
  },
  onHotkey(handler: Handler<string>) {
    return listen<string>(CHANNELS.hotkey, handler);
  },
  onBufferState(handler: Handler<EngineStats>) {
    return listen<EngineStats>(CHANNELS.bufferState, handler);
  },

  /** Local emit used by the browser hotkey shim. */
  emitLocalHotkey(accelerator: string) {
    emitLocal(CHANNELS.hotkey, accelerator);
  },
  emitLocalError(message: string) {
    emitLocal(CHANNELS.error, message);
  },
};

export type ClipFlowApi = typeof clipflow;
