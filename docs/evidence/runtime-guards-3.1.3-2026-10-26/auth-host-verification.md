# rc.3 真实宿主授权等待验收

日期：2026-10-26。对象为本轮3.1.3候选的授权模块及主线接线。此为隔离真实SDK宿主测试，模型响应和用户应答提供方为确定性fixture，不连接外部LLM、不向真人发问、不操作3080服务；临时profile、DSH_HOME、工作区和持久状态均独立。

## 结论

本机已安装 `/usr/lib/node_modules/@deepseek-ai/dsh` 的 **0.2.1-rc.3** 中，pending后的 **300002.97毫秒真实观察**通过：模型请求数 **1→1**，`goal.roundsStarted` **1→1**，目标持续为 **active/disarmed**，没有持久`prompt-rejected`阻塞，没有Agent错误。

匹配晚答复经实际`userQuestions.answer`→宿主Inbox→`user/message`日志→任务需求刷新→授权记录`answered`；原插件暂停的同一目标只出现一次resume。`requestRevision`从1到2，`appliesToBinding.requestRevision`同为2，没有答案一入账就自我过期。拒绝/跳过的单测与问答消费不授予额外工具许可；这里的`answered`不代表任务accepted。

**作者验证最终结论**：本报告发现的完成集合核对、历史目标归属和工作/授权交叉等待问题均已修正，并有对应回归；本专项范围未见仍未关闭的P1。后文保留的“建议根处理”“当时未复现”属于发现过程，当前状态以文末“当前已关闭事项”为准。独立工程专项另有54/54通过及无未解除P1的结论，不能把作者验证当作独立审核，也不能把分批结果拼成一次未实际执行的全量验收。

## 环境与工件

- 宿主：系统唯一已安装DSH的CLI入口，未安装另一生产实例；测试没有Web监听端口。
- 临时运行目录：`.omc/313-auth-host`，运行时复制候选lib及声明到独立plugin目录后编译，不从生产链接源码构建。
- profile：`auth313`，DSH_HOME位于临时目录；确定性provider为`swarm-auth-313-mock`。
- 只在隔离副本把天枢的ask工具设为`mode: timed, timeout: 1`，测试调用真实工具返回pending；主源码预设与用户配置未改。
- 临时测试状态显式启用持久化，以便服务有序关闭后校验真实写入记录；没有改变用户的持久化偏好。
- [五分钟运行原始结果](auth-host-five-minute/host-auth-result.json)、[候选模块指纹](auth-host-five-minute/candidate-manifest.json)。原始结果为合成测试数据，问答存储仅包含摘要、选项索引及来源。
- [同步/异步六场景SDK回归结果](auth-host-sdk-smoke/host-auth-result.json)、[对应模块指纹](auth-host-sdk-smoke/candidate-manifest.json)。
- 根统一版本并构建后的 **3.1.3最新短回归**：[六场景结果](auth-host-final-3.1.3/host-auth-result.json)、[最终短回归模块指纹](auth-host-final-3.1.3/candidate-manifest.json)，耗时15.46秒，Agent错误0。未再次运行五分钟；真实300秒观察与新代码短回归分别保留证据，不混淆工件。

## 实际覆盖

| 场景 | 观察与结论 |
| --- | --- |
| 真实pending等待5分钟 | 单个模型请求后停住，目标轮次无增长；维持active/disarmed，goal不是blocked |
| 错call/错误来源的晚答复 | 真实消息投到宿主后没有新增模型请求；不能解除原问题等待 |
| 正确晚答复 | 宿主接纳一次，重复回答被宿主排队守卫拒绝；日志实际入库，授权为answered，需求绑定同步到2 |
| 人工pause后晚答复 | 答案可记录，目标仍paused，resume次数0 |
| 等待期间clear/create替换goal | 新goal身份确实改变；旧答复不能恢复新goal，resume次数0 |
| 正在真实ask工具中人工cancel | 原调用中断，落账cancelled；晚答复入口返回false，模型请求未重新启动 |
| 无应答者 | 实际timed服务返回pending，模型请求仍1，持久记录waiting；没有虚构同意 |
| 同步即时答复 | 新SDK回归中实际`tool/result`提交后消费，origin为tool-result，绑定requestRevision2；不是只测晚答复路径 |

实际turn可以因pre-step拒绝以blocked结束，这与持久goal.phase不同；本测试分别检查两者，未把“某轮停止”伪装成目标已完成。

## 发现并修复的真实竞态

等待旧问题期间创建新goal后，旧实现会用新goal替换私有hold，旧回答可能取得新goal的恢复权。本次在`authorization-runtime.ts:holdForWait`保留最初等待目标身份；新目标可以被保守抑制，但不继承旧答复的rearm权。已补单测，并用实际`goals.clear/create`、真实晚答复和持久记录复验通过。

根主线接线已通过实际测试验证：`tools/result`观察器同步登记内部屏障；真正`session/event tool/result`和`user/message`提交后才能刷新需求并消费。宿主不await最终观察器，没有因此产生暂态放行或日志入库死锁。

## 可复跑命令

默认SDK短回归：

```sh
npx vitest run --config vitest.integration.config.ts tests/integration/runtime-guard-host.test.ts
```

真实五分钟观察：

```sh
SWARM_AUTH_OBSERVE_MS=300000 npx vitest run --config vitest.integration.config.ts tests/integration/runtime-guard-host.test.ts
```

命令要求候选已构建；`SWARM_PLUGIN_ROOT`可指定隔离候选目录。测试自己复制运行工件并创建新home/profile，不改生产。新增集成用例对六场景进行断言；5分钟不是假时钟，也不是用户应答限时。

## 验收边界与接线核查

1. 测试验证rc.3的公开问答/生命周期与本候选行为，使用本地确定性模型；不证明外部模型质量、网络波动、所有长任务必然完成或其他宿主版本行为。
2. 本轮未对压缩后缺少原assistant问答调用、失联/断电重启全集做实际SDK覆盖；模块的保守reconcile与单测不能包装为这些端到端场景已全部通过。
3. `GoalService.complete`直接/Remote入口没有公开前置钩子，仍遵循反方报告的覆盖边界；当前测试不声称百工封住整个宿主所有完成入口。
4. 服务`dispose`已经等待`authorizationRuntime.onDisposed(rootAgent)`与观察落账屏障，再关闭FeatureSession；此项安全收尾接线已完成。专项没有自行修改service/index/runtime。
5. 本次5分钟候选工件已固定指纹。若最终发布代码改变授权/事件/恢复接线，应重新进行对应SDK回归，不能借用不同字节候选的既有结果。

### 历史发现：完成合集核对（已关闭）

最初只读检查主线`BeforeManagedTool(update_goal complete)`时发现，遍历候选任务遇到第一份当前receipt便`verified=true; break`。若同一当前goal下T-1和T-2均已accepted，而之后只有T-2范围内的文件被外部改变，先找到仍当前的T-1可能使T-2的过期证据未被核对。当时建议明确当前goal的必需任务集合并逐项验证，不能把任意一份任务receipt当作全部任务的证明。该短路检查随后已移除。

随后又发现，机械要求整段会话所有历史任务都匹配新goal，会让旧goal的accepted阻止新goal完成。最终由服务器绑定稳定`runtimeGoalId`区分当前义务和明确历史目标，并保留同goal修订使旧receipt失效的检查；对应独立回归已通过，详见文末关闭记录。上述SDK问答fixture不承担整个完成集合的证明。

本专项既参与实现又做本机验证；报告属于作者验证。最终独立正反复审、全量兼容测试与Jev审查仍由根与其他代理完成，不以本报告替代独立终审。

## 历史发现：多原因等待恢复（已关闭）

中间复核阶段，根已补关闭时await授权结算/私有hold清理，再关闭FeatureSession；已补只读、已审且规范路径不相交的独立任务判据，并要求特定工具匹配真实ready节点。完成集合当时已改成锁内逐项检查，稳定目标归属随后继续补齐。

该阶段发现一处**代码级交叉等待风险**：`resumeRuntimeWork`先删除`runtimeWorkHolds`，之后才检查未决授权。当“长工具先导致goal被工作等待暂停 → 用户输入触发ask并得到pending（授权hold本身没有disarm所有权）→ 长工具先结算 → 用户最后答复”时，工作hold可能提前丢失，最后无人恢复goal。当时尚未用SDK fixture复现，因此没有将其包装成真实服务器故障；随后已按这一交错补真实服务链路回归并关闭。

最终保留工作hold直到所有暂停原因解除（或目标/人工停止使其失效），并在授权答案安全落账后由`afterDecisionSettled`通知原等待所有者重新判断。没有让两个控制器各自无条件resume；本专项提供协调器钩子，根完成service接线。

## 当前已关闭事项

| 发现 | 当前实现及复验 | 状态 |
| --- | --- | --- |
| 一份当前receipt掩盖同目标另一任务的过期产物 | 目标完成在taskLock内逐项检查当前必需accepted任务；改变任一任务真实产物即拒绝 | 已关闭 |
| 不同历史目标的receipt阻断新目标 | 建卡/首次接受由服务器绑定稳定`runtimeGoalId`，只排除已明确属于其他goal id的历史任务；旧卡不能直接改属新目标 | 已关闭 |
| 把同goal修订误当历史而跳过 | 相同goal id的新revision仍使旧receipt失效；没有归属的legacy任务不会静默消失 | 已关闭 |
| 工作hold在授权待答时提前丢失 | `resumeRuntimeWork`保留hold，授权真实终态落账后通过`afterDecisionSettled`泵原等待所有者；暂停、stop、目标替换不复活 | 已关闭 |
| 关闭存储与异步答案落账竞争 | 服务关闭先await授权与观察屏障，再保存检查点并关闭FeatureSession | 已关闭 |

完成集合及历史目标三项由[独立工程报告](engineering-independent-review.md)与[机器结果](engineering-independent-results.json)支持：5份定向测试54/54通过、0失败、0跳过，本专项范围无未解除P1。该独立结果包含多任务过期产物、不同goal历史隔离、同goal修订失效和legacy不绕过等反例。

交叉等待另有[真实服务级专项回归](../../../tests/unit/runtime-work-wait.test.ts) **5/5通过**，使用实际`intSwarmService`、FeatureSession/授权仓库、延迟确定性子任务及公开goal接口替身，验证：工作先暂停→ask pending→工作先完成仍不恢复→真实答复经消息来源/需求刷新安全落账→恰好一次resume；同时覆盖拒绝答复、人工pause、替换goal与stop。委派调用保持一次，重复答复不重复恢复。它关闭服务级P1，**不冒充真实SDK服务器中长工具与问答并发的端到端实测**。

300秒原始工件只对应其[固定模块指纹](auth-host-five-minute/candidate-manifest.json)。之后的goal归属、完成集合及多原因等待修复，分别由最新短SDK回归、服务级5项回归和独立工程54项回归验证；没有将早期候选的300秒记录改写成最终发行包同字节测试，也没有再次运行300秒。最终发布工件的构建/整包验证与收据由根提供。

目前保留的是本报告已列明的能力与覆盖边界：原生SDK/Remote complete的前置hook缺失、未实测的压缩/断电全集、确定性provider不代表外部模型质量。它们不能被写成已验证能力，也不应与上述已关闭发现混为仍未修复的P1。
