/** discover → load → action → simulate for Neverland USDC supply (mainnet, unsigned). */
import { Registry } from "@themoss/core";
import * as erc from "@themoss/erc";
import * as neverland from "@themoss/protocol-neverland";
import { createTraceSimulator } from "@themoss/simulator";
import * as system from "@themoss/system";
import { monadRuntime, USDC_ADDRESS } from "@themoss/system";

const ACCOUNT = (process.env.MOSS_ACCOUNT ??
  "0xe52b14240514e7a05ddda336cff0d99ce8bb7230") as `0x${string}`;

const runtime = await monadRuntime({
  ...(process.env.MOSS_RPC_URL ? { rpcUrl: process.env.MOSS_RPC_URL } : {}),
});
const registry = new Registry(runtime, {
  trustedTokens: [{ address: USDC_ADDRESS, label: "USDC" }],
}).use(system, erc, neverland);
const simulator = createTraceSimulator(runtime, {
  receipt: (capability, changes) => registry.parseReceipt(capability, changes),
});

console.log("1. discover", registry.discover({ protocol: "neverland" }));
console.log("2. load", registry.load([{ protocol: "neverland", method: "supply" }]));

const capability = await registry.action("neverland", "supply", ACCOUNT, {
  asset: USDC_ADDRESS,
  amount: "0.001",
});
if (capability.kind !== "capability") throw new Error("expected a Capability");
console.log("3. action", JSON.stringify(capability, null, 2));

const outcome = await simulator.simulate(capability);
console.log("4. simulate", JSON.stringify(outcome, null, 2));
if (outcome.halted || outcome.results.some(({ warnings }) => warnings.length > 0)) {
  console.error("Warnings present. Stop; do not sign.");
  process.exitCode = 1;
} else {
  for (const result of outcome.results) console.log(result.receipt?.text);
  console.log("Compare the ordered Receipts with the user's intent before signing.");
}
