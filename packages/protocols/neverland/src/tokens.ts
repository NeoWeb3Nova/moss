import type { TokenRef } from "@themoss/core";

/**
 * Neverland introduces no new tokens of its own. Its receipt tokens (nUSDC,
 * nWMON, etc.) are Aave-style aTokens minted by the Pool and resolved at
 * runtime via PoolDataProvider.getReserveTokensAddresses(). They are therefore
 * not listed here as fixed TokenRefs; the adapter resolves aToken addresses
 * on demand and surfaces them in Receipt outcomes by address once a reserve
 * is chosen (Capability/Receipt model — not legacy quantified expects).
 */
export const TOKENS: readonly TokenRef[] = [];
