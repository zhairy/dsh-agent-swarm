# dsh-agent-swarm v3.1.5 任务进度图表修复证据

日期：2026-10-27。候选提交：`a1bc2564a69d087cc7bbc07d61fb617fa22de0ec`。

## 定位

实际长任务中，流程重协会产生派生视图；旧实现使用派生版本过滤已提交委派，导致历史节点全部变成 `unknown`。同时客户端在 `accepted/incomplete` 摘要出现后停止轮询，即使仍有 ready/running 节点或在途委派。

## 修复

- 图表委派使用已提交任务版本核对，流程视图仍使用重协后的定义。
- 流程版本变化时，历史已完成节点显示为 `skipped` 并保留原因；运行/失败/阻塞节点显示为 `blocked`，不自动重放。
- 同角色多个 ready 节点使用确定性 fallback，仍优先显式 `node_id`。
- 任务仍有 ready/running 节点、在途委派或阻塞恢复时继续轮询。

## 验证

- `npm test`：111 文件，1472 passed，4 skipped。
- `npm run test:integration`：9 文件，49 passed。
- `npm run typecheck`、`npm run build`：通过。
- 真实 DSH Web 任务：`T-1`，只读多节点冒烟；任务进度从 `0/2` 更新为 `1/2`，第一节点完成后显示“已完成”，第二节点显示“执行中”。
- 桌面与 390×844 截图均从同一次真实任务状态取得。
- axe WCAG 2A/2AA：0 violations；`color-contrast` 因宿主叠层无法确定背景而保持 incomplete。
- Jev 七项原始结果已保存：`jev_ask` 对“真实任务从 0/2 到 1/2 并切换运行节点”的判断为 0.97；`jev_check` 的 `diagram_refresh` 仍为 uncertain，`jev_classify` 为 `review_needed`，因此不把 Jev 当发布证明。
- 发布：GitHub `v3.1.5` 已非 draft、非 prerelease；五类资产已匿名下载并逐项通过 `SHA256SUMS`，tarball 与本地最终包逐字节一致。详见 `publication-verification.json`。

截图：

- `browser-progress-after-node.png`
- `browser-progress-after-node-390.png`
