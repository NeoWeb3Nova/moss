---
"@themoss/protocol-neverland": minor
"@themoss/mcp-server": patch
---

Add Neverland Protocol adapter (Capability/Receipt)

Introduces `@themoss/protocol-neverland` for the Neverland Aave V3 market on
Monad: `supply` and `withdraw` Capabilities with nested ERC-20 approval,
`accountData` Query, exhaustive Receipt parsers, and ADR 0007 vendored full
Aave interface ABIs. The MCP CLI composition root includes the package.
