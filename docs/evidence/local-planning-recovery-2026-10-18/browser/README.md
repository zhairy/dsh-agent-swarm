# 最终浏览器只读验收

2026-10-18，使用独立 `agent-browser` 会话访问 `http://127.0.0.1:3080`。业务消息发送、goal 操作和配置写入均为 0。

- 最终刷新对应 PID **2014749**；命令解析为 `/usr/bin/dsh`，真实入口为 `/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`。
- 通用设置实际显示 **当前版本：0.2.1-rc.2**，见 `version-final.png`。
- 百工、subscriptions、OpenViking、calculator、finance-data、quant、browser-playwright 七个插件全部启用。完整组件详情于前一 PID 1990786 留证；最后一次纯诊断更新重启后，七个开关再次逐项核对。
- 百工包含 18 个组件、2 个运行中；其他为原本停用的可选原生后端和单角色预设，不能把它们表述为全部 18 项都已运行。浏览器插件 3/3 运行，其余关键包各 1/1 运行。
- 百工实际 Codex 路由选择器显示 **gpt-6.1-sol**，占位项未选中；8 个可选目录条目包含账户变体，按模型名去重为 4 种。未选择或更改任何模型。
- 捕获 362 个网络请求，HTTP 错误和资源 404 均为 0；页面异常与 console error 均为 0。仅有两条 `genui` 激活信息日志。

机器可读结果见 `final-browser-verification.json`，逐插件详情见 `plugin-details-verification.json`，模型目录见 `codex-model-selector.json`。

截图只包含插件详情、版本文字或模型行。本机路径和账户标签仅在隔离浏览器 DOM 中隐藏，未更改底层配置、选值或宿主数据。原始会话快照、网络请求头和认证 storageState 仅在 0700/0600 私有临时目录中处理，不进入本 evidence。

此次浏览器检查证明版本可见、插件界面与模型目录可用；不替代后台真实模型请求、MCP 调用或业务任务完成证据。
