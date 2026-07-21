# @themoss/protocol-neverland

Moss Protocol adapter for [Neverland](https://neverland.finance/) — Monad-native **Aave V3** lending.

> **Aave V3** = on-chain protocol generation.  
> **adapter v1 / v2 / v3** = Moss package capability slices (not Aave V1/V2).

## Version surface

| Slice | Methods | Status |
| --- | --- | --- |
| **v1** | `supply`, `withdraw`, `accountData`, `reserveTokens` | ✅ |
| **v2** | `borrow`, `repay` | ✅ |
| **v3** | `setCollateral`, `setEMode`, `userReserveData`, `reserveConfig`, `reservesList` | ✅ |

**Out of scope:** liquidation bots, flash loans, rewards controllers, admin mints.

## Capabilities

| Method | Verb | Risk | Notes |
| --- | --- | --- | --- |
| `supply` | supply | fundOut, approval | Approve only when allowance is low |
| `withdraw` | withdraw | fundOut | Display amount → base units |
| `borrow` | borrow | fundOut | Default `interestRateMode = 2` (variable) |
| `repay` | repay | fundOut, approval | Mode must match debt |
| `setCollateral` | supply* | fundOut | Toggle reserve as collateral |
| `setEMode` | supply* | fundOut | `categoryId`; `0` disables |

\*Closed Moss verb set has no dedicated “configure” verb. Prefer **`method` / tags**
(`collateral`, `emode`, `v3`) over `verb: supply` when discovering these ops.

`setCollateral(true)` when the reserve is **already** enabled may emit no new event;
simulation can then fail Receipt coverage — re-`action` or skip no-op toggles.

## Queries

| Method | Returns |
| --- | --- |
| `accountData` | HF, collateral/debt in Aave base currency (8 decimals) |
| `reserveTokens` | aToken + debt token addresses |
| `userReserveData` | Per-asset aToken balance, variable/stable debt, collateral flag |
| `reserveConfig` | LTV, liquidation threshold, borrow enabled, frozen, … |
| `reservesList` | All underlying symbols + addresses |

## Contracts (Monad mainnet, chainId 143)

| Contract | Address | Source / verification |
| --- | --- | --- |
| Pool proxy | `0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585` | Neverland docs + `eth_getCode` on `rpc.monad.xyz` (2026-07-16 / e2e) |
| PoolDataProvider | `0xfd0b6b6F736376F7B99ee989c749007c7757fDba` | Same; reserve token resolution checked live |

Package labels for known aTokens (e.g. `nUSDC`) are presentation-only; runtime discovery uses `reserveTokens` / PoolDataProvider.

### Amount display note (intent alignment)

USDC on Monad uses **6 decimals**, not 18. ERC-20 Approval Receipt text from `@themoss/erc` prints **base units** (e.g. `1000`), while Neverland Supply text prints **display** (`0.001`). Both refer to the same quantity.

## Amounts

- Inputs: human decimals (`"0.001"`).
- Receipt outcomes: `amountBase` + `amountDisplay` (when decimals known; USDC = 6).
- USDC is ERC-20 with **6** decimals, not 18.

## Live e2e (unsigned mainnet simulation)

```bash
unset MOSS_SKIP_E2E
pnpm --filter @themoss/protocol-neverland test
```

Includes:

- supply display amount  
- supply → withdraw  
- **supply → borrow → repay → withdraw**  
- reserveConfig / reservesList / userReserveData  
- setEMode / setCollateral paths  

No private key; gas is state-overridden.

## ABI (ADR 0007)

Vendored `@aave/core-v3@1.19.3` full artifacts in `abis-src/`; regenerate with `pnpm gen:abis`.

## Example

```bash
pnpm --filter @themoss/example-simple-flow neverland
```
