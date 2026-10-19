# subscriptions 0.9.9 的本机 rc.2 兼容核查

本地候选：`/home/zhairy/.dsh/local-bundles/dsh-plugin-subscriptions-rc2`，版本 `0.9.9+local.rc2.1`，包名保持 `dsh-plugin-subscriptions`。本次没有修改生产 profile、重启 DSH、修改 pnpm 原包或批准 `allow-version`。

## 结论与修改

原包缺少 `engines.dsh`，相关 DSH peer 范围只明确覆盖到 `0.2.0-rc.2`。严格 rc.2 加载因此跳过插件，导致 Codex 等提供方完全未注册。候选保留上游全部 139 个文件、许可证、代码、客户端、工具及凭据 namespace；仅修改 `package.json` 的本地版本、精确 `engines.dsh=0.2.1-rc.2`、相关 peer 的 rc.2 范围及 `dsh.testedVersions`，另增加本地适配说明与原文件摘要清单。没有修改业务 JS，没有将包名或 `plugins/subscriptions` 凭据目录改名。

此声明仅覆盖实际验证的 `0.2.1-rc.2`，不扩大到未测试的未来版本。运行依赖独立保存在副本的 `.runtime-deps`，以独立 package.json／package-lock.json 锁定并安装 Undici 7.29.1；DSH peer 通过副本 node_modules 的稳定链接直接解析到 `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`。原 profile 和旧 `.pnpm` 目录不再参与候选依赖解析。139 个原文件没有与候选形成硬链接，原包摘要未变化。

## API 核查证据

| 插件用法 | 插件源码位置 | rc.2 宿主对应实现／核查 |
| :--- | :--- | :--- |
| `LlmAdapter`、`LlmError`、`ReasoningEffortId` 及错误常量 | 上游 `lib/index.js:1`–`16` | 通过实际 ESM 链接；不是把缺少导出错误吞掉。实际 peer 为 rc.2。 |
| `llm.registerAdapter` 返回带 `replace` 的句柄 | 上游 `lib/index.js:11593` | `/usr/lib/.../dsh-llm/lib/index.js:1842` 保留此合同，实际注册五个提供方通过。 |
| `listProviders/listModels/resolveModelInfo` | 上游 `lib/index.js:11896` 等 | rc.2 `dsh-llm/lib/index.js:2086`、`:2111` 验证提供方、目录、上下文和推理元数据；隔离 Codex 测试目录与 resolve 均通过。 |
| `defineTool`、`tools.register`、Agent 作用域限制 | 上游 `lib/index.js:12076`–`12104` | rc.2 `dsh-tools/lib/index.js:838` 及注册接口存在；三工具实际注册；真实 Agent 创建与 dispose 通过。 |
| `web.registerSearchProvider` | 上游 `lib/index.js:12069` | rc.2 `dsh-web/lib/index.js:69` 保留注册合同。测试未发起外部搜索。 |
| `connection.fetch.register` | 上游 `lib/auth/rpc.js`／打包入口 `lib/index.js:1845` | rc.2 `dsh-client-connection/lib/index.js:734`、`:840` 保留 Fetch 路由注册；没有修改鉴权路由或登录协议。浏览器交互仍需切换后核查。 |
| `attachments.readImage/readImageRequest/saveImage` | 上游打包入口的图片读写路径 | rc.2 附件服务保留相应方法；本轮未调用真实图片／视频生成。 |
| `dshHomePath('plugins','subscriptions',...)` | 上游 `lib/auth/store.js:169` 等 | 使用实际 rc.2 home-paths；候选 JS 字节未改，原凭据 namespace 保留。隔离测试采用独立 DSH_HOME。 |

## 严格宿主对照测试

同一隔离 profile、同一 `/usr/lib` rc.2 可执行入口和同一探针，分别切换原包与候选。没有兼容豁免配置。

- **原包**：退出码 1；宿主明确输出 incompatible 并跳过 `dsh-plugin-subscriptions@0.9.9`，探针观察到 `Provider not registered: codex`。
- **候选**：退出码 0；注册 `codex/claude/grok/copilot/antigravity` 五个提供方以及 `x_search/video_generate/image_generate` 三工具。
- **模型目录**：只有隔离 profile 配置合成账户及静态 `compat-codex` 目录；宿主返回正确提供方／模型身份、32000 contextWindow、4096 defaultMaxTokens 和合法 reasoning efforts。
- **Agent 生命周期**：使用真实宿主 `agents.create` 和 handle.dispose，通过既有 `agent/created` 工具限制监听器。
- 其它未配置合成账户的提供方目录正常为空，不能把空目录说成已验证这些真实订阅可用。

独立依赖切换后再次使用真实 rc.2 宿主运行同一探针，退出码 0，五提供方、三个工具、Codex 目录与 Agent 创建／释放均通过，stderr 为空。实际解析路径已核对：Undici 来自本副本，相关 DSH SDK 来自 `/usr/lib`；Schemastery 为该宿主的 3.18.5。

详细结果为同目录 `subscriptions-rc2-verification.json`；原始隔离输出位于 `/tmp/subscriptions-rc2-compat-yp8kaaud`。合成令牌只存在该隔离临时目录，不能用于远程认证；未读取或复制生产 OAuth 凭据，也未发起生成模型调用。

## 主维护会话切换时的边界

1. 生产 profile 的依赖改为候选目录的显式 `link:`，保留原 manifest／lock 备份，维持包名不变，避免加载两份订阅插件。
2. 原用户配置继续使用，不复制隔离测试的静态模型或合成账户；生产自动模型发现逻辑完全保留。
3. `/usr/lib` 宿主统一切换后，再核对真实模型目录、Settings 订阅页、配额读取及最小真实模型请求。此次隔离 API 核查不等于真实账户 OAuth 刷新或浏览器交互验证。
4. 恢复原依赖路径即可回滚候选；本次未写用户原有 auth、provider-settings 或 model-default 文件。

没有发现需要额外业务 API 适配的证据，因此本次不修改上游逻辑，避免凭兼容升级引入功能删改。

## 运行依赖重建

上游包保留原开发依赖声明；避免在发布包根目录安装其旧版开发 SDK，使用独立运行依赖锁。重建命令如下，安装脚本禁用，宿主版本不是 rc.2 时明确拒绝：

```bash
node /home/zhairy/.dsh/local-bundles/dsh-plugin-subscriptions-rc2/rebuild-runtime.mjs
```

锁定依赖使用 `npm ci --ignore-scripts --no-audit --no-fund` 安装到副本内部，已实际安装验证。此副本不依赖生产 profile 的旧包引用，因此后续 profile 同步清理不会删除其运行依赖。
