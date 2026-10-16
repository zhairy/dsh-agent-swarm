# 2.7.0 实施计划：按段快照、分片数治理与发布流程加固

## 1. 目标

2.6.0 把主写入路径降成 O(变更分片)，但留下 7 个结构性缺口。本轮逐条处理，并在过程中保留 v1/v2 日志兼容。

| # | 要求 | 本轮做法 |
| --- | --- | --- |
| 1 | 按段快照 | `snapshot/` 目录，段文件按内容指纹命名，`meta.json` 最后原子替换 |
| 2 | sidecar 外移 | 绑定历史按 agentId 有界（默认 4 条），更老的先写 `history/bindings.jsonl` 再移出状态 |
| 3 | 分片数治理 | `delegations` 按任务分桶；布局从「哈希」升级为「版本号 + 指纹」 |
| 4 | 孤儿清理显式化 | 校验层继续显式拒绝；新增离线修复命令 `scripts/repair-state.mjs` |
| 5 | 提交常数回归 | 段哈希缓存（真正生效）+ 切分编码（实测无效，已回退） |
| 6 | 发布流程自动化 | `scripts/pack-release.mjs`：构建 → 闭包校验 → 打包 → 校验和 |
| 7 | 打包前模块清单校验 | 从 `lib/index.js` 递归收集相对依赖闭包，逐项确认在 `npm pack` 清单里 |

## 2. 设计

### 2.1 按段快照（要求 1）

- 目录：`<state>/snapshot/`，文件 `<段名>.<指纹前16位>.json`，外加 `meta.json`。
- `meta.json`：`{ schemaVersion, sequence, layout, layoutFingerprint, checksum, segments: { 段名: { file, fingerprint } } }`。
  其中 `checksum` 是**分片根哈希**，读取时按声明布局重建分片后复核。
- 写入：只落盘指纹变化的段文件（内容寻址天然去重），随后原子替换 `meta.json`，最后清理不属于当前代的段文件并删除旧整份快照。
- 读取：优先按段快照；缺失时回退旧的整份 `snapshot.json`，两条路径都做布局校验与校验和复核。

### 2.2 绑定历史 sidecar（要求 2）

- `createAgentBindingRegistry(store, { maxHistoryPerAgent, archive })`：每次写绑定历史后按「提交后的历史」排序，
  每个 agentId 只保留最近 N 条，其余先经 `archive` 落盘再从主状态删除。
- 归档先于删除：崩溃只会留下「已归档但仍在状态里」的重复，不会丢审计记录。
- 归档文件只用于审计，不参与恢复与消息校验；更老的绑定本来也不会再有可投递消息（TTL ≤ 24h），因此 fail-closed 是安全的。

### 2.3 分桶分片与布局版本（要求 3）

- `SegmentSpec.bucketOf`：同一桶的元素合并成一个分片（分片 key = 桶键，值 = 元素数组）。
  `delegations` 用 `bucketOf: taskId`，段内分片数 = 任务数而不是委派总数。
- 整份编码不变：分桶只改分片划分，`encode()` / `getStateBytes()` / `materialize()` 与扁平布局逐字节一致（有回归断言）。
- 布局声明升级为「版本号 + 指纹」：
  - `layout`（数字）决定**能否续写增量**；低版本目录会在下一次写入时补一条迁移全量行；
  - `layoutFingerprint`（段名 + 类型 + 是否分桶的哈希）决定**规格是否真的对得上**。
  - 2.6.0 的行把布局哈希直接写在 `layout` 里，按旧算法复算比对。
  - 目录版本高于代码时直接拒绝打开，避免用旧布局改写。

### 2.4 孤儿修复命令（要求 4）

- 校验层不变：`DELEGATION_OWNERSHIP_INDEX` 明确拒绝「任务索引与委派记录不一致」的状态。
- `scripts/repair-state.mjs <state-dir> [--dry-run]`：用 `validate: () => true` 打开损坏状态，
  删除所属任务已不存在的委派、按记录重建每个任务的索引，先在内存里过一遍 `validateFeatureState`，
  通过后才写回；`--dry-run` 只报告不写。

### 2.5 提交开销（要求 5）

- **保留**：段哈希缓存（`Segment.hash`，未变段在预览中按引用复用）+ 分桶减少分片数。
- **回退**：曾尝试从整份 canonical 编码里切出段/元素子串以避免二次编码（`ChunkedState.fromCanonicalEncoded`）。
  实测 16 MiB 状态的全量 commit 反而更慢（JS 逐字符扫描比原生 `JSON.stringify` 慢），
  该实现与测试已删除，结论记录在本轮证据里。

### 2.6 发布流程（要求 6、7）

- `scripts/pack-release.mjs`：
  1. `npm run build`（可 `--skip-build`）；
  2. 从 `lib/index.js` 递归解析相对 `.js` 依赖，缺文件立即失败；
  3. `npm pack --dry-run --json --ignore-scripts` 取清单，逐项核对闭包文件都在清单里；
  4. 通过后 `npm pack` 产出 tarball，并连同 notes/manifest 生成 `SHA256SUMS`。
- `--ignore-scripts` 是必需的：否则 `prepare` 会在 pack 期间再次构建，把构建日志混进 JSON 输出。

## 3. 验证矩阵

| 面 | 手段 |
| --- | --- |
| 分桶语义 | `tests/unit/state-layout-migration.test.ts`（桶合并、桶删除、回放一致） |
| 布局迁移 | 同文件：低版本目录 → 迁移全量行 → 增量行；只读打开不迁移；高版本目录被拒 |
| 编码不变量 | `tests/unit/state-chunks-encoding.test.ts`（字节一致、分桶不改整份编码、循环引用分类为 STATE_INVALID） |
| 按段快照 | `tests/unit/state-store.test.ts`（元数据篡改/符号链接/压缩失败回退） |
| 绑定归档 | `tests/unit/agent-binding.test.ts`（每 agentId ≤ N，归档条目完整） |
| 修复命令 | `tests/unit/state-repair-script.test.ts`（dry-run 不写、修复后过完整校验、缺参数报错） |
| 打包校验 | `tests/unit/pack-release-script.test.ts`（闭包缺失为 0） |
| 端到端 | 全量单测、双宿主集成、对抗脚本、升级路径脚本、本机重启实测 |

## 4. 已知边界

- 归档文件不参与恢复：主状态里被移出的历史绑定不再能通过 `bindingHistory` 查询，这是有界化的代价（消息校验对超期绑定 fail-closed）。
- 修复命令只处理「孤儿委派 + 委派索引」两类结构问题；其它字段损坏仍会被 `validateFeatureState` 拒绝，需人工处理。
- 依赖闭包校验只识别相对 `.js` 字符串字面量；动态拼接路径或非 `.js` 资源不在校验范围内（当前构建产物没有这种用法）。
- 快照目录与 journal 仍是同目录下的文件；跨目录原子性依赖 `meta.json` 的最后替换语义，进程级崩溃不会产生半个代次，但断电级损坏仍需人工判断。

## 5. 后续

1. 快照与日志的跨文件原子性可以做「代目录 + 指针文件」进一步提升，但当前 `meta.json` 语义已足够。
2. 依赖闭包校验可扩展到子路径导出与非 JS 资源清单。
3. `messages` / `messageAcks` 仍是按条目分片的 dict 段；若要继续压分片数，需要消息归档策略而不是分桶。
