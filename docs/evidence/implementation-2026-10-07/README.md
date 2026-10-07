# 2.2.0 实施验收

实施日期：2026-10-07 至 2026-10-08（Asia/Shanghai）。本目录区分代码审查、机器执行、模型辅助判断和未验证边界；最终源码摘要及完整检查结果见 [implementation-manifest.json](implementation-manifest.json)。

按[计划](../../superpowers/plans/2026-10-07-tian-shu-workflow-and-verification.md)交付了单一 DAG 与 Mermaid、生成后目标/流程/代码三维审核、每轮检查点与范围/收敛检查、近距离提示与分页披露、持久专家与受限 P2P、先盲审后回应、经验候选/晋升、快速流程、Markdown/KaTeX、纯函数数学计算，以及订阅额度/模型池/余额耗尽的即时回退。配置默认兼容旧流程；严格执行、严格双审与持久化/P2P 等开关见 [任务流程与验证](../../任务流程与验证.md)。

## 最终机器验收

- TypeScript 检查与构建通过，13 个预设从真实 DSH standard 重新生成。
- 完整单元测试 439/439 通过；行 95.85%、分支 82.37%、函数 93.20%、语句 89.35%，达到原仓库阈值。
- 完整宿主集成结果见 manifest：使用真实 DSH/Cordis/Retry/AgentLoop，生成供应商为确定性 mock，Jev 为隔离的本地 HTTP mock；不是向 Claude 等付费订阅发送测试请求。
- [浏览器 QA](task-flow-qa.json) 使用实际 DSH React、Markdown/KaTeX、SwarmService 和生产 RPC helper。1280 与390宽检查真实SVG、公式、三维未审核状态、源码、刷新、缩放、失效图与RPC失败回退；控制台无错误。
- [基准](workflow-benchmark.json) 含20类本地流程与6类计算、100次样本、P50/P95/P99/RSS及环境。原始在线20题仅提供评测样例；token节省28%没有测得。
- [发布包检查](package-check.json) 验证实际 npm dry-run 包含入口、客户端、流程/审核/持久化/数学模块、预设和技能，排除私有缓存；未发布到npm。

## 正反交叉审查中的修复

[功能专家记录](functional-final-review.json)与[工程反方记录](engineering-final-review.md)及算法专家回归推动以下修复：

1. 真实宿主 `maxDepth` 是绝对深度，规划审核应设1；同时要求provider实际声明路由、结构输出、工具过滤、persona和depth能力。实际只读Agent读文件成功，发出的write被宿主拒绝且无产物。
2. 技能目录/子代理通知也可使用user role，必须按人类来源筛选原始需求；同ID修改文本用digest触发新需求版本。旧运行专家在下一次工具调用前失效；上下文、P2P、ACK、旧证据和连续会话也绑定需求版本。
3. 流程改版重新生成L0/L1引用；累计重复证据不假装新进展；完整交付以L2保存，作者过程在盲审初轮屏蔽；冻结后的response不重开已完成节点，也不替代原初审门禁。
4. 额度终态先于宿主next/长退避；全备用耗尽不外层重启。健康态在恢复动作前持久提交；持久失败终止恢复。已确认额度域不由十分钟恢复计时解除。
5. 工具输出省略可选undefined、拒绝非有限/宿主句柄，满足真实DSH的lossless JSON。测试使用独立临时工作区，保留未知写入租约阻断。
6. 预算在线变化保留已消费记录，原请求结算后再按新限额启动；缺token/费用估计时拒绝正上限。Jev全部豁免；未报告token/费用标unknown，费用零仅表示已知subtotal，另计unknownCost。
7. 设置页保存模型链保留显式policy，资源类型来自后台同源推导；Mermaid源码不被文本裁剪截断；网页分别展示目标、流程设计、语法、投影和语义结果。

## Jev 实际调用与审批边界

本次采用 `typesafe-ai` 技能与官方 API/Noul 文档。实施初期实际调用了 `mcp__jev__jev_check`，原始输入、概率、用量与时效范围保存在 [jev-routing-review.json](jev-routing-review.json)；该次只审核当时的路由实现摘要，不证明全部后续代码。

最终追加 `mcp__jev__jev_health` 被工具审批策略拒绝：`MCP tool call requires approval, but approval policy is never`。原始错误见 [jev-final-attempt.json](jev-final-attempt.json)。没有通过其他工具绕过，未伪造最终模型批准。规划双审机制则由真实宿主与独立Agent、隔离Jev HTTP mock实际验证。

## 验证范围

原生Codex/Claude包未安装在测试profile；其内部重试及外部子进程停止没有验证。宿主多数prepareCall异常绕过request-error，因此即时回退只对已测公开请求错误/解析预检路径成立。实际生成模型完整用量、物理HTTP计费、NFS掉电/分布式并写、任意shell的OS隔离及完整DSH浏览器登录认证链均未由本次测试证明。新功能默认范围没有依据未知收益全部强制开启。

同步发布以经过验收的同一文件树为准，保留两个仓库的原有历史；源目录与release目录均需干净，GitHub main提交由最终发布结果确认。工作树备份保存在workspace外的临时目录，不写入Git。
