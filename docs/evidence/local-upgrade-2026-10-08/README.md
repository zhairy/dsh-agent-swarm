# 本地 DSH 百工 2.2.1 升级验证

2026-10-08 将现有源码链接安装重新构建并由唯一的 `dsh-web.service` 加载；运行时确认百工版本为 **2.2.1**。本机 DSH 为 `0.2.0-rc.2`，Node 为 `24.21.0`。

## 同步与兼容修复

- 保留原 `link:/data/nas/public/swarm/dsh-agent-swarm` 安装方式、默认天枢预设、模型链及插件设置。
- 升级检查发现原 Mermaid 地址 `/swarm-assets/mermaid.min.js` 不符合真实宿主 Connection Fetch 的 `/api` 路由约束。资源注册抛错会令注入作用域回滚，三个已经注册的百工 RPC 也随之失效；外层插件仍显示 active，因此只检查版本和插件状态无法发现故障。
- 客户端和服务端统一改用 `/api/swarm-assets/mermaid.min.js`，继续沿用宿主认证与固定依赖文件读取。修复后实际 Web 服务中的三个 RPC 和 Mermaid 资源均可达。
- 本地工作树包含此兼容补丁。已发布 `v2.2.1` tag、tgz、校验和及发布清单保持原样；现有 GitHub 附件尚未包含该补丁，重新安装该附件会覆盖本地修复。

## 验证结果

- 构建、TypeScript 检查通过。
- `rpc-task-view`、`client-task-flow`、`plugin`、`jev-hub` 四组测试共 **34 项通过**。
- 新增 `rpc-host-registration.test.ts`：真实发布版 DSH SDK 的 **3 项测试通过**，覆盖全部路由注册与分发、子作用域卸载和重注入、旧资源路径导致 RPC 注册回滚的负例。
- 实际 HTTP 验证见 [runtime-check.json](./runtime-check.json)：版本 2.2.1，审批设置已加载，百工核心 active，默认预设为天枢，420 条会话记录保留。
- `swarm.jevStatus` 正常响应；`swarm.taskView` 的无效输入及 `swarm.jevHealth` 的方法不匹配探针均返回预期的 `gateway/bad-request` 信封，证明三个处理器都已接线。此次部署验证未调用模型；这些探针不代表 Jev 在线推理或完整任务执行通过。
- Mermaid 经认证 GET 返回 200，未认证返回 401。返回内容为锁定依赖的本地资源，长度 2,748,992 字节，SHA-256 与磁盘文件一致。
- 原有 17 组插件设置的规范化哈希全部一致；新增审批设置使用 `inherit`，不覆盖宿主授权策略。
- 服务运行正常，自动重启计数为 0，`127.0.0.1:3080` 只有该 systemd 服务监听。

运行时记录只保留版本、状态、计数及资源摘要，不包含登录 token、cookie、密钥、会话内容或模型配置值。浏览器完整交互、后台任务流和模型推理不在此次升级冒烟验证范围内。

## 本地回退资料

升级前配置与 systemd 单元的私有备份位于 `/home/zhairy/.dsh/backups/agent-swarm-upgrade-2.2.1-20261008-103711`，目录权限为 0700。仅当需要回退本次变更时再核对差异恢复；升级期间其他插件发生的独立配置变更不应被覆盖。
