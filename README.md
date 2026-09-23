# dsh-agent-swarm

DeepSeek Harness（DSH）的中文多智能体插件：「天枢」主持 12 位中文专家，用任务卡、门禁和证据来决定是否验收；模型路由按你的订阅配置，qwen-token-plan-cn 优先、opencode-go 备用，运行中遇到失败自动回退。

- 适配 DSH **0.1.7-alpha.2**（`package.json` 的 `dsh.testedVersions`）
- 设计：[docs/V2-完整设计说明.md](docs/V2-完整设计说明.md)、实现规格：[docs/superpowers/specs/](docs/superpowers/specs/)

## 组成

```
宿主层（cordis.patch.yml）
  swarm-core ── 提供 agentSwarm 服务：路由 · 策略 · 衡鉴（Jev）· 账本 · 写文件守卫
  swarm-codex / swarm-codex-edit / swarm-claude-plan / swarm-claude-edit ── 原生后端实例（装了官方 bundle 才启用）
  agent-preset-registry ── 默认预设改为天枢

预设层（presets/*.patch.yml，13 个）
  天枢：标准工具 + swarm_task_card / swarm_delegate / swarm_status / swarm_accept
  谋定 枢机 算衡 探微 博闻 观象 铸剑 行舟 疾风 御史 复核 妙笔：按权限裁剪的工具
  每个预设都挂 runtime 行：在预设作用域内改写路由、处理失败回退
```

角色、权限与默认路由见 [docs/角色.md](docs/角色.md)。

## 快速开始

见 [docs/安装.md](docs/安装.md)。简要步骤：升级 DSH 到 0.1.7-alpha.2 → `npm install && npm run build` → `dsh plugin --profile swarm add <本目录>` → 在「设置 → 模型」添加 qwen-token-plan-cn / opencode-go / DeepSeek → `npm run doctor -- --profile swarm` → `dsh --profile swarm web`。

使用方法见 [docs/使用.md](docs/使用.md)，升级与回退见 [docs/升级与回退.md](docs/升级与回退.md)，评测方法见 [docs/评测.md](docs/评测.md)。

## 开发命令

| 命令 | 作用 |
|---|---|
| `npm run build` | 编译 `src/` 到 `lib/` |
| `npm run typecheck` | 类型检查（含测试） |
| `npm test` / `npm run coverage` | 单元测试 / 覆盖率（阈值：行 80%、分支 75%） |
| `npm run test:integration` | 在 `.sandbox/` 安装真实 DSH，用 mock LLM 跑端到端场景 |
| `npm run gen:presets` | 以沙箱 DSH 的 standard 预设为底重新生成 13 个预设 |
| `npm run doctor -- --profile <p>` | 只读检查本机环境（不输出密钥） |
| `npm run sync-dsh -- --version <x>` | 适配新版 DSH：重新生成预设并跑全部测试 |

## 验证状态

| 项目 | 沙箱（DSH 0.1.7-alpha.2 + mock LLM） | 需在本机用真实账号验证 |
|---|---|---|
| bundle 安装、13 个预设、默认预设 | ✓ | 升级后执行 `doctor` |
| 委派、工具白名单、写文件守卫 | ✓ | — |
| 门禁拦截与验收 | ✓ | — |
| 子智能体与主会话的路由回退 | ✓ | 真实 provider 的失败码 |
| 视觉拒收与截图入库 | ✓ | 真实视觉模型的识别质量 |
| Jev 分流与严格路径 | ✓（本地 mock 服务） | 真实 Jev key |
| 原生 Codex / Claude Code | 仅验证「未安装时退回 API」 | 登录后的真实调用 |
| V2 设计稿 §8 的 20 题评测 | 提供了框架与样例 | 需要你运行 |

## 许可证

MIT
