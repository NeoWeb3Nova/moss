import {
  type CapabilityNode,
  type Change,
  flattenCapabilityTree,
  type MossRuntime,
  type QueryResult,
  Registry,
} from "@themoss/core";
import { ERC20 } from "@themoss/erc";
import { createTraceSimulator } from "@themoss/simulator";
import { monadRuntime, USDC_ADDRESS } from "@themoss/system";
import { createPublicClient, http } from "viem";
import { describe, expect, it } from "vitest";
import { NEVERLAND_POOL_ADDRESS, Neverland } from "../src/index.js";

const ACCOUNT = "0x0000000000000000000000000000000000000001";

function offlineRegistry(): Registry {
  const runtime: MossRuntime = {
    rpcUrl: "http://offline",
    client: createPublicClient({ transport: http("http://offline") }),
  };
  const registry = new Registry(runtime).use(ERC20, Neverland);
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

  it("builds a supply capability with an approval transaction", async () => {
    const registry = offlineRegistry();
    const aTokenAddress = "0x1111111111111111111111111111111111111111";
    (
      registry.runtime.client as {
        // biome-ignore lint/suspicious/noExplicitAny: minimal RPC stub for offline shape testing
        readContract: any;
      }
    ).readContract = async ({ functionName }: { functionName: string }) => {
      if (functionName === "getReserveTokensAddresses") {
        return [aTokenAddress, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000"];
      }
      if (functionName === "decimals") return 6;
      if (functionName === "name") return "USD Coin";
      if (functionName === "symbol") return "USDC";
      throw new Error(`unexpected readContract: ${functionName}`);
    };
    const built = (await registry.action("neverland", "supply", ACCOUNT, {
      asset: USDC_ADDRESS,
      amount: "10",
    })) as CapabilityNode;
    const flat = flattenCapabilityTree(built);
    expect(flat).toHaveLength(2);
    expect(flat[1]?.transaction.to).toBe(NEVERLAND_POOL_ADDRESS);
  });

  it("rejects native MON supply", async () => {
    const registry = offlineRegistry();
    await expect(
      registry.action("neverland", "supply", ACCOUNT, { asset: "native", amount: "1" }),
    ).rejects.toThrow("native MON");
  });
});

describe.skipIf(!!process.env.MOSS_SKIP_E2E)("neverland adapter (Monad mainnet e2e)", async () => {
  const runtime = await monadRuntime();
  const registry = new Registry(runtime, {
    trustedTokens: [{ address: USDC_ADDRESS, label: "USDC" }],
  }).use(ERC20, Neverland);
  const simulator = createTraceSimulator(runtime, {
    receipt: (capability: CapabilityNode, changes: readonly Change[]) => registry.parseReceipt(capability, changes),
  });

  // A Monad mainnet account that holds USDC and has not interacted with the
  // Neverland pool in this trace. The simulator prefunds native gas; the USDC
  // balance is real chain state.
  const USDC_WHALE = "0xe52b14240514e7a05ddda336cff0d99ce8bb7230";

  it("supplies 0.001 USDC with zero warnings", { timeout: 120_000 }, async () => {
    const capability = (await registry.action("neverland", "supply", USDC_WHALE, {
      asset: USDC_ADDRESS,
      amount: "0.001",
    })) as CapabilityNode;

    const simulation = await simulator.simulate(capability);
    expect(simulation.halted).toBe(false);
    const result = simulation.results.at(-1);
    expect(result?.protocol).toBe("neverland");
    expect(result?.method).toBe("supply");
    expect(result?.receipt).toBeDefined();
    expect(result?.warnings).toEqual([]);
    expect(result?.receipt?.text).toMatch(/^Supplied [\d.]+ .* to Neverland$/);
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
