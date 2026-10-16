# 2.6.0 增量分片存储验证（2026-10-16）

## 背景与目标

2.5.x 的持久化提交是 O(整份状态字节)：`structuredClone` → `canonicalStateJson` → `sha256` → 整行写盘，
在每个请求边界执行。`route-health-capacity-2026-10-16` 实测 4/8/16 MiB 状态一次提交中位约
28.8 / 54.4 / 95.3 ms，是算法成本，与机器内存无关。

2.6.0 目标：主写入路径（任务卡、委派记录、绑定、消息、经验）的成本只与本次变更相关，
同时保留既有恢复语义、安全语义与容量护栏（持久化默认 4 MiB / 内存态默认 16 MiB）。

## 实现概要

- 状态按顶层段拆分成分片（`list` 段按元素键、`dict` 段按条目键，未声明段保持 `whole`）；
  每个分片持有 canonical JSON 编码、sha256、字节数与深冻结值，一次提交只重编码、重哈希、写盘变更分片。
- `update(type, write)`：直接补丁，或在 store 互斥区内以冻结的已提交状态求值补丁（消除读-改-写竞态）；
  补丁与已提交内容逐字节一致时短路返回 `{ changed: false }`，不写日志、不消耗序列号。
- journal 行两代混排：v1（2.5.x 全量行）照常恢复；v2 行携带段布局指纹与分片根哈希，
  增量行只写 `changes`；v1 行之后不得再出现 v1 行，段布局不一致被明确拒绝。
- 内存存储（绑定、消息、经验）增加脏追踪：`takeDirty` 取走即清空，提交失败 `restoreDirty` 放回；
  存储层仓库改为锁内读 + 变更分片补丁。

完整设计与实施步骤见 [实施计划](../../superpowers/plans/2026-10-16-incremental-store-2.6.0.md)。

## 验证

### 单元、类型与构建

- `npx vitest run`：76 文件 / 931 用例全部通过，含新增 `state-incremental-store.test.ts`（6 用例：
  分片编码、补丁合并、回放、超限拒绝、`changed:false` 短路、布局指纹）、
  `state-incremental-legacy-window.test.ts`（3 用例：升级前压缩崩溃窗口恢复、同序号链值不一致仍 fail-closed、
  声明段拒绝 whole 补丁）与 `state-invariants-regression`（「取走之后的新写入不丢」并发脏键回归）。
- `npm run typecheck`、`npm run build` 通过。

### 双宿主集成

真实 `dsh` CLI + 沙箱 profile（`vitest.integration.config.ts`），两个受测宿主版本各 8 文件 / 39 用例通过：
`0.2.1-alpha.4` 与 `0.2.0-rc.2`。`state-consistency` 场景按 v1/v2 行语义回放提交状态后断言。

### 升级路径（2.5.2 → 2.6.0）

`.work/verify-upgrade.mjs`（用 2.5.2 编译产物与 2.6.0 当前构建实测）：

1. 2.5.2 写 v1 日志两行（530 B / 262 708 B）；
2. 2.6.0 打开同一目录完整恢复（`recovered_state_equal true`，sequence 2，无校验和错误）；
3. 续写 v2 增量行（512 B，仅 `changes`），重开验证任务数一致、256 KiB 材料 roundtrip 一致。

### 复杂度（本机基准）

`scripts/bench-state-store.mjs`（12 采样、3 预热、`--expose-gc`、同进程交替），完整数据、构建指纹与
校验测量见 [benchmark.json](benchmark.json)（sha256 `2fabb5063547d330…`）：

| 状态规模 | 2.5.2 全量 commit 中位 | 2.6.0 全量 commit 中位 | 2.6.0 增量·whole 中位 | 2.6.0 增量·分片 中位 |
| --- | --- | --- | --- | --- |
| 0.25 MiB | 1.06 ms | 1.64 ms | 0.029 ms | 0.100 ms |
| 1 MiB | 3.66 ms | 5.28 ms | 0.033 ms | 0.075 ms |
| 4 MiB | 13.32 ms | 16.98 ms | 0.061 ms | 0.103 ms |
| 8 MiB | 26.34 ms | 34.50 ms | 0.085 ms | 0.122 ms |
| 16 MiB | 60.73 ms | 87.41 ms | 0.073 ms | 0.110 ms |

- 增量提交（主路径）中位数 0.029–0.122 ms，不随状态规模增长；16 MiB 下全量 87.41 ms 与增量 0.110 ms
  相差约 790 倍。
- 全量 `commit`（兼容与快照路径）比 2.5.2 慢 1.27–1.54×（分片遍历与哈希组合开销）；该路径未做优化，属已知取舍。
- 业务校验（`validateFeatureState`）：1000 委派 0.94 → 0.98 ms；4000 委派 2.36 → 2.29 ms；
  100 任务 / 4000 委派 1.67 → 1.65 ms（同一轮交替测量，未观察到系统性差异）。
- 本节数字在空闲机器上复测（`recordedAt` 见 benchmark.json）；更早一次带并发测试负载的记录绝对值更高，
  但「增量列平坦、全量列线性」的形状一致。

### 独立对抗性验证

`scripts/verify-incremental-adversarial.mjs` 只依赖构建产物，不读取仓库用例；12 项全部通过，
结果与模块摘要见 [adversarial-verification.json](adversarial-verification.json)：

| 面 | 结果 |
| --- | --- |
| 随机差分 | 120 步随机补丁（set/remove/order/dict）后 `read()` 与独立内存镜像逐字节一致；每次提交后 `getStateBytes()` 等于 canonical 编码长度、根哈希等于 `ChunkedState.fromState(read())` 的根哈希 |
| 幂等与并发 | 逐字节相同的 set 不写日志、不消耗序列号；16 个并发 `update` 全部落盘且序号连续 |
| 失败面 | 截断行、篡改 `previousChecksum`/`checksum`/分片编码、布局指纹不匹配、v2 后的新 v1 行、超限提交，全部 fail-closed 且不改变已提交状态 |
| 恢复面 | 升级前崩溃窗口目录可恢复；journal 超限先写快照再清空，恢复后状态/序号/根哈希一致 |
| 基线冻结 | `build` 在锁内收到的基线不可变（写入抛 `TypeError`），已提交状态不受影响 |
| 补丁边界 | 声明段缺席时的 `whole` 补丁被拒（`STATE_INVALID`）且段类型不被固化；`set`/`whole` 中的 `undefined` 抛 `STATE_INVALID` 且不落盘 |

### 本机部署

- `dsh-web.service` 于 2026-10-16 17:10 重启并持续运行；重启时点的 lib 已含分片增量路径
  （17:05 基准可测得 `incrementalWhole` / `incrementalChunk` 非空）。
- 重启后真实 `swarm.jevHealth` RPC 探针返回 `ok:true`（密钥已配置、真实上游可用）。
- 当前 lib 已在同一源码上重建两次验证确定性（`lib/state-store.js` sha256 `d8fb215c…`）；
  服务进程内为重启时点版本，如需与当前构建严格一致需再次重启。

## 实现期发现并修复的缺陷

1. **回放顺序**：list 段不显式记录 `order` 时，回放按 canonical JSON 字母排序的 `set` 键序重建，根哈希不符。
   修复：list 段始终显式记录完整键序。
2. **脏键误清**：`takeDirty` 不清空、成功后再清理，会把 `await` 期间的新写入一并清掉。
   修复：取走即清空，提交失败时 `restoreDirty` 放回。
3. **段首次出现**：增量行引用尚不存在的段时回放报错。修复：按声明类型创建段，未声明段仍然拒绝。
4. **内存记录的 `undefined` 字段**：分片编码需与旧全量路径一致地做一次 JSON 归一化（失败回退，不是默认路径）。
5. **升级前压缩崩溃窗口**（独立验证发现）：2.5.2「快照已写、日志清空未完成」留下的 v1 行与快照序号重叠时，
   恢复把整份状态校验和与分片根哈希混比，误判 `Snapshot and journal disagree`。修复：按行代际选择链值基准
   （v1 行比整份校验和、v2 行比分片根哈希）；与快照链值不一致的同序号 v1 行仍被拒绝。
6. **声明段的 `whole` 补丁**（独立验证发现）：声明为 `list`/`dict` 的段缺席时，`whole` 补丁会把段类型固化成
   whole，随后同段分片补丁被拒。修复：显式拒绝并提示改用 `set`/`remove`。
7. **补丁中的 `undefined` 值**（独立验证发现）：`set`/`whole` 传 `undefined` 时抛出非 `StateStoreError`
   （键提取或 JSON 解析错误）。修复：统一抛 `STATE_INVALID`，不落盘、不改变序号。

## 已知边界

- 全量 `commit` 路径存在小幅回归（见上表）；快照仍每 64 次提交整份写入，按段快照列入后续计划。
- 分片数随记录数增长；主成本已从「字节」降到「条目」，二级分片等治理列入后续版本（见计划 §6）。
- 回滚单向约束：2.5.2 无法解析 v2 日志行。回滚前须用 2.6.0 打开状态目录触发一次整份快照，
  或整体恢复 `~/.dsh/backups/agent-swarm-pre-2.6.0-20261016-170720`。
- 本节所有数字来自开发机内存态基准，不是 NAS、端到端、LLM 成本或 Token 收益基准。

## 证据文件

| 文件 | 说明 |
| --- | --- |
| [benchmark.json](benchmark.json) | 复杂度基准、构建指纹与校验测量（sha256 `2fabb506…`） |
| [verification.json](verification.json) | 结构化验证记录（测试计数、升级路径、源文件指纹） |
| [adversarial-verification.json](adversarial-verification.json) | 独立对抗性验证（12 项、模块摘要、脚本路径） |
| [实施计划](../../superpowers/plans/2026-10-16-incremental-store-2.6.0.md) | 设计与实施步骤、缺陷与后续计划 |
