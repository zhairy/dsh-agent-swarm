# v3.4.1 兼容性说明

本轮目标为 DSH **0.2.2-rc.3**、Node.js **>=24.9.0** 和 Linux 本机/API Worker。主包与 Notebook、Subscriptions 均经过归档到实际加载目录的逐文件 size/SHA 比对；八项矩阵检查全部通过，详见 `compatibility-matrix.json`。

- Swarm `3.4.1`：受控 primary/linked、Git 保存、复核有限输出和进程内路由观测。
- Notebook `0.4.2+rc3.sandbox.9`：原 `.3` 到 `.9` 精确补丁及原 NPM 到最终组件 composite patch 都提供；同 attempt/任务/目录和来源校验不授予历史执行权。
- Subscriptions `0.9.13+rc3.transport.2`：保留完整 `cordis.patch.yml` 与 rc.3 传输兼容；使用总包内 NPM baseline 到 `.2` 的完整补丁。
- RigorQuant `0.7.0+rc3.sidecar.2`、OpenCode Go、本地 OpenCode 设置适配器和 calculator 从已验证模板保留，确切版本/文件摘要/来源与许可证见 `third-party-manifest.json`。

兼容总包包含六组件、完整补丁/计划、Host 桥接工具、原许可证和内部校验和。主插件提供版本名和固定名同字节 tgz；Notebook/Subscriptions/RigorQuant 另有独立包。它们是本发布维护的社区兼容构建，不代表第三方上游发行。

主树要求唯一工作树，获授权 Worker 通过 `swarm_bind_primary_workspace` 或恢复入口取得当前绑定。模型选择不是写权。linked 分支必须从合同基线派生；项目根/主分支/attempt/版本/目录身份不符均拒绝。只读恢复和冷启动不能复活旧租约。

保留 rc.1 脚本及历史版本范围；本轮没有扩大这些组合的完整运行验收声明。未知版本和字节拒绝。普通 standard Notebook 保留原语义，托管 Notebook 不静默切换未核验环境。

先验证 `SHA256SUMS`，再阅读主包中的安装/升级与回退说明。升级应替换匹配bundle并核对profile、运行API和浏览器；不要只改磁盘文件。回滚使用匹配程序和一致备份，不覆盖已经产生的新历史。外部MCP未启动、OAuth失效或供应商限流按实际状态处理。
