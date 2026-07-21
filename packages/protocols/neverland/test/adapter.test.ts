import {
  type CapabilityNode,
  type Change,
  flattenCapabilityTree,
  type Hex,
  type JsonSafeValue,
  type MossRuntime,
  type QueryResult,
  Registry,
  type UnsignedTx,
  verifyReceiptCoverage,
} from "@themoss/core";
import { ERC20 } from "@themoss/erc";
import { createTraceSimulator, type SimulateOutcome } from "@themoss/simulator";
import { extractChanges } from "../../../simulator/src/changes.js";
import { mergeDiff } from "../../../simulator/src/overrides.js";
import {
  DEFAULT_SIMULATION_GAS,
  type StateOverrides,
  traceWithCalls,
  traceWithDiff,
} from "../../../simulator/src/trace.js";
import { monadRuntime, USDC_ADDRESS } from "@themoss/system";
import {
  createPublicClient,
  encodeAbiParameters,
  encodeEventTopics,
  http,
  parseAbiParameters,
} from "viem";
import { describe, expect, it } from "vitest";
import { AavePoolAbi, ATokenAbi } from "../src/abis/aave.js";
import {
  NEVERLAND_DATA_PROVIDER_ADDRESS,
  NEVERLAND_POOL_ADDRESS,
  Neverland,
  type NeverlandSupplyOutcome,
  type NeverlandWithdrawOutcome,
} from "../src/index.js";

const ACCOUNT = "0x0000000000000000000000000000000000000001" as const;
const USER = "0x1111111111111111111111111111111111111111" as const;
const ATOKEN = "0x2222222222222222222222222222222222222222" as const;
const USDC_WHALE = "0xe52b14240514e7a05ddda336cff0d99ce8bb7230" as const;
const PREFUND = `0x${(10n ** 24n).toString(16)}` as const;

function offlineRegistry(): Registry {
  const runtime: MossRuntime = {
    rpcUrl: "http://offline",
    client: createPublicClient({ transport: http("http://offline") }),
  };
  return new Registry(runtime).use(ERC20, Neverland);
}

function stubReads(
  registry: Registry,
  opts: { decimals?: number; allowance?: bigint } = {},
): void {
  const decimals = opts.decimals ?? 6;
  const allowance = opts.allowance ?? 0n;
  (
    registry.runtime.client as {
      // biome-ignore lint/suspicious/noExplicitAny: minimal RPC stub
      readContract: any;
    }
  ).readContract = async ({ functionName }: { functionName: string }) => {
    if (functionName === "decimals") return decimals;
    if (functionName === "name") return "USD Coin";
    if (functionName === "symbol") return "USDC";
    if (functionName === "allowance") return allowance;
    if (functionName === "getReserveTokensAddresses") {
      return [ATOKEN, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000"];
    }
    throw new Error(`unexpected readContract: ${functionName}`);
  };
}

function transferChange(
  token: `0x${string}`,
  from: `0x${string}`,
  to: `0x${string}`,
  value: bigint,
): Change {
  return {
    kind: "event",
    address: token,
    topics: encodeEventTopics({
      abi: ATokenAbi,
      eventName: "Transfer",
      args: { from, to },
    }) as readonly Hex[],
    data: encodeAbiParameters(parseAbiParameters("uint256 value"), [value]),
  };
}

function mintChange(onBehalfOf: `0x${string}`, value: bigint): Change {
  return {
    kind: "event",
    address: ATOKEN,
    topics: encodeEventTopics({
      abi: ATokenAbi,
      eventName: "Mint",
      args: { caller: NEVERLAND_POOL_ADDRESS, onBehalfOf },
    }) as readonly Hex[],
    data: encodeAbiParameters(
      parseAbiParameters("uint256 value, uint256 balanceIncrease, uint256 index"),
      [value, 0n, 10n ** 27n],
    ),
  };
}

function burnChange(from: `0x${string}`, value: bigint): Change {
  return {
    kind: "event",
    address: ATOKEN,
    topics: encodeEventTopics({
      abi: ATokenAbi,
      eventName: "Burn",
      args: { from, target: from },
    }) as readonly Hex[],
    data: encodeAbiParameters(
      parseAbiParameters("uint256 value, uint256 balanceIncrease, uint256 index"),
      [value, 0n, 10n ** 27n],
    ),
  };
}

function supplyChange(reserve: `0x${string}`, onBehalfOf: `0x${string}`, amount: bigint): Change {
  return {
    kind: "event",
    address: NEVERLAND_POOL_ADDRESS,
    topics: encodeEventTopics({
      abi: AavePoolAbi,
      eventName: "Supply",
      args: { reserve, onBehalfOf, referralCode: 0 },
    }) as readonly Hex[],
    data: encodeAbiParameters(parseAbiParameters("address user, uint256 amount"), [
      onBehalfOf,
      amount,
    ]),
  };
}

function withdrawChange(
  reserve: `0x${string}`,
  user: `0x${string}`,
  to: `0x${string}`,
  amount: bigint,
): Change {
  return {
    kind: "event",
    address: NEVERLAND_POOL_ADDRESS,
    topics: encodeEventTopics({
      abi: AavePoolAbi,
      eventName: "Withdraw",
      args: { reserve, user, to },
    }) as readonly Hex[],
    data: encodeAbiParameters(parseAbiParameters("uint256 amount"), [amount]),
  };
}

function capabilityNode(method: "supply" | "withdraw", params: JsonSafeValue): CapabilityNode {
  return {
    kind: "capability",
    protocol: "neverland",
    method,
    params,
    children: [
      {
        kind: "transaction",
        transaction: {
          from: USER,
          to: NEVERLAND_POOL_ADDRESS,
          data: "0x",
          value: "0x0",
        },
      },
    ],
  };
}

/** Simulate one or more Capability trees with state chaining (supply then withdraw). */
async function simulateChained(
  runtime: MossRuntime,
  registry: Registry,
  trees: CapabilityNode[],
): Promise<SimulateOutcome> {
  const overrides: StateOverrides = {};
  const results: SimulateOutcome["results"] = [];
  let globalIndex = 0;

  for (const root of trees) {
    for (const { capability, transaction } of flattenCapabilityTree(root)) {
      const sender = transaction.from.toLowerCase() as keyof StateOverrides;
      overrides[sender] = { balance: PREFUND, ...overrides[sender] };
      const call = transaction as UnsignedTx;
      let frame: Awaited<ReturnType<typeof traceWithCalls>>;
      try {
        frame = await traceWithCalls(
          runtime.client,
          runtime.rpcUrl,
          call,
          overrides,
          DEFAULT_SIMULATION_GAS,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        results.push({
          protocol: capability.protocol,
          method: capability.method,
          transaction,
          reverted: false,
          warnings: [{ code: "TRACE_FAILED", message: reason }],
          gas: null,
        });
        return { results, halted: { transactionIndex: globalIndex, reason } };
      }
      if (frame.error) {
        const reason = frame.revertReason ?? frame.error;
        results.push({
          protocol: capability.protocol,
          method: capability.method,
          transaction,
          reverted: true,
          revertReason: reason,
          warnings: [{ code: "REVERTED", message: `transaction reverted: ${reason}` }],
          gas: null,
        });
        return { results, halted: { transactionIndex: globalIndex, reason } };
      }
      let changes: readonly Change[];
      try {
        changes = extractChanges(frame);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        results.push({
          protocol: capability.protocol,
          method: capability.method,
          transaction,
          reverted: false,
          warnings: [{ code: "RECEIPT_FAILED", message: reason }],
          gas: null,
        });
        return { results, halted: { transactionIndex: globalIndex, reason } };
      }
      let receipt;
      try {
        receipt = registry.parseReceipt(capability, changes);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        results.push({
          protocol: capability.protocol,
          method: capability.method,
          transaction,
          reverted: false,
          changes,
          warnings: [{ code: "RECEIPT_FAILED", message: reason }],
          gas: null,
        });
        return { results, halted: { transactionIndex: globalIndex, reason } };
      }
      results.push({
        protocol: capability.protocol,
        method: capability.method,
        transaction,
        reverted: false,
        receipt,
        changes,
        warnings: [],
        gas: null,
      });
      try {
        const diff = await traceWithDiff(
          runtime.client,
          runtime.rpcUrl,
          call,
          overrides,
          DEFAULT_SIMULATION_GAS,
        );
        mergeDiff(overrides, diff);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { results, halted: { transactionIndex: globalIndex, reason } };
      }
      globalIndex += 1;
    }
  }
  return { results };
}

describe("neverland adapter (offline shape)", () => {
  it("discovers supply, withdraw, accountData, reserveTokens", () => {
    const registry = offlineRegistry();
    const caps = registry.discover({ protocol: "neverland" });
    expect(caps.map((c) => c.method).sort()).toEqual([
      "accountData",
      "reserveTokens",
      "supply",
      "withdraw",
    ]);
  });

  it("loads parameter descriptions", () => {
    const registry = offlineRegistry();
    const [supply] = registry.load([{ protocol: "neverland", method: "supply" }]);
    expect(supply?.risk).toEqual(["fundOut", "approval"]);
    const [withdraw] = registry.load([{ protocol: "neverland", method: "withdraw" }]);
    expect(Object.keys(withdraw?.params ?? {})).toEqual(["asset", "amount", "to"]);
  });

  it("builds supply with approve when allowance is insufficient", async () => {
    const registry = offlineRegistry();
    stubReads(registry, { allowance: 0n });
    const built = (await registry.action("neverland", "supply", ACCOUNT, {
      asset: USDC_ADDRESS,
      amount: "10",
    })) as CapabilityNode;
    const flat = flattenCapabilityTree(built);
    expect(flat).toHaveLength(2);
    expect(flat[0]?.capability).toMatchObject({ protocol: "erc20", method: "approve" });
    expect(flat[1]?.capability).toMatchObject({ protocol: "neverland", method: "supply" });
  });

  it("skips approve when allowance already covers the supply", async () => {
    const registry = offlineRegistry();
    stubReads(registry, { allowance: 10n ** 18n });
    const built = (await registry.action("neverland", "supply", ACCOUNT, {
      asset: USDC_ADDRESS,
      amount: "10",
    })) as CapabilityNode;
    const flat = flattenCapabilityTree(built);
    expect(flat).toHaveLength(1);
    expect(flat[0]?.capability).toMatchObject({ protocol: "neverland", method: "supply" });
  });

  it("builds a single-tx withdraw tree", async () => {
    const registry = offlineRegistry();
    stubReads(registry);
    const built = (await registry.action("neverland", "withdraw", ACCOUNT, {
      asset: USDC_ADDRESS,
      amount: "1",
      to: ACCOUNT,
    })) as CapabilityNode;
    expect(flattenCapabilityTree(built)).toHaveLength(1);
  });

  it("rejects native MON for supply, withdraw, and reserveTokens", async () => {
    const registry = offlineRegistry();
    await expect(
      registry.action("neverland", "supply", ACCOUNT, { asset: "native", amount: "1" }),
    ).rejects.toThrow("native MON");
    await expect(
      registry.action("neverland", "withdraw", ACCOUNT, {
        asset: "native",
        amount: "1",
        to: ACCOUNT,
      }),
    ).rejects.toThrow("native MON");
    await expect(
      registry.action("neverland", "reserveTokens", ACCOUNT, { asset: "native" }),
    ).rejects.toThrow("ERC-20 only");
  });
});

describe("neverland Receipt coverage", () => {
  it("covers Transfer + Mint + Supply with human-readable USDC outcome", () => {
    const registry = offlineRegistry();
    const amount = 1_000_000n;
    const changes = [
      transferChange(USDC_ADDRESS, USER, NEVERLAND_POOL_ADDRESS, amount),
      mintChange(USER, amount),
      supplyChange(USDC_ADDRESS, USER, amount),
    ] as const;
    const receipt = registry.parseReceipt(
      capabilityNode("supply", { asset: USDC_ADDRESS, amount: "1" }),
      changes,
    );
    const outcome = receipt.outcome as NeverlandSupplyOutcome;
    expect(outcome).toMatchObject({
      operation: "supply",
      amountBase: "1000000",
      amountDisplay: "1",
      decimals: 6,
    });
    expect(receipt.text).toMatch(/Supplied 1 /);
    verifyReceiptCoverage(changes, receipt);
  });

  it("fails when Supply event is missing", () => {
    const registry = offlineRegistry();
    const changes = [transferChange(USDC_ADDRESS, USER, NEVERLAND_POOL_ADDRESS, 1_000_000n)];
    expect(() =>
      registry.parseReceipt(capabilityNode("supply", { asset: USDC_ADDRESS, amount: "1" }), changes),
    ).toThrow(/Supply event/);
  });

  it("covers Burn + Transfer + Withdraw", () => {
    const registry = offlineRegistry();
    const amount = 500_000n;
    const changes = [
      burnChange(USER, amount),
      transferChange(USDC_ADDRESS, NEVERLAND_POOL_ADDRESS, USER, amount),
      withdrawChange(USDC_ADDRESS, USER, USER, amount),
    ] as const;
    const receipt = registry.parseReceipt(
      capabilityNode("withdraw", { asset: USDC_ADDRESS, amount: "0.5", to: USER }),
      changes,
    );
    const outcome = receipt.outcome as NeverlandWithdrawOutcome;
    expect(outcome.amountDisplay).toBe("0.5");
    verifyReceiptCoverage(changes, receipt);
  });
});

describe.skipIf(!!process.env.MOSS_SKIP_E2E)("neverland adapter (Monad mainnet e2e)", async () => {
  const runtime = await monadRuntime();
  const registry = new Registry(runtime, {
    trustedTokens: [{ address: USDC_ADDRESS, label: "USDC" }],
  }).use(ERC20, Neverland);
  const simulator = createTraceSimulator(runtime, {
    receipt: (capability, changes) => registry.parseReceipt(capability, changes),
  });

  it("Pool and DataProvider have deployed bytecode", { timeout: 60_000 }, async () => {
    const [poolCode, dataCode] = await Promise.all([
      runtime.client.getCode({ address: NEVERLAND_POOL_ADDRESS }),
      runtime.client.getCode({ address: NEVERLAND_DATA_PROVIDER_ADDRESS }),
    ]);
    expect(poolCode && poolCode !== "0x").toBe(true);
    expect(dataCode && dataCode !== "0x").toBe(true);
  });

  it("resolves USDC reserve token addresses on-chain", { timeout: 60_000 }, async () => {
    const result = await registry.action("neverland", "reserveTokens", USDC_WHALE, {
      asset: USDC_ADDRESS,
    });
    expect(result.kind).toBe("query");
    const data = (result as QueryResult).data as {
      aToken: string;
      asset: string;
    };
    expect(data.asset.toLowerCase()).toBe(USDC_ADDRESS.toLowerCase());
    expect(data.aToken).toMatch(/^0x[a-fA-F0-9]{40}$/);
    const code = await runtime.client.getCode({ address: data.aToken as `0x${string}` });
    expect(code && code !== "0x").toBe(true);
  });

  it("supplies 0.001 USDC with zero warnings and display amount", { timeout: 120_000 }, async () => {
    const capability = (await registry.action("neverland", "supply", USDC_WHALE, {
      asset: USDC_ADDRESS,
      amount: "0.001",
    })) as CapabilityNode;

    const simulation = await simulator.simulate(capability);
    expect(simulation.halted).toBeUndefined();
    expect(simulation.results.every((result) => result.warnings.length === 0)).toBe(true);
    const supplyResult = simulation.results.at(-1);
    expect(supplyResult?.protocol).toBe("neverland");
    const outcome = supplyResult?.receipt?.outcome as NeverlandSupplyOutcome;
    expect(outcome.amountBase).toBe("1000");
    expect(outcome.amountDisplay).toBe("0.001");
    expect(supplyResult?.receipt?.text).toMatch(/0\.001/);
  });

  it("supply then withdraw closes the loop with zero warnings", { timeout: 180_000 }, async () => {
    const supply = (await registry.action("neverland", "supply", USDC_WHALE, {
      asset: USDC_ADDRESS,
      amount: "0.001",
    })) as CapabilityNode;
    // Withdraw slightly less than supplied to absorb aToken index rounding.
    const withdraw = (await registry.action("neverland", "withdraw", USDC_WHALE, {
      asset: USDC_ADDRESS,
      amount: "0.0009",
      to: USDC_WHALE,
    })) as CapabilityNode;

    const simulation = await simulateChained(runtime, registry, [supply, withdraw]);
    expect(simulation.halted).toBeUndefined();
    expect(simulation.results.every((result) => result.warnings.length === 0)).toBe(true);

    const supplyResult = simulation.results.find(
      (result) => result.protocol === "neverland" && result.method === "supply",
    );
    const withdrawResult = simulation.results.find(
      (result) => result.protocol === "neverland" && result.method === "withdraw",
    );
    expect(supplyResult?.receipt?.outcome).toMatchObject({
      operation: "supply",
      amountDisplay: "0.001",
    });
    expect(withdrawResult?.receipt?.outcome).toMatchObject({
      operation: "withdraw",
      amountDisplay: "0.0009",
    });
    expect(withdrawResult?.receipt?.text).toMatch(/0\.0009/);
  });

  it("withdraw without a position reverts (expected failure path)", { timeout: 120_000 }, async () => {
    // Fresh address: simulator prefunds MON for gas but has no aTokens.
    const empty = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
    const withdraw = (await registry.action("neverland", "withdraw", empty, {
      asset: USDC_ADDRESS,
      amount: "0.001",
      to: empty,
    })) as CapabilityNode;
    const simulation = await simulator.simulate(withdraw);
    expect(simulation.halted).toBeDefined();
    expect(simulation.results.some((result) => result.reverted || result.warnings.length > 0)).toBe(
      true,
    );
  });

  it("reads live account data with unit metadata", { timeout: 60_000 }, async () => {
    const result = await registry.action("neverland", "accountData", USDC_WHALE, {
      user: USDC_WHALE,
    });
    expect(result.kind).toBe("query");
    const data = (result as QueryResult).data as Record<string, unknown>;
    expect(data.baseCurrencyDecimals).toBe(8);
    expect(typeof data.healthFactorInfinite).toBe("boolean");
    expect(BigInt(String(data.healthFactor))).toBeGreaterThanOrEqual(0n);
  });
});
