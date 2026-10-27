# dsh-agent-swarm v3.1.4 证据

日期：2026-10-27。候选提交：`c39893c3d205db7fccb8939a1c694e8f46facc15`。

## 本地与真实宿主

- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npm test`：111 文件，1467 passed，4 skipped。
- `npm run test:integration`：9 文件，49 passed。
- 真实 DSH 宿主：`dsh-web.service` active/running，单实例，MainPID `2104091`，`NRestarts=0`，仅监听 `127.0.0.1:3080`。
- 本地 bundle：`dsh-agent-swarm-v3.1.4-65c1603dc144`，版本 `3.1.4`。

## 浏览器

- 桌面和 390×844 任务进度页均完成真实截图。
- 实际创建只读冒烟任务 `T-1`，任务流程、实时快照、治理修订 `0` 和无治理记录空态可见。
- 页面没有批准、派发、恢复或完成任务按钮。
- axe WCAG 2A/2AA：0 violations；剩余 1 类 `color-contrast` incomplete 来自宿主叠层无法确定背景，未报告确定性违规。
- `console --clear` 与 `errors --clear`：无页面错误输出。

截图：

- `browser-progress-final-desktop.png`
- `browser-progress-final-390.png`

## Jev 原始结果

通过本机 `jev-mcp` 逐项调用七项工具，原始信封保存在本目录：

- `jev_health.json`
- `jev_ask.json`
- `jev_check.json`
- `jev_classify.json`
- `jev_match.json`
- `jev_score.json`
- `jev_screen.json`

结果摘要：`jev_health` 返回 `jev-1.14.0`；`jev_check` 的根因、硬门禁、候选隔离和“不宣称零风险”进入 flags，`release_gate` 保持 uncertain；`jev_classify` 为 `review_needed`；`jev_score` 为约 `2.04/3`（真实宿主和浏览器已过，Canary 显式授权与发布资产核验仍需完成）；`jev_screen` 为 `review`，这是过滤器的保守结果，不是安全证明。Jev 不能替代测试或签发验收。

## 边界

- 真实宿主当前 profile 的 persistence 默认关闭；重启后的任务目录空态是配置事实，不是把历史任务伪装成已恢复。
- Canary/撤回路径已在仓储和集成状态机测试中覆盖；生产默认不启用，必须有明确选择的单 root/task 和真实授权。
- 三组回放夹具不证明真实误停率为零；释放资产、匿名下载、Canary 和回滚检查完成前不能称为发布完成。
