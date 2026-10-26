# 授权模块接线契约

根代理负责service/index/runtime/FeatureSession；本专项独占两个authorization模块和专属单测。宿主契约只追加新接口，不调整既有字段。

- `createAuthorizationRepository<T extends AuthorizationState>(store, options?)`：返回 `prepare/get/forTask/dispatchKnown/dispatchUnknown/consumeAnswer/invalidate/cancel`。写入均使用 `store.update({build})` 在存储互斥区核对最新基线，成功提交后再失效读取缓存。默认总容量128、单任务64，满时CAPACITY_EXCEEDED，不删除历史。
- `AuthorizationBinding`：`rootSessionId/workspaceId/taskId/lineageId/requestRevision/cardRevision/workflowRevision/nodeId?`。
- `prepare({binding,operationDigest,scopeDigest,questions,approvalRules,requiresUserDecision:true})` 返回 `{decision,reused}`。dedup不含随机question/call ID或revision；同一操作/范围/lineage重复必须复用原记录，不派发第二问题。技术错误不传 `requiresUserDecision:true`。
- `dispatchKnown(id,{callId,questionDigest})` / `dispatchUnknown(id,reason)`：前者绑定真实ask调用；未知派发保留reconcile，不重发。
- `consumeAnswer(id,{callId,answers,origin,binding,operationDigest,scopeDigest})`：origin必须由host adapter从可信工具结果或真正的宿主user-question-reply构建。answers只有匹配预先保存approvalRules的明确选项才批准；跳过/自定义/含糊只记answered，拒绝选项记declined。真实答复允许requestRevision前进但不扩大操作/范围。
- `createAuthorizationHostAdapter({goals?,projections?,userQuestions?,isLiveRoot})`：`observeCall(execution,nodeId?)`提取真实ask调用及规范问题；`observeResult(decision,execution,result)`读取pending/真实答案/明确错误；`observeReply(decision,message)`验证宿主晚答复来源和原问题合同；`disarmForWait(agent)`先公开disarm，返回原goal ref及抑制句柄；`observePendingReply(agent,decision,messages)`只允许一次可信晚答复输入消费，不预先批准；`getQuestions(agent)`读取公开投影供reconcile；`resumeAfterAnswer(agent,held,consumedDecision)`仅可在可信答案消费后显式调用，不恢复人工paused/blocked/replaced目标。

`observeResult`需接最终 `tools/result` 或在最终结果已确认后调用；`tools/execute`内的next结果仍可能受post-execute改写，不能以中间成功提前授予许可。宿主`dsh-tools/lib/index.js:3505`的final observer不等待Promise，所以根服务需同步登记本次授权落账Promise，并在pre-step/request等待该落账屏障；不能因为通知异步就让下一轮先读取旧waiting状态或暂态许可。具体签名以源码导出类型为准。

## 隐私与恢复

- `AuthorizationDecision.questions`保存问题ID、选项摘要与multiSelect，不保存问题正文；`questionDigest`绑定完整规范问题。`answers`只保存选项索引和customDigest，不保存用户自由文本。工具结果/晚答复方法返回的raw answers仅供即时结算，不追加到guard账本。
- `approvalRules`由服务器操作政策传入；默认空。没有显式规则时真实回答为`answered`，结束问答等待但不授予工具许可。`approved`依然不覆盖宿主审批、门禁或租约。
- `observePendingReply`只发一次输入消费；真正`session/event user/message`到达后用`observeReply`重新核对并调用`consumeAnswer`。答案尚未提交时不能直接approve。
- 若输入在日志准入前失败，先核对宿主原消息，再用`releasePendingReply(decisionId,messageId)`释放相同消息的消费票据；不可盲目重发问题。
- `getQuestions`返回active问题摘要和settledCallIds。continued服务降级或settled超过128时标`partial:true`，不能据缺少列表项认定不存在。
- 用户取消、aborted生命周期、goal替换或Agent释放时调用`invalidateHeldGoal(rootId)`。持有句柄不持久化；重启不能恢复旧进程rearm能力，必须经公开状态核对或用户继续入口。
- 重复`prepare`若`reused:true`且已有不同hostCallId，返回已有决定/等待，不投递新的ask。取消/失效记录不会因重复同操作自动重新打开；只有真实新用户决定/目标阶段经服务核对后才建立新的决策身份。

## 参考接线

```typescript
const call = host.observeCall(execution, matchedNodeId)
if (call !== undefined) {
  const { decision, reused } = await repo.prepare({
    binding, operationDigest, scopeDigest, questions: call.questions,
    requiresUserDecision: true
  })
  if (reused && decision.hostCallId !== undefined && decision.hostCallId !== call.callId) {
    throw new SwarmError('RECOVERY_REQUIRED', '原用户决定仍待处理，不能重复提问')
  }
  await repo.dispatchKnown(decision.id, {
    callId: call.callId, questionDigest: call.questionDigest
  })
}
```

这里的binding/operationDigest/scopeDigest由根服务当前真实任务、操作政策和范围派生，不能从模型回答“已授权”取值。真正缺少用户决定才走此路径，技术故障不伪造成授权。

## FeatureSession 集成补充（进行中）

- 新暴露`features.progress`与`features.authorizations`，两者直接写同一FeatureState存储，不经过另一套WAL。
- 进展谱系需要可核对的owner/task映射。拟导出`getTaskRuntimeLineage({rootSessionId,workspaceId,taskId})`，按这三个稳定字段取规范摘要；服务层需复用该函数，不能用当前revision或随机ID生成新谱系。
- 新FeatureState为schema2，含runtimeControls/progressHistory/authorizationDecisions三dict；旧schema1仍读，恢复保守迁移；schema1带新安全字段拒绝。receipt只验归属/完整绑定/不超前版本，历史可旧版本留存，不作为当前批准。
- **布局指纹兼容需要根处理**：state-chunks增加新dict会改变`state-store.ts:129`的整个spec指纹；保持layout2时，旧layout2的`:332/:386`比较直接失败。不能只增spec假称兼容。需要根在state-store支持明确旧layout2指纹的安全规格回放/迁移（或批准相应更改）。专属测试会保留旧快照/旧WAL升级用例，不重写旧数据掩盖问题。

### 已交付的FeatureSession API与阻断

`features.progress`和`features.authorizations`已暴露。根后续将谱系加强为首次真实用户来源锁定的`progress.bindTask/forTask/lineageFor`，跨同源新任务卡共享控制历史；不能再以taskId变化自动重置全局目标历史。`getTaskRuntimeLineage`仅保留兼容/无任务`@root`哨兵用途，实际授权binding.lineageId优先采用已绑定的progress控制记录。FeatureState validator由根核对control的root/workspace/taskIds归属，拒绝孤儿/跨根/未来绑定。历史receipt允许旧版本保留，但仍须正确root/workspace/task归属、不能绑定未来版本。未变冻结progress页跳过规范正文重解析/哈希，交叉计数仍校验。

已完成schema1读取→schema2保守恢复，旧schema1含新安全集合拒绝；prepared/waiting/unavailable恢复为reconcile-required。没有handoff的内存态仍不恢复历史或启用持久化。memory-handoff只将明确版本白名单增加3.1.3，并保留3.1.2。

2026-10-26类型检查通过；7个定向测试文件84项通过、4项旧布局兼容回归失败，失败原因均为旧layout1/2快照spec指纹不匹配。失败用例位于`tests/unit/runtime-guard-feature-state.test.ts`的最后一组，覆盖layout1/2×快照/WAL。没有修改它们的期望来掩盖问题。

根需在`state-store.ts`显式支持“只新增上述3个dict、旧段语义不变”的已知旧指纹。原始旧状态没有新集合，按新增dict规格重建旧字段的根摘要不变；仍需校验原日志根/链与schema，不能全局忽略layoutFingerprint，也不能将任意不匹配布局视为兼容。该文件超出本专项当前改动授权，尚未修改。

## 授权coordinator接线（src/authorization-runtime.ts）

构造`createAuthorizationRuntime(deps)`需要原计划的`getContext/refreshBinding/getGoals/getProjections/getUserQuestions/isLiveRoot/hasIndependentReadyWork`，以及**`listDecisions(context)`**：必须枚举该root完整且有界的授权记录（含@root），不能只查当前选中的task，否则切任务可绕过已待回答的问题。根可从当前FeatureState的`authorizationDecisions`只读段取值，或等价仓库索引，不读私有宿主文件。`isLiveRoot`必须同时限制百工天枢身份与宿主精确live-root所有权，普通会话不应进入协调器。

返回方法：

| 方法 | 根接线位置及注意事项 |
| --- | --- |
| `beforeTool(execution)` | 真正`tools/execute`调用体之前await；真实ask登记/去重后才next，其他依赖动作等待，安全读取/停止可继续 |
| `observeFinalResult(execution,result)` | 最终`tools/result`，方法同步登记内部Promise屏障，不依赖宿主await观察器 |
| `beforeStep(agent,decision)` | 原FilterPreStep之后、模型步骤之前await；先等屏障；没有ready工作时disarm后reject；匹配晚答复发一次输入票据 |
| `beforeRequest(agent)` | runtime `agent/request`入口await；已有输入票据不能被本入口再次挡住；无票据且待答时禁止新模型调用 |
| `onUserMessage(agent,event.data)` | 真实`session/event user/message`提交后通知；从公开deriveMessages核对实际已提交消息再消费，不信任传入body自行批准 |
| `onToolResult(agent,event.data.message)` | 真实`session/event tool/result`提交后通知；可直接及时结算阻塞式答案。beforeStep/request也会从公开已提交消息补核，避免漏通知死锁 |
| `onTurnEnd(agent,event.data.reason)` | aborted使当前待答决定取消，撤销私有hold；正常blocked等待不得误取消 |
| `onDisposed(agent)` | await后再dispose FeatureSession；释放进程私有hold/ticket，不恢复旧goal |
| `getDiagnostics(rootId)` | 只返回ready/unsupported/reconcile-required及固定原因，不返回问答body |

最终tools/result成功答案**不会立即consumeAnswer**，因为宿主此刻还未把tool/result写入Session；直接refreshBinding可能读到旧requestRevision。协调器在真实日志提交/下一步边界核对后，再调用根的refreshBinding（根持taskLock刷新真实需求并persist）→repo.consumeAnswer→必要时恢复插件自身disarm的同一active目标。

`hasIndependentReadyWork`只决定是否还可推理处理独立工作，不证明任意write都独立。需要等待中实施特定独立作业时，可注入`isIndependentTool(execution,waitingDecisions)`，其判据必须来自实际节点依赖和范围；不注入则除白名单读取/安全停止外保守拒绝。所有许可仍经过原工具审批/版本/租约。

专项单测目前3文件34项通过；5分钟观察仍须真实宿主测试，不能以替身测试当生产证明。全项目类型检查当时唯一失败为主线service尚在接线、未返回新增五个SwarmService方法；授权协调器自身无类型诊断。

### 多原因等待恢复钩子（后续修正）

现增加可选`afterDecisionSettled(agent): void | Promise<void>`，用于根的**既有工作等待所有者**重新判断是否可恢复。它在真实决定已提交、必要的授权hold恢复检查结束后调用；属于同一结算屏障，异步回调未结束前下一请求不放行。回调只能泵本地现有恢复判断，不能递归调用getContext、beforeStep/request或制造新授权。

- 同一终态幂等通知一次；pending/unknown/unavailable不通知。
- 工作先disarm、授权自身没有恢复权时，真实回答或拒绝落账仍通知外层，让原暂停者在所有条件清空后恢复。
- 正常授权自身成功恢复后也可通知外层检查，不由外层重复恢复；外层依然核对id/revision/phase/stop。
- 问题登记时保存进程私有goal ref；目标被替换/修订不匹配时旧答复只入账，不通知外层恢复新目标。
- 最终`ASK_ABORTED`取消不提前泵外层；取消通知延迟到真实aborted轮次处理，此时根必须已同步撤销工作hold。安全取消不能恢复目标。
- 冷恢复丢失原私有goal ref时不冒领恢复权，需要核对或人工继续。

增加单测覆盖“work hold先拥有恢复权、auth hold没有armed所有权”、拒绝答复、异步结算屏障、取消顺序和替换目标。当前授权单测3文件40项通过；真实300秒观察和最新SDK短回归见[验收报告](auth-host-verification.md)。
