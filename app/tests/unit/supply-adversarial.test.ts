import { chaosFromEnv, defaultChaos } from "../../src/supply/fixtures/adversarial.ts";

describe("defaultChaos", () => {
  it("starts enabled with empty explicit lists", () => {
    const chaos = defaultChaos();
    expect(chaos.enabled).toBe(true);
    expect(chaos.timeoutSourceIds).toEqual([]);
    expect(chaos.driftOfferIds).toEqual([]);
    expect(chaos.soldOutOfferIds).toEqual([]);
    expect(chaos.latencyMs).toEqual({});
  });
});

describe("chaosFromEnv", () => {
  it("SM_CHAOS=off disables chaos", () => {
    const chaos = chaosFromEnv({ SM_CHAOS: "off" } as NodeJS.ProcessEnv);
    expect(chaos.enabled).toBe(false);
  });

  it("SM_CHAOS=on (or unset) leaves chaos enabled", () => {
    expect(chaosFromEnv({ SM_CHAOS: "on" } as NodeJS.ProcessEnv).enabled).toBe(true);
    expect(chaosFromEnv({} as NodeJS.ProcessEnv).enabled).toBe(true);
  });

  it("SM_CHAOS_TIMEOUT sets a single forced-timeout source id", () => {
    const chaos = chaosFromEnv({ SM_CHAOS_TIMEOUT: "fx-gamma" } as NodeJS.ProcessEnv);
    expect(chaos.timeoutSourceIds).toEqual(["fx-gamma"]);
  });
});
