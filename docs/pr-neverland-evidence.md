# PR evidence: `@themoss/protocol-neverland` (v1–v3)

## Summary

Adds a self-describing Neverland (Aave V3 on Monad mainnet) Protocol package with:

- **v1:** `supply`, `withdraw`, `accountData`, `reserveTokens`
- **v2:** `borrow`, `repay` (variable rate default)
- **v3:** `setCollateral`, `setEMode`, `userReserveData`, `reserveConfig`, `reservesList`

MCP composition root includes `neverland`. Example: `pnpm --filter @themoss/example-simple-flow neverland`.

## Package boundary

- New: `packages/protocols/neverland/**`
- Composition: `packages/mcp-server/src/cli.ts`
- Docs/examples/changeset only; no core/simulator API changes

## Verification commands

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
# offline
MOSS_SKIP_E2E=1 pnpm --filter @themoss/protocol-neverland test
# live mainnet (unsigned debug_traceCall; no key, no broadcast)
unset MOSS_SKIP_E2E
pnpm --filter @themoss/protocol-neverland test
```

## Live happy paths (mainnet simulation)

| Path | Result |
| --- | --- |
| supply 0.001 USDC | zero Warnings; `amountDisplay: "0.001"` |
| supply → withdraw | zero Warnings |
| supply → borrow → repay → withdraw | zero Warnings |
| reserveConfig / reservesList / userReserveData | live data |
| nUSDC label vs `reserveTokens` aToken | match + bytecode |

## Notes for reviewers

1. **USDC decimals = 6** on Monad. ERC-20 Approval text may show base units (`1000`); Neverland Supply text shows display (`0.001`). Same quantity.
2. **`setCollateral` / `setEMode`** use `verb: "supply"` because the closed verb set has no configure verb. Discover by **method / tags** (`collateral`, `emode`, `v3`).
3. Re-enabling collateral when already enabled may emit **no** Pool event → Receipt can fail; agents should avoid no-op toggles.
4. ABI: vendored full `@aave/core-v3@1.19.3` artifacts under `abis-src/` (ADR 0007); `test/abis.test.ts` locks generation.
