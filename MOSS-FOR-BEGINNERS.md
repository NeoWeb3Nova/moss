# Moss 小白入门指南：从零到一理解 Agent × DeFi 交互层

> 作者：Neo × Nova001  
> 初稿：2026-07-14  
> **架构同步：2026-07-20**（Capability Tree + Exhaustive Receipt）  
> 适合读者：会基本 JavaScript/TypeScript，想理解 Moss 是什么、为什么需要它、怎么用它。  
> 更细的源码笔记：[MOSS-STUDY-NOTES.md](./MOSS-STUDY-NOTES.md)  
> 通俗架构图解：[docs/architecture-explained.zh-CN.md](./docs/architecture-explained.zh-CN.md)

---

## 第零步：为什么需要 Moss？

### 想象一个场景

你对 AI Agent 说：

> 「帮我在 Monad 上把 1 MON 换成 USDC。」

如果没有 Moss，Agent 需要自己搞清楚：

- 哪个 DEX？路由器地址？  
- exact-in 还是 target-output？  
- 要不要先 wrap？滑点怎么设？  
- 失败了怎么办？  

任何一个细节错了，资金都可能走错路径。

### Moss 做什么？

把 Moss 想成**协议超市 + 试衣间**：

- 每个协议（WMON、Kuru、ERC-20…）是一个货架  
- 每个能力（swap、wrap、transfer…）是一件商品  
- Agent 按标准流程选商品、填参数  
- **付款（签名）前**，在模拟器里完整试穿一遍，并拿到可核对的小票文字  

**最重要的一句话：Moss 只构建和模拟，永远不签名、不发送交易。**

---

## 第一步：把 Moss 跑起来

### 环境

- Node.js ≥ 22  
- pnpm 11  

### 安装与构建

```bash
git clone https://github.com/nishuzumi/moss   # 或你的 fork
cd moss
pnpm install
pnpm build
pnpm test:offline
```

### 第一个例子（不需要私钥）

```bash
# WMON wrap 全流程
pnpm --filter @themoss/example-simple-flow wrap

# Kuru MON → USDC 报价 + 模拟
pnpm --filter @themoss/example-simple-flow swap
```

成功时会提示：把**有序 Receipt 文字**与用户意图对比后，才可以把未签名交易交给钱包。  
若有 Warning：停止，不要签名。

---

## 第二步：四步流程

```
discover → load → action → simulate
```

| 步骤 | Agent 在问 | Moss 在做 | 超市类比 |
|------|------------|-----------|----------|
| **discover** | 我想 wrap / swap… | 返回 protocol + method 坐标 | 找到货架 |
| **load** | 这个操作怎么调？ | intent、risk、参数类型与说明 | 看商品详情 |
| **action** | 请按参数组装 | 返回 **Capability 树**（未签名） | 装进购物车 |
| **simulate** | 这样安全吗？ | 链上模拟 → 穷尽解析 → 文字证据 | 结账前试衣 + 小票 |

> **注意：** 旧资料里的 `Plan` / `expects` / `planHash` 已废弃。  
> 现在 action 产出的是 **Capability tree**；安全证据是模拟产生的 **Changes + Receipt**，不是作者事先声明的数量。

---

## 第三步：用代码走一遍（WMON wrap）

### 1. 组装 Registry

```ts
import { Registry } from "@themoss/core";
import * as erc from "@themoss/erc";
import * as kuru from "@themoss/protocol-kuru";
import { createTraceSimulator } from "@themoss/simulator";
import * as system from "@themoss/system";
import { monadRuntime } from "@themoss/system";

const runtime = await monadRuntime();
const registry = new Registry(runtime).use(system, erc, kuru);
const simulator = createTraceSimulator(runtime, {
  receipt: (capability, changes) => registry.parseReceipt(capability, changes),
});
```

Registry **默认是空的**，必须 `use(...)` 显式装载协议。

### 2. discover

```ts
registry.discover({ verb: "wrap" });
// → [{ protocol: "wmon", method: "wrap", kind: "capability", ... }]
```

### 3. load

```ts
registry.load([{ protocol: "wmon", method: "wrap" }]);
// → intent、risk: ["fundOut"]、params 的 type schema + description
```

### 4. action

```ts
const account = "0xcccccccccccccccccccccccccccccccccccccccc";
const capability = await registry.action("wmon", "wrap", account, {
  amount: "1.5",
});
// capability.kind === "capability"
```

形态概念上是：

```json
{
  "kind": "capability",
  "protocol": "wmon",
  "method": "wrap",
  "params": { "amount": "1.5" },
  "children": [
    {
      "kind": "transaction",
      "transaction": {
        "from": "0xcc…",
        "to": "0x…WMON…",
        "data": "0xd0e30db0",
        "value": "0x…"
      }
    }
  ]
}
```

关键点：

- **只有未签名交易**，没有私钥参与  
- 每个 Capability **恰好一笔** direct transaction  
- 更复杂的流程用**子 Capability** 嵌套（例如先 approve 再 swap）

### 5. simulate

```ts
const outcome = await simulator.simulate(capability);
if (outcome.halted || outcome.results.some((r) => r.warnings.length)) {
  // 停：不要签名
} else {
  // 核对每条 receipt 文字是否符合用户原话
  for (const r of outcome.results) console.log(r.receipt?.text);
}
```

完整脚本：`examples/simple-flow/src/wmon-wrap.ts`。

---

## 第四步：架构分层（心智图）

```
┌──────────────────────────────────────┐
│  @themoss/mcp-server                 │  Agent 入口：四个工具
├──────────────────────────────────────┤
│  @themoss/protocol-*                 │  具体协议专柜
├──────────────────────────────────────┤
│  @themoss/system                     │  Monad Runtime + WMON
├──────────────────────────────────────┤
│  @themoss/erc                        │  通用 ERC 语义
├──────────────────────────────────────┤
│  @themoss/simulator                  │  试衣间：trace + Changes
├──────────────────────────────────────┤
│  @themoss/core                       │  规则：树、Registry、覆盖校验
└──────────────────────────────────────┘
```

---

## 第五步：Capability 树 vs Receipt（新核心）

### Capability 树 = 购物车清单（意图编码）

- 作者/协议代码根据参数**拼出**要发的交易  
- 可嵌套：父能力可以依赖子能力（approve 等）  
- **不是证据**，只是「准备做什么」

### Receipt = 试衣后的小票（仿真证据）

模拟器对每笔交易：

1. `debug_traceCall` 执行  
2. 抽出有序 **Changes**（事件 + 原生 MON 转账）  
3. 调用该能力的 **Receipt 解析器** 翻译成 outcome + text  
4. **穷尽覆盖**：每条 Change 必须被解释，且顺序一致  

任一失败 → Warning → 整条流停止。

| 旧模型（已删除） | 新模型 |
|------------------|--------|
| Plan + expects 声明 | Capability 树 |
| 模拟结果与 expects 对比 | Changes 必须被 Receipt 穷尽覆盖 |
| planHash 防篡改传输 | 树可 JSON 传输；安全靠模拟 + 文字对齐 |

---

## 第六步：模拟器在干什么？

1. 把 Capability 树 **DFS 压平**成交易列表  
2. 给发送账户临时预充余额（模拟「执行后果」，不是查你真实余额策略）  
3. `debug_traceCall` 重放  
4. 抽 Changes → 跑 Receipt → 覆盖校验  
5. 多笔时可用状态覆盖把前一笔效果链式传给后一笔  

**模拟通过 ≠ 未来一定成功上链**，也不等于「符合用户意图」。  
意图对齐是 Agent 用 **有序 Receipt 文字** 对照用户原话完成的。

---

## 第七步：自己写一个最小协议（概念）

1. 复制 `packages/protocols/_template`  
2. 用 `@Protocol` 声明合约与依赖  
3. `@Capability` 返回 `TransactionNode` 或嵌套节点（**不要**再写 `plan()`）  
4. 写 `@Receipt` 解析器：只根据 Changes 说话  
5. 在 composition root `registry.use(myProtocol)`  
6. 离线/集成测试：action → simulate，warnings 为空且文字合理  

详细步骤见官方 [`docs/protocol-onboarding.md`](./docs/protocol-onboarding.md)。

---

## 第八步：小白检查清单

- [ ] 为什么需要「协议超市」而不是让 Agent 直接拼 calldata？  
- [ ] discover / load / action / simulate 各产出什么？  
- [ ] Capability 树和 Receipt 谁是证据？  
- [ ] 为什么 Moss 永不签名？  
- [ ] simulate 有 Warning 时该怎么做？  
- [ ] 代币能不能用符号（如 `"USDC"`）当身份？  
- [ ] 旧的 Plan/expects 被什么替代了？  

---

## 第九步：常见误区

| 误区 | 正确理解 |
|------|----------|
| Moss 能帮我发交易 | 只生成未签名树；签名在钱包 |
| 无 Warning = 一定上链成功 | 只保证模拟时刻解析完整 |
| 无 Warning = 符合用户意图 | 还要对齐有序 Receipt 文字 |
| 可以手改 calldata | 改参数后重新 action |
| 用符号找代币 | 用地址或 `native` |
| Moss 是钱包 | 是协议交互与验证层，不保管私钥 |

---

## 第十步：建议学习路径

1. **第 1 天**：跑 wrap / swap 例子，对照四步流程  
2. **第 2 天**：手写一段 `Registry` + `createTraceSimulator` 脚本  
3. **第 3 天**：读 `wmon.ts` 与 `docs/architecture-explained.zh-CN.md`  
4. **第 4 天**：读 `framework.ts`（flatten + coverage）与 simulator  
5. **第 5 天**：读 `docs/mcp-tools.md` 与 agent-skill  
6. **第 6 天**：复制 template，实现最小 Capability + Receipt  
7. **第 7 天**：读 Kuru 或本地 Neverland，理解嵌套能力  

---

## 总结

> **让 AI Agent 在不签名、不发送交易的前提下，安全地发现、理解、构建，并用仿真证据验证链上协议能力。**

核心价值不是「自动化发交易」，而是 **在签名前强制看见可核对的证据**。

---

## 参考资料

- Moss 上游：https://github.com/nishuzumi/moss  
- 通俗架构：`docs/architecture-explained.zh-CN.md`  
- 深度笔记：`MOSS-STUDY-NOTES.md`  
- 官方入门：`docs/getting-started.md` / `docs/getting-started.zh-CN.md`  
- MCP 契约：`docs/mcp-tools.md`  
- Agent 规则：`docs/agent-skill.md`  
- Protocol 贡献：`docs/protocol-onboarding.md`  
- ADR：`docs/adr/`  
- 领域语言：`CONTEXT.md`  
