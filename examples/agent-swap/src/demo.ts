/**
 * 手动演示 agent-swap 的完整闭环：
 * 1. 连接本地 Monad mainnet fork
 * 2. 用 Moss 构建 swap Plan
 * 3. simulate 验证
 * 4. 输出 Plan 供本地钱包签名发送
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Plan, Registry } from "@themoss/core";
import { ercManifest } from "@themoss/erc";
import { kuruManifest } from "@themoss/protocol-kuru";
import { createTraceSimulator } from "@themoss/simulator";
import { monadRuntime, systemManifest } from "@themoss/system";
import { FORK_RPC_URL, devAccount, rpc } from "./dev-wallet.js";

const runtime = monadRuntime({ rpcUrl: FORK_RPC_URL });
const registry = new Registry(runtime);
for (const manifest of [systemManifest, ercManifest, kuruManifest]) registry.use(manifest);
const simulator = createTraceSimulator(runtime, { observer: registry.observer() });

const account = devAccount.address;

async function printBalances(label: string) {
  const mon = await rpc<string>("eth_getBalance", [account, "latest"]);
  console.log(`${label}: ${Number(mon) / 1e18} MON`);
}

console.log("\n=== 1. discover — 找到能 swap 的协议 ===");
const coords = registry.discover({ verb: "swap", category: "dex" });
console.log(JSON.stringify(coords, null, 2));

console.log("\n=== 2. load — 获取 Kuru swap 的调用方式 ===");
const [stub] = registry.load([{ protocol: "kuru", method: "swap" }]);
console.log(JSON.stringify(stub, null, 2));

console.log("\n=== 3. action — 构建 Plan ===");
const plan = (await registry.action("kuru", "swap", account, {
  tokenIn: "MON",
  tokenOut: "USDC",
  amount: "10",
  slippage: 100,
})) as Plan;
console.log("intent:", plan.intent);
console.log("expects:", JSON.stringify(plan.expects, null, 2));
console.log("txs count:", plan.txs.length);

console.log("\n=== 4. simulate — 验证 Plan ===");
await printBalances("before swap");
const { results } = await simulator.simulate([plan]);
const [result] = results;
console.log("reverted:", result?.reverted);
console.log("effects:", JSON.stringify(result?.effects, null, 2));
console.log("observations:", JSON.stringify(result?.observations, null, 2));
console.log("warnings:", JSON.stringify(result?.warnings, null, 2));

if (result?.warnings.length === 0) {
  console.log("\n✓ No warnings — ready to sign and send.");
  const planPath = join(tmpdir(), "moss-swap-plan.json");
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  console.log(`Plan written to ${planPath}`);
  console.log("\nNext step: send it with the wallet:");
  console.log(`pnpm --filter @themoss/example-agent-swap wallet send ${planPath}`);
} else {
  console.log("\n✗ Warnings present — do not sign.");
  process.exitCode = 1;
}
