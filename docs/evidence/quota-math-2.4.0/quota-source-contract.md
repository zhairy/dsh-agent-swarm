# 额度数据来源与准确性契约

审查日期：2026-10-09。实现：`src/quota.ts`；定向回归：`tests/unit/quota.test.ts`。此记录描述公开接口和合成回归，不包含账户凭据、邮箱、套餐实测余额或付费模型生成。

额度来源面向天枢和各专家实际调用时的自动模型路由，不增加额度设置面板或供 LLM 手动挑选模型的额度工具。保留只读诊断 RPC `swarm.quotaView` 供宿主核对。真实模型回退、用户选定模型和任务准入的权威检查不由未知采样的数据替代。

## 已确认的公开接口

本机已安装 `dsh-plugin-subscriptions` 0.9.8。其 `lib/auth/rpc.d.ts` 与实际 `lib/index.js` 的 `src/auth/rpc.ts` 区域一致：

| 接口 | 当前返回内容 | 本次使用方式 |
| --- | --- | --- |
| `subscriptions-auth.status` | `{providers:{[provider]:{busy,accounts:[{key,isDefault,account?,plan?,expiresAt?}],detail?}}}` | 一轮只请求一次；只保留内部 key、default 标记；不向路由依据返回邮箱/原 key |
| `subscriptions-auth.usage` | 参数 `{provider,account,force?}`；返回 `{supported,windows?,plan?}` | 每账户一次；窗口保留上游百分比及公开 reset 时间 |
| `subscriptions-auth.providerSettings` | 账户目录、每账户模型目录、`poolEnabled`/`poolModels` 等偏好 | 可证明候选目录映射；未返回最终 family/tier 成员定义，须与公开宿主配置结合，不能仅凭目录猜测实际池 |

`UsageWindow` 的正式形状为 `{kind:'session'|'weekly'|'other',scope?,usedPercent,resetsAt?}`。没有公开绝对 Token 上限、绝对余额、供应商采样时间或缓存失效标记。实现不根据模型名称、价格、本地调用数、token 用量反推套餐额度，不把 `session` 分类额外推断成精确五小时长度。

当前已安装 DSH 的公开 `llm`、`session`、`llm-deepseek`、`llm-pi-ai` 类型没有通用订阅额度/账户余额服务。调用产生的 token usage 和 DeepSeek Files 存储配额均不是套餐余额。因此 Qwen Token Plan、OpenCode Go、DeepSeek 官方 API、Jev 等没有上述公开查询契约的路由返回 `unknown`。已知计费方式不意味着已知剩余额度或无限余额。本次不读取私有 API key 去拼接厂商余额请求。

## 已接受的反方证据

订阅插件的 `PoolUsageTracker.snapshotFor` 在刷新失败或失败冷却期内，即使 `force:true`，也可能返回 `lastSnapshot`。`usage` RPC 没有把该缓存状态传出来。因此强制刷新成功返回也不能证明刚刚访问了供应商、不能证明数据实时：

- `readAt` 只表示百工完成本次读取的时间；`sampledAt:null`、`freshness:'upstream-not-disclosed'` 始终保留。
- 自动路由依据及诊断结果保留“上游采样时间未公开，可能为订阅插件缓存”。缓存读取保留最初 `readAt` 并返回 `cacheAgeMs`。
- reset 已过去时明确提示无法据此认定当前窗口耗尽或已恢复。
- 未知采样的数据不能用于硬跳过模型、解除健康隔离或阻止首选恢复探测；限定的自动选择策略须保留这些边界。

订阅插件自己的池策略把 `usedPercent >= 95` 标为调度满额，但实际 `select` 仍把这些成员放在末尾作为最后尝试。这是上游池的策略，并不等于供应商已经耗尽。本次不会把 95% 上报值转为百工的隔离条件，也不会修改上游插件。

## 映射、共享窗口与隐私

账户和窗口按提供方与原账户身份生成稳定 opaque ID。两个账户的同类窗口不合并；全局 weekly 与模型 scope 的 weekly 分别返回，不相加。重复相同窗口只保留一份；同一身份窗口数值冲突则明确拒绝。

只有 canonical `~account:<encoded-account>:<encoded-model>` 标识能直接证明独立账户绑定。大小写不规范的百分号编码、非法编码、缺失账户不回退到 default。额度结构用 opaque `routeId` 区分路由，只返回解码后的 wire model，不回显模型 ID 中内嵌的邮箱/原账户 key。模型 scope 常是展示名（例如 Opus），不能任意与 wire ID 模糊匹配；独立账户路由只引用未带 scope 的共享窗口，其余保留在账户结构中。

普通模型只关联同一提供方的账户结构：`mapping:'provider-accounts'`、`windowIds:[]`、实际模型额度 `unknown`。这不是候选池成员集合；即使某账户被 `poolEnabled:false` 或 `poolModels:[]` 排除，仍可返回该账户自身的真实上报数据，但不会声称它能供该模型使用。未公开的 pool/tier 映射不作猜测。

以上是基础诊断结构的保守映射。实际自动调用层另外组合公开宿主配置与目录证据，不把它当作“宿主无法证明任何池成员”的结论。

## 自动调用路由层

`quota-routing.ts` 从公开 `ConfigEditor.entries()` 中选择唯一 active、名称严格为 `dsh-plugin-subscriptions` 的入口。只投影非秘密的 `providers` 和 `pool` 已知字段，成员只取 `provider/account/model`；不枚举、复制整个插件配置，不访问其他字段或凭据。`SettingsForms.describe()` 仅公布 volatile 表单，而订阅插件的 pool 配置并非 volatile，因此不能据“表单没有 pool”推断公开宿主无读取能力。

结合 `subscriptions-auth.providerSettings` 的每账户模型目录及偏好，可重建 auto-account 池、覆盖它的同 provider families、覆盖 family 的跨 provider tiers，以及关闭池/auto 后的 default-first 合格账户回退。未知账号别名、默认账户不唯一、目录不可用、登录状态与目录快照不一致、owner 未证明时降为 unknown，不猜测成员。配置与目录等待期间变动的处理由自动来源装配层继续检查。

当前来源的供应商采样时间仍未知，`getQuotaRouteDecision` 始终保留 `eligibility:'unknown'`、`hardSkip:false`，不伪装成实时准入权威。只有成员全部明确、每个成员至少有一个适用窗口上报 100%、窗口有未到期 reset、窗口结构完整且本地快照在有效期内，才给 `reported-full` 软提示。任一未知成员、部分窗口、未知重置截止、已过 reset 或资源策略冲突都保持中性。模型 scope 只使用已安装订阅插件明确的 `windowApplies` 字符串包含规则，且仅用于这个非权威提示。

软提示仅在连续订阅段内稳定后移；容量已报告和 unknown 保持原序，不比较不同套餐的容量大小。所有后移订阅仍在 API 之前尝试，绝不因旧缓存把健康订阅永久丢到 API 之后。用户选定模型和实际首选恢复探测受到保护；成功保护指纹只包含本路由成员、适用窗口值/reset 与有效配置，不包含读取时间或其他 provider，避免相同 `lastSnapshot` 强制刷新后再次压过真实成功。此信息不写入任务目标、规划审核版本或永久健康隔离，不重置数学累计预算。

同一 provider/model 在常规链和升级链中具有不同 reasoning level 时仍只产生一个额度身份及 `routeId`，防止 Agent 重复解释同一额度。若同一身份配置了不同有效资源策略，计费标签降为 `unknown` 并提示冲突；账户原始上报值仍独立保留，不任取其中一条策略作为事实。

接口异常只返回固定指导语，不回显原始 HTTP 异常正文、账户标识或凭据。供应商失败、未知、unsupported、未登录分别保留，不把它们当作零消耗或无限额度。

## 授权与资源边界

DSH 的公开 `connection.createSharedFetchHandler('/api')` 返回包含 `.fetch(request)` 的可信内部载体；其契约要求调用发生在认证之后。集成只能从已认证 `swarm.quotaView` 或可信自动路由宿主操作调用本模块固定的 status、usage、providerSettings 三种只读方法。它不替代 HTTP 认证，不暴露任意 endpoint 代理，不携带浏览器 cookie 或 bearer token。新 RPC 必须在真实宿主回归中验证匿名请求仍为 401。

本模块的本地结构化结果缓存为 30 秒，force 请求在没有正在执行的读取时绕过缓存；有并发读取时加入该轮，并明确返回 `refreshJoinedExisting:true`。单个调用者取消只取消等待，不取消其他调用者共享工作。不宣称取消了订阅插件内部未响应信号的网络工作。

| 资源 | 边界与反馈 |
| --- | --- |
| 同时进行的上游额度读取 | 跨全部 provider 共享并发 4 |
| 一轮读取 | 总截止 30 秒；剩余账户返回明确读取失败，不继续发新请求 |
| 总账户 | 128；超过的提供方返回 unknown，并提示未读取及视图不完整 |
| 每账户窗口/全视图窗口 | 128 / 1024；超限账户明确 unknown，不静默截断为完整数据 |
| 单 RPC 响应 | 最多 512 KiB，流式累计并在超限时取消读取 |
| 缓存对象 | 返回脱离副本，调用方修改不能污染后续读取 |

设账户数为 A、实际检查的窗口数为 W_seen、保留窗口数为 W、配置路由数为 R：读取处理为 O(A+W_seen)，缓存空间 O(A+W)，并发网络数 O(1)。路由映射对独立账户进行列表匹配，最多 O(R×(A+W))；P 固定为五个订阅提供方。A≤128、W_seen≤128A、W≤1024，避免把原始 5×128×128 个窗口全部常驻缓存。原始响应暂存受并发 4 和每响应 512 KiB 共同约束。

## 定向验证

`npx vitest run tests/unit/quota.test.ts`：26 项通过。覆盖百分比原值、账户/模型 scope 不求和、冲突/非法/空窗口、过去 reset、不支持接口、一次全提供方 status、跨提供方并发上限、缓存与 force 合并、取消隔离、异常脱敏、独立账户精确匹配及 ID 隐私、总账户/窗口边界、真实形状 `.fetch` 载体、唯一 rpcId、响应大小限制、全默认常规/升级链去重及资源策略冲突。

`tests/unit/quota-routing.test.ts`：21 项通过。覆盖安全宿主配置投影、auto/family/tier/default/alias/账户偏好/owner、partial/未知截止/过期、稳定成功指纹、保护路由和 API 边界，以及独立批次 evaluator 的结果一致性和快照隔离。

`tests/integration/quota-math-host.test.ts`：6 项通过。通过独立编译候选的实际 `index/tools/runtime` 入口接入真实已安装 SDK `Context`、`HostConnectionService`、`SystemPrompt`、`ToolRuntime`。验证正式注册/准入、百分比精度、共享窗口、缺失/取消/单飞、真实 `agent/request` 自动额度来源与备用订阅选择，以及实际工具管道中的禁用无预算消耗、显式矩阵执行和 mean/variance 数值反例。订阅源响应和身份为固定测试夹具，不是付费模型或真实用户额度。SDK：DSH、Connection、Tools、SystemPrompt 0.2.0-rc.2；Cordis 4.0.4。

CPU 审查发现，逐路由逐成员重复构建账户目录 Set 会扩大元数据处理成本。新增 `createQuotaRouteEvaluator(input)` 为单次同步排序批次各规范化目录一次，并复制小范围 quota/config 快照；默认独立 helper 保持无缓存行为。每次 order 重新创建，不把资格、健康或授权缓存到下一请求。[基准记录](./quota-routing-performance.md)包含输入边界、时间/空间取舍和实际重复测量；这些测量不是模型生成端到端性能。

`npm run typecheck -- --pretty false`：通过。上述结果不替代生产宿主的真实额度源对照、浏览器和本机升级验证；最终执行结果由主审记录。
