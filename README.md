# dsh-agent-swarm

[中文](#中文) · [English](#english)

---

## 中文

DeepSeek Harness（DSH）的多智能体插件：「天枢」主持 12 位中文专家（谋定、枢机、算衡、探微、博闻、观象、铸剑、行舟、疾风、御史、复核、妙笔），用任务卡、门禁和真实证据决定是否验收；模型路由按你的订阅配置多层回退，故障时立即切到可用备用，最后一个可用模型短时故障时在预算内等待恢复。

- 适配 DSH **0.2.x**（`>=0.2.0-rc.2 <0.3.0`，推荐 0.2.1-rc.3）与 Node.js 22.12 及以上
- 新建会话选「百工模式」即可使用；Jev API key 可选

### 3.1.7 的变化

- 本版是审计与稳定性版本：修复门禁、状态恢复、授权等待、路由恢复与 Jev 端点的正确性问题，并移除从未接入运行时的进化治理任务视图与只读面板。
- 验算门禁只认标注 `proof` 的已证实结论；复核里任何失败命令都会否决之前的通过；性能验收只接受最后一次编辑之后的最新测量，验收复评读取最近的委派。
- 状态恢复会丢弃日志末尾未确认的半条记录；授权准入按需释放、已答复的旧决定按需回收，critical 结算失败会在下一次进入时受控对账；长任务的在途等待不再累加到上限而把任务判为耗尽。
- 所有 Jev 直通工具发送前替换常见密钥格式，复评脱敏改为线性匹配并整体替换认证方案与组合凭据；非 https（本机回环除外）的 baseUrl 会被拒绝；`approvals=deny` 覆盖写入或命令时，原生 Codex/Claude 委派改走 API 并记录原因。
- 控制面板轮询不再清掉失败提示，推理强度变化不再误报为切换模型；移除不可用的 `maxTokens` / `maxCostUsd` 配置。
- 公开仓库 main 恢复“仅插件”形态；3.1.6 的全部修复已并入本版（3.1.6 未单独创建 GitHub Release）。

### 3.1.3 的变化

- 百工设置按五类选项卡组织，备用模型链支持拖拽、按钮和键盘排序。
- 修复订阅耗尽与人工换模竞态，恢复委派会重新取得当前任务的执行身份。
- 真实用户问答进入可恢复等待；服务端验收凭证与全历史结构守卫阻止无证据完成和重复空转。
- 适用范围与存储兼容保持向后兼容；内部实施记录只在源码仓库的 GitHub 历史中维护。

### 3.1.2 的变化

- 原生“任务进度”Tab集中六个图表视角，按需查看任务、版本、节点状态和证据流；rc.3窄屏可从“更多视图”进入。
- 聊天与Tab共享只读读取，支持取消、过期提示、连接隔离和失败恢复；关闭视图不停止长期任务。
- 技能/工具候选保留来源与隔离元数据，不能通过文本复核激活或自动执行。
- 吸收 Ruflo 的工作区、只读投影与来源化候选设计；内部迭代记录不进入发布包。

### 3.1.1 的变化

- 规划审核会话识别为百工子会话，实际模型由宿主请求记录展示；模型与恢复面板区分实际调用和后续选择。
- 一次性审核可选择下一请求模型，当前请求不中断；连续专家保留取消、沉寂确认和安全继续流程。
- 失效上下文引用返回当前任务授权索引，重新选择 ref/digest 即可继续读取；不恢复旧版本权限。
- 文件发现支持相对子目录、有界索引与输出；宿主搜索容量溢出和 Fetch 404 保留原错误并说明恢复方式。
- 已复核经验的适用条件参与有界检索；自我进化按发布说明分阶段提供。
- 真正需要人工决定时，天枢调用 `ask_user_question`，不以重复思考代替授权交互；未答复不表示同意。

### 3.1.0 的变化

| 变化 | 说明 |
|---|---|
| **长会话不再从某条消息后整段消失** | GitHub Issue #1：`swarm-model-call` 在分页或长会话的事件窗口缺少 `request/header` 时不再从 `start()` 返回 `undefined`。它返回继承上一状态的隐藏占位，渲染层丢弃该节点，宿主事件订阅器不会中断；下一条调用也不会误报「切换模型」。普通会话同样受保护。 |
| **thinking 协议错误不再重复命中** | DeepSeek 返回 `The content[].thinking ... must be passed back` 时归类为 `protocol_incompatible`，当前请求立即回退并隔离该路由，避免同一会话反复调用同一不兼容模型。 |
| **目标受阻时给出可执行恢复处方** | `swarm_status` 新增 `blockedRecovery`：区分协议不兼容、路由耗尽、规划服务故障、连续无进展、缺门禁和验证缺口，给出推荐角色与下一步。天枢按处方最多做一次只读诊断或对应专家修复，不靠重复改卡、重复评分或重放业务写入恢复。 |
| **pnpm 11 本地 tarball 安装说明** | 使用 `minimumReleaseAgeIgnoreMissingTime: true`，只跳过 registry 中没有发布时间信息的本地包；`minimumReleaseAgeExclude` 只接受精确版本，不能写 semver range。 |
| **原生 Agent Team 只读镜像（默认关闭）** | 启用 DSH 原生 Agent Team 后，可在会话头部查看已有成员、共享任务、实时状态、owner、依赖和写入范围，并打开成员会话。镜像不创建成员、不修改共享任务、不调用 `spawn_teammate` 或原生 `complete`；百工仍是唯一任务、证据、租约和执行控制器。 |
| **本地 tarball 可直接 link 安装** | 新增 `scripts/install-profile.mjs`，校验并解包发布包后以内容摘要目录和 `link:` 接入 profile，避免 pnpm 回查未发布的 registry 版本。四层自我进化仍只提供分阶段路线，3.1.0 不自动修改提示、工具或工作流。 |

### 3.0 的变化

| 变化 | 说明 |
|---|---|
| **铸剑等专家不再频繁「路由链耗尽」** | 链上没有可切换的模型时，最后一个可用模型的网络/服务端/限流类临时故障按 5 秒起、封顶 60 秒退避重试；其他模型被隔离但即将到期、或正由其他专家探测恢复时等它。发起请求时共用的订阅路由刚被另一位专家的失败隔离，也在预算内等待，不再直接失败。等待与断网等待共用每个请求的 `agents.networkWaitMs` 预算（默认 10 分钟，每个请求最多等 32 次），用尽才结束，并在结果里列出每条路由的状态；等待期间人工换的模型醒来后照用。订阅模型池以 `AUTH` 报告的耗尽按认证失效处理，其他 `AUTH` 按状态码细分；池与认证冷却按宿主恢复时间隔离（至多 30 分钟重探）；重新登录或普通目录/配置更新不会使隔离提前到期。登录后等待冷却，或在已有「模型与恢复」面板请求受控重试；重试仍按策略判定，不能绕过供应商 `resetAt` 或他人持有的半开探测。 |
| **按设置的语言输出** | 每个预设都带 `- **Language**: 强制使用{$language}回答与思考（代码、变量名、命令、路径与专业术语保持原文）。`，运行时替换成「设置 → 百工 Agent」里选的语言，并在系统提示末尾追加用该语言书写的要求；换模型后照样生效。DSH 0.2.1 起专家子会话与原生 Codex / Claude Code 后端也使用按语言生成的委派 persona。已有探测中最终回复按设置语言输出；尽管语言要求已注入，DSH 显示的可见推理仍可能为英文，不能保证其始终遵循设置，见 [docs/使用.md](docs/使用.md#输出语言)。 |
| **工程规范写入全部角色** | 不过度工程化、不过度精简、不盲目重构、安全第一、异常带上下文日志、每项改动附可执行验证；铸剑/疾风另有 C.T.I.V. 流程、命名与测试要求，行舟/复核有终端安全规则，御史按四个维度和固定模板审查。 |
| **任务卡不再因流程草稿被打回** | 天枢给的流程草稿缺少必需门禁（例如资金逻辑要求的 `G_MATH_VERIFY`）时由宿主自动补齐节点，不再报「workflow 缺少必需门禁」；与门禁顺序冲突的草稿依赖被绕过，其余业务先后保留。 |
| **观察模式不再自动规划审核** | 一次长期目标实测中，自动审核耗时与全部专家执行相当且 94 次只通过 2 次；现在只在强制模式自动审核，观察模式按需调用 `swarm_review_plan`。 |
| **规划审核设置可视化** | 「设置 → 百工 Agent → 任务流程与规划审核」可改流程模式、自动审核、`requireJev`、修正轮数、通过阈值与 `planningReview.timeoutMs`（默认 0 不限，正整数毫秒为显式上限，非法值拒绝）。 |
| **长期运行更稳** | 模型错误不再暂停持久专家（取消、打断、回合被拦下仍暂停），续跑期间不提供会打断自动恢复的「继续」；写入正常完成先等本委派登记的宿主后台作业收尾，取消时请求停止并等待确认。结束或释放通知只触发重查，未确认副作用仍保留租约阻断；不保证宿主未跟踪或逃逸的系统进程已经停止，详见 [任务流程与验证](docs/任务流程与验证.md#执行与协作)。 |
| **代码精简** | 移除死代码与重复实现，移除 PRD、规划与证据类文档和一次性脚本。 |

### 安装

装好后重启 DSH（systemd 托管时：`systemctl --user restart dsh-web.service`）。

- **插件市场（dsh-market）**：搜索 `dsh-agent-swarm` 一键安装。
- **预构建包**：
  ```sh
  dsh plugin --profile <profile> add https://github.com/zhairy/dsh-agent-swarm/releases/latest/download/dsh-agent-swarm.tgz
  ```
- **从源码**：
  ```sh
  git clone https://github.com/zhairy/dsh-agent-swarm.git && cd dsh-agent-swarm
  npm install            # prepare 会构建 lib/
  dsh plugin --profile <profile> add "$(pwd)"
  ```

模型 provider、Jev、原生 Codex / Claude Code 与 dsh-llm-fallbacks 共存的设置见 [docs/安装.md](docs/安装.md)。

### 使用

在「百工模式」会话里用自然语言描述目标和验收条件，天枢会：

1. `swarm_task_card` 建任务卡（目标、验收、范围、风险标志、性能预算），生成 Mermaid 流程；规则与衡鉴（Jev）给出硬门禁。
2. `swarm_delegate` 把自包含的子任务交给专家：自动选择模型路由、限制工具权限、校验结构化交付，衡鉴复评交付可信度。
3. `swarm_status` 查看门禁、证据与路由；`swarm_accept` 逐项核对证据后验收，缺证据返回 `blocked`。

另有 7 个 Jev 判断工具（`jev_check`、`jev_classify`、`jev_score`、`jev_match`、`jev_screen`、`jev_ask`、`jev_health`）和 `jev-judgments`、`typesafe-ai` 两个技能，在插件内直接调用，不需要外部 MCP。详见 [docs/使用.md](docs/使用.md)、[docs/角色.md](docs/角色.md)、[docs/任务流程与验证.md](docs/任务流程与验证.md)。

| 委派结果与专家会话 | Jev API key | 专家会话与重试 | 模型设置 |
|---|---|---|---|
| ![委派结果](assets/screenshots/delegation-result.png) | ![Jev API key](assets/screenshots/jev-api-key.png) | ![会话策略](assets/screenshots/session-policy.png) | ![模型设置](assets/screenshots/models-seting.png) |

### 设置 → 百工 Agent

| 卡片 | 写入 swarm-core | 内容 |
|---|---|---|
| Jev 模型 API Key | DSH 凭据存储 | 保存、清除、测试连接；密钥不写入配置文件 |
| 百工工具审批 | `approvals` | 继承宿主 / 请求审批 / 拒绝，按写入、Shell、外部 MCP、Jev 工具选择作用域 |
| 专家会话与重试 | `agents` | 默认交付语言、会话策略、重试、提示风格、模型调用显示、断网等待（链尾保持预算）、天枢恢复时间 |
| 任务流程与规划审核 | `workflow`、`planningReview` | 流程模式、自动审核、Jev 要求、修正轮数、阈值、`timeoutMs` |
| 纯函数数学算子 | `math` | 算子组、数值模式与计算规模 |
| 各角色模型链 | `routes` | 每层供应商、模型、推理强度；可升级角色另配容灾升级 |

### 组成

```
宿主层（cordis.patch.yml）
  swarm-core      agentSwarm 服务：任务卡与门禁、委派、路由状态（回退 / 链尾保持 / 首选恢复）、衡鉴、账本、写入守卫
  swarm-codex*    原生 Codex / Claude Code 后端实例（安装官方 bundle 后启用）
预设层（presets/*.patch.yml，13 个）
  百工模式（天枢）：标准工具 + swarm_* 编排工具 + jev_* 工具
  12 个专家预设：按权限裁剪的工具；委派时作为子会话的组合（DSH 0.2.1 起）
  每个预设都挂 runtime 行：改写路由、处理失败回退、解析语言占位符、安装委派 persona
浏览器端（client/ → lib/client.js）
  设置页、聊天中的「调用模型」行、任务流程图、持久专家的模型与恢复控制
```

### 开发（仅源码仓库）

公开源码树包含插件源码、构建脚本和用户文档，不附维护测试、沙箱或同步脚本。

| 命令 | 作用 |
|---|---|
| `npm run build` | 编译 `src/` 到 `lib/` 并生成浏览器端 bundle |
| `npm run typecheck` | 类型检查（仅 `src/`） |
| `npm run gen:presets -- --dsh "$(npm root -g)/@deepseek-ai/dsh/node_modules"` | 以 DSH 的 standard 预设为底重新生成 13 个预设 |
| `npm run doctor -- --profile <p>` | 只读检查本机环境（不输出密钥） |
| `npm run pack:release` | 构建、校验入口依赖闭包并打包发布物 |

升级、回退与卸载见 [docs/升级与回退.md](docs/升级与回退.md)。

### 许可证

MIT，见 [LICENSE](LICENSE)。内嵌的 Jev 工具改编自 jev-mcp 0.2.1（MIT），`skills/typesafe-ai` 收录自 TypeSafe AI（MIT），详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

---

## English

A multi-agent plugin for DeepSeek Harness (DSH). The orchestrator "Tian Shu" leads 12 Chinese-named experts (requirements, architecture, math, code exploration, research, vision, complex implementation, command execution, small edits, independent review, verification, copywriting) and accepts work only on evidence: task cards, hard gates and real command results. Each role has a multi-layer model chain built from your subscriptions; failures switch to a usable backup immediately, and a short outage of the last usable model is waited out within a budget.

- Works with DSH **0.2.x** (`>=0.2.0-rc.2 <0.3.0`, 0.2.1-rc.3 recommended) on Node.js 22.12 or newer
- Start a session in the "百工模式" (Agent Swarm) preset; a Jev API key is optional

### What's new in 3.1.7

- This is an audit and stability release: it fixes correctness issues in gates, state recovery, authorization waits, route recovery and the Jev endpoint, and removes the never-wired evolution-governance task view and read-only panel.
- The verification gate only accepts proved claims marked `proof`, any failed command in a review vetoes earlier passes, performance acceptance only accepts the latest measurement after the last edit, and acceptance review reads the most recent delegations.
- Recovery discards an unconfirmed half-written journal tail; authorization admissions are released and old answered decisions reclaimed as needed, successive in-flight waits in long tasks no longer exhaust the task, and a critical settlement failure is reconciled on the next entry.
- Every Jev direct tool replaces common secret formats before sending, review redaction matches in linear time and replaces auth schemes and combined credentials as a whole, a non-https `baseUrl` (loopback excepted) is rejected, and under `approvals=deny` for writes or commands native Codex/Claude delegations use the API tool chain with the reason recorded.
- Control-panel polling no longer clears failure notices, a reasoning-effort change is not reported as a model switch, and the unusable `maxTokens` / `maxCostUsd` settings are removed.
- Public `main` returns to a plugin-only tree; all 3.1.6 fixes are included here (3.1.6 did not get a separate GitHub Release).

### What's new in 3.1.3

- Categorized settings and accessible drag, button and keyboard ordering for fallback routes.
- Safer fallback during quota exhaustion and model changes; resumed delegates acquire a fresh execution binding.
- Recoverable user-decision waits, server-issued acceptance receipts and bounded structural loop detection.
- Runtime-guard scope and compatibility remain backward compatible; internal implementation records stay in the source repository's GitHub history.

### What's new in 3.1.2

- A native Task progress view brings six diagram perspectives together, with task selection and version-bound evidence. On narrow rc.3 layouts it can appear under More views.
- Shared read-only loading adds cancellation, stale snapshots and connection isolation without stopping long-running work.
- Tool and skill proposals remain quarantined metadata; text reviews cannot activate or execute them.
- Adopts Ruflo-inspired workspace, read-projection and provenance principles without adding another runtime; internal iteration records are excluded from the release package.

### What's new in 3.1.1

- Planning-review child sessions display models observed by the host; the controls distinguish actual attempts from next-request selections.
- One-shot reviewers can select the next request model without interrupting the in-flight request. Persistent experts retain cancellation, settlement and safe continuation.
- Obsolete context references return the current authorized index without reviving old permissions.
- File discovery supports bounded relative-directory scans; search overflow and Fetch endpoint failures retain their error status and offer recovery guidance.
- Reviewed experiences can match bounded applicability text. Self-evolution is delivered in stages described by the release notes.
- Tian Shu uses `ask_user_question` for necessary human decisions; silence never grants permission.

### What's new in 3.1.0

| Change | Details |
|---|---|
| **Long conversations no longer stop rendering** | GitHub Issue #1: `swarm-model-call` no longer returns `undefined` from `start()` when a paginated/long event window has no `request/header`. A hidden placeholder inherits the previous state and is dropped by the renderer, so the host event subscription remains intact; the next attempt is not falsely reported as a model switch. Ordinary sessions are protected by the same contract. |
| **Thinking-protocol failures are isolated** | `The content[].thinking ... must be passed back` is classified as `protocol_incompatible`; the current request fails over immediately and the route is isolated instead of being retried repeatedly in the same session. |
| **Blocked goals get a recovery prescription** | `swarm_status` now returns `blockedRecovery` for protocol incompatibility, route exhaustion, planning-service failure, no progress, missing gates and verification gaps. Tian Shu uses the recommended role and next action once, without repeating equivalent cards, scores or business mutations. |
| **pnpm 11 tarball guidance** | Installation docs use `minimumReleaseAgeIgnoreMissingTime: true`, which skips only local packages without registry publish-time metadata. `minimumReleaseAgeExclude` accepts exact versions only and rejects semver ranges. |
| **Read-only native Agent Team mirror (off by default)** | When native DSH Agent Team is enabled, the session header can show existing members, shared tasks, live status, owner, dependencies and write scopes, and open member sessions. It never creates members, edits tasks, calls `spawn_teammate` or native `complete`; the swarm remains the sole task, evidence, lease and execution controller. |
| **Link-based local tarball installer** | `scripts/install-profile.mjs` validates and unpacks a release tarball into a digest-addressed local bundle and wires it with `link:`, avoiding registry lookups for unpublished versions. Four-layer self-evolution remains a staged roadmap; 3.1.0 does not auto-modify prompts, tools or workflows. |

### What's new in 3.0

| Change | Details |
|---|---|
| **No more spurious "route chain exhausted"** | When no other route is available, transient network/server/rate-limit failures on the last usable model are retried with 5 s → 60 s backoff, and isolated routes about to recover — or being probed by another expert — are awaited. A request that starts while a shared subscription route has just been isolated by another expert also waits instead of failing. Waits share the per-request `agents.networkWaitMs` budget (10 min by default, at most 32 waits per request); only then does the request end, listing every route's state. A model you pick during a wait is honoured when it ends. Subscription pool exhaustion reported with `AUTH` counts as an authentication failure, other `AUTH` errors are classified by status; pool and auth cooldowns follow the host's recovery time (capped at 30 minutes before a re-probe). Signing in again or ordinary model-catalog/configuration updates do not expire isolation early. After signing in, wait for cooldown or request a controlled retry in the existing Model & recovery panel; retry eligibility follows policy and cannot bypass a provider's `resetAt` or another request's half-open probe. |
| **Replies in your configured language** | Every preset carries `- **Language**: 强制使用{$language}回答与思考…`; the runtime replaces `{$language}` with the language chosen in Settings → Agent Swarm and appends a rule written in that language, so it survives model switches. On DSH 0.2.1+, delegated experts and the native Codex / Claude Code backends also get a delegation persona generated in that language. Final replies followed the setting in the observed probes; despite the injected language instructions, reasoning displayed by DSH may still be in English, so it is not guaranteed to follow the setting. See [docs/使用.md](docs/使用.md#输出语言) (Chinese). |
| **Engineering rules for every role** | No over-engineering, no over-simplification, no blind refactors, security first, logged I/O errors, runnable verification for every change; implementers get C.T.I.V., naming and testing rules, executors get terminal-safety rules, reviewers a fixed four-dimension template. |
| **Workflow drafts are repaired, not rejected** | Missing required gate nodes (e.g. `G_MATH_VERIFY` for financial logic) are inserted by the host instead of failing the task card; draft edges that contradict the gate order are bypassed while every other business ordering is kept. |
| **No automatic planning review in advisory mode** | In a long-running goal, automatic reviews cost as much time as all expert work and passed 2 of 94 times. They now run automatically only in enforced mode; advisory mode reviews on demand via `swarm_review_plan`. |
| **Planning review settings in the UI** | Settings → Agent Swarm → "Task workflow & planning review" edits the workflow mode, automatic review, `requireJev`, fix rounds, pass threshold and `planningReview.timeoutMs` (0 = no limit by default; positive integer milliseconds keep an explicit limit; invalid values are rejected). |
| **Steadier long runs** | Model errors no longer pause persistent experts (cancellation, interruption and blocked turns still do), and "continue" is not offered while the automatic retry is pending. Normal writer completion waits for the delegation's registered host jobs to settle; cancellation requests a stop and waits for confirmation. End or disposal notifications trigger a recheck, not release; unconfirmed side effects keep the lease blocked. This does not guarantee that untracked or escaped OS processes have stopped. See [task workflows and verification](docs/任务流程与验证.md#执行与协作) (Chinese). |
| **Leaner code base** | Dead and duplicated code removed, as well as PRD, planning and evidence documents and one-off scripts. |

### Install

Restart DSH afterwards (with systemd: `systemctl --user restart dsh-web.service`).

- **dsh-market**: search for `dsh-agent-swarm`.
- **Release tarball**:
  ```sh
  dsh plugin --profile <profile> add https://github.com/zhairy/dsh-agent-swarm/releases/latest/download/dsh-agent-swarm.tgz
  ```
- **From source**:
  ```sh
  git clone https://github.com/zhairy/dsh-agent-swarm.git && cd dsh-agent-swarm
  npm install            # prepare builds lib/
  dsh plugin --profile <profile> add "$(pwd)"
  ```

Providers, Jev, native Codex / Claude Code and coexistence with dsh-llm-fallbacks are covered in [docs/安装.md](docs/安装.md) (Chinese).

### Usage

Describe the goal and acceptance criteria in an Agent Swarm session. Tian Shu then:

1. creates a task card with `swarm_task_card` (goal, acceptance, scope, risk flags, performance budget) and a Mermaid workflow; rules and Jev triage add hard gates;
2. delegates self-contained subtasks with `swarm_delegate`, which picks the model route, restricts tools, validates structured deliverables and has Jev rate their reliability;
3. inspects gates, evidence and routes with `swarm_status`, and accepts with `swarm_accept`, which returns `blocked` with the missing evidence.

Seven embedded Jev judgment tools (`jev_check`, `jev_classify`, `jev_score`, `jev_match`, `jev_screen`, `jev_ask`, `jev_health`) and the `jev-judgments` and `typesafe-ai` skills run inside the plugin without an external MCP server. See [docs/使用.md](docs/使用.md), [docs/角色.md](docs/角色.md) and [docs/任务流程与验证.md](docs/任务流程与验证.md) (Chinese).

### Settings → Agent Swarm

| Card | swarm-core key | Purpose |
|---|---|---|
| Jev API key | DSH credential store | save, clear and test the key; it never enters config files |
| Swarm tool approvals | `approvals` | inherit / ask / deny for writes, shell, external MCP and Jev tools |
| Agent sessions & retries | `agents` | default output language, session policy, retries, prompt style, model-call display, network wait (also the last-route hold budget), Tian Shu model recovery |
| Task workflow & planning review | `workflow`, `planningReview` | workflow mode, automatic review, Jev requirement, fix rounds, threshold, `timeoutMs` |
| Pure mathematical operators | `math` | operator groups, numeric modes and limits |
| Model chain per role | `routes` | provider, model and reasoning effort per layer; escalation chains for upgradeable roles |

### Development (source checkout only)

The public source tree ships the plugin sources, build scripts and user documentation; it does not include maintenance tests, the sandbox or the sync scripts.

| Command | Purpose |
|---|---|
| `npm run build` | compile `src/` to `lib/` and build the browser bundle |
| `npm run typecheck` | type-check `src/` only |
| `npm run gen:presets -- --dsh "$(npm root -g)/@deepseek-ai/dsh/node_modules"` | regenerate the 13 presets from DSH's standard preset |
| `npm run doctor -- --profile <p>` | read-only environment check (never prints secrets) |
| `npm run pack:release` | build, verify the entry dependency closure and pack the release tarball |

Upgrade, rollback and removal: [docs/升级与回退.md](docs/升级与回退.md) (Chinese).

### License

MIT, see [LICENSE](LICENSE). The embedded Jev tools are adapted from jev-mcp 0.2.1 (MIT) and `skills/typesafe-ai` comes from TypeSafe AI (MIT); see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
