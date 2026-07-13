import { type MossRuntime, NATIVE, type Plan, Registry } from "@themoss/core";
import { describe, expect, it } from "vitest";
import { MOCK_VAULT_ADDRESS, mockvaultManifest } from "../src/index.js";

const ACCOUNT = "0xCcCccCCCcCCcccCcCccccCcCCCCcccccCcCCcCcC";

function offlineRegistry(): Registry {
  const runtime: MossRuntime = {
    chainId: 143,
    rpcUrl: "http://offline",
    // biome-ignore lint/suspicious/noExplicitAny: reads unused in offline tests
    client: {} as any,
  };
  const registry = new Registry(runtime);
  registry.use(mockvaultManifest);
  return registry;
}

describe("mockvault adapter (offline shape)", () => {
  it("is discoverable and loads a described stub", () => {
    const registry = offlineRegistry();
    expect(registry.discover({ protocol: "mockvault" })).toHaveLength(2);
    const [stub] = registry.load([{ protocol: "mockvault", method: "deposit" }]);
    expect(stub?.risk).toEqual(["fundOut"]);
  });

  it("builds a plan with quantified expects", async () => {
    const registry = offlineRegistry();
    const built = (await registry.action("mockvault", "deposit", ACCOUNT, {
      amount: "1",
    })) as Plan;
    expect(built.txs[0]?.to).toBe(MOCK_VAULT_ADDRESS);
    expect(built.expects.out).toEqual([{ token: NATIVE, amountMax: (10n ** 18n).toString() }]);
    expect(built.planHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
