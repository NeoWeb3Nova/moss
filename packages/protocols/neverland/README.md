# @themoss/protocol-neverland

Moss Protocol adapter for [Neverland](https://neverland.finance/) — a Monad-native lending market built on Aave V3.

## Scope (v1)

| Method | Kind | Verb / tags | Behaviour |
| --- | --- | --- | --- |
| `supply` | Capability | `supply` · `fundOut`, `approval` | Nested `erc20.approve` **only if** allowance is insufficient; then `Pool.supply` |
| `withdraw` | Capability | `withdraw` · `fundOut` | `Pool.withdraw` of the requested display amount |
| `accountData` | Query | health | Collateral / debt / HF with base-currency unit metadata |
| `reserveTokens` | Query | reserve | aToken + debt token addresses for an underlying |

**Out of scope:** borrow, repay, liquidation.

Native MON is rejected; wrap to WMON first.

## Contracts (Monad mainnet, chainId 143)

| Contract | Address |
| --- | --- |
| Pool (transparent proxy) | `0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585` |
| PoolDataProvider | `0xfd0b6b6F736376F7B99ee989c749007c7757fDba` |

Bytecode and reserve resolution are checked in the live e2e suite.

## Parameters

- Token identity: EVM address or `native` (`native` is rejected for writes/reserves).
- Amounts: human-readable decimals (`"0.001"`). Internally scaled by on-chain `decimals()`.
- Receipt outcomes expose both:
  - `amountBase` — smallest units (from Pool `Supply` / `Withdraw` events)
  - `amountDisplay` — human string when the asset is in the known-decimals table (e.g. USDC = 6)

## Verification model

Writes return a **Capability tree**. Simulation produces ordered **Changes**. Receipts must cover every Change (Pool events, aToken Mint/Burn, ERC-20 transfers, peripheral diagnostics).

Live mainnet e2e (no private key, no broadcast):

1. Bytecode present on Pool + DataProvider  
2. `reserveTokens(USDC)` returns a live aToken  
3. `supply 0.001 USDC` → zero Warnings, display amount `0.001`  
4. **supply → withdraw** state-chained loop (withdraw `0.0009`) → zero Warnings  
5. withdraw with empty position → expected revert  
6. `accountData` includes `baseCurrencyDecimals: 8` and `healthFactorInfinite`

## ABI origin (ADR 0007)

Vendored full Hardhat artifacts from `@aave/core-v3@1.19.3`:

- `abis-src/*.json` + `VENDOR.json`
- `pnpm gen:abis` → `src/abis/aave.ts`
- `test/abis.test.ts` locks generator output

## MCP

`packages/mcp-server` composition root loads:

`system`, `erc`, `kuru`, **`neverland`**

## Development

```bash
# monorepo root
pnpm install && pnpm build
pnpm --filter @themoss/protocol-neverland test   # live e2e if MOSS_SKIP_E2E unset
pnpm test:offline                                # skip live
pnpm --filter @themoss/protocol-neverland gen:abis
```

Example script:

```bash
pnpm --filter @themoss/example-simple-flow neverland
```
