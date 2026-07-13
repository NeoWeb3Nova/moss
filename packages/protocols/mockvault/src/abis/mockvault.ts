// ABI origin: hand-written minimal example for learning purposes.
// Not for production — no deployed contract backs this address.
import { parseAbi } from "viem";

export const MockVaultAbi = parseAbi([
  "function deposit() payable",
  "function balanceOf(address owner) view returns (uint256)",
  "event Deposited(address indexed account, uint256 amount)",
]);
