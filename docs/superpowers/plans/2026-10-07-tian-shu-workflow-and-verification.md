# 天枢任务流程、协作闭环与算法验证能力优化实施方案

日期：2026-10-07（Asia/Shanghai）。状态：设计方案，待按阶段实施。

本次交付只新增本方案文档，不修改运行代码、预设、依赖或现有配置，不执行发布。分析对象为 dsh-agent-swarm 当前工作树：package.json 标识 2.1.0，Git HEAD 为 127e226，但存在大量既有未提交修改，不能将本方案中的当前能力等同于该提交或已发布版本。后续实施应先保存工作树基线，再逐阶段修改。本文代码块是拟议接口，不表示已经实现。

## 1. 推荐结论

采用“任务卡 + 有界结构化流程 + 自动生成 Mermaid + 生成后 Agent/Jev 审核 + 版本绑定证据”的增量设计。天枢继续负责调度与裁决；插件负责校验依赖、记录状态、检查预算和执行硬门禁。第一版不另建通用工作流引擎，也不把 Mermaid 文本当作可执行程序。

把用户提出的能力分成三个交付阶段：

1. **先完成可信流程**：任务与证据版本、流程图、节点执行约束、阶段自检、近距离任务模板、简单任务快速通道、结构化性能预算。
2. **再完成协作与计算**：渐进披露、Jev 无限额审核与复用、专家检查点持久化、受限 P2P 文件邮箱、独立交叉评审、小型纯函数数学算子。
3. **最后完善体验与经验**：宿主 Markdown/公式复用、Mermaid 可视化、经验候选与人工可核对的晋升、真实任务对照评测。

资源统计与最小预算控制从第一阶段开始，不能等功能全部叠加后才评估成本。数学算子可以与协作能力并行实现，不必等待消息总线完成。

新增 P0 优先需求：百工根会话和全部专家遇到已确认的订阅额度耗尽、余额不足或模型池无可用成员时，立即选择已配置的可用备用路由；同一失败域不重复调用、不等待额度恢复。详见 §7.5，覆盖用户给出的 pool exhausted 与 9060669 ms 超长延迟案例。

### 1.1 对每项要求的取舍

| 要求 | 采纳方式 | 剔除或限制 |
| --- | --- | --- |
| 任务执行 Mermaid | 每张新任务卡返回流程定义、源码、当前节点与缺失证据；从同一流程结构生成 Markdown 图 | 不维护模型手写图和另一套调度状态；不执行图里的任意代码 |
| 生成后再审核目标与图 | 对冻结的原始需求、任务卡、图结构与源码做确定性检查，然后独立 Agent 与 Jev 审核 | 不只让任务卡自我对照；审核通过不等于模型保证语义永远正确 |
| 每轮回顾/收敛/反跑题/协作/资源自检 | 在一次委派交付、失败、修复轮或验收前形成一个短检查点 | 不在每个 token、工具调用后追加五段长反思；不默认新增五个 Agent |
| 近距离引导 | 委派正文附近放身份、当前节点任务、输出 schema、停止条件与证据要求 | 不重复粘贴完整角色目录、整份历史和全局长协议 |
| 渐进披露 | 核心约束常驻、当前节点证据按需载入、历史材料通过受控引用读取 | 不把“约 28%”当实测结论；不能省略验收、权限、风险与版本更新 |
| 专家持久化 | 复用现有连续会话；新增持久检查点、已见任务版本和有限摘要 | 不承诺旧宿主进程重启后能够恢复同一个 live thread；不无限保留历史 |
| 专家文件消息总线 | 专家通过授权邮箱直接发送/拉取消息，天枢 LLM 不转述正文 | “零中转”指零协调官内容中转，仍有运行时身份校验、存储与审计 |
| 交叉评审 | 新会话、明确作者与评审关系、盲审后再回应挑战 | 不以更多模型同意代替验证；验算初轮不接收研算解释 |
| 经验沉淀 | 有出处和适用范围的候选经验，经复核晋升，带失效条件 | 不自动改系统提示、权限或门禁；不把失败猜测写成永久事实 |
| 简单任务快速通道 | 自动套用短流程，代码小改保留疾风 + 复核 | 不绕过 changesAlgorithm 等高风险规则，也不免除实际验证 |
| 内置 Jev 快速审核 | 复用既有 Hub、七个工具、分流/会话/交付/验收评估 | 不再接第二套客户端，不用概率做计算或证明，不重复审核同一状态 |
| Jev 不限流、不限预算 | 按用户明确偏好，取消插件侧 RPS 排队和调用数/token/费用额度；所有 Jev 入口统一执行 | 保留观测、请求超时、取消及上游错误恢复，不能通过其他全局预算间接限额 |
| 额度耗尽立即回退 | 订阅、按量 API 和模型池采用能力元数据与不同故障策略；识别后同路由重试 0 次，直接选择备用 | 不把所有 429 都当额度耗尽，不把 pool exhausted 当成唯一的额度证明，不把 API 当成永不失败 |
| Markdown 与公式 | 复用宿主 GFM + KaTeX，规范任务产物格式，补 Mermaid 独立展示 | 不增加第二套 Markdown 解析器；公式展示不触发计算 |
| 数学纯函数算子 | 固定操作名、JSON 输入、精确/近似类型、大小限额、可复算结果 | 不开放 eval、任意 JavaScript、shell、符号求解引擎或隐式文件执行 |

## 2. 现状与应优先修复的架构问题

以下锚点指当前工作树，后续行号可能变化，应同时按函数名查找。

| 已核查的事实 | 代码依据 | 对方案的影响 |
| --- | --- | --- |
| 任务卡已有标题、目标、验收、scope、constraints、perf、风险 flags，没有 workflow | src/policy.ts:15、23；src/tools.ts:50 | 扩展现有任务卡，不创建竞争的规划系统 |
| 已有 G_VERIFY / G_REVIEW / 数学研算验算 / 差分 / 基准 / 视觉门禁 | src/policy.ts:3、45、169 | 流程模板必须覆盖当前 requiredGates |
| 更改已有任务卡保留历史委派和验收；没有任务版本 | src/service.ts:463，尤其 470–477 | 新目标、新验收、新预算不能继续使用旧 accepted 或未重新核对的证据 |
| 连续专家对“已见 taskId”省略背景，没有比较任务版本 | src/delegate.ts:getThreadFollowupText（197）；src/threads.ts | 披露优化前先增加 seenRevision，否则可能更省但更容易沿用旧约束 |
| 门禁主要通过角色、结构化结果与最后编辑时间核对 | src/policy.ts:getGateStatus（427） | 加入任务、流程、产物版本绑定；继续保留现有最后编辑检查 |
| 基准只要求命令成功且摘要含数字，没有比较 card.perf | src/policy.ts:347、388 | 增加有单位、有输入与环境的测量记录和预算比较，不能让超预算结果通过 |
| perf 独立校验仅检查数字类型或“待测” | src/policy.ts:getPerf（86） | 在该入口检查有限、非负及合法单位，不依赖其他 schema 校验间接保护 |
| TaskStore、根会话、ThreadRegistry 都在内存 | src/evidence.ts:154；src/service.ts:265、272；src/threads.ts:intThreadRegistry | 重启恢复属于新增能力，当前连续会话不等于跨进程持久化 |
| JSONL 账本对每个字符串截断到 2000 字符，写失败仅回调 | src/evidence.ts:217、224、257 | 它是脱敏审计日志，不能充当完整状态或恢复数据库 |
| 编辑锁按根会话创建，委派才经过该锁 | src/service.ts:279；src/delegate.ts:896 | 同工作区跨根会话的编辑/验证需统一租约；根直接写与 shell 仍有追踪限制 |
| 守卫只识别 write/edit；shell 写文件无法识别是代码注明的限制 | src/host-contract.ts:45；src/service.ts:569 | 不宣称工具过滤等同 OS 沙箱；最终证据要绑定实际文件摘要 |
| 专家连续会话、忙状态重检、自动重试已存在 | src/delegate.ts:569、634、645；src/threads.ts | 复用这些能力，不重新实现专家生命周期 |
| Jev 已内置、共用凭据，当前 maxRequestsPerSecond 默认 8；复评无调用额度 | src/jev-hub.ts；src/config.ts:42、77；src/service.ts:368 | 按新增用户偏好取消 Jev 插件侧限流，保持调用数/token/费用不限，仅补齐观测；不是新增 Jev 预算 |
| 当前默认单次 Jev 请求最多 4 次重试；专家最多 3 次自动重试 | src/config.ts:48、66；src/jev.ts:253 | 不能描述成“无限重试”；请求故障重试和执行收敛规则保留，Jev 无总额度是用户选定策略 |
| 专家执行不设时间限，断网等待支持取消 | src/config.ts:70、76；src/network.ts | 区分耗时、无成本等待与有成本请求；避免超时后另起重复写任务 |
| 额度/pool exhausted 已被分类为 route-fatal，但 runtime 先 await next()，备用链耗尽又返回原 action | src/routes.ts:306、315；src/runtime.ts:34；src/route-state.ts:144、158 | 若 next() 已执行宿主退避，则分类虽正确仍不能及时回退；无备用不能继续沿用同路由 retry |
| 沙箱宿主 retry 可先等待再返回动作，也存在 always 模式 | .sandbox/dsh-0.2.0-rc.2/node_modules/@deepseek-ai/dsh-llm-retry/lib/index.js:116、142、151 | 必须验证恢复处理的真实顺序，并对百工终态失败截断宿主等待；不能只增加匹配正则 |
| 当前根回退默认 10 分钟后重新尝试选择器模型，外层专家重试可能重新登记路由 | src/route-state.ts:276；src/config.ts:71；src/delegate.ts:569、634 | 订阅额度恢复需要共享故障状态与真实 reset 信息，不能每轮重建或按固定 10 分钟重新撞额度 |
| 本插件最小 failure 类型省略了宿主 providerRetryAfterMs | src/host-contract.ts:62；沙箱 dsh-llm/lib/types/types.d.ts:26 | 扩展宿主契约保留重试/恢复元数据，不能丢掉 9060669 ms 这类诊断事实 |
| 外层专家将所有 stopReason=error 都视作网络疑似故障，提示文案也可能提前声称已经切换 | src/delegate.ts:528；src/util/failure-hint.ts:12 | 额度/池终态先分类，禁止先探网长等待；“已回退”只能依据实际路由事件显示 |
| ChildEndHub 按 childId 等待 end，没有独立消息/attempt 关联契约 | src/threads.ts:98；src/host-contract.ts:122；src/delegate.ts:716 | 首版邮箱在检查点拉取，不能随意 push 唤醒忙专家 |
| 宿主 subagents.list 列出的是 provider，不是存活线程 | src/host-contract.ts:130 | 不能用它假装检测旧 thread 是否可恢复 |
| 0.2.0-rc.2 宿主已公开 MarkdownText，支持 GFM + KaTeX，禁 raw HTML/危险协议 | .sandbox/dsh-0.2.0-rc.2/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/types/index.d.ts:87；markdown/MarkdownText.d.ts:37 | 复用宿主文字与公式展示 |
| MarkdownText 没有代码围栏渲染注入参数；宿主未发现 Mermaid 处理 | 同目录 markdown/MarkdownText.d.ts:41；lib/index.js:renderCode | Mermaid 使用独立任务流程组件，不能声称已有围栏插件接口 |
| 项目已有聊天节点扩展和认证 RPC 模式 | client/model-display.js:233；src/rpc.ts；src/index.ts:100 | 优先沿用已有会话节点投影和 RPC，不新增 Web 服务 |

**优先级判断：** 任务版本与证据失效、性能预算比较、持久真源、工作区并发边界是工程问题；流程图只是这些状态的展示。先让状态正确，再让图准确。

## 3. 三专家正反讨论与裁决

本次实际调用了三个专家 Agent：functional_advocate（软件功能设计，正方）、engineering_skeptic（软件工程设计，反方）、algorithm_performance（软件算法与性能研究，第三方）。三者直接互发观点与反驳，再由主 Agent 结合代码核查整理本方案。以下是设计结论的概括，不是逐字引用或虚构专家投票。

| 争点 | 正方主张 | 反方挑战 | 算法/性能约束与最终裁决 |
| --- | --- | --- | --- |
| 图是否可执行 | 有执行约束才能防止图成为装饰 | Mermaid 与状态分别编辑会漂移；通用引擎成本过高 | 结构化 DAG 是真源；图自动生成；现有 delegate/accept 入口校验，不自动启动所有节点 |
| P2P 是否应直接写共享文件 | 减少天枢转述损耗和等待，专家互相澄清 | 放开只读专家 write 会破坏权限；没有 owner 绑定会串任务 | 专用 send/read 工具写受限邮箱；身份来自 AgentBinding；正文不经过天枢 LLM |
| 直接唤醒专家 | 互动及时，减少调度轮次 | 当前 end 关联按 childId，推送会混淆当前交付；忙会话不能重入 | 首版 pull + checkpoint + single-flight；未来 push 需新宿主关联能力及测试 |
| 每轮自检 | 回顾、收敛、反跑题有助于质量 | 每工具调用长反思会增加成本并制造重复工作 | 每交付/失败/修复/验收边界一个结构化短记录；确定性先行，Jev 按变化触发 |
| 跨轮与重启持久化 | 专家可继续修正，减少重复背景 | 内存注册表与脱敏账本不可恢复；不能假定宿主支持 resume | 持久检查点和摘要重建优先；旧线程只在能力核验通过时恢复 |
| 快速通道 | 简单任务无需全角色登场 | 快道不能跳过硬门禁或仅凭低 token 数判简单 | 确定性低风险规则先决定；疾风 + 复核；发现扩大范围自动转标准路径 |
| 省 token 约 28% | 渐进披露、引用和续会话有节省潜力 | 现有代码已有省 brief，追加消息、Jev 和重试可能抵消节省 | 以当前实现为对照，计入完整开销；只作为待检验假设 |
| 算衡直接计算 | 算法研究中小型计算应当顺手 | 只读角色不能拿 shell 或运行任意模型生成代码 | 新增 pure-calc 能力；固定算子与限额；计算结果不能标为 theorem proved |
| 交叉评审与经验 | 直接互评、沉淀可提升复用 | 原作者解释会污染独立验算；历史错误会扩散 | 初轮盲审隔离，后续反驳关联 findings；经验先候选、证据审核后晋升 |
| “更强隔离” | 消息和协作都需权限保障 | 插件工具限制不是完整进程沙箱 | 真实说明威胁模型；本期保证插件接口不越权，OS/外部进程隔离另行设计 |

正方接受了“图不直接执行”“邮箱不放开业务写权限”“快道不免门禁”的反驳；反方认可了流程可见性、近距离任务提醒、小计算直用和零协调官转述的收益。算法专家要求版本先行、数值语义显式、完整成本计量，作为共同方案的前置条件。

草稿写入后又交给三位专家只读审查。功能专家补充研算先于算法实现、quick 图补修复与检查点；工程反方补充模式边界、动态门禁改图与取消后执行隔离；算法专家补充整数除法、重放规范和取消不可退还已发送请求。本文已吸收这些修正。

## 4. 任务流程的数据模型与 Mermaid

### 4.1 单一真源

保留 TaskCard 原字段，增加可选 workflow 输入；后端规范化成完整定义。旧调用不传 workflow 时，从 flags、requiredGates 与 scope 生成 quick/standard/algorithm 模板，所以所有新任务都能返回 Mermaid。无任何代码改动的只读任务采用“探索 → 证据归纳 → 验收”短模板。

只接受固定节点操作和依赖结构，不接受可执行字符串条件。第一版允许添加分析节点与调整安全顺序，硬门禁、checkpoint 与 accept 由系统补齐；用户不能删除或绕过它们。

~~~ts
type WorkflowMode = 'quick' | 'standard' | 'algorithm'
type NodeOperation = 'delegate' | 'checkpoint' | 'accept'
type NodeStatus = 'pending' | 'ready' | 'running' | 'succeeded'
  | 'failed' | 'blocked' | 'skipped'

interface WorkflowDefinition {
  schemaVersion: 1
  mode: WorkflowMode
  nodes: Array<{
    id: string
    label: string
    operation: NodeOperation
    role?: DelegableRoleId
    mathMode?: 'research' | 'verify'
    dependsOn: string[]
    gates: GateId[]
    requirementRefs: string[]
    acceptanceRefs: string[]
    outputContractVersion: string
  }>
}
interface EvidenceBinding {
  rootSessionId: string
  workspaceId: string
  taskId: string
  cardRevision: number
  workflowRevision: number
  roundId: string
  nodeId: string
  attemptId: string
  artifactDigest: string
  contractVersion: string
}
~~~

TaskRecord 增加 cardRevision、workflowRevision、workflowDefinition、workflowDigest、workflowState、evidenceRefs、checkpoints、executionBudget；DelegationRecord 增加 EvidenceBinding。Mermaid 文本、Markdown 任务说明、节点状态标色全部是上述状态的派生视图，不作为第二个可写真源。

节点操作限制：delegate 只能选择既有角色与对应 schema；checkpoint 由宿主计算及短字段记录；accept 仍调用 getAcceptanceCheck 和原验收逻辑。上下文读取、计算、消息发送均是节点内部的受限工具，不另加十几种节点类型。

### 4.2 输入与图校验

- 检查节点 ID 唯一、依赖存在、角色/模式合法、DAG 无环、节点可达、验收节点唯一且可达；可选节点只由确定性规则标为 skipped。
- 初始限制：最多 32 节点、64 依赖边、标签 120 字符；全部是可调的第一版策略值，需实测，不宣称最佳。
- 每个 requiredGate 必须有可产生该证据的节点；验收依赖所有必需节点和最后检查点。无法补齐的自定义图拒绝保存并返回具体问题。
- 每次委派、检查点和验收前重算 getEffectiveGates。执行中出现新有效门禁时，系统补必要节点、递增 workflowRevision，使对应验收与受影响下游证据失效；不能只在建立任务卡时生成图。保持历史映射可审计，保留无关产物供重新核对。
- 代码实现节点完成后才开启复核、御史与实现后的验算；只读需求、架构、资料探索可并行。复核和写入共享工作区时也要走一致的工作区租约。
- changesAlgorithm 的实现节点必须依赖当前版本 G_MATH_RESEARCH 证据；只有研算节点“存在”但排在实现之后的自定义图不合法。
- 源码由程序生成，只用稳定 ID、转义标签和 flowchart TD，不生成 click、HTML、init 指令、外部资源或自定义脚本。
- 检查复杂度为 O(V + E)。只重算发生变化的状态摘要，默认不在每次模型请求里重新发送整图。

### 4.3 标准任务的可见流程

下面的回边仅展示控制器创建下一修复轮，不是 DAG 中可无限遍历的执行边。每轮 DAG 无环；修复次数受既有 maxAutoFixRounds 约束。

~~~mermaid
flowchart TD
  A["任务卡：目标、验收、预算、范围"] --> B["规则分流与版本化流程"]
  B --> B2["目标、流程设计与 Mermaid 源码审核"]
  B2 --> C["需求、架构、代码探索"]
  C --> D["实施：铸剑或疾风"]
  D --> E["复核：实际测试与基准"]
  D --> F["御史：独立审查"]
  E --> G["检查点：回顾、收敛、范围、协作、资源"]
  F --> G
  G --> H{"门禁、当前版本证据、预算均满足"}
  H -->|是| I["天枢验收与经验候选"]
  H -->|否，仍有修复额度| J["记录问题与开启下一修复轮"]
  J --> D
  H -->|否，无额度或不可恢复| K["记录未完成与精确阻塞原因"]
~~~

图中“御史”“基准”等只在 flags/门禁要求或明确选择时出现；不是所有标准任务强制派全部角色。未知性能要求保留“待测”，不编造通过阈值。

### 4.4 算法任务模板

~~~mermaid
flowchart TD
  A["版本化算法合同：定义、误差、验收、预算"] --> A2["生成图，审核目标、流程设计与源码"]
  A2 --> B["算衡研算：不变量与复杂度"]
  B --> C["铸剑：实现"]
  C --> D["复核：单元、差分、性质、基准"]
  C --> E["算衡验算：新会话独立找反例"]
  C --> F["御史：接口、资源与工程边界"]
  D --> G["宿主检查点与必要的 Jev 语义复评"]
  E --> G
  F --> G
  G --> H{"证据覆盖全部要求"}
  H -->|通过| I["天枢验收"]
  H -->|需要修复且有额度| J["反例或失败反馈，下一轮"]
  J --> C
  H -->|缺证据或额度用尽| K["未完成"]
~~~

纯函数计算工具可辅助 B/E/D，但实际测试门禁仍要求复核运行命令。有限样本检验和高 Jev 概率都不能替代数学证明。

### 4.5 对现有工具的增量接口

| 入口 | 变化 |
| --- | --- |
| swarm_task_card | 增加 workflow 与 expected_card_revision；返回 flow.definition、flow.mermaid、flow.digest、各版本、nextReadyNodes、预算摘要 |
| swarm_delegate | 增加 node_id、expected_workflow_revision、request_id；校验 ready、角色、依赖、权限、预算与单次执行租约 |
| swarm_status | 增加 detail: summary/node/evidence、node_id、cursor、limit；返回版本、流程与小摘要；保留 verbose 兼容 |
| swarm_accept | 除当前门禁外，核对当前版本、必需节点、未解决发现、预算与未完成租约；不得仅凭图的 succeeded 验收 |
| swarm_context_read（新增） | 按已授权引用与 cursor 读取材料，带 digest、版本、截断标识 |
| swarm_message_send/read（新增） | 仅对应线程/任务邮箱的受限通信 |
| swarm_calculate（新增） | 固定纯函数算子，JSON 输入与明确数值类型 |

checkpoint 默认在服务处理交付/失败/验收时自动生成，模型只补一个 progress/nextAction 短字段；不为五项自检增添五个公开工具。经验检索复用 context_read，首版不引入新的搜索服务。

第一版仍由天枢调用 delegate，不自动启动所有 ready 节点。重复 request_id 返回相同 attempt 的状态或结果，不能再次启动；同 node/round 只允许一个有效 attempt，失效结果按绑定版本记录，不能写入当前节点成功状态。

legacy/advisory 调用省略 node_id 时，仅在唯一 ready 节点的角色、模式与 gate 均匹配时自动绑定；多候选则返回明确提示并在 advisory 下保持原委派行为但记录 unmatched。enforced 下此情况拒绝执行，不能暗自选择一个节点。纯 legacy 未参与流程绑定的历史委派只按旧规则查看，不伪装成新版节点证据。

上述依赖、节点状态和必需节点约束在 enforced 模式形成执行/验收阻断。off/advisory 不因新增 DAG 约束阻断原本允许的委派或验收，advisory 记录 would-block 与 unmatched；原有硬门禁及 P0 的任务语义版本、产物摘要、性能预算准确性修复始终有效。验收状态与“流程尚有建议节点”分别显示，不能把 advisory 原规则 accepted 渲染为 enforced 已完成。

新增统一 ReconcileWorkflow，在建卡/改版、before-delegate、after-change、status、accept 入口执行。可预知的编辑在启动前补齐 G_VERIFY；getEffectiveGates 新增必要门禁时补节点，并补最后 checkpoint/accept 的依赖。只有图摘要改变才递增 workflowRevision，门禁扩展不修改 cardRevision。语义改版使有关证据失效；仅门禁扩展时，operation、依赖、输出合同与产物摘要均未变化的上游节点可通过确定性的 carry-forward 事件显式映射到新版本，保留旧 attempt 来源，但新增门禁和受影响下游验收必须重新完成。正在运行的旧版本 attempt 只对原输入有效：相关输入未变化且映射证明完整时可交付到对应节点；否则标 stale，不能把旧结果直接改写成新版本成功，更不能因补图自动重复执行编辑。

### 4.6 生成后再次审核：用户需求、目标与 Mermaid 的执行前审查

2026-10-07 补充要求：每次首次生成任务流程后，再调用独立 Agent 和 Jev，分别审核任务目标、流程设计，以及 Mermaid 源码书写与表达正确性。在默认启用的 planningReview 中，“生成完成”只表示候选图存在；“审核通过”是另一项带版本的状态。

审核依据从**原始用户需求与已确认约束**开始，而不只是检查“流程图是否符合天枢自己写的目标”。保留原始需求及后续用户修改的受控引用、requestRevision 和 requestDigest；为需求建立 requirementId，将其关联到目标、验收条目与节点。映射由任务作者提出，独立评审逐条核对，不能因为存在一个非空 requirementRefs 就认定需求已被覆盖。

原始材料以需求与证据身份传入，不作为系统指令执行。关键信息不明确时列 assumptions/unresolved，不能由审核模型默默补成用户已确认的需求；只有影响目标正确性或范围的歧义才进入明确澄清，其余有据可查的问题由专家补证。

#### 三项分别审核，不能互相代替

| 维度 | 明确检查内容 | 核心依据 |
| --- | --- | --- |
| 目标正确性 goalReview | 原始需求是否忠实转成目标、约束和可检验验收；有无漏项、曲解、擅自扩大范围 | 原始消息/澄清的具体来源位置、完整必要原文、requirementId 映射 |
| 流程设计正确性 designReview | 步骤是否足以实现目标；依赖顺序、并行边界、角色权限、证据产出、异常/修复/停止路径是否合理 | 结构化 DAG、验收追踪、有效门禁和预算；独立 Agent/Jev 语义审核 |
| Mermaid 代码正确性 mermaidReview | 源码能否解析；节点标识、引用、箭头方向、分支、标签与生成器/结构化流程是否一致；有无禁用指令 | 同版本 Mermaid.parse 诊断、受限语法投影一致性检查；Agent/Jev 复核代码所表达的流程 |

ReviewRecord 分别保存 goalReview、designReview、mermaidReview，不把它们平均成一个总分。合法 Mermaid 可能画出错误流程，合理流程可能被写成无效或方向错误的源码，两者都必须分别处理。mermaidReview 记录 parserVersion、generatorVersion、sourceDigest、parseVerdict、projectionVerdict 和具体错误行/节点；模型称语法正确不能覆盖 parser 失败。

Mermaid.parse 失败时先修源码再开展语义审核，不将无法解析的图标为“审核通过”。源码可解析但缺边/反向边/错误标签时，代码一致性检查或语义评审仍须指出错误。演示图中的修复回边由控制器生成并单独标记，不要求它与业务 DAG 的无环依赖投影机械相同。

#### 审查顺序

1. 冻结 ReviewSnapshot，包含原始需求/澄清、任务目标/验收、范围/预算/风险、有效门禁、完整结构化流程、规范化 Mermaid 源码和需求映射。
2. 先由代码检查 DAG、先后顺序、权限、必需门禁、需求/验收引用是否存在；用 Mermaid.parse 检查源码语法，并核对生成器受限语法投影中的节点 ID、标签与依赖边是否与结构化流程一致。语法解析通过不意味着目标或顺序正确。
3. 结构检查通过后，独立只读 Agent 与 Jev 读取同一冻结快照并行审核。Jev 的首次判断不包含 Agent 审核结论，Agent 也看不到 Jev 首次评分，以降低相互锚定。
4. 代码汇总结构证据、Agent 逐条发现与 Jev 各项概率。需要改动时返回定位到 requirement/acceptance/node 的 findings，修改任务卡或流程后生成新快照，再审。
5. enforced 模式下，没有当前快照的有效审核结果时，不启动任务执行节点；advisory 返回待审核/存疑提示和 would-block，不新增实际阻断。任何模式的原硬门禁都保持。

~~~mermaid
flowchart TD
  A["原始用户需求与已确认约束"] --> B["目标、验收与结构化流程"]
  B --> C["生成 Mermaid 并冻结版本快照"]
  C --> D["代码：DAG、门禁、引用、parser 语法与源码一致性"]
  D --> E{"结构检查通过"}
  E -->|是| F["新会话只读 Agent：逐条核对需求与方案"]
  E -->|是| G["Jev：独立的类型化语义判断"]
  F --> H["汇总发现、概率与证据"]
  G --> H
  H --> I{"当前版本审核状态"}
  I -->|通过或允许的明确降级| J["可执行，仍需后续验证与验收"]
  I -->|需要修正且有额度| K["修改目标或图，再冻结并复审"]
  K --> B
  I -->|不明确、必须服务不可用或额度用尽| L["待补证或记录阻塞"]
  E -->|否，仍可修正且有修正轮| K
  E -->|否，不可修复或修正轮用尽| L
~~~

本图描述 planningReview 控制面，不是任务 DAG 中的新业务节点。审核活动本身不再生成一个待审核的新任务图，避免“审核审核流程”的递归。第一轮用于收集原始需求或必要规划材料的只读探索可在执行前开展，但必须区分 planning 与 task execution；不能借“规划探索”开展业务修改。

#### Agent 审查合同

复用既有角色：默认从谋定/枢机/御史中选择未参与该候选目标或流程编写的只读评审者，使用 session:new；任务作者和评审者不能是同一专家会话。优先选不同模型家族，记录实际路由；没有可用独立角色或必需权限时为 unknown/unavailable，不伪造独立审查已达成。

评审不需要作者的自我辩解或此前“模型觉得正确”的评分。输入中必须能读取完整当前图和原始需求；不能因省 token 隐去验收条目、预算、异常/修复分支或重要用户限定。

Agent 使用专用 PlanningReviewResult，输出 verdict(pass/changes_requested/unknown/needs-clarification)、goalReview/designReview/mermaidReview、逐条 requirementCoverage、findings、assumptions、unresolved。finding 包含 requirementId、acceptanceId 或 nodeId、严重度、问题、依据与修正建议。pass 要求三个维度均满足合同、没有未解决 critical/high 发现、所有必需需求有实质覆盖、重要假设有依据，且报告绑定该 ReviewSnapshot；泛泛一句“看起来正确”不构成 pass。

审查重点为：目标是否忠实于用户意图、是否遗漏/扩张要求、验收是否真正对应目标、步骤与依赖是否能产生验收证据、预算与权限是否相容、失败/修复/停止路径是否有界。语义判断仍可能出错，因此对可确定检查的部分始终以代码与证据为依据。

#### Jev 审查问题与汇总策略

复用现有 JevHub，一次批量提出独立 Noul 问题并按三个维度分组：目标与原始需求一致、必需需求有完整覆盖、验收可检验且回应目标；步骤与顺序适合完成目标、权限与非 Jev 预算没有明显矛盾、失败与停止策略明确；Mermaid 节点文字/箭头/分支表达与当前结构化流程和目标一致。每个问题写出正反判定标准，完整必要原文与源码随同快照提供；缺证据不能被当作“没有问题”。算术、parser 语法结论和图的精确等价判定由代码完成，不让 Jev 重复替代码裁决。

概率阈值由本项目标注样本校准，试点可将正向概率 0.8 设为初始 reviewAbove，明确它只是初始策略。低于阈值或存在材料缺失属于需复核信号，不代表模型证明错误；高概率也不是语义正确保证。

| 结果组合 | 后续动作 |
| --- | --- |
| 结构通过 + Agent pass + Jev 通过当前策略 | pass；允许 enforced 执行 |
| 结构失败、Agent changes_requested/unknown，或发现未解决严重问题 | changes_requested/unknown；先修正或补证，不能用 Jev 高分覆盖 |
| Agent pass + Jev 指出问题/不确定 | review_required；再由另一独立 Agent 定向复核具体争点，不能直接按多数票通过 |
| Agent pass + Jev 无密钥/网络错误/超时/上游配额或计费错误 | requireJev=false 时 pass_with_degradation 并明确服务原因；requireJev=true 时 unavailable，enforced 等待补齐；插件没有 Jev 本地预算不足状态 |
| 定向 Agent 有证据回应争点但 Jev 仍有未决语义问题 | 记录复核依据，修改或补足当前快照后重新审核；不能只凭天枢采信消除未决审核 |
| 没有当前版本快照审核、审核模型不可用或材料不完整 | pending/unknown/unavailable，不能显示已审核 |

planningReview 默认调用 Agent 和 Jev；requireJev=false 仅允许已记录的服务不可用降级，不允许将未解决的语义反对或缺项称为降级通过，也不意味着默认省略 Jev。available 不等于 pass，缺失答案或解析失败为 unknown。需要“两个审核都完成并满足策略才执行”的 profile 设置 requireJev=true；必要服务不可用或结果未决时明确阻塞，不以等待超时推定审核通过，不自动切换 legacy/advisory 逃过审核。

#### 审核版本、成本与失效规则

ReviewSnapshot/ReviewRecord 绑定 rootSessionId、workspaceId、taskId、requestRevision/requestDigest（含原始消息/澄清 source/span）、cardRevision、workflowRevision/workflowDigest、mermaidDigest、effectiveGatesDigest、requirementMapDigest、reviewPolicyVersion、parserVersion/generatorVersion，以及实际 reviewer/jev 模型、问题版本和审核时间。结果由服务根据真实完成的审查写入，swarm_task_card 不能接受模型自报 planningReview:pass。

目标、验收、步骤/依赖、门禁、权限或非 Jev 预算发生语义变化时审核 stale；审核结果提交与每次 mutation/执行启动都原子比较当前绑定，避免“审核旧图、执行新图”。同一有效快照缓存复用；仅颜色、节点运行状态或布局变化不改变语义图摘要，无需重新调用 Agent/Jev。用户追加需求即使尚未更新任务卡，也立即递增 requestRevision 并使旧审核失效；题义/策略、生成器/解析器语义或关键未确认假设改变同样需要复审。

流程初始化的审核属于 planning 阶段，规划 Agent 委派计入非 Jev 总预算，Jev 物理尝试与用量只统计，不设限额。不能复用 task execution 的 ready 检查来启动审核，否则会出现“没审核不能派评审”的循环。快道也保留一次短 Agent 审核与一次批量 Jev，不给每个节点分别派评审。规划审核是宿主内部只读控制面，不提供由模型传入 review:true 的公开豁免；其结果不能满足实现后的 G_REVIEW/G_MATH_VERIFY/G_VERIFY。

maxPlanningReviewFixRounds 初始为 2，表示初审加最多两次修正复审；它限制规划修改循环，不是 Jev 调用配额。计数由 task 级控制记录维护；改变 workflowRevision、退回模板或改 task 标题不重置返修次数。专家 Agent 重试计入非 Jev 预算，Jev 请求重试仅统计；非 Jev 额度或修正轮用尽后记录缺失项，不无限重画。Jev 自身不受任务/session/global 调用数、token 或费用上限约束。

初始 bounded 非 Jev 预算为规划审核留出额度：quick 总委派为 6，standard 为 16，algorithm 为 20，全部仍为待评测试点值；启动规划 Agent 前预留必要后续执行/验证的最低额度。快道在正常无冲突情况下只多一次独立规划委派和一次批量 Jev，异常返修与定向 Agent 复核计入专家总预算。Jev 没有物理尝试总上限。后续验收证据门禁不因规划审核已通过而减少。

任务卡/状态页显示“流程已生成”“审核中”“需修正”“已审核”“降级审核”“审核失效”及发现定位，区分 planningReview 与执行验收。swarm_task_card 可返回 pending 候选图；后台或显式规划审核返回完成状态。swarm_delegate 在 enforced 中拒绝尚未审核的执行节点，但允许宿主登记的 planning 只读审查操作；swarm_accept 再核对当前审核绑定。

planningReview 增加 src/planning-review.ts、审核 schema、受控规划调用入口与状态字段，复用 delegate/threads 的路由与生命周期，禁止伪造临时任务或绕过预算。P1 即实现该能力，客户端与 Jev 字段随原阶段集成。

## 5. 版本、证据与并发控制：第一阶段的前置工程

### 5.1 任务改版规则

变更 goal、acceptance、scope、constraints、perf、flags 或 workflow 的语义内容时递增相应 revision。只有标题/展示文案变化可列为 presentationRevision，不使验证失效。

语义改版必须清除“当前已验收”投影，把历史 accepted 保留在历史中；running 尝试仍记录结果，但旧版本产物不自动满足新版本门禁。首版采用保守策略：有关节点证据全部 stale；以后只有显式再验证才能复用，不能由 Jev 判断“差不多一样”直接迁移。

thread.seenRevision 保存已见 card/workflow 版本。版本变化时，下一次委派必须发送新目标、验收、约束、预算以及版本差异，不能仅因为 taskId 相同而省 brief。新会话、模型切换、摘要重建均重新装载 L0 核心合同。

严重发现与反例 resolution 增加当前修复产物引用和复查结果。只有一段“已处理”的文字不能证明缺陷已经消失；保持旧接口的历史可读性，新流程的阻断发现需要可核对的处理证据。

### 5.2 产物版本

对任务 scope 与实际 changedFiles 的并集生成规范化文件清单与内容摘要。摘要包含未跟踪文件及不存在的文件标记，不仅用 git HEAD。大文件可采用明确上限与流式 hash；超限或读失败标为 unknown，不能假装验证有效。

验证开始与结束均采集产物摘要；若期间文件发生变化，结果标 stale。最后验收重新核对摘要。根 write/edit、shell、外部编辑不能完全由当前工具事件覆盖，因此通过实际摘要核对补足，不声称已拥有完整文件系统监控或 OS 隔离。

### 5.3 工作区与状态锁

新增 canonical workspaceId（realpath + profile 边界），进程内按 workspaceId 管理 edit/verify 排他租约；TaskStore 的改版、预算预留、attempt 状态更新按 task 锁执行。必须先预留预算与 node attempt，再启动专家，避免并行请求分别看到“还剩一次”而重复消费。

执行互斥以真实 canonical cwd 为锁键，profile 用于授权命名空间，不能把 profile 拼进锁键后让两个 profile 对同一 cwd 各持独立锁。enforced 流程运行期间，天枢直接 write/edit 与可能改文件的通用 shell 统一由现有同步 guard 拒绝，交给受租约管理的委派执行；advisory/legacy 保留旧行为并注明可能有外部并写。若要透明包装根工具获取/释放租约，必须先核验宿主工具前后钩子能力，不能只靠当前 guard 假称已经实现。

统一锁顺序：状态事务完成后再等待工作区执行租约；持有执行租约时只做短状态事务，不在 task 锁内等待模型、网络或另一个专家。禁止持锁同步等待 P2P 回复，避免协作死锁。

对于多进程共享同一目录，第一版执行层只支持一个 owner 进程；其他进程检测到活动 owner 后拒绝写入或验证，给出原因。检测机制是专用运行目录的独占 owner 标记与恢复握手，不能把旧的 session mutex 宣称为跨进程锁。NAS/NFS 文件锁与掉电耐久不作未验证保证，必须纳入故障验证；需要分布式并写时另行采用事务存储与 fencing。

取消执行只发出停止信号；确认子进程/原生后端停止后才能释放写租约。无法确认副作用执行已停止时，workspace 标 mutationUnknown，暂停新的写/验证租约并要求 reconcile；不能仅因 dispose/AbortSignal 被调用就另起替代写任务。观察模式记录此风险，只有受控执行路径才提供租约保障。

owner 标记过期不证明原进程已经退出；无法确认旧 owner 停止时拒绝自动接管。取消进入 cancelling 后立即撤销新调用与通信权限，状态 reconcile 完成才能颁发新 leaseEpoch。

## 6. 每轮自检、近距离引导与快速通道

### 6.1 一轮的明确定义

一轮是一个节点 attempt 交付/失败，或一组并行只读节点全部结束后的调度边界；修复轮与验收前另形成检查点。不是每个工具调用，也不是每条 P2P 消息。首次探索允许“新增风险/收窄假设”计作有效进展，不能只按完成门禁数评价研究任务。

每个 Checkpoint 记录以下五个短字段，宿主能计算的部分优先计算：

| 项目 | 检查内容 | 失败时动作 |
| --- | --- | --- |
| 回顾 | 当前目标版本、已新增证据、已失败的验证 | 引用真实结果，不重复生成长总结 |
| 收敛 | unresolvedDelta、newEvidence、resolvedFindings、下一步是否有可检验价值 | 连续 2 个检查点同一阻塞且无新证据，暂停该分支，记录阻塞；2 是初始可调值 |
| 反跑题 | 当前动作与节点目标、允许路径、验收要求是否一致 | 确定性越界阻止执行；语义疑似偏离用单个 Jev 判断或专家澄清 |
| 协作 | 依赖是否已满足、消息是否过期/冲突、是否重复执行 | 去重、交由对应专家回应；冲突保持 unresolved，天枢最终裁决 |
| 资源 | 非 Jev 请求/token/费用额度；全部来源用量、等待/活动时间、输入大小、修复剩余额度 | 非 Jev 到限停止新受预算约束请求或升级；Jev 只观测，不因预算停止 |

修复额度继续采用 maxAutoFixRounds 默认 2，但必须在“开始新的修复 attempt”时以 roundId 原子消费，不能仅依赖天枢主动提交 reject。自动重试不重复消耗修复轮，却消耗物理调用与 token 预算；同轮不重启重复副作用任务。

不增加“强制每轮重新搜索、重新审查、重新拉起专家”的要求。已完成且仍有效的证据无需重复验证。

无进展计数只针对已有机会执行的工作轮；网络、用户输入、前置专家等待单列 waiting，不增加停滞次数。任务 accepted、证据满足或停止条件已达到时立刻停止，不为形成检查点再次调用模型。

### 6.2 委派的近距离模板

保留 src/model-family.ts 的 Claude XML / GPT / generic 风格，仅由统一 TaskEnvelope 映射出不同表述：

~~~text
身份：当前角色、权限、本轮职责、独立性要求
任务：task/node/round/attempt 与 card/workflow revision
目标：当前节点完成后应产生什么
必守：验收要点、风险、路径与资源预算、禁止越权
输入：当前版本合同 + 直接依赖证据摘要 + 受控引用
输出：该角色实际 outputSchema、证据引用、unresolved
停止：满足节点标准即交付；阻塞、反例、资源不足如实记录
~~~

角色级 outputSchema 仍由 src/contracts.ts 统一定义。不能把原 schema、另一份文字模板和第三份前端 schema 分别维护。全局静态身份只放 persona，本轮约束放请求附近；长材料用引用，不改变原先按模型家族组织提示的合理设计。

### 6.3 快速通道

quick 由确定性规则决定：范围明确且局部、需求不含歧义、不涉及算法语义、数值精度、安全、资金/回测、状态机、并发、跨模块架构；不得仅凭文件少或 Jev “简单”分类决定。

~~~mermaid
flowchart TD
  A["任务卡与短流程自动生成"] --> A2["短 Agent 审查与 Jev 三项审核"]
  A2 --> B["疾风局部修改"]
  B --> C["复核实际运行必要检查"]
  C --> H["短检查点：进展、范围、协作、预算"]
  H --> D{"范围、证据、预算满足"}
  D -->|是| E["天枢验收"]
  D -->|范围扩大或出现风险| F["保留产物，改版转标准流程"]
  D -->|验证失败且仍有额度| J["记录失败，开启下一修复轮"]
  J --> B
  D -->|失败且无修复额度| G["未完成"]
~~~

只读简单任务可以不调用疾风/复核，其证据仍须支持验收。quick 不创建专用协调 Agent；规则分流已足够时不调用 Jev 做重复分流。交付与验收的 Jev 审核优先复用同一状态快照，保留关闭或不可用时的规则路径。

## 7. 渐进披露与 Jev 快速审核

### 7.1 三层上下文

| 层 | 内容 | 装载规则 |
| --- | --- | --- |
| L0 常驻合同 | 身份/权限、当前目标、验收、风险、预算、版本、当前节点输出要求 | 每个新会话和每次语义改版必须可见；不能为省 token 隐去 |
| L1 当前材料 | 当前节点直接依赖的证据、必要文件片段、未解决问题 | 初轮提供；后续按版本变化提供差量 |
| L2 历史与参考 | 旧专家完整产物、长文档、日志、经验候选 | context_read 按引用与页读取，返回 digest 与来源；按权限过滤 |

保存摘要与完整受控产物分离；摘要记录覆盖范围与未解决事项，不是凭空压缩成“都完成”。取到截断材料时明确 truncated、nextCursor、totalBytes；数学推导、反例或验收关键上下文不得只取头尾片段。

swarm_status 的 summary 控制为一屏任务信息，按 node/evidence 读取细节；旧 verbose 继续可用但设置返回体限额。身份映射隔离不同任务、工作区和独立验算模式，不能借引用检索绕过盲审。

### 7.2 Jev 的角色

已经存在的 triage、session plan、delivery review、acceptance review 保留，并统一通过 JevHub。新增的轮次语义核查按相同状态批处理，独立问题可以一次请求提出；依赖先前答案才能构造的问题分第二次，不能错误地假定批内题目互见。

拟新增问题限于明确语义判断，例如“当前动作是否回应节点目标”“证据是否支撑这个验收条目”“是否与某项未解决发现冲突”。ID 不携带题意，instructions 与 criteria 必须完整。算术、图校验、单位换算、预算比较、权限与状态迁移由代码执行。

缓存键包含 resolvedModel、questionVersion、stateDigest、cardRevision、workflowRevision、artifactDigest 和相关上下文版本；服务端使用会话绑定 HMAC/digest，避免暴露敏感正文。缓存只在相同状态与题义下复用；TTL 到期、模型版本变化或材料改版均失效。不声称 jev-latest 永远固定，应从响应记录实际模型；无法识别真实版本时限制为当前运行周期的短缓存。

Choice/Score 的 confidence 表示分布集中程度，不是正确率；Noul 返回 yes 概率且没有独立 confidence。阈值应通过本项目样本校准。Jev 失败、超时、无密钥或上游服务拒绝时返回 unavailable/unknown 并注明来源，继续确定性门禁与必要专家验证；没有 Jev 本地预算不足状态，不能将不可用转换成 trusted，也不能用 Jev 移除规则门禁。

### 7.3 Jev 不做插件侧限流或预算限额

用户明确说明 Jev 的 API 成本很低，并选择 Jev 不限流、不限预算。本方案据此采用以下政策，适用于任务分流、会话规划、生成后规划审核、轮次检查、专家交付/验收复评，以及所有 jev_* 工具：

- 不设置主动 RPS 节流、并发调用额度、每任务/会话/全局调用数上限，也不设置 Jev token 或费用额度。
- Jev 费用与用量单独观测，明确排除于 executionBudget 的拒绝/停止判定之外。非 Jev 预算耗尽不能使独立 Jev 工具返回“本地额度已用尽”；已结束任务不会因此新增工作，但有效请求不被 Jev 额度拦截。
- 拟议配置 effective maxRequestsPerSecond=0 表示不限，既有非零配置迁移为停用/忽略主动节流，并在配置说明中注明。不能悄悄保留原 8 RPS，也不能把 0 显示为 0 次可用。
- **现有实现需要实改**：src/jev.ts:intRequestLimiter 使用 Math.max(1, max)，当前传 0 会变成 1 RPS。实现阶段必须让 0 直接返回无需排队的 acquire，或在客户端跳过 limiter；JevHub 全入口共用这一无节流路径。这里只修改设计方案，没有提前改变当前运行代码。
- 保留单次请求超时、AbortSignal、有限失败重试和收到上游 429/5xx 后的 Retry-After/退避。这些处理服务错误与请求生命周期，不是插件主动限流，也不是累计使用预算。上游服务自己的配额/429 不由本插件控制，不伪装成本地额度耗尽。
- maxRequestChars 保留为接口输入容量限制，Math/邮箱/图规模限制亦保持各自语义；它不累计调用额度。缓存只复用同一有效快照，显式要求重新审核时可以 bypassCache，不因缓存或本地限额拒绝重新判断。

最大规划/实现修正轮控制的是任务收敛，不是 Jev 计费限制。不因为 Jev 便宜就无目的地重复审核同一状态，也不让固定审核轮数妨碍用户显式要求对新证据重新判断。

### 7.4 非 Jev 预算与全部来源观测

区别被调度的委派、模型 HTTP 尝试、成功调用、队列等待、断网等待、token 与实际/估算费用。成功 usage、失败尝试、重试以及 jev_* 直接调用必须统一归属到任务和 attempt。获取不到宿主 usage 时标记 unknown，不能填 0。

保留旧专家 budgets 配置含义。新增非 Jev executionBudget 和 profile: legacy/bounded：升级已有专家配置默认 legacy，新流程试点显式启用 bounded；Jev 限流策略按本次明确偏好统一变更，不继承旧 RPS 节流。有限专家预算属于试点默认策略，不是现有版本事实：

| 初始策略 | quick | standard | algorithm |
| --- | --- | --- | --- |
| 委派预算（包括规划审核） | 6 | 16 | 20 |
| Jev 调用/物理尝试/token/费用额度 | 不限 | 不限 | 不限 |
| 自动修复轮 | 2 | 2 | 2 |
| mailbox 未确认消息/任务 | 32 | 128 | 128 |

非 Jev 尝试与专家委派预算在其覆盖来源内共享；调用前原子预留，达到上限后新专家请求返回明确原因，不能以自动 fallback 绕过。Jev 不经过该预算预留与拒绝路径，只累计统计。实际专家额度需经评测调整；必需专家验证没有额度时，任务标未完成而非降低验收标准，试点前应显示最低验证预算。

非 Jev token 和费用上限由用户预算或已核实模型价格配置，不填臆测值。Jev 实际/估算费用另列，但不计入上限判定。宿主不提供 token/费用时无法宣称严格专家 token/费用门禁，bounded 仍可执行专家调用数、输入字符数与尝试数上限，状态显示计量缺口。

配置、任务说明与近距离提示同源读取预算：0 显示“不限”，unknown 显示“未知/待测”，不得渲染“最多 0 次”。maxAutoFixRounds 使用配置值，persona 不再硬编码“两轮”覆盖用户设置。

活动运行期限为可选设置，默认沿用当前专家无时间限行为。断网等待不计为 token 消费；不能因等待长同时再启动同一写节点。取消传递 AbortSignal，并依照租约规则确认停止与副作用状态后释放执行权。

非 Jev 预算预留状态为 reserved → started → settled：仅未发出的 reserved 可取消退款；已发请求消费尝试数，已使用 token/费用不因取消退还，无法取得用量标 unknown。反复“发出 → 取消 → 重试”不能绕过专家上限。Jev HTTP 仅做尝试与用量观测，无预留、退款或累计限额；专家/原生后端物理尝试需宿主 hooks，缺少 hooks 时分别显示覆盖范围，不能宣称不可观测的专家调用已严格计费控制。

### 7.5 额度耗尽立即回退、订阅与按量 API 的路由规划

2026-10-07 新增要求：用户观察到百工模型在不可用时长时间、多次重试，给出的原始案例是：

~~~text
重试延迟：9060669毫秒
失败原因：pool "claude-opus-5-5" exhausted: every member is unavailable or failed
~~~

9060669 ms = 2 小时 31 分 0.669 秒。该案例必须进入回归 fixture。pool exhausted 表示池内当前没有可用成员，原因可能是额度、认证、服务错误或其他成员故障；仅凭这句消息不能断言 Claude Pro 的具体额度已耗尽。但它足以要求停止对该池排队重试，选择其他可用的已配置备用路由。

#### 资源类型与职责

| 资源类别 | 本项目实例与默认用途 | 失败策略 |
| --- | --- | --- |
| 语义判断 API | Jev：规划审核、证据支持、目标对齐、冲突提示 | 保持 §7.3 的无本地限流/使用额度；上游瞬时错误可有限重试，余额/认证终态错误直接 unavailable，不无限重试，也不作为天枢/实现模型的备用 |
| 按量付费生成 API | deepseek-official；其他已配置且明确采用 API 计费的生成接口 | 不套用订阅的固定恢复窗口；真实余额不足/账号禁用立即回退，短时 rate-limit/5xx 依策略短重试 |
| 订阅生成服务 | claude（Claude Pro 等账号登录）、codex（ChatGPT Pro 等账号登录）、opencode-go、qwen-token-plan-cn | 额度/计划上限耗尽立即隔离该额度域并切备用；实际恢复窗口来自适配器/官方用量状态，不写死所有产品同一周期 |
| API 池或代理聚合 | 用户案例中的 claude-opus-5-5 pool；实际 provider/账号/池由宿主返回 | pool exhausted 直接跳过该池；保留成员失败原因，禁止把同一个不可用池换名字当新的备用 |

“不设插件本地使用额度”不代表上游永远不限速或无需余额。DeepSeek 官方说明 402 为余额不足、429 为请求速率限制；两者需要不同动作。[DeepSeek 错误说明](https://api-docs.deepseek.com/quick_start/error_codes/)

订阅额度与 API 计费按实际接入方式区分，不按模型名称猜测。Claude 账号多产品共享用量；OpenAI 的订阅额度和 API-key 用量采用不同计费方式；OpenCode Go 与 Qwen Coding Plan 都有自身计划限制。具体周期、剩余额度、追加余额/积分行为应读取当前账户和已配置入口，不能因同名模型推断额度共享或自动变更计费。[Claude 用量说明](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work)、[OpenAI Docs：计费与用量](https://learn.chatgpt.com/docs/pricing)、[OpenCode Go](https://opencode.ai/docs/go/)、[Qwen Coding Plan](https://www.alibabacloud.com/help/en/model-studio/coding-plan)

上述分类属于路由策略，不改变 §7.4 已明确的非 Jev 任务执行预算。已经配置在备用链中的 API 可以按配置自动使用，不能把“订阅耗尽”解释为自动购买积分、开通额外账户或启用未配置的付费服务。

#### 结构化路由与错误契约

新增 RouteResourcePolicy，与现有 routes.chain 条目关联，缺失元数据时保守处理，不保存原始凭据：

~~~ts
interface RouteResourcePolicy {
  provider: string
  model: string
  accessMode: 'subscription' | 'metered_api' | 'judgment_api' | 'unknown'
  quotaDomainId?: string // 宿主账号/凭据/计划/模型池域的不透明标识
  quotaScope: 'account' | 'plan' | 'model' | 'pool' | 'unknown'
  poolId?: string
  configuredAsFallback: boolean
  capabilities: { generation: boolean; structuredOutput: boolean;
    vision: boolean; tools: boolean }
}
type FailureKind = 'quota_exhausted' | 'pool_exhausted'
  | 'insufficient_balance' | 'auth_invalid' | 'model_unavailable'
  | 'rate_limited' | 'network_transient' | 'service_transient' | 'unknown'
interface NormalizedRouteFailure {
  kind: FailureKind
  provider: string
  model: string
  quotaDomainId?: string
  poolId?: string
  code?: string
  status?: number
  requestId?: string
  providerRetryAfterMs?: number
  resetAt?: string
  origin: 'provider' | 'pool' | 'native' | 'host'
  underlyingKinds: FailureKind[]
  message: string
}
~~~

host-contract.ts 保留宿主已有的 providerRetryAfterMs、requestId 和可用的底层错误码；其他字段通过版本化 provider/native/pool 适配层读取。没有可用字段就标 unknown，不把字符串解析结果伪装成服务商确认的 resetAt。

判定优先级：结构化额度/余额/池不可用事实 → 已验证供应商错误码 → 精确错误模式 → HTTP 状态与短时故障 → unknown。兼容 QUOTA、usage limit、insufficient balance、模型池 exhausted 及供应商实际返回的计划限制码；不以包含任意 quota 单词的错误消息笼统覆盖限速/并发错误。HTTP 402 的已知按量 API 含义、429 的 quota/rate-limit 区分需要供应商适配，不能把全部 429 归为同一类。

额度或池不可用的快路径由代码执行，不等待 Jev 再批准切换。Jev 可以帮助解释歧义、核对报告，但概率不能覆盖已确认的服务错误或代替宿主路由动作。

#### 重试、等待与回退规则

| 失败类别 | 当前失败路由重复重试 | 实际动作 |
| --- | --- | --- |
| 订阅额度耗尽/计划到限 | 0 次 | 记录 quotaDomain 不可用，立即选择下一条合法备用 |
| pool exhausted | 0 次 | 隔离 pool，跳过同池别名/成员，选择其他可用资源 |
| 按量 API 余额不足 | 0 次 | 隔离该凭据的余额域，切其他已配置路由；不等待充值 |
| 明确认证失效/账号禁用 | 0 次 | 按实际凭据域隔离，不反复刷新/重发；不要未经依据屏蔽同 provider 的所有独立账户 |
| 模型不存在/无权限/不支持当前输入 | 0 次 | 跳过该模型路由，保留其他可用模型；选择兼容 vision/tools/schema 的备用 |
| 真正短时 rate-limit 或服务故障 | 初始最多额外 1 次 | 只有 delay <= 2000 ms 且本请求累计等待 <= 5000 ms 时短重试；超出就回退，长 Retry-After 作为该路由不可用时间记录 |
| 真实全机断网 | 使用独立可取消的 network wait | 按现有配置显示网络等待，不轮流冲击全部供应商；已确认额度/pool 错误不得走此路径 |
| 所有合法备用都不可用 | 0 次 | route_chain_exhausted，明确记录未完成；不得返回原同路由 retry 或启动新专家再撞一次 |

2000/5000 ms 为本次短重试策略初始值，需实测校准；它们约束百工任务生成模型的失败等待，不构成 Jev RPS 或用量限制。Jev 请求继续采用独立的请求生命周期设置，不套用生成模型的订阅额度与尝试总上限。

如果 providerRetryAfterMs 很长，插件不能把它截短后提前再打同一服务。正确行为是暂时隔离该路由并切备用，在真实允许时间之后才考虑恢复。对于明确终态故障，无论宿主 retryableCodes 或 mode:always 怎么配置，百工均不得在原路由延迟重试。

#### 必须先解决宿主和外层重试的执行顺序

当前 runtime.ts 调用 getErrorAction 时先 await next()；沙箱宿主 llm-retry 的 backoff 在返回 retry 之前真的等待。实现不能只把 quota 正则加进 routes.ts，或在等待结束后才覆写返回动作。

P0-R 需要验证 Cordis 恢复 waterfall 的真实顺序：百工终态失败判定必须在宿主退避和网络探测之前执行并截断旧动作。优先通过可验证的预设/作用域组合让百工拥有该会话的 recovery 决策；如果当前宿主顺序或 always 重试无法被完整截断，必须增加正式的“百工托管会话绕过默认 retry”宿主协作适配，使用已有 managed-agent 登记识别会话。不能伪造宿主不存在的 stop 动作，也不能将“发出取消信号”误当等待一定已被停止。

协作能力未验证时，doctor 明确报告 immediate-fallback 不可保证；P0-R 不能宣称完成。实现通过版本化包/配置组合或宿主正式扩展交付，不靠修改 node_modules 临时维持；其他会话仍按其原重试策略运行。

routes.ts / route-state.ts 在没有下一条可用路由时返回经过宿主契约验证的终止结果，记录 failedRoute/attempt/suppressedRetryAfter；不能回传原来的长延迟 retry。delegate.ts 的自动续跑/重启也要识别 route_chain_exhausted，停止同一逻辑请求的外层重试。正常路由切换只重新发送失败的模型请求，不重新执行已经成功的工具、副作用或整段任务。

native Codex/Claude 的内部重试也在验收范围。适配器收到明确额度/池终态错误时需要立即将结构化失败交给同一恢复控制面，不能让原生子进程继续等数小时；跨 native/API 切换要复用已审计上下文与工具结果。若后端没有可验证的终态通知/停止能力，状态明确标该能力不可保证，未确认副作用进程停止前遵守 §5.3 的 mutationUnknown，不同时启动新的写专家。

一轮模型请求维护共享 RequestRecoveryState：logicalRequestId、attemptId、已尝试 routeId/quotaDomain/pool、瞬时重试数、累计等待与 terminal 标记。宿主重试、专家 oneshot/continuable 重试、native fallback 共用该标记，不能层层各重试三次、清空状态后重新从首选链启动。正常备用切换不消耗一次新专家委派或任务修复轮，实际模型请求仍按 §7.4 的非 Jev 观测/预算计量。

另设同一 logicalRequest 的生成模型实际发送上限，初始最多 8 次，包含首次、各备用和瞬时重试，排除 Jev；用户把任务委派总额度设为不限也不能绕过这一恢复循环边界。上限到达返回 recovery_attempts_exhausted，不假称所有未尝试备用均已失败。额度/pool 错误本身始终重试 0 次，8 是整条恢复过程的上限，不是先对耗尽模型重试 8 次。

#### 共享额度故障状态与恢复

故障状态按 profile 下实际 quotaDomain/pool 身份共享给天枢、各角色与专家线程，不仅按 agentId 保存。已知账号/计划共享额度耗尽时，同域不同模型也跳过；已知仅模型池到限时不擅自封禁别的独立池。未知域至少阻断当前 route/pool，优先选择不同已知额度域的备用，不把 provider 相同就一律认作同域。

额度隔离不因线程结束、AddChild 重登记、修复轮、容灾升级或根会话 rootRecoverMs=600000 自动清除。resetAt 由真实服务信息提供，恢复前只允许单个受控 half-open 验证；没有 reset 信息时当前任务保持备用，后续由已验证用量查询、凭据/配置更新或用户显式再试解除。路由预检“模型可解析”不能证明额度已恢复。

用户更换选择器时尊重其选择，但当前额度隔离仍显示并生效；选择同一不可用域不默默触发十多次重试。切换后的实际供应商、模型、推理强度、隔离原因与恢复依据写入状态和路由事件。跨重启是否恢复额度状态由 persistence 配置决定，关闭时明确该状态仅进程内有效。

客户端区分“识别到额度/池不可用”“正在选择备用”“已切换实际模型”“没有可用备用”，仅在真正写入路由覆盖并使用备用时显示“已回退”。保留原失败消息与原始 Retry-After 作为诊断，不将数小时延迟渲染成当前任务的剩余等待。

#### 回退流程与验收

~~~mermaid
flowchart TD
  A["模型请求失败：保留实际错误与 Retry-After"] --> B["代码分类与共享恢复状态"]
  B --> C{"确认额度、余额或模型池不可用"}
  C -->|是| D["原路由重试 0 次，隔离故障域"]
  C -->|否| E{"可在短等待窗口内恢复"}
  E -->|是| F["最多一次短时重试"]
  E -->|否| D
  F -->|再次失败| D
  F -->|成功| G["继续当前任务"]
  D --> H["选择已配置且能力兼容的可用备用"]
  H --> I{"存在合法备用"}
  I -->|是，恢复尝试仍有余量| J["切换实际路由，复用已完成工具结果"]
  J --> G
  I -->|否或恢复次数用尽| K["停止该请求，记录链不可用或恢复上限"]
~~~

该图只表示网络可达情况下的模型故障恢复，真实断网另走明确 waiting 状态。订阅额度恢复或数小时 Retry-After 不放在任务关键执行路径里睡眠。

验收必须包含：用户原始 pool 错误与 9060669 ms、QUOTA/402、订阅到限型 429 与短 rate-limit 型 429、相同额度域不同模型、独立账户、根/所有角色、oneshot/continuable/native、宿主 normal/always、全部备用不可用、长 Retry-After、共享状态不被重登记清空、无重复工具执行，以及 Jev 仍无限流/无额度。配置可用备用时，首个已识别终态错误之后同失败路由请求数为 0，既不调 sleep(9060669)，也不生成同路由 llm/retry 等待事件。

## 8. 专家持久化、P2P 文件消息与交叉评审

### 8.1 持久化真源

运行目录采用 DSH_HOME/share/dsh-agent-swarm/state/<workspaceHash>/<rootSessionId>/，不放在业务源码 scope 中。workspaceHash 是稳定标识，绝不是访问凭据。根会话、任务、线程、attempt、产物都用 UUID/命名空间标识；可保留 T-1、D-1 作为展示别名。

首版实现一套 DurableStateStore：完整、受限访问的 snapshot + 按序事件 journal + artifact 文件。日志仍是原先脱敏 JSONL，明确与恢复真源分开。持久态避免保存凭据，敏感材料通过已授权 artifact 引用；摘要不得偷偷丢失恢复所需的未解决问题。

存储操作返回成功/失败，重要状态必须 durable commit 后才能确认节点成功、消息发送成功或任务 accepted。写失败不能像审计日志那样仅 warn 后继续宣称成功。采用同目录临时文件、完整写入、flush、原子替换与递增事件序号；写前进行 schema/version 校验，恢复遇损坏应显式 recoveryRequired，不能静默跳过关键状态。

上述 durable commit 要求适用于 persistence.enabled=true。关闭持久化时仍可在进程内使用流程与计算，但显示“仅当前进程有效，不支持重启恢复”，不宣称已有可恢复事务。messageBus.enabled=true 依赖持久态与 AgentBinding，依赖不满足时配置校验拒绝启用；其余模块不因未启用持久化而被无条件阻断。

恢复时：读取版本与 checksum → 回放完整 committed 事件 → 校对 artifact 摘要 → running/租约标记 interrupted/unknown → 由宿主能力决定是否恢复线程。当前宿主缺少 live resume 契约时默认新建专家会话，携带已审计摘要、L0 合同与待完成节点；不能自动重跑未知状态的有副作用命令。

持久化不等于永久复用专家：采用每角色/任务有限空闲线程池、上下文大小水位与过期时间。首先配置上限并计量，再选择摘要重建阈值；独立验算永远使用 fresh thread。恢复与关闭 dispose 要释放 waiter、线程引用、路由状态与邮箱订阅。

### 8.2 AgentBinding：先解决消息身份

新增 AgentBinding，由实际子会话启动事件/委派绑定推导：

~~~ts
interface AgentBinding {
  agentId: string
  rootSessionId: string
  workspaceId: string
  taskId: string
  nodeId: string
  attemptId: string
  threadId: string
  role: DelegableRoleId
  cardRevision: number
  workflowRevision: number
  permissions: string[]
  generation: number
  leaseEpoch: number
  state: 'active' | 'suspended' | 'revoked'
}
~~~

不能使用 getSession(childAgent.id) 新建“伪根会话”，也不能采信消息参数自报 senderRole/rootSessionId。身份、权限、邮箱位置由运行时绑定给出；native 后端尚不能绑定这些工具时不承诺 P2P 可用，使用原先结构化委派交付作为兼容路径并注明降级原因。

同 thread 续用于新节点/任务时，先原子撤销旧 binding，再颁发新 generation/leaseEpoch；工具要求当前 active attempt，已结束、取消或 suspended 的身份不能继续发送新消息。

### 8.3 直接文件邮箱协议

~~~ts
interface ExpertMessage {
  schemaVersion: 1
  id: string
  taskId: string
  cardRevision: number
  workflowRevision: number
  fromThreadId: string
  toThreadId: string
  senderAttemptId: string
  senderGeneration: number
  senderLeaseEpoch: number
  nodeId: string
  kind: 'question' | 'answer' | 'finding' | 'review-response'
  correlationId?: string
  createdAt: string
  expiresAt: string
  summary: string
  artifactRefs: string[]
  payloadDigest: string
}
~~~

文件放在 state/bus/inbox/<toThreadId>/<messageId>.json，由工具执行端写入，发送者不能传任意路径。每条消息独立 immutable 文件，通过临时文件完整提交；不让多个专家同时 append 一个共享 JSONL。ACK 存储在收件人独立游标/记录中，read 默认只读，显式 acknowledge 才确认消费。

默认同 root、workspace、task、当前 revision 通信；允许的接收者来自流程中存在且授权的 thread。拒绝跨任务、冒充 sender、路径穿越、过期版本和超额消息；摘要初始上限 2 KiB、封装总大小 8 KiB，大产物只传引用。消息正文属于材料，不是系统指令。

发送时检查当前 active binding；拉取时核对消息提交时有效的 binding 历史和当前任务版本，并拒绝旧代际冒用新 attempt。已合法提交的消息不会仅因发送者正常结束就全部消失；若任务改版或 lease 被撤销为不可信，标 stale 并保留审计引用。

传递语义是 at-least-once + messageId 去重；不承诺 exactly-once。发送确认必须对应已提交文件；ACK 丢失可重投，同 ID 不重复执行业务动作。重启恢复 cursor、correlation 与 ACK；无接收线程时返回 receiver-unavailable，不自动派生一个新 Agent。

首版在节点开始或检查点拉取有限批次消息，忙 thread 不重入、不抢占。不用每几百毫秒轮询，也不把一条消息当作新的节点交付。等待答复必须有期限/预算，不能持写租约等待；超时记录 unresolved 并回到控制器处理。

**零协调官中转验收：** 专家 A 发送、专家 B 拉取与回复的链路没有天枢 LLM 转述；天枢只收到引用与状态摘要。运行时仍是权限和审计层。首版不采用未核验的 sibling push 或活线程恢复能力。

### 8.4 交叉评审协议

对高风险实现与算法保留“原作者产物 → 独立评审 → 对应作者回应 → 复核修正”的路径。原作者不能审核自己的改动；首次独立评审使用 session:new 和未经作者辩解污染的输入。算衡验算初轮只接收问题合同、待检验实现与必要定义，不收研算证明过程、原结论置信度或 P2P 解释。

盲审结束且报告绑定产物摘要后，才能开放双方 finding/review-response 消息。消息里必须指出 findingId、具体反驳、证据或反例；争议留作 unresolved。不同模型家族是增加多样性的条件，不能单凭不同家族认定正确；实际模型/权限隔离不可达时如实报告。

首版 peer finding 需要导入现有御史/算衡结构化结果契约，才进入门禁判定；普通聊天消息本身不能满足或取消 gate。严重问题最终必须有当前版本修正与独立复查证据。

## 9. Markdown、数学公式和纯函数计算

### 9.1 展示与计算分开

任务说明与专家报告保留 Markdown 原文，支持标题、表格、代码块、文件/证据引用，公式采用 $...$、$$...$$ 等宿主实际支持的格式。任务卡 Markdown 固定包含标题、目标、验收、预算、文件、Mermaid、当前状态与证据索引。

0.2.0-rc.2 已有 MarkdownText + KaTeX，复用其解析和安全策略。更早宿主逐版本能力探测：不可用时显示源码与可复制文件，不未经验证宣称同等富文本体验。

Mermaid 另做 client/task-flow.js：沿用 conversation.chat.node 扩展方式，通过已认证、限制当前会话可读范围的 swarm.taskView RPC 取得结构化状态。优先从既有工具结果会话事件投影生成入口，不写任意自定义会话事件；实施前用真实宿主场景验证事件投影。若投影不可用，保留任务卡/工具结果中的 Mermaid 源码，RPC 只读详情可单独呈现。

Mermaid 展示组件懒加载、本地打包、不使用运行时 CDN；strict、htmlLabels:false，禁 diagram directives、click、任意 SVG/HTML、外部资源，设置 text/edge 限额。渲染完成前不重跑流式半截图。已经通过前置 mermaidReview 的规范源码，在客户端展示阶段解析/渲染失败可回退源码与诊断，不使已审查的任务停止；前置 parser 或投影一致性检查失败仍阻断 enforced 执行，不能把展示回退当作通过审核。

不假定当前 scripts/build-client.mjs 的文本拼装能够自动解析 npm 模块。若宿主没有 Mermaid 服务，增加最小浏览器打包步骤，只生成该组件依赖的静态 chunk；不要同时引入完整前端框架。新增依赖需锁定实际验证版本，并更新 THIRD-PARTY-NOTICES。

公式保持宿主 KaTeX trust:false；如独立预览需要自行调用，限制宏展开与尺寸、每次渲染使用独立宏表，未知命令回退源码。公式渲染和 Mermaid 解析都不触发 calculate 或 shell。

### 9.2 算子接口与边界

纯内核与工具包装分离：

~~~ts
type NumericMode = 'float64' | 'bigint' | 'rational'
interface CalcRequest {
  op: string
  version: 1
  mode: NumericMode
  args: unknown
  tolerance?: { abs: number; rel: number }
}
type CalcResult =
  | { ok: true; value: unknown; semantics: string;
      exact: boolean; inputDigest: string; operatorVersion: string;
      diagnostics: string[] }
  | { ok: false; code: 'DOMAIN' | 'DIMENSION' | 'NON_FINITE'
      | 'INPUT_LIMIT' | 'OPERATION_LIMIT' | 'DIV_ZERO'; message: string }
~~~

内核不得访问文件、网络、时间、环境变量、随机数或进程；只对显式输入运算并返回新值，不原地修改数组。延迟/资源/工具调用证据由外层记录，不写入纯内核返回值，使同版本同输入的内核输出可稳定复算。

工具包装校验角色 pure-calc 能力、任务预算、schema、规模与成本后调用内核。为天枢、算衡、复核及确有需求的分析专家开放；不能因此给算衡 shell 权限。固定 op 枚举，每个操作单独 schema，不接受表达式字符串、函数回调、代码或路径。

### 9.3 第一批最小算子集

| 操作组 | 首版操作 | 明确语义与复杂度 |
| --- | --- | --- |
| 基础算术 | add/sub/mul/div、compare_close | float64 有限数；bigint 整数；rational 有理数；除零拒绝；无隐式跨类型转换 |
| 整数/组合 | gcd/lcm、binomial | BigInt 十进制字符串；gcd(0,0)=0 且非负；lcm 含零为零；二项式仅接受 0 <= k <= n，越域明确失败 |
| 统计 | sum/mean/variance | sum 用 Neumaier 补偿求和、variance 用稳定算法；ddof 仅取 0/1、默认 0，n <= ddof 报 DOMAIN；空数组 sum=0，mean/variance 失败 |
| 向量 | dot/norm2 | 同长有限数组；dot O(n)，norm2 用缩放法处理溢出风险 |
| 小矩阵（后续显式开启） | matmul | 矩形、维度匹配；O(mnk)；乘加数先计费再执行 |
| 多项式（后续显式开启） | poly_eval | 按从常数项到最高次的 coefficients，用 Horner O(n)，空系数视零多项式 |
| 验证辅助 | residual_norm | 首版仅对显式残差向量应用 norm2；A,x,b 残差组合待矩阵算子开启，输出计算残差，不宣称算法正确 |

首期按六组交付：基础算术/比较、整数、有理数、统计、dot、norm2；poly_eval/matmul 不阻塞首期。暂缓 mod_pow、determinant/inverse/eigensolver、符号化简、积分/微分、通用优化器与随机模拟；这些功能另需数值稳定性、误差与依赖决策。先用 residual 验证算法实现，不重复建设完整 CAS。

bigint 和 rational 在 JSON 中以规范十进制字符串传输。有理数分母非零、约分、分母为正，零规范成 0/1。float64 不允许 NaN/Infinity，不把 > MAX_SAFE_INTEGER 的整数 number 误认为精确输入。非有限中间值返回错误；结果中 exact:false 明确近似计算。

bigint 的 div 只接受整除，余数非零返回 DOMAIN，绝不把 JavaScript 截断商称为精确实数除法；分数结果必须显式选择 rational。compare_close 只支持 float64；bigint/rational 的精确比较使用对应 compare，不混入浮点容差。

compare_close 定义为 |a-b| <= absTol + relTol * max(|a|,|b|)，两种容差均有限非负，必须显式声明。浮点数值结果只给算法语义与风险诊断，没有经过误差分析时不编造“严格误差界”。

compare_close 必须采用缩放或等价稳定比较，避免有限输入的差值或容差阈值溢出成 Infinity 后错误地总为 true。dot 先检查乘积是否有限；浮点重放承诺同版本同运行环境的语义稳定，不承诺不同引擎、CPU 上逐 bit 相同。整数复杂度同时计迭代与位宽，不能把每次 BigInt 运算都当 O(1)。

重放 digest 的规范化固定为对象键排序、数组顺序不变、规范整数字符串与分数、数值负零归一化为 0，绑定 op/version/mode/args/tolerance；时间和性能观测不进入纯内核摘要。float64 证据另记录 Node/V8 与数值实现版本。compare 反例 a=1e308、b=-1e308、absTol=0、relTol=0.1 必须 false。

### 9.4 初始计算限制与证据

第一版建议：请求 JSON 最多 128 KiB、每数组最多 4096 元素、每请求总标量最多 8192、结果最多 4096 标量；BigInt 每个输入最多 1024 位十进制、结果与中间整数最多 4096 位十进制，转换前先检字符串长度。二项式 n <= 1000、gcd 迭代 <= 16384；后期开启矩阵时维度 <= 32、乘加数 <= 32768；多项式次数 <= 1024。所有限制都是初始可配置保护值，需由复核压测校准。

另外限制每任务最多 64 次 calculate 调用、累计浮点元素/乘加工作量 <= 1000000；BigInt 预算单独按迭代及操作数位宽记录，并在实现注册表里为每个操作定义保守计费，初版达到单次位宽/迭代或总调用上限即拒绝，不能靠无限多小请求绕过。调用次数限额是首期保守替代，位复杂度计量尚不完整时应显示该缺口，不能宣称已做严格 CPU 用量计费。

操作注册表给出规模检查和工作量估算；同时检查预期输出尺寸与中间增长，不能只限制输入。超限直接拒绝，不转 shell、不自动放宽；小任务先在有界内核同步计算，真实事件循环延迟不合格时再使用受控 worker，不预先引入 worker 池。

每次工具计算形成 CalcEvidence，包含 EvidenceBinding、op/version、输入引用与 digest、数值模式、结果引用、exact、容差与工具侧持续时间。它证明“对该输入执行了此操作”，不是普遍数学命题证明，也不替代复核的真实 command 证据。

算衡 claims.status=proved 必须提供可审查推导或证明；有限计算只能列为 numerical_checked 证据，建议另增 evidenceType 字段，保持 proved/refuted/unverified 的原语义，不让数值测试静默升级为 proved。

## 10. 结构化性能验收与经验沉淀

### 10.1 BenchmarkEvidence

扩展复核结构化输出，让每个 benchmark 记录 metric、value、unit、sampleCount、dataScale、inputDigest、environment、warmup、methodVersion、commandRef、rawArtifactRef 与当前 EvidenceBinding。

新增数值化 PerfTarget：metric、operator（<= 或 >=）、value、unit。p95Ms/p99Ms 可直接规范化；原 throughput/dataScale 字符串保留描述，不用正则从任意自然语言猜测阈值。无法规范化的旧预算显示“待明确”，不得宣称严格达标。

预算比较由代码完成：单位匹配、样本与输入规模符合任务声明、测量绑定当前产物，延迟上限用 <=、吞吐下限用 >=。p95Ms=10 而实测 9999ms 即使 command exitCode=0 也必须阻止 G_BENCH；缺测量、不一致单位或 insufficient samples 明确未满足。

原 G_BENCH 的成功命令仍保留为必要证据，新增目标检查不能用“Jev 觉得摘要可信”替代。记录冷/热状态、机器配置与峰值 RSS，避免拿不同数据规模比较数字。

### 10.2 经验库

经验条目包含 id、problemClass、适用/不适用条件、结论、来源 task/revision/artifact、验证方式、counterexamples、模型/工具版本、reviewer、status(candidate/validated/deprecated)、expiresAt。只保存可复用事实与方法，不保存凭据、整段私有对话或未经审查的用户数据。

accepted 任务仅自动产生 candidate；复核证据齐全且没有未解决严重问题，独立评审确认适用条件后才晋升 validated。失败案例可沉淀为“此条件下不成立”的反例，不能写成通用原则。

首版使用文件索引、关键词与 problemClass 检索，最多返回三条当前有效条目摘要与引用。不引入向量数据库，也不让经验绕过门禁、覆盖用户约束或自修改工具权限。用户改任务合同、依赖/工具版本变更或新反例出现时标 stale/deprecated 并显示原因。

## 11. 分阶段实施清单与代码落点

每一阶段均先写对应实现测试，再完成最小代码改动；不要为了纯文档修改新增产品测试。生成预设通过 scripts/gen-presets.mjs，不能手改 presets/*.patch.yml。

| 阶段 | 改动内容与文件 | 必须交付的验证 |
| --- | --- | --- |
| P0-R：额度耗尽立即回退（优先） | 修改 src/routes.ts、src/route-state.ts、src/runtime.ts、src/delegate.ts、src/host-contract.ts、src/config.ts；新增 src/provider-policy.ts、src/route-health.ts；核验并适配宿主 retry 协作，配置/客户端显示资源类型与真实切换 | quota/pool/余额原路由重试 0 次；9060669 ms 无等待；宿主 always 与外层重试不可绕过；共享故障域及恢复；全部备用不可用正确终止 |
| P0：基线与合同 | 保存当前工作树；核验宿主事件/usage/线程能力。修改 src/policy.ts、src/evidence.ts、src/service.ts、src/contracts.ts；新增 src/workflow.ts、src/artifacts.ts | 任务改版旧证据失效；预算有限合法；文件摘要；旧任务输入兼容；超预算 benchmark 被挡 |
| P1：有界流程与生成后审核 | 扩展 src/tools.ts、src/delegate.ts、src/contracts.ts、src/host-contract.ts；新增 src/planning-review.ts、src/checkpoint.ts、src/execution-budget.ts、src/util/workspace-lease.ts；交付官方 Mermaid parser 的锁定依赖/宿主适配；更新角色与配置 | 目标/流程设计/源码三项分别审核，parser 实际通过、需求映射、独立 Agent/Jev、requireJev、审核失效、request 去重、非 Jev 预算和修复上限 |
| P2a：披露与 Jev | 新增 src/context-store.ts；扩展 src/jev-hub.ts、src/jev.ts、src/jev-tools.ts、src/review.ts、src/config.ts；关闭 Jev 主动限流，接入 usage 和尝试级指标 | 同状态缓存、版本失效、Jev 不受 RPS/并发/全局预算拒绝，所有入口一致；缺密钥/429/超时处理与 unknown 观测 |
| P2b：恢复与 P2P | 新增 src/state-store.ts、src/message-bus.ts、src/agent-binding.ts、src/collaboration-tools.ts；扩展 threads/service/delegate/host-contract | 原子提交、损坏恢复、未知副作用不自动重跑、越权拒绝、ACK 去重、盲审隔离、无天枢正文中转 |
| P2c：纯函数数学 | 新增 src/math/operators.ts、src/math/schema.ts、src/math/limits.ts、src/math-tools.ts；扩展 contracts 与 capability 目录 | 精确算术 oracle、数值差分、性质测试、输入不变、非有限值、复杂度上限与事件循环基准 |
| P3：展示与经验 | 新增 client/task-flow.js、src/experience.ts；扩展 src/rpc.ts、src/index.ts、scripts/build-client.mjs、package.json、locale、docs 与第三方声明 | Markdown/公式复用、Mermaid 懒加载/源码回退、RPC 会话隔离、经验晋升/失效；真实宿主浏览器验证 |
| P4：评测与试点 | 扩展 docs/评测.md、tests/fixtures/eval-tasks.example.json，新增 scripts/bench-workflow.mjs；完成新配置示例 | 同任务对照评测、完整 token/费用/延迟、质量与权限回归；再决定默认开启范围 |

P0-R 与 P0 为首批前置工作，完成后进入 P1；P2a、P2b、P2c 依赖合同与绑定设计，可以分工作区并行开发；P3 的结构化显示可以先于 P2b 完成，但不能先显示尚不存在的恢复或 P2P 成功状态。P4 的埋点和基线采集在 P0 开始，最终对照在全部试点功能完成后进行。

新模块职责保持小而具体，service.ts 只编排，workflow/math 为纯逻辑，store/bus/lease 为 I/O 边界；不把所有新代码塞入已有 service.ts，也不创建第二个全局协调服务。

### 11.1 配置与兼容

增加 workflow.mode: off/advisory/enforced、workflow.defaultTemplate、planningReview.enabled（新流程默认 true）、planningReview.requireJev（默认 false）、planningReview.maxFixRounds（初始 2）、execution.profile、executionBudget、contextPolicy、persistence.enabled、messageBus.enabled、math.enabled、experience.enabled 等配置，但以小分组暴露。升级既有 profile 时：workflow 默认 advisory，persistence/messageBus/experience 默认关闭；math 可试点启用。新 flow/schema 显示为派生信息，保留所有原工具字段与旧配置。workflow=off 时保留原调度，不宣称已通过新审核；enforced 配置不能同时关闭 planningReview。

enforced 必须在能力/兼容测试通过后开启，此时 node_id 和 expected revision 强制要求，旧入口由明确 legacy adapter 转换，不能静默忽略。无对应宿主能力时声明降级为源码展示/一次性会话/原委派返回，不暗示完整协作。

切换到 enforced 前必须没有未结束的旧模式 attempt；若仍在运行则返回 mode-switch-pending，不将其结果悄悄解释为新模式证据。图中新增约束和验收矩阵按 §4.5 的模式边界执行。

不要一次改变包导出或引入多套 Agent preset。工具 capability 必须在 src/host-contract.ts 与 role-registry 中同步，未知工具和 preset-scoped tool 的宿主约束通过真实集成测试核验；API spawn 与 native 后端分别验证，不能凭 API 路径通过就宣称 native 同样受控。

### 11.2 回滚

功能旗标可关闭展示、邮箱、经验与计算；版本/证据与预算准确性修复应保留。旧配置不被删除。持久态带 schemaVersion 和 reader 兼容边界，旧代码遇到未知恢复版本只读拒绝恢复，不吞字段或覆盖数据。

回滚前停止新节点、等待或取消当前 attempt、保存检查点并释放 owner/工作区租约。保留 artifact 与状态文件供审计，不自动删除经验或用户材料。关闭邮箱后未确认消息标停用，不能继续后台唤醒线程。

## 12. 验证矩阵与发布验收

| 场景 | 必须观察到的结果 |
| --- | --- |
| 旧 task_card 输入不含 workflow | 正常建立任务，自动返回合理 Mermaid 和当前门禁，不破坏原字段 |
| 图符合任务卡但任务卡曲解用户需求 | 独立审核对照原始需求发现错误，不能因为卡与图一致就 pass |
| 合法 Mermaid 漏一个验收要求/顺序不合理 | 精确结构检查加语义审核标出 requirement/acceptance/node；语法通过不能代替规划正确 |
| 流程设计正确但 Mermaid 括号/引号/节点引用错误 | mermaidReview parser 失败或投影失败，给出位置，不被 Agent/Jev 高分覆盖 |
| Mermaid 合法但依赖箭头反向/节点标签曲解需求 | 源码投影与 designReview 分别核对，错误不能以 syntax pass 通过 |
| Agent/Jev 只读同一快照 | 首次判断彼此不可见、Agent fresh，会话和实际模型可追溯 |
| Agent 指出严重问题而 Jev 高概率通过 | 不能放行，保留发现并返修 |
| Jev 存疑或不可用 | 定向独立复核或按 requireJev 明确降级/阻塞，不伪造双审完成 |
| 审核通过后改目标、预算、依赖或门禁 | 审核 stale，enforced 执行前必须重新审当前快照 |
| 只改变图的颜色或当前节点状态 | 复用同一语义审核，不追加 Agent/Jev 费用 |
| 修改 workflowRevision 反复重试规划 | 返修计数不重置，总预算持续累加，达到上限明确阻塞 |
| 修改目标/验收/perf 但未改源码 | revision 递增，旧 accepted 与门禁证据 stale，续会话收到新合同 |
| 删除门禁节点/加环/错误依赖/角色冒用 | 非法图保存被拒绝；enforced 执行拒绝，advisory 仅记录流程偏离；原权限仍强制 |
| 算法图研算存在但位于实现之后 | 图不合法，enforced 实现不能提前运行 |
| 直接跳到验收/复核前实现未结束 | enforced required 节点与所有模式原硬门禁阻止错误验收；advisory 不增加 DAG 阻断 |
| 执行中新增 effective gate | 自动补图与依赖、workflow 改版，新增门禁未完成前不能验收；旧 running 结果按映射或 stale 处理，不重复编辑 |
| 同一 request_id 重试、并行提交同节点 | 只有一个有效 attempt，预算与结果不重复消费 |
| 同工作区不同根会话编辑与验证 | 租约串行且不死锁；只读探索仍可并行 |
| 验证时外部/shell 改文件 | 起止或验收 digest 不匹配，证据 stale，不报告通过 |
| 复核 exit0 但 p95 超目标 | G_BENCH 未满足，显示目标、实测、单位与输入规模 |
| 同一问题多轮失败 | 达到 maxAutoFixRounds 或无进展策略后记录未完成，不能隐性续开修复 |
| Jev 无密钥/429/5xx/超时/上游配额错误 | 服务原因明确，requireJev 严格/降级规则正确，成本可追踪；不报告本地额度耗尽 |
| pool claude-opus-5-5 exhausted + providerRetryAfterMs=9060669 | 配置合法备用时立即换路由，原池重复重试 0 次、不排长等待；底层原因未知如实记录 |
| 订阅 QUOTA/计划用尽或按量 API 402 | 故障域隔离，直接回退，不走网络等待或同路由指数退避 |
| 429 为短时限速/429 为计划额度用尽 | 分别执行有界短重试/立即回退；不只按 HTTP 状态猜测 |
| 备用全部不可用，宿主 always 或专家重启仍想 retry | 统一 terminal 标记，明确未完成，无同路由返回重试和无限外层重启 |
| 长 Retry-After 超短重试窗口 | 路由隔离并回退，不截短后违反服务端恢复时间 |
| 根固定 10 分钟恢复或专家 AddChild 重登记 | 仍跳过未恢复额度域；只有真实恢复依据才能解除 |
| 回退到同一模型的其他独立账号/不同能力模型 | 核对真实 quotaDomain 和 capabilities，不重复同域、丢图像或破坏输出合同 |
| Jev 并行调用或跨任务/session/global 预算耗尽 | 无主动 RPS/并发额度排队，Jev 有效请求不被非 Jev 上限拒绝；全入口共享无节流策略 |
| 旧 Jev RPS=8 或新 RPS=0 | 迁移为实际不限，0 不退化成 1 RPS；设置页说明与真实路径一致 |
| 非 Jev 请求发出后取消再重试/并发预留 | 已发送尝试不退还，未发预留才释放；不能超额发出受专家预算约束请求 |
| Jev 同状态重评/任务改版 | 前者可复用；后者缓存失效；题义变更也失效 |
| P2P 专家问答 | 文件直接送达、关联清楚、正文零天枢 LLM 转述；消息不能满足 gate |
| P2P 伪造 sender/跨任务/路径穿越/过期/刷消息 | 插件接口拒绝；配额及拒绝原因入状态 |
| 同版本下旧 attempt/旧 binding 发新消息 | generation/leaseEpoch 检查拒绝；合法已提交消息按绑定历史核验 |
| ACK 丢失、重复消息、进程重启 | 可重投但按 ID 去重；不重复副作用；损坏或无法确认状态显式恢复失败 |
| 盲审验算请求研算过程 | context/message 层拒绝；初轮报告后才允许有证据的争论 |
| 重启时旧线程无法 resume | 新建线程加载检查点，running 标 interrupted，未知副作用不自动重放 |
| 取消后未确认原生后端停止 | workspace mutationUnknown，不能重新授予写租约或重复运行 |
| 小改意外触及算法/多模块 | 升级流程与版本、增加硬门禁，保留已产生的产物引用 |
| 精确算术与浮点边界 | BigInt/rational 对独立 oracle；float64 对稳定参考；除零/非有限/维度/超限正确失败 |
| bigint 1/2 或极值容差比较 | bigint 非整除 DOMAIN；float64 极值不会因 Infinity 比较错误通过 |
| 旧预算 0 或自定义修复轮 | 显示“不限”或实际配置值，模板不硬编码覆盖配置 |
| Markdown/公式/Mermaid 无效或恶意材料 | 原文仍可读，unsafe 协议/指令不执行，失败不阻塞执行状态 |
| 经验候选含未解决反例 | 不晋升，不注入常驻提示；已验证经验遇新反例失效 |

实现阶段运行 npm run typecheck、npm test、npm run build；涉及生成器时 npm run gen:presets 后检查差异；涉及宿主工具/线程/RPC/客户端时 npm run test:integration，覆盖 package.json 声明的最低宿主和当前 0.2.0-rc.2。现有 integration driver 扩展明确场景，不只写模拟实现的单元测试。

数学差分参考优先采用独立标准库 oracle（如 Python fractions、math.comb、math.gcd），不把同一内核的另一层包装当独立验证；可选测试依赖不加入生产依赖。浮点性质测试使用显式容差，不断言结合律精确成立。包含极端量级、抵消、近零、样本 ddof 与不规则矩阵。

## 13. “约 28% token 节省”的验证方案

本方案不采信未经本项目测量的节省比例。以**当前工作树已有续会话、省略 brief 和 Jev 机制**为 baseline，而不是拿完全无优化的系统对照。

采用至少 20 个代表性任务，覆盖小改、探索、架构、状态/并发、算法/数值、恢复与故障任务。固定任务集、宿主版本、实际模型路由、缓存条件、数据输入、验收标准及预算；每个任务每组至少 3 次独立运行，随机化组间顺序，使用隔离工作区避免前次产物影响。

记录天枢、各专家、Jev、消息上下文、恢复摘要、重试的完整 usage，并区分 input/output/cached tokens 与服务费用。不能把字符数近似转换当实际 token，也不能直接把不同供应商 token 相加解释为等价成本。跨供应商同时报告逐提供商 token、价格配置来源、美元/人民币费用及 unknown 部分。

~~~text
saving = 1 - T_new / T_baseline
~~~

T 口径必须先固定，分别报告同模型口径、每任务总使用量和费用；单任务 baseline 为 0/unknown 时不给节省比。Jev 或宿主不返回 usage 时明确观测不完整，不能声称验证了全链路 28%。

同步比较实际验收通过率、严重缺陷逃逸、任务跑题/重复委派、恢复正确率、P50/P95 总耗时、活动与等待时间、峰值 RSS、控制器开销与图渲染开销。bootstrap 按任务聚类给区间，避免把同一任务的重复运行当独立任务。

先做消融：仅版本/图与自检、再加披露、再加 Jev 缓存、再加 P2P/持久化，定位收益与新增开销。若平均节省达到约 28% 但尾部成本、缺陷或验收质量恶化，不能判为优化成功。试点达标条件为确定性合同测试全部通过、严重缺陷逃逸不增加、验收质量不退化；token/延迟收益如实报告，不设无数据支持的宣传数字。

初始性能建议是控制器与小算子不能明显阻塞事件循环、流程渲染只在 settled 状态更新；P95 数值门槛在目标硬件采集 baseline 后写入 PerfTarget。所有本文件未实测性能数值均是初始策略或待测目标。

## 14. 本次设计核验与实施范围

本次完成：当前代码与沙箱宿主类型核查、三个专家的正反交叉讨论、官方 Mermaid/TypeSafe/KaTeX 文档核验，以及本方案文档交付。

本次没有运行新产品功能或真实插件评测，不能据此声称流程调度、持久恢复、P2P、算子或 28% 已实现或已验证。后续文档检查与本次 Jev 辅助核查结果记录在本节之后；这些检查只验证方案的一致性，不证明运行实现正确。

## 15. 外部依据

以下官方资料于 2026-10-07 核验；实现时仍需锁定实际依赖版本。方案中的具体系统设计、预算和性能目标是本项目的工程选择，不是官方文档给出的保证。

- [TypeSafe 文档索引](https://docs.typesafe.ai/llms.txt)：发现当前 primitives、SDK、cookbook；本文遵循代码掌控执行、模型提供窄语义判断的边界。
- [TypeSafe Confidence](https://docs.typesafe.ai/confidence)、[Noul](https://docs.typesafe.ai/primitives/noul)：区分 Choice/Score 集中程度与 Noul yes 概率，阈值需本领域校准。
- [TypeSafe Citation Check](https://docs.typesafe.ai/cookbooks/citation_check)：支持围绕具体证据设计单项核查，不能代替数学证明或确定性预算检查。
- [Mermaid 配置 schema](https://mermaid.js.org/config/schema-docs/config.html)、[程序化用法](https://mermaid.js.org/config/usage.html)：strict、secure 配置、文本/边数限制与 parse/render 能力；Mermaid 只负责可视化。
- [KaTeX 安全](https://katex.org/docs/security.html)、[选项](https://katex.org/docs/options.html)：公式展示限制采用 trust、展开与尺寸控制；既有宿主组件优先复用。
- 另通过 Context7 的 /mermaid-js/mermaid 核对官方仓库 docs/config/usage.md 与配置示例；未采用第三方教程作为执行契约。
- 额度/回退补充依据：[DeepSeek 错误码](https://api-docs.deepseek.com/quick_start/error_codes/)、[Claude 用量与上下文限制](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work)、[OpenAI Docs 用量与计费](https://learn.chatgpt.com/docs/pricing)、[OpenCode Go 用量限制](https://opencode.ai/docs/go/)、[Qwen Coding Plan](https://www.alibabacloud.com/help/en/model-studio/coding-plan)。核验仅用于资源分类，不固化各订阅的次数、价格或恢复周期。

## 16. 初版设计审查历史

初版交付时，三位专家完成互相驳斥和草稿复查；关键修正已并入 §3–§12。当时静态检查确认 9 个代码块闭合、3 个 Mermaid 源码示例具备完整节点引用、17 项需求词覆盖，且检查的 10 个源文件/配置摘要与既存 Git 工作树状态未变。本节为补充要求前的历史记录，不代表本轮新增内容已在当时审核。

另实际调用 Jev 对本方案正文做七项窄判断：需求覆盖、单一流程真源、证据版本、观察/强制模式、取消预算、数学边界、未实测声明。模型为 jev-1.13.0，七项 yes 概率为 0.97–0.98，没有不确定标记；耗时 3888.91 ms，工具返回 input_tokens=22830、output_tokens=136。该概率仅是文档辅助审核信号，不是代码、数学或性能通过证明；本次调用没有验证插件内部 JevHub 的运行链路。

初版审查正文 SHA-256：9ada09cc47132ae58103aa4a78d8d2cbfb2fdfd705d0cc1f7ad4671bf18faa19；它是旧快照，不是当前正文摘要。机器记录的 revisionHistory 保存该次审核，当前摘要与本轮结果见 [审查记录](2026-10-07-tian-shu-workflow-and-verification.review.json)。

初版尚未运行 Mermaid 官方 parser 或浏览器渲染，也未运行新功能产品测试；其通过范围仅是源码结构、需求覆盖与设计审查。本轮已新增官方 parser 检查，记录如下；真实渲染、实现、恢复、计算与 token 收益仍按 §12–§13 验收。

## 17. 生成后审核与 Jev 无限额策略的审查历史

本轮按用户补充更新 §4.6 的目标/流程设计/Mermaid 源码三项审核，以及 §7.3 的 Jev 无插件侧限流、无调用数/token/费用额度。工程反方复审后结论为“可通过”，并要求明确展示回退不能覆盖执行前 parser 失败、结构错误修正轮耗尽必须终止；两项已修正。

四个当前 Mermaid 示例实际通过 mermaid 11.12.0 的 parse，使用临时目录中的 jsdom 26.1.0 适配；故意未闭合引号/括号的负例被拒绝。临时验证依赖未写入产品 package.json/package-lock.json，也没有执行浏览器渲染；语法通过不等于任务设计或运行实现已证明正确。

另对当前正文独立执行 Jev 八项文档核查，未向 Jev 提供本轮 Agent 结论。模型 jev-1.13.0，yes 概率范围 0.81–0.98，八项均被工具标为成立、无不确定标记；耗时 3163.431 ms，input_tokens=29804、output_tokens=152。这是设计文本的辅助信号，不能代替目标语义、数学或产品运行正确性证据。

该次受审正文 SHA-256：1c95a95239f0f573a44601dafff131b70b06acd2acbfb3708573926d9da21c67，为额度回退补充之前的旧快照。其原始结果保存在审查 JSON 的 revisionHistory；当前文档与新增要求的核查如下。上述能力仍须按实施清单落地。

## 18. 额度耗尽回退要求的本次更新记录

本次新增 §7.5 与 P0-R、资源类型/错误合同、立即回退路径、共享额度故障状态、短时重试边界、native/宿主协作要求，以及验收矩阵中的用户原始失败案例。核查当前 runtime、route-state、delegate 和沙箱 llm-retry 源码发现需要重点验证的等待顺序及外层重复重试路径，未据用户的一条日志推断全部实际故障来源。

核验了 DeepSeek、Claude、OpenAI Docs、OpenCode Go、Qwen Coding Plan 官方资料；不将按量 API 描述成永不限速/永不缺余额，也不固化各订阅的窗口与额度。Jev 无插件侧限流/使用额度的用户偏好持续适用。

本次 Jev 仅对新增路由条款与 Jev 政策做七项辅助核查，模型 jev-1.13.0，工具将七项标记为成立，yes 概率范围 0.78–0.96。叠层重试收敛项为 0.78，低于 §4.6 的试点阈值 0.8，因此保留“必须以真实宿主/原生后端验证避免重试循环”的实现门槛，不据模型评估宣称运行修复已完成。其余原始概率、用量与延迟保存在审查 JSON。

受审正文（§16 之前）SHA-256：ef0efeedafc2f9d7975745cb0bad2ac26be253234ae087f00df7acae10e81c25。本次修改范围仍是方案与审查记录；产品代码、配置及运行中的重试等待未在本次改动。Mermaid parser 检查覆盖现有五个示例，包含新增回退流程，具体源码摘要与检查结果见审查 JSON。

## 19. 实施交付记录（2026-10-08）

§14–§18 是 2026-10-07 的设计阶段历史记录。本次按用户后续授权实施，产品版本更新为 2.2.0；代码、测试、依赖、客户端、配置示例与生成预设均已变更。审查 JSON 保留原设计审计快照，当前实施证据另行绑定，不能将旧设计评分当作新代码批准。

| 阶段 | 本次交付 |
| --- | --- |
| P0-R | 公共模型错误路径在宿主 next/长退避前识别终态；共享额度域、立即回退、备用耗尽终止、短时临时重试与有限逻辑尝试；健康态先持久提交再返回恢复动作 |
| P0/P1 | 唯一 DAG 真源与 Mermaid 投影、需求/合同/流程版本及文件摘要；生成后官方 parser、独立只读新御史与 Jev 三维审核、严格/明确降级、CAS/请求幂等、每轮回顾与数值性能验收 |
| P2a | L0/L1/L2 引用与分页、改版重新披露、按模型家族的近距离角色/任务/格式引导、简单任务快速流程；所有 Jev 入口移除本地 RPS 与使用预算 |
| P2b | 原子持久状态、专家线程/身份代际、未知副作用恢复屏障、真实工作区租约、P2P 文件邮箱/ACK；先盲审后冻结回应，回应不替代初审门禁 |
| P2c | 有界纯函数 float64/bigint/rational 六组算子；多项式/矩阵/残差扩展开关，稳定容差与补偿计算；computed 与证明分离 |
| P3 | DSH Markdown/KaTeX、本地 Mermaid、缩放/源码/刷新/诊断、分别显示三维审核及节点/需求位置；经验候选依据实际独立审查和复核证据晋升 |
| P4 | 完整单元/覆盖率与真实 Cordis/Retry/AgentLoop 集成、浏览器组件验收、20 类控制面与6类计算基准、20个在线待评测样例及用量导入；完整在线质量/token对照试点仍待真实账号能力 |

真实宿主新增规划双审集成发现并修复两项 mock 未覆盖的问题：`maxDepth` 为绝对子代理深度，审核 Agent 应设 1；DSH 技能目录和子代理通知也可使用 user role，原始需求只取人类来源消息，避免审核提示目录而遗漏用户目标。后续同 ID 编辑消息也按摘要递增需求版本，并在运行中专家每次工具调用前失效旧授权；需求版本同时进入上下文、消息与证据绑定。

实际整数保护比 §9 建议更保守：输入/输出各 4096 bit，中间值 8192 bit；保留 JSON 128 KiB、数组 4096、总元素 8192、矩阵维度32/乘加32768、多项式次数1024。数值范围与性能边界属于可检查合同，不由模型概率裁决。非 Jev 预算缺可信 token/费用估计时明确拒绝正上限配置，在线改限额保留已消费记录；Jev 不受这些拒绝条件影响。

具体最终测试数量、覆盖率、源码摘要、原始初期 Jev 辅助结果、审批阻断与浏览器图片见 [实施报告](../../evidence/implementation-2026-10-07/README.md) 和 [实施清单](../../evidence/implementation-2026-10-07/implementation-manifest.json)。使用与开关见 [任务流程与验证](../../任务流程与验证.md)。

保留的验证边界：原生 Codex/Claude 内部重试与外部写进程停止未验证；多数 prepareCall 异常绕过宿主 request-error，需要正式恢复接口才能扩展覆盖。完整物理 HTTP 计费/生成模型用量、完整浏览器认证链、NFS 掉电与任意 shell 的 OS 隔离不在本次通过范围。实际完成了初期 Jev MCP 摘要判断；最终追加调用被审批策略拒绝（需要批准但策略为 never），已记录原始错误，未绕过或伪造通过。28% token 节省没有测得。
