import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generate } from "../scripts/abis.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("neverland ABI provenance", () => {
  it("committed src/abis/aave.ts matches offline generation from abis-src/", () => {
    const committed = readFileSync(join(packageRoot, "src/abis/aave.ts"), "utf8");
    expect(committed).toBe(generate(packageRoot));
  });
});
