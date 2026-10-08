# 工程反方审查：审批来源与宿主边界

审查时间：2026-10-08 09:57（Asia/Shanghai）。结论：本轮工具审批实现在已验证的公共 SDK 组合范围内通过；它增加宿主审批请求或拒绝，不改变外层开发环境权限，也不证明原生客户端内部工具受百工守卫控制。

## 来源核实

- 历史 `MCP tool call requires approval, but approval policy is never` 属于开发回合的 MCP client，发生在 Jev 返回判断之前；不能据此判断 Jev API 本身故障。本轮主协调官已经报告真实 `mcp__jev__jev_health` 成功，旧拒绝未复现；本工程 Agent 没有重复调用或绕过拒绝。成功不能归因于新增百工代码，因为二者处于不同控制层。
- 当前本机 Codex 配置未声明顶层 `approval_policy` / `sandbox_mode`，所以没有证据认定该文件配置错误。审批设置也可能由活动宿主注入。本轮未修改 Codex、MCP wrapper、秘密文件或全局配置。
- 已读取的 Jev v0.2.1 缓存源码中，七项工具使用无显式 annotations 的 `@mcp.tool()`；其中 health 只调用 `list_models()`。准确补充只读提示是上游元数据改进候选，但不是客户端放行保证；外部 API 仍属于开放世界，判断请求可能外传材料且重复计费，不能伪装为闭域或保证幂等。没有把缓存源码当成当前客户端有效工具目录的完整证明。

## 三层控制

| 层 | 本轮能力与边界 |
| --- | --- |
| 开发环境 / Codex MCP client | 外层策略独立生效。百工不能修改它或把失败写成通过；操作者通过宿主支持入口管理。 |
| DSH ToolRuntime / 百工 | 配置 `approvals.mode=inherit/ask/deny` 与四类 scope，默认 inherit。只管理百工所属会话；其他插件会话保持原行为。 |
| Native Codex / Claude | 各自 SDK 与已配置实例决定内部工具行为。`never` 是禁止请求审批，不等于只读；`approve-for-me` 是 Codex 自动评审，不是 DSH 人工审批。本轮没有扩展或更改 native 权限。 |

scope 的真实工具映射：write 为 `write/edit`；shell 为 `bash/pwsh/run_code`；external_mcp 为 DSH 的 `mcp__` 公共名称（包括外接 Jev）；jev 为插件七个 `jev_*` 工具。内部规划与复评的 Jev HTTP 不经过 ToolRuntime，不属于这项工具审批配置。

真实 DSH 0.2.0-rc.2 证据：`dsh-mcp-client/lib/index.js:97` 构造 `mcp__${serverName}__${rawName}`；`dsh-user-approval/lib/index.js:172-176` 先检查取消与 never，再派发 answerer；`dsh-subagent/lib/index.js:529-559` 在委派时给 child 固定 never。服务名为 `approval`，公共结果仅 `allowed-once/rejected/cancelled/unavailable`，请求必须位于 open turn。

`index.ts` 使用 prepend + await next 包裹正常 pre-execute 组合，保留已有 deny/cancel/ask；额外 ask 仍交给宿主，缺渠道失败关闭。最终单调 guard 保留角色、任务版本、取消和工作区约束，并支持审批等待期间切换 deny。没有调用 `setPolicy`、注册自动许可应答者或复用审批。

UI 应区分继承、额外申请、额外拒绝，以及宿主 never / 渠道不可用；不能把配置 ask 显示为已获许可，也不能将 native never 显示为只读。本文件不替代浏览器 UI 验证。按本轮收敛，不增加抗任意新插件 prepend 且不 next 的执行 token 校验器，因此不宣传对任意第三方短路监听器的 ask 强保证；deny 的最终 guard 仍保留。

## 已执行测试

- 首轮 `tests/unit/approval-policy.test.ts`：23/23 通过，包含五项真实发布 SDK 测试。
- 补充审批服务缺失、answerer 抛错/非法返回的负控后，该文件为 24 项，其中六项使用实际 DSH 0.2.0-rc.2 的 Cordis、scope、ToolRuntime 和 ApprovalService。当前执行选用完整的本机 global SDK；会话日志与应答者是隔离 fixture，不是人工 UI，不是完整 AgentLoop，也不发送模型请求。CI 无完整 SDK 时这些六项明确 skip。
- `npx vitest run tests/unit/approval-policy.test.ts tests/unit/service.test.ts tests/unit/config.test.ts`：51/51 通过（09:54）。验证单次许可、每调用独立审计、拒绝/缺渠道、never 与 delegation never、取消丢弃迟到许可、等待中切 deny 和最终只读 guard；index 接线验证百工所属判定与下游决定保留。
- `npx tsc --noEmit --pretty false`：09:57 通过。`git diff --check` 对本工程 Agent 修改文件通过。

## 冻结快照

| 文件 | SHA-256 |
| --- | --- |
| src/approval-policy.ts | `970c6906da972fefcd041bf57919fd8c0cd398c499cf3501b45bee717389524e` |
| src/host-contract.ts | `9d6330365bd686b5cf20b6caa53f723f0a4d865eb6d65b2abf4e8d2d0f3bc8ac` |
| src/index.ts | `294da048c0bf181a18a5b58beab96dcba3979142bb3bcd93770b536a1b33b078` |
| tests/unit/approval-policy.test.ts | `4f252be5af812c93c959fbd5388a201b2218da1f3c0f38f05e39599aa76830ba` |

外部一手契约：[Codex MCP 配置](https://developers.openai.com/codex/mcp/)、[MCP 工具规范](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)、[DSH Codex 原生 wire](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent-codex/src/wire.ts)、[DSH Claude 原生权限处理](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent-claude-code/src/run.ts)。native 链接是上游当前源码，并非本轮已安装运行的 native 二进制验证。
