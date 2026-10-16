# DSH 0.2.0-rc.2 → 0.2.1-alpha.4 升级与插件适配证据（2026-10-16）

## 本机升级

- 本机 DSH 由 **0.2.0-rc.2** 升级到 **0.2.1-alpha.4**（`sudo npm install -g @deepseek-ai/dsh@0.2.1-alpha.4`，
  `dsh --version` 实测 0.2.1-alpha.4）。升级前旧安装整体备份到
  `/usr/lib/node_modules/@deepseek-ai/.dsh-0.2.0-rc.2-rollback`；profile 文件（`cordis.patch.yml`、
  `compatibility.json`、`package.json`）备份到 `~/.dsh/backups/upgrade-0.2.1a4-20261016-133946/`。
- 唯一服务 `dsh-web.service` 停一次、升级后启动一次；启动无跳过的 bundle、无未激活必需插件。
- 持久化保持关闭：跨版本重启不携带内存态百工会话状态；已脱敏账本仍是只读审计来源。

## 宿主兼容性发现（0.2.0-rc.2 → 0.2.1-alpha.4 的破坏性差异）

1. `connection` 条目不再注入已移除的 `webRuntime` 服务（工厂默认改为 `webStartup`）。
   本机用户层覆盖已从 `[webRuntime, webServer]` 改为 `[webStartup, webServer]`（保留订阅页需要的 `webServer`）。
2. 未激活条目从“警告”升级为**启动失败**（`auditStartupEntries` 对必需条目 fail-loud）。
   `dsh-at-file@0.7.0` 主机侧调用 `ctx.settings.register`，而 0.2.0-rc.2 与 0.2.1-alpha.4 的
   `@deepseek-ai/dsh-settings` 都没有该方法——旧宿主只是警告并保持可用，新宿主会拒绝启动。
   已在本机用户层禁用该行（`- id: dsh-at-file, disabled: true`），待上游适配后删除覆盖即可恢复。
3. 插件兼容声明改为优先 `engines.dsh`。本机 5 个第三方 bundle 的旧 peer 范围不覆盖 0.2.1-alpha.4，
   按既有先例在 `compatibility.json` 中登记精确版本豁免：`@deepseek-ai/dsh-tool-calculator@0.0.1`、
   `dsh-plugin-finance-data@0.3.2`、`dsh-plugin-subscriptions@0.9.9`、`dsh-browser-playwright@0.1.1`、
   `dsh-quant@0.90.0`（每条仅对包名@版本 + 0.2.1-alpha.4 生效，可逐条撤销）。
4. 标准预设变化：移除 `{{cwd}}` 提示变量、新增 `time-context`/`tool-schedule`/`working-directory`/`plugin-market` 行；
   子智能体不再接受启动期 `persona`/`toolFilter`，composition 改由 `agentPreset` 选中的预设承担。

## 插件适配（2.5.2）

- **兼容声明**：`package.json` 新增 `engines.dsh: ">=0.2.0-rc.2 <0.3.0"`，
  `dsh.minVersion` 与 `testedVersions` 同步为 `0.2.0-rc.2`、`0.2.1-alpha.4`。
- **双版本子智能体协议**：`src/subagent-compat.ts` 统一启动入口——旧宿主走 `start`/`startContinuable`，
  新宿主走 `startActivation`（`delivery: 'caller'`，由插件自己消费回合结算，避免重复通知天枢）。
- **子智能体 composition**：新宿主下按角色传 `agentPreset`（角色预设承载 persona 与工具组合）；
  宿主提供激活协议时，插件在 `agent/created`（排队工作释放前）按角色在子智能体作用域
  `tools.restrict(角色所需工具 ∩ 当前可见工具)`，并在委派前登记 `allow_web`（`NoteChildScope`）。
- **角色预设注册**：0.2.1 的预设注册表没有隐藏层；插件在检测到激活协议时按需注册
  `presets/declarations.json`（由 `scripts/gen-presets.mjs` 生成）中的 13 个角色预设。
  旧宿主保持原行为（默认不注册，`DSH_SWARM_ROLE_PRESETS=1` 才展开）。
- **预设再生**：以 0.2.1-alpha.4 的 standard 预设为底重新生成 13 个角色预设：
  去掉宿主已删除的 `{{cwd}}`，纳入 `time-context`/`working-directory` 等新行；
  为保证旧宿主可加载，不内置旧安装缺包的 `tool-schedule` 行。
- **订阅额度读取**：0.2.1 起共享 fetch handler 需要显式 Peer；插件用
  `connection.createPeer({ principal: { kind: 'owner' } })` 供进程内受信读取（旧实现忽略该参数）。

## 验证

- 单元/回归：`npx vitest run` → 74 文件 / 921 用例通过（测试宿主为 0.2.1-alpha.4）。
- 真实宿主集成：`vitest.integration.config.ts` 在 **0.2.1-alpha.4** 与 **0.2.0-rc.2** 上各
  8 文件 / 39 用例通过（含委托、门禁、连续会话、恢复、状态一致性、额度/数学与真实 RPC）。
- 升级预检：以本机 profile 副本在 0.2.1-alpha.4 上真实启动（备用端口）无启动失败；同法验证旧宿主可回退前提。
- 本机生产：服务重启后 `swarm.jevStatus`（插件 RPC）返回正常；`swarm.quotaView` 返回
  `dsh-plugin-subscriptions` 的真实账户窗口（示例 plan=prolite，status=reported），
  证明插件、订阅来源与新连接 Peer 读取链路均在 0.2.1-alpha.4 上工作。

## 边界

- 0.1.7-* 历史宿主本轮未复测；`engines.dsh` 支持下限声明为 0.2.0-rc.2。
- 5 条第三方豁免是精确版本的显式风险接受，不是兼容性证明；相关插件沿用原版本。
- 0.2.1-alpha.4 上角色预设会出现在模式列表中（宿主没有隐藏层）；它们同时可作为独立专家模式使用。
