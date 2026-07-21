# Moss 架构通俗讲解

> 本地学习文档（非上游官方文档）。  
> 同步日期：2026-07-20  
> 对应架构：Capability Tree + Exhaustive Receipt（上游 #31 之后）

权威词汇以 [`CONTEXT.md`](../CONTEXT.md) 为准；可运行教程见 [Getting started](./getting-started.md)。

---

## 1. 一句话

**Moss 是给 AI Agent 用的「安全交易说明书工厂」。**

Agent 说「我想把 1.5 MON 包成 WMON」，Moss 帮你：

1. 找到对应操作  
2. 拼好**未签名**交易  
3. 在链上**模拟**一遍  
4. 把模拟结果翻译成**可核对的文字证据**

**它永远不签名、不广播。** 签字的事留给钱包。

---

## 2. 为什么需要它？

没有 Moss 时，Agent 要自己找地址、拼 ABI、处理 approve 顺序、判断「钱会不会被转走」。任何一步出错都可能把资金打进错误目标。

Moss 的立场：

> Agent 不能直接碰「生肉交易」；只能走  
> **找能力 → 填参数 → 拿树 → 模拟 → 核对文字** 这条管道。

---

## 3. 四步流水线

```
用户意图
   ↓
discover  有哪些操作？
   ↓
load      这个操作要什么参数、有什么风险？
   ↓
action    拼出 Capability 树（未签名）
   ↓
simulate  模拟执行 → Changes → Receipt 文字
   ↓
Agent 核对文字 ↔ 用户原话 → 通过才交给钱包
```

| 步骤 | 输入 | 输出 |
|------|------|------|
| discover | verb / category / protocol | 坐标列表（protocol + method） |
| load | 坐标 | intent、risk、参数 schema |
| action | 坐标 + account + params | Query 数据，或一棵 Capability 树 |
| simulate | Capability 树 | 有序 Receipt 文字 + Warnings |

MCP 只暴露这四个工具；SDK 可直接调 `Registry` / `Simulator`。

---

## 4. 两个核心结构

### 4.1 Capability Tree ——「准备做什么」

```
CapabilityNode  wmon.wrap
  └── TransactionNode          （恰好一笔 direct 交易）
        from / to / data / value
```

更复杂时（swap 前要 approve）：

```
CapabilityNode  kuru.swap
  ├── CapabilityNode  erc20.approve
  │     └── TransactionNode
  └── TransactionNode          （swap 自己的那笔）
```

硬规则：

- 每个 Capability **有且只有 1 笔** direct `TransactionNode`
- 额外交易必须是**嵌套子 Capability**
- Core 用 DFS **压平**成按序执行列表

`action` 本质：校验参数 → 实例化协议类 → 调能力方法 → 包成 `CapabilityNode`。

### 4.2 Receipt ——「模拟后实际看到了什么」

模拟对每笔交易跑 `debug_traceCall`，抽出有序 **Changes**：

- `event`：日志  
- `nativeTransfer`：原生 MON 转移  

协议作者的 **Receipt parser**（纯函数）把 Changes 译成：

- 结构化 `outcome`
- 给人/Agent 看的 `text`
- 每条 Change 的解读

然后 **穷尽覆盖校验**：

- 每条 Change 必须被用上  
- 顺序不能变  
- 不能漏、不能多、不能重排  

任一失败 → Warning → 整条流停止 → **禁止签名**。

| 概念 | 含义 | 算不算证据 |
|------|------|------------|
| intent / risk | 作者元数据 | ❌ 否 |
| Changes + Receipt | 模拟可观察事实 | ✅ 是 |

---

## 5. 代码角色怎么串

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Protocol   │────▶│   Registry   │◀────│ MCP Server  │
│  能力+收据  │     │  总调度台    │     │ Agent 入口  │
└─────────────┘     └──────┬───────┘     └─────────────┘
                           ▼
                    ┌──────────────┐
                    │  Simulator   │
                    │  traceCall   │
                    └──────────────┘
```

| 角色 | Package | 职责 |
|------|---------|------|
| Protocol | `protocol-*` / system / erc | `@Protocol` / `@Capability` / `@Query` / `@Receipt` |
| Handle | core | 本地编码未签名交易；read/call 只读预览 |
| Registry | core | discover / load / action / parseReceipt / label 渲染 |
| Simulator | simulator | flatten → trace → Changes → Receipt → coverage |
| MCP | mcp-server | 四工具门面；simulate 只投影 leaf texts |

### Handle 三张脸

```ts
this.wmon.deposit(...)      // 编码 → TransactionNode（不上链）
this.wmon.read.balanceOf    // eth_call 读
this.wmon.call.xxx          // eth_call 预览写
```

没有 sign，没有 send。

---

## 6. 完整走一遍：wrap 1.5 MON

1. **discover** `{ verb: "wrap" }` → `wmon.wrap`  
2. **load** → amount 人类可读小数；risk `fundOut`  
3. **action** `{ amount: "1.5" }` → Capability 树（`deposit` + value）  
4. **simulate** → Changes（Deposit 事件 + native transfer）→ Receipt 文字  
5. **意图对齐**：金额、方向、账户是否与用户原话一致  
6. 通过 → 钱包签名；有 Warning / 对不上 → 停

可运行脚本：`examples/simple-flow/src/wmon-wrap.ts`。

---

## 7. 它不是什么

| 误区 | 真相 |
|------|------|
| Moss 是钱包 | 不持有私钥，不广播 |
| 模拟通过 = 一定上链成功 | 只证明**模拟当时**解析完整 |
| 防协议作者作恶 | 协议包受信；靠 review/测试/出处 |
| 可手改 calldata | 应改参数后重新 `action` |
| 用代币符号当身份 | 只用地址或 `native` |

---

## 8. 包分层

```
Agent / 应用
    ↓
@themoss/mcp-server     四个工具
    ↓
@themoss/core           装饰器、Registry、树、覆盖校验
@themoss/simulator      trace + Changes
@themoss/system         Monad Runtime、WMON
@themoss/erc            通用 ERC
@themoss/protocol-*     具体协议
@themoss/abi-tools      按 ADR 0007 拉 ABI
```

写新协议 = 新 `protocol-*` 包：Capabilities + Receipts，再 `Registry.use(...)`。

---

## 9. 旧架构对照（必读）

2026-07 上游 **#31 Capability and Receipt framework** 替换了 Plan 模型：

| 旧（已删除） | 新（当前） |
|--------------|------------|
| Plan + `txs` + `planHash` | Capability tree |
| quantified `expects` | 仿真 Changes + 穷尽 Receipt |
| observation plane | Receipt parser + coverage |
| TokenTable 符号解析 | 地址 / `native`；Trusted/Package label 仅展示 |
| `plan(steps, flows)` | 返回 TransactionNode / 嵌套 Capability |

被废止的 ADR：0004、0005、0006、0008、0009（由 0010/0011 重新表述）。

**Moss 的灵魂不是「帮 Agent 发交易」，而是「强制先看见可核对的仿真证据，再决定是否签名」。**

---

## 10. 本地文档索引

| 文档 | 用途 |
|------|------|
| [MOSS-FOR-BEGINNERS.md](../MOSS-FOR-BEGINNERS.md) | 小白入门（已同步新架构） |
| [MOSS-STUDY-NOTES.md](../MOSS-STUDY-NOTES.md) | 源码级学习笔记（已同步新架构） |
| [CONTEXT.md](../CONTEXT.md) | 官方领域词汇 |
| [docs/adr/](./adr/) | 架构决策 |
| [docs/agent-skill.md](./agent-skill.md) | Agent 硬规则 |

本地 fork 扩展：`packages/protocols/neverland`（lending，分支 `feat/neverland-adapter`）。
