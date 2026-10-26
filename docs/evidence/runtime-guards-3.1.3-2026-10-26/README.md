# 3.1.3 运行守卫、设置与恢复证据

本轮目标：完成既定3.1.3运行守卫与用户决定计划，增加设置分类Tab、备用链拖拽，并修复额度回退与连续专家身份恢复。用户已授权本机验证后部署并发布3.1.3。

## 当前验证

- 最后源码单元测试 **1455/1455**，109文件；包含真实旧3.1.2包reader/writer的四种布局/日志/快照迁移，没有跳过。类型检查及diff格式检查通过。
- 源码候选在真实 **rc.3 49/49、rc.2 49/49** SDK集成通过；模型供应商为明确的本地确定性夹具。最终资产相同字节的SDK复验 **rc.3 49/49、rc.2 49/49** 也通过，不把模拟供应商说成真实Claude额度测试。
- [正向授权等待验收](auth-host-verification.md)：实际300002.97ms，模型请求和目标轮次均1→1；晚答复一次恢复，人工pause/stop/replaced不复活旧目标。该300秒工件与之后短回归分别保留摘要。
- [独立反方54项](engineering-independent-review.md)：全部通过，当前专项无未解除P1。覆盖多任务凭证、并发修订、业务ID/数组尾/深度内容、写故障诊断、并行ready不绕计数、旧writer拒绝、不同目标历史及同目标修订。
- [设置真实Web测试](settings-web-review.md)：34交互断言、14落盘核对，最终3.1.3快速回归；五Tab、原生拖拽、Alt排序、保存/刷新和390px均通过。
- [路由与安全继续](routing-recovery-review.md)：272定向单测、10真实Host场景，以及真实浏览器同child D-1→D-2安全继续；副作用仅一次。
- `tests/unit/runtime-work-wait.test.ts`五项服务级交错回归：先工作等待、后授权等待、工作先结算、用户最后回答，原暂停者一次恢复；取消/换目标不复活。这不是所有长任务并发端到端证明。
- [Jev明确payload审查](jev-candidate-review.json)与[最终候选审查](jev-final-candidate-review.json)已运行ask/check/classify/match/score/screen及health。首次match误传window=3由服务400拒绝，保留失败后按接口默认值修正；没有反复抽样取高分。screen要求review，工程指令按不可信材料隔离，人工及独立代码审查不据此授予执行权限。

## 实现与边界

- 当前完整目标的必需任务逐项校验服务器凭证；稳定`runtimeGoalId`区分旧目标，同目标revision仍约束凭证。阶段验收保留历史，不替代当前完整交付。
- 真实问答的回执、输入与需求版本衔接；无答复不授予权限，工作与授权hold分别保留恢复所有权。
- 全历史结构签名、自动激活与恢复有界；工具名/专家角色是控制结构维度，不是新质量证据。真实长工具等待不新增模型轮次。
- 索引平均O(1)，规范结构与内容摘要随输入变化；既有提交交叉校验仍有扫描。没有宣称完整提交O(1)、语义相似度证明正确或所有长任务必然完成。
- schema1/layout1、2保留旧指纹读取；schema2/layout3有能力围栏。3.1.3来源不允许以schema1丢空守卫历史；旧accepted明确为旧政策历史。
- 原生SDK/Remote直接`GoalService.complete`没有公开前置hook，**不在插件完成守卫覆盖内**；保护百工service和受管理工具入口，不猴补宿主。
- 经验权重、语义嵌入与动态剪边/Canary留给3.1.4影子评测，强制门禁不被剪除。继续使用可见时轮询，没有新建推送控制面。

## 发布进度

最终tarball：`release-artifacts/v3.1.3/dsh-agent-swarm.tgz`，SHA256 `ea5860c85dfc6d9c2f1f660de2c2c3296da801c9c71703a651c66a2d8681cf84`。闭包85个文件无缺失，86个编译JS与源码构建一致；公开候选未含私有PRD、测试、状态或审查原始资料。

已将该包安装到摘要命名的本机待用bundle，并在正式profile副本上运行pnpm安装和frozen-lock校验；仅swarm依赖发生变化，其他38个bundle顺序与插件选择保留，四个服务端导出可加载。副本最初漏复制既有patches目录导致ENOENT，补齐相同补丁后通过；未改正式profile，也未放宽release-age政策。

**正式3080已部署3.1.3，GitHub v3.1.3已发布。** 用户确认任务暂停后，权威API运行数与待答数均为0，再执行切换。原候选等待记录保留于检查点；实际结果见下文。

## 正式切换与发布结果

- 切换前实际PID为1291619，已经不同于候选阶段的1041904；core rc.3、插件3.1.2。只导出当前权威FeatureSession，实测已加载数量为0，不把旧PID的内存猜成可恢复状态，不生成空的伪业务交接。没有宣称恢复用户更早重启前的内存任务。
- 当前正式PID **1300135**，3080唯一监听，core继续使用 `/usr/lib/node_modules/@deepseek-ai/dsh` 的rc.3，插件为摘要bundle中的3.1.3；临时9229诊断端口已关闭。
- [真实加载校验](live-loaded-bytes.json)：84个实际已加载服务端模块，含12个指定核心模块，源码字节均与预审候选一致；客户端由独立Web验收验证一致。
- [正式Web独立验收](formal-web/README.md)：10项设置检查、390px/桌面、真实拖拽取消与Alt排序后放弃，保存次数0，页面error为0；任务进度按实际空目录显示，没有生成历史任务、模型请求或新业务许可。
- [本次切换](cutover.json)：实际前后均为40个bundle，顺序一致；直接依赖只改swarm，锁文件packages键新增/移除均为0。原先候选profile副本的39条目记录不是本次切换现场数字。百工配置语义摘要不变。
- 停服后的首次离线安装因dsh-opencode-go@0.1.24的npmjs metadata未缓存失败，保留原失败日志。随后按原有策略在线补齐元数据，4.2秒安装通过，再离线frozen-lock通过；没有降低release-age或修改其他依赖版本。维护脚本已补“新版启动前失败恢复旧依赖与服务、新版启动尝试后禁止盲目降级”的兜底，6项内存桩场景通过。
- 安装结束时配置字节与备份一致。重启后OpenCode Go配置发生重排并出现modelVisibility字段，[观察记录](post-start-config-observation.json)单列保留，不归因于百工，不回滚该后续设置；[百工配置语义比对](swarm-config-observation.json)仍一致，不能说整个profile永远字节不变。
- [Jev部署后边界核对](jev-post-deploy-review.json)支持本机加载证据；审查时尚未发布的事实与后来的发布证据分开记录，模型分数不替代SHA校验。
- 发布地址：https://github.com/zhairy/dsh-agent-swarm/releases/tag/v3.1.3 。公开main/tag指向`046b0065f8bfce3923ddf244313050a61226bf07`；发布时间`2026-10-26T07:39:11Z`（北京时间15:39:11）。
- [远端资产核验](publication-verification.json)：5项资产实际重新下载，大小、SHA256及GitHub digest全部匹配；下载tarball版本为3.1.3，86个编译JS逐一匹配已验证候选。正式profile保持摘要link安装，没有改成会触发注册表查询的file tarball。

发布包含本轮变化的中英文说明、安装tarball、release-manifest及SHA256SUMS。正式观察未发起外部生成模型或真实Claude配额耗尽请求；49+49项SDK集成供应商仍为明确夹具，不扩张为所有长业务必然完成。
