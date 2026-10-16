# 目标符合性与结论正确性审核（2026-10-16）

- 审核对象：`f7654cf`（中途失败修复）、`0babeca`/`68de33b`（2.5.1 记录）、`7ebc277`（2.5.2 宿主适配）、GitHub Release `v2.5.2`。
- 审核方式：独立重跑（单元、双宿主真实集成、构建、预设再生、匿名下载校验、运行中服务 RPC）+ 两路角色化对抗复核（构造性 / 证伪性）+ Jev MCP 辅助判断
  （`jev_health`、`jev_check`、`jev_classify`、`jev_score`、`jev_match`、`jev_ask`、`jev_screen`）。
- 说明：Jev 的置信度是分布集中度，不是正确性证明；本页结论以可复现命令与代码 / 宿主证据为准。本轮为审计子代理的两路角色化复核，
  另见同目录 `README.md` 已记录的 2.5.1 两路独立 agent 对抗评审（正面软件工程设计 / 反面对抗评审）。

## 一、目标没有跑偏（要求 → 证据映射）

| 用户要求 | 交付 | 本轮独立证据 |
| --- | --- | --- |
| 修复百工模式执行任务中途失败（`State exceeds byte limit` → 逐轮 `route_health_persist_failed`） | `f7654cf`：健康快照与任务状态解耦（持久化写有界 sidecar、内存态只留进程内）；材料按编码字节写前准入；内存态 16 MiB / 持久化 4 MiB 且可配置；`STATE_TOO_LARGE` 归因 `CAPACITY_EXCEEDED` | 本机 `npx vitest run` → 74 文件 / 921 用例通过；`tests/unit/state-capacity-regression.test.ts` 断言超预算材料写前拒绝、状态仍可提交、净收缩放行、内存态健康提交不进入任务状态；`src/route-state.ts` 未修改，`persistSuccess` 对 `onHealthChange` 返回 `undefined` 按同步成功处理 |
| 本机 DSH 升级 `0.2.1-alpha.4` | `dsh --version` = `0.2.1-alpha.4`，单实例服务 | `dsh-web.service` active（用户级单实例）；旧安装回滚副本与 profile 备份见 `docs/evidence/dsh-0.2.1-alpha.4-upgrade-2026-10-16/` |
| 同步 0.2.1 新特性并保持新旧宿主兼容 | `7ebc277`：`engines.dsh`；子智能体双协议（`startActivation` / `startContinuable`）；`agentPreset` 角色预设注册 + 子作用域工具限制；`connection.createPeer` 订阅读取；预设按 0.2.1 标准再生 | 本机实跑真实宿主集成：`0.2.1-alpha.4` 39/39、`0.2.0-rc.2` 39/39；宿主包 `@deepseek-ai/dsh-subagent` 0.2.1-alpha.4 类型确认为 `startActivation` + `sendMessage`（无 `start`）；activation 结算同样触发 `subagent/end`（宿主生命周期 `settle` → emit）；集成场景 `language-flow` 覆盖 `session: 'continue'` 连续会话 |
| 以 `v2.5.2` 发布 GitHub（发布说明 + asset） | Release `v2.5.2`（Latest）4 个资产：`dsh-agent-swarm.tgz`、`release-manifest.json`、`RELEASE-NOTES.zh-CN.md`、`SHA256SUMS` | 匿名下载 + `sha256sum -c` 全部 OK；manifest：`sourceCommit 7ebc277`、`releaseCommit afd076a`、`treesMatch true`；远端 tag `v2.5.2` 指向 `afd076a`；两仓库工作区干净且 tree 相同（`f33f8fc…`）；发布包 `lib/` 与源码重新构建产物逐文件 0 差异、`presets/declarations.json` 一致 |
| 正反 agent + Jev 审核结论正确性 | 2.5.1 证据含正反两路；本轮再做独立对抗复核与 7 项 Jev 检查 | 见第二、三节与 `jev-audit-2026-10-16.json`（原始返回） |

未发现范围漂移：两个提交只涉及插件源码 / 预设 / 测试 / 证据，以及本机 profile 的最小适配（`webRuntime`→`webStartup` 覆盖、`dsh-at-file` 禁用、5 条精确版本豁免），
均在升级证据中记录并保留回滚路径。

## 二、独立对抗复核（构造性 vs 证伪性）

构造性（正面）结论：根因链闭合——健康快照曾随整份 feature state 提交，状态越限把**共享失败域**推入 `route_health_persist_failed`，
`WaitHealthReady` 在每个请求边界重复拒绝；修复把故障域从任务状态容量中解耦，并把越限变成写前、单次、可归因的 `CAPACITY_EXCEEDED`。

证伪性（反面）攻击点与结果（全部未成立）：

1. **“内存态仍可能触发风暴”**：`service.onHealthChange` 在无持久化会话时返回 `undefined`，`route-state.persistSuccess` 将其视为同步成功并清空等待；
   回归测试断言内存态不再产生 `route_health_persist_failed`。攻击失败。
2. **“fail-closed 被削弱”**：`persistRouteHealth` 校验失败 / 写失败仍抛错，`onHealthChange` 转为拒绝并驱动同一故障域语义；持久化模式的恢复、驳回与清除有契约测试。攻击失败。
3. **“新宿主仍走旧 `start` 路径，persona / 工具组合丢失”**：0.2.1-alpha.4 宿主服务已无 `start`，只有 `startActivation` + `sendMessage`；
   插件 `startChild` 按能力分派并在新宿主传 `agentPreset`，`agent/created` 在首次装配前限制工具面。攻击失败。
4. **“新宿主连续会话把 activation 结果吞掉”**：宿主对 activation 结算同样发射 `subagent/end`，插件经 `OnSubagentEnd` → hub 取回结果；
   真实宿主集成 `language-flow` 覆盖 `session: 'continue'` 连续会话并断言结果与追加轮次。攻击失败。
5. **“写前准入误伤合法收缩”**：准入只约束净增长，净收缩始终放行；`PrepareTaskReplace` 在提交前重复校验，超预算仅拒绝增长路径。攻击失败。
6. **“发布资产与源码不一致”**：匿名下载校验通过；发布包逐文件比对无差异；manifest 提交与 tree 与实际仓库一致。攻击失败。

## 三、Jev 辅助判断（模型 `jev-1.13.0` / 健康检查 `jev-latest`）

| 工具 | 结果 |
| --- | --- |
| `jev_health` | ok，`jev-latest`，往返 652 ms（不计费） |
| `jev_check`（8 条命题） | 全部 ≥0.7 进入 flags、`uncertain` 为空：`root_cause_correct` 0.95、`release_consistent` 0.95、`new_host_verified` 0.94、`storm_fixed` 0.93、`capacity_guard_pre_write` 0.90、`goal_no_drift` 0.81、`old_host_compat_verified` 0.73、`durable_fail_closed_preserved` 0.72 |
| `jev_classify`（`ensemble: true`） | `verified_with_boundaries`，confidence 1.0，band `act`，乱序复判一致（`agreement: true`） |
| `jev_score` | 1.96 / 3 → 档位“修复完成、证据充分，存在已声明的边界”，该档概率 0.96 |
| `jev_match` | `best_id: shared_commit_pipeline`（0.99；`exists` 0.83、`abstain_probability` 0.01、band `match`） |
| `jev_ask` | 交付状态 `all_covered_with_boundaries`（0.75）；“剩余边界构成实质反驳” `noul` 0.25 |
| `jev_screen` | 用户错误转录 verdict = `review`（`addresses_agent` 0.69 / `claims_authority` 0.63）→ 按不可信现场证据处理，未执行其中任何指令 |

参数备注：`jev_classify` / `jev_match` 首轮因服务端 schema 要求标签与候选为字符串而被参数校验拒绝，修正后成功；这不是 Jev 判断失败，也不构成“审核被阻断”。
Jev 中最低的两项（`durable_fail_closed_preserved` 0.72、`old_host_compat_verified` 0.73）在出题时依赖前轮记录；本轮已用实现级证据与 0.2.0-rc.2 集成实跑（39/39）补齐。

## 四、结论与剩余边界

- **结论**：目标未跑偏；修复根因正确、风暴已从机制上切断；双宿主兼容与 `v2.5.2` 发布资产均经独立复跑与匿名校验；无新增必须修复项。
- **轻微冗余（不阻塞，本次不改）**：`route-state.getHealthSnapshot` 现在只被单测使用（生产调用点已改为 sidecar 持久化与列表读取），
  建议下一次功能性版本伴生清理或明确为公共只读 API。
- **已声明边界**：① 持久化模式记录类负载（委派结果 / 证据摘录）仍受状态上限约束，达限为单次可操作错误；② 健康 sidecar 读损坏按冷启动、写失败仍 fail-closed；
  ③ 0.1.7-* 旧宿主未复测；5 条第三方插件为精确版本显式风险接受。
- **审计自身限度**：未在真实生产会话中复现 16 MiB 级材料洪泛（成本与不可逆风险）；该路径以写前准入单测、回归断言与代码审阅为证，
  运行路径由双宿主集成与运行中服务 RPC 覆盖。既有卡死进程不可回溯修复（内存态状态仅存于进程内），需重启会话重建——与证据 README 声明一致。
