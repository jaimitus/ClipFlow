/**
 * Privacy-mode gate hysteresis.
 *
 * The 2 s foreground poll computes the *desired* gate state every tick, but
 * the engine must only learn about it once the state has been stable for
 * `windowMs` — a quick alt-tab or a transient detection blip must never wipe
 * the ring buffer, re-force an encoder key frame or spam toasts. Turning
 * privacy off un-gates immediately.
 *
 * Pure class with an injectable clock, so the whole policy is unit-testable
 * without React or the engine.
 */
export class PrivacyGateHysteresis {
  /** Last desired gate state (null = never computed yet). */
  private desired: boolean | null = null;
  /** Last gate state that was successfully applied to the engine. */
  private applied: boolean | null = null;
  /** When `desired` last changed (clock units). */
  private changedAt = 0;

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Feed one foreground poll.
   *
   * @param privacyEnabled the Privacy mode setting.
   * @param desiredGate what the current foreground implies: `true` pauses
   *   (desktop / ClipFlow focused), `false` records (game focused).
   * @returns the gate value the caller should apply to the engine, or `null`
   *   when nothing should change.
   */
  tick(privacyEnabled: boolean, desiredGate: boolean): boolean | null {
    // Privacy off: un-gate right away (one-shot), regardless of stability.
    // Mirrors the old reset-on-toggle behaviour — the engine gate follows the
    // setting instantly.
    if (!privacyEnabled) {
      const wasActive = this.desired !== null || this.applied !== null;
      this.desired = null;
      this.applied = null;
      this.changedAt = 0;
      return wasActive ? false : null;
    }

    if (desiredGate !== this.desired) {
      this.desired = desiredGate;
      this.changedAt = this.now();
    }

    // Only hand over a gate change once the state has been stable for the
    // whole window, and never re-apply what the engine already has.
    if (
      this.now() - this.changedAt >= this.windowMs &&
      desiredGate !== this.applied
    ) {
      return desiredGate;
    }
    return null;
  }

  /**
   * Call after the engine invoke for the value `tick()` returned succeeded.
   * The caller must NOT call this on failure — the next tick then returns the
   * same value again, which retries the apply.
   */
  commit(gate: boolean): void {
    this.applied = gate;
  }

  /** Whether the engine currently holds the paused gate (for badges/UI). */
  get isGated(): boolean {
    return this.applied === true;
  }
}

/**
 * Mirrors the Rust `privacy_should_gate()`: pause only when the foreground is
 * *positively* ClipFlow itself or the desktop (explorer.exe). A failed query
 * (`null` / empty) means "keep recording" — breaking Alt+C for an undetected
 * game is worse than a rare ambiguous frame.
 */
export function shouldGateForForeground(exe: string | null | undefined): boolean {
  if (!exe) return false;
  const lower = exe.toLowerCase();
  return lower.startsWith("clipflow") || lower.startsWith("explorer");
}
