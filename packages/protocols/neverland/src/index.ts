import { defineProtocolPackage } from "@themoss/core";
import { Neverland } from "./adapter.js";
import { TOKENS } from "./tokens.js";

export { NEVERLAND_DATA_PROVIDER_ADDRESS, NEVERLAND_POOL_ADDRESS, Neverland } from "./adapter.js";
export { TOKENS } from "./tokens.js";

/**
 * The Neverland protocol manifest. Register it with:
 *   registry.use(neverlandManifest)
 */
export const neverlandManifest = defineProtocolPackage({
  name: "neverland",
  protocols: [Neverland],
  tokens: TOKENS,
});
