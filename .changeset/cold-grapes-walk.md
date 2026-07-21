---
"@themoss/protocol-neverland": minor
"@themoss/mcp-server": patch
---

Add complete Neverland Protocol adapter (Capability/Receipt)

Introduces `@themoss/protocol-neverland` for the Neverland Aave V3 market on
Monad: `supply` / `withdraw` Capabilities (approve only when needed),
`accountData` and `reserveTokens` Queries, exhaustive Receipt parsers with
base + display amounts, ADR 0007 vendored full Aave ABIs, MCP composition,
and live mainnet e2e including a supply→withdraw state-chained loop.
