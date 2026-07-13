import { defineProtocolPackage } from "@themoss/core";
import { MockVault } from "./adapter.js";
import { TOKENS } from "./tokens.js";

export { MOCK_VAULT_ADDRESS, MockVault } from "./adapter.js";
export { TOKENS } from "./tokens.js";

export const mockvaultManifest = defineProtocolPackage({
  name: "mockvault",
  protocols: [MockVault],
  tokens: TOKENS,
});
