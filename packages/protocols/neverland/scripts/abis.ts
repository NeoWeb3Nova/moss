/**
 * Deterministic ABI generator: derive src/abis/*.ts purely from committed
 * abis-src/ files + VENDOR.json. No network, no clock.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface SourceSpec {
  file: string;
  exportName: string;
}

export const SOURCES: SourceSpec[] = [
  { file: "IPool.json", exportName: "AavePoolAbi" },
  { file: "IPoolDataProvider.json", exportName: "PoolDataProviderAbi" },
  { file: "IAToken.json", exportName: "ATokenAbi" },
];

export interface VendorInfo {
  name: string;
  version: string;
  tarballSha256: string;
  vendoredAt: string;
  releaseAgeGuardDays: number;
  files: string[];
}

interface AbiEntry {
  type: string;
  name?: string;
}

export function generate(packageRoot: string): string {
  const vendor = JSON.parse(
    readFileSync(join(packageRoot, "abis-src", "VENDOR.json"), "utf8"),
  ) as VendorInfo;

  let generated = `// GENERATED FILE — do not edit by hand.
//   regenerate offline from abis-src/:  pnpm gen:abis
// ABI origin: vendored (ADR 0007)
//   source:   ${vendor.name}@${vendor.version} (npm) — verbatim hardhat artifacts in ../../abis-src/
//   tarball:  sha256 ${vendor.tarballSha256}
//   vendored: ${vendor.vendoredAt} (release-age guard: ${vendor.releaseAgeGuardDays}d)
//   verification: Neverland Pool / PoolDataProvider on Monad mainnet (chainId 143)
//     exercised via eth_getCode + live simulation tests against rpc.monad.xyz.
//   caveat:   Neverland uses upgradeable proxies; call the proxy addresses only.
`;

  for (const source of SOURCES) {
    const raw = readFileSync(join(packageRoot, "abis-src", source.file), "utf8");
    const artifact = JSON.parse(raw) as AbiEntry[] | { abi: AbiEntry[] };
    const abi = Array.isArray(artifact) ? artifact : artifact.abi;
    if (!Array.isArray(abi)) {
      throw new Error(`${source.file}: could not locate an ABI array in the upstream file`);
    }
    generated += `\nexport const ${source.exportName} = ${JSON.stringify(abi, null, 2)} as const;\n`;
  }

  return generated;
}
