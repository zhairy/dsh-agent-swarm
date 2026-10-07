# dsh-agent-swarm

DeepSeek Harness（DSH）的中文多智能体插件：「天枢」主持 12 位中文专家，用任务卡、门禁和证据来决定是否验收；模型路由按你的订阅配置多层回退，断网时等待恢复后在原模型上重试。

- 适配 DSH **0.2.0-rc.2**，最低 0.1.7-alpha.2（`package.json` 的 `dsh.testedVersions`）；专家的连续会话需要 0.1.7-rc.2 及以上，更早的版本自动改为一次性调用
- **按模型家族组织提示**：Claude 用 XML 分节、写明约束理由、长材料在前；GPT（Codex）用 Role / Goal / Success criteria / Stop rules 与 GOAL / STOP WHEN / EVIDENCE；其他模型用编号的必做项。专家按实际启动的路由选择风格，天枢按对话框所选模型追加调度说明（参考 oh-my-openagent 的 agent-model-matching 与 Anthropic、OpenAI 官方提示指南）
- **内嵌 Jev**：7 个判断工具 `jev_ask` / `jev_check` / `jev_classify` / `jev_score` / `jev_match` / `jev_screen` / `jev_health` 与技能 `jev-judgments`、`typesafe-ai` 直接在插件内调用 TypeSafe System One，不需要外部 MCP；与衡鉴共用客户端、限流与凭据
- **聊天窗口显示模型**：百工会话每次调用模型都显示「调用模型：模型 · 供应商（路由名）· 推理强度」（可改为只在每轮首次与换模型时显示），回退 / 升级换模型时标为「切换模型」；会话头部显示当前模型；委派结果写明专家使用的模型、供应商与提示风格
- 设计：[docs/V2-完整设计说明.md](docs/V2-完整设计说明.md)

## 组成

```
宿主层（cordis.patch.yml）
  swarm-core ── 提供 agentSwarm 服务：路由 · 策略 · 衡鉴（Jev 分流、会话判断与交付复评）· 专家连续会话与自动重试 · 账本 · 写文件守卫
  swarm-codex / swarm-codex-edit / swarm-claude-plan / swarm-claude-edit ── 原生后端实例（装了官方 bundle 才启用）
  agent-preset-registry ── 默认预设改为天枢

预设层（presets/*.patch.yml，13 个）
  百工模式（天枢）：标准工具 + swarm_task_card / swarm_delegate / swarm_status / swarm_accept；模式列表里唯一的入口
  谋定 枢机 算衡 探微 博闻 观象 铸剑 行舟 疾风 御史 复核 妙笔：按权限裁剪的工具；默认停用，
    委派子智能体不依赖它们；要把某个专家单独作为主会话使用，设 DSH_SWARM_ROLE_PRESETS=1 后重启 dsh
  每个预设都挂 runtime 行：在预设作用域内改写路由、处理失败回退

浏览器端（client/settings-page.js + client/model-display.js → lib/client.js）
  设置 → 百工 Agent：顶部是 Jev API key（保存到 DSH 凭据存储，可测试连接）；「专家会话与重试」配置会话策略、
  自动重试、提示风格、断网等待与天枢恢复时间；再下面为 14 条角色路由（算衡分研算/验算）配置模型链
  （默认 4 层，可增删；每层选供应商、模型与推理强度），可升级的角色另配容灾升级；写入 swarm-core 的 routes / agents，即时生效
  聊天窗口：百工会话的「调用模型」行与会话头部的当前模型徽标（只读会话事件，不写自定义事件）
```

角色、权限与默认路由见 [docs/角色.md](docs/角色.md)。

## 快速开始

见 [docs/安装.md](docs/安装.md)。简要步骤：升级 DSH 到 0.2.0-rc.2 → `npm install && npm run build` → `dsh plugin --profile swarm add <本目录>` → 在「设置 → 模型」添加 qwen-token-plan-cn / opencode-go / DeepSeek → `npm run doctor -- --profile swarm` → `dsh --profile swarm web`。

使用方法见 [docs/使用.md](docs/使用.md)，升级与回退见 [docs/升级与回退.md](docs/升级与回退.md)。

## 开发命令

| 命令 | 作用 |
|---|---|
| `npm install && npm run build` | 编译 `src/` 到 `lib/`，并生成浏览器端 `lib/client.js` |
| `npm run typecheck` | 类型检查 |
| `npm run gen:presets -- --dsh "$(npm root -g)/@deepseek-ai/dsh/node_modules"` | 以已安装 DSH 的 standard 预设为底重新生成 13 个预设（先 build） |
| `npm run doctor -- --profile <p>` | 只读检查本机环境（不输出密钥） |

## 验证状态

| 项目 | 沙箱（DSH 0.2.0-rc.2 + mock LLM） | 需在本机用真实账号验证 |
|---|---|---|
| bundle 安装、13 个预设、默认预设 | ✓ | 升级后执行 `doctor` |
| 委派、工具白名单、写文件守卫 | ✓ | — |
| 门禁拦截与验收 | ✓ | — |
| 子智能体与主会话的路由回退 | ✓ | 真实 provider 的失败码 |
| 视觉拒收与截图入库 | ✓ | 真实视觉模型的识别质量 |
| Jev 分流与严格路径、7 个 jev_* 工具 | ✓（本地 mock 服务与单元测试） | 真实 Jev key |
| 按模型家族的提示风格、断网等待与天枢恢复 | ✓（单元测试） | 真实 Claude / GPT 的效果 |
| 原生 Codex / Claude Code | 仅验证「未安装时退回 API」 | 登录后的真实调用 |

## 许可证

MIT，见 [LICENSE](LICENSE)。内嵌的 Jev 工具改编自 jev-mcp 0.2.1（MIT），`skills/typesafe-ai` 收录自 TypeSafe AI（MIT），详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
