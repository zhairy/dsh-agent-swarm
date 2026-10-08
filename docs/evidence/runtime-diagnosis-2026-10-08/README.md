# 百工 2.3.0 真实会话错误诊断

取证对象是本机升级前的百工会话，取证时间为 2026-10-08。下表记录 **2.2.2 及历史版本的观测与风险**；实施和验收状态以 [2.3.0 实施计划](../../superpowers/plans/2026-10-08-v2.3.0-runtime-recovery-and-evidence.md) 为准。

## 范围与隐私

读取 454 个会话的首行头，按百工预设与父子关系确认 276 个会话；178 个无关会话不读取正文。只扫描各会话最高 canonical generation，排除 8 个旧代和继承种子。归属会话共 74,668 条事件，提取 735 条工具错误、模型错误或命令非零退出标记，正常事件不导出。解析失败、解压告警和扫描期间变化文件均为 0。

**735 是标记事件数，不是 735 个插件缺陷。** 同一失败可能同时出现在 attempt 与 turn/end；`rg` 无匹配导致退出 1 也不等于插件故障。DSH shell 非零退出不一定设置 `isError`，因此同时检查退出码、超时和信号。压缩会话通过 zstd CLI 读取串联帧，源日志未修改。

完整对话、正常用户/助手内容、完整工具参数、凭据和原始错误集合不提交仓库。私有取证只保留脱敏错误摘录和定位索引。本文仅列本次功能相关的聚类。

## 观测、归因与修复

| 观测 | 实际结论 | 对应修复 |
| --- | --- | --- |
| 当日两次“规划修正轮次用尽” | 插件在保存任务卡前抛错，必要的 scope 收窄同样被挡 | 合同编辑不受自动审核额度锁死；自动审核暂停后可显式复审；审查预算与执行预算分离 |
| 一次 `src/task.ts` 不存在 | 路径猜测，不能归因为 rg 未安装 | 发现实际项目文件的工具和近距离探索指导；空匹配为正常结果，不自动猜另一个文件 |
| 三次私有 state/ledger 通用读取被拒 | 隔离按设计生效，但恢复指引缺少可发现的授权材料 | `swarm_context_read` 可先列出当前授权材料；账本摘要走 `swarm_status`，不解除私有文件保护 |
| “Summarize probe measurements” 非零退出，`TypeError: string indices must be integers, not 'str'` | 命令的数据形状假设错误，未见审批或守卫拒绝 | 识别真实退出码；按实际工具 schema 和测量结构处理结果，不宣称插件禁用了执行能力 |
| ChatGPT/Codex 当日三次 `pool exhausted` 和一次 `TRANSPORT` | 当日未见 ChatGPT 明确 usage/quota/401/403；池错误没有揭示成员失效原因 | 区分池、认证、网络和额度；修复永久健康隔离；提供作用域受限的恢复探针与人工模型切换，真实订阅调用另行验证 |
| Qwen 明确返回月额度耗尽及恢复时间 | 是 Qwen 自身的订阅额度事实，与 ChatGPT 独立 | 遵守供应商 reset，立即转备用模型，不跨 provider 扩大封锁 |
| OpenCode Go 四次 `CONTEXT_WINDOW_EXCEEDED`，262144 上限下请求增长至 277019–459079 tokens | 请求上下文问题，不能按泛 400 把健康模型永久下线；百工错误接管还拦截了宿主已有的压缩恢复 | 独立上下文错误分类；调用真实宿主压缩，确认上下文确实前进后有界恢复，不盲目换模型重复同一超长请求 |
| 16 次 `structured_output` 参数错误，其中 15 次沿用平坦摘要而缺三维审核结构 | 真实工具要求 `value` 内完整的三维嵌套审核结果，泛交付提示不足 | 当前规划审核提交模板靠近输出要求，明确必填字段、空数组与未知状态；不能补造通过结论 |
| 两次专家邮箱未启用却尝试调用 | 工具能力披露与实际配置不一致 | 依据实际持久化和邮箱能力过滤工具并在委派中说明可用恢复方式 |

## 修复前路由架构风险

- 健康记录没有 reset 或 cooldown 时会永久拒绝领取恢复探针；half-open 失败又删除恢复时间，持久化和跨根共享使临时故障长期残留。
- 泛 400/402/404/422 被统一归为模型不可用，会混入上下文、请求格式等错误。
- 聚合池无可用成员不等于订阅额度耗尽。既有错误元数据中有一分钟 retry 提示，未提供 ChatGPT 额度域或 reset 的确证。
- 新设计区分供应商明确的 `resetAt` 和插件自己的 `retryAt`，新逻辑请求最多一个受控 half-open；人工重试不能清空其他 provider 的隔离或绕过确切 reset。

这些源码风险已经确认，但不能在缺少模型池成员级证据时，把它们宣称为下午所有 ChatGPT 失败的唯一原因。真实宿主探针和实际订阅验证是最终归因与验收的必要补充。

## 全角色配置与最后实际路由

以下配置是升级前当前 profile 的受限投影，原文件最后修改于 **2026-10-08 22:48:21（Asia/Shanghai）**。这是配置快照，不等于每个历史任务都使用此链。当前未覆盖的行舟使用源码默认链。表内 `@` 后是声明的推理强度，不等同每次实际请求的最终默认档位；实际调用依据已提交助手消息的 `source.provider/model`，不依赖模型自报或仅依据下一次选择器。

为缩短表格，provider 映射固定为：**C=codex、L=claude、Q=qwen-token-plan-cn、G=opencode-go、D=deepseek-official、A=antigravity**。C/L/Q/G 在此配置下属于订阅类，D 是官方计费 API；名称相似的 `G/deepseek-v4.1-flash` 与 `D/deepseek-flash` 必须分开。没有观测样本的角色不判为健康，也不判为额度耗尽。

| 角色 | 当前基础声明链 | 最后观测到的实际 provider/model；本地时间 | 已知跳过/回退原因与判断边界 |
| --- | --- | --- | --- |
| 天枢 / `tian_shu` | `C/gpt-6.1-sol@max` → `L/claude-opus-5-5@max` → `Q/deepseek-v4.1-flash@max` → `G/deepseek-v4.1-flash@max` → `D/deepseek-flash@max` | `opencode-go/deepseek-v4.1-flash`<br>2026-10-08 22:56:47 | 最新来源是 Go 订阅，不能因 DeepSeek 名称称其已到官方 API；自动 header 与人选混淆的旧 root 风险见下文。 |
| 谋定 / `mou_ding` | `Q/deepseek-v4.1-flash@max` → `C/gpt-6.1-sol@xhigh` → `G/qwen3.8-max@xhigh` → `D/deepseek-flash@max` | 未知 | 没有可归属成功来源，原因未知；不能判为正常或已耗尽。 |
| 枢机 / `shu_ji` | `L/claude-opus-5-5@xhigh` → `C/gpt-6.1-sol@max` → `Q/deepseek-v4.1-flash@max` → `G/deepseek-v4.1-flash@max` → `D/deepseek-flash@max` | `codex/gpt-6-sol`<br>2026-09-27 16:57:42 | 只有 9/27 历史样本，早于当前配置；不推断当日恢复结果。 |
| 算衡·研算 / `suan_heng:research` | `C/gpt-6.1-sol@max` → `Q/deepseek-v4.1-flash@max` → `G/deepseek-v4.1-flash@max` → `D/deepseek-flash@max` | `codex/gpt-6-sol`<br>2026-10-07 11:22:33 | 研算当前链未配置 Claude；旧 Codex Sol 成功样本不证明验算链。 |
| 算衡·验算 / `suan_heng:verify` | `L/claude-opus-5-5@max` → `C/gpt-6.1-sol@max` → `Q/deepseek-v4.1-flash@max` → `G/deepseek-v4.1-flash@max` → `D/deepseek-flash@max` | `deepseek-official/deepseek-flash`<br>2026-10-08 22:51:04 | 五次最终官方 API；升级 Codex/Claude、基础 Codex 与历史 Qwen Max 被 route-isolated；Go 未失败也未跳过，实际被升级链末项插队。 |
| 探微 / `tan_wei` | `Q/qwen3.8-flash@xhigh` → `G/mimo-v2.6-flash@high` → `G/muse-spark-1.3-contributor@xhigh` → `D/deepseek-flash@max` | `qwen-token-plan-cn/qwen3.8-flash`<br>2026-10-08 12:51:22 | 所见完成采用 Qwen 主路由，无回退原因样本；发生在当天 Qwen 明确 quota 错误之前。 |
| 博闻 / `bo_wen` | `Q/qwen3.8-max@xhigh` → `G/minimax-m3@high` → `D/deepseek-flash@high` | 未知 | 没有可归属成功来源，原因未知。 |
| 观象 / `guan_xiang` | `Q/qwen3.8-max@xhigh` → `Q/deepseek-v4.1-flash@high` → `G/minimax-m3@high` → `D/deepseek-flash@max` | `opencode-go/minimax-m3`<br>2026-10-08 22:25:49 | 最新委派的两条 Qwen 路由均 route-isolated，使用 Go；隔离原因不能仅凭最终路由反推。 |
| 铸剑 / `zhu_jian` | `L/claude-sonnet-5@max` → `Q/deepseek-v4.1-flash@max` → `G/kimi-k2.7-code@high` → `D/deepseek-flash@max` | `deepseek-official/deepseek-flash`<br>2026-10-08 23:01:19 | 最新委派跳过两升级路由、Claude Sonnet、Qwen；Go/Kimi 上下文超限后到官方 API，最后委派 aborted，不能把模型来源当作验收成功。 |
| 行舟 / `xing_zhou` | `Q/deepseek-v4.1-flash@low` → `Q/qwen3.8-flash@low` → `G/mimo-v2.6-flash@low` → `D/deepseek-flash@low` | 未知 | 无角色覆盖，表内是源码默认链；没有可归属成功来源。 |
| 疾风 / `ji_feng` | `Q/deepseek-v4.1-flash@max` → `G/deepseek-v4.1-flash@max` → `A/gemini-3.8-flash-tiered@high` → `D/deepseek-flash@high` | `qwen-token-plan-cn/deepseek-v4.1-flash`<br>2026-10-08 18:10:24 | 所见完成采用 Qwen 主路由，无回退原因样本。 |
| 御史 / `yu_shi` | `C/gpt-6-sol@xhigh` → `Q/qwen3.8-max@xhigh` → `G/mimo-v2.6-pro@high` → `D/deepseek-flash@max` | `opencode-go/mimo-v2.6-pro`<br>2026-10-08 22:56:30 | 最新委派跳过 Codex/Qwen 健康隔离；官方 DeepSeek 因 same-family 被排除，使用 Go Mimo Pro，独立性过滤应保留。 |
| 复核 / `fu_he` | `Q/deepseek-v4.1-flash@max` → `Q/glm-5.3@max` → `G/mimo-v2.6-flash@high` → `D/deepseek-flash@high` | `opencode-go/mimo-v2.6-flash`<br>2026-10-08 22:22:36 | 最新委派两条 Qwen route-isolated 后使用 Go Mimo Flash。 |
| 妙笔 / `miao_bi` | `Q/qwen3.8-max@xhigh` → `L/claude-sonnet-5@xhigh` → `C/gpt-6-sol@max` → `D/deepseek-flash@max` | 未知 | 没有可归属成功来源，原因未知。 |

当前显式非空升级链如下，均 `enabled=true`。其他已显式配置的升级链为空；空链不构成可执行的升级。行舟未配置升级且不属于升级角色。升级触发条件仍按当前任务和配置执行，不能仅凭有一条升级链就认定每次都触发。

| 角色 | 当前升级声明链 |
| --- | --- |
| 天枢 | `C/gpt-6-astra@max` → `L/claude-opus-5-5@max` |
| 谋定 | `L/claude-opus-5-5@xhigh` → `C/gpt-6-astra@max` |
| 枢机 | `L/claude-opus-5-5@max` → `C/gpt-6-astra@max` |
| 算衡·验算 | `C/gpt-6-astra@max` → `L/claude-opus-5-5@max` → `D/deepseek-flash@max` |
| 铸剑 | `L/claude-opus-5-5@max` → `C/gpt-6-astra@max` |
| 御史 | `L/claude-opus-5-5@max` → `C/gpt-6-astra@max` |

当前 `agents.rootRecoverMs=180000`，即 **3 分钟，不是 0**；不能把本次粘备用归因于“用户关闭了自动恢复”。`recovery` 未显式覆盖，默认额外瞬时重试 1 次、每逻辑请求最多 8 次 admission、单次短退避上限 2000ms、累计短等待上限 5000ms。admission 上限与真实模型 stream 尝试观测分开，不能把预检计数冒充真实付费请求。`rootRecoverMs=0` 的合法配置语义仍是禁用主会话自动恢复，2.3.0 不擅自修改用户设置。

路由元数据阶段另选到 280 个百工根/后代会话；此阶段只额外读取角色、request/header、model/selection 与已提交助手消息的 provider/model 来源字段，没有重新导出正常对话。上文 276 会话/735 标记仍是原错误快照的覆盖统计，不宣称是此后所有新增消息的总数。最新抽取的 10/8 ledger 结局均在本地下午，没有上午结局样本可作为前后对照。

## 长运行粘连原因与修复边界

1. **算衡验算的官方 API 插队已证实。** 五次历史完成都先跳过四条已隔离路由，却没有 Go 的 failed/skipped 记录。旧 merge 先拼完整升级链，因此升级链共同末项的官方 API 位于基础 Go 前，首个健康 API 成功后基础 Go 根本没被调用。2.3.0 仅把两个声明中唯一共同末项、且资源类型明确为 `metered_api` 的 fallback 延到基础订阅后；显式 API primary、非共同末项与 unknown 资源顺序保留。root 初始升级也先合并完整声明链再预检，以 `SetRootUpgrade(full, initialUsable)` 登记，不能只把过滤后单个官方 API 设为初始路线。见 [upgrade.ts](../../../src/upgrade.ts) 与 [service.ts](../../../src/service.ts)。

2. **铸剑的同一长会话有直接时间轨迹。** 同一 child 的 8 个 turn、390 个成功模型消息来源观测依次为 Codex→Qwen→Codex→Qwen→官方 API；19:23 后官方 API 有 242 次成功消息来源观测，持续至 23:01。Go/Kimi 在多次 resume 附近六次 `CONTEXT_WINDOW_EXCEEDED`，无 Go 成功来源。它实际曾被重新尝试，不能说已证明 Go 被永久封锁。修复是识别上下文超限，走真实宿主压缩并确认 surface replacement 后在同逻辑请求内最多恢复一次；没有实际缩短就暂停为 `context_recovery_required`，不能继续把相同超长历史换模型。成功消息计数不是模型请求计数，也不是任务验收次数。

3. **自动 header 变化不能充当人工选择。** 初次检查的 270 个后代中，55 个有多路由 request/header，而 `model/selection` 为零。DSH 会把自动 fallback 写入 request/header，作为后续工具 step 的请求 seed；API 的 current/next 也可能是 lastUsed。已安装历史 **2.2.2 的 root** 存在误将漂移认作换 picker、从而取消升级的风险；本轮实现中曾出现的 **persistent child SetChildOverride 漂移分支尚未发布**，已改正，不能把它当作 2.2.2 历史因果。当前以真实 `model/selection` 或可信人工控制识别人意，稳定保存 root preference，自动变化不 pin 子会话、不取消 root 升级。见 [runtime.ts](../../../src/runtime.ts) 与 [route-state.ts](../../../src/route-state.ts)。

4. **临时健康隔离不能永久残留。** 原 health 无 reset 时永久隔离，half-open 再失败也无后续恢复时间。当前分离供应商明确的 `resetAt` floor 与插件探针 `retryAt`；未知 reset 也有有界冷却、局部指数退避和共享单 half-open owner。pool 聚合错误不证明 quota；其巨大 retry hint 不当成订阅重置，插件恢复探针等待最多 5 分钟。真正明确的供应商 reset 必须遵守，手动 scoped retry 的 force 只越插件冷却，不能越供应商 floor。认证/模型错误不扩大到另一个 provider；仅明确共享 quota/balance 才用已知 opaque 资源域。成功 stream 才确认恢复，取消只释放临时所有权。见 [provider-policy.ts](../../../src/provider-policy.ts) 与 [route-health.ts](../../../src/route-health.ts)。真实旧 2.2.2 的 fatal pool 调用并未把巨额 hint 写成 resetAt，不能据推测静默清除来源不明的旧显式 reset。

5. **恢复优先级需要完整兼容链和安全边界。** 保存本次任务允许的 compatible declared chain 与初始可用路由；临时隔离的首选项保留，same-family、图像/工具/推理档位不兼容项继续排除。仅在新逻辑 step/安全边界重新做 metadata、vision、资源能力与健康检查；实际发送前原子领取半开所有权。同逻辑重试不倒回刚失败路线，失败探针局部退避；人工指定的 next route 保持优先。root 正常/升级恢复都遵守 rootRecoverMs，任务完成/incomplete/关闭升级时清除升级及其自动覆盖，回到稳定人工 preference。见 [delegate.ts](../../../src/delegate.ts)、[route-state.ts](../../../src/route-state.ts) 与 [service.ts](../../../src/service.ts)。

6. **请求能力错误不能污染其它角色。** `IMAGE_UNSUPPORTED`、`UNSUPPORTED_OPTION`、`UNSUPPORTED_REASONING_EFFORT` 为 `capability_mismatch`，只对当前逻辑请求寻找兼容候选，不全局封锁同模型的合法文本/合法 effort 请求。metadata probe 校验真实 Host resolveCallConfig，cache key 含 canonical effort；既有 Codex ultra→max wire 映射共享一个实现。所选历史错误没有这些明确码样本，此项是源码潜在缺陷修复，不能冒充当日已经发生的原因。`UNKNOWN_MODEL` 仍与上下文/能力错误区别处理。见 [routes.ts](../../../src/routes.ts) 与 [provider-policy.ts](../../../src/provider-policy.ts)。

## 机器验证与真实调用边界

- [升级 Host 回归](../../../tests/integration/upgrade-host.test.ts) **4/4 通过**，使用真实 DSH 0.2 AgentLoop、subagent 和工具，供应商 stream 为隔离确定性 fixture：升级订阅可用仍优先；升级均隔离时 Go 真被调用；Go 真实 stream 失败后才到官方 API；root 初始升级同样不越基础 Go。前三例先两红一绿、merge 修复后三绿；追加 root 例先红、root full-chain 接线后四绿。没有为这些场景调用真实 Claude/Go/官方 API。
- [模型控制 QA](../agent-control-2026-10-08/functional-model-control-qa.json) 与 [Host 事件](../agent-control-2026-10-08/host-recovery-events.json) 记录 **6 个真实 Host 场景通过、125 个对应 unit 通过**。同 child 实际 header 为 preferred→backup→preferred，backup 真执行 read，后续 step 首选真实 committed；child model/selection 为零且没有生成 manual override。另一个 root 通过真实 model/selection 人工选 recovered/max，后续确实调用该模型。root 正常/升级、180000/0 四种定时语义都有单测覆盖。供应商回复均为明确隔离的 mock，不能称真实订阅恢复证明。
- provider-policy/route-health/upgrade/routes 四套 unit 在 23:42 运行 **74/74 通过**。这些是当时 owned 路由模块证据，不冒充最终全仓测试；发布的全套结果由 release 记录另列。
- 另经授权只做了一次当前 Codex 实际最小请求：唯一注册 provider 为 codex，无工具/refresh/其他 provider fallback，上游 HTTP 200，SSE model=gpt-6-astra，固定答复符合预期。它证明当前该模型/low 档的一次真实调用成功，不证明下午 pool 每个成员的原始 cause、其它模型/max 档或旧 live 进程已恢复。本公开报告不披露账号/用量/认证元数据。
- native backend 与 prepareCall 内部重试，如果缺少结构化失败、真实 attempt 观测和预退避控制合同，仍明确 `unverified/unknown`。不能把外层 AgentLoop fixture 的覆盖扩大到 native 内部；本子任务没有发送 Claude 请求或自行重启唯一生产服务。

## 最终工程审查与闭合

发现并闭合一项本轮 service 接线的 P1：相同任务卡刷新/专家完成后的 `UpdateRootUpgrade` 重新 `SetRootUpgrade(full, usable[0])`，曾清除自动 fallback override 并将升级链 index 置回首选，绕过 `rootRecoverMs` 和局部退避。这属于本轮审查发现，不冒充历史 2.2.2 已证成因。

公开服务入口的隔离复现先证明：preferred 两次 `SERVER_ERROR` 后 backup 成功，health 为空；完全相同的 T-1 合同刷新（cardRevision 1→1）后，新 step 提前回 preferred。owner 已将 `SetRootUpgrade` 改为幂等刷新：现存路线仍在新声明链中时更新链元数据并保留 index、override、timer 和退避；首次激活或当前路线已从新链移除才重选。恢复首选统一交给安全边界的 `PreparePreferredRecovery`，不能被状态刷新代替；人工取消标记仍优先。

修复后独立重跑 **4 个公开 service 组合全部符合预期**：`rootRecoverMs=0/180000` × 同合同刷新/真实 `service.delegate` 收尾。均为 preferred→backup→刷新后仍 backup，revision 保持 1，委派分支实际 completed，未调用任何真实供应商。永久回归见 [service.test.ts](../../../tests/unit/service.test.ts) 的“相同任务卡及委派收尾刷新升级不越过恢复间隔”。当前本审查范围没有剩余必须修复的 P1；全仓最终测试与部署状态仍以发布证据为准。

## 本机最终实际执行

唯一生产服务升级为 2.3.0，原有 458 个会话保留，17 组配置哈希未变；新控制 RPC 生效，Mermaid 资源认证后 200、匿名 401。见 [HTTP 检查](local-web.json)。

独立只读工作区的同一真实会话先观测到 `codex/gpt-6.1-sol` 根调用。第一次观察窗口 240 秒到期中断了规划审核，不算审核通过；新输入使旧审核失效，按现有 advisory 模式继续允许的只读探针，没有变更 enforced 设置或全局默认模型。随后真实文件发现找到 fixture、纯函数 sum 得 6（computed）、持久探微实际通过 `opencode-go/mimo-v2.6-flash` high 读取源码并完成。独立 `jev-1.13.0` 对该来源可信度 0.947、关联度 0.950，判断集中程度分别 0.84/0.87；这些是判断记录，不是正确率。子控制面按真实 attempt 显示相同实际模型，结束为 idle/settled；任务最后记录 incomplete，父 turn 真正结束，文件和所有设置保持不变。见 [脱敏任务证据](production-task.json)。

全仓结果和最终源文件哈希见 [机器检查](checks.json)，673 单元 / 30 真实宿主集成测试、类型检查和构建通过。Jev 的七种 MCP 均真实调用，初次证据不足及补充复审结果完整保留在 [判断记录](jev-routing-review.json)。版本发布的附件哈希与隔离安装结果保存在对应 GitHub release manifest，不能把本次探针当作所有供应商、所有 native 内部或所有历史故障的认证。
