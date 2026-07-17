import type { KnownToken } from "@themoss/core";

/**
 * Neverland introduces no new tokens of its own. Its receipt tokens (nUSDC,
 * nWMON, etc.) are Aave-style aTokens minted by the Pool and resolved at
 * runtime via PoolDataProvider.getReserveTokensAddresses(). They are therefore
 * not registered in the static token table; the adapter declares them in
 * quantified expects by address once a reserve is chosen.
 */
export const TOKENS: readonly KnownToken[] = [];
