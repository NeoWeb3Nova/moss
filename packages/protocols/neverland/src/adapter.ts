/**
 * Neverland — Monad-native lending protocol built on Aave V3.
 *
 * Surface (v1):
 *   - supply / withdraw Capabilities
 *   - accountData / reserveTokens Queries
 *
 * Out of scope: borrow / repay / liquidation (need richer risk modeling).
 *
 * Quirks:
 *   - Always call the Pool transparent proxy, never the implementation.
 *   - aToken addresses are resolved at runtime via PoolDataProvider.
 *   - Non-native supply nests erc20.approve only when allowance is insufficient.
 *   - Receipts cover every ordered Change (Pool events + aToken Mint/Burn +
 *     ERC-20 transfers + peripheral diagnostics); see ADR 0011.
 *   - Outcome amounts include base units and display units when decimals are known.
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
  type CapabilityNode,
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
  type TransactionNode,
  TokenReference,
} from "@themoss/core";
import { ERC20 } from "@themoss/erc";
import { decodeEventLog, formatUnits, getAddress, parseUnits } from "viem";
import { AavePoolAbi, ATokenAbi, PoolDataProviderAbi } from "./abis/aave.js";

/** Neverland Pool proxy — the only address users should call. */
export const NEVERLAND_POOL_ADDRESS: Address = "0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585";

/** Neverland PoolDataProvider — read-only reserve metadata helper. */
export const NEVERLAND_DATA_PROVIDER_ADDRESS: Address =
  "0xfd0b6b6F736376F7B99ee989c749007c7757fDba";

/**
 * Known aToken / contract addresses for Package label rendering
 * (docs.neverland.money + live verification). Runtime aToken discovery still
 * uses PoolDataProvider so newly listed reserves keep working.
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

/**
 * Display decimals for common Monad underlyings (Receipt parsers are pure and
 * cannot eth_call). Unknown assets expose amountBase only.
 */
export const KNOWN_ASSET_DECIMALS: Readonly<Record<string, number>> = {
  "0x754704bc059f8c67012fed69bc8a327a5aafb603": 6, // USDC
  "0x00000000efe302beaa2b3e6e1b18d08d69a9012a": 6, // AUSD
  "0x3bd359c1119da7da1d913d1c4d2b7c461115433a": 18, // WMON
  "0x0555e30da8f98308edb960aa94c0db47230d2b9c": 8, // WBTC (Wrapped)
  "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242": 18, // WETH-like
};

/** Aave base-currency scale used by getUserAccountData (USD with 8 decimals). */
export const AAVE_BASE_CURRENCY_DECIMALS = 8;

/** Aave sentinel health factor when the account has no debt. */
export const AAVE_MAX_HEALTH_FACTOR =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";

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
    description:
      'Quantity in display units (e.g. "0.001"), or a value at least as large as the full aToken balance to withdraw all.',
  },
  to: { type: AddressSchema, description: "Address that receives the withdrawn underlying." },
} satisfies ParamsSpec;

const accountParams = {
  user: { type: AddressSchema, description: "User address whose Neverland account is read." },
} satisfies ParamsSpec;

const reserveParams = {
  asset: {
    type: TokenReference,
    description: "Underlying ERC-20 reserve (not native MON).",
  },
} satisfies ParamsSpec;

export type NeverlandSupplyOutcome = {
  operation: "supply";
  asset: AddressValue;
  /** Underlying amount in the token's smallest unit (from Pool Supply event). */
  amountBase: string;
  /** Human display amount when decimals are known; otherwise null. */
  amountDisplay: string | null;
  decimals: number | null;
  onBehalfOf: AddressValue;
};

export type NeverlandWithdrawOutcome = {
  operation: "withdraw";
  asset: AddressValue;
  amountBase: string;
  amountDisplay: string | null;
  decimals: number | null;
  user: AddressValue;
  to: AddressValue;
};

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function knownDecimals(asset: string): number | null {
  return KNOWN_ASSET_DECIMALS[asset.toLowerCase()] ?? null;
}

function displayAmount(amountBase: bigint | string, asset: string): {
  amountBase: string;
  amountDisplay: string | null;
  decimals: number | null;
} {
  const base = typeof amountBase === "bigint" ? amountBase.toString() : amountBase;
  const decimals = knownDecimals(asset);
  return {
    amountBase: base,
    amountDisplay: decimals === null ? null : formatUnits(BigInt(base), decimals),
    decimals,
  };
}

function amountPhrase(amountBase: string, amountDisplay: string | null, asset: string): string {
  if (amountDisplay !== null) return `${amountDisplay} ${asset}`;
  return `${amountBase} (base units) ${asset}`;
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
    const steps: Array<CapabilityNode | TransactionNode> = [];
    const allowanceResult = (await this.erc20.allowance({
      token: asset,
      owner: ctx.account,
      spender: NEVERLAND_POOL_ADDRESS,
    })) as { allowance: string };
    if (BigInt(allowanceResult.allowance) < rawAmount) {
      steps.push(
        await this.erc20.approve({
          token: asset,
          spender: NEVERLAND_POOL_ADDRESS,
          amount: rawAmount.toString(),
        }),
      );
    }
    steps.push(this.pool.supply([asset, rawAmount, ctx.account, 0]));
    return steps;
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
    // Aave: amount == type(uint256).max withdraws the full aToken balance.
    // Callers that pass a display amount larger than the scaled balance still
    // withdraw only what they hold; we map ordinary display strings via parseUnits.
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
        return this.#parsePoolChange(change, (decoded) => {
          if (decoded.eventName === "Supply") {
            if (supplyEvent) throw new Error("Neverland supply emitted multiple Supply events");
            const asset = getAddress(decoded.args.reserve);
            const amounts = displayAmount(decoded.args.amount, asset);
            supplyEvent = {
              operation: "supply",
              asset,
              ...amounts,
              onBehalfOf: getAddress(decoded.args.onBehalfOf),
            };
            return {
              kind: "change" as const,
              change,
              data: supplyEvent,
              text: `Neverland Supply: ${amountPhrase(amounts.amountBase, amounts.amountDisplay, asset)} for ${supplyEvent.onBehalfOf}`,
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
      text: `Supplied ${amountPhrase(supplyEvent.amountBase, supplyEvent.amountDisplay, supplyEvent.asset)} to Neverland for ${supplyEvent.onBehalfOf}`,
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
        return this.#parsePoolChange(change, (decoded) => {
          if (decoded.eventName === "Withdraw") {
            if (withdrawEvent) {
              throw new Error("Neverland withdraw emitted multiple Withdraw events");
            }
            const asset = getAddress(decoded.args.reserve);
            const amounts = displayAmount(decoded.args.amount, asset);
            withdrawEvent = {
              operation: "withdraw",
              asset,
              ...amounts,
              user: getAddress(decoded.args.user),
              to: getAddress(decoded.args.to),
            };
            return {
              kind: "change" as const,
              change,
              data: withdrawEvent,
              text: `Neverland Withdraw: ${amountPhrase(amounts.amountBase, amounts.amountDisplay, asset)} to ${withdrawEvent.to}`,
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
      text: `Withdrew ${amountPhrase(withdrawEvent.amountBase, withdrawEvent.amountDisplay, withdrawEvent.asset)} from Neverland to ${withdrawEvent.to}`,
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
    const hf = healthFactor.toString();
    return {
      user: params.user,
      /** Aave base currency (USD) amounts use 8 decimals. */
      baseCurrencyDecimals: AAVE_BASE_CURRENCY_DECIMALS,
      totalCollateralBase: totalCollateralBase.toString(),
      totalDebtBase: totalDebtBase.toString(),
      availableBorrowsBase: availableBorrowsBase.toString(),
      /** Basis points style thresholds as returned by Aave (e.g. 8500 = 85%). */
      currentLiquidationThreshold: currentLiquidationThreshold.toString(),
      ltv: ltv.toString(),
      healthFactor: hf,
      healthFactorInfinite: hf === AAVE_MAX_HEALTH_FACTOR || totalDebtBase === 0n,
    };
  }

  @Query({
    intent: "Resolve Neverland aToken / debt token addresses for {asset}",
    params: reserveParams,
    tags: ["lending", "reserve"],
  })
  async reserveTokens(params: InferParams<typeof reserveParams>) {
    const { asset } = params;
    if (asset === NATIVE) {
      throw new Error("Neverland reserves are ERC-20 only; wrap native MON to WMON first.");
    }
    const [aTokenAddress, stableDebtTokenAddress, variableDebtTokenAddress] =
      await this.dataProvider.read.getReserveTokensAddresses([asset]);
    return {
      asset: getAddress(asset),
      aToken: getAddress(aTokenAddress),
      stableDebtToken: getAddress(stableDebtTokenAddress),
      variableDebtToken: getAddress(variableDebtTokenAddress),
    };
  }

  #parsePoolChange(
    change: Extract<Change, { kind: "event" }>,
    onPrimary: (decoded: ReturnType<typeof decodeEventLog<typeof AavePoolAbi>>) => ParsedLeaf,
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
