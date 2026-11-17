# DSH Agent Swarm v3.4.0

面向 **DSH 0.2.2-rc.3** 的原生协议适配、恢复一致性加固与现有执行工具接入。要求 Node.js >=24.9.0。本次同时发布第三方兼容组件、精确补丁、许可证、版本清单与校验和。

## ✨ 新增功能

- 适配 rc.3 顶层 Subagent 启动、具名成员与后代目录；恢复只接受可证明的直接父子关系。
- Swarm专家可使用Notebook多cell/多step状态；默认只读工作区、断网，保留Shell审批和当前任务身份核验。Root整理草稿，专家负责计算。
- 提供JS/TS受管Node执行与独立agent-browser验证路径；实际退出和自建服务清理纳入证据。
- 发布完整rc.3兼容归档：Notebook、Subscriptions、RigorQuant、OpenCode Go、OpenCode live/Pi AI设置包装器、calculator，以及宿主模型/执行桥接。

## 🐛 问题修复

2026-11-17 附件修订：初版 Subscriptions 兼容包遗漏 `cordis.patch.yml`，导致 Host 报 ENOENT、设置中缺少订阅入口。修订版 `0.9.13+rc3.transport.2` 恢复该文件；156 个 lib 文件与初版兼容构建逐字节一致。完整兼容归档、清单和 SHA256SUMS 已同步替换，请重新下载并核验；Swarm 主包与 v3.4.0 产品 tag 保持不变。校验器现在反查 main/types/exports/overlay 声明，拒绝文件缺失或未入清单的组件。


- 修复连续委派绑定落盘窗口及旧快照恢复；历史打开/续接继续检查线程、委派、任务版本和目录身份，不重放未知操作。
- 联网探测为在线时保留已配置短重试；临时失败在链尾仍可按有界退避恢复。单条历史的thinking协议错误不再扩大为其他会话的模型隔离。
- 可靠完成后结算原委派/规划/授权等待；未知句柄不能被一句“继续”解除；排队后的真实投递重验相关授权。
- dispose/停核失败进入清理未确认状态，不自动重派或解除围栏；修复预算耗尽且目标未完成时返回incomplete。
- 修复RigorQuant旧Team API/cwd模板导致的历史打开失败、Subscriptions旧定位hook，以及Notebook结束后视图消失/卸载后误降级legacy。
- 未核验Python选择仍可显示笔记；首屏list只返回元信息。未授权文件操作和未知会话执行明确拒绝，保持隔离边界。

## 🎨 体验优化

- Notebook完成后保留有界结果视图，内核停止与页面可查看分别验证。
- Subscriptions错误保留脱敏网络code，移除账号标识；不把传输失败当成订阅额度耗尽。
- P6复用冻结分片编码、统一恢复物化，保持事件格式、哈希校验、原子提交和fsync。性能证据限于指定热缓存合成样本，不外推为所有真实会话保证。

## ⚠️ 其他变更

- 兼容包不包含node_modules、Python venv、账号、Cookie、API Key、原会话或私人preset；补足/保留MIT等原许可证。它是社区兼容构建，不代表第三方上游发布。
- OpenCode Go 0.4.4沿用上游字节，无需额外代码补丁；Zen/Pi AI的owner隔离由配套包装器处理。OpenCode live必须保留父目录完整闭包。
- LayerFS仅做源码审计和设计借鉴，没有作为本版运行依赖或存储替换。
- 普通standard Notebook保持原执行语义，不能将其等同于Swarm托管沙箱；Windows完整执行隔离、多语言预热池、microVM和跨重启活变量恢复未交付。

## 兼容性说明

- 主要验收宿主：DSH **0.2.2-rc.3**；rc.1桥接保留。具体接口/行为说明见[rc.3适配文档](https://github.com/zhairy/dsh-agent-swarm/blob/v3.4.0/docs/3.4.0-DSH-rc3与本机升级.md)。
- 精确版本/SHA不匹配时拒绝桥接和受保护执行。升级前停用目标安装的全部写者，备份程序/profile及一致数据。rc.3 catalog v3不能直接交给旧rc.1读取。
- 文件及命令写入需要已核验Linux本机、bwrap、native linux-scope和API Worker；PTC、持久终端与原生CLI私有写入不因升级而开放。
- 官方API、订阅和网关各自的模型能力/额度仍以其实际返回为准。实测Google可在界面有余量时返回429，此类拒绝仍会触发必要回退；Codex最小调用已成功，但不保证未来网络或额度可用性。
- 核心单测 **1792通过、14既有跳过**；Node **64通过**；显式rc.3 Host **56通过**，另有Notebook元信息5项、Subscriptions诊断6项及精确包/实际受管执行验证。Host确定性模型结果与真实供应商小文本探针分别记录，不宣称所有第三方业务功能全量验收。

### 下载与选择

- `dsh-agent-swarm-3.4.0.tgz`：主插件；`dsh-agent-swarm.tgz`为相同字节的固定名副本。
- `dsh-agent-swarm-3.4.0-dsh-0.2.2-rc.3-compat.tar.gz`：可选兼容组件、合成补丁及前后SHA、校验/桥接工具、许可和Python依赖锁。
- Notebook、Subscriptions、RigorQuant各提供单独兼容tgz。其余组件在完整兼容归档中。
- `third-party-manifest.json`、`verification-summary.json`、`release-manifest.json`和`SHA256SUMS`：来源、验证范围、源码绑定和文件校验。

安装、版本矩阵与回滚见 `COMPATIBILITY.zh-CN.md`；所有文件下载后先核验SHA256SUMS。

### 已知问题与下一轮

Notebook变量仅限同一委派，完成视图为64份/总16MiB的进程内缓存；持久结果需由获授权Worker保存.ipynb。旧健康记录缺原始错误时保持保守隔离；未知写入/清理继续阻塞。供应商限制、浏览器兼容和可选服务仍有各自边界。

下一轮优先3.4.1实测问题和兼容矩阵自动化；随后3.4.2 Notebook数据保存/恢复、路由观测；再评估3.5 kernel registry、依赖快照、配额与评测，以及更后期的容器/microVM。详细验收标准见 `KNOWN-ISSUES-AND-ROADMAP.zh-CN.md`，这些计划尚未实现或发布。
