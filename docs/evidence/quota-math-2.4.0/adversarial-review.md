# 2.4.0 额度与纯函数算子：反方独立审查

审查日期：2026-10-09。基线为插件 2.3.2、真实宿主 DSH 0.2.0-rc.2、已安装 `dsh-plugin-subscriptions` 0.9.8。审查只读已安装 SDK、订阅插件与项目源码；未读取凭据正文，未请求订阅生成，未运行 DSH CLI，未修改第三方插件或生产编译产物。下述复现仅调用纯数学函数与带注入假 fetcher 的上游类。

## 结论与准确性的边界

接受读取正式认证接口返回的供应商上报窗口，保留 provider、account、窗口 kind、scope、usedPercent 和公开 reset 时间。百分比是上游返回值，不是本插件根据 token 推算；但当前接口不足以证明它是实时采样值，也不足以推出剩余 token 数、金额、账户额度上限或所有模型的可用性。

DSH 的公共 `LlmProviderInfo` 只公开供应商目录，`LlmConfigurableProvider` 公开设置命名空间和路径，`LlmRuntime` 没有通用 quota/balance/remaining API。内置 pi-ai 与 DeepSeek 的流式 usage 是单请求 token 观测；DeepSeek 的文件容量 API 也不是余额接口。订阅插件 ProviderId 只有 codex、claude、grok、copilot、antigravity。因此 Qwen Token Plan、OpenCode Go、DeepSeek 官方 API 当前应明确显示“宿主未公开额度接口”，不能用零、无限、价格表或会话 token 估算代替。

当前可接受的功能表述是“可追溯供应商上报额度”，不可宣称“所有供应商实时精确统计”。上游后来公开采样时间、缓存状态、账户/模型资源标识或余额接口时，需另行按正式契约接入。

## 已复现反例

### Q1：强制刷新也可能返回旧快照

订阅插件 `lib/providers/pool-usage.js` 的 `snapshotFor` 在 fetch 失败后返回 `lastSnapshot`；负缓存冷却内即使 `force=true` 也继续返回它。正式 `subscriptions-auth.usage` 只返回 `ProviderUsage`，不附带原采样时间或 stale 标记。

无真实账号的复现：

```js
let calls = 0
const tracker = new PoolUsageTracker(() => async () => {
  calls++
  if (calls > 1) throw new Error('simulated upstream failure')
  return { supported: true, windows: [{ kind: 'session', usedPercent: 96 }] }
})
const first = await tracker.snapshotFor('codex', 'fixture-account')
const forced = await tracker.snapshotFor('codex', 'fixture-account', true)
const forcedAgain = await tracker.snapshotFor('codex', 'fixture-account', true)
// calls === 2; first === forced === forcedAgain
```

实测结果与注释一致。必须把 `receivedAt` 定义为“本插件读取时间”，并固定提示“上游采样时间未公开，可能为订阅插件缓存”。不能根据这个时间把旧值重新标为新鲜，也不能用它清除模型隔离、强制封禁或排序模型。

### Q2：上游有余量仍可能降低池成员优先级（复查纠正）

同一上游文件定义 `QUOTA_FULL_PERCENT = 95`。注入窗口 `usedPercent: 95` 后，`quotaFor({ provider:'codex', account:'fixture-account', model:'gpt-fixture' })` 返回 `available:false`，尽管展示剩余比例仍为 5%。但继续追踪实际 `PoolAdapter.select` 后确认，它最终返回 `[...scored, ...quotaFull]`，保留满额成员作为最后尝试的尾部。此前将 `quotaFor.available=false` 直接解释为“排除成员”的表述不准确，此处明确纠正：95% 影响配额感知排序，不是硬禁用，也不是供应商报告 100% 耗尽。

路由设计必须保留此边界，不能把尾部优先级误转为本插件整个账号的健康冻结，不能据此断言某次回退一定由 95% 引起。

### M1：均值的可表示结果被中间和溢出拒绝

基线纯函数：

```js
calculate({ op:'mean', mode:'float64', args:{ values:[1e308, 1e308] } })
// { ok:false, code:'NON_FINITE' }; 数学均值为可表示的 1e308
```

Neumaier 求和提高消去精度，但不能自动避免求和中间量溢出。均值须单独使用按最大绝对值缩放的补偿算法，不能直接依赖 `sum/n`。

### M2：总体方差的可表示结果被 M2 溢出拒绝

基线纯函数：

```js
calculate({ op:'variance', mode:'float64', args:{ values:[1e154,-1e154], ddof:0 } })
// { ok:false, code:'NON_FINITE' }; 总体方差约 1e308，结果有限
```

Welford 的未缩放平方差总和约为 `2e308`，先溢出再除以 n。接受正方提出的平移、缩放、补偿两遍算法；仍须区分真正不可表示的方差（例如同输入 ddof=1）并返回明确失败。

## 正反互驳后的设计取舍

额度正方接受 Q1 的反证：采用 `freshness='upstream-not-disclosed'` 与独立读取时间，仅展示真实上报值；不接入健康清除、隔离与排序。接受每 provider/account 只读一次窗口，不逐角色相加。独立账号模型只有 canonical `~account:<encoded-account>:<encoded-model>` 能证明精确映射并引用窗口；普通模型进一步收敛为 `provider-accounts` 管理视图，`windowIds=[]`，明确说明公开接口未披露实际池成员及所选账户。没有 catalog/池成员契约时，连“候选账号”也不推断。这减少了额外模型目录发现请求，并避免把个人额度展示误当作路由承诺。

数学正方接受 M1/M2 和预计费意见：新增组、单算子和数字模式三层 AND 开关；常规组默认开、矩阵和多项式默认关。旧 `enableExtended=true` 仅在对应组未显式配置时迁移，显式关闭优先。矩阵残差须同时允许 verification、residual_norm、matrix 和 matmul；显式残差向量不需要矩阵授权。配置资源边界为正安全整数并受硬上限约束，任务剩余工作量与单次工作量取较小值。矩阵与 A,x,b 残差在循环执行前计入完整乘加与归约成本。均值最终进一步收敛为优先 Neumaier，只有中间量 NON_FINITE 时使用缩放回退，避免 `[1e308,1e-15,-1e308]` 的小项在统一缩放时消失；操作限额错误不触发回退或退费。

反方明确拒绝以下方案：

- 根据 elapsed 时间推算额度恢复，或者由已用百分比换算绝对 token/余额。
- 把 session 一律改名为 5 小时，或根据当前 reset 时间伪造窗口起点/时长。
- 合并不同账号的百分比，或将全局 weekly 与 Opus weekly 相加。
- 普通模型默认绑定第一个账号、把 provider 别名猜成另一个有 usage 的供应商。
- 保留未知设置字段等同授予未知算子/模式权限；未知授权键不得生效。
- 将矩阵/工作量边界设为 0、NaN、负数或超大值以关闭资源保护。
- 计算残差等于算法正确、有限计算等于一般数学证明。

## 必须验证的回归

额度：

1. 相同 provider 的两个账号拥有同 kind 窗口时分别保留；全局与 scoped weekly 均保留且不求和。
2. 缺失、失败、unsupported、空 windows、无效百分比分别报告，未知值不变成 0；缺少 reset 不做本地倒计时推算。
3. `poolModels=[]`、`poolEnabled=false` 的账号可以在供应商账户管理视图展示个人额度，但不能据此声明普通路由候选或可消耗额度；独立模型是否启用也不能由账号额度反推。
4. 畸形或非 canonical `~account:` ID 不降级到默认账号；未公开的 pool/family 映射保持 unknown。
5. 页面、专家行与手动刷新共享 in-flight 请求；force 加入已有请求时不能承诺新的上游采样。账号数/窗口数受限时公开 truncated，不静默遗漏后仍宣称全量。
6. 匿名额度读取保持 401；错误、日志、截图与发布证据不包含 access/refresh token 或凭据正文。
7. 新显示读取不更改路由健康、用户所选模型、回退链或 Jev 调用配额；源接口不支持的 API 额度保持 unknown。

数学：

1. 组、算子、模式每层显式关闭均拒绝；旧 enableExtended 迁移、显式关闭优先、全部关闭保持无计算能力。
2. 无关设置保存往返不丢失；未知授权键、错误类型、0/负/unsafe/超硬上限拒绝或明确不授权。
3. `mean([1e308,1e308])`、混合符号大数、`variance([1e154,-1e154],0)` 有限；同方差 ddof=1 明确 NON_FINITE。
4. `[1e12,1e12+1,1e12+2]` 的总体方差约 2/3；`[1e-160,-1e-160]` 的可表示次正规方差不被不必要地清零；缩放 norm2 保留大数有限值。
5. 矩阵维度与乘加边界在执行前拒绝，失败不会越过任务剩余预算；A,x,b 与显式 residual 两条授权路径分离。
6. 同任务并发算子调用原子计数；冷恢复保留已消耗次数和工作量；在线改低限额不退还历史消费。
7. 保持纯函数无 I/O、无 eval、无随机、无调用者对象修改；返回 computed 证据且不升级为 proof。

## 实施复核状态

反方已只读复核额度读取、数学授权、数学算法和设置保存代码，并独立执行：

```text
npx vitest run tests/unit/math-config.test.ts tests/unit/math-operators.test.ts \
  tests/unit/client-settings.test.ts tests/unit/config.test.ts tests/unit/quota.test.ts --reporter=dot
5 files / 70 tests passed
```

此后额度模块增加隐私、全局容量与正式 SDK 载体回归，反方再次独立执行 `tests/unit/quota.test.ts`：24 项通过。最终均值策略调整后，再次独立执行 `math-config` 与 `math-operators`：2 文件、16 项通过。以上是不同代码检查点的记录，不能将重叠执行数累加为唯一测试数量。

显式 `math:null/[]/string` 默认授予能力的问题已改为配置错误并拒绝计算。反方追加发现的设置恢复问题也已修复：重置数学权限与 limits 使用完整默认快照，清除派生错误，不能重新合并未知授权键；保存仍保留顶层无关未来设置。缩放均值/方差、次正规结果和矩阵执行前工作量收费的回归已通过。

数学核实现版本提升为 `operatorVersion=2`，复现摘要包含新实现版本；请求 wire schema 仍为 1，旧证据不被重写。均值/方差仍为 O(n)，新增临时归一化数组以换取有限结果稳定性，整体空间 O(n)，受元素上限约束。矩阵仍为 O(mnk)，乘加边界、输出大小与累计工作量分别检查。

追加发现并修复独立账号模型 ID 自带身份的问题：即使不返回 status 的邮箱，原 `~account:<email>:<model>` 仍可解码出账户。额度 route 现在只返回 opaque routeId 和 wire model；非法独立 ID 不回显正文。全视图限制 128 个账号、1024 个保留窗口，共享并发上限为 4；超限明确 unknown 和不完整，不冒充全量。缓存 30 秒保留原读取时间，force 加入既有请求会明确提示未新增上游强刷。

已核对 DSH 的公开 `HostConnectionService.createSharedFetchHandler('/api')`：其 Fetch 契约是处理已经认证的请求；浏览器入口在桥接前单独执行 `connection.admit`。额度载体只允许固定 status/usage 方法，必须由已认证的 Swarm RPC 或可信宿主操作调用，不是认证替代品或任意代理。新增 RPC 的真实宿主匿名 401、设置保存、冷恢复和全量回归仍需以最终验证记录为准。

现有总容量边界仍为单 owner 最多 512 份上下文与 4 MiB 全状态。数学调用数 0 表示不设调用次数限制，不代表可以无限保留证据；调高单次输入边界也不能取消总状态边界。没有通过删除历史、退还已经执行的工作量或关闭 schema 校验来掩盖容量问题。

## 接线后追加反审

反方只读检查 root 接线后，独立执行 `task-runtime` 与 `client-quota-view`，2 文件 42 项通过。锁内取最新数学配置、单次与任务剩余上限取较小值、预占 hard upper 后 settle 实际工作量、已消耗工作量冷恢复不退还均有代码与定向回归支持。额度 RPC 只接受可选布尔 force，路由由可信宿主枚举，调用者不能指定任意 endpoint/account。

追加发现两项确定问题，root 已修复，反方完成只读复核：

1. **取消准入缺失，已解决**：原纯 mock 的 task-runtime 临时副本中，预先 abort 的 exec.signal 调用 add(2,3) 仍返回 value=5、artifactRef，并生成 settled 数学预算与 L2 证据。该复现的“1 passed”表示成功复现缺陷，不是修复测试通过。现在 Calculate 入口与任务锁首行分别检查取消，在版本刷新、预算预占及计算前拒绝。预先取消和另一真实操作持有任务锁期间排队取消的回归都确认无新增预算和 L2 证据。
2. **默认模型额度关联重复 key，已解决**：原入口按完整 RouteInfo JSON 去重，而 routeId 只绑定 provider/model，默认角色链得到 26 条完整 JSON 路由但只有 13 个 provider/model。现在 mapper 统一按 provider/model 去重，推理档位不再重复算为额度；有效资源策略冲突只把计费标签降为 unknown 并提示，不随机选取策略，也不修改账户原始上报值。完整默认角色链、升级链 routeIds 唯一以及对象键序不会产生伪策略冲突的回归均通过。

两个追加边界也已处理：界面现在说明上游模型池可能在供应商额度用尽前暂停成员，上报比例不等于池可用性；service 对数学核拒绝的输入只保存已通过准入的有界 op/mode、失败结果和“原输入未保存、未计算输入摘要”的声明，不再复制完整 raw 请求。100,000 元素的超限输入仍返回原 INPUT_LIMIT，失败证据小于 1,000 字符，后续正常计算成功。

最终接线反审独立执行：

```text
npx vitest run tests/unit/quota.test.ts tests/unit/pipeline-atomicity.test.ts \
  tests/unit/task-runtime.test.ts tests/unit/client-quota-view.test.ts --reporter=dot
4 files / 75 tests passed
```

反方对本轮三项修改没有未解决的代码阻断发现；上游采样不可证明、部分提供方无额度 API、总状态容量仍受限属于已公开的契约边界。最终生产实测和发布工件仍以 root 的真实宿主验证记录为准，本反审不替代部署验证。

本文件记录独立反证、正反取舍及已运行的定向回归；最终生产实测与发布结论以同目录的最终验证记录为准。发布不能仅凭讨论通过或 Jev 概率判断宣称确定性回归通过。

## 最新目标：真实 Agent 自动路由（覆盖此前仅展示方案）

用户最终要求额度成为真实 Agent 模型链路的自动选择依据；仅设置页展示或提供 LLM 可选调用的额度工具不足以满足目标。此前展示方案的实现及测试是历史检查点，不能据此声称新的自动路由目标已完成。最终不注册 `swarm_quota_read`，数学设置功能保留。

重新独立调查公开契约后，纠正“没有任何公开模型/账号映射”的过度表述：`subscriptions-auth.providerSettings` 实际返回 `{provider, settings, models, accounts, tools}`，其中每个账号包含 models 和 unavailable，settings 包含 poolEnabled/poolModels/independentEntry。它能证明账号目录与偏好，但不单独公开最终 families/tiers 成员、实际选中账号或 usage 新鲜度。

DSH 还提供公开宿主 `ConfigEditor.entries(): Entry[]`。可信适配层可只定位唯一、运行中的 `dsh-plugin-subscriptions` entry，读取其公开 `entry.fiber.config.pool` 的白名单字段，不读取/序列化完整插件配置，不触碰 antigravity secret、凭据或私有控制器。`SettingsForms.describe` 只投影 volatile 字段，而当前订阅插件 schema 的 pool 不是 volatile，所以远程 settings 缺失 pool 不代表宿主无法读取它。无法唯一确认 owner、配置表达式未解析或别名无法解析时必须 unknown。

自动路由设计建议：

- 分离三值资格 allow/deny/unknown 与偏好。完整映射与额度新鲜度是两个独立证据，不能用完整目录推导 usage 是实时值。
- 普通自动账号池由账号目录与 poolEnabled/poolModels 重建；families 覆盖同名自动池，tiers 可跨 provider；省略 account 只能用同一一致快照的唯一 default。配置旧账号别名不能猜成当前账号。pool 关闭或 autoAccounts 关闭仍有 default-first 的可用账号 fallback，不能错误当作没有路由。
- providerSettings unavailable、目录降级为 last-known、状态/目录快照账号不一致、缺少成员、超限截断、未知 usage 均不能作为硬排除全部成员的依据。
- 当前 0.9.8 usage 即使 force 仍可能返回 lastSnapshot，故不能单凭上报 100% 前置 hard skip。确证硬跳来源是现有实际结构化 quota/pool/auth 失败，或未来正式公开的 live 采样资格；后者还要求所有确切成员均有适用、未过期、完整的耗尽窗口。
- 正方提出缓存满额时 soft defer，反方已反驳其在套餐升级后可能把健康首选长期排后。若选择软偏好，必须保留尝试机会、不越过订阅优先于 API 的边界、不压过人工选择、不阻止首选恢复探测，实际成功还应压过旧满额提示；不得把它称为准确额度硬排除。更严格的默认是采样未知时 neutral。
- 上游真实 `PoolAdapter.streamMembers/select` 已执行 quota_aware 账号调度。集成应在 root、child、probe 和首选恢复的真实路径共同使用同一资格层，验证缺失数据不中断执行、不扩大健康域、不重放已发生副作用；不依赖主持模型自愿查询工具。

root 最终接受的折中是：完整可证成员全部报告 100%、具有未过期 reset 时，只作 soft defer，`hardSkip=false`；仅在连续的 subscription 路由段内稳定重排，unknown 与有余量路由保持原序，不比较不同套餐百分比的大小。被 defer 的订阅仍必须保留在该段后面的 API 之前实际尝试。人工选模和首选恢复探测受保护；实际成功压过相同旧窗口指纹。反方接受这是明确允许缓存假阳性的排序策略，不是“实时准确判定耗尽”。

新的自动路由接口以 `orderQuotaRoutes(routes, signal?, protectedRoutes?)` 与成功观测为中心，不增加 LLM 额度查询工具。指纹必须只由该模型成员及适用窗口的实际数值/重置字段组成，不能含 readAt、cacheAge 或无关供应商数据，否则同一 lastSnapshot 每次刷新就会重新压低已成功的首选。故障隔离始终独立，成功屏蔽软提示不能放行仍隔离的路由。

实现必须保持逻辑请求最多 8 次原计数，不因重排重置或重复计数；已实际尝试集合独立于旧 index，避免先选 B 后回退跳过被 defer 的 A；取消或源超时回 unknown，不派发被取消调用，不重放已经产生副作用的任务；冷恢复不恢复额度权威，数学预算与额度来源缓存完全独立。

本节是重新互驳后的设计审查；新的自动路由实现、界面清理以及本机运行验证尚需后续记录，前述仅展示测试不替代它。

## 自动路由实现后的反审

反方对 `route-state/runtime/delegate` 与公开额度映射实现进行了只读复核，独立构造并复现两个新增竞态/一致性问题，已由自动路由专家修复：

1. 根升级链 A→B 后，B 失败等待 C 的元数据探测；同内容升级链刷新克隆 roots 对象，旧异步 guard 把 C 的有效恢复判作陈旧并终止。现在同链且相同有效 policy 的刷新真正保留对象与时钟；实质变更、人工选择或 dispose 仍能阻止旧探测覆盖新状态。确定性回归确认会 retry C。
2. 子智能体额度预检按 B→A→API 排序，B 创建失败后实际以 A 创建；首个 model request 又重选回 B，造成重复失败并与已绑定 persona 不符。现在可信 `initialQuotaOrder` 只安装完整回退顺序，保留实际创建时的 initialRoute。没有可信预检标记的 child 仍能进行自动初选。

实现专家另修复旧 step 的取消清理删除新 step 排序的问题：finally 只清除同 token、同逻辑请求的准备记录。实际成功源回调隔离辅助异常，不撤销真实成功；首次 root、child 初选、手选保护、首选恢复探测、既有回退时钟、完整未尝试集合和第 8 次计数边界均有回归。

独立执行：

```text
npx vitest run tests/unit/route-state.test.ts tests/unit/delegate.test.ts \
  tests/unit/quota.test.ts tests/unit/quota-routing.test.ts --reporter=dot
4 files / 171 tests passed
```

公开额度成员 helper 已要求 active owner、完整 account/window 数据以及状态/目录身份一致；缺失、partial、过期 reset、无 reset 的满额、来源不足均 neutral。指纹不依赖读取时间或无关供应商，source 的成功保护也明确处理尚无有效指纹的情况。额度仍只是有假阳性的软排序，不产生 hard skip。

正式设置页源码与构建脚本已经移除额度卡片和额度客户端模块引用，保留 MathCard；没有注册 `swarm_quota_read`。后台 source 自动接入 runtime/delegator，诊断脱敏，来源缓存不写合同、健康墓碑或数学预算。

反方还向 root 指出并确认修复 source 层的策略冲突接线：后台 reader 原调用不带 routes，不能依赖展示 mapper 原先填入的 policyConflict；现在自动排序前针对当前 route 列表重新映射并按 routeId 去重，冲突降为 unknown，不任取同身份的第一个策略。

反方另在独立临时 fixture 中运行 3 个 source seam 用例，全部通过：100% 订阅软后移仍在 API 前尝试，实际成功压过同一旧指纹，冲突策略保持原序且 hint unknown，取消等待拒绝返回新排序。该 fixture 只使用合成公共 RPC 数据与源代码，不调用生产服务、凭据、CLI 或生成模型。正式 source 全量回归与生产实测仍以 root 的后续验证记录为准。
