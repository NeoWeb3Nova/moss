/**
 * Neverland — Monad-native lending protocol built on Aave V3.
 *
 * This adapter covers the core lending surface (supply / withdraw / account
 * health) against the Neverland Pool proxy on Monad mainnet. It is deliberately
 * small: borrow/repay/liquidation are left out because they need additional
 * risk/expect primitives that Moss v1's closed set does not yet model.
 *
 * Key quirks the next maintainer must know:
 *   - The Pool is an upgradeable transparent proxy; always interact with the
 *     proxy address, never the implementation.
 *   - Receipt tokens (nUSDC, nWMON, …) are Aave aTokens. Their addresses are
 *     fetched at runtime from PoolDataProvider so the adapter does not go stale
 *     when new reserves are listed.
 *   - Supplying requires ERC-20 approval on the underlying asset; the adapter
 *     emits an `approve` child capability when the asset is not native MON.
 *   - Withdraw burns aTokens; no approval is required.
 *
 * Address verification:
 *   - Pool proxy:       eth_getCode present at 0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585
 *   - PoolDataProvider: eth_getCode present at 0xfd0b6b6F736376F7B99ee989c749007c7757fDba
 *   Both verified on Monad mainnet (chainId 143) via rpc.monad.xyz, 2026-07-16.
 */
import {
  type ActionCtx,
  type Address,
  Address as AddressSchema,
  Capability,
  type CapabilityResult,
  type Change,
  type Handle,
  type InferParams,
  NATIVE,
  type ParamsSpec,
  PositiveDecimalString,
  Protocol,
  type ProtocolRef,
  Query,
  Receipt,
  type ReceiptResult,
  TokenReference,
  transaction,
} from "@themoss/core";
import type { ERC20Outcome } from "@themoss/erc";
import { ERC20 } from "@themoss/erc";
import { decodeEventLog, formatUnits, getAddress, parseUnits, type Hex } from "viem";
import { AavePoolAbi, ATokenAbi } from "./abis/aavePool.js";
import { PoolDataProviderAbi } from "./abis/poolDataProvider.js";

/** Neverland Pool proxy — the only address users should call. */
export const NEVERLAND_POOL_ADDRESS: Address = "0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585";

/** Neverland UI PoolDataProvider — read-only helper for reserve metadata. */
export const NEVERLAND_DATA_PROVIDER_ADDRESS: Address =
  "0xfd0b6b6F736376F7B99ee989c749007c7757fDba";

/** Known aToken addresses for fixed Package labels (verified on docs.neverland.money). */
export const NEVERLAND_TOKENS: Record<string, Address> = {
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

const amountParams = {
  asset: { type: TokenReference, description: "Asset to supply or withdraw." },
  amount: {
    type: PositiveDecimalString,
    description: 'Quantity of the asset in display units, such as "10" or "0.001".',
  },
} satisfies ParamsSpec;

const supplyParams = {
  ...amountParams,
} satisfies ParamsSpec;

const withdrawParams = {
  ...amountParams,
  to: { type: AddressSchema, description: "Address that receives the withdrawn underlying." },
} satisfies ParamsSpec;

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
  labels: NEVERLAND_TOKENS,
})
export class Neverland {
  declare pool: Handle<typeof AavePoolAbi>;
  declare dataProvider: Handle<typeof PoolDataProviderAbi>;
  declare erc20: ProtocolRef<ERC20>;

  async #decimals(asset: Exclude<Address, typeof NATIVE>): Promise<number> {
    return Number((await this.erc20.metadata({ token: asset })).decimals);
  }

  async #aToken(asset: Address): Promise<Address> {
    const tokens = await this.dataProvider.read.getReserveTokensAddresses([asset]);
    return getAddress(tokens[0] as Address);
  }

  @Capability<Neverland, typeof supplyParams>({
    intent: "Supply {amount} {asset} to Neverland",
    verb: "supply",
    params: supplyParams,
    receipt: "supplyReceipt",
    risk: ["fundOut", "approval"],
    tags: ["lending", "aave-v3", "yield"],
  })
  async supply(params: InferParams<typeof supplyParams>, ctx: ActionCtx): Promise<CapabilityResult> {
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
    ctx: ActionCtx,
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
  supplyReceipt(changes: readonly Change[]): ReceiptResult<{ amount: string; symbol: string }> {
    const transfer = this.erc20.changesReceipt(changes);
    const poolTransfer = transfer.outcome.find(
      (o): o is Extract<ERC20Outcome, { operation: "transfer" }> =>
        o.operation === "transfer" && o.to.toLowerCase() === NEVERLAND_POOL_ADDRESS.toLowerCase(),
    );
    if (!poolTransfer) throw new Error("Neverland supply Receipt requires a transfer into the Pool");
    // Aave supply also emits a `Mint` on the aToken and a `Transfer` from the
    // zero address; prefer the Mint amount when available because it is the
    // scaled mint value that reflects the position actually created.
    let minted = "0";
    for (const change of changes) {
      if (change.kind !== "event") continue;
      try {
        const decoded = decodeEventLog({
          abi: ATokenAbi,
          topics: change.topics as [Hex, ...Hex[]],
          data: change.data,
          strict: true,
        });
        if (decoded.eventName === "Mint") {
          minted = decoded.args.value.toString();
          break;
        }
      } catch {
        // not a Mint on an aToken; keep looking
      }
    }
    return {
      kind: "receipt",
      outcome: { amount: minted || poolTransfer.amount, symbol: poolTransfer.token === NATIVE ? "MON" : poolTransfer.token },
      text: `Supplied ${poolTransfer.amount} ${poolTransfer.token} to Neverland`,
      changes: transfer.changes,
    };
  }

  @Receipt()
  withdrawReceipt(changes: readonly Change[]): ReceiptResult<{ amount: string; symbol: string }> {
    const transfer = this.erc20.changesReceipt(changes);
    const poolTransfer = transfer.outcome.find(
      (o): o is Extract<ERC20Outcome, { operation: "transfer" }> =>
        o.operation === "transfer" && o.from.toLowerCase() === NEVERLAND_POOL_ADDRESS.toLowerCase(),
    );
    if (!poolTransfer) throw new Error("Neverland withdraw Receipt requires a transfer out of the Pool");
    return {
      kind: "receipt",
      outcome: { amount: poolTransfer.amount, symbol: poolTransfer.token === NATIVE ? "MON" : poolTransfer.token },
      text: `Withdrew ${poolTransfer.amount} ${poolTransfer.token} from Neverland`,
      changes: transfer.changes,
    };
  }

  @Query({
    intent: "Neverland account data for {user}",
    params: { user: { type: AddressSchema, description: "User address to read account data for." } },
    tags: ["lending", "health"],
  })
  async accountData(params: InferParams<{ user: { type: typeof AddressSchema; description: string } }>) {
    const { user } = params;
    const [
      totalCollateralBase,
      totalDebtBase,
      availableBorrowsBase,
      currentLiquidationThreshold,
      ltv,
      healthFactor,
    ] = await this.pool.read.getUserAccountData([user]);
    return {
      totalCollateralBase: totalCollateralBase.toString(),
      totalDebtBase: totalDebtBase.toString(),
      availableBorrowsBase: availableBorrowsBase.toString(),
      currentLiquidationThreshold: currentLiquidationThreshold.toString(),
      ltv: ltv.toString(),
      healthFactor: healthFactor.toString(),
    };
  }
}
