# 2.7.0 存储结构加固验证（2026-10-16）

## 1. 目标与结论

2.6.0 把主写入路径降成 O(变更分片)，但快照仍是整份、绑定历史与委派分片随历史线性增长、布局信息不足以支撑演进。
本轮逐条处理，设计见 [实施计划](../../superpowers/plans/2026-10-16-incremental-store-2.7.0.md)。

| 要求 | 结论 | 证据 |
| --- | --- | --- |
| 按段快照 | 达成：`snapshot/` 目录，段文件按内容指纹命名并复用，未变段不重写 | `tests/unit/state-store.test.ts`、§3 |
| sidecar 外移 | 达成：绑定历史每 agentId 保留最近 4 条，其余写 `history/bindings.jsonl` | `tests/unit/agent-binding.test.ts` |
| 分片数治理 | 达成：`delegations` 按任务分桶，段内分片数 = 任务数 | `tests/unit/state-layout-migration.test.ts` |
| 孤儿清理显式化 | 达成：校验层显式拒绝 + `scripts/repair-state.mjs` | `tests/unit/state-repair-script.test.ts` |
| 提交常数回归 | 基本消解：全量 commit 1.13/1.25/1.04/0.97/1.05×（切分方案实测无效已回退） | §2 |
| 发布流程自动化 | 达成：`scripts/pack-release.mjs` 构建后打包 | `tests/unit/pack-release-script.test.ts` |
| 打包前模块清单校验 | 达成：入口依赖闭包（67 文件）逐项核对 `npm pack` 清单 | 同左 |

## 2. 全量提交与增量提交（本机基准）

`scripts/bench-state-store.mjs`（12 采样、3 预热、`--expose-gc`、同进程交替），完整数据与模块指纹见
[benchmark.json](benchmark.json)（sha256 `600b3fecb9a1c072…`）：

| 状态规模 | 2.6.0 全量 commit 中位 | 2.7.0 全量 commit 中位 | 比值 | 2.7.0 增量·分片 中位 |
| --- | --- | --- | --- | --- |
| 0.25 MiB | 2.82 ms | 3.19 ms | 1.13× | 0.166 ms |
| 1 MiB | 11.23 ms | 14.00 ms | 1.25× | 0.190 ms |
| 4 MiB | 40.46 ms | 41.96 ms | 1.04× | 0.222 ms |
| 8 MiB | 77.93 ms | 75.45 ms | 0.97× | 0.188 ms |
| 16 MiB | 100.99 ms | 106.32 ms | 1.05× | 0.149 ms |

- 增量提交仍然平坦（0.149–0.222 ms），与状态规模无关。
- 全量 commit 的常数回归已回到 1.0× 附近（8 MiB 甚至略快）。
- **失败的尝试也已记录**：一度实现「从整份 canonical 编码切出段/元素子串以避免二次编码」
  （`fromCanonicalEncoded`）。实测 16 MiB 状态的全量 commit 反而慢到 1.25–1.57×——
  JS 逐字符扫描比原生 `JSON.stringify` 慢，该实现与测试已删除，只保留段哈希缓存这条真正有效的路径。

## 3. 按段快照行为

- 段文件名为 `<段名>.<指纹前16位>.json`：内容未变时文件名不变，写入直接复用已有文件，因此一代快照的写入量只与变化段相关。
- `meta.json` 最后原子替换；替换前崩溃只会留下无人引用的段文件（下次快照清理）。
- 读取优先按段快照，缺失时回退旧整份 `snapshot.json`；两条路径都做布局校验与校验和复核。
- 篡改 `meta.json`（schemaVersion、符号链接）与压缩写入失败都会 fail-closed，见 `tests/unit/state-store.test.ts`。

## 4. 布局迁移与保护

`.work/verify-upgrade.mjs`（2.5.2 真实构建产物 → 2.7.0 当前构建，使用插件真实的 `SWARM_LAYOUT_OPTIONS`）实测：

```
journal_lines [
  { version: 1, layout: undefined, hasChanges: false, hasState: true },
  { version: 1, layout: undefined, hasChanges: false, hasState: true },
  { version: 2, layout: 2, hasChanges: false, hasState: true },
  { version: 2, layout: 2, hasChanges: true, hasState: false }
]
line_bytes [ 530, 262708, 262812, 534 ]
reopened_ok true material_roundtrip true
```

读法：2.5.2 写出的两行 v1 全量行 → 2.7.0 完整恢复 → 首次写入补一条**迁移全量行**（262 KB，一次性）→
随后的写入是 **534 字节的增量行**。

保护措施：

- 低版本目录（layout 缺失 / 1 / 2.6.0 的布局哈希）允许打开并自动迁移。
- 目录版本**高于**代码版本直接拒绝（`newer layout version`），避免旧代码改写新目录。
- `layoutFingerprint` 与规格不符时拒绝（`different chunk layout`），
  这条在实现过程中曾因「layout 从哈希退化成版本号」而丢失，已补回。

## 5. 测试与验证

```bash
npm run typecheck
npx vitest run                      # 80 文件 947 用例
npm run verify:incremental          # 12/12
SWARM_DSH_VERSION=<版本> npx vitest run --config vitest.integration.config.ts
```

- 单测：80 文件 / 947 用例通过。
- 双宿主集成：`0.2.1-alpha.4` 与 `0.2.0-rc.2` 各 8 文件 / 39 用例通过。
- 对抗验证：12/12（含随机差分、布局拒绝、崩溃窗口、并发、基线冻结、补丁边界）。
- 本机部署：见 §6。

## 6. 本机部署

以下为 2026-10-16 23:29 CST 的实测记录（不是预写声明）：

- 状态目录备份：`~/.dsh/backups/agent-swarm-pre-2.7.0-20261016-232850`（23 MiB）。
- `dsh-web.service`（用户级单实例）于 23:29:07 重启，`systemctl --user is-active` 返回 `active`；
  进程加载的构建为 `lib/state-store.js` sha256 `4cc4f8a81684878b…`（与发布物同源）。
- 真实宿主 RPC 探针（带认证 cookie）：`POST /api/swarm.jevHealth` → HTTP 200、`result.ok=true`；
  `POST /api/swarm.jevStatus` → HTTP 200、`result.ok=true`。
- 启动日志扫描（`journalctl --user -u dsh-web.service`）：无 `STATE_TOO_LARGE` / `STATE_INVALID` /
  `route_health_persist_failed` / `RECOVERY_REQUIRED`。

## 7. 已知边界

- 归档文件不参与恢复；被移出主状态的历史绑定不再能通过 `bindingHistory` 查询（消息校验对超期绑定 fail-closed）。
- 修复命令只处理孤儿委派与委派索引两类结构问题，其它字段损坏仍由 `validateFeatureState` 拒绝。
- 依赖闭包校验只识别相对 `.js` 字符串字面量；动态拼接路径与非 JS 资源不在覆盖范围内。
- 快照目录与 journal 仍是同目录文件；进程级崩溃不会产生半个代次，断电级损坏仍需人工判断。

## 证据文件

| 文件 | 说明 |
| --- | --- |
| [benchmark.json](benchmark.json) | 复杂度基准、构建指纹（sha256 `600b3fec…`） |
| [verification.json](verification.json) | 结构化验证记录（测试计数、升级路径、布局迁移、真实宿主） |
| [adversarial-verification.json](adversarial-verification.json) | 独立对抗性验证（12 项、模块摘要，sha256 `df3fd8a0…`） |
| [实施计划](../../superpowers/plans/2026-10-16-incremental-store-2.7.0.md) | 设计与实施步骤、缺陷与后续计划 |
