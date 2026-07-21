# Architecture sync log (local)

| Date | What changed |
|------|----------------|
| 2026-07-20 | Merged upstream Capability/Receipt framework (`1883ae2`). Rewrote local study docs to match. |

## Living docs (source of truth for local learning)

1. [`architecture-explained.zh-CN.md`](./architecture-explained.zh-CN.md) — conversational architecture
2. [`../MOSS-FOR-BEGINNERS.md`](../MOSS-FOR-BEGINNERS.md) — beginner path
3. [`../MOSS-STUDY-NOTES.md`](../MOSS-STUDY-NOTES.md) — source-level notes
4. Upstream: `CONTEXT.md`, `docs/getting-started*.md`, `docs/adr/`, `docs/mcp-tools.md`

## Week 2 submissions — revised 2026-07-20

Camp repo path: `submissions/week-02-tech/`.

| Status | Files |
|--------|--------|
| **Use now (public)** | `moss-architecture-errata.md`, `moss-beginner-guide-v2.md`, `moss-wechat-article-v2.md` |
| Historical only | `moss-beginner-guide.md`, `moss-wechat-article.md` (banner → v2) |
| Lightly updated | `moss-project-introduction.md`, `moss-open-source-challenge.md`, `moss-proof-of-work.md` |
| Process log (unchanged body) | `github-exploration-log-moss.md` (header errata only) |
| Submit cards | `moss-*-submit.md` point to v2 |

When reusing content publicly:

- Capability tree (not Plan)
- Changes + exhaustive Receipt (not expects reconciliation)
- Intent alignment via ordered Receipt texts (not planHash alone)

## Code comment cleanup

- `packages/protocols/neverland/src/tokens.ts` — removed leftover “quantified expects” wording (2026-07-20)
