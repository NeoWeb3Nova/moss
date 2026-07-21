# @themoss/protocol-neverland

Moss Protocol adapter for [Neverland](https://neverland.finance/) — a Monad-native lending market built on Aave V3.

## Scope

| Method | Kind | Verb / tags | Notes |
| --- | --- | --- | --- |
| `supply` | Capability | `supply` · risk `fundOut`, `approval` | Nested `erc20.approve` + `Pool.supply` |
| `withdraw` | Capability | `withdraw` · risk `fundOut` | Burns aTokens; no approval |
| `accountData` | Query | health | Collateral, debt, HF, LTV |

**Out of scope (v1):** borrow, repay, liquidation.

Native MON is not accepted: wrap to WMON first.

## Contracts (Monad mainnet, chainId 143)

| Contract | Address |
| --- | --- |
| Pool (transparent proxy) | `0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585` |
| PoolDataProvider | `0xfd0b6b6F736376F7B99ee989c749007c7757fDba` |

Bytecode is checked in the live e2e suite against `rpc.monad.xyz`.

## Parameters

- Token identity: **EVM address or `native` only** (native rejected for supply/withdraw).
- Amounts: human-readable decimal strings (e.g. `"0.001"`); the adapter scales by on-chain decimals.
- aToken addresses: resolved at runtime via `PoolDataProvider.getReserveTokensAddresses`.

## Verification model

Writes return a **Capability tree**. Simulation produces ordered **Changes**; `@Receipt` parsers (`supplyReceipt` / `withdrawReceipt`) must cover every Change exactly once (Pool `Supply`/`Withdraw`, aToken `Mint`/`Burn`, ERC-20 transfers, and other observed pool diagnostics).

## ABI origin (ADR 0007)

Vendored full Hardhat artifacts from `@aave/core-v3@1.19.3`:

- sources: `abis-src/IPool.json`, `IPoolDataProvider.json`, `IAToken.json`
- generator: `pnpm gen:abis` → `src/abis/aave.ts`
- lock: `test/abis.test.ts` asserts generator output matches the committed file

## Development

```bash
# from monorepo root
pnpm install
pnpm build
pnpm --filter @themoss/protocol-neverland test   # includes offline; live if MOSS_SKIP_E2E unset
pnpm test:offline                                   # skips live e2e
```

Regenerate ABIs after editing `abis-src/`:

```bash
pnpm --filter @themoss/protocol-neverland gen:abis
```

MCP composition root loads this package via `packages/mcp-server` (`system`, `erc`, `kuru`, `neverland`).
