# Moss 小白入门指南：从零到一理解 Agent × DeFi 交互层

> 作者：Neo × Nova001  
> 日期：2026-07-14  
> 适合读者：会基本 JavaScript/TypeScript，想理解 Moss 是什么、为什么需要它、怎么用它。

---

## 第零步：为什么需要 Moss？

### 想象一个场景

你对 AI Agent 说：
> “帮我在 Monad 上把 1 MON 换成 USDC。”

如果没有 Moss，Agent 需要自己去学：
- 哪个 DEX 在 Monad 上？
- 路由器地址是多少？
- 是 exact-in 还是 exact-out？
- 要不要先 wrap MON 成 WMON？
- 滑点怎么设？
- 交易失败了怎么办？

Agent 在万一中搞错一个细节，交易就可能把钱打进黑洞。

### Moss 做什么？

Moss 就像是一个**协议超市**：
- 每个铜币协议（如 Kuru、WMON、ERC-20）是一个**货架**
- 每个货架上的能力（如 swap、wrap、transfer）是一件**商品**
- Agent 不用知道底层合约怎么写，只需按照 Moss 的标准流程购买商品
- 付款前，Moss 会在**模拟器**里跑一遍，告诉 Agent：这个 Plan 是否安全

**最重要的一句话：Moss 只构建和模拟，永远不签名、不发送交易。**

---

## 第一步：把 Moss 跑起来

### 环境要求

- Node.js ≥ 22
- pnpm

### 安装

```bash
# 克隆（或你的 fork）
git clone https://github.com/NeoWeb3Nova/moss.git
cd moss

# 安装依赖
pnpm install

# 构建
pnpm -r build

# 离线测试（不需要网络）
MOSS_SKIP_E2E=1 pnpm -r test
```

如果上面三条命令都通过，说明你的环境已经准备好了。

### 跑第一个例子

```bash
pnpm --filter @themoss/example-simple-flow exec tsx src/wmon-wrap.ts
```

你会看到输出结束于：
```
✓ No warnings — the unsigned txs may be handed to a wallet for review.
```

这行字是 Moss 的全部价值——它证明这个交易计划在模拟环境里没有问题，可以交给钱包签名了。

---

## 第二步：四步流程

Moss 的一切都围绕四个动作：

```
discover → load → action → simulate
```

用超市来比喻：

| 步骤 | 你对 AI 说 | AI 对 Moss 做 | 类比 |
|------|------------|--------------|------|
| **discover** | “我想换币” | 查找所有能 swap 的协议 | 在超市找到卖饭的框架 |
| **load** | “告诉我 Kuru swap 怎么用” | 返回调用契约：需要什么参数、有什么风险 | 看商品详情页 |
| **action** | “帮我构建这个交易” | 生成 Plan：未签名的交易 + 声明的资产流动 | 把菜放进购物车 |
| **simulate** | “检查一下这个 Plan 是否安全” | 在当前链状态下重放，抽取效果，与声明对比 | 结账前先在脑海里走一遍 |

---

## 第三步：手动拆解四步流程

我们来看一段最简单的代码。

### 1. 准备环境

```ts
import { Registry } from "@themoss/core";
import { createTraceSimulator } from "@themoss/simulator";
import { systemManifest, monadRuntime } from "@themoss/system";

const runtime = monadRuntime();          // Monad mainnet RPC + chainId
const registry = new Registry(runtime);  // 空的协议目录
registry.use(systemManifest);            // 注册 WMON 等系统协议
```

注意：Registry 一开始是**空的**。你必须明确告诉它“我要用这些协议”。

### 2. discover

```ts
const coords = registry.discover({ verb: "wrap" });
console.log(coords);
```

输出类似：
```json
[
  {
    "protocol": "wmon",
    "method": "wrap",
    "kind": "capability",
    "verb": "wrap",
    "category": "token",
    "tags": ["wrapper"],
    "summary": "Wrap {amount} native MON into WMON"
  }
]
```

意思是：“找到了，WMON 协议可以帮你 wrap。”

### 3. load

```ts
const stubs = registry.load([{ protocol: "wmon", method: "wrap" }]);
console.log(stubs);
```

输出类似：
```json
[
  {
    "protocol": "wmon",
    "method": "wrap",
    "kind": "capability",
    "intent": "Wrap {amount} native MON into WMON",
    "risk": ["fundOut"],
    "params": {
      "amount": "A human-decimal amount of native MON (e.g. \"1.5\"). Do not pre-scale to wei."
    }
  }
]
```

这就是 Agent 调用前需要知道的信息：需要什么参数、有什么风险。

### 4. action

```ts
const account = "0xCcCccCCCcCCcccCcCccccCcCCCCcccccCcCCcCcC";
const plan = await registry.action("wmon", "wrap", account, { amount: "1.5" });
console.log(plan);
```

`plan` 是这样的结构：
```json
{
  "kind": "plan",
  "protocol": "wmon",
  "method": "wrap",
  "intent": "Wrap 1.5 native MON into WMON",
  "txs": [
    { "from": "0xCcC...", "to": "0x3bd3...", "data": "0xd0e30db0", "value": "0x14d1120d7b160000" }
  ],
  "expects": {
    "out": [{ "token": "native", "amountMax": "1500000000000000000" }],
    "in": [{ "token": "0x3bd3...", "amountMin": "1500000000000000000" }]
  },
  "planHash": "0x..."
}
```

这里只有三个关键点：
- `txs`：未签名交易
- `expects`：声明会发生什么
- `planHash`：这份 Plan 的指纹，防篡改

### 5. simulate

```ts
const simulator = createTraceSimulator(runtime, { observer: registry.observer() });
const { results } = await simulator.simulate([plan]);
console.log(results[0].effects);
console.log(results[0].warnings);
```

如果 `warnings` 是空数组，就是安全的。

---

## 第四步：Moss 的架构分层

Moss 的代码分成几层，从底到顶越来越接近产品：

```
┌─────────────────────────────────────┐
│  产品层：@mcp-server           │ ← 四个 MCP 工具（discover/load/action/simulate）
├─────────────────────────────────────┤
│  协议层：@protocol-*           │ ← 每个协议一个包（Kuru、未来的 Uniswap 等）
├─────────────────────────────────────┤
│  实例层：@system              │ ← Monad 的特定配置（WMON 地址、令牌表）
├─────────────────────────────────────┤
│  接口层：@erc                │ ← ERC-20/721/WETH9 等通用接口
├─────────────────────────────────────┤
│  验证层：@simulator          │ ← debug_traceCall 模拟 + 效果抽取
├─────────────────────────────────────┤
│  机械层：@core               │ ← Plan、Registry、装饰器、语义类型
└─────────────────────────────────────┘
```

用一个比喻：
- `@core` 是“货币超市的规则手册”
- `@simulator` 是“付款前的试衣间”
- `@protocol-*` 是“各个品牌专柜”
- `@mcp-server` 是“货架对外的收银台”

---

## 第五步：什么是 Plan？

Plan 是 Moss 的核心概念。它是一份自包含的**交易计划**，包含：

| 字段 | 含义 | 类比 |
|------|------|------|
| `txs` | 未签名交易列表 | 购物车里的商品 |
| `expects` | 声明会发生什么资产流动 | 购物清单上写的价格 |
| `planHash` | Plan 的指纹 | 清单的防伪封条 |
| `intent` | 人类可读描述 | 清单上的备注 |
| `confirms` | 期望出现的收据 | 你要求店员给的小票 |

为什么需要 `expects`？

因为 AI 可能会写错代码，或者协议本身有 bug。Moss 会在 simulate 时比对：
- 你声明了最多付出 1.5 MON
- 模拟结果显示付出了 2 MON
- → 触发 `OUTFLOW_EXCEEDS_MAX` warning

这就是 Moss 的安全机制：**any undeclared difference becomes a warning**。

---

## 第六步：模拟器怎么工作？

simulate 不是简单地“验签”。它做了这些事：

1. **预充资金**：给测试账户 100 万 MON（模拟不问你有没有钱，只问执行后会怎样）
2. **调用 debug_traceCall**：在当前链状态下重放交易
3. **抽取 effects**：从 trace 里读出所有资产流动
4. **与 expects 对比**：不一致就报 warning
5. **跳过累积状态**：多个 Plan 可以依次执行，后一个能用到前一个的效果

为什么需要两次 trace？
- 第一次（callTracer）：看调用树 + event log
- 第二次（prestateTracer diffMode）：看状态变化，用于跨交易累积

---

## 第七步：自己写一个最小适配器

如果你想给 Moss 添加一个新协议，步骤是：

### 1. 复制模板

```bash
cp -r packages/protocols/_template packages/protocols/myprotocol
cd packages/protocols/myprotocol
```

### 2. 填充合约地址和 ABI

在 `src/adapter.ts` 里：

```ts
export const MY_PROTOCOL_ADDRESS: Address = "0x...";

@Protocol({
  name: "myprotocol",
  category: "token",
  description: "My protocol does X",
  contracts: {
    pool: { abi: MyAbi, addr: MY_PROTOCOL_ADDRESS },
  },
})
export class MyProtocol {
  declare pool: Handle<typeof MyAbi>;

  @Capability({
    intent: "Deposit {amount} MON into my protocol",
    verb: "supply",
    params: { amount: nativeAmount },
    risk: ["fundOut"],
  })
  async deposit({ amount }: { amount: bigint }) {
    const step = this.pool.deposit([], { value: amount });
    return plan([step], {
      out: [{ token: NATIVE, amountMax: amount }],
    });
  }
}
```

### 3. 导出 manifest

```ts
export const myprotocolManifest = defineProtocolPackage({
  name: "myprotocol",
  protocols: [MyProtocol],
  tokens: [],
});
```

### 4. 测试

```ts
const registry = new Registry(runtime);
registry.use(myprotocolManifest);

const plan = await registry.action("myprotocol", "deposit", account, { amount: "1" });
const { results } = await simulator.simulate([plan]);
expect(results[0].warnings).toEqual([]);
```

---

## 第八步：小白学习检查清单

如果你能回答以下问题，说明你已经理解了 Moss：

- [ ] 为什么 Moss 要做“协议超市”？
- [ ] `discover/load/action/simulate` 分别做什么？
- [ ] 为什么 Plan 需要 `expects`？
- [ ] 为什么 Moss 永远不签名交易？
- [ ] 如果 simulate 出现 warning，应该怎么做？
- [ ] 如何给 Moss 添加一个新协议能力？

---

## 第九步：常见误区

| 误区 | 正确理解 |
|------|---------|
| “Moss 可以帮我发送交易” | 不行。Moss 只生成未签名 Plan，签名必须由你的钱包完成。 |
| “simulate 没 warning 就等于交易一定成功” | 不等于。它只保证 Plan 做了它声明的事，但是否符合你的意图，需要自己检查。 |
| “我可以直接调用合约，不用 discover/load” | 可以，但那就失去了 Moss 的安全网和意图对齐保护。 |
| “Moss 是一个钱包” | 不是。Moss 是协议交互层，不保管私钥。 |

---

## 第十步：建议的学习路径

1. **第一天**：跑通 `wmon-wrap.ts`，理解四步流程。
2. **第二天**：手动写一个脚本，重复 discover/load/action/simulate。
3. **第三天**：阅读 `packages/core/src/types.ts`、`plan.ts`、`decorators.ts`。
4. **第四天**：阅读 `packages/simulator/src/index.ts` 和 `effects.ts`。
5. **第五天**：复制 `_template`，实现一个简单的 query/capability，跑通 offline test。
6. **第六天**：选一个真实的 Monad 协议，尝试写一个真正的 adapter。

---

## 总结

Moss 解决的问题可以用一句话概括：

> **让 AI Agent 在不签名、不发送交易的前提下，安全地发现、理解、构建和验证链上协议能力。**

它的核心价值不是“自动化交易”，而是“在签名前发现问题”。

---

## 参考资料

- Moss GitHub: https://github.com/nishuzumi/moss
- 获得开始指南: `docs/getting-started.md`
- 工具契约: `docs/mcp-tools.md`
- Agent 安全规则: `docs/agent-skill.md`
- Protocol 贡献指南: `docs/protocol-onboarding.md`
- ADR 设计决策: `docs/adr/`
