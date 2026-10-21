# dsh-agent-swarm

[中文](#中文) · [English](#english)

---

## 中文

DeepSeek Harness（DSH）的多智能体插件：「天枢」主持 12 位中文专家（谋定、枢机、算衡、探微、博闻、观象、铸剑、行舟、疾风、御史、复核、妙笔），用任务卡、门禁和真实证据决定是否验收；模型路由按你的订阅配置多层回退，故障时立即切到可用备用，最后一个可用模型短时故障时在预算内等待恢复。

- 适配 DSH **0.2.x**（`>=0.2.0-rc.2 <0.3.0`，推荐 0.2.1-rc.2）
- 新建会话选「百工模式」即可使用；Jev API key 可选

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

公开源码树不附维护测试、沙箱或同步脚本。

本节命令面向源码仓库。预构建 npm 包提供运行时文件、使用文档与维护工具，不包含源码构建或测试环境。

| 命令 | 作用 |
|---|---|
| `npm run build` | 编译 `src/` 到 `lib/` 并生成浏览器端 bundle |
| `npm run typecheck` | 仅检查 `src/` |
| `npm run gen:presets -- --dsh "$(npm root -g)/@deepseek-ai/dsh/node_modules"` | 以 DSH 的 standard 预设为底重新生成 13 个预设 |
| `npm run doctor -- --profile <p>` | 只读检查本机环境（不输出密钥） |
| `npm run pack:release` | 构建、校验入口依赖闭包并打包发布物 |

升级、回退与卸载见 [docs/升级与回退.md](docs/升级与回退.md)。

### 许可证

MIT，见 [LICENSE](LICENSE)。内嵌的 Jev 工具改编自 jev-mcp 0.2.1（MIT），`skills/typesafe-ai` 收录自 TypeSafe AI（MIT），详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

---

## English

A multi-agent plugin for DeepSeek Harness (DSH). The orchestrator "Tian Shu" leads 12 Chinese-named experts (requirements, architecture, math, code exploration, research, vision, complex implementation, command execution, small edits, independent review, verification, copywriting) and accepts work only on evidence: task cards, hard gates and real command results. Each role has a multi-layer model chain built from your subscriptions; failures switch to a usable backup immediately, and a short outage of the last usable model is waited out within a budget.

- Works with DSH **0.2.x** (`>=0.2.0-rc.2 <0.3.0`, 0.2.1-rc.2 recommended)
- Start a session in the "百工模式" (Agent Swarm) preset; a Jev API key is optional

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

The public source tree omits maintenance tests, sandbox tooling and sync scripts.

These commands target a source checkout. The prebuilt npm package includes runtime files, usage documentation and maintenance tools, not a source-build or test environment.

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
