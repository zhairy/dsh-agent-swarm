# dsh-agent-swarm

DeepSeek Harness 的百工多智能体插件。天枢负责规划、授权、路由与派发，12 位专家按任务合同执行，门禁以真实证据决定验收。

## 3.4.2

- 精确适配 DSH **0.2.3-alpha.2**；Node.js **24.22.3（24.x）或 >=26.13.1**。
- 隐藏补阙仅由失败事件触发，模型链可配置；SQLite 原子去重、共享有限预算、退避冷却、禁止递归修复。
- `MODEL_SWITCH_COMPACTION_FAILED` 保留原模型，不误判为配额故障，也不绕过摘要必须更短的校验。
- 在模型调用前裁剪天枢不适用的工具，保留人工轮次、独立初审与受控工作树的合法门禁。
- 保留单一主工作树和 linked 工作树的授权、租约及执行围栏；Notebook 上下文使用当前宿主公开接口。
- 可选 Python / Node 隔离预热池、操作 ID 去重和短令牌凭据代理；独立服务允许 DSH 重启后保留有效内核。
- 安装器校正本地依赖链接与锁文件，打包检查入口闭包、迁移 SQL 和静态资源。

自动恢复仅执行已有可信见证和权限合同允许的动作；未知副作用及超出预算的任务转人工。microVM、整机重启后的活进程恢复和旧 Notebook 内核整体托管不在本版完成范围。

## 安装

```bash
dsh plugin --profile web add https://github.com/zhairy/dsh-agent-swarm/releases/download/v3.4.2/dsh-agent-swarm.tgz
```

安装前确认宿主版本与必要桥接，见 [安装](docs/安装.md) 和 [alpha.2 合同](docs/3.4.2-alpha2宿主与独立执行服务.md)。本包不会升级宿主、安装第三方整包、迁移个人配置或自动启动执行服务。

## 使用

在会话中选择「百工模式」，描述目标与验收条件：天枢建立任务卡、派发专家、核验交付与门禁。模型、重试和 Jev 在「设置 → 百工 Agent」配置。补阙不能从手动角色列表或 `swarm_delegate` 调用。

- [使用](docs/使用.md)
- [角色](docs/角色.md)
- [任务流程与验证](docs/任务流程与验证.md)
- [补阙权限与恢复边界](docs/3.4.2-补阙恢复与验收边界.md)
- [升级与回退](docs/升级与回退.md)
- [可选执行镜像与服务](runtime/README.md)

## English

DSH Agent Swarm v3.4.2 targets DSH 0.2.3-alpha.2. It provides evidence-gated delegation, bounded failure recovery, controlled workspaces, and optional isolated Python/Node kernels. Recovery never gains the original task's permissions and does not replay unknown side effects. Runtime containers and third-party plugins are not bundled. See the linked installation and compatibility documents before enabling optional services.

## License

MIT. Included third-party licenses and notices are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
