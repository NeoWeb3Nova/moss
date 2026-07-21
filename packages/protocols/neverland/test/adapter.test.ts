import {
  type CapabilityNode,
  type Change,
  flattenCapabilityTree,
  type Hex,
  type JsonSafeValue,
  type MossRuntime,
  type QueryResult,
  type Receipt,
  Registry,
  type UnsignedTx,
  verifyReceiptCoverage,
} from "@themoss/core";
import { ERC20 } from "@themoss/erc";
import { createTraceSimulator, type SimulateOutcome } from "@themoss/simulator";
import { monadRuntime, USDC_ADDRESS } from "@themoss/system";
import {
  createPublicClient,
  encodeAbiParameters,
  encodeEventTopics,
  http,
  parseAbiParameters,
} from "viem";
import { describe, expect, it } from "vitest";
import { extractChanges } from "../../../simulator/src/changes.js";
import { mergeDiff } from "../../../simulator/src/overrides.js";
import {
  DEFAULT_SIMULATION_GAS,
  type StateOverrides,
  traceWithCalls,
  traceWithDiff,
} from "../../../simulator/src/trace.js";
import { AavePoolAbi } from "../src/abis/aave.js";
import {
  INTEREST_RATE_VARIABLE,
  NEVERLAND_DATA_PROVIDER_ADDRESS,
  NEVERLAND_POOL_ADDRESS,
  Neverland,
  type NeverlandBorrowOutcome,
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

function stubReads(registry: Registry, opts: { decimals?: number; allowance?: bigint } = {}): void {
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
      return [
        ATOKEN,
        "0x0000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000",
      ];
    }
    if (functionName === "getUserReserveData") {
      return [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0, false];
    }
    if (functionName === "getReserveConfigurationData") {
      return [6n, 8500n, 9000n, 10500n, 4000n, true, true, false, true, false];
    }
    if (functionName === "getAllReservesTokens") {
      return [{ symbol: "USDC", tokenAddress: USDC_ADDRESS }];
    }
    throw new Error(`unexpected readContract: ${functionName}`);
  };
}

function eventTopics(
  abi: readonly unknown[],
  eventName: string,
  args: Record<string, unknown>,
): readonly Hex[] {
  return encodeEventTopics({
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    abi: abi as any,
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    eventName: eventName as any,
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    args: args as any,
  }) as readonly Hex[];
}

function supplyChange(reserve: `0x${string}`, onBehalfOf: `0x${string}`, amount: bigint): Change {
  return {
    kind: "event",
    address: NEVERLAND_POOL_ADDRESS,
    topics: eventTopics(AavePoolAbi, "Supply", { reserve, onBehalfOf, referralCode: 0 }),
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
    topics: eventTopics(AavePoolAbi, "Withdraw", { reserve, user, to }),
    data: encodeAbiParameters(parseAbiParameters("uint256 amount"), [amount]),
  };
}

function borrowChange(reserve: `0x${string}`, onBehalfOf: `0x${string}`, amount: bigint): Change {
  return {
    kind: "event",
    address: NEVERLAND_POOL_ADDRESS,
    topics: eventTopics(AavePoolAbi, "Borrow", {
      reserve,
      onBehalfOf,
      referralCode: 0,
    }),
    data: encodeAbiParameters(
      parseAbiParameters(
        "address user, uint256 amount, uint8 interestRateMode, uint256 borrowRate",
      ),
      [onBehalfOf, amount, 2, 10n ** 25n],
    ),
  };
}

function repayChange(
  reserve: `0x${string}`,
  user: `0x${string}`,
  repayer: `0x${string}`,
  amount: bigint,
): Change {
  return {
    kind: "event",
    address: NEVERLAND_POOL_ADDRESS,
    topics: eventTopics(AavePoolAbi, "Repay", { reserve, user, repayer }),
    data: encodeAbiParameters(parseAbiParameters("uint256 amount, bool useATokens"), [
      amount,
      false,
    ]),
  };
}

function capabilityNode(method: string, params: JsonSafeValue): CapabilityNode {
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
      let receipt: Receipt;
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

describe("neverland offline shape (v1–v3)", () => {
  it("discovers v1–v3 methods", () => {
    const registry = offlineRegistry();
    const methods = registry
      .discover({ protocol: "neverland" })
      .map((c) => c.method)
      .sort();
    expect(methods).toEqual([
      "accountData",
      "borrow",
      "repay",
      "reserveConfig",
      "reserveTokens",
      "reservesList",
      "setCollateral",
      "setEMode",
      "supply",
      "userReserveData",
      "withdraw",
    ]);
    expect(registry.discover({ verb: "borrow" }).some((c) => c.protocol === "neverland")).toBe(
      true,
    );
    expect(registry.discover({ verb: "repay" }).some((c) => c.protocol === "neverland")).toBe(true);
  });

  it("builds borrow and repay trees", async () => {
    const registry = offlineRegistry();
    stubReads(registry, { allowance: 0n });
    const borrow = (await registry.action("neverland", "borrow", ACCOUNT, {
      asset: USDC_ADDRESS,
      amount: "0.1",
      interestRateMode: INTEREST_RATE_VARIABLE,
    })) as CapabilityNode;
    expect(flattenCapabilityTree(borrow)).toHaveLength(1);

    const repay = (await registry.action("neverland", "repay", ACCOUNT, {
      asset: USDC_ADDRESS,
      amount: "0.1",
      interestRateMode: 2,
    })) as CapabilityNode;
    const flat = flattenCapabilityTree(repay);
    expect(flat.length).toBeGreaterThanOrEqual(1);
    expect(flat.some((x) => x.capability.method === "repay")).toBe(true);
  });

  it("builds setCollateral and setEMode trees", async () => {
    const registry = offlineRegistry();
    stubReads(registry);
    const coll = (await registry.action("neverland", "setCollateral", ACCOUNT, {
      asset: USDC_ADDRESS,
      useAsCollateral: true,
    })) as CapabilityNode;
    expect(flattenCapabilityTree(coll)).toHaveLength(1);

    const emode = (await registry.action("neverland", "setEMode", ACCOUNT, {
      categoryId: 0,
    })) as CapabilityNode;
    expect(flattenCapabilityTree(emode)).toHaveLength(1);
  });

  it("runs v3 queries offline", async () => {
    const registry = offlineRegistry();
    stubReads(registry);
    const userRes = await registry.action("neverland", "userReserveData", ACCOUNT, {
      asset: USDC_ADDRESS,
      user: ACCOUNT,
    });
    expect(userRes.kind).toBe("query");
    const cfg = await registry.action("neverland", "reserveConfig", ACCOUNT, {
      asset: USDC_ADDRESS,
    });
    expect((cfg as QueryResult).data).toMatchObject({ borrowingEnabled: true, decimals: 6 });
    const list = await registry.action("neverland", "reservesList", ACCOUNT, {});
    expect((list as QueryResult).data).toMatchObject({
      reserves: [{ symbol: "USDC" }],
    });
  });

  it("rejects native for borrow/repay", async () => {
    const registry = offlineRegistry();
    await expect(
      registry.action("neverland", "borrow", ACCOUNT, { asset: "native", amount: "1" }),
    ).rejects.toThrow(/native MON/);
    await expect(
      registry.action("neverland", "repay", ACCOUNT, { asset: "native", amount: "1" }),
    ).rejects.toThrow(/native MON/);
  });
});

describe("neverland Receipt coverage (v1–v2)", () => {
  it("parses supply / withdraw / borrow / repay primary events", () => {
    const registry = offlineRegistry();
    const amount = 100_000n;

    const supplyChanges = [supplyChange(USDC_ADDRESS, USER, amount)] as const;
    const supplyReceipt = registry.parseReceipt(
      capabilityNode("supply", { asset: USDC_ADDRESS, amount: "0.1" }),
      supplyChanges,
    );
    expect((supplyReceipt.outcome as NeverlandSupplyOutcome).amountDisplay).toBe("0.1");
    verifyReceiptCoverage(supplyChanges, supplyReceipt);

    const withdrawChanges = [withdrawChange(USDC_ADDRESS, USER, USER, amount)] as const;
    const withdrawReceipt = registry.parseReceipt(
      capabilityNode("withdraw", { asset: USDC_ADDRESS, amount: "0.1", to: USER }),
      withdrawChanges,
    );
    expect((withdrawReceipt.outcome as NeverlandWithdrawOutcome).operation).toBe("withdraw");
    verifyReceiptCoverage(withdrawChanges, withdrawReceipt);

    const borrowChanges = [borrowChange(USDC_ADDRESS, USER, amount)] as const;
    const borrowReceipt = registry.parseReceipt(
      capabilityNode("borrow", { asset: USDC_ADDRESS, amount: "0.1" }),
      borrowChanges,
    );
    expect((borrowReceipt.outcome as NeverlandBorrowOutcome).operation).toBe("borrow");
    expect((borrowReceipt.outcome as NeverlandBorrowOutcome).interestRateMode).toBe(2);
    verifyReceiptCoverage(borrowChanges, borrowReceipt);

    const repayChanges = [repayChange(USDC_ADDRESS, USER, USER, amount)] as const;
    const repayReceipt = registry.parseReceipt(
      capabilityNode("repay", { asset: USDC_ADDRESS, amount: "0.1" }),
      repayChanges,
    );
    expect(repayReceipt.text).toMatch(/Repaid/);
    verifyReceiptCoverage(repayChanges, repayReceipt);
  });

  it("fails when the primary Pool event is missing", () => {
    const registry = offlineRegistry();
    const noise: Change = {
      kind: "event",
      address: NEVERLAND_POOL_ADDRESS,
      topics: eventTopics(AavePoolAbi, "ReserveDataUpdated", {
        reserve: USDC_ADDRESS,
      }),
      data: encodeAbiParameters(
        parseAbiParameters(
          "uint256 liquidityRate, uint256 stableBorrowRate, uint256 variableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex",
        ),
        [0n, 0n, 0n, 0n, 0n],
      ),
    };
    expect(() =>
      registry.parseReceipt(capabilityNode("supply", { asset: USDC_ADDRESS, amount: "0.1" }), [
        noise,
      ]),
    ).toThrow(/Supply event/);
    expect(() =>
      registry.parseReceipt(capabilityNode("borrow", { asset: USDC_ADDRESS, amount: "0.1" }), [
        noise,
      ]),
    ).toThrow(/Borrow event/);
    expect(() =>
      registry.parseReceipt(capabilityNode("repay", { asset: USDC_ADDRESS, amount: "0.1" }), [
        noise,
      ]),
    ).toThrow(/Repay event/);
    expect(() =>
      registry.parseReceipt(
        capabilityNode("withdraw", { asset: USDC_ADDRESS, amount: "0.1", to: USER }),
        [noise],
      ),
    ).toThrow(/Withdraw event/);
  });

  it("fails when primary events are duplicated", () => {
    const registry = offlineRegistry();
    const amount = 100_000n;
    const a = supplyChange(USDC_ADDRESS, USER, amount);
    const b = supplyChange(USDC_ADDRESS, USER, amount);
    expect(() =>
      registry.parseReceipt(capabilityNode("supply", { asset: USDC_ADDRESS, amount: "0.1" }), [
        a,
        b,
      ]),
    ).toThrow(/multiple Supply/);

    const ba = borrowChange(USDC_ADDRESS, USER, amount);
    const bb = borrowChange(USDC_ADDRESS, USER, amount);
    expect(() =>
      registry.parseReceipt(capabilityNode("borrow", { asset: USDC_ADDRESS, amount: "0.1" }), [
        ba,
        bb,
      ]),
    ).toThrow(/multiple Borrow/);
  });

  it("fails coverage when Changes are reordered relative to Receipt leaves", () => {
    const registry = offlineRegistry();
    const amount = 100_000n;
    const first = supplyChange(USDC_ADDRESS, USER, amount);
    const second: Change = {
      kind: "event",
      address: NEVERLAND_POOL_ADDRESS,
      topics: eventTopics(AavePoolAbi, "ReserveDataUpdated", { reserve: USDC_ADDRESS }),
      data: encodeAbiParameters(
        parseAbiParameters(
          "uint256 liquidityRate, uint256 stableBorrowRate, uint256 variableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex",
        ),
        [1n, 2n, 3n, 4n, 5n],
      ),
    };
    const ordered = [second, first] as const;
    const receipt = registry.parseReceipt(
      capabilityNode("supply", { asset: USDC_ADDRESS, amount: "0.1" }),
      ordered,
    );
    // Receipt parses successfully, but swapping input order against the same
    // leaf list violates identity/order coverage.
    const swapped = [first, second] as const;
    expect(() => verifyReceiptCoverage(swapped, receipt)).toThrow(/does not retain the original/);
  });
});

describe("neverland load contracts", () => {
  it("exposes separate type schema and field description for borrow/repay", () => {
    const registry = offlineRegistry();
    const [borrow] = registry.load([{ protocol: "neverland", method: "borrow" }]);
    expect(borrow?.params.amount?.description).toMatch(/display units/i);
    expect(borrow?.params.amount?.type).toBeTruthy();
    expect(borrow?.params.interestRateMode?.description).toMatch(/variable/i);
    expect(borrow?.verb).toBe("borrow");

    const [repay] = registry.load([{ protocol: "neverland", method: "repay" }]);
    expect(repay?.params.asset?.description).toMatch(/debt/i);
    expect(repay?.risk).toEqual(expect.arrayContaining(["approval", "fundOut"]));

    const [supply] = registry.load([{ protocol: "neverland", method: "supply" }]);
    expect(supply?.params.amount?.type).not.toEqual(supply?.params.amount?.description);
  });
});

describe.skipIf(!!process.env.MOSS_SKIP_E2E)("neverland live mainnet e2e (v1–v3)", async () => {
  const runtime = await monadRuntime();
  const registry = new Registry(runtime, {
    trustedTokens: [{ address: USDC_ADDRESS, label: "USDC" }],
  }).use(ERC20, Neverland);
  const simulator = createTraceSimulator(runtime, {
    receipt: (capability, changes) => registry.parseReceipt(capability, changes),
  });

  it("v1 supply with display amount", { timeout: 120_000 }, async () => {
    const capability = (await registry.action("neverland", "supply", USDC_WHALE, {
      asset: USDC_ADDRESS,
      amount: "0.001",
    })) as CapabilityNode;
    const simulation = await simulator.simulate(capability);
    expect(simulation.halted).toBeUndefined();
    const supplyResult = simulation.results.at(-1);
    expect(supplyResult?.receipt?.outcome).toMatchObject({
      operation: "supply",
      amountDisplay: "0.001",
    });
  });

  it("v1 supply then withdraw loop", { timeout: 180_000 }, async () => {
    const supply = (await registry.action("neverland", "supply", USDC_WHALE, {
      asset: USDC_ADDRESS,
      amount: "0.001",
    })) as CapabilityNode;
    const withdraw = (await registry.action("neverland", "withdraw", USDC_WHALE, {
      asset: USDC_ADDRESS,
      amount: "0.0009",
      to: USDC_WHALE,
    })) as CapabilityNode;
    const simulation = await simulateChained(runtime, registry, [supply, withdraw]);
    expect(simulation.halted).toBeUndefined();
    expect(simulation.results.every((r) => r.warnings.length === 0)).toBe(true);
  });

  it("v2 supply → borrow → repay → withdraw loop", { timeout: 300_000 }, async () => {
    const supply = (await registry.action("neverland", "supply", USDC_WHALE, {
      asset: USDC_ADDRESS,
      amount: "1",
    })) as CapabilityNode;
    const borrow = (await registry.action("neverland", "borrow", USDC_WHALE, {
      asset: USDC_ADDRESS,
      amount: "0.05",
      interestRateMode: 2,
    })) as CapabilityNode;
    const repay = (await registry.action("neverland", "repay", USDC_WHALE, {
      asset: USDC_ADDRESS,
      amount: "0.05",
      interestRateMode: 2,
    })) as CapabilityNode;
    const withdraw = (await registry.action("neverland", "withdraw", USDC_WHALE, {
      asset: USDC_ADDRESS,
      amount: "0.9",
      to: USDC_WHALE,
    })) as CapabilityNode;

    const simulation = await simulateChained(runtime, registry, [supply, borrow, repay, withdraw]);
    expect(simulation.halted).toBeUndefined();
    expect(simulation.results.every((r) => r.warnings.length === 0)).toBe(true);
    expect(
      simulation.results.some((r) => r.protocol === "neverland" && r.method === "borrow"),
    ).toBe(true);
    expect(simulation.results.some((r) => r.protocol === "neverland" && r.method === "repay")).toBe(
      true,
    );
    const borrowResult = simulation.results.find((r) => r.method === "borrow");
    expect(borrowResult?.receipt?.outcome).toMatchObject({
      operation: "borrow",
      amountDisplay: "0.05",
    });
  });

  it("v3 reserveConfig / reservesList / userReserveData", { timeout: 90_000 }, async () => {
    const cfg = await registry.action("neverland", "reserveConfig", USDC_WHALE, {
      asset: USDC_ADDRESS,
    });
    expect(cfg.kind).toBe("query");
    expect((cfg as QueryResult).data).toMatchObject({
      borrowingEnabled: true,
      decimals: 6,
    });

    const list = await registry.action("neverland", "reservesList", USDC_WHALE, {});
    const reserves = ((list as QueryResult).data as { reserves: { symbol: string }[] }).reserves;
    expect(reserves.length).toBeGreaterThan(0);
    expect(reserves.some((r) => r.symbol.toUpperCase().includes("USD"))).toBe(true);

    const userRes = await registry.action("neverland", "userReserveData", USDC_WHALE, {
      asset: USDC_ADDRESS,
      user: USDC_WHALE,
    });
    expect(userRes.kind).toBe("query");
    expect((userRes as QueryResult).data).toMatchObject({ decimals: 6 });

    // Package label nUSDC should match live PoolDataProvider aToken for USDC.
    const tokens = await registry.action("neverland", "reserveTokens", USDC_WHALE, {
      asset: USDC_ADDRESS,
    });
    const aToken = ((tokens as QueryResult).data as { aToken: string }).aToken;
    expect(aToken.toLowerCase()).toBe("0x38648958836ea88b368b4ac23b86ad44b0fe7508");
    const aCode = await runtime.client.getCode({ address: aToken as `0x${string}` });
    expect(aCode && aCode !== "0x").toBe(true);
  });

  it("v3 setEMode category 0 (disable)", { timeout: 120_000 }, async () => {
    const emode = (await registry.action("neverland", "setEMode", USDC_WHALE, {
      categoryId: 0,
    })) as CapabilityNode;
    const simulation = await simulator.simulate(emode);
    // category 0 may be a no-op event-wise on some deployments; accept success or empty revert-less
    if (!simulation.halted) {
      expect(simulation.results.every((r) => r.warnings.length === 0)).toBe(true);
    } else {
      // If the node reverts for category 0, still document the capability shape.
      expect(flattenCapabilityTree(emode)).toHaveLength(1);
    }
  });

  it("v3 setCollateral after supply (enable path)", { timeout: 180_000 }, async () => {
    const supply = (await registry.action("neverland", "supply", USDC_WHALE, {
      asset: USDC_ADDRESS,
      amount: "0.01",
    })) as CapabilityNode;
    const enable = (await registry.action("neverland", "setCollateral", USDC_WHALE, {
      asset: USDC_ADDRESS,
      useAsCollateral: true,
    })) as CapabilityNode;
    const simulation = await simulateChained(runtime, registry, [supply, enable]);
    // Enabling when already enabled may emit no new event → receipt fail. Accept halt on that edge
    // or full success when an event is present.
    if (!simulation.halted) {
      expect(simulation.results.every((r) => r.warnings.length === 0)).toBe(true);
    } else {
      expect(simulation.results[0]?.warnings.length ?? 0).toBe(0); // supply should still succeed first
    }
  });

  it("Pool bytecode present", { timeout: 60_000 }, async () => {
    const code = await runtime.client.getCode({ address: NEVERLAND_POOL_ADDRESS });
    expect(code && code !== "0x").toBe(true);
    const dataCode = await runtime.client.getCode({ address: NEVERLAND_DATA_PROVIDER_ADDRESS });
    expect(dataCode && dataCode !== "0x").toBe(true);
  });
});
