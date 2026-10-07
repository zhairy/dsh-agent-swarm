# 软件工程反方最终审查

审查日期：2026-10-08（Asia/Shanghai）。对象为当前工作树，不等同 Git HEAD 或已发布版本。审查者：engineering_skeptic；本报告记录代码审查与实际测试，不将 Jev 概率当作正确性证明。

## 结论

在下面明确覆盖的路径中通过；本轮未发现尚未处理的工程阻断问题。前期发现的双真源、旧规格证据复用、身份尚未绑定、取消后延迟工具、未知副作用租约、并行幂等、POSIX symlink/.. 路径，以及终态故障持久化窗口，均已形成对应代码约束和回归证据。有限测试不能保证全部数学结论、所有部署环境或任意外部代码正确。

## 终态故障的持久化闭合

- `service.ts:ensureFeatures` 在赋值缓存前恢复并校验 routeHealth；真正根会话 `WaitAgentReady` 在持久化开启时于首个模型请求前加载，子会话等待身份与持久提交就绪。
- 所有正常 FeatureSession.persist 调用带入 routeState.getHealth；仅在节点结束时保存仍会遗漏“根首个请求失败且全备用耗尽、从未调用任务卡”及崩溃窗口，因此新增 `RouteStateOptionsInfo.onHealthChange`。
- `getErrorAction` 先在内存隔离明确 quota/pool/余额或长 Retry-After，随后等待健康态 durable commit，成功后才选择/返回恢复动作；没有备用也先提交。写入失败标 `route_health_persist_failed` 并抛出，不能返回 retry 或被外层委派当作普通错误重启。
- 默认预检 `RouteProbe.onFailure` 等待同一钩子；确认隔离立即返回 route-isolated。service 仅在 persistence.enabled 时持久化已加载根会话，共享域同时保存；关闭时保持进程内状态并明确覆盖范围。
- `RestoreHealth` 原子校验 key/kind/route/policy/时间/别名，清除旧进程 half-open 身份，保留当前进程较新的隔离或 live claim；没有 reset 信息不自行设置 TTL，不按根十分钟恢复窗口解除额度隔离。

## 已执行验证

| 实际命令/范围 | 结果 |
| --- | --- |
| npm run build | 通过 |
| npx tsc --noEmit --pretty false | 通过 |
| npx vitest run tests/unit/routes.test.ts tests/unit/route-state.test.ts tests/unit/network.test.ts tests/unit/jev.test.ts tests/unit/task-runtime.test.ts | 95/95 通过；最后执行 2026-10-08 00:28（Asia/Shanghai） |
| npx vitest run --config vitest.integration.config.ts tests/integration/recovery-host.test.ts | 10/10 通过；最后执行 2026-10-08 01:07，31.29 秒 |
| route-state 单元文件中的真实官方 Cordis + dsh-scope + dsh-llm-retry | 0.1.7-rc.2、0.2.0-rc.2 各 normal/always；托管终态不生成宿主 llm/retry 等待，非托管会话保留原策略 |

完整 AgentLoop 使用实际沙箱宿主与预设，供应商由确定性 mock stream 模拟：pool exhausted + 9060669 ms 后仅原失败请求一次、备用继续；所有备用 quota 时停止；oneshot/continuable 不出现三重外层重启；成功备用真实写文件一次。供应商模拟不等于已向付费服务发送实测请求。新增第十场景以默认启用 planningReview、enforced 和 requireJev=true 运行；真正 spawn 御史 custom outputSchema，官方 Mermaid 11.12.0 parser 与 localhost Jev HTTP mock 双审同一冻结快照；真 read 成功、实际 write 工具调用被拒且无文件；依赖跳步和提前验收负控仍阻止执行，业务分析真读 README 后正常 accepted。

新增持久化测试验证提交前尚未选择备用、无备用终态也提交、存储拒绝时不调用宿主 next、不重启，以及解析预检等待提交。Service 公共测试覆盖合法复核/行舟 shell、取消迟到调用、advisory 未知副作用保护、幂等及未启动预算退款、绑定等待、任务版本与私有文件路径（含真实 POSIX symlink/..）。

## 真实宿主补充审查及修正

真实 planning 集成发现两个 service mock 未揭示的生产缺口，均已修正并经第十场景验证：

- `maxDepth=0` 是绝对子智能体深度，真实宿主拒绝 root 深度 0 到 reviewer 深度 1；改为 maxDepth=1，仍阻止再派生深度 2，保持只读工具过滤。
- 宿主技能目录以 user role、source.kind=skill-catalog 注入；旧 getTaskIntent 取最后一个 user，把目录当作需求。现选择真实 human 来源，并排除技能目录/后台通知等注入；集成断言冻结原文精确匹配用户输入，不放宽为仅目标自验。

Jev 缺失用量修正单独执行 `npx vitest run tests/unit/jev.test.ts tests/unit/jev-tools.test.ts`：27/27 通过；缺失、负数、非有限、不安全整数和部分用量保持 unknown，合法零仍已知；组合查询的缺失部分及估算费用为 null+usage_unknown，控制台明确未知。Jev 不因 unknown 用量增加调用额度限制。

## 覆盖限制

1. 真实 AgentLoop 的 `prepareRequest` 仅特殊处理 NO_ADAPTER；其余 prepareCall 异常可能直接发 agent/error，不进入 request-error 恢复 waterfall。本次快速切换验证覆盖 stream/request-error 路径与模型解析预检，未宣称解决 prepareCall 全阶段重发；若要覆盖，需要正式宿主恢复接口或已验证适配。
2. 测试 profile 只安装 dsh-base、driver 与 swarm，未安装 native Codex/Claude 子智能体包。native 内部 HTTP 尝试、退避与进程副作用停止仍不可验证；能力声明与实际验证分开，不将最终结构化错误等同 pre-delay 控制。
3. generation `attempts` 是 request admission 的保守边界；stream/start 观测单列且去重。不将无法观察的 provider/native 内部 HTTP 重试记为零或宣称统一物理计费。
4. 插件保护受管 FS 接口及 context/message 身份；任意 shell/native 程序、NFS 掉电耐久、分布式并写和性能/token 节省未获本轮证明，保持已有明确边界。
5. 标准 Qwen 单 key provider 依据已核验适配器契约共享 plan；Go 按 model，Claude/Codex 账号域保持 unknown。自定义同名 provider 必须用显式 policy 覆盖，不能将推断当作实际账号身份确认。

## Jev 辅助核查

实施过程中实际使用 TypeSafe 技能、官方 API/Noul 文档及 Jev MCP：jev-1.13.0 对“终态先于 next”“无本地 Jev 使用额度”“如实区分覆盖范围”给出 0.86/0.80/0.89，无 uncertain；677 输入、63 输出 tokens，4160.765 ms。该次判断针对实施摘要，未审计所有后续改动；最终结论来自上述代码与测试。原始成功输出与 state/propositions 已另存 `jev-routing-review.json`，明确不是后续全部改动的最终 Jev 审计。第十集成的 Jev 是 HTTP fixture，不冒充真实服务审核。

## 审查快照

后续源码改动会使以下哈希绑定失效，需重新核查相应部分。

| 文件 | SHA-256 |
| --- | --- |
| src/routes.ts | `8379d55c3a8c576aa73af6064627c41d80f7305a5e158ef335aa73bd8fa54bcc` |
| src/route-state.ts | `9055341fd4dc604845bfb2d7f73c1c0ee4e92ffae83970acce575e43abe110b0` |
| src/route-health.ts | `143bfc56f2fb4dea1ef33992476fbbe933cd83751e459a6f5b3e5e8b6ce25d78` |
| src/provider-policy.ts | `e2fa36426ac622739d0e9c10ed3dc3c762ded62b12fdde380a04fdf092f7039d` |
| src/runtime.ts | `11de1201da9cb6919a220d07fd0d39939bc52f8a5b010d7237ee490f3ae71e6c` |
| src/jev.ts | `a3767aa9483eea1df575bb16f123b7b823567399503c70715787b3a5232e8e64` |
| src/service.ts | `8cc8910760802ceccc193fdd5be75387895be7d4eafdd294340c58f6068bdabc` |
| tests/unit/route-state.test.ts | `990f02d1d81487ceccad2750718915f9019d8b3fc698798dc9811e4829628579` |
| tests/unit/routes.test.ts | `23bd614b981060acbd5a4fd1789777369067f0bf8910e406511de9104d2dcdd8` |
| tests/integration/recovery-host.test.ts | `8a2cd3a2b835341f9118dd5ec24e0a7828a48014d99aacaae36919295aa369aa` |
| tests/integration/driver/recovery-scenarios.js | `23fd09dc1ae9695bfecb6dbf9013a47840ab5b1f6f6f5094e7cb5f6be524efee` |
| src/task-model.ts | `2577b01ace132410e3db171cc0df7b49c3fdc8f64a07df3c9ce384c23f0515aa` |
| src/jev-tools.ts | `c143bccbd8d74f285bd90e2f1c3bee5a68684c5d516aeda2b08a2363df217fa5` |
| tests/unit/jev.test.ts | `df3ad81799a6b22a40fbc6dd0b98dc407c4301d8b681d33546bb43138637eb44` |
| tests/unit/jev-tools.test.ts | `2ecc299eaf24a9fb0285062e416b70c1f09c58fdd679785015584e85b7ac133e` |
