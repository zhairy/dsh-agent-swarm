# 百工中途失败 `route_health_persist_failed` 修复证据（2026-10-16）

## 症状

真实会话 `session-09556361-9064-46a0-a725-02df334725c6`（任务 T-1，本地默认内存态 `persistence.enabled=false`）在
2026-10-16 08:07 完成一次委派持久化时报 `Error: State exceeds byte limit`，此后每一轮模型请求都在请求边界返回
`本轮运行失败 route_health_persist_failed`，工具写入（委派、规划审核、写状态）全部失败，会话无法自愈。

## 根因链（含证据）

1. 完整状态在每次提交时做 canonical JSON 编码并强制 4 MiB 上限：
   `src/state-store.ts`（`maxStateBytes ?? 4 * 1024 * 1024`，超限抛 `STATE_TOO_LARGE 'State exceeds byte limit'`）。
   该检查对内存态同样执行；`STATE_TOO_LARGE` 不置 `failed`，因此不是一次性熔断，而是每次提交都重复失败。
2. 会话合法增长可以越过该上限：材料单件 1 MiB × 512 件、委派记录（结构化结果、证据评估摘录）、线程历史、
   任务检查点等全部内嵌在同一份状态里，准入上限与状态上限互不协调。
3. 路由健康快照原本写入**每个会话的完整 feature state**：`src/service.ts` `onHealthChange` →
   `features.persist('route/health', …)` → 整份状态序列化。任一会话超限都会让健康提交失败。
4. 健康提交失败是故障域语义：`src/route-state.ts` 置 `failedHealthCommit` 与
   `recovery.terminal='route_health_persist_failed'`，`WaitHealthReady` 在之后每个请求边界（`src/runtime.ts`）
   抛 `SERVICE_UNAVAILABLE route_health_persist_failed`，并且会重新尝试注定失败的提交 → 逐轮“处理失败”风暴。
5. 现场测量（会话转录，只读）：失败前最后一次 `swarm_context_read` 材料清单为 29 条、合计 494 732 B（约 483 KiB），
   说明本次溢出**不是**材料单项，而是记录类数据的累计；材料准入上限与状态上限脱钩只是同类风险之一。

## 修复

1. **故障域与任务状态解耦**（结构性）：
   - `FeatureSession.persistRouteHealth()`：持久化模式下健康快照写入独立的有界 sidecar
     （`<state>/…/route-health/snapshot.json`，原子写 + fsync + 校验），不再随整份任务状态提交；
     内存态没有落盘故障域，健康只留在进程内，`onHealthChange` 不再产生任何请求边界等待。
   - `FeatureSession.readRouteHealth()`：恢复时优先读 sidecar；旧持久化状态的内嵌 `routeHealth` 作为一次性兼容回退。
   - `persist(type, tasks, threads)` 不再接收/写入健康快照；所有调用点同步调整。
2. **内存态容量上限与持久化分离**：`persistence.maxStateBytes`（0=自动）新增配置；
   持久化默认 4 MiB（日志/快照 I/O 有界），内存态默认 16 MiB——内存态没有日志写入，
   4 MiB 只是实现细节而非安全边界，长任务不再在同一位置被顶死。
3. **材料准入预算**：`ContextStore` 按编码字节记账，`Add` / `PrepareTaskReplace` 只在净增长时校验
   `状态上限 − 预留 − 非材料占用`；净缩小始终放行（修订任务卡即收缩救援路径）。拒绝发生在写入之前，
   不产生幽灵材料，错误为 `CAPACITY_EXCEEDED` 且给出可操作指引。
4. **容量失败可诊断**：`persist` 命中 `STATE_TOO_LARGE` 时改抛 `CAPACITY_EXCEEDED`，附试提交总量、
   上限与最大字段归因（如 `delegations 2.1 MiB、contexts 0.9 MiB`），并声明“完整状态未被部分写入”。
5. **观测**：`swarm_status` 与 `swarm.taskView` 暴露 `stateBytes / stateLimitBytes / contextBytes`，
   容量增长可监控、可复盘。

## 验证

- 单元与回归：`npx vitest run` → 74 文件 / 920 用例全部通过，其中
  `tests/unit/state-capacity-regression.test.ts` 断言：超预算材料在写入前被拒、状态仍可提交、
  净缩小替换放行、内存态健康提交不进入任务状态且不产生 `route_health_persist_failed`；
  `tests/unit/task-runtime.test.ts` 断言持久化模式健康 sidecar 的恢复、半开所有者剥离、非法快照拒绝与清除语义。
- 真实 Host 集成（`vitest.integration.config.ts`，真实 `dsh` CLI + 沙箱 profile）：8 文件 / 39 用例全部通过
  （含 `state-consistency-host`、`recovery-host`、`flows`、`bundle`、`upgrade-host` 等），见 `verification.json`。
- 构建：`npm run build` 通过（tsc + client 构建）。
- 内存态提交成本（本机实测，`scripts/bench-state-store.mjs` 同款 load）：4 MiB 状态中位 14.2 ms / p95 18.3 ms；
  8 MiB 35.0 / 39.9 ms；16 MiB 72.6 / 81.8 ms。提交发生在委派、任务卡、数学计算等低频边界；
  健康快照已不再触发整份状态提交，16 MiB 默认值可接受。

## 正反面审核（两路 agent 对抗）

- 正面（软件工程设计）：确认根因链成立，并指出结构性缺陷是“单个集合上限与整份状态上限互不协调”；
  实测 4/8/32 MiB 状态一次 canonical 编码约 10.5/19.8/71.9 ms、一次 structuredClone 约 3.7/8/30.1 ms。
  建议长期将 contexts/证据摘录移出原子状态（sidecar + digest + fail-closed）。
- 反面（对抗评审）：用会话转录证伪了“材料是本次主因”——失败前材料清单仅 29 条 / 494 732 B，
  真正的累计大头是委派记录（结构化结果、证据评估摘录）等记录类负载；并指出
  ①`addContext` 先写内存后提交，容量守卫必须发生在写入之前（本次已如此实现）；
  ②健康提交失败不得与任务容量失败混为一类（本次按持久化 sidecar 解耦，内存态不再参与请求边界）。
- 结论：双方一致同意“健康/故障域与任务状态解耦 + 准入与状态上限协调”是必须项；
  对“是否立即把记录负载迁移到 sidecar”存在分歧，本次以诊断归因 + 内存态上限提升作为边界，
  结构性迁移列入后续候选。

## 已知边界（不做无限承诺）

- 持久化模式完整状态仍受 4 MiB（或配置值）约束；记录类增长（委派结构化结果、证据评估摘录、线程历史）尚未逐项设上限，
  达到上限时会得到单次 `CAPACITY_EXCEEDED` 与字段归因，不会出现逐轮失败风暴；后续建议将记录负载迁移到独立 sidecar（见下）。
- 内存态 >4 MiB 的状态无法通过 maintenance `pending.json`（上限 4 MiB）做版本迁移；这是既有桥接的显式边界。
- 本次修复不回溯修复已经卡死的旧进程状态：内存态状态在进程内，只能重启会话重建（账本仍是只读审计源）。

## 后续候选（未在本次实施）

- 将 `contexts` 文本与 `delegations[].evidenceAssessment` 摘要移出原子状态（内容寻址 sidecar + digest 校验 + 缺失即 fail-closed），
  使状态体积与提交成本与记录负载解耦。
- 给角色契约字符串（`contracts.ts`）、线程历史 request、消息总线条目增加显式总量上限。
