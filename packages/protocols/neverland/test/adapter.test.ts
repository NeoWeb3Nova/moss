import {
  type CapabilityNode,
  type Change,
  flattenCapabilityTree,
  type Hex,
  type JsonSafeValue,
  type MossRuntime,
  type QueryResult,
  Registry,
  verifyReceiptCoverage,
} from "@themoss/core";
import { ERC20 } from "@themoss/erc";
import { createTraceSimulator } from "@themoss/simulator";
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
} from "../src/index.js";

const ACCOUNT = "0x0000000000000000000000000000000000000001" as const;
const USER = "0x1111111111111111111111111111111111111111" as const;
const ATOKEN = "0x2222222222222222222222222222222222222222" as const;

function offlineRegistry(): Registry {
  const runtime: MossRuntime = {
    rpcUrl: "http://offline",
    client: createPublicClient({ transport: http("http://offline") }),
  };
  return new Registry(runtime).use(ERC20, Neverland);
}

function stubErc20Metadata(registry: Registry): void {
  (
    registry.runtime.client as {
      // biome-ignore lint/suspicious/noExplicitAny: minimal RPC stub
      readContract: any;
    }
  ).readContract = async ({ functionName }: { functionName: string }) => {
    if (functionName === "decimals") return 6;
    if (functionName === "name") return "USD Coin";
    if (functionName === "symbol") return "USDC";
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
    data: encodeAbiParameters(parseAbiParameters("uint256 value, uint256 balanceIncrease, uint256 index"), [
      value,
      0n,
      10n ** 27n,
    ]),
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
    data: encodeAbiParameters(parseAbiParameters("uint256 value, uint256 balanceIncrease, uint256 index"), [
      value,
      0n,
      10n ** 27n,
    ]),
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
    data: encodeAbiParameters(parseAbiParameters("address user, uint256 amount"), [onBehalfOf, amount]),
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

describe("neverland adapter (offline shape)", () => {
  it("is discoverable as lending supply/withdraw and accountData", () => {
    const registry = offlineRegistry();
    const caps = registry.discover({ protocol: "neverland" });
    expect(caps).toHaveLength(3);
    expect(registry.discover({ verb: "supply" }).some((c) => c.protocol === "neverland")).toBe(
      true,
    );
    expect(registry.discover({ verb: "withdraw" }).some((c) => c.protocol === "neverland")).toBe(
      true,
    );
  });

  it("loads parameter descriptions for supply and withdraw", () => {
    const registry = offlineRegistry();
    const [supply] = registry.load([{ protocol: "neverland", method: "supply" }]);
    expect(supply?.verb).toBe("supply");
    expect(supply?.risk).toEqual(["fundOut", "approval"]);
    expect(Object.keys(supply?.params ?? {})).toEqual(["asset", "amount"]);

    const [withdraw] = registry.load([{ protocol: "neverland", method: "withdraw" }]);
    expect(withdraw?.verb).toBe("withdraw");
    expect(Object.keys(withdraw?.params ?? {})).toEqual(["asset", "amount", "to"]);
  });

  it("builds a supply capability with nested approve + pool transaction", async () => {
    const registry = offlineRegistry();
    stubErc20Metadata(registry);
    const built = (await registry.action("neverland", "supply", ACCOUNT, {
      asset: USDC_ADDRESS,
      amount: "10",
    })) as CapabilityNode;
    const flat = flattenCapabilityTree(built);
    expect(flat).toHaveLength(2);
    expect(flat[0]?.capability).toMatchObject({ protocol: "erc20", method: "approve" });
    expect(flat[1]?.capability).toMatchObject({ protocol: "neverland", method: "supply" });
    expect(flat[1]?.transaction.to).toBe(NEVERLAND_POOL_ADDRESS);
  });

  it("builds a withdraw capability with a single pool transaction", async () => {
    const registry = offlineRegistry();
    stubErc20Metadata(registry);
    const built = (await registry.action("neverland", "withdraw", ACCOUNT, {
      asset: USDC_ADDRESS,
      amount: "1",
      to: ACCOUNT,
    })) as CapabilityNode;
    const flat = flattenCapabilityTree(built);
    expect(flat).toHaveLength(1);
    expect(flat[0]?.transaction.to).toBe(NEVERLAND_POOL_ADDRESS);
  });

  it("rejects native MON supply and withdraw", async () => {
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
  });
});

describe("neverland Receipt coverage", () => {
  it("covers Transfer + Mint + Supply in order", () => {
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
    expect(receipt.protocol).toBe("neverland");
    expect(receipt.outcome).toMatchObject({ operation: "supply", amount: amount.toString() });
    expect(receipt.text).toMatch(/^Supplied /);
    verifyReceiptCoverage(changes, receipt);
  });

  it("fails when Supply event is missing", () => {
    const registry = offlineRegistry();
    const changes = [transferChange(USDC_ADDRESS, USER, NEVERLAND_POOL_ADDRESS, 1_000_000n)];
    expect(() =>
      registry.parseReceipt(capabilityNode("supply", { asset: USDC_ADDRESS, amount: "1" }), changes),
    ).toThrow(/Supply event/);
  });

  it("covers Burn + Transfer + Withdraw in order", () => {
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
    expect(receipt.outcome).toMatchObject({ operation: "withdraw", amount: amount.toString() });
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

  const USDC_WHALE = "0xe52b14240514e7a05ddda336cff0d99ce8bb7230" as const;

  it(
    "Pool and DataProvider have deployed bytecode",
    { timeout: 60_000 },
    async () => {
      const [poolCode, dataCode] = await Promise.all([
        runtime.client.getCode({ address: NEVERLAND_POOL_ADDRESS }),
        runtime.client.getCode({ address: NEVERLAND_DATA_PROVIDER_ADDRESS }),
      ]);
      expect(poolCode && poolCode !== "0x").toBe(true);
      expect(dataCode && dataCode !== "0x").toBe(true);
    },
  );

  it("supplies 0.001 USDC with zero warnings and full receipt", { timeout: 120_000 }, async () => {
    const capability = (await registry.action("neverland", "supply", USDC_WHALE, {
      asset: USDC_ADDRESS,
      amount: "0.001",
    })) as CapabilityNode;

    const simulation = await simulator.simulate(capability);
    expect(simulation.halted).toBeUndefined();
    expect(simulation.results.every((result) => result.warnings.length === 0)).toBe(true);
    const supplyResult = simulation.results.at(-1);
    expect(supplyResult?.protocol).toBe("neverland");
    expect(supplyResult?.method).toBe("supply");
    expect(supplyResult?.receipt?.text).toMatch(/Supplied /);
    expect(supplyResult?.receipt?.outcome).toMatchObject({ operation: "supply" });
  });

  it("reads live account data", { timeout: 60_000 }, async () => {
    const result = await registry.action("neverland", "accountData", USDC_WHALE, {
      user: USDC_WHALE,
    });
    expect(result.kind).toBe("query");
    const data = (result as QueryResult).data as Record<string, string>;
    expect(BigInt(data.totalCollateralBase ?? "0")).toBeGreaterThanOrEqual(0n);
    expect(BigInt(data.healthFactor ?? "0")).toBeGreaterThanOrEqual(0n);
  });
});
