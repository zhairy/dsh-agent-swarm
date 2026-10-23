# 代码审查报告

## 1. 总体评价

- **评分**：⭐⭐⭐⭐☆（4/5，限定于本报告审核范围）
- **摘要**：上下文缺失引用从无法继续处理的通用异常，改为明确失败但可恢复的当前授权索引；没有恢复旧授权、旧正文或替代审批。文件发现和宿主工具恢复提示采用局部改动，减少重复大范围搜索，同时保留原错误和访问边界。定向回归及真实 DSH AgentLoop 场景通过；该结论不代替最终安装包、本机 3080 Web 实测及发布校验。
- **审核范围**：`src/context-store.ts`、`src/service.ts` 的 `ReadContext`、`src/memory.ts`、`src/project-discovery.ts`、`src/tool-recovery.ts`、`src/index.ts` 的恢复提示接入，以及相关测试。没有审阅本轮全部 UI/模型控制改动，也没有据此作出全库无缺陷保证。

## 2. 详细审查

| 级别 | 位置 | 结论或问题描述 | 验证与处置 |
| :--- | :--- | :--- | :--- |
| 🔵 确认 | `context-store.ts`、`service.ts:ReadContext` | 仅确实不存在的 ref 使用 `CONTEXT_REFERENCE_UNAVAILABLE`；既存材料的根会话、工作区、任务、版本、摘要及线程权限错误仍拒绝。 | 单元测试覆盖相同文本摘要的新需求版本不自动恢复旧 ref、跨任务、错误摘要和未绑定专家。 |
| 🔵 确认 | `service.ts:ReadContext` | 恢复返回 `ok:false`、`mayUseForImplementation:false` 和当前授权索引，不含正文或分页游标，不创建新材料，不改变规划或验收状态。 | 新增恢复回归；300 次合同修订的既有回归已更新为明确的失败恢复断言，验证旧 ref 不在当前索引、当前版本一致、审批状态不变。 |
| 🔵 确认 | `task-runtime.test.ts` | 盲审的御史和算衡验算读取缺失 ref 时，作者过程不会通过恢复索引泄漏。 | 先生成真实 `author-reasoning` 材料，再委派两类盲审；恢复索引仅包含允许类型，直接读取作者 ref 仍被拒绝。 |
| 🔵 确认 | `memory.ts` | 补充适用条件词法召回有实际用途，仍只召回已审查经验，完整条件不会因截断而丢失。 | 每条新增检查最多 2000 个 UTF-16 字符；候选、过期记录、本任务结果仍过滤，返回值保留 `applicabilityUnverified:true` 与 `requiresVerification:true`。 |
| 🔵 确认 | `project-discovery.ts` | 相对 `path` 可以缩小真实目录范围；索引数、索引路径字节与页路径字节分别限制，取消信号保持生效。 | 定向测试覆盖绝对/上级路径拒绝、私有目录及其别名拒绝、外部 symlink 拒绝、内部目录别名、旧 cursor、取消与长路径容量。 |
| 🔵 确认 | `project-discovery.ts` | `complete:false` 时明确告知未扫描范围未知，cursor 只分页当前有界索引，避免把“不在结果中”解释为“不存在”。 | 3000 个长路径测试使索引达到字节上限，再缩小子目录后能够完整发现；返回页保持有限大小。 |
| 🔵 确认 | `tool-recovery.ts`、`index.ts` | 只给百工管理的失败工具结果追加建议；不重放操作，不修改 `isError` 或原 error，不把网页 Fetch 404 当作页面不存在。 | 定向测试覆盖 overflow、Fetch 404、成功/取消/无关错误以及提示去重；配置地址仍要求用户选择。 |
| 🟡 验证边界 | 真实宿主集成 | 已运行真实 DSH 运行时、Session、专家工具和隔离工作区；供应商模型和 Jev 响应为固定 fixture。 | 能证明宿主装配、绑定、工具结果和状态机行为，不证明公网模型、Fetch 端点或多小时业务任务的服务可用性。 |

本范围内未发现直接阻断此次补丁发布的权限旁路或错误成功声明。文件系统目录可在扫描期间变化；现有摘要游标会对可观测索引变化返回 stale，这不是跨进程原子文件系统快照保证。

## 3. 优化与复杂度

上下文正常读取为 Map 定位与分页切片，成本为 O(返回页长度)。缺失引用的恢复路径只枚举当前任务可见材料，为 O(当前任务材料数)，材料总数仍受既有 512 上限控制；没有新增历史引用表或持久化写入。

经验检索仍扫描至多 1024 条记录；每条新增适用条件扫描最多 2000 字符。已有排名与输出预算不变，不引入 embedding、联网或自动提示/工具/工作流修改。

文件发现对本次有界索引进行排序，若保留 M 条路径，则为 O(M log M)；扫描量受 8192 个目录项和 1 MiB 路径预算约束，单页路径预算为 32 KiB。每页重新扫描用于校验变化，不能宣称总成本 O(1)。本轮通过缩小 `path` 控制常见成本，没有引入昂贵全局索引服务。

这些局部改动没有新增依赖、数据库迁移或第二套任务控制面。

## 4. 验证记录

2026-10-23，在 `.work-v3` 执行：

```bash
npm run typecheck
npx vitest run tests/unit/task-runtime.test.ts tests/unit/evidence-service-integration.test.ts tests/unit/project-discovery.test.ts tests/unit/tool-recovery.test.ts
npx vitest run --config vitest.integration.config.ts tests/integration/recovery-host.test.ts -t '真实宿主自动规划'
```

- 类型检查通过。
- 本次增补定向单测：4 个文件、63 项通过；包含御史/算衡盲审、300 次合同修订、文件发现和工具恢复。
- 本次增补真实宿主集成：3 个场景通过，11 个未选择场景跳过；场景为 planning-enforced、planning-phase-pass、planning-phase-low。
- 规划审核者及执行专家均真实调用 `swarm_context_read` 获取缺失 ref，宿主工具执行成功返回结构化 `ok:false`，没有被伪装成材料读取成功；正文不存在、恢复指示明确。
- 低分规划场景仍不产生业务专家，规划状态保持 `review_required`、验收保持 `blocked`，缺失 ref 恢复没有授予执行权限。
- 初轮上下文、分页、经验、工具与任务运行定向验证另有 7 个文件、87 项通过；与本轮存在重叠，不能简单相加作为独立总覆盖数。

最终发布前由主持者完成全量验证、候选包检查及真实 3080 宿主测试。本报告不将尚未执行的验证记为通过。
