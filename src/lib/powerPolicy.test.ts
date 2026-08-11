import { beforeEach, describe, expect, it } from "vitest";
import { decideEco, EcoHysteresis, ECO_BUFFER_SECONDS, ECO_FPS } from "./powerPolicy";
import type { PowerState } from "./types";

const AC: PowerState = {
  onBattery: false,
  batteryPercent: 100,
  availableRamBytes: 12 * 1024 ** 3,
  totalRamBytes: 16 * 1024 ** 3,
};

function base(over: Partial<Parameters<typeof decideEco>[1]> = {}) {
  return {
    adaptiveEco: true,
    ecoBatteryThresholdPct: 30,
    ecoRamFreeGbs: 4,
    bufferSeconds: 60,
    targetFps: 120,
    ...over,
  };
}

describe("decideEco", () => {
  it("is inert when ECO is disabled", () => {
    const d = decideEco(
      { ...AC, onBattery: true, batteryPercent: 5 },
      base({ adaptiveEco: false }),
    );
    expect(d.active).toBe(false);
    expect(d.reason).toBe("off");
    expect(d.ecoBufferSeconds).toBe(60);
    expect(d.ecoFps).toBe(120);
  });

  it("stays off on healthy AC power and RAM", () => {
    const d = decideEco(AC, base());
    expect(d.active).toBe(false);
    expect(d.reason).toBe("off");
  });

  it("activates when battery drops to the threshold", () => {
    const d = decideEco({ ...AC, onBattery: true, batteryPercent: 30 }, base());
    expect(d.active).toBe(true);
    expect(d.reason).toBe("battery");
    expect(d.ecoBufferSeconds).toBe(ECO_BUFFER_SECONDS);
    expect(d.ecoFps).toBe(ECO_FPS);
  });

  it("does not activate above the threshold", () => {
    const d = decideEco({ ...AC, onBattery: true, batteryPercent: 31 }, base());
    expect(d.active).toBe(false);
  });

  it("activates when free RAM drops below the threshold", () => {
    const d = decideEco({ ...AC, availableRamBytes: 3 * 1024 ** 3 }, base());
    expect(d.active).toBe(true);
    expect(d.reason).toBe("ram");
  });

  it("exactly at the RAM threshold does not trip", () => {
    const d = decideEco({ ...AC, availableRamBytes: 4 * 1024 ** 3 }, base());
    expect(d.active).toBe(false);
  });

  it("battery reason wins when both conditions hold", () => {
    const d = decideEco(
      {
        ...AC,
        onBattery: true,
        batteryPercent: 10,
        availableRamBytes: 1 * 1024 ** 3,
      },
      base(),
    );
    expect(d.reason).toBe("battery");
  });

  it("never grows the buffer beyond the user setting", () => {
    const d = decideEco(AC, base({ bufferSeconds: 15 }));
    expect(d.ecoBufferSeconds).toBe(15);
    const e = decideEco(
      { ...AC, onBattery: true, batteryPercent: 5 },
      base({ bufferSeconds: 15 }),
    );
    expect(e.ecoBufferSeconds).toBe(15); // already smaller than ECO's 30s
  });

  it("caps fps to ECO_FPS without raising a lower user value", () => {
    const d = decideEco(
      { ...AC, onBattery: true, batteryPercent: 5 },
      base({ targetFps: 24 }),
    );
    expect(d.ecoFps).toBe(24);
    const e = decideEco(
      { ...AC, onBattery: true, batteryPercent: 5 },
      base({ targetFps: 240 }),
    );
    expect(e.ecoFps).toBe(ECO_FPS);
  });
});

describe("EcoHysteresis", () => {
  let now = 0;
  // `now` is shared across tests inside this describe — reset it so no test
  // inherits the previous test's clock (moving it backwards would break the
  // stability arithmetic).
  beforeEach(() => {
    now = 0;
  });
  const h = () => new EcoHysteresis(6000, () => now);

  it("ignores a brief blip", () => {
    const g = h();
    expect(g.tick(true)).toBeNull();
    now = 2000;
    expect(g.tick(true)).toBeNull();
    now = 4000;
    expect(g.tick(true)).toBeNull(); // still inside the 6 s window
    now = 6000;
    expect(g.tick(true)).toBe(true);
  });

  it("resets the stability clock when the desired state changes", () => {
    const g = h();
    expect(g.tick(true)).toBeNull();
    now = 4000;
    expect(g.tick(false)).toBeNull(); // flapped back — clock restarts
    now = 11000;
    expect(g.tick(false)).toBe(false);
  });

  it("only applies each state once", () => {
    const g = h();
    expect(g.tick(true)).toBeNull(); // first tick establishes the baseline
    now = 6000;
    expect(g.tick(true)).toBe(true);
    g.commit(true);
    now = 12000;
    expect(g.tick(true)).toBeNull(); // stable, already applied
    now = 12000;
    expect(g.tick(false)).toBeNull(); // just flipped — must wait
    now = 18000;
    expect(g.tick(false)).toBe(false);
  });

  it("does not apply after commit on a changed desire until stable again", () => {
    const g = h();
    expect(g.tick(true)).toBeNull(); // establish baseline
    now = 6000;
    expect(g.tick(true)).toBe(true);
    g.commit(true);
    now = 7000;
    expect(g.tick(false)).toBeNull(); // just flipped — must wait
    now = 13000;
    expect(g.tick(false)).toBe(false);
  });
});
