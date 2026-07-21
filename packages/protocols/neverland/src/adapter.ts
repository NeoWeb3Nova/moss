/**
 * Neverland — Monad-native lending (Aave V3) Protocol adapter.
 *
 * Version surface:
 *   v1 — supply / withdraw / accountData / reserveTokens
 *   v2 — borrow / repay (+ receipts, rate mode)
 *   v3 — setCollateral / setEMode / userReserveData / reserveConfig / reservesList
 *
 * Out of scope: liquidation bots, flash loans, rewards, admin mints.
 */
import {
  type ActionCtx,
  type Address,
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
  Protocol,
  type ProtocolRef,
  Query,
  Receipt,
  type ReceiptChange,
  type ReceiptResult,
  type TransactionNode,
} from "@themoss/core";
import { ERC20 } from "@themoss/erc";
import { decodeEventLog, formatUnits, getAddress, parseUnits } from "viem";
import { AavePoolAbi, ATokenAbi, PoolDataProviderAbi } from "./abis/aave.js";
import {
  AAVE_BASE_CURRENCY_DECIMALS,
  AAVE_MAX_HEALTH_FACTOR,
  amountPhrase,
  displayAmount,
  INTEREST_RATE_VARIABLE,
  sameAddress,
} from "./amounts.js";
import {
  accountParams,
  borrowParams,
  collateralParams,
  eModeParams,
  repayParams,
  reserveParams,
  supplyParams,
  userReserveParams,
  withdrawParams,
} from "./params.js";

export {
  AAVE_BASE_CURRENCY_DECIMALS,
  AAVE_MAX_HEALTH_FACTOR,
  INTEREST_RATE_STABLE,
  INTEREST_RATE_VARIABLE,
  KNOWN_ASSET_DECIMALS,
} from "./amounts.js";

/** Neverland Pool proxy — the only address users should call. */
export const NEVERLAND_POOL_ADDRESS: Address = "0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585";

/** Neverland PoolDataProvider — read-only reserve metadata helper. */
export const NEVERLAND_DATA_PROVIDER_ADDRESS: Address =
  "0xfd0b6b6F736376F7B99ee989c749007c7757fDba";

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

export type AmountFields = {
  amountBase: string;
  amountDisplay: string | null;
  decimals: number | null;
};

export type NeverlandSupplyOutcome = {
  operation: "supply";
  asset: AddressValue;
  onBehalfOf: AddressValue;
} & AmountFields;

export type NeverlandWithdrawOutcome = {
  operation: "withdraw";
  asset: AddressValue;
  user: AddressValue;
  to: AddressValue;
} & AmountFields;

export type NeverlandBorrowOutcome = {
  operation: "borrow";
  asset: AddressValue;
  onBehalfOf: AddressValue;
  interestRateMode: number;
  borrowRate: string;
} & AmountFields;

export type NeverlandRepayOutcome = {
  operation: "repay";
  asset: AddressValue;
  user: AddressValue;
  repayer: AddressValue;
  useATokens: boolean;
} & AmountFields;

export type NeverlandCollateralOutcome = {
  operation: "setCollateral";
  asset: AddressValue;
  enabled: boolean;
};

export type NeverlandEModeOutcome = {
  operation: "setEMode";
  user: AddressValue;
  categoryId: number;
};

function asHexTopics(topics: readonly Hex[]): [Hex, ...Hex[]] {
  return topics as [Hex, ...Hex[]];
}

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

function requireErc20(
  asset: string | typeof NATIVE,
  action: string,
): asserts asset is AddressValue {
  if (asset === NATIVE) {
    throw new Error(`Neverland ${action} does not support native MON; wrap to WMON first.`);
  }
}

@Protocol({
  name: "neverland",
  category: "lending",
  description:
    "Neverland: Monad-native Aave V3 lending. Supply, withdraw, borrow, repay, manage collateral/eMode, and read reserve health.",
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

  async #maybeApprove(
    asset: AddressValue,
    owner: AddressValue,
    amount: bigint,
  ): Promise<Array<CapabilityNode | TransactionNode>> {
    const steps: Array<CapabilityNode | TransactionNode> = [];
    const allowanceResult = (await this.erc20.allowance({
      token: asset,
      owner,
      spender: NEVERLAND_POOL_ADDRESS,
    })) as { allowance: string };
    if (BigInt(allowanceResult.allowance) < amount) {
      steps.push(
        await this.erc20.approve({
          token: asset,
          spender: NEVERLAND_POOL_ADDRESS,
          amount: amount.toString(),
        }),
      );
    }
    return steps;
  }

  // ─── v1 writes ───────────────────────────────────────────────────────────

  @Capability<Neverland, typeof supplyParams>({
    intent: "Supply {amount} {asset} to Neverland",
    verb: "supply",
    params: supplyParams,
    receipt: "supplyReceipt",
    risk: ["fundOut", "approval"],
    tags: ["lending", "aave-v3", "v1"],
  })
  async supply(
    params: InferParams<typeof supplyParams>,
    ctx: ActionCtx,
  ): Promise<CapabilityResult> {
    requireErc20(params.asset, "supply");
    const rawAmount = parseUnits(params.amount, await this.#decimals(params.asset));
    const steps = await this.#maybeApprove(params.asset, ctx.account, rawAmount);
    steps.push(this.pool.supply([params.asset, rawAmount, ctx.account, 0]));
    return steps;
  }

  @Capability<Neverland, typeof withdrawParams>({
    intent: "Withdraw {amount} {asset} from Neverland to {to}",
    verb: "withdraw",
    params: withdrawParams,
    receipt: "withdrawReceipt",
    risk: ["fundOut"],
    tags: ["lending", "aave-v3", "v1"],
  })
  async withdraw(
    params: InferParams<typeof withdrawParams>,
    _ctx: ActionCtx,
  ): Promise<CapabilityResult> {
    requireErc20(params.asset, "withdraw");
    const rawAmount = parseUnits(params.amount, await this.#decimals(params.asset));
    return [this.pool.withdraw([params.asset, rawAmount, params.to])];
  }

  // ─── v2 writes ───────────────────────────────────────────────────────────

  @Capability<Neverland, typeof borrowParams>({
    intent: "Borrow {amount} {asset} from Neverland",
    verb: "borrow",
    params: borrowParams,
    receipt: "borrowReceipt",
    risk: ["fundOut"],
    tags: ["lending", "aave-v3", "v2", "debt"],
  })
  async borrow(
    params: InferParams<typeof borrowParams>,
    ctx: ActionCtx,
  ): Promise<CapabilityResult> {
    requireErc20(params.asset, "borrow");
    const rawAmount = parseUnits(params.amount, await this.#decimals(params.asset));
    const mode = params.interestRateMode ?? INTEREST_RATE_VARIABLE;
    return [this.pool.borrow([params.asset, rawAmount, BigInt(mode), 0, ctx.account])];
  }

  @Capability<Neverland, typeof repayParams>({
    intent: "Repay {amount} {asset} debt on Neverland",
    verb: "repay",
    params: repayParams,
    receipt: "repayReceipt",
    risk: ["fundOut", "approval"],
    tags: ["lending", "aave-v3", "v2", "debt"],
  })
  async repay(params: InferParams<typeof repayParams>, ctx: ActionCtx): Promise<CapabilityResult> {
    requireErc20(params.asset, "repay");
    const rawAmount = parseUnits(params.amount, await this.#decimals(params.asset));
    const mode = params.interestRateMode ?? INTEREST_RATE_VARIABLE;
    const steps = await this.#maybeApprove(params.asset, ctx.account, rawAmount);
    steps.push(this.pool.repay([params.asset, rawAmount, BigInt(mode), ctx.account]));
    return steps;
  }

  // ─── v3 writes ───────────────────────────────────────────────────────────

  @Capability<Neverland, typeof collateralParams>({
    intent: "Set {asset} collateral usage to {useAsCollateral} on Neverland",
    verb: "supply",
    params: collateralParams,
    receipt: "collateralReceipt",
    risk: ["fundOut"],
    tags: ["lending", "aave-v3", "v3", "collateral"],
  })
  async setCollateral(
    params: InferParams<typeof collateralParams>,
    _ctx: ActionCtx,
  ): Promise<CapabilityResult> {
    requireErc20(params.asset, "setCollateral");
    return [this.pool.setUserUseReserveAsCollateral([params.asset, params.useAsCollateral])];
  }

  @Capability<Neverland, typeof eModeParams>({
    intent: "Set Neverland eMode category to {categoryId}",
    verb: "supply",
    params: eModeParams,
    receipt: "eModeReceipt",
    risk: ["fundOut"],
    tags: ["lending", "aave-v3", "v3", "emode"],
  })
  async setEMode(
    params: InferParams<typeof eModeParams>,
    _ctx: ActionCtx,
  ): Promise<CapabilityResult> {
    return [this.pool.setUserEMode([params.categoryId])];
  }

  // ─── Receipts ────────────────────────────────────────────────────────────

  @Receipt()
  supplyReceipt(changes: readonly Change[]): ReceiptResult<NeverlandSupplyOutcome> {
    let primary: NeverlandSupplyOutcome | undefined;
    const parsed = changes.map((change) => {
      if (change.kind === "nativeTransfer") return this.erc20.changesReceipt([change]);
      if (sameAddress(change.address, NEVERLAND_POOL_ADDRESS)) {
        return this.#parsePoolChange(change, (decoded) => {
          if (decoded.eventName === "Supply") {
            if (primary) throw new Error("Neverland supply emitted multiple Supply events");
            const asset = getAddress(decoded.args.reserve);
            const amounts = displayAmount(decoded.args.amount, asset);
            primary = {
              operation: "supply",
              asset,
              ...amounts,
              onBehalfOf: getAddress(decoded.args.onBehalfOf),
            };
            return {
              kind: "change" as const,
              change,
              data: primary,
              text: `Neverland Supply: ${amountPhrase(amounts.amountBase, amounts.amountDisplay, asset)} for ${primary.onBehalfOf}`,
            };
          }
          return this.#poolDiagnostic(change, decoded.eventName, decoded.args);
        });
      }
      return this.#parseTokenSideChange(change);
    });
    if (!primary) throw new Error("Neverland supply Receipt requires a Pool Supply event");
    return {
      kind: "receipt",
      outcome: primary,
      text: `Supplied ${amountPhrase(primary.amountBase, primary.amountDisplay, primary.asset)} to Neverland for ${primary.onBehalfOf}`,
      changes: parsed,
    };
  }

  @Receipt()
  withdrawReceipt(changes: readonly Change[]): ReceiptResult<NeverlandWithdrawOutcome> {
    let primary: NeverlandWithdrawOutcome | undefined;
    const parsed = changes.map((change) => {
      if (change.kind === "nativeTransfer") return this.erc20.changesReceipt([change]);
      if (sameAddress(change.address, NEVERLAND_POOL_ADDRESS)) {
        return this.#parsePoolChange(change, (decoded) => {
          if (decoded.eventName === "Withdraw") {
            if (primary) throw new Error("Neverland withdraw emitted multiple Withdraw events");
            const asset = getAddress(decoded.args.reserve);
            const amounts = displayAmount(decoded.args.amount, asset);
            primary = {
              operation: "withdraw",
              asset,
              ...amounts,
              user: getAddress(decoded.args.user),
              to: getAddress(decoded.args.to),
            };
            return {
              kind: "change" as const,
              change,
              data: primary,
              text: `Neverland Withdraw: ${amountPhrase(amounts.amountBase, amounts.amountDisplay, asset)} to ${primary.to}`,
            };
          }
          return this.#poolDiagnostic(change, decoded.eventName, decoded.args);
        });
      }
      return this.#parseTokenSideChange(change);
    });
    if (!primary) throw new Error("Neverland withdraw Receipt requires a Pool Withdraw event");
    return {
      kind: "receipt",
      outcome: primary,
      text: `Withdrew ${amountPhrase(primary.amountBase, primary.amountDisplay, primary.asset)} from Neverland to ${primary.to}`,
      changes: parsed,
    };
  }

  @Receipt()
  borrowReceipt(changes: readonly Change[]): ReceiptResult<NeverlandBorrowOutcome> {
    let primary: NeverlandBorrowOutcome | undefined;
    const parsed = changes.map((change) => {
      if (change.kind === "nativeTransfer") return this.erc20.changesReceipt([change]);
      if (sameAddress(change.address, NEVERLAND_POOL_ADDRESS)) {
        return this.#parsePoolChange(change, (decoded) => {
          if (decoded.eventName === "Borrow") {
            if (primary) throw new Error("Neverland borrow emitted multiple Borrow events");
            const asset = getAddress(decoded.args.reserve);
            const amounts = displayAmount(decoded.args.amount, asset);
            primary = {
              operation: "borrow",
              asset,
              ...amounts,
              onBehalfOf: getAddress(decoded.args.onBehalfOf),
              interestRateMode: Number(decoded.args.interestRateMode),
              borrowRate: decoded.args.borrowRate.toString(),
            };
            return {
              kind: "change" as const,
              change,
              data: primary,
              text: `Neverland Borrow: ${amountPhrase(amounts.amountBase, amounts.amountDisplay, asset)} mode ${primary.interestRateMode}`,
            };
          }
          return this.#poolDiagnostic(change, decoded.eventName, decoded.args);
        });
      }
      return this.#parseTokenSideChange(change);
    });
    if (!primary) throw new Error("Neverland borrow Receipt requires a Pool Borrow event");
    return {
      kind: "receipt",
      outcome: primary,
      text: `Borrowed ${amountPhrase(primary.amountBase, primary.amountDisplay, primary.asset)} from Neverland for ${primary.onBehalfOf}`,
      changes: parsed,
    };
  }

  @Receipt()
  repayReceipt(changes: readonly Change[]): ReceiptResult<NeverlandRepayOutcome> {
    let primary: NeverlandRepayOutcome | undefined;
    const parsed = changes.map((change) => {
      if (change.kind === "nativeTransfer") return this.erc20.changesReceipt([change]);
      if (sameAddress(change.address, NEVERLAND_POOL_ADDRESS)) {
        return this.#parsePoolChange(change, (decoded) => {
          if (decoded.eventName === "Repay") {
            if (primary) throw new Error("Neverland repay emitted multiple Repay events");
            const asset = getAddress(decoded.args.reserve);
            const amounts = displayAmount(decoded.args.amount, asset);
            primary = {
              operation: "repay",
              asset,
              ...amounts,
              user: getAddress(decoded.args.user),
              repayer: getAddress(decoded.args.repayer),
              useATokens: Boolean(decoded.args.useATokens),
            };
            return {
              kind: "change" as const,
              change,
              data: primary,
              text: `Neverland Repay: ${amountPhrase(amounts.amountBase, amounts.amountDisplay, asset)} for ${primary.user}`,
            };
          }
          return this.#poolDiagnostic(change, decoded.eventName, decoded.args);
        });
      }
      return this.#parseTokenSideChange(change);
    });
    if (!primary) throw new Error("Neverland repay Receipt requires a Pool Repay event");
    return {
      kind: "receipt",
      outcome: primary,
      text: `Repaid ${amountPhrase(primary.amountBase, primary.amountDisplay, primary.asset)} on Neverland for ${primary.user}`,
      changes: parsed,
    };
  }

  @Receipt()
  collateralReceipt(changes: readonly Change[]): ReceiptResult<NeverlandCollateralOutcome> {
    let primary: NeverlandCollateralOutcome | undefined;
    const parsed = changes.map((change) => {
      if (change.kind === "nativeTransfer") return this.erc20.changesReceipt([change]);
      if (sameAddress(change.address, NEVERLAND_POOL_ADDRESS)) {
        return this.#parsePoolChange(change, (decoded) => {
          if (
            decoded.eventName === "ReserveUsedAsCollateralEnabled" ||
            decoded.eventName === "ReserveUsedAsCollateralDisabled"
          ) {
            if (primary)
              throw new Error("Neverland setCollateral emitted multiple collateral events");
            const enabled = decoded.eventName === "ReserveUsedAsCollateralEnabled";
            primary = {
              operation: "setCollateral",
              asset: getAddress(decoded.args.reserve),
              enabled,
            };
            return {
              kind: "change" as const,
              change,
              data: primary,
              text: `Neverland collateral ${enabled ? "enabled" : "disabled"} for ${primary.asset}`,
            };
          }
          return this.#poolDiagnostic(change, decoded.eventName, decoded.args);
        });
      }
      return this.#parseTokenSideChange(change);
    });
    if (!primary) {
      throw new Error("Neverland setCollateral Receipt requires a collateral enable/disable event");
    }
    return {
      kind: "receipt",
      outcome: primary,
      text: `Set collateral ${primary.enabled ? "on" : "off"} for ${primary.asset} on Neverland`,
      changes: parsed,
    };
  }

  @Receipt()
  eModeReceipt(changes: readonly Change[]): ReceiptResult<NeverlandEModeOutcome> {
    let primary: NeverlandEModeOutcome | undefined;
    const parsed = changes.map((change) => {
      if (change.kind === "nativeTransfer") return this.erc20.changesReceipt([change]);
      if (sameAddress(change.address, NEVERLAND_POOL_ADDRESS)) {
        return this.#parsePoolChange(change, (decoded) => {
          if (decoded.eventName === "UserEModeSet") {
            if (primary) throw new Error("Neverland setEMode emitted multiple UserEModeSet events");
            primary = {
              operation: "setEMode",
              user: getAddress(decoded.args.user),
              categoryId: Number(decoded.args.categoryId),
            };
            return {
              kind: "change" as const,
              change,
              data: primary,
              text: `Neverland eMode category ${primary.categoryId} for ${primary.user}`,
            };
          }
          return this.#poolDiagnostic(change, decoded.eventName, decoded.args);
        });
      }
      return this.#parseTokenSideChange(change);
    });
    if (!primary) throw new Error("Neverland setEMode Receipt requires a UserEModeSet event");
    return {
      kind: "receipt",
      outcome: primary,
      text: `Set eMode category ${primary.categoryId} for ${primary.user} on Neverland`,
      changes: parsed,
    };
  }

  // ─── Queries ─────────────────────────────────────────────────────────────

  @Query({
    intent: "Read Neverland account health for {user}",
    params: accountParams,
    tags: ["lending", "health", "v1"],
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
      baseCurrencyDecimals: AAVE_BASE_CURRENCY_DECIMALS,
      totalCollateralBase: totalCollateralBase.toString(),
      totalDebtBase: totalDebtBase.toString(),
      availableBorrowsBase: availableBorrowsBase.toString(),
      currentLiquidationThreshold: currentLiquidationThreshold.toString(),
      ltv: ltv.toString(),
      healthFactor: hf,
      healthFactorInfinite: hf === AAVE_MAX_HEALTH_FACTOR || totalDebtBase === 0n,
    };
  }

  @Query({
    intent: "Resolve Neverland aToken / debt token addresses for {asset}",
    params: reserveParams,
    tags: ["lending", "reserve", "v1"],
  })
  async reserveTokens(params: InferParams<typeof reserveParams>) {
    requireErc20(params.asset, "reserveTokens");
    const [aTokenAddress, stableDebtTokenAddress, variableDebtTokenAddress] =
      await this.dataProvider.read.getReserveTokensAddresses([params.asset]);
    return {
      asset: getAddress(params.asset),
      aToken: getAddress(aTokenAddress),
      stableDebtToken: getAddress(stableDebtTokenAddress),
      variableDebtToken: getAddress(variableDebtTokenAddress),
    };
  }

  @Query({
    intent: "Read a user's Neverland position for {asset}",
    params: userReserveParams,
    tags: ["lending", "reserve", "v3"],
  })
  async userReserveData(params: InferParams<typeof userReserveParams>) {
    requireErc20(params.asset, "userReserveData");
    const [
      currentATokenBalance,
      currentStableDebt,
      currentVariableDebt,
      principalStableDebt,
      scaledVariableDebt,
      stableBorrowRate,
      liquidityRate,
      stableRateLastUpdated,
      usageAsCollateralEnabled,
    ] = await this.dataProvider.read.getUserReserveData([params.asset, params.user]);
    const decimals = await this.#decimals(params.asset);
    return {
      asset: getAddress(params.asset),
      user: params.user,
      decimals,
      currentATokenBalance: currentATokenBalance.toString(),
      currentATokenBalanceDisplay: formatKnown(currentATokenBalance, params.asset, decimals),
      currentStableDebt: currentStableDebt.toString(),
      currentVariableDebt: currentVariableDebt.toString(),
      currentVariableDebtDisplay: formatKnown(currentVariableDebt, params.asset, decimals),
      principalStableDebt: principalStableDebt.toString(),
      scaledVariableDebt: scaledVariableDebt.toString(),
      stableBorrowRate: stableBorrowRate.toString(),
      liquidityRate: liquidityRate.toString(),
      stableRateLastUpdated: Number(stableRateLastUpdated),
      usageAsCollateralEnabled,
    };
  }

  @Query({
    intent: "Read Neverland reserve configuration for {asset}",
    params: reserveParams,
    tags: ["lending", "reserve", "v3"],
  })
  async reserveConfig(params: InferParams<typeof reserveParams>) {
    requireErc20(params.asset, "reserveConfig");
    const [
      decimals,
      ltv,
      liquidationThreshold,
      liquidationBonus,
      reserveFactor,
      usageAsCollateralEnabled,
      borrowingEnabled,
      stableBorrowRateEnabled,
      isActive,
      isFrozen,
    ] = await this.dataProvider.read.getReserveConfigurationData([params.asset]);
    return {
      asset: getAddress(params.asset),
      decimals: Number(decimals),
      /** LTV in basis points (e.g. 8000 = 80%). */
      ltv: ltv.toString(),
      liquidationThreshold: liquidationThreshold.toString(),
      liquidationBonus: liquidationBonus.toString(),
      reserveFactor: reserveFactor.toString(),
      usageAsCollateralEnabled,
      borrowingEnabled,
      stableBorrowRateEnabled,
      isActive,
      isFrozen,
    };
  }

  @Query({
    intent: "List Neverland underlying reserve symbols and addresses",
    params: {},
    tags: ["lending", "reserve", "v3"],
  })
  async reservesList() {
    const tokens = await this.dataProvider.read.getAllReservesTokens();
    return {
      reserves: tokens.map((token) => ({
        symbol: token.symbol,
        asset: getAddress(token.tokenAddress),
      })),
    };
  }

  // ─── private parsers ─────────────────────────────────────────────────────

  #parsePoolChange(
    change: Extract<Change, { kind: "event" }>,
    onPrimary: (decoded: ReturnType<typeof decodeEventLog<typeof AavePoolAbi>>) => ParsedLeaf,
  ): ParsedLeaf {
    let decoded: ReturnType<typeof decodeEventLog<typeof AavePoolAbi>>;
    try {
      decoded = decodeEventLog({
        abi: AavePoolAbi,
        topics: asHexTopics(change.topics),
        data: change.data,
        strict: true,
      });
    } catch {
      // Only ABI-decode failures become diagnostic leaves.
      return this.#unknownEvent(change);
    }
    // Semantic failures (duplicate primary events, etc.) must propagate.
    return onPrimary(decoded);
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

function formatKnown(amount: bigint, _asset: string, decimals: number): string {
  return formatUnits(amount, decimals);
}
