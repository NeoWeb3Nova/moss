---
"@themoss/protocol-neverland": minor
"@themoss/mcp-server": patch
---

Add Neverland protocol adapter

Introduces `@themoss/protocol-neverland`, a Moss adapter for the Neverland
Monad-native Aave V3 lending market. Capabilities: `supply`, `withdraw`, and
`accountData` query. The adapter resolves aToken addresses at runtime via the
PoolDataProvider, declares quantified fund flows and approvals, and gates
writes on on-chain `Supply` / `Withdraw` event receipts. The MCP server catalog
now serves the Neverland manifest.
