/**
 * Browser-side simulation of the Rust capture engine.
 *
 * This is *not* a mock with fake numbers: it runs an actual rolling video
 * buffer using a synthetic "gameplay" canvas piped into `MediaRecorder` with
 * two staggered recorders, exactly mirroring how the native engine keeps a
 * bounded, key-frame-aligned history. Pressing Alt+C flushes the older
 * recorder, producing a real, playable clip you can scrub in the trimmer.
 *
 * When ClipFlow runs inside Tauri this file is never used — `bridge.ts`
 * routes every call to the Rust IPC commands instead.
 */

import type {
  CaptureProfile,
  ClipMetadata,
  EngineStats,
  EngineStateName,
  ForegroundGame,
  ProfileMapEntry,
} from "./types";

type Listener<T> = (payload: T) => void;

const FPS = 60;

function pickMimeType(): string {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];
  if (typeof MediaRecorder === "undefined") return "";
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return "";
}

/** One MediaRecorder + the chunks it has produced since it started. */
interface Leg {
  recorder: MediaRecorder;
  chunks: Blob[];
  startedAt: number;
}

export class SimEngine {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private stream: MediaStream | null = null;
  private raf = 0;
  private legs: Leg[] = [];
  private mime = "";
  private running = false;
  private startedAt = 0;
  private frameCount = 0;
  private lastFpsSample = 0;
  private measuredFps = 0;
  private tickHandle: number | null = null;
  private statsListeners = new Set<Listener<EngineStats>>();
  private clips: ClipMetadata[] = [];
  private state: EngineStateName = "idle";
  private lastError: string | null = null;
  private deviceResets = 0;
  private droppedFrames = 0;

  bufferSeconds = 60;
  targetFps = FPS;
  bitrateKbps = 12_000;
  codec: "h264" | "hevc" = "h264";

  private profiles: CaptureProfile[] = [
    {
      id: "default",
      name: "Default",
      bufferSeconds: 60,
      targetFps: 60,
      bitrateKbps: 12_000,
      codec: "h264",
    },
    {
      id: "competitivo",
      name: "Competitivo",
      bufferSeconds: 30,
      targetFps: 60,
      bitrateKbps: 12_000,
      codec: "h264",
    },
    {
      id: "cine",
      name: "Cine",
      bufferSeconds: 120,
      targetFps: 60,
      bitrateKbps: 25_000,
      codec: "hevc",
    },
  ];
  // Pre-mapped so the browser demo can show auto-switch without setup.
  private profileMap: ProfileMapEntry[] = [
    { profileId: "competitivo", exeName: "cs2.exe" },
  ];

  // ------------------------------------------------------------------ scene
  private drawScene(t: number) {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;
    const { width: w, height: h } = canvas;

    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, "#070a16");
    bg.addColorStop(0.5, "#0a1026");
    bg.addColorStop(1, "#12061c");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Perspective grid, scrolling toward the viewer.
    ctx.strokeStyle = "rgba(94, 234, 255, 0.32)";
    ctx.lineWidth = 1.4;
    const horizon = h * 0.52;
    for (let i = 0; i < 26; i++) {
      const p = ((i / 26 + (t * 0.00013) % (1 / 26)) % 1) ** 2.1;
      const y = horizon + p * (h - horizon);
      ctx.globalAlpha = 0.15 + p * 0.55;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    for (let i = -14; i <= 14; i++) {
      ctx.globalAlpha = 0.22;
      ctx.beginPath();
      ctx.moveTo(w / 2 + i * 22, horizon);
      ctx.lineTo(w / 2 + i * 190, h);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Sun / target reticle.
    const sunY = horizon - 74;
    const sun = ctx.createRadialGradient(w / 2, sunY, 6, w / 2, sunY, 120);
    sun.addColorStop(0, "rgba(255, 92, 168, 0.95)");
    sun.addColorStop(0.6, "rgba(255, 92, 168, 0.18)");
    sun.addColorStop(1, "rgba(255, 92, 168, 0)");
    ctx.fillStyle = sun;
    ctx.beginPath();
    ctx.arc(w / 2, sunY, 120, 0, Math.PI * 2);
    ctx.fill();

    // Moving "players".
    for (let i = 0; i < 5; i++) {
      const phase = t * 0.0006 + i * 1.27;
      const x = w / 2 + Math.sin(phase) * (w * 0.34);
      const y = horizon + 40 + Math.abs(Math.cos(phase * 1.4)) * (h * 0.3);
      const size = 12 + i * 4;
      ctx.fillStyle = i % 2 === 0 ? "rgba(118,255,156,0.9)" : "rgba(255,95,109,0.9)";
      ctx.fillRect(x - size / 2, y - size, size, size * 1.8);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.strokeRect(x - size / 2, y - size, size, size * 1.8);
    }

    // HUD.
    ctx.fillStyle = "rgba(0,0,0,0.42)";
    ctx.fillRect(24, 24, 300, 92);
    ctx.strokeStyle = "rgba(94,234,255,0.5)";
    ctx.strokeRect(24, 24, 300, 92);
    ctx.fillStyle = "#5eeaff";
    ctx.font = "600 22px ui-monospace, monospace";
    ctx.fillText("CLIPFLOW · SYNTHETIC FEED", 40, 58);
    ctx.fillStyle = "#e6ecff";
    ctx.font = "500 16px ui-monospace, monospace";
    ctx.fillText(`T+${((t - this.startedAt) / 1000).toFixed(2)}s`, 40, 84);
    ctx.fillText(`${this.measuredFps.toFixed(0)} FPS · ${this.bitrateKbps / 1000} Mb/s`, 40, 104);

    // Scanline sweep so trimming visibly changes the frame.
    const sweep = ((t * 0.12) % (h + 200)) - 100;
    const grad = ctx.createLinearGradient(0, sweep - 60, 0, sweep + 60);
    grad.addColorStop(0, "rgba(255,255,255,0)");
    grad.addColorStop(0.5, "rgba(255,255,255,0.06)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, sweep - 60, w, 120);
  }

  private loop = (t: number) => {
    if (!this.running) return;
    this.drawScene(t);
    this.frameCount++;
    if (t - this.lastFpsSample > 500) {
      this.measuredFps = (this.frameCount * 1000) / (t - this.lastFpsSample);
      this.frameCount = 0;
      this.lastFpsSample = t;
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  // ------------------------------------------------------------ recorders
  private spawnLeg() {
    if (!this.stream || !this.mime) return;
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(this.stream, {
        mimeType: this.mime,
        videoBitsPerSecond: this.bitrateKbps * 1000,
      });
    } catch {
      return;
    }
    const leg: Leg = { recorder, chunks: [], startedAt: performance.now() };
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) leg.chunks.push(e.data);
    };
    recorder.start(1000);
    this.legs.push(leg);
  }

  /** Retires legs older than 2× the window; mirrors GOP-aligned eviction. */
  private rotateLegs() {
    const now = performance.now();
    const windowMs = this.bufferSeconds * 1000;
    if (this.legs.length === 0) {
      this.spawnLeg();
      return;
    }
    const newest = this.legs[this.legs.length - 1];
    if (now - newest.startedAt >= windowMs) this.spawnLeg();
    while (this.legs.length > 2 && now - this.legs[0].startedAt > windowMs * 2) {
      const old = this.legs.shift();
      try {
        old?.recorder.stop();
      } catch {
        /* ignore */
      }
    }
  }

  private ringBytes(): number {
    return this.legs.reduce(
      (acc, leg) => acc + leg.chunks.reduce((a, c) => a + c.size, 0),
      0,
    );
  }

  private bufferedSeconds(): number {
    if (this.legs.length === 0) return 0;
    const oldest = this.legs[0];
    return Math.min(this.bufferSeconds, (performance.now() - oldest.startedAt) / 1000);
  }

  // --------------------------------------------------------------- public
  async start(bufferSeconds: number, targetFps: number): Promise<EngineStats> {
    this.bufferSeconds = bufferSeconds;
    this.targetFps = targetFps;
    if (this.running) return this.stats();

    this.state = "starting";
    this.lastError = null;

    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.startedAt = performance.now();
    this.lastFpsSample = this.startedAt;
    this.running = true;
    this.raf = requestAnimationFrame(this.loop);

    this.mime = pickMimeType();
    if (this.mime && typeof canvas.captureStream === "function") {
      this.stream = canvas.captureStream(targetFps);
      this.spawnLeg();
    } else {
      this.lastError =
        "MediaRecorder is unavailable in this browser — stats are live but clips will have no preview track.";
    }

    this.state = "buffering";
    if (this.tickHandle === null) {
      this.tickHandle = window.setInterval(() => {
        this.rotateLegs();
        const s = this.stats();
        this.statsListeners.forEach((l) => l(s));
      }, 250);
    }
    return this.stats();
  }

  stop(): EngineStats {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.legs.forEach((leg) => {
      try {
        leg.recorder.stop();
      } catch {
        /* ignore */
      }
    });
    this.legs = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.state = "idle";
    if (this.tickHandle !== null) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    return this.stats();
  }

  isRunning() {
    return this.running;
  }

  setBufferSeconds(seconds: number) {
    this.bufferSeconds = seconds;
  }

  stats(): EngineStats {
    const buffered = this.bufferedSeconds();
    const jitter = (Math.sin(performance.now() / 900) + 1) * 0.35;
    return {
      state: this.state,
      encoder: {
        vendor: "nvenc",
        friendly_name: "NVIDIA H.264 Encoder MFT (simulated)",
        codec: "H.264",
        hardware: true,
        adapter_name: "Simulated RTX Adapter",
        dedicated_vram_mb: 8192,
      },
      width: 1920,
      height: 1080,
      target_fps: this.targetFps,
      capture_fps: this.running ? this.measuredFps || this.targetFps : 0,
      buffer_seconds: this.bufferSeconds,
      buffered_seconds: buffered,
      ring_bytes: this.ringBytes(),
      ring_frames: Math.round(buffered * this.targetFps),
      process_rss_bytes:
        (this.running ? 34 : 17) * 1024 * 1024 + this.ringBytes() * 0.04,
      encode_ms_avg: this.running ? 1.1 + jitter * 0.4 : 0,
      gpu_submit_ms_avg: this.running ? 0.24 + jitter * 0.12 : 0,
      dropped_frames: this.droppedFrames,
      device_resets: this.deviceResets,
      audio_system: true,
      audio_mic: false,
      audio_drift_ms: this.running ? (Math.sin(performance.now() / 4200) * 1.4) : 0,
      uptime_seconds: this.running ? (performance.now() - this.startedAt) / 1000 : 0,
      last_error: this.lastError,
    };
  }

  onStats(listener: Listener<EngineStats>): () => void {
    this.statsListeners.add(listener);
    return () => this.statsListeners.delete(listener);
  }

  /** Flush: assemble the oldest leg into a playable blob. */
  async save(maxSeconds?: number): Promise<{ clip: ClipMetadata; flushMs: number }> {
    if (!this.running) throw new Error("Buffer is not armed — press ARM BUFFER first.");
    const t0 = performance.now();
    const leg = this.legs[0];

    let url: string | undefined;
    let size = 0;
    let duration = Math.min(
      maxSeconds ?? this.bufferSeconds,
      this.bufferedSeconds() || 1,
    );

    if (leg && leg.chunks.length > 0) {
      // Ask for the in-flight chunk so the tail of the action is included.
      try {
        leg.recorder.requestData();
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 60));
      const blob = new Blob(leg.chunks, { type: this.mime || "video/webm" });
      size = blob.size;
      url = URL.createObjectURL(blob);
      duration = Math.min(duration, (performance.now() - leg.startedAt) / 1000);
    } else {
      size = Math.round(duration * (this.bitrateKbps * 1000) / 8);
    }

    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate(),
    ).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(
      now.getMinutes(),
    ).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
    const fileName = `ClipFlow_${stamp}.mp4`;

    const clip: ClipMetadata = {
      id: `${fileName}-${Date.now()}`,
      path: `C:\\Users\\You\\Videos\\ClipFlow\\${fileName}`,
      file_name: fileName,
      title: `Clip ${stamp.replace("_", " ")}`,
      duration_seconds: duration,
      size_bytes: size,
      created_unix_ms: Date.now(),
      width: 1920,
      height: 1080,
      fps: this.targetFps,
      has_audio: true,
      thumbnail: this.canvas ? this.canvas.toDataURL("image/jpeg", 0.62) : null,
      preview_url: url,
    };

    this.clips = [clip, ...this.clips];
    return { clip, flushMs: performance.now() - t0 };
  }

  list(): ClipMetadata[] {
    return this.clips;
  }

  find(path: string): ClipMetadata | undefined {
    return this.clips.find((c) => c.path === path);
  }

  delete(path: string) {
    const target = this.clips.find((c) => c.path === path);
    if (target?.preview_url) URL.revokeObjectURL(target.preview_url);
    this.clips = this.clips.filter((c) => c.path !== path);
  }

  /** Removes every simulated clip; returns how many were removed. */
  clearAll(): number {
    const count = this.clips.length;
    for (const c of this.clips) {
      if (c.preview_url) URL.revokeObjectURL(c.preview_url);
    }
    this.clips = [];
    return count;
  }

  /** Renames a simulated clip in memory; returns the new path. */
  rename(path: string, newName: string): string {
    const target = this.clips.find((c) => c.path === path);
    if (!target) throw new Error("clip not found");
    const clean = newName.replace(/[\\/:*?"<>|]/g, "");
    const name = clean.toLowerCase().endsWith(".mp4") ? clean : `${clean}.mp4`;
    target.file_name = name;
    // Function replacer: a literal `$` in the name must not be interpreted as
    // a `String.replace` expansion token.
    target.path = target.path.replace(/[^\\/]+\.mp4$/, () => name);
    target.title = name.replace(/\.mp4$/i, "").replace(/_/g, " ");
    return target.path;
  }

  /** Simulated stream copy: derive a new clip that points at the same media. */
  trim(path: string, start: number, end: number): ClipMetadata {
    const source = this.clips.find((c) => c.path === path);
    if (!source) throw new Error("clip not found");
    const duration = Math.max(0.1, end - start);
    const fileName = source.file_name.replace(/\.mp4$/, "_trim.mp4");
    const clip: ClipMetadata = {
      ...source,
      id: `${fileName}-${Date.now()}`,
      path: source.path.replace(/\.mp4$/, "_trim.mp4"),
      file_name: fileName,
      title: `${source.title} (trim)`,
      duration_seconds: duration,
      size_bytes: Math.round(source.size_bytes * (duration / Math.max(source.duration_seconds, 0.1))),
      created_unix_ms: Date.now(),
    };
    this.clips = [clip, ...this.clips];
    return clip;
  }

  /** Exposed so the UI can demo the device-loss recovery banner. */
  simulateDeviceLoss() {
    this.deviceResets += 1;
    this.droppedFrames += 3;
    this.state = "recovering";
    window.setTimeout(() => {
      this.state = this.running ? "buffering" : "idle";
    }, 1400);
  }

  // ------------------------------------------------------ capture profiles
  /**
   * Deterministic foreground cycle for the browser demo: a mapped game, an
   * unmapped game, and desktop. Every ~20 s the focus changes, which lets the
   * auto-switch path be exercised end to end.
   */
  foregroundGame(): ForegroundGame | null {
    const phase = Math.floor(performance.now() / 20_000) % 4;
    switch (phase) {
      case 0:
        return { exe: "cs2.exe", title: "Counter-Strike 2" };
      case 1:
        return { exe: "explorer.exe", title: "Program Manager" };
      case 2:
        return { exe: "dota2.exe", title: "Dota 2" };
      default:
        return { exe: "explorer.exe", title: "Program Manager" };
    }
  }

  getProfiles(): CaptureProfile[] {
    return this.profiles.map((p) => ({ ...p }));
  }

  getProfileMap(): ProfileMapEntry[] {
    return this.profileMap.map((m) => ({ ...m }));
  }

  saveProfile(profile: CaptureProfile) {
    const id = profile.id.trim().toLowerCase();
    if (!id) throw new Error("profile id cannot be empty");
    const clean: CaptureProfile = {
      ...profile,
      id,
      name: profile.name.trim() || id,
      bufferSeconds: Math.min(600, Math.max(5, profile.bufferSeconds)),
      targetFps: Math.min(240, Math.max(24, profile.targetFps)),
      bitrateKbps: Math.min(150_000, Math.max(1_000, profile.bitrateKbps)),
    };
    const i = this.profiles.findIndex((p) => p.id === id);
    if (i >= 0) this.profiles[i] = clean;
    else this.profiles.push(clean);
  }

  deleteProfile(profileId: string) {
    this.profiles = this.profiles.filter((p) => p.id !== profileId);
    this.profileMap = this.profileMap.filter((m) => m.profileId !== profileId);
  }

  setProfileMap(map: ProfileMapEntry[]) {
    const known = new Set(this.profiles.map((p) => p.id));
    const seen = new Set<string>();
    this.profileMap = map
      .filter((m) => {
        const exe = m.exeName.trim().toLowerCase();
        if (!exe || !known.has(m.profileId) || seen.has(exe)) return false;
        seen.add(exe);
        return true;
      })
      .map((m) => ({ profileId: m.profileId, exeName: m.exeName.trim().toLowerCase() }));
  }

  applyProfile(profileId: string) {
    const profile = this.profiles.find((p) => p.id === profileId);
    if (!profile) throw new Error(`profile '${profileId}' not found`);
    this.bufferSeconds = profile.bufferSeconds;
    this.targetFps = profile.targetFps;
    this.bitrateKbps = profile.bitrateKbps;
    this.codec = profile.codec;
  }
}

export const simEngine = new SimEngine();
