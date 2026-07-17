# @themoss/protocol-neverland

Moss protocol adapter for [Neverland](https://neverland.finance/) — a
Monad-native lending market built on Aave V3.

## What this adapter covers

- **Supply** an ERC-20 asset into the Neverland Pool.
- **Withdraw** an asset from the Pool to any address.
- **Account data** query: total collateral, debt, available borrows, LTV,
  liquidation threshold, and health factor.

Borrow/repay/liquidation are intentionally out of scope for v1: they need
additional risk primitives that Moss's closed capability set does not yet
model.

## Contracts

| Contract | Address | Note |
|---|---|---|
| Pool (transparent proxy) | `0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585` | The only address users should call. |
| PoolDataProvider | `0xfd0b6b6F736376F7B99ee989c749007c7757fDba` | Read-only helper for reserve metadata. |

Both verified on Monad mainnet (chainId 143) via `eth_getCode` against
`rpc.monad.xyz` on 2026-07-16.

## Supported assets

The adapter does not hard-code receipt tokens. When a reserve is chosen, the
aToken address is resolved at runtime from `PoolDataProvider.getReserveTokensAddresses()`
so the adapter stays valid when new reserves are listed. Any reserve listed on
Neverland can be supplied or withdrawn by address or symbol (if the symbol is
in the Moss token table).

## Capability semantics

| Method | Verb | Risk | Notes |
|---|---|---|---|
| `supply` | `supply` | `fundOut`, `approval` | Emits `approve` followed by `Pool.supply`. |
| `withdraw` | `withdraw` | `fundOut` | Burns aTokens; no approval needed. |
| `accountData` | query | — | Live account health snapshot. |

## On-chain receipts

Both writes declare `@Event` receipts (`supplyReceipt`, `withdrawReceipt`) and
`confirms` them. Simulation will warn with `CONFIRMATION_MISSING` if the
expected event is absent from the trace.

## ABI provenance

ABIs in `src/abis/` are **vendored** from the Aave V3 core contracts
(`IPool.sol` / `UiPoolDataProviderV3.sol`), commit `master` as of
2026-07-16. Function and event signatures were exercised live against the
Neverland contracts on Monad mainnet via `eth_call` and event-topic matching.
See the header comments in each ABI file for upstream URLs.

## Development

```bash
pnpm install
pnpm -r build
pnpm -r typecheck
MOSS_SKIP_E2E=1 pnpm -r test   # offline; skips live Monad mainnet e2e
```

The e2e tests simulate real transactions against Monad mainnet but never sign
or send anything.
