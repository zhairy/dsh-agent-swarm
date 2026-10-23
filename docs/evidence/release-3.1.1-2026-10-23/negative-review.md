# 代码审查报告

日期：2026-10-23。角色：独立反方架构与数学审查。工作树：`.work-v3`。本报告基于工作区实际 diff 和下列独立执行记录，不代表真实宿主验收已经完成。

## 1. 总体评价

* **评分**：⭐⭐⭐⭐☆（4/5，修复后代码审核通过，真实宿主验收待主线执行）。
* **摘要**：本审核先独立复现一次性换模后的错误回退归属P1，再对修复后的实际源码和构建产物复验，原P1与终态覆盖风险均已解决。独立执行18个测试文件、318项通过，追加角色/需求来源2文件11项通过，以及真实DSH AgentLoop隔离集成3项通过（使用mock模型适配器）。未发现尚未解决的本轮发布阻断。上下文恢复、词法经验召回、文件发现、失败提示与3.1.1–3.1.4路线在明确边界内成立。持久子会话原停止、等待宿主沉寂及显式继续机制保留。本报告不代替真实生产宿主验收；按用户选择，应等待运行中会话结束再部署发布。

## 2. 详细审查

| 级别 | 位置 | 问题描述 | 改进建议 |
| :--- | :--- | :--- | :--- |
| 🔴 P1，已解决 | `src/route-state.ts:523` 起的 `getChildFallback` | 初版选择下一模型后，旧请求的失败可能错误加入新模型tried并耗尽路由。 | 修复后显式传入实际失败route；不同选择从链首重新准入。真实复验400/401/403/404均由新健康模型接手，旧失败归属保持正确。异步预检期间再换模及跨委派旧回调也有回归。 |
| 🟡 终态风险，已解决 | `src/agent-control.ts` 的 `MarkRunSettled`、`ObserveSelection` | 初版依赖可变reason保护一次性终态。 | 修复后使用单调`oneShotSettled`锁；迟到selection、等待与blocked通知不再重开，继续和新选择仍拒绝。现有测试真实通过。 |
| 🟡 既有边界 | `src/checkpoint.ts:48` 起 | 同一义务改写文本或给同一内容换引用可以绕过重复无进展检测。 | 3.1.3 改为稳定义务 ID 与真实摘要；3.1.1 不宣称已实现全局语义终止。 |
| 🔵 建议 | `src/service.ts` 缺失 ref 恢复分支 | 结果为传输成功、读取失败的 `ok:false`，上层为 JSON 展示；未发现自动将它当证据的消费路径。 | 后续增加消费者时使用区分成功页/恢复结果的类型，并保留没有正文、批准、执行凭证的断言。 |
| 🔵 性能事实 | `src/workflow.ts` 的 Kahn 与祖先检查 | Kahn 核心为 O(V+E)，完整验证还有重复祖先遍历。 | 保留当前32节点/64边上限，不把整个验证器宣传为线性，也无需本补丁重写。 |

### 初版P1独立复现与修复后复验

初版复现使用当时的 `lib/route-state.js`（该次复现发生在路由模块修复前）和现有 `getSwarmConfig`，设置：

1. 一次性审核子会话初始链只有 `provider-a/old`，调用准入并记录真实 `old-request` attempt。
2. 运行中执行 `SetChildOverride` 选择健康的 `provider-b/new`，与本轮一次性选择分支的动作一致。
3. 原请求返回401，调用 `getErrorAction`。

实际结果：

```json
{
  "chosenAvailable": true,
  "action": null,
  "terminal": "route_chain_exhausted",
  "attemptedRoutes": ["provider-a/old"],
  "lastFailure": {
    "kind": "auth_invalid",
    "provider": "provider-a",
    "model": "old"
  },
  "terminalDetail": "provider-b/new 本次请求已失败；provider-a/old auth_invalid"
}
```

初版中，`provider-b/new` 实际没有调用且仍健康，却被写为“本次请求已失败”，故当时阻断发布。该问题随后由实现方修复；本审核独立重审最终差异并重新执行复现，四个状态码均得到：

```json
{
  "status": "400 / 401 / 403 / 404",
  "action": "retry",
  "terminal": null,
  "actualNext": "provider-b/new",
  "lastFailureProvider": "provider-a",
  "attemptedRoutesAfterNextAdmission": ["provider-a/old", "provider-b/new"]
}
```

复验先以当前`src/route-state.ts`即时转译执行，随后对已经重新构建的`lib/route-state.js`执行同一脚本。最后又运行包含预检换模、控制面终态和宿主活性的18文件测试集，不把初版通过结果沿用于修复后的源码。

最小复现代码（在项目根目录构建后使用 Node 的 ESM 模式执行）：

```javascript
import { intRouteStateRegistry } from './lib/route-state.js'
import { getSwarmConfig } from './lib/config.js'
const original = { provider: 'provider-a', model: 'old' }
const selected = { provider: 'provider-b', model: 'new' }
const agent = { id: 'one-shot-review', session: { header: { parentSession: 'root' } } }
const routes = intRouteStateRegistry()
const config = getSwarmConfig({ agents: { networkWaitMs: 0 } })
routes.AddChild(agent.id, { chain: [original], role: 'yu_shi', logicalRequestId: 'audit-plan' })
routes.getRequestOverride(agent, original, undefined, config)
routes.MarkRequestStarted(agent.id, 'old-request', original)
routes.SetChildOverride(agent.id, selected)
const action = await routes.getErrorAction({ agent, provider: original.provider,
  failure: { status: 401, message: 'old request authentication failed' } }, undefined, undefined, config)
console.log({ action, terminal: routes.getTerminal(agent.id), chosenAvailable: routes.isRouteAvailable(selected),
  recovery: routes.getRecovery(agent.id) })
```

### 已核对的边界

* 一次性选择分支没有调用 interrupt、resume 或 setPaused；选中值不覆盖 `actual`。异步模型校验后再次核对 CAS，能拒绝校验期间已经结算的选择。单调结算锁使迟到selection、等待或blocked通知也不能重开一次性会话。
* 真实 `agent/assistant-stream` 的 start 才记录 actual；初始候选与 requestedRoute 不成为已调用模型。规划审核完成记录仅附带实际观测到的 provider/model/reasoningEffort。
* `model-events` 仍保留 Issue #1 的隐藏占位：所有匹配事件 start 都返回状态，未知路由不制造 undefined 模型切换。
* 有效持久 ref 可恢复；缺 ref 仅返回当前授权索引。跨任务、旧版本、错误摘要、线程权限和盲审拒绝继续有效。
* 经验召回只增加最多2000字符的适用条件匹配，完整适用/排除条件仍保留。`Experience` 拒绝盲审，自动注入排除御史、复核及算衡验算，独立规划审核不注入经验。
* 文件发现显式 path 经 realpath 后检查工作区与私有根；遍历跳过链接。新增内部别名、私有别名和1MiB长路径截断测试真实通过，扫描容量不足返回 complete=false。未提供针对恶意并发目录替换的完整文件系统沙箱证明。
* glob 20MB 错误来自宿主完整 stdout 保护，不能解释成模型上下文不足；新增提示不提高缓冲、不自动重放。
* DeepSeek Fetch 的404不能证明目标网页不存在。新增提示保留 isError 和原错误，不切聊天模型、不修改可信端点、不发送密钥。

### 追加授权交互与抽屉需求边界

天枢persona新增5a条已复核：优先复用已有授权，只对真正缺失的用户专属决定调用`ask_user_question`，不得把pending、跳过、取消或超时视为批准。已直接核对本机DSH 0.2.1-rc.2的`dsh-user-questions`与`dsh-tool-ask-user`实现：timed参数确为`timeout`，`-1`用于必须得到回答才能推进的请求；普通缺省模式仍按当前schema执行。本轮只修改指引，不声称已实现运行时未决问题去重、状态迁移或持久化恢复；这些明确留在3.1.3。用户答复不能变成绕过版本/租约/服务器权限的通行证。

用户追加抽屉task-progress属于评估规划，本审核不将其视为3.1.1已实现功能，也不建议为该项扩大本轮源码改动范围。

### 真实宿主竞态证据复核

已读取并通过独立断言校验`docs/evidence/model-controls-3.1.1-2026-10-23/route-race-host.json`：

* `planning-model-switch`：4次实际请求，初始`swarm-mock/role-yu_shi`，选择后当时actual仍是旧模型，后续请求才使用`swarm-mock/reviewer-switched`。
* `planning-model-switch-failure`：5次实际请求，旧请求在选择之后返回401，后续使用`swarm-selected-mock/reviewer-switched`，结算锁为true，agentErrors为空。
* 两场景都没有将选择立即写成actual；缺失context结果没有正文，只含授权索引；写入尝试被拒绝。审核状态为`pass_with_degradation`，原因是该隔离fixture显式关闭Jev，不能把它当作真实Jev通过记录。

在复核其他Agent生成的证据之后，本审核又自己执行同两场景及真实问答来源场景，而不是只信任JSON文件中的结论。此为真实DSH AgentLoop加mock模型的隔离集成，不等同生产端口3080上的人工实测。

### 数学与路线审核

`docs/plans/2026-10-23-self-evolution-3.1.1-through-3.1.4.md` 已正确区分规划与实现，未把低相似度变化当成功、未剪强制安全审核边，也没有伪称已经复现 Lean 工件。

* 相邻距离趋零不能保证有限步停止或正确；常量错误输出可无变化。没有正定函数、单调下降等条件，不能称 Lyapunov 证明。
* 有限容量N加“后继与全部历史两两分离”的守卫，才有从初态起至多N−1次新转移的结论。仅相邻不同无法排除A→B→A。
* 固定DAG和每节点有界重试能保证固定代次有限；无限重规划、需求代次递增不在该证明内。
* 两个审核周期不足以声称统计显著。必要权限、风控、验收和盲审边不得自动删除。
* [Semantic Early-Stopping 原论文](https://arxiv.org/abs/2606.27009) 将距离收敛标为经验猜想；本轮未找到用户提及精确名称“Termination by Novelty”的可核验论文/Lean主来源，不宣传已核验。

性能边界：文件发现 O(B+F log F)，分页重新有界扫描；经验召回 O(E×T×L+E log E)，E≤1024、T≤64、L有界；精确全历史签名索引均摊查询可近似O(1)，构造仍随结构大小增长且存储O(H)，不能宣称完整语义判定O(1)。

## 3. 优化后代码示例

本次审核不修改共享源码。实现方已把回退入口改为显式接收已经观察到的失败路由，而不是使用可能被下一请求选择覆盖的链指针：

```text
已观察的旧 attempt → 仅隔离旧 route
人工选择的新 route → 保留为下一请求候选
旧 attempt 失败 → 按旧 route 排除/选择新的准入路径
新 attempt 实际开始 → 才更新 actual
```

此处是实现契约，不是可替代真实代码的完整实现。

## 4. 验证建议

本审核已真实执行并通过：

```bash
npx vitest run tests/unit/context-reference-recovery.test.ts tests/unit/context-store.test.ts tests/unit/project-discovery.test.ts tests/unit/tool-recovery.test.ts tests/unit/memory.test.ts tests/unit/checkpoint.test.ts tests/unit/blocked-recovery.test.ts
```

初审结果：7个文件、45项通过；新增长路径测试后重跑为46项通过。初版另真实执行401复现，确认P1；修复后上述400/401/403/404四项独立复验全部通过。

最终独立测试命令：

```bash
npx vitest run tests/unit/agent-control.test.ts tests/unit/client-model-display.test.ts tests/unit/planning-runtime.test.ts tests/unit/planning-liveness.test.ts tests/unit/route-state.test.ts tests/unit/planning-review.test.ts tests/unit/rpc-agent-control.test.ts tests/unit/service-agent-control-restore.test.ts tests/unit/context-reference-recovery.test.ts tests/unit/context-store.test.ts tests/unit/project-discovery.test.ts tests/unit/tool-recovery.test.ts tests/unit/memory.test.ts tests/unit/checkpoint.test.ts tests/unit/blocked-recovery.test.ts tests/unit/task-runtime.test.ts tests/unit/evidence-service-integration.test.ts tests/unit/plugin.test.ts
```

结果：18个文件、318项通过，退出码0。其中包括一次性不取消当前调用、不伪造actual、异步CAS结算拒绝、结算后迟到selection不可重开、持久会话停止/继续、预检期间再次换模、盲审缺ref仅返回授权索引以及大路径索引截断。

最终重审关键文件SHA256：

```text
83bf284b142cb318119676e4034f6b4ac566c6bbffa03d8314f9b6fe73f77e61  src/route-state.ts
61d79fa0a80d64404fde65e17cbcbebbd820156e07893bf6f6f1a1d35059b329  src/agent-control.ts
1cf13bcd3e5436d94fe36f39613781412cd2b8b870bd44ef359d4f50f3572f47  client/model-display.js
ae0b7be2841577f0f012397ef1541d74d1155562141bb63ca38039d7912db71e  src/role-registry.ts
b5f45de1858a9395ef3f5ea8769aeb577a95ef2ca829215e68f4bf0a1ed37ac7  docs/plans/2026-10-23-self-evolution-3.1.1-through-3.1.4.md
```

追加执行：

```bash
npx vitest run tests/unit/role-registry.test.ts tests/unit/intent-provenance-service.test.ts
npx vitest run --config vitest.integration.config.ts tests/integration/recovery-host.test.ts -t 'planning-model-switch|真实 ask_user_question'
```

结果分别为2文件11项通过；隔离集成1文件3项通过、12项因名称过滤跳过，退出码均0。没有把跳过的集成项标为通过。

边界：没有在本审核进程中执行全量类型检查、全量测试、真实生产服务重启、真实收费模型请求或GitHub发布；这些由主线执行并另存证据。本审核不将其他Agent的执行记录写成自己已执行。用户已选择等待生产会话结束后再部署，不能因代码审核通过提前发布。
