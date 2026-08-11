/**
 * Adaptive capture (ECO) policy — pure and unit-testable.
 *
 * The deck polls `getPowerState()` every few seconds and runs `decideEco`
 * over the snapshot. When the machine is on battery below the configured
 * threshold, or free RAM drops under the threshold, the rolling buffer shrinks
 * to `ECO_BUFFER_SECONDS` (live, engine-only) and the fps is capped at
 * `ECO_FPS` (applies on the next engine start, same contract as profiles).
 * When conditions clear, both restore to the user's configured values.
 *
 * `EcoHysteresis` mirrors `PrivacyGateHysteresis`: the desired state must hold
 * for `windowMs` before it actually flips, so a momentary RAM blip never
 * churns the buffer or spams toasts.
 */

import type { PowerState } from "./types";

export const ECO_BUFFER_SECONDS = 30;
export const ECO_FPS = 30;

export type EcoReason = "battery" | "ram" | "off";

export interface EcoDecision {
  active: boolean;
  reason: EcoReason;
  /** The buffer window that should be live right now. */
  ecoBufferSeconds: number;
  /** The fps cap that should apply (takes effect on the next engine start). */
  ecoFps: number;
}

export interface EcoInput {
  adaptiveEco: boolean;
  ecoBatteryThresholdPct: number;
  ecoRamFreeGbs: number;
  bufferSeconds: number;
  targetFps: number;
}

export function decideEco(power: PowerState, settings: EcoInput): EcoDecision {
  if (!settings.adaptiveEco) {
    return {
      active: false,
      reason: "off",
      ecoBufferSeconds: settings.bufferSeconds,
      ecoFps: settings.targetFps,
    };
  }
  const lowBattery =
    power.onBattery && power.batteryPercent <= settings.ecoBatteryThresholdPct;
  const lowRam =
    power.availableRamBytes < settings.ecoRamFreeGbs * 1024 * 1024 * 1024;
  const active = lowBattery || lowRam;
  return {
    active,
    reason: lowBattery ? "battery" : lowRam ? "ram" : "off",
    ecoBufferSeconds: active
      ? Math.min(settings.bufferSeconds, ECO_BUFFER_SECONDS)
      : settings.bufferSeconds,
    ecoFps: active ? Math.min(settings.targetFps, ECO_FPS) : settings.targetFps,
  };
}

/**
 * Stability gate for the ECO *active* boolean. The buffer only changes once the
 * desired state has held for the whole window — in either direction, so a RAM
 * blip can't shrink the buffer for a few seconds and restore it again.
 */
export class EcoHysteresis {
  private lastDesired: boolean | null = null;
  private applied: boolean | null = null;
  private stableSince = 0;

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Feed one poll. Returns the desired state to apply, or null for no change. */
  tick(desired: boolean): boolean | null {
    if (desired !== this.lastDesired) {
      this.lastDesired = desired;
      this.stableSince = this.now();
    }
    if (this.now() - this.stableSince >= this.windowMs && desired !== this.applied) {
      return desired;
    }
    return null;
  }

  /** Call after the engine apply for the value `tick()` returned succeeded. */
  commit(value: boolean): void {
    this.applied = value;
  }
}
