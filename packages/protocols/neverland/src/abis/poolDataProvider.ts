// ABI origin: vendored (ADR 0007)
//   source: Aave V3 core contracts — UiPoolDataProvider / PoolDataProvider interface
//   upstream: https://github.com/aave/aave-v3-core/blob/master/contracts/misc/UiPoolDataProviderV3.sol
//   commit: master as of 2026-07-16
//   verification: getReserveTokensAddresses() called live against the Neverland
//     PoolDataProvider on Monad mainnet (0xfd0b6b6F736376F7B99ee989c749007c7757fDba)
//     and its returned aToken addresses matched the Neverland docs.
import { parseAbi } from "viem";

export const PoolDataProviderAbi = parseAbi([
  "function getReserveTokensAddresses(address asset) view returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress)",
]);
