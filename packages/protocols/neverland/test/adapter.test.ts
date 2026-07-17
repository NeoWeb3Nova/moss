import {
  type MossRuntime,
  type Plan,
  type PlanObservation,
  type QueryResult,
  Registry,
} from "@themoss/core";
import { createTraceSimulator } from "@themoss/simulator";
import { monadRuntime, systemManifest } from "@themoss/system";
import { describe, expect, it } from "vitest";
import { NEVERLAND_POOL_ADDRESS, neverlandManifest } from "../src/index.js";

const ACCOUNT = "0x0000000000000000000000000000000000000001";

function offlineRegistry(): Registry {
  const runtime: MossRuntime = {
    chainId: 143,
    rpcUrl: "http://offline",
    // biome-ignore lint/suspicious/noExplicitAny: reads unused in offline tests
    client: {} as any,
  };
  const registry = new Registry(runtime);
  registry.use(systemManifest);
  registry.use(neverlandManifest);
  return registry;
}

describe("neverland adapter (offline shape)", () => {
  it("is discoverable as a lending supply capability", () => {
    const registry = offlineRegistry();
    const caps = registry.discover({ protocol: "neverland" });
    expect(caps).toHaveLength(3); // supply, withdraw, accountData
    expect(registry.discover({ verb: "supply" })).toHaveLength(1);
    expect(registry.discover({ verb: "withdraw" })).toHaveLength(1);
  });

  it("loads parameter descriptions for supply", () => {
    const registry = offlineRegistry();
    const [stub] = registry.load([{ protocol: "neverland", method: "supply" }]);
    expect(stub?.verb).toBe("supply");
    expect(stub?.risk).toEqual(["fundOut", "approval"]);
    expect(Object.keys(stub?.params ?? {})).toEqual(["asset", "amount"]);
  });

  it("builds a supply plan with an approval step and quantified expects", async () => {
    const registry = offlineRegistry();
    // The supply capability needs the aToken address to quantify the "in" flow.
    // Offline we have no RPC, so we stub readContract; the shape test still
    // validates that the adapter emits two steps and declares approval/out/in.
    const aTokenAddress = "0x1111111111111111111111111111111111111111";
    (
      registry.runtime.client as {
        // biome-ignore lint/suspicious/noExplicitAny: minimal RPC stub for offline shape testing
        readContract: any;
      }
    ).readContract = async () => [
      aTokenAddress,
      "0x0000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000",
    ];
    const built = (await registry.action("neverland", "supply", ACCOUNT, {
      asset: "USDC",
      amount: "10",
    })) as Plan;
    expect(built.txs).toHaveLength(2);
    expect(built.txs[1]?.to).toBe(NEVERLAND_POOL_ADDRESS);
    expect(built.expects.approvals).toHaveLength(1);
    expect(built.expects.out?.[0]?.token).toMatch(/^0x[0-9a-f]{40}$/i);
    expect(built.expects.in?.[0]?.token).toBe(aTokenAddress);
    expect(built.planHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe.skipIf(!!process.env.MOSS_SKIP_E2E)("neverland adapter (Monad mainnet e2e)", () => {
  const runtime = monadRuntime();
  const registry = new Registry(runtime);
  registry.use(systemManifest);
  registry.use(neverlandManifest);
  const simulator = createTraceSimulator(runtime, { observer: registry.observer() });

  // A Monad mainnet account that holds USDC and has not interacted with the
  // Neverland pool in this trace. The simulator prefunds native gas; the USDC
  // balance is real chain state.
  const USDC_WHALE = "0xe52b14240514e7a05ddda336cff0d99ce8bb7230";

  it("supplies 0.001 USDC with zero warnings", { timeout: 120_000 }, async () => {
    const plan = (await registry.action("neverland", "supply", USDC_WHALE, {
      asset: "USDC",
      amount: "0.001",
    })) as Plan;

    const { results, halted } = await simulator.simulate([plan]);
    expect(halted).toBeUndefined();
    const [result] = results;
    expect(result?.reverted).toBe(false);
    expect(result?.warnings).toEqual([]);

    const receipt = result?.observations.find((o: PlanObservation) => o.name === "supplyReceipt");
    expect(receipt?.intent).toMatch(/^Supplied [\d.]+ USDC to Neverland$/);
  });

  it("reads live account data for the whale", { timeout: 60_000 }, async () => {
    const result = await registry.action("neverland", "accountData", USDC_WHALE, {
      user: USDC_WHALE,
    });
    expect(result.kind).toBe("query");
    const data = (result as QueryResult).data as Record<string, string>;
    expect(BigInt(data.totalCollateralBase ?? "0")).toBeGreaterThanOrEqual(0n);
    expect(BigInt(data.healthFactor ?? "0")).toBeGreaterThanOrEqual(0n);
  });
});
