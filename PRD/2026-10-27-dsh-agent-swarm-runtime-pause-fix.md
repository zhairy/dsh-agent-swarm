# DSH 百工长任务暂停与专家误失败修复

## 1. 背景

会话 `session-90316032-52f5-4980-9447-fcb40dc36f35`（“缠论引擎重构”）在长任务末尾出现两类问题：

- D-29 至 D-36 的只读/验证专家在子会话启动后立即失败，错误对外仅显示 `error`。
- 天枢第 4 至第 9 轮多次以 `turn/end reason=blocked` 结束；用户从暂停点继续后，经常只前进一个 step 又再次暂停。

## 2. 根因

1. `intentHistoryUnavailable` 被错误当成“需求或合同失效”。宿主压缩后无法读取完整历史，但任务卡、冻结版本和自包含委派 prompt 仍有效；子会话启动与工具守卫因此被全部拒绝。
2. 运行进展指纹只记录工具名。连续编辑不同文件时都记为 `edit`，第三次命中后被误判为 `LOOP_DETECTED`。
3. 用户恢复令牌在第一个非人工 step 被删除。显式继续只允许第一步，后续 step 或 model request 再次触发同一暂停。

## 3. 修改

- `src/service.ts`
  - 工具活动指纹改为“工具名 + 规范化参数摘要”。
  - 用户输入恢复令牌保持到 `turn/end`，并作为 `root-round` 的恢复事件。
  - `goal/change(operation=resume)` 建立一次有界恢复窗口。
  - 需求历史不可读不再单独阻断已冻结、版本一致的专家会话。
- `tests/unit/runtime-safety-adversarial.test.ts`
  - 覆盖不同参数的连续 `edit` 不被误判为循环。
  - 覆盖 `goal resume` 可恢复被进展守卫暂停的轨迹。
- `tests/unit/runtime-work-wait.test.ts`
  - 覆盖需求历史暂时不可读时，版本一致的专家仍可启动并执行只读工具。

## 4. 风险与边界

- 相同工具、相同参数的重复调用仍按原规则检测，防止真实循环。
- 合同版本、任务身份、工作区租约、授权等待和写入守卫不放松。
- 规划审核仍可因需求历史不可读而拒绝旧批准；本次只放开已有冻结合同下的专家执行。
- 历史记录中已经写入的失败与暂停状态不会改写。

## 5. 验证

- 单元/回归：109 个文件，1454 passed，4 skipped。
- 真实 DSH `0.2.1-rc.3` 集成宿主：3 个文件，20 passed。
- 类型检查、构建、发布闭包校验通过。
- 候选包：`dsh-agent-swarm@3.1.4`，SHA256 `ca4ede03b9093d961a5207536551a71597c4c10584ba8a7406358aba2f374bf8`。
- 在役服务：`dsh-web.service` active/running，`NRestarts=0`，唯一监听 `127.0.0.1:3080`。

## 6. 回滚

profile 备份：

`/home/zhairy/.dsh/backups/dsh-agent-swarm-3.1.4-20261027T105904`

旧 bundle 保留：

`/home/zhairy/.dsh/local-bundles/dsh-agent-swarm-v3.1.3-ea5860c85dfc`

回滚时恢复备份中的 `package.json` 与 `pnpm-lock.yaml`，重新执行 profile 的离线安装，再重启 `dsh-web.service`。
