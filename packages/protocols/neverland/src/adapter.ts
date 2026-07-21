/**
 * Neverland — Monad-native lending protocol built on Aave V3.
 *
 * Surface (v1):
 *   - supply / withdraw Capabilities
 *   - accountData Query
 *
 * Out of scope: borrow / repay / liquidation (need richer risk modeling).
 *
 * Quirks:
 *   - Always call the Pool transparent proxy, never the implementation.
 *   - aToken addresses are resolved at runtime via PoolDataProvider.
 *   - Non-native supply nests an erc20.approve Capability before Pool.supply.
 *   - Receipts must cover every ordered Change (Pool events + aToken Mint/Burn
 *     + underlying ERC-20 transfers); see ADR 0011.
 *
 * Address verification (Monad mainnet, chainId 143, rpc.monad.xyz):
 *   - Pool proxy:       0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585 (eth_getCode)
 *   - PoolDataProvider: 0xfd0b6b6F736376F7B99ee989c749007c7757fDba (eth_getCode)
 *   Checked live in test/adapter.test.ts.
 */
import {
  type ActionCtx,
  type Address,
  Address as AddressSchema,
  type AddressValue,
  Capability,
  type CapabilityResult,
  type Change,
  type Handle,
  type Hex,
  type InferParams,
  type JsonSafeValue,
  NATIVE,
  type ParamsSpec,
  PositiveDecimalString,
  Protocol,
  type ProtocolRef,
  Query,
  Receipt,
  type ReceiptChange,
  type ReceiptResult,
  TokenReference,
} from "@themoss/core";
import { ERC20 } from "@themoss/erc";
import { decodeEventLog, getAddress, parseUnits } from "viem";
import { AavePoolAbi, ATokenAbi, PoolDataProviderAbi } from "./abis/aave.js";

/** Neverland Pool proxy — the only address users should call. */
export const NEVERLAND_POOL_ADDRESS: Address = "0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585";

/** Neverland PoolDataProvider — read-only reserve metadata helper. */
export const NEVERLAND_DATA_PROVIDER_ADDRESS: Address =
  "0xfd0b6b6F736376F7B99ee989c749007c7757fDba";

/**
 * Known aToken addresses for Package label rendering only (docs.neverland.money).
 * Runtime aToken discovery still uses PoolDataProvider for new reserves.
 */
export const NEVERLAND_PACKAGE_LABELS: Record<string, Address> = {
  Pool: NEVERLAND_POOL_ADDRESS,
  DataProvider: NEVERLAND_DATA_PROVIDER_ADDRESS,
  nWMON: "0xD0fd2Cf7F6CEff4F96B1161F5E995D5843326154",
  nWBTC: "0x34c43684293963c546b0aB6841008A4d3393B9ab",
  nWETH: "0x31f63Ae5a96566b93477191778606BeBDC4CA66f",
  nAUSD: "0x784999fc2Dd132a41D1Cc0F1aE9805854BaD1f2D",
  nUSDC: "0x38648958836eA88b368b4ac23b86Ad44B0fe7508",
  nUSDT0: "0x39F901c32b2E0d25AE8DEaa1ee115C748f8f6bDf",
  nSMON: "0xdFC14d336aea9E49113b1356333FD374e646Bf85",
  nGMON: "0x7f81779736968836582D31D36274Ed82053aD1AE",
  nSHMON: "0xC64d73Bb8748C6fA7487ace2D0d945B6fBb2EcDe",
};

const supplyParams = {
  asset: { type: TokenReference, description: "ERC-20 asset to supply (not native MON)." },
  amount: {
    type: PositiveDecimalString,
    description: 'Quantity of the asset in display units, such as "10" or "0.001".',
  },
} satisfies ParamsSpec;

const withdrawParams = {
  asset: { type: TokenReference, description: "ERC-20 asset to withdraw (not native MON)." },
  amount: {
    type: PositiveDecimalString,
    description: 'Quantity of the asset in display units, such as "10" or "0.001".',
  },
  to: { type: AddressSchema, description: "Address that receives the withdrawn underlying." },
} satisfies ParamsSpec;

const accountParams = {
  user: { type: AddressSchema, description: "User address whose Neverland account is read." },
} satisfies ParamsSpec;

export type NeverlandSupplyOutcome = {
  operation: "supply";
  asset: AddressValue;
  amount: string;
  onBehalfOf: AddressValue;
};

export type NeverlandWithdrawOutcome = {
  operation: "withdraw";
  asset: AddressValue;
  amount: string;
  user: AddressValue;
  to: AddressValue;
};

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function asHexTopics(topics: readonly Hex[]): [Hex, ...Hex[]] {
  return topics as [Hex, ...Hex[]];
}

/** ABI decode args may contain bigint; Receipt data must be JSON-safe. */
function jsonSafeArgs(value: unknown): JsonSafeValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number in event args");
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafeArgs);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, jsonSafeArgs(entry)]),
    );
  }
  throw new TypeError(`unsupported event arg type ${typeof value}`);
}

type ParsedLeaf = ReceiptChange | ReceiptResult<JsonSafeValue>;

@Protocol({
  name: "neverland",
  category: "lending",
  description:
    "Neverland: Monad-native Aave V3 lending market. Supply assets to earn yield, withdraw on demand, and check account health.",
  contracts: {
    pool: { abi: AavePoolAbi, addr: NEVERLAND_POOL_ADDRESS },
    dataProvider: { abi: PoolDataProviderAbi, addr: NEVERLAND_DATA_PROVIDER_ADDRESS },
  },
  protocols: { erc20: ERC20 },
  labels: NEVERLAND_PACKAGE_LABELS,
})
export class Neverland {
  declare pool: Handle<typeof AavePoolAbi>;
  declare dataProvider: Handle<typeof PoolDataProviderAbi>;
  declare erc20: ProtocolRef<ERC20>;

  async #decimals(asset: AddressValue): Promise<number> {
    return Number((await this.erc20.metadata({ token: asset })).decimals);
  }

  @Capability<Neverland, typeof supplyParams>({
    intent: "Supply {amount} {asset} to Neverland",
    verb: "supply",
    params: supplyParams,
    receipt: "supplyReceipt",
    risk: ["fundOut", "approval"],
    tags: ["lending", "aave-v3", "yield"],
  })
  async supply(
    params: InferParams<typeof supplyParams>,
    ctx: ActionCtx,
  ): Promise<CapabilityResult> {
    const { asset, amount } = params;
    if (asset === NATIVE) {
      throw new Error("Neverland does not support native MON supply; wrap to WMON first.");
    }
    const decimals = await this.#decimals(asset);
    const rawAmount = parseUnits(amount, decimals);
    return [
      await this.erc20.approve({
        token: asset,
        spender: NEVERLAND_POOL_ADDRESS,
        amount: rawAmount.toString(),
      }),
      this.pool.supply([asset, rawAmount, ctx.account, 0]),
    ];
  }

  @Capability<Neverland, typeof withdrawParams>({
    intent: "Withdraw {amount} {asset} from Neverland to {to}",
    verb: "withdraw",
    params: withdrawParams,
    receipt: "withdrawReceipt",
    risk: ["fundOut"],
    tags: ["lending", "aave-v3", "yield"],
  })
  async withdraw(
    params: InferParams<typeof withdrawParams>,
    _ctx: ActionCtx,
  ): Promise<CapabilityResult> {
    const { asset, amount, to } = params;
    if (asset === NATIVE) {
      throw new Error("Neverland does not support native MON withdraw; use WMON.");
    }
    const decimals = await this.#decimals(asset);
    const rawAmount = parseUnits(amount, decimals);
    return [this.pool.withdraw([asset, rawAmount, to])];
  }

  @Receipt()
  supplyReceipt(changes: readonly Change[]): ReceiptResult<NeverlandSupplyOutcome> {
    let supplyEvent: NeverlandSupplyOutcome | undefined;
    const parsed: ParsedLeaf[] = changes.map((change) => {
      if (change.kind === "nativeTransfer") {
        return this.erc20.changesReceipt([change]);
      }
      if (sameAddress(change.address, NEVERLAND_POOL_ADDRESS)) {
        return this.#parsePoolChange(change, "supply", (decoded) => {
          if (decoded.eventName === "Supply") {
            if (supplyEvent) throw new Error("Neverland supply emitted multiple Supply events");
            supplyEvent = {
              operation: "supply",
              asset: getAddress(decoded.args.reserve),
              amount: decoded.args.amount.toString(),
              onBehalfOf: getAddress(decoded.args.onBehalfOf),
            };
            return {
              kind: "change" as const,
              change,
              data: supplyEvent,
              text: `Neverland Supply: ${supplyEvent.amount} ${supplyEvent.asset} for ${supplyEvent.onBehalfOf}`,
            };
          }
          return this.#poolDiagnostic(change, decoded.eventName, decoded.args);
        });
      }
      return this.#parseTokenSideChange(change);
    });

    if (!supplyEvent) throw new Error("Neverland supply Receipt requires a Pool Supply event");
    return {
      kind: "receipt",
      outcome: supplyEvent,
      text: `Supplied ${supplyEvent.amount} ${supplyEvent.asset} to Neverland for ${supplyEvent.onBehalfOf}`,
      changes: parsed,
    };
  }

  @Receipt()
  withdrawReceipt(changes: readonly Change[]): ReceiptResult<NeverlandWithdrawOutcome> {
    let withdrawEvent: NeverlandWithdrawOutcome | undefined;
    const parsed: ParsedLeaf[] = changes.map((change) => {
      if (change.kind === "nativeTransfer") {
        return this.erc20.changesReceipt([change]);
      }
      if (sameAddress(change.address, NEVERLAND_POOL_ADDRESS)) {
        return this.#parsePoolChange(change, "withdraw", (decoded) => {
          if (decoded.eventName === "Withdraw") {
            if (withdrawEvent) {
              throw new Error("Neverland withdraw emitted multiple Withdraw events");
            }
            withdrawEvent = {
              operation: "withdraw",
              asset: getAddress(decoded.args.reserve),
              amount: decoded.args.amount.toString(),
              user: getAddress(decoded.args.user),
              to: getAddress(decoded.args.to),
            };
            return {
              kind: "change" as const,
              change,
              data: withdrawEvent,
              text: `Neverland Withdraw: ${withdrawEvent.amount} ${withdrawEvent.asset} to ${withdrawEvent.to}`,
            };
          }
          return this.#poolDiagnostic(change, decoded.eventName, decoded.args);
        });
      }
      return this.#parseTokenSideChange(change);
    });

    if (!withdrawEvent) {
      throw new Error("Neverland withdraw Receipt requires a Pool Withdraw event");
    }
    return {
      kind: "receipt",
      outcome: withdrawEvent,
      text: `Withdrew ${withdrawEvent.amount} ${withdrawEvent.asset} from Neverland to ${withdrawEvent.to}`,
      changes: parsed,
    };
  }

  @Query({
    intent: "Read Neverland account health for {user}",
    params: accountParams,
    tags: ["lending", "health"],
  })
  async accountData(params: InferParams<typeof accountParams>) {
    const [
      totalCollateralBase,
      totalDebtBase,
      availableBorrowsBase,
      currentLiquidationThreshold,
      ltv,
      healthFactor,
    ] = await this.pool.read.getUserAccountData([params.user]);
    return {
      totalCollateralBase: totalCollateralBase.toString(),
      totalDebtBase: totalDebtBase.toString(),
      availableBorrowsBase: availableBorrowsBase.toString(),
      currentLiquidationThreshold: currentLiquidationThreshold.toString(),
      ltv: ltv.toString(),
      healthFactor: healthFactor.toString(),
    };
  }

  #parsePoolChange(
    change: Extract<Change, { kind: "event" }>,
    _operation: "supply" | "withdraw",
    onPrimary: (
      decoded: ReturnType<typeof decodeEventLog<typeof AavePoolAbi>>,
    ) => ParsedLeaf,
  ): ParsedLeaf {
    try {
      const decoded = decodeEventLog({
        abi: AavePoolAbi,
        topics: asHexTopics(change.topics),
        data: change.data,
        strict: true,
      });
      return onPrimary(decoded);
    } catch {
      // Proxies may emit peripheral events not in IPool; still cover the Change.
      return this.#unknownEvent(change);
    }
  }

  #poolDiagnostic(
    change: Extract<Change, { kind: "event" }>,
    eventName: string,
    args: unknown,
  ): ReceiptChange {
    return {
      kind: "change",
      change,
      data: { event: eventName, emitter: change.address, args: jsonSafeArgs(args) },
      text: `Neverland Pool ${eventName} at ${change.address}`,
    };
  }

  /**
   * aToken Mint/Burn/Transfer, plain ERC-20 Transfer/Approval, or an opaque
   * diagnostic leaf for peripheral events from interest strategies / oracles.
   */
  #parseTokenSideChange(change: Extract<Change, { kind: "event" }>): ParsedLeaf {
    try {
      const decoded = decodeEventLog({
        abi: ATokenAbi,
        topics: asHexTopics(change.topics),
        data: change.data,
        strict: true,
      });
      if (decoded.eventName === "Mint") {
        const data = {
          event: "Mint",
          emitter: change.address,
          caller: getAddress(decoded.args.caller),
          onBehalfOf: getAddress(decoded.args.onBehalfOf),
          value: decoded.args.value.toString(),
          balanceIncrease: decoded.args.balanceIncrease.toString(),
          index: decoded.args.index.toString(),
        } as const;
        return {
          kind: "change",
          change,
          data,
          text: `aToken Mint: ${data.value} to ${data.onBehalfOf} at ${data.emitter}`,
        };
      }
      if (decoded.eventName === "Burn") {
        const data = {
          event: "Burn",
          emitter: change.address,
          from: getAddress(decoded.args.from),
          target: getAddress(decoded.args.target),
          value: decoded.args.value.toString(),
          balanceIncrease: decoded.args.balanceIncrease.toString(),
          index: decoded.args.index.toString(),
        } as const;
        return {
          kind: "change",
          change,
          data,
          text: `aToken Burn: ${data.value} from ${data.from} at ${data.emitter}`,
        };
      }
      if (decoded.eventName === "Transfer" || decoded.eventName === "Approval") {
        return this.erc20.changesReceipt([change]);
      }
      return {
        kind: "change",
        change,
        data: {
          event: decoded.eventName,
          emitter: change.address,
          args: jsonSafeArgs(decoded.args),
        },
        text: `aToken ${decoded.eventName} at ${change.address}`,
      };
    } catch {
      // Fall through.
    }
    try {
      return this.erc20.changesReceipt([change]);
    } catch {
      return this.#unknownEvent(change);
    }
  }

  #unknownEvent(change: Extract<Change, { kind: "event" }>): ReceiptChange {
    const topic0 = change.topics[0] ?? "0x";
    return {
      kind: "change",
      change,
      data: {
        event: "unknown",
        emitter: change.address,
        topic0,
        topics: [...change.topics],
        data: change.data,
      },
      text: `Unclassified event ${topic0} at ${change.address}`,
    };
  }
}
