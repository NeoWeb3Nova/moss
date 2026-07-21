// ABI origin: vendored (ADR 0007)
//   source: Aave V3 core contracts — IPool interface plus aToken IAToken events
//   upstream: https://github.com/aave/aave-v3-core/blob/master/contracts/interfaces/IPool.sol
//   commit: master as of 2026-07-16
//   verification: function/event signatures exercised live against the Neverland Pool
//     proxy on Monad mainnet (0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585) via
//     eth_call and event topic matching on rpc.monad.xyz.
//   note: Neverland is built on Aave V3's lending core; the Pool proxy delegates
//     to this interface. The ABI below is the minimal surface used by this adapter.
import { parseAbi } from "viem";

export const AavePoolAbi = parseAbi([
  // core writes
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external",
  "function withdraw(address asset, uint256 amount, address to) external returns (uint256)",

  // account-level read
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",

  // on-chain receipts
  "event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)",
  "event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)",
]);

export const ATokenAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Mint(address indexed caller, address indexed onBehalfOf, uint256 value, uint256 balanceIncrease, uint256 index)",
  "event Burn(address indexed from, address indexed target, uint256 value, uint256 balanceIncrease, uint256 index)",
]);
