# Neverland adapter PR — resume notes

**Branch:** `feat/neverland-adapter`  
**Fork remote:** `https://github.com/NeoWeb3Nova/moss.git` (origin)  
**Upstream:** `https://github.com/nishuzumi/moss.git`  
**Last commit before pause:** `1a49f3f`

## What is already done

- Protocol package: `packages/protocols/neverland`
- v1: `supply`, `withdraw`, `accountData`, `reserveTokens`
- v2: `borrow`, `repay` (variable rate default)
- v3: `setCollateral`, `setEMode`, `userReserveData`, `reserveConfig`, `reservesList`
- Vendored Aave V3 ABI under ADR 0007 (`abis-src/`)
- Offline unit tests + live mainnet e2e (unsigned simulation)
- README with address sources, amount display notes, configure-verb workaround
- PR evidence doc and hardened receipt coverage tests

## What still needs work before opening upstream PR

1. **Run full verification locally and fix any failures**
   ```bash
   pnpm install
   pnpm build
   pnpm typecheck
   pnpm lint
   MOSS_SKIP_E2E=1 pnpm --filter @themoss/protocol-neverland test
   unset MOSS_SKIP_E2E
   pnpm --filter @themoss/protocol-neverland test
   ```

2. **Type / lint / test polish**
   - `adapter.test.ts` imports from `../../../simulator/src/*`; check if Moss convention prefers package exports.
   - `Repay` Receipt text may need verification against actual borrow rate mode semantics.
   - Ensure no unused imports (e.g. `KNOWN_ASSET_DECIMALS` already removed).

3. **ADR / docs alignment**
   - Verify all exported types and decorators match current ADRs in `docs/adr/`.
   - If `mcp-server` composition root is wired, confirm `packages/mcp-server/src/cli.ts` still lists `neverland`.

4. **Changeset**
   - Add a changeset with `pnpm changeset` so the release bot can version the package.

5. **Open PR upstream**
   - Target `nishuzumi/moss:main` from `NeoWeb3Nova/moss:feat/neverland-adapter`.
   - Title idea: `feat(protocols): add Neverland (Aave V3 on Monad) adapter`.
   - Body can use `docs/pr-neverland-evidence.md` as the checklist.

## How to resume

```bash
cd /home/neo/workspace/projects/Web3SummerInternshipProgram-MonadBuilderCamp/experiments/moss
git fetch upstream
git checkout feat/neverland-adapter
# do work, then:
pnpm build && pnpm typecheck && pnpm lint
MOSS_SKIP_E2E=1 pnpm --filter @themoss/protocol-neverland test
```
