# 3.1.2实施、rc.3兼容与发布证据

日期：2026-10-25。已完成本机升级和[GitHub v3.1.2发布](https://github.com/zhairy/dsh-agent-swarm/releases/tag/v3.1.2)。唯一系统宿主为`/usr/lib/node_modules/@deepseek-ai/dsh`0.2.1-rc.3，CLI与真实设置页版本一致；插件3.1.2，最终PID4093920、127.0.0.1:3080、NRestarts=0，临时4186/9229已关闭。以下保留候选过程与最终结果，不把过程中的失败或限制隐去。

## 实现与设计吸收

- [Ruflo研究](../../plans/2026-10-25-ruflo-design-adoption.md)固定提交`fe99f748c577158ec3e517c7b421670a4601f54f`，区分宣称、代码、实验和宿主接线。吸收独立工作区、读投影/导航分离、来源候选、基线回放；不引入Ruflo依赖或第二执行控制面，不复制其完成/超时/静态模型策略。
- 原生`conversation.view`order20注册任务进度；六图导航、单画布、任务/节点选择、缩放、源码/导出、版本与新鲜度；rc.3允许视图进入More，普通/御史/规划审核不自动查询父根。
- `TaskViewStore`按连接generation/root/task共享单飞读取；缓存硬上限8，含目录；5秒可见周期，15秒取消展示读取，2/5/15秒退避。取消不停止业务，不合作请求未结算不补开；迟到响应不覆盖新任务。失败保留正确快照及过期标记。
- 新只读`swarm.taskIndex`只列真实根任务摘要；宿主已加载的真实根可恢复受支持状态而无需先请求LLM，任意字符串不能建立根。没有增加完成或执行入口。
- 可选`swarm_experience.action=record_tool_candidate`只保存来源与隔离元数据；`evaluation=unavailable`、`executionEnabled=false`，文本经验晋升拒绝工具候选，召回排除、恢复拒绝激活状态。引用不是实际沙箱结果或执行权限，不自动开启经验/持久化设置。
- 手工维护交接精确增加3.1.2来源；v1与旧入参兼容，未知未来来源拒绝，不自动重放旧委派。

当前仍没有3.1.3规划的完整授权等待/验收receipt/全历史结构守卫，也没有3.1.4自动Canary。代码新增UI取消点不构成长期Agent时限。

## 已完成候选验证

| 验证 | 当前结果与边界 |
| --- | --- |
| 构建/typecheck | 通过；所有新客户端模块进入bundle |
| 全量单测 | 最终97文件、1333项通过；包含真Store/乱序/取消/容量/目录/候选/冷恢复及两项P1负向回归 |
| rc.2首轮真实宿主集成 | 8文件、44项通过；供应商是显式fixture，不是外部模型长期稳定性证明 |
| rc.3首轮真实宿主集成 | 8文件、44项通过；公开conversation/RPC/session/goal兼容；最终候选仍复核 |
| 隔离公开候选 | 5入口、80依赖模块、缺失0；81编译JS与源码构建一致；无私有计划、证据、PRD或测试进入包 |
| 内存交接check-only | 1根、4任务、约1.96MB，schema/身份/摘要校验通过，尚未stage或消费，不代替最终切换前快照 |

最初全量测试在客户端模块拆分期间失败，旧测试loader不认识新Store；更新真实模块装载及保留负向断言后全量通过。候选登记回归最初错误假定stateBytes不变，已改为允许存储候选增长、同时要求任务/门禁/合同视图不变。

## 宿主升级风险与处置

[反方记录](negative-review.md)已真实复现本机calculator精确rc.2 pin在rc.3拒装。须逐项处理profile原有兼容包及官方native bundle，不使用全局版本豁免或取消供应链策略。兼容副本仅在隔离目录准备，实际生产变更与39bundle保留情况待切换后核对。

内存任务原始备份位于用户0700/0600维护目录，不进入仓库或发布包；临时本机inspector读取后关闭。维护不发起业务任务、不重放交易或其它副作用，正式切换前再次读取running/待答和最新状态。

## 后续验收与发布门槛

真实rc.3浏览器需覆盖六图/任务切换/不同root同名T-1/普通与御史空态/窄屏More/隐藏停止请求/脚本错误；正反Agent与明确payload Jev记录保留未覆盖边界。仅全部所需验证、正式交接与本机实际版本确认后，才将资产标为validated并推送GitHub3.1.2。

## 最终部署与发布

上述门槛已在本轮限定范围完成。真实3080旧根读取4任务，六种视角逐一渲染且每次1个SVG，T-4/T-1切换正确，合同默认收起；可见6.3秒产生2次任务读取，切回聊天6.3秒新增0次，95条既有模型行可见，页面脚本错误为空。CLI与Web设置均显示rc.3；匿名任务RPC返回401；实际Jev健康为jev-1.14.0，16个模型提供方已注册。见[生产界面](production-web-verification.json)、[宿主检查](production-host-checks.json)。

受限交接已消费且只消费一次，4任务/33委派/53材料的版本、引用、正文、摘要和委派事实保全，旧绑定仅revoked/suspended，没有恢复旧进程或重放业务。见[恢复验证](restoration-verification.json)。维护VM动态导入引起的一次意外重启及精确状态重建，完整留痕在[维护事件](maintenance-incident.md)，不能称整次维护无错误。

39个配置bundle及顺序保留；除Swarm外，5个旧本地兼容包只追加精确rc.3元数据，业务文件哈希不变，两个native使用官方rc.3。完整约束复扫39/39匹配，原有disabled设置不变。最终共8条依赖改变。第一次实际启动发现quant漏扫和pi-ai整体配置失败，补齐quant并重新验证59个工具与8项纯计算后受控重载，最终启动无上述错误。

既有OpenCode同步定时器并发刷新过模型目录，未用旧备份覆盖它；该同步器曾把上游Google协议误当成当前宿主支持，已增加实际`hostAdapter.supportedProtocols()`筛选、整份`Config`校验及并发编辑保护。实际列表/生成结果保留4条受支持自动路由、隔离1个不支持模型；未更换凭据或现有受支持路由的API地址。见[宿主协议检查](opencode-host-contract.json)。这些本机脚本/其它插件兼容副本不在Swarm发布包内。

首个pnpm安装输出Done后工作线程未退出，记录SIGTERM，没有伪造其退出码；随后以仅当前进程`PNPM_MAX_WORKERS=4`执行frozen-lockfile验证退出0，quant补充事务也正常退出0。没有更改全局release-age、版本豁免或Jev配额。安装日志中旧unused patch/peer警告保留；不以警告本身推断已启用插件失败。

候选的[七类Jev审核](jev-candidate-review.md)保留screen=review、0.75证据阶段评分及生产未证明的低分；获得新生产证据后[再次check/classify/health](jev-production-review.json)，发布准备命题0.79、分类ready_to_publish_bounded_release=0.99，未刷分或用高分覆盖低分，概率不替代实际验证。

代码提交`68a9391a43f8d284f20d2bb2fb248ea363c30fe7`，公开main/release分支/tag指向`f3c5db8150050585f20b18a45f64a3560533b74c`。五资产为tarball、中英说明、manifest、SHA256SUMS；匿名下载全部逐字节一致，四项校验和通过。包1,339,511字节，SHA256为`32cb1913c337f0ca8d93d8c2c2d5c11de237c86a0475a2afc2f6ae3980dacb69`。见[发布下载验证](publication-verification.json)。

验证边界：未运行多小时业务、真实Codex/Claude生成或交易；没有将御史预设根的空态冒充完整原生盲审子会话导航验收。3.1.3完整授权等待/验收凭证/全局新意及3.1.4治理仍是后续计划。
