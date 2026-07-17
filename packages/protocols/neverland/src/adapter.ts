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
 *     emits an `approveStep` and declares the approval expectation.
 *   - Withdraw burns aTokens; no approval is required.
 *
 * Address verification:
 *   - Pool proxy:       eth_getCode present at 0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585
 *   - PoolDataProvider: eth_getCode present at 0xfd0b6b6F736376F7B99ee989c749007c7757fDba
 *   Both verified on Monad mainnet (chainId 143) via rpc.monad.xyz, 2026-07-16.
 */
import {
  type Address,
  address,
  Capability,
  type DecodedEvent,
  Event,
  type Handle,
  type ObserveCtx,
  Protocol,
  plan,
  Query,
  token,
  tokenAmount,
} from "@themoss/core";
import { approveStep } from "@themoss/erc";
import { AavePoolAbi } from "./abis/aavePool.js";
import { PoolDataProviderAbi } from "./abis/poolDataProvider.js";

/** Neverland Pool proxy — the only address users should call. */
export const NEVERLAND_POOL_ADDRESS: Address = "0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585";

/** Neverland UI PoolDataProvider — read-only helper for reserve metadata. */
export const NEVERLAND_DATA_PROVIDER_ADDRESS: Address =
  "0xfd0b6b6F736376F7B99ee989c749007c7757fDba";

@Protocol({
  name: "neverland",
  category: "lending",
  description:
    "Neverland: Monad-native Aave V3 lending market. Supply assets to earn yield, withdraw on demand, and check account health.",
  contracts: {
    pool: { abi: AavePoolAbi, addr: NEVERLAND_POOL_ADDRESS },
    dataProvider: { abi: PoolDataProviderAbi, addr: NEVERLAND_DATA_PROVIDER_ADDRESS },
  },
})
export class Neverland {
  declare pool: Handle<typeof AavePoolAbi>;
  declare dataProvider: Handle<typeof PoolDataProviderAbi>;

  async #aToken(asset: Address): Promise<Address> {
    const tokens = await this.dataProvider.read.getReserveTokensAddresses([asset]);
    return tokens[0] as Address;
  }

  @Capability({
    intent: "Supply {amount} {asset} to Neverland",
    verb: "supply",
    params: {
      asset: token,
      amount: tokenAmount("asset"),
    },
    risk: ["fundOut", "approval"],
    tags: ["lending", "aave-v3", "yield"],
    confirms: ["supplyReceipt"],
  })
  async supply({ asset, amount }: { asset: Address; amount: bigint }, ctx: { account: Address }) {
    const aToken = await this.#aToken(asset);
    const steps = [
      approveStep(asset, NEVERLAND_POOL_ADDRESS, amount),
      this.pool.supply([asset, amount, ctx.account, 0]),
    ];
    return plan(steps, {
      out: [{ token: asset, amountMax: amount }],
      in: [{ token: aToken, amountMin: amount }],
    });
  }

  @Capability({
    intent: "Withdraw {amount} {asset} from Neverland to {to}",
    verb: "withdraw",
    params: {
      asset: token,
      amount: tokenAmount("asset"),
      to: address,
    },
    risk: ["fundOut"],
    tags: ["lending", "aave-v3", "yield"],
    confirms: ["withdrawReceipt"],
  })
  async withdraw({ asset, amount, to }: { asset: Address; amount: bigint; to: Address }) {
    const aToken = await this.#aToken(asset);
    return plan([this.pool.withdraw([asset, amount, to])], {
      out: [{ token: aToken, amountMax: amount }],
      in: [{ token: asset, amountMin: amount }],
    });
  }

  @Event<Neverland>({
    events: { pool: ["Supply"] },
    intent: "Supplied {amount} {symbol} to Neverland",
  })
  async supplyReceipt(events: DecodedEvent[], ctx: ObserveCtx) {
    const e = events.find((ev) => ev.name === "Supply");
    if (!e) return null;
    const { reserve, amount } = e.args as { reserve: Address; amount: bigint };
    const t = await ctx.token(reserve);
    return { amount: t.format(amount), symbol: t.symbol };
  }

  @Event<Neverland>({
    events: { pool: ["Withdraw"] },
    intent: "Withdrew {amount} {symbol} from Neverland",
  })
  async withdrawReceipt(events: DecodedEvent[], ctx: ObserveCtx) {
    const e = events.find((ev) => ev.name === "Withdraw");
    if (!e) return null;
    const { reserve, amount } = e.args as { reserve: Address; amount: bigint };
    const t = await ctx.token(reserve);
    return { amount: t.format(amount), symbol: t.symbol };
  }

  @Query({
    intent: "Neverland account data for {user}",
    params: { user: address },
    tags: ["lending", "health"],
  })
  async accountData({ user }: { user: Address }) {
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
