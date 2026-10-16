# 2.6.0 实施计划：增量分片存储（O(变更) 提交）

## 1. 背景

2.5.x 的持久化是「每行完整状态」：`commit` 要对整份状态做 `structuredClone` →
`canonicalStateJson` → `sha256` → 写入 journal 行，并且每个请求边界都要做一次。

实测（`docs/evidence/route-health-capacity-2026-10-16/README.md`）：4/8/32 MiB 状态一次 canonical 编码约
10.5/19.8/71.9 ms，一次 `structuredClone` 约 3.7/8/30.1 ms。这是 O(n) 的算法成本，与机器内存无关。

目标：让**主写入路径**的成本只与本次变更相关，同时保留既有恢复语义、安全语义与容量护栏
（持久化默认 4 MiB、内存态默认 16 MiB）。

## 2. 设计

### 2.1 分片模型

- 状态按顶层段拆分：`list` 段（`tasks`/`delegations`/`threads`/`contexts`/`agentControls`）按元素 key 分片，
  `dict` 段（`bindings`/`bindingHistory`/`messages`/`messageAcks`/`experiences`/`budgets`/`planningBudgets`）按条目 key 分片，
  未声明的段（`schemaVersion`/`runtime`/旧 `routeHealth`）保持 `whole`。
- 每个分片持有 `encoded`（canonical JSON）、`hash`（sha256）、`bytes`、深冻结的 `value`。
- 段哈希 = 该段 `(key, chunkHash)` 集合的规范组合；根哈希 = 各段哈希的规范组合。

### 2.2 提交协议

- `update(type, write)`：
  - `write.patch`：直接给补丁；
  - `write.build(state)`：在 store 互斥区内、以**冻结的当前状态**为基线求值补丁 —— 读取、判断与写入同处一个事务，
    消除「读-改-写」竞态。
- 补丁结构 `StatePatch = { set, remove, order, whole }`；`preview()` 做编码与合并，
  **与已提交分片逐字节一致的 set 不计入触碰清单**；没有任何真实变化时 `update` 短路返回
  `{ sequence, changed: false }`，不写日志、不消耗序列号。
- 校验：`validateIncremental`（按分片）缺省回退到完整 `validate`。本插件当前使用完整
  `inspectFeatureState`，但对**已通过完整校验且深冻结**的材料跳过 `text` 摘要重算（引用身份即内容身份）。

### 2.3 日志格式

journal 行两代共存：

| 版本 | 内容 | 链值 |
| --- | --- | --- |
| v1（2.5.2 及更早） | `state`：完整状态对象 | `checksum(state)` |
| v2 全量行 | `state`：完整状态对象 | 分片根哈希 |
| v2 增量行 | `changes`：段 → `{ set, remove, order, whole }`（分片值是编码字符串） | 分片根哈希 |

- 每条 v2 行带 `layout` 指纹（段名 → kind 的哈希）。用不同段布局打开同一目录会被明确拒绝，
  而不是抛出难以定位的校验和不符。
- list 段在日志里**显式记录 order**：canonical JSON 会按键名排序对象字段，回放不能依赖 `set` 的键序。
- 混合顺序约束：v1 行之后不得再出现 v1 行（`Journal mixes legacy entries after upgraded entries`）。

### 2.4 脏追踪

- `evidence.ts`（tasks/delegations）、`threads.ts`、`context-store.ts` 记录写入口脏键；
- `takeDirty()` **取走即清空**，`restoreDirty()` 在提交失败时把同一批键放回。
  「取走」与「清空」必须原子：提交是异步的，若把清空推迟到提交成功之后，
  `await` 期间发生的新写入会被误清而永久漏写（实测缺陷，见 §5）。
- 无脏追踪的存储（测试替身）回退到原有全量 `persistFull`，语义不变。

### 2.5 存储层读改写

`createAgentBindingRegistry`、`createMessageBus`、`createExperienceRepository` 的写入口
从「拿草稿全量重写」改为「在锁内按补丁写入」：

```ts
await store.update('binding/revoke', { build: (state) => {
  const old = state.bindings[agentId]
  if (old === undefined) return {}
  const next = { ...old, state: 'revoked', revocationReason: reason }
  return { set: { bindings: { [agentId]: next }, bindingHistory: { [bindingKey(old)]: next } } }
}})
```

`build` 收到的 `state` 是冻结的已提交视图，因此「读到的就是本次提交的基线」，不会出现丢更新。

## 3. 复杂度

| 路径 | 2.5.2 | 2.6.0 |
| --- | --- | --- |
| 主写入（persist/绑定/消息/经验） | O(状态字节)（clone + 编码 + 哈希 + 写盘） | O(变更分片字节 + 段数 + 分片数) |
| 校验 | O(状态字节)（每请求一次） | O(记录数)（材料摘要按冻结引用缓存） |
| 恢复 | O(日志字节) | O(日志字节)，增量行很小 |
| 快照 | 每 16 次提交整份 | 每 64 次提交整份（按段快照列入后续） |

「分片数」随记录数增长，因此仍然需要治理（见 §6）；但对材料体量主导的状态，
主成本已经从「字节」降到「条目」。

## 4. 实施步骤

1. 抽出 `state-core.ts`（canonical 编码/校验和/深冻结），保持 `canonicalStateJson` 语义不变。
2. 新增 `state-chunks.ts`：分片模型、段规格、补丁、`preview`、`applyEncoded`。
3. 重写 `state-store.ts`：新增 `getRootChecksum`、`update`，支持 v1/v2 混排恢复与 `layout` 指纹。
4. `feature-session.ts`：注入段规格，persist 改为装配增量补丁；材料摘要按冻结引用缓存。
5. 三个内存存储加脏追踪（取走即清空 + 失败放回）。
6. 三个存储层仓库改为锁内读 + 变更分片补丁。
7. 扩展 `scripts/bench-state-store.mjs`：增加增量列与 256 KiB → 16 MiB 规模。
8. 回归与基准：单测全量、双宿主集成、升级路径脚本、本机重启实测。

## 5. 验证矩阵

| 面 | 手段 |
| --- | --- |
| 分片/回放/超限 | `tests/unit/state-incremental-store.test.ts`（6 用例） |
| 并发脏键 | `tests/unit/state-invariants-regression.test.ts`「取走之后的新写入不丢」 |
| 既有状态不变量 | `state-write-regression`、`pipeline-atomicity`、`task-runtime`、`upgrade-250-adversarial` |
| 业务级校验 | 全量 `npx vitest run`（75 文件 927 用例） |
| 真实宿主 | `vitest.integration.config.ts` × 2 个 DSH 版本（各 8 文件 39 用例） |
| 升级路径 | `.work/verify-upgrade.mjs`：2.5.2 产物写 v1 → 2.6.0 恢复并续写 v2 |
| 复杂度 | `scripts/bench-state-store.mjs`（`docs/evidence/incremental-store-2.6.0/benchmark.json`） |
| 本机部署 | `dsh-web.service` 重启 + `swarm.jevHealth` 真实 RPC 探针 |

### 5.1 实现期发现并修复的真实缺陷

1. **回放顺序**：`buildChanges` 原先只在补丁显式给出 `order` 时才写它，回放因此按被 canonical JSON
   字母排序后的 `set` 键序重建 list 段，导致根哈希不符（`Journal checksum mismatch`）。
   修复：list 段始终显式记录完整键序。
2. **脏键误清**：`takeDirty` 不清空、`clearDirty` 在提交成功后按快照删除，会把 `await` 期间的新写入一并清掉。
   修复：`takeDirty` 取走即清空，失败时 `restoreDirty` 放回。
3. **段首次出现**：增量行引用尚不存在的段时回放报错。修复：按声明类型创建段，未声明段仍然拒绝。
4. **内存记录的 `undefined` 字段**：分片编码必须与旧全量路径一致地做一次 JSON 归一化（失败回退，不是默认路径）。

## 6. 后续计划（2.6.x / 2.7）

1. **按段快照**：`snapshot.json` 拆成按段文件，使快照写入也变成 O(变更段)；保留向后兼容的整份快照读取。
2. **sidecar 外移**：把 route health 之外的大体积诊断（如维护账本）继续移出核心状态，减少分片数。
3. **分片数治理**：为 `delegations` 等增长型 list 段引入按任务的二级分片，使「段内分片数」不随历史累积线性增长。
4. **孤儿清理显式化**：当前增量路径不做「删除任务时顺带清理孤儿委派」，改为在校验层显式拒绝并提供修复命令。
5. **提交常数回归**：在保持分片哈希语义的前提下，缓存未变段的段哈希，压掉全量 `commit` 的固定开销。

## 7. 回滚

- 代码回滚到 2.5.2 后，**已写入的 v2 行 2.5.2 无法解析**。回滚前必须先把状态导出为整份快照
  （或用 2.6.0 重新打开后触发一次快照写入），并在发布说明中明确这条单向升级约束。
- 状态目录本身可整体从 `~/.dsh/backups/` 恢复；本轮已备份
  `agent-swarm-pre-2.6.0-20261016-170720`。
