# 状态存储与协作状态性能审查（2026-10-08）

本轮对 `state-store.ts`、`feature-session.ts`、`agent-binding.ts`、`message-bus.ts` 做局部优化，保留提交校验与失败关闭。冻结的相关源码/测试 SHA-256 见 [performance-review.json](./performance-review.json)，可复现测量见 [state-store-benchmark.json](./state-store-benchmark.json)。本记录不是整个发布的独立 Jev 审核结论。

## 修改与作用

- 状态提交在完整 canonical JSON 与业务 schema 校验后复用同一份 canonical 字符串，计算状态/日志校验和并构造磁盘 envelope，减少重复编码。memory-only 模式不再构造永远不会落盘的日志行。
- 已验证的私有 JSON 状态使用 `structuredClone` 生成隔离副本；新增只复制指定路径/字段的 `readPath`、`readFields`。绑定查询只复制一个绑定，消息读取只复制身份/消息/ACK，不必复制任务、上下文、经验等无关状态。兼容没有新方法的旧 store 实现。
- 任务和委派记录的双向归属校验建立按任务分组的 Set。保留全局委派 ID 唯一性、任务内 ID 唯一性、缺失/多余记录及跨任务归属拒绝，去除每个任务反复全表扫描及数组线性查找。
- 首次创建 journal 使用已有 `atomicStateFile` 完成文件和目录 fsync，再允许追加提交。初始化和恢复变换异常清理当前进程拥有的 owner inode，避免同一活进程再次打开时被遗留 owner 阻塞；释放时不删除已经被替换的 owner 文件。

## 复杂度与空间取舍

记 B 为完整状态的 JSON 大小，P 为选中投影大小，T 为任务数，D 为委派记录数，dᵢ 为第 i 个任务的委派数，M 为消息数，H 为绑定历史大小。canonical JSON 对对象字段排序，因此更精确的编码成本是 O(B + Σ k log k)，k 为每个对象的字段数；不能把任意对象的 canonical 编码都宣称为严格线性。

| 路径 | 优化前 | 优化后 | 取舍 |
| --- | --- | --- | --- |
| 完整状态 read | canonical 编码再 parse | structuredClone，仍 O(B) | 保留副本隔离，减少重复字符处理；未使全量读取成为 O(1) |
| 单绑定查询 | O(B) 全状态复制 | O(路径深度 + P) 投影复制 | 固定大小绑定不随无关大上下文增长；无可变内部引用泄漏 |
| commit | 多次完整编码/parse/哈希及全量日志行 | 一次 canonical 校验编码、复用字符串；仍有全量 draft/parse/返回副本和哈希 | 总渐进复杂度不变，减少常数；新增常驻 canonical 字符串 O(B) |
| 任务/委派关联校验 | O(TD + Σ dᵢ²) | Set/Map 平均 O(T + D) | O(T + D) 索引空间；没有降低完整 schema 校验范围 |
| message pull | 全状态复制，再过滤/排序 | 选中字段复制，再过滤/排序；仍 O(M log M + H) 及字段体积 | 排除任务/上下文大字段；没有引入需要双写维护的持久次级索引 |
| 持久恢复 | 读取并验证 snapshot 和完整 journal | 保留原验证，当前优化未改变渐进复杂度 | journal 64 MiB、state 4 MiB 默认上限继续生效 |

本轮选择用 O(B) canonical 缓存交换编码 CPU，而没有改为增量日志/差分状态：后者需要处理部分状态、增量校验、索引一致性及恢复迁移。状态仍受大小限制，完整校验是明确保留的成本。未测量峰值内存下降，也未声称本轮减少峰值内存。

## 可复现性能结果

同一进程交替运行基线 `cab2c805a55cd8b16d80703e1bb36eca6dcacb79` 和当前代码，每项预热 10 次、正式 50 次，Node 24.21.0，Intel Core Ultra 5 125H，Linux 6.12。基线通过 `git archive` 导出并用同一 TypeScript 编译器重新编译，不使用来源不明的旧构建。JSON 留存环境、基线 commit、编译模块摘要、样本数、中位数、P95、最小/最大值。

| 场景 | 基线中位数 | 本轮中位数 | 中位耗时变化 |
| --- | ---: | ---: | ---: |
| 2 MiB ASCII 状态完整 read | 7.521 ms | 1.437 ms | 降低 80.90% |
| 2 MiB ASCII 状态 memory-only commit | 44.649 ms | 13.067 ms | 降低 70.73% |
| 2 MiB 状态中的单绑定查询 | 7.383 ms | 0.038 ms | 降低 99.48% |
| 1 任务 / 1000 委派完整 feature 校验 | 2.127 ms | 0.536 ms | 降低约 74.79% |
| 1 任务 / 4000 委派完整 feature 校验 | 23.459 ms | 1.496 ms | 降低约 93.62% |
| 100 任务 / 4000 委派完整 feature 校验 | 5.728 ms | 1.537 ms | 降低约 73.17% |

这里的 store 测量关闭磁盘持久化且不传业务 schema validator；完整 feature schema 校验单独测量。结果只说明这组本机合成数据的 CPU 热路径，不能推广成 NAS fsync、端到端模型任务耗时、计费或 token 节省承诺。GC、并行负载、对象形态和机器配置会影响数值。

复现命令（在仓库中执行，`BASE` 指向导出的基线源码目录；导出目录需能解析本仓库已安装的 `node_modules`）：

```bash
git archive cab2c805a55cd8b16d80703e1bb36eca6dcacb79 | tar -x -C "$BASE"
node_modules/.bin/tsc -p "$BASE/tsconfig.build.json"
npm run build
node --expose-gc scripts/bench-state-store.mjs \
  --baseline-dir "$BASE/lib" \
  --baseline-ref cab2c805a55cd8b16d80703e1bb36eca6dcacb79 \
  --current-dir lib --samples 50 --warmup 10 \
  --output /tmp/state-store-benchmark.json
```

## 正确性边界与验证

提交仍由同一 mutex 串行执行；canonical JSON、有限数值/普通 JSON、大小限制、credential/accessor 禁止和业务 schema 校验都在发布前执行。磁盘版本仍为 v1，固定 canonical 字段排序及 state/entry checksum 的兼容性有回归测试。没有用跳过验证、返回内部对象或异步延后落盘来换性能。

持久提交只有在 journal 写入并 fsync 成功后才更新进程内状态；失败阻止后续写入。若日志已经持久但后续压缩失败，已经提交的事务仍返回成功并可恢复，store 随后进入需恢复状态；不会声称事务已经回滚。首次 journal 文件目录项也通过原子替换与目录 fsync 持久化。

以下 5 个测试文件共 **58 项通过**；`npm run typecheck` 与相关文件 `git diff --check` 通过：

```bash
npm test -- tests/unit/state-store.test.ts \
  tests/unit/feature-state-validation.test.ts \
  tests/unit/agent-binding.test.ts \
  tests/unit/message-bus.test.ts tests/unit/task-runtime.test.ts
```

新增负控覆盖投影/返回副本/逃逸 draft 不可改内部状态、坏快照和初始化失败清理 owner、恢复变换异常后可重开、替换 owner 不被删除、压缩失败保持已持久提交、以及缺失/多余/重复/跨任务委派索引。既有消息取消/代际隔离、ACK 恢复、身份鉴权、任务运行时和工作区约束用例保持通过。

owner inode 检查与私有目录是保守生命周期措施，不构成对同权限恶意进程修改文件系统的完整隔离；没有扩展这种保证。外部 Jev 审核是否调用成功、以及其对整体代码的判断，应以根审查记录为准。
