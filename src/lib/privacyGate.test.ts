import { describe, expect, it } from "vitest";
import { PrivacyGateHysteresis, shouldGateForForeground } from "./privacyGate";

const WINDOW = 5000;

/** Fake clock + machine pair so tests advance time deterministically. */
function makeMachine(nowRef: { t: number }) {
  const machine = new PrivacyGateHysteresis(WINDOW, () => nowRef.t);
  return machine;
}

describe("PrivacyGateHysteresis", () => {
  it("does not gate until the desired state has been stable for the window", () => {
    const now = { t: 0 };
    const m = makeMachine(now);
    // Game focused → desired = false (record). First tick just arms the timer.
    expect(m.tick(true, false)).toBeNull();
    now.t = WINDOW - 1;
    expect(m.tick(true, false)).toBeNull();
    // Exactly at the boundary the gate may flip.
    now.t = WINDOW;
    expect(m.tick(true, false)).toBe(false);
  });

  it("flips only once per stable state (no re-apply spam)", () => {
    const now = { t: 0 };
    const m = makeMachine(now);
    expect(m.tick(true, false)).toBeNull();
    now.t = WINDOW;
    expect(m.tick(true, false)).toBe(false);
    m.commit(false);
    now.t = WINDOW * 10;
    expect(m.tick(true, false)).toBeNull(); // already applied → nothing
  });

  it("survives a quick alt-tab: never gates when focus flickers within the window", () => {
    const now = { t: 0 };
    const m = makeMachine(now);
    // Game → desktop flicker every 2 s (the poll interval), never 5 s stable.
    now.t = 0;
    expect(m.tick(true, false)).toBeNull();
    now.t = 2000;
    expect(m.tick(true, true)).toBeNull();
    now.t = 4000;
    expect(m.tick(true, false)).toBeNull();
    now.t = 6000;
    expect(m.tick(true, true)).toBeNull();
    now.t = 8000;
    expect(m.tick(true, false)).toBeNull();
    // The whole sequence never produced a gate change.
    expect(m.isGated).toBe(false);
  });

  it("gates after a stable desktop focus and un-gates when the game returns", () => {
    const now = { t: 0 };
    const m = makeMachine(now);
    expect(m.tick(true, false)).toBeNull(); // game: timer starts
    now.t = WINDOW;
    const recordGate = m.tick(true, false)!;
    expect(recordGate).toBe(false); // stable game → keep recording
    m.commit(recordGate);
    now.t = WINDOW + 1000;
    expect(m.tick(true, true)).toBeNull(); // desktop: timer restarts
    now.t = WINDOW + 1000 + WINDOW;
    expect(m.tick(true, true)).toBe(true); // stable desktop → pause
    m.commit(true);
    expect(m.isGated).toBe(true);
    // Back to the game: needs a fresh stable window before un-gating.
    now.t = WINDOW + 1000 + WINDOW + 1000;
    expect(m.tick(true, false)).toBeNull();
    now.t = WINDOW + 1000 + WINDOW + 1000 + WINDOW;
    const backToGame = m.tick(true, false)!;
    expect(backToGame).toBe(false);
    m.commit(backToGame);
    expect(m.isGated).toBe(false);
  });

  it("re-arms the timer whenever the desired state changes", () => {
    const now = { t: 0 };
    const m = makeMachine(now);
    expect(m.tick(true, false)).toBeNull();
    now.t = WINDOW - 1;
    expect(m.tick(true, true)).toBeNull(); // flicker resets the timer
    now.t = WINDOW - 1 + WINDOW - 1;
    expect(m.tick(true, true)).toBeNull(); // not yet stable from the flicker
    now.t = WINDOW - 1 + WINDOW;
    expect(m.tick(true, true)).toBe(true);
  });

  it("un-gates immediately when privacy is turned off", () => {
    const now = { t: 0 };
    const m = makeMachine(now);
    // Gate was applied.
    expect(m.tick(true, false)).toBeNull();
    now.t = WINDOW;
    const recordGate = m.tick(true, false)!;
    expect(recordGate).toBe(false);
    m.commit(recordGate);
    // Privacy off → one-shot un-gate regardless of stability.
    expect(m.tick(false, false)).toBe(false);
    // ...and stays silent afterwards.
    expect(m.tick(false, false)).toBeNull();
    expect(m.isGated).toBe(false);
  });

  it("un-gates even if privacy is switched off before the gate was applied", () => {
    const now = { t: 0 };
    const m = makeMachine(now);
    expect(m.tick(true, false)).toBeNull(); // desired armed, not yet applied
    expect(m.tick(false, false)).toBe(false); // still tells the engine to un-gate
  });

  it("retries the same gate when the caller does not commit (invoke failure)", () => {
    const now = { t: 0 };
    const m = makeMachine(now);
    expect(m.tick(true, false)).toBeNull();
    now.t = WINDOW;
    expect(m.tick(true, false)).toBe(false);
    // Caller's invoke failed → no commit → next tick retries the same value.
    now.t = WINDOW + 2000;
    expect(m.tick(true, false)).toBe(false);
    m.commit(false);
    expect(m.tick(true, false)).toBeNull();
  });

  it("does nothing at all while privacy is off from the start", () => {
    const now = { t: 0 };
    const m = makeMachine(now);
    expect(m.tick(false, false)).toBeNull();
    now.t = WINDOW * 10;
    expect(m.tick(false, false)).toBeNull();
    expect(m.isGated).toBe(false);
  });
});

describe("shouldGateForForeground", () => {
  it("gates only for ClipFlow itself and the desktop", () => {
    expect(shouldGateForForeground("clipflow.exe")).toBe(true);
    expect(shouldGateForForeground("ClipFlow")).toBe(true);
    expect(shouldGateForForeground("explorer.exe")).toBe(true);
  });

  it("keeps recording for games and unknown foregrounds", () => {
    expect(shouldGateForForeground("cs2.exe")).toBe(false);
    expect(shouldGateForForeground("chrome.exe")).toBe(false);
    expect(shouldGateForForeground("discord.exe")).toBe(false);
  });

  it("treats a failed query as keep-recording (optimistic default)", () => {
    expect(shouldGateForForeground(null)).toBe(false);
    expect(shouldGateForForeground(undefined)).toBe(false);
    expect(shouldGateForForeground("")).toBe(false);
  });
});
