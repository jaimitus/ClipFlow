/**
 * Save-confirmation blip, generated with WebAudio so ClipFlow ships zero audio
 * assets and stays fully offline. Gated by the `playSaveSound` setting.
 *
 * Browsers/WebView2 require a user gesture before an AudioContext is allowed
 * to run; we try to resume on demand and silently no-op when denied — the clip
 * was saved regardless, this is just feedback.
 */

let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  return ctx;
}

/** Short two-tone "snap": a 880 Hz tick followed by a soft 1318 Hz ping. */
export function playSaveSound(): void {
  const c = audioContext();
  if (!c) return;
  try {
    const t0 = c.currentTime;

    const tick = c.createOscillator();
    const tickGain = c.createGain();
    tick.type = "square";
    tick.frequency.setValueAtTime(880, t0);
    tickGain.gain.setValueAtTime(0.0001, t0);
    tickGain.gain.exponentialRampToValueAtTime(0.06, t0 + 0.004);
    tickGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.07);
    tick.connect(tickGain).connect(c.destination);
    tick.start(t0);
    tick.stop(t0 + 0.08);

    const ping = c.createOscillator();
    const pingGain = c.createGain();
    ping.type = "sine";
    ping.frequency.setValueAtTime(1318.5, t0 + 0.05);
    pingGain.gain.setValueAtTime(0.0001, t0 + 0.05);
    pingGain.gain.exponentialRampToValueAtTime(0.05, t0 + 0.06);
    pingGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
    ping.connect(pingGain).connect(c.destination);
    ping.start(t0 + 0.05);
    ping.stop(t0 + 0.24);
  } catch {
    /* audio is best-effort; never let it break the save path */
  }
}
