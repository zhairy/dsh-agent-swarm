# v3.4.0 第三方插件与 DSH rc.3 兼容包

目标宿主为 DSH **0.2.2-rc.3**，Node.js **>=24.9.0**。兼容归档随 [v3.4.0 Release](https://github.com/zhairy/dsh-agent-swarm/releases/tag/v3.4.0) 发布。它包含代码和补丁，不包含账号、密钥、Cookie、模型配置、会话、工作树或 Python 虚拟环境。

## 组件与用途

| 组件 | 上游/基线 | 兼容版本 | 主要处理 |
| --- | --- | --- | --- |
| DSH Agent Swarm | 本仓库 | 3.4.0 | rc.3 子代理/恢复、原生执行边界、路由、等待/授权及 Notebook 接线 |
| [dsh-notebook](https://github.com/beihzb/dsh-notebook) | 0.4.2 | 0.4.2+rc3.sandbox.3 | rc.3 工具输出契约、受管内核、角色与路径权限、退出证明、完成视图和环境元信息 |
| [dsh-plugin-subscriptions](https://github.com/V1ki/dsh-plugin-subscriptions) | 0.9.13 | 0.9.13+rc3.transport.1 | 空文本/错误工具结果、Gemini thinking 兼容、rc.3 peers、CSS anchors、脱敏传输诊断 |
| dsh-rigorquant | 0.7.0 | 0.7.0+rc3.sidecar.2 | 冻结前选模、公共 Team/Subagent 身份、关闭态和权限守卫、移除过期 cwd 模板 |
| [dsh-opencode-go](https://github.com/Duskriver/dsh-opencode-go) | 0.4.4 | 0.4.4，上游字节无需额外补丁 | 保留上游目录刷新/模型池；owner区分由配套设置包装器处理 |
| dsh-opencode-live | 本地适配器 | 0.1.0+rc22.local.1 | Zen 动态目录、元数据交集、动态注册/释放，复用 rc.3 Pi AI |
| @deepseek-ai/dsh-llm-pi-ai 设置包装器 | 官方 rc.3 | 0.2.2-rc.3 | 通用设置不抢占 OpenCode owner；位于 opencode-live/pi-ai-settings |
| @deepseek-ai/dsh-tool-calculator | 保留的本地 MIT 实现 | 0.0.1+rc22.local.1 | 保留计算器解析器和工具协议，依赖固定到 rc.3；该版本不是可重新下载的官方 npm rc.3 包 |

这些 `+rc3.*` 是本发布维护的兼容构建，不是第三方上游的正式新版本。`third-party-manifest.json` 记录精确来源、许可、文件和归档摘要；说明中的版本号不能代替摘要核验。

其他已安装第三方组件的版本和固定 Git commit 列在公开清单中，继续从各自上游安装，不把它们的整棵 node_modules 或运行数据再打包。LayerFS 本轮只有源码借鉴审计，没有 rc.3 完整运行验收，不作为必装组件。本机历史 preset 配置没有统一的再分发许可，不分发其私人副本；新安装使用 Swarm 自带的13个预设。

## 归档结构

兼容归档包含 `components/` 的可分发组件、`patches/` 的逐组件合成补丁/前后 SHA、`host-patches/` 的 rc.3 模型和执行桥接、`tools/` 的校验及精确补丁工具、`licenses/` 和 Python 依赖锁。以实际 manifest 为准。

Notebook、Subscriptions、RigorQuant 另提供单独 tgz，方便只替换自己已安装的组件。包含原许可证及补足的分发声明；打包时未更改其经过验证的运行代码。

OpenCode live 必须保留整个目录：

```text
components/opencode-live/
  index.mjs
  catalog.mjs
  registration.mjs
  provider-settings.mjs
  native-pi-ai.mjs
  native/
  pi-ai-settings/
```

只复制 `pi-ai-settings/` 会破坏 `../native-pi-ai.mjs` 等相对导入。设置包装器和 Zen 适配器必须来自同一归档，使用相同的宿主 SDK。

## 安装与回滚

先验证 SHA256SUMS，选择实际需要的组件。发布操作本身不会替用户自动启用这些可选插件。

```bash
sha256sum -c SHA256SUMS
tar -xzf dsh-agent-swarm-3.4.0-dsh-0.2.2-rc.3-compat.tar.gz
node dsh-agent-swarm-3.4.0-rc3-compat/tools/verify-compat.mjs --root dsh-agent-swarm-3.4.0-rc3-compat --sdk /path/to/dsh/node_modules
```

安装前停止使用目标安装的全部进程，备份 profile 及一致的会话/Swarm状态，保留旧程序、旧包和工作树。只在停止使用的副本上应用补丁；不要在线修改已加载文件。

宿主模型桥和执行桥分别核验精确版本/原包摘要：

```bash
node dsh-agent-swarm-3.4.0-rc3-compat/host-patches/apply-dsh-step-bridge.mjs --dsh-root /path/to/dsh
node dsh-agent-swarm-3.4.0-rc3-compat/host-patches/apply-dsh-execution-boundary.mjs --dsh /path/to/dsh/node_modules
node dsh-agent-swarm-3.4.0-rc3-compat/host-patches/apply-dsh-step-bridge.mjs --dsh-root /path/to/dsh --check
node dsh-agent-swarm-3.4.0-rc3-compat/host-patches/apply-dsh-execution-boundary.mjs --dsh /path/to/dsh/node_modules --check
```

第三方补丁使用 `tools/apply-plugin-compat.mjs` 和对应 manifest。合成补丁以所列原始包为输入；不要把它再叠加在本发布已经修补的组件上。原仓库中的分阶段 patch 保留作实现历史，不代表任意顺序都可应用。`--check` 验证修补后字节，`--restore` 恢复匹配的原字节；未知、混合或变更的文件直接拒绝。

只使用已有完成组件时无需再次应用其补丁。把需要的组件作为 profile 的 `link:`/`file:` 依赖，并由宿主的 profile bundle 管理器启用；共享依赖应解析到同一 rc.3 SDK。`verify-compat.mjs --link-sdk` 仅为解压副本建立共享 SDK 链接，不改用户 profile、不启动插件。SDK未包含的普通 npm运行依赖仍须按组件 package.json 在隔离副本安装，不能自动装入另一版 DSH peer。

Swarm 自身继续使用原安装器：

```bash
node /path/to/swarm/scripts/install-profile.mjs --tarball /path/to/dsh-agent-swarm-3.4.0.tgz --profile /path/to/dsh-home/profiles/web --dsh-home /path/to/dsh-home
```

rc.3 子代理目录使用 catalog v3，不能直接交给旧 rc.1 程序。跨宿主降级须保存升级后全部数据，再恢复配套旧程序及升级前数据代；不能只切二进制。仅回退本轮插件代码时，也不要盲目覆盖已经产生的新历史或删除未知租约。

## Notebook 运行环境

Python依赖在单独venv中安装，完整锁见归档中的 `notebook-runtime.requirements.txt`。不包含系统级安装、项目依赖或虚拟环境二进制。

```bash
python3 -m venv /path/to/notebook-venv
/path/to/notebook-venv/bin/python -m pip install -r dsh-agent-swarm-3.4.0-rc3-compat/notebook-runtime.requirements.txt
```

由宿主服务配置controller，模型/工具参数不能覆盖这些值：

```ini
[Service]
Environment=DSH_NOTEBOOK_CONTROLLER_PYTHON=/path/to/notebook-venv/bin/python
Environment=DSH_NOTEBOOK_CONTROLLER_RUNTIME_PREFIX=/path/to/notebook-venv
```

Swarm托管计算默认为只读工作区、断网和有界资源。Root整理草稿，专家执行计算；`nb_save`仍需合法Worker的工作树和任务写scope。未知环境可以显示元信息，但执行前须显式选择已核验内核。普通standard Notebook保留原行为，不声称与受管专家具有相同沙箱。

## 验证范围

Swarm核心1792项单测通过、14项既有跳过；Node62项通过（含新增的3项兼容归档校验测试）；显式rc.3 Host56项通过。另有Notebook元信息5项、Subscriptions诊断6项及真实受管Notebook/JS/TS/浏览器路径验证。精确包验证与公开校验摘要随资产发布。

RigorQuant已覆盖历史打开与Team权限相关路径，OpenCode覆盖注册/目录和归属边界，calculator覆盖工具契约；这些不等于验证每个第三方业务功能。完整限制和后续验收标准见[已知问题与迭代计划](KNOWN-ISSUES-AND-ROADMAP.zh-CN.md)。
