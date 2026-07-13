# Moss 项目深度学习笔记

> 作者：Neo  
> 日期：2026-07-14  
> 来源：逐行阅读 `packages/core`、`packages/simulator`、`packages/protocols/_template`、`packages/system/src/wmon.ts`

---

## 一、项目定位

Moss 把复杂的 Monad DApp/协议交互封装成 AI Agent 可以安全调用的统一能力层。核心流程是：

```
discover → load → action → simulate
```

关键原则：**Moss 只构建和模拟，永远不签名、不发送交易。**

---

## 二、架构分层（从底到顶）

| 层级 | Package | 职责 |
|------|---------|------|
| 机械层 | `@themoss/core` | 装饰器、Plan、Registry、语义类型，不依赖任何链上数据 |
| 验证层 | `@themoss/simulator` | `debug_traceCall` 模拟、效果抽取、expects 与实际对比 |
| 接口层 | `@themoss/erc` | 标准 ABI（ERC20/721/WETH9）和地址无关的通用行为 |
| 实例层 | `@themoss/system` | Monad 令牌数据、链配置、WMON 等特定地址适配器 |
| 协议层 | `@themoss/protocol-*` | 每个协议一个 package |
| 产品层 | `@themoss/mcp-server` | 4 个 MCP 工具：discover/load/action/simulate |

---

## 三、packages/core 深度解读

### 3.1 types.ts — 领域词汇

- **Verb**：从用户视角出发的资金语义，如 `wrap`、`swap`、`supply`，而不是协议函数名。WMON 的 `deposit()` 在 Moss 里叫 `wrap`。
- **Category**：`dex` / `lending` / `staking` / `rewards` / `token` / `nft`。
- **RiskLabel**：`fundOut` / `approval` / `priceImpact`，用于 discover/load 时的风险分类。
- **Expects**：Plan 中声明的资产流动：`out`、`in`、`approvals`、`nfts`。
- **Plan**：自包含的未签名交易包 + 声明 + planHash，可以通过 JSON 传输，MCP server 是 stateless 的。

### 3.2 decorators.ts — 三个核心装饰器

- **@Protocol**：类装饰器，声明协议名称、类别、合约列表。它通过 mixin 模式在构造时注入 Handle（根据 `declare` 字段名匹配）和 `runtime`。
- **@Capability**：方法装饰器，标识一个写能力，需要返回 `plan(steps, flows)`u3002
- **@Query**：方法装饰器，标识一个读能力，返回 JSON-safe 数据。

重要细节：中续数据不用 `context.metadata`（跨编译器不稳定），而是用 Symbol-keyed marker property 挂在函数/类上。

### 3.3 handle.ts — ABI 类型化代理

`createHandle(abi, address, client)` 返回一个 Proxy：

- `handle.deposit([args], { value })` → 返回 `TxStep`（本地编码的 calldata，不签名）
- `handle.read.balanceOf([owner])` → 发起 `eth_call` 读取
- `handle.call.deposit([args], { from, value })` → 模拟调用并返回结果

这是“不签名”边界的核心体现：Handle 只产生未签名交易数据或发起读取。

### 3.4 plan.ts — PlanDraft → Plan 的封装

- `plan(steps, flows)`：能力作者返回的草稿，包含 `TxStep[]` 和定量声明 `DeclaredFlows`。
- `finalizePlan(draft, meta)`：core 把 draft 封装成完整 Plan，加上 account、chainId、intent、planHash。
- `computePlanHash`：对 `{chainId, account, txs, expects, confirms}` 做 keccak256，防篡改。

### 3.5 semantics.ts — 语义类型

这是 Agent 与协议之间的类型层：

- `address`：0x 地址，转换为 checksum
- `token`：符号、地址、"native"。**符号只能在精心打磨的 TokenTable 中解析，绝不通过链上 symbol() 回退**。
- `nativeAmount`：人类可读 MON 数量
- `tokenAmount("assetParam")`：依赖兄弟参数的资产类型进行精度缩放
- `fixedAmount(decimals, label)`：精度已知的代币

### 3.6 registry.ts — 协议目录

Registry 是空的，需要通过 `registry.use(pkg)` 明确组装。

主要方法：

- `use(pkg)`：注册一个协议包（检查 token 冲突）
- `register(ctor)`：注册一个协议类，遍历原型链收集 @Capability/@Query/@Event
- `discover(filter)`：返回 Coordinate[]
- `load(coords)`：返回 Stub[]（agent 调用 action 前需要的参数说明）
- `action(protocol, method, account, params)`：执行 query 或构建 capability Plan
- `observer()`：为 simulator 提供 @Event 解码和渲染 hook

验证逻辑：
- capability 必须声明至少一个 risk label
- `confirms` 中的名字必须是已注册的 @Event 方法
- @Event 订阅的合约键和事件名必须在 ABI 中存在

### 3.7 token.ts / tokens.ts — 令牌表

- `Token` 类拥有 `scale`/`format` 方法，是唯一做精度转换的地方。
- `TokenTable` 是每个 Registry 独立的，**符号不同地址直接抛错**，防止同名假币攻击。

### 3.8 observe.ts — 观察平面

@Event 定义了“协议自己的语言”来描述交易结果，如 "Swapped 1 MON into 0.0239 USDC on Kuru (3 fills)”。

红线：**observations 只能收紧结果（通过 `confirms` 引发 `CONFIRMATION_MISSING` warning），绝不能取代 expects 与 effects 的对比。**

---

## 四、packages/simulator 深度解读

### 4.1 设计目标

把 `declared` 转化为 `verified`。通过 `debug_traceCall` 在当前链状态下重放交易，抽取真实效果，与 Plan 的 expects 对比。

### 4.2 trace.ts — 两次 trace

每个交易模拟时要调用两次 `debug_traceCall`：

1. `traceWithCalls`：使用 `callTracer` + `withLog: true`，获取调用树和事件 log。
2. `traceWithDiff`：使用 `prestateTracer` + `diffMode: true`，获取状态变化 diff。

为什么需要两次？
callTracer 能抓住资金流动和 log，但不能正确追踪状态累积；prestateTracer diffMode 能给出每个账户/合约的前后状态，用于跨交易累积。

### 4.3 effects.ts — 效果抽取

`EffectsAccumulator` 走访每个 tx 的调用树，从以下来源收集资金流动：

- `CALL` 帧的 `value` 转移 → native MON 流入/流出
- `Transfer` event → ERC-20 令牌流动
- `Transfer` event (四个 topic) → ERC-721 NFT 流动
- `Approval` event → ERC-20 授权
- `ApprovalForAll` event → ERC-721 operator 授权
- `Deposit`/`Withdrawal` event → WETH9 风格的 wrap/unwrap

所有 event topic hash 都是通过 `toEventSelector` 从人类可读签名计算出来的，不手动粘贴。

### 4.4 reconcile.ts — 对比逻辑

核心是：**any undeclared difference becomes a warning**。

对比项：
- `UNDECLARED_OUTFLOW` / `OUTFLOW_EXCEEDS_MAX`：assetsOut vs expects.out
- `UNDECLARED_APPROVAL` / `APPROVAL_EXCEEDS_MAX`：approvals vs expects.approvals
- `MIN_INFLOW_NOT_MET`：assetsIn vs expects.in
- `UNDECLARED_NFT_OUT`：NFT 流出
- `NFT_OPERATOR_GRANTED`：operator 授权总是警告

### 4.5 index.ts — 模拟器主体

`createTraceSimulator(runtime, options)` 返回 Simulator：

- 每个 Plan 的每个 tx 依次模拟
- 账户预充 100 万 MON（因为模拟回答的不是“能不能付得起”，而是“执行后会怎样”）
- 使用 `prestateTracer diff` 累积状态变化，支持多步 Plan 组合
- 模拟结束后调用 observer 渲染 @Event
- 检查 `confirms`，缺失则 `CONFIRMATION_MISSING`

---

## 五、wmon.ts — 参考适配器

WMON 是最简洁的参考实现：

```ts
@Protocol({ name: "wmon", category: "token", contracts: { wmon: { abi: WETH9Abi, addr: WMON_ADDRESS } } })
export class WMON {
  declare wmon: Handle<typeof WETH9Abi>;

  @Capability({ intent: "Wrap {amount} native MON into WMON", verb: "wrap", params: { amount: nativeAmount }, risk: ["fundOut"] })
  async wrap({ amount }: { amount: bigint }) {
    const deposit = this.wmon.deposit([], { value: amount });
    return plan([deposit], {
      out: [{ token: NATIVE, amountMax: amount }],
      in: [{ token: WMON_ADDRESS, amountMin: amount }],
    });
  }
}
```

要点：
- `declare wmon` 只是类型声明，运行时由 @Protocol 注入 Handle
- `@Capability` 的 `params` 使用 `nativeAmount`，这样 agent 只需传 `"1.5"`
- `plan()` 中的 `flows` 必须是定量的，与 simulate 后的 effects 对比

---

## 六、_template — 适配器模板

模板包含：
- `src/abis/example.ts`：ABI 定义
- `src/adapter.ts`：协议类（含 @Capability / @Query / @Event）
- `src/tokens.ts`：代币列表
- `src/index.ts`：导出 manifest
- `test/adapter.test.ts`：离线形状测试

开发 checklist 要点：
1. 替据 ABI，注明 ABI origin
2. 填充合约地址，注明验证方式
3. 选择正确的 verb 和 category
4. 为 capability 声明 risk 和 quantified expects
5. 有意义收据时添加 @Event 和 confirms
6. 添加测试，优先离线形状，再加 live e2e
7. 在 mcp-server 中注册 manifest

---

## 七、学到的设计思想

1. **声明 vs 执行分离**：Plan 是一份声明，simulate 是验证，签名是钱包的事。三者责任分离清晰。
2. **量化 expects**：“我愿意支付最多 X，收到至少 Y”是安全的基础。
3. **符号安全**：不信任链上 symbol()，只信任精心维护的 TokenTable。
4. **两层平面**：Audit plane（通用资产流动）与 Observation plane（协议自己的语言）互补，后者不能取代前者。
5. **无状态 MCP server**：所有信息都在 Plan 里，server 不保存任何状态，可随意传播和验证。

---

## 八、与 PactGuard 的可能组合

| 阶段 | Moss | PactGuard |
|------|------|-----------|
| 意图理解 | “换 1 MON 成 USDC” | “是否在预算/白名单内？” |
| 能力发现 | discover | — |
| 调用构建 | action 生成 Plan | — |
| 模拟验证 | simulate 确认无 warning | 在 simulate 后、签名前检查预算/白名单/频率 |
| 签名发送 | 由外部钱包完成 | 也由外部钱包完成，Pact 保护下的最小授权 |

可能的组合点：Moss simulate 通过后，PactGuard 解析 Plan 的 expects 和 effects，判断是否在用户预置的策略范围内；越权则拒绝、记录审计。
