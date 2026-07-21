import { formatUnits } from "viem";

/**
 * Display decimals for common Monad underlyings (Receipt parsers are pure and
 * cannot eth_call). Unknown assets expose amountBase only.
 */
export const KNOWN_ASSET_DECIMALS: Readonly<Record<string, number>> = {
  "0x754704bc059f8c67012fed69bc8a327a5aafb603": 6, // USDC
  "0x00000000efe302beaa2b3e6e1b18d08d69a9012a": 6, // AUSD
  "0x3bd359c1119da7da1d913d1c4d2b7c461115433a": 18, // WMON
  "0x0555e30da8f98308edb960aa94c0db47230d2b9c": 8, // WBTC
  "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242": 18, // WETH-like
};

/** Aave base-currency scale used by getUserAccountData (USD with 8 decimals). */
export const AAVE_BASE_CURRENCY_DECIMALS = 8;

/** Aave sentinel health factor when the account has no debt. */
export const AAVE_MAX_HEALTH_FACTOR =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";

/** Aave V3 InterestRateMode: 1 = stable, 2 = variable. */
export const INTEREST_RATE_VARIABLE = 2;
export const INTEREST_RATE_STABLE = 1;

export function knownDecimals(asset: string): number | null {
  return KNOWN_ASSET_DECIMALS[asset.toLowerCase()] ?? null;
}

export function displayAmount(
  amountBase: bigint | string,
  asset: string,
): {
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

export function amountPhrase(
  amountBase: string,
  amountDisplay: string | null,
  asset: string,
): string {
  if (amountDisplay !== null) return `${amountDisplay} ${asset}`;
  return `${amountBase} (base units) ${asset}`;
}

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
