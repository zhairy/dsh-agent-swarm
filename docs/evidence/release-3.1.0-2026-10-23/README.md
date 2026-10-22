# 3.1.0 修复与发布验证

日期：2026-10-23。基线：DSH 0.2.1-rc.2，`dsh-agent-swarm` 3.0.0 的共享源码树 `5a00b4c`。

## GitHub Issue #1

问题存在。Issue #1 描述的事件窗口缺失 `request/header` 时，`swarm-model-call.start()` 返回 `undefined`，与宿主 conversation definition 契约冲突，导致订阅器失败并使后续消息不再渲染。

修复前测试直接断言缺失 header 时返回 `undefined`，因此问题被测试固化为“期望行为”。修复后：

- 事件投影拆到 `client/model-events.js`，React 展示留在 `client/model-display.js`。
- 缺失路由时返回继承上一条状态的隐藏占位 `__hidden: true`。
- `buildViewNode` 和 `ModelCallRow` 丢弃隐藏节点。
- 未知推理强度不制造 `switched`；后续同模型调用保持 `repeat`。
- 普通会话的 `assistant/attempt` 同样不会让 `start()` 返回 `undefined`。

## 长期任务恢复

- DeepSeek 的 `content[].thinking ... must be passed back` 归类为 `protocol_incompatible`，当前请求立即回退并隔离故障路由。
- 连续子会话遇到该错误时关闭损坏会话，以任务卡、证据和真实工作区建立新的干净子会话；禁止重放已完成副作用。
- `swarm_status` 返回 `blockedRecovery`，区分协议、路由、规划服务、无进展、门禁和验证缺口，并给出推荐角色。诊断不构成批准，门禁和权限不降低。

## 原生 Team 与自我进化

- 原生 Agent Team 镜像默认关闭，只读成员、共享任务、实时状态、owner、依赖和写入范围，并可导航到已有成员会话；不调用 `spawn_teammate`、不修改任务、不调用原生 `complete`。
- 四层自我进化仅完成路线规划；3.1.0 不自动修改提示、工具或工作流。

## 本地安装与 pnpm 11

- 新增 `scripts/install-profile.mjs`：校验 tarball 路径、包名和版本，安装包依赖，解包到 `<DSH_HOME>/local-bundles/dsh-agent-swarm-v<版本>-<摘要>/`，以 `link:` 接入 profile，并把 `dsh-agent-swarm` 加入 `dsh.profile.bundles`。
- pnpm 11 的 `minimumReleaseAgeExclude` 只接受精确版本；range 会报 `ERR_PNPM_INVALID_MINIMUM_RELEASE_AGE_EXCLUDE`。
- profile 使用 `minimumReleaseAgeIgnoreMissingTime: true`，只跳过 registry 中缺少发布时间字段的本地包；其他插件仍受 release-age 检查。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| TypeScript 类型检查 | 通过 |
| 单元测试 | 94 个文件、1284 项通过 |
| 真实 DSH 集成 | 8 个文件、42 项通过 |
| 预构建包依赖闭包 | 5 个入口、78 个模块、缺失 0 |
| 隔离 tarball 安装 | 3.1.0 正常启动并通过 pnpm 11 |
| link 安装器 | 临时 profile 启动，插件启用，`dsh.profile.bundles` 正确 |
| agent-browser | 百工预设、插件版本 v3.1.0、原生 Team 实验开关正常，无页面错误 |
| 本机正式 profile | `dsh-web` 用户服务 active，PID 1358953，仅监听 127.0.0.1:3080；宿主与插件分别为 0.2.1-rc.2 / 3.1.0 |
| 长会话回归 | 打开真实的“行情工作台布局优化”会话，数百条消息、工具调用和压缩历史连续渲染，页面错误为空 |

浏览器证据：

- [百工预设](browser/baigong-preset.png)
- [插件版本](browser/plugin-v3.1.0.png)
- [本机真实长会话](browser/production-long-session.png)
- [本机插件页](browser/production-plugin-v3.1.0.png)

本机 profile 升级前备份位于 `/home/zhairy/.dsh/backup-v3.1.0-20261023-014921`。`pnpm install` 期间出现旧版本 patch 未命中和 peer warning；升级后 `dshmarket`、RigorQuant、subscriptions、finance、browser、quant 等插件仍可解析，`dsh --dump-config` 仅报告已知的 RigorQuant `agent-team` 缺失提示。

## Jev 审核

- `jev_health`：通过，返回 `jev-1.14.0`。
- `jev_classify`：`confirmed_and_fixed`，置信度 1.0。
- `jev_match`：最佳方案为 `hidden_inherit`，概率 0.76。
- `jev_ask`：修复契约 0.85、协议隔离 0.87、门禁保持 0.93、模块化不过度重构 0.90、pnpm 方案 0.91；发布决策为 release，概率 0.71，风险落在“低风险”区间。
- `jev_check`：隐藏节点和宿主契约相关命题通过；直接代码事实中部分命题不确定，因此以源码、回归测试和真实宿主集成为准，未把 Jev 概率当事实证明。
- `jev_score`：修复质量 2.51/5，位于“合格～强”之间，置信度 0.60；主要不确定性来自未提供多小时的完整真实会话语料。
- `jev_screen`：外部 Issue 文本判为 `review`，因为其中包含修复指令；未直接执行文本中的建议，而由主线代码和测试独立核对。
- `jev_ask` 曾对“精确代码路径是否存在”给出 0.47 的低置信 Noul；随后 `jev_classify` 以完整证据判为 1.0。该分歧被保留，不将低置信结果包装成确定事实。

## Agent 审核

- 性能/架构 Agent 完成独立审查并确认 Issue #1，指出 3.0.0 的 `start()` 缺陷，同时提出事件投影拆分、原生 Team 只读镜像和 link 安装器。主线采用了这些模块，并通过全量测试。
- 反方 Agent 的任务注入通道未返回可解析的最终报告；相关尝试已中断。为避免伪造双审结论，本记录只把实际返回的 Agent 报告列为证据，并保留 Jev 作为第二路独立判断。

## 边界

- 未提供真实用户的多小时分页会话全集；用穷举事件组合和宿主集成测试覆盖可枚举契约。
- 临时 profile 未配置真实模型，因此没有重复发起真实模型业务调用；原生产 profile 的模型链路另行验证。
- 原生 Team 在临时 profile 中没有实际成员/任务，仅验证默认关闭、组件加载和开关；成员投影的 DOM 上限由单元测试覆盖。

## GitHub 发布

- Release：<https://github.com/zhairy/dsh-agent-swarm/releases/tag/v3.1.0>
- 标签 `v3.1.0` 指向发布提交 `e75df18`；源码发布提交为 `809f20c63de8b41087559a303ed627820af4cdfe`，后续证据提交不改变发布物。
- 五个资产：`dsh-agent-swarm.tgz`（1,316,811 字节）、`release-manifest.json`、`RELEASE-NOTES.zh-CN.md`、`RELEASE-NOTES.en.md`、`SHA256SUMS`。
- 发布包 SHA256：`0bdf0a00b29d18b9787f74a76e0fe62e416ff29079d2b6996540d38fdab7851b`。
- 已通过 `releases/latest/download` 匿名下载五个资产，`sha256sum -c SHA256SUMS` 全部通过。
