# 规划审核模型显示与子会话切换实测

日期：2026-10-23。宿主版本：DSH 0.2.1-rc.2；候选源码：`.work-v3`。只使用隔离 profile 和确定性模型响应，本项没有重启或修改生产 3080 服务，也不把测试供应商响应视为第三方真实模型请求。

## 根因与修复

- 独立规划审核使用专用 persona，旧界面只识别包名；该 persona 原来仅含 `[[swarm:role=yu_shi]]`，会被判为普通会话。现在兼容识别角色标记，新的规划 persona 也带包名。
- 规划审核不走普通委派的 `onChildStart`，旧逻辑没有登记 `agentControl`，因此无法从控制面查询实际 attempt。现在登记一次性、只读审核绑定；只有宿主 `agent-loop` 的实际 attempt 观测可进入 reviewer 的 `provider/model/reasoningEffort` 和 `planningRuns.actualRoute`。初始候选单独标为 `routeSource: selected-initial`。
- 连续专家保留“取消当前调用 → 宿主确认沉寂 → 显式继续原委派管线”。一次性审核或委派选择仅覆盖下一次请求，当前调用继续；不能人工续跑已结束的一次性审核。选择不修改证据、任务版本、审核 schema、工具权限或工作区租约。
- 一次性选择在模型合法性校验后执行 CAS；覆盖与选择回执间不进行异步持久化，避免会话在等待期间结束后又写回覆盖。正常结算后拒绝再次选择或继续。超时或清理尚未确认不能伪称 actual attempt 已结束。
- 修复隔离浏览器 QA 桥的模块注入：事件投影已拆出 `model-events.js`，QA 桥也必须加载该模块。

## 已执行验证

1. `npm run typecheck`：通过。
2. 模型显示、Agent 控制、规划运行、规划活性 4 个单元文件：63 项通过。
3. 原有真实 DSH 恢复与子会话控制 2 个集成文件：19 项通过。
4. 新增真实 DSH `planning-model-switch` 集成：通过。单个规划审核会话依次请求 `role-yu_shi → reviewer-switched → reviewer-switched`；切换回执仍显示原 actual attempt，后续真实调用才更新 actual；真实 `read` 成功、`write` 被拒，审核记录保存实际的新模型。
5. `agent-browser` 检查隔离真实 Host 子会话与生产 RPC 处理器：打开“模型与恢复”，选择 `recovered/max`，确认先保持 `hang/high` 的 actual 显示，宿主确认暂停后点击“安全继续任务”，最终同一 child ID 调用 `recovered/max`。页面和控制台错误均为空。

浏览器桥地址仅用于本轮 QA：`http://127.0.0.1:4197`。实际 Host 证据见 [browser-host.json](./browser-host.json)，界面结构见 [browser-snapshot.json](./browser-snapshot.json)，截图见 [model-controls.png](./model-controls.png)。QA 结束后已关闭浏览器和桥接进程。

## 验证边界

本项覆盖真实 DSH AgentLoop、只读工具边界、同一子会话换模与生产 RPC 处理器；浏览器页面是隔离 QA 桥，不是生产 3080 的完整会话页面。生产部署后的完整页面复核由主线执行。未更改用户选择的外部 Search/Fetch URL。

## 反方 P1 竞态修复复测

独立反方发现：一次性审核运行中换模后，旧请求的 401 可能让新链指针被误当成失败路由。修复后，`getErrorAction` 捕获的实际失败路由显式传入子会话回退；tried、认证域排除、日志与链尾说明都绑定该失败路由。新选择始终保留为下一请求候选。若用户在备用预检期间再次选择，只有同一逻辑请求、同一底层链代次可以重新进入准入；释放、取消、跨代重新登记不会被旧回调恢复。

一次性结束状态另用单调 `oneShotSettled` 标记，迟到的选择、等待和错误通知均不能重新开放选择，不再依赖可变的原因字符串。该字段为一次性内存记录的可选扩展，现有持久连续子会话快照不变。

复测结果：

- `route-state`、`agent-control`、`client-model-display`：3 个文件 156 项通过，覆盖旧请求 400/401/403/404 后新模型接手、预检期间再次换模、结算后迟到事件。
- 真实 DSH 的成功换模与旧请求 401 两个场景均通过。新版主线 fixture 同时验证缺失上下文引用恢复：成功场景为旧模型读取一次、所选模型后续三次；401 场景为旧模型失败一次、所选新供应商读取及后续四次。所有请求均在同一个审核子会话，真实读取成功，越权写入继续被拒。
- 类型检查通过。真实宿主记录见 [route-race-host.json](./route-race-host.json)。测试供应商仅模拟响应，换模、错误恢复、工具权限与结算由真实 DSH 执行。

命令：

```bash
npx vitest run tests/unit/route-state.test.ts tests/unit/agent-control.test.ts tests/unit/client-model-display.test.ts
npm run typecheck
npx vitest run --config vitest.integration.config.ts tests/integration/recovery-host.test.ts -t '一次性规划审核登记实际模型'
```

本节是实现方复测结果，反方最终复核与主线全量验证应另行记录。
