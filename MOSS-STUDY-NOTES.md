# Moss 项目深度学习笔记

> 作者：Neo  
> 初稿：2026-07-14  
> **架构同步：2026-07-20**（Capability Tree + Exhaustive Receipt，对齐上游 #31 / 本地 `1883ae2`）  
> 源码阅读：`packages/core`、`packages/simulator`、`packages/system/src/wmon.ts`、`packages/mcp-server`、`packages/protocols/*`  
> 通俗总览：[`docs/architecture-explained.zh-CN.md`](./docs/architecture-explained.zh-CN.md)

---

## 0. 架构版本声明（先读这个）

本笔记描述 **当前 main 线** 的实现逻辑。

| 已废弃（旧笔记 / 旧 PR 材料） | 当前实现 |
|------------------------------|----------|
| `Plan`、`planHash`、`plan.ts` | `CapabilityNode` + `TransactionNode` 树 |
| quantified `expects` / DeclaredFlows | 仿真 `Change[]` + Receipt 穷尽覆盖 |
| `observe.ts` / observation plane | `@Receipt` 解析器 + `verifyReceiptCoverage` |
| `manifest` / TokenTable 符号解析 | 自描述 `@Protocol` + 地址/`native` + Zod 参数 |
| `plan(steps, flows)` | 返回 `TransactionNode` 或嵌套 Capability 结果 |

若材料里仍出现 expects 对账、planHash、TokenTable，一律视为 **2026-07 重设计前** 的内容。

---

## 一、项目定位

Moss 把 Monad 上的协议交互封装成 Agent 可调用的统一能力层：

```
discover → load → action → simulate
```

硬原则：

1. **只构建、只模拟，永不签名、永不广播**  
2. **声明不是证据**；证据来自 `debug_traceCall` 的 Changes  
3. **任意 Warning 即停**，禁止交给签名器  
4. Token 身份只用 **EVM 地址或 `native`**

---

## 二、架构分层

| 层级 | Package | 职责 |
|------|---------|------|
| 产品层 | `@themoss/mcp-server` | 四工具门面；simulate 投影 leaf texts |
| 协议层 | `@themoss/protocol-*` | 具体协议：Capabilities、Queries、Receipts、ABI |
| 系统层 | `@themoss/system` | Monad Runtime（chainId 143）、官方常量、WMON |
| 接口层 | `@themoss/erc` | 地址无关的 ERC-20/721/WETH9 语义 |
| 验证层 | `@themoss/simulator` | `debug_traceCall`、Change 抽取、状态链式 |
| 机械层 | `@themoss/core` | 装饰器、Registry、参数契约、Capability 树、覆盖校验 |
| 工具 | `@themoss/abi-tools` | ADR 0007：从 explorer 拉完整 ABI |

包边界（CONTEXT）：core 管框架契约；simulator 管 trace；协议包管 ABI/Receipt/独占地址；system 管 Runtime；MCP 管传输。

---

## 三、领域词汇（精简）

完整版见 `CONTEXT.md`。实现里最常用：

| 词 | 含义 |
|----|------|
| **Protocol** | 自描述适配器类，可声明依赖其他 Protocol |
| **Capability** | 写意图：1 笔 direct unsigned tx + 1 个 Receipt parser |
| **Query** | 只读，不产生交易 |
| **Handle** | ABI 类型化网关：编码 tx / read / call 预览 |
| **Capability tree** | 写操作的唯一可执行结构 |
| **Change** | 成功执行的 event 或 nativeTransfer（执行序） |
| **Receipt** | 对 Changes 的结构化解释 + 文本投影 |
| **Warning** | 模拟/解析/覆盖失败；出现即停 |
| **Verb** | 用户视角动词（wrap/swap/supply…），不是合约函数名 |
| **Risk label** | 作者标签：fundOut / approval / priceImpact |

---

## 四、packages/core 深度解读

### 4.1 types.ts

- `Verb` / `Category` / `RiskLabel`：封闭枚举，服务 discover  
- `TokenRef` = `Address | "native"`  
- `UnsignedTx`：`from/to/data/value`  
- `TransactionNode`：`{ kind: "transaction", transaction }`  
- `CapabilityNode`：`{ kind: "capability", protocol, method, params, children }`  
- `Change`：event | nativeTransfer  
- `ReceiptResult` / `Receipt`：outcome + text + 递归 changes；Registry 盖上 `protocol`

**没有** Plan、expects、planHash。

### 4.2 decorators.ts

| 装饰器 | 作用 |
|--------|------|
| `@Protocol` | name、category、description、contracts、protocols 依赖、labels |
| `@Capability` | intent、verb、params、receipt 方法名、risk、tags |
| `@Query` | intent、params、tags |
| `@Receipt` | 标记纯解析函数 |

元数据用 **Symbol-keyed marker property** 挂在类/方法上（不用 `context.metadata`，跨转译器更稳）。  
Registry 通过原型链扫 marker 发现方法。

依赖约束：装饰过的 Protocol **不能继承**另一个装饰 Protocol；用 `protocols: { erc20: ERC20 }` 注入。

### 4.3 handle.ts

`createHandle(abi, address, client, account)`：

| 面 | 行为 |
|----|------|
| `handle.fn(args, { value })` | 本地 `encodeFunctionData` → `TransactionNode` |
| `handle.read.fn(args)` | `readContract` / eth_call |
| `handle.call.fn(args, opts)` | eth_call 预览写函数返回值 |

`transaction(from, to, { data, value })` 可手写裸节点。  
**Receipt 解析器不得走任何 RPC 面。**

### 4.4 framework.ts

- `flattenCapabilityTree(root)`：DFS；每个 capability 必须恰好 1 个 direct transaction  
- `verifyReceiptCoverage(changes, receipt)`：长度、顺序、同一 Change 对象引用  
- 失败抛 `ReceiptCoverageError`

### 4.5 semantics.ts（参数契约）

Capability/Query 入参：`{ type, description }`：

- `type`：可复用、上下文无关的 Zod 值契约（校验、转换、默认、单位说明）  
- `description`：该字段在本方法中的角色  

`load` 暴露 JSON-safe schema。常见类型：`Address`、`TokenReference`、`PositiveDecimalString` 等。  
**不再**用 TokenTable 把符号解析成地址。

### 4.6 registry.ts — 总调度

```ts
const registry = new Registry(runtime, { trustedTokens }).use(system, erc, kuru);
```

关键 API：

| API | 行为 |
|-----|------|
| `discover(filter)` | 按 verb/category/protocol 搜坐标 |
| `load(items)` | intent / risk / 参数契约 |
| `action(protocol, method, account, params)` | Query → data；Capability → 建树 |
| `parseReceipt(node, changes)` | 按注册元数据找 parser → 覆盖校验 → 盖 protocol → 渲染 label |
| `validateCapabilityTree(root)` | 压平并确认 protocol.method 已注册 |

`#buildCapability` 流程：

1. `parseParams`  
2. `#instantiate(protocol, account)` 注入 Handle + 依赖 Protocol  
3. 调能力方法  
4. 结果数组化成 `children`，包成 `CapabilityNode`  
5. 立刻 `flattenCapabilityTree` 做结构校验  

Receipt 委托：子 Receipt 必须是**已声明依赖**的协议；调用方不能改写子 Outcome/text/Changes。  
Label 渲染：Trusted → 当前 Package → 调用链 Package → 无歧义依赖 Package → 原始地址。

---

## 五、packages/simulator

`createTraceSimulator(runtime, { receipt })`：

1. `flattenCapabilityTree`  
2. 对每笔交易：预充余额 → `debug_traceCall`（可带 state overrides 链式）  
3. `extractChanges(frame)`：成功路径上的 event + nativeTransfer  
4. `receipt(capability, changes)` → 通常接 `registry.parseReceipt`  
5. `verifyReceiptCoverage`  
6. 任一步失败：写入 Warning，设置 `halted`，**不再执行后续交易**

Warning 码（实现侧）：`REVERTED`、`TRACE_FAILED`、`CHANGE_ORDER_UNAVAILABLE`、`RECEIPT_FAILED`、`CHANGE_COVERAGE_MISMATCH`、`STATE_CHAIN_FAILED`。

模拟证明的是：**在模拟时刻，Changes 可被穷尽解析**；不是未来出块保证，也不是用户意图本身。

---

## 六、packages/mcp-server

四工具映射 Registry / Simulator：

| 工具 | 实现 |
|------|------|
| discover | `registry.discover` |
| load | `registry.load` |
| action | `registry.action` |
| simulate | `validateCapabilityTree` + `simulator.simulate` + `toAgentSimulation` |

`toAgentSimulation`：SDK 全量证据 → Agent 瘦响应：

- `ok` / `guidance`  
- 每笔：`protocol`、`method`、**有序 leaf texts**、`warnings`  
- 可能有 `halted`

Agent 必须用 texts 做 **intent alignment**，不能只看一行 summary。

---

## 七、WMON 源码导读（最小完整例子）

文件：`packages/system/src/wmon.ts`

```ts
@Protocol({
  name: "wmon",
  category: "token",
  contracts: { wmon: { abi: WETH9Abi, addr: WMON_ADDRESS } },
  protocols: { erc20: ERC20 },
})
export class WMON {
  declare wmon: Handle<typeof WETH9Abi>;
  declare erc20: ProtocolRef<ERC20>;

  @Capability({ ..., receipt: "wrapReceipt", risk: ["fundOut"] })
  async wrap(params) {
    return [this.wmon.deposit([], { value: parseUnits(params.amount, 18) })];
  }

  @Receipt()
  wrapReceipt(changes) { /* 解码 Deposit + nativeTransfer，交叉校验金额与账户 */ }
}
```

要点：

1. Capability 只负责**编码意图**，不负责证明  
2. Receipt 只看 Changes，不查外部状态补洞  
3. Transfer/Approval 可委托 `erc20.changesReceipt`  
4. Deposit 金额必须与 native transfer 一致，否则 parser 抛错 → RECEIPT_FAILED  

跑通：

```bash
pnpm --filter @themoss/example-simple-flow wrap
```

---

## 八、嵌套能力与多笔交易

复杂协议（如 Kuru swap）在 Capability 的 `children` 里嵌套 `erc20.approve` 等子 Capability。

执行序 = DFS 压平序。Simulator 用 state overrides 把前一笔 diff 叠到后一笔，使「先 approve 再 swap」在模拟里可连续。

每个节点仍满足：1 capability : 1 direct tx。

---

## 九、本地扩展：Neverland

路径：`packages/protocols/neverland`（分支 `feat/neverland-adapter`）

- Monad 上 Aave V3 风格 lending  
- 覆盖 supply / withdraw / account health 等核心面  
- aToken 地址运行时从 PoolDataProvider 取，不写死在静态 Token 表  
- 非 native 资产 supply 时嵌套 ERC-20 approve 子能力  

实现已用新 API（`@Capability` + `transaction` + `@Receipt`），不是旧 `plan()`。

---

## 十、Agent 安全规则（实现侧摘要）

见 `docs/agent-skill.md`：

1. 先记录用户 Intent  
2. discover → load → action → **必须** simulate  
3. 有 Warning 就停  
4. 有序 Receipt 文字与用户原话对齐  
5. 展示后再签；Moss 自己永不签  

---

## 十一、相关 ADR

| ADR | 内容 |
|-----|------|
| 0001 | 装饰器作者模型 + Handle 三面 |
| 0002 | 用 `debug_traceCall` 模拟 |
| 0003 | Capability / Query 两档 |
| 0007 | ABI origin：compiled / explorer / vendored |
| 0010 | 自描述 Protocol + Zod 参数 + 依赖注入 |
| 0011 | Capability 树 + 穷尽 Receipt |
| 0012 | Kuru 动态 market discovery |

---

## 十二、学习路径（更新后）

1. 读 `docs/architecture-explained.zh-CN.md` + `MOSS-FOR-BEGINNERS.md`  
2. 跑 `examples/simple-flow` 的 wrap / swap  
3. 精读 `wmon.ts` + `framework.ts` + `registry.ts` 的 action/parseReceipt  
4. 精读 `simulator/src/index.ts` + `changes.ts`  
5. 读 `docs/mcp-tools.md` 与 `toAgentSimulation`  
6. 复制 `protocols/_template`，写最小 Capability + Receipt  
7. （可选）读 Neverland / Kuru 看嵌套与动态地址  

---

## 十三、检查清单

- [ ] 能画出 discover → load → action → simulate 数据流  
- [ ] 能解释 Capability 树与「每节点一笔 tx」  
- [ ] 能解释 Change / Receipt / coverage 三者关系  
- [ ] 知道声明（intent/risk）不是证据  
- [ ] 知道 MCP 与 SDK 在 simulate 返回上的差别  
- [ ] 能指出 Handle 为何体现「不签名」边界  
- [ ] 知道旧 Plan/expects 已被什么替代  

---

## 十四、参考链接

- 上游：https://github.com/nishuzumi/moss  
- 本地 fork：https://github.com/NeoWeb3Nova/moss  
- 框架 PR：https://github.com/nishuzumi/moss/pull/31  
- 领域语言：`CONTEXT.md`  
- 通俗讲解：`docs/architecture-explained.zh-CN.md`  
- 官方入门：`docs/getting-started.md` / `.zh-CN.md`  
