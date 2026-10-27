# dsh-agent-swarm 3.1.6 代码审查与验证

本记录只存在于源码仓库，不进入 npm tarball 或 GitHub release assets。

## 审查范围

- 运行、状态和持久化：分片状态、增量提交、任务终结清理、路由健康与长期资源回收。
- Agent 生命周期与控制面：一次性和持久专家、取消、迟到请求、任务级控制记录清理。
- 前端：设置连接代际、Jev 凭据保存、任务进度缓存容量、隐藏页轮询、Mermaid 渲染安全。
- 构建与发布：Mermaid Worker、ESM/CJS 边界、依赖安全、tarball 文件白名单、manifest 与校验和。

## 确认并修复的问题

1. Mermaid 11 的旧依赖链含 critical/high 公告，且 ESM 宿主中的 Worker 使用 CommonJS 入口后会失败。升级到 Mermaid 12.2.0，使用 DOMPurify 3.4.17 与 KaTeX 0.18.10，并为 Worker 指定 `--input-type=commonjs`。
2. 一次性专家结束后，`closedOneShotIds` 依赖 4096 条有界历史，超限后可能放行迟到模型请求。授权判断改为“百工角色子会话必须持有当前活跃 owner 或本次启动授权”，不再依赖历史 tombstone。
3. 任务终结删除控制记录时，持久专家的 route、tool scope、prompt、signal、ready 与 owner 映射未释放；原清理还只按任务 ID 匹配，可能跨根删除同名 `T-1`，并在删掉最后一条记录时不写回空快照。`ForgetTask` 现同时绑定父会话和任务 ID，返回已删除 child ID，服务逐项释放运行时作用域并显式持久化所属根。
4. 连接重建后的迟到设置或 Jev 保存结果可能覆盖新草稿；加入连接代际检查。
5. 任务进度缓存可在最后订阅离开、传输迟到结算时永久占住容量；结算后淘汰空闲条目并唤醒容量等待者。
6. 页面隐藏时专家恢复面板仍轮询；关闭面板时，不可取消的状态或目录读取可能永久悬挂，模型目录读取也没有超时。现在隐藏页跳过周期读取，关闭/连接重建会结算加载令牌，目录读取有 15 秒可重试超时。
7. `swarm_status` 生成完整六图却不渲染；改为紧凑投影，图表只走版本绑定的任务进度接口。
8. 状态段字节统计重复扫描全部历史分片；增加每段不可变字节数缓存，删除和顺序检查改用 Set。跨连接且取消不合作的读取现进入有界 detached 集合，真实 in-flight 诊断包含这些请求。
9. npm tarball 曾包含 159 个内部 docs 文件。`files` 现在只保留用户文档，打包守卫拒绝 PRD、plans、evidence、source、client 和 tests；打包脚本同时产出版本化 tarball 和稳定别名，并修正包内源码断链与开发脚本说明。

## 自动验证

- `npm run typecheck`：通过。
- `npm test`：111 个测试文件，1511 passed，4 skipped。
- `npm run test:integration`：9 个集成文件，49 passed。
- `npm audit`：0 vulnerabilities。
- 覆盖率：语句 88.93%，分支 83.97%，函数 92.32%，行 94.71%。
- 官方 Mermaid Worker：12.2.0，parse pass。
- `pack-release --check-only`：依赖闭包 86 个文件，missing=0，forbidden=0。
- 精确 tarball：298 个文件，无 plans/evidence/tests/source/client。
- 正式 3080 宿主：`dsh-web.service` PID 2331415，插件 3.1.6，Mermaid 12.2.0。
- 正式 Web：五类设置 Tab、74 个可排序路由层控件、真实任务 T-1 与六个 Mermaid 视角均验证；浏览器 page error 与 console error 均为 0。
- 页面验证后已归档本轮的临时 UI 冒烟会话。

## 性能结论

- 50,000 个 context 分片、仅修改任务和 runtime 时，缓存字节统计连续 500 次平均约 0.0010 ms，结果与完整编码字节数一致。
- 同一规模、无结构校验的隔离内存状态提交约 6.7 ms。
- 生产 `FeatureSession` 仍会在增量提交时物化完整视图并执行全量结构校验，因此提交复杂度仍是 O(n)，不能宣称严格 O(1)。这是为了维持跨记录引用一致性而保留的正确性边界。

## 残余结构风险

- 根 Agent 释放后，已加载 session、scheduler 与 FeatureSession 仍可能保留到服务级 dispose。该问题需要按根会话的持久化、重开和并发交接设计统一生命周期，不能以简单删除内存表替代。
- 超大单任务仍受完整状态物化和全量校验成本约束；进一步优化需要分片增量验证与按对象持久化，属于后续架构版本，不应在补丁版中仓促实现。

## 审核边界

Jev 和独立 Agent 结果是辅助判断，不是正确率、执行许可或真实宿主验收。最终结论只由完整测试、精确 tarball、正式 3080 宿主和人工交互证据共同支持。

部署后的七项 Jev 原始结果保存在本目录的 `jev_*.json`。最终 `jev_classify` 将候选归为 `validated_patch`（置信 0.93），`jev_score` 为 2.11/3，`jev_screen` 为 pass、风险 0.01；`jev_check` 对测试、类型/审计、宿主、打包边界和不作严格 O(1) 声明均给出 0.94–0.98 的概率。`jev_ask` 对跨根清理语义的单项判断仅为 0.52，因此该结论继续由代码测试、双路反审和集成验证支撑，不能用 Jev 分数替代。
