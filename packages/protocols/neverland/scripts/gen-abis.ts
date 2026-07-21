/**
 * Offline regeneration: derive src/abis/aave.ts from committed abis-src/.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "./abis.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
writeFileSync(join(packageRoot, "src/abis/aave.ts"), generate(packageRoot));
console.log("regenerated src/abis/aave.ts from abis-src/ (offline)");
