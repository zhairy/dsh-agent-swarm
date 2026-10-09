# 自动额度路由的 CPU 复核

测量工具：`scripts/bench-quota-routing.mjs`；原始结果：[quota-routing-benchmark.json](./quota-routing-benchmark.json)。Node v24.21.0，5 次预热、30 次样本。所有数据为合成账户目录与窗口，不访问服务、凭据或付费模型。

旧路径在每个 route、每个 tier member 中再次把完整账户目录规范化为 Set。设路由数 R、成员数 L、账户数 A、目录模型数 M，总目录构建工作可达 O(R×L×A×M)。调用链虽然已经按 routeId 去重，但不能消除成员循环内的重复构建。

`createQuotaRouteEvaluator(input)` 为单次同步排序建立局部 Catalog Map：每 provider 规范化一次目录；复制当前 quota、pool 配置、provider 列表和时间快照，保证同一批次一致。下一次排序创建新 evaluator。默认 `getQuotaRouteDecision`、`getQuotaRouteMembership` 不保留状态，继续反映调用者当次可变输入；没有全局 WeakMap、跨请求资格缓存或健康缓存。

| 合成输入 | 来源响应大小 | 未复用目录 median / p95 | 单批 evaluator median / p95 |
| --- | --- | --- | --- |
| 2 账户 × 64 模型，13 路由 × 2 成员 | 4,753 B，低于 RPC 上限 | 1.406 / 1.942 ms | 0.644 / 1.737 ms |
| 32 账户 × 256 模型，32 路由 × 16 成员 | 305,393 B，低于 RPC 上限 | 357.091 / 438.558 ms | 5.434 / 7.231 ms |
| 32 账户 × 512 模型，32 路由 × 16 成员 | 616,689 B，超过当前 RPC 上限 | 820.726 / 1,065.750 ms | 5.856 / 11.976 ms |

三个场景中，全部决策输出逐字段一致。第三个场景只用于展示算法扩展趋势：当前 512 KiB RPC 响应限制会拒绝它，不能把其耗时称为生产可达耗时。小场景的亚毫秒差异会受到 GC 和计时噪声影响，不据此承诺模型任务提速。

规范化目录总构建工作降为 O(P×A×M)，P 为最多五个订阅 provider；成员查找、窗口检查、指纹及输出仍随 R、L、A、W 增长。批次中保留 O(P×A×M) 的规范化集合，加上 quota/config 小快照和决策输出；用单批保留集合与少量复制，换取重复分配与扫描的大幅减少。批次结束后 evaluator 不被来源层保存，后续请求重新检查来源与配置。

回归覆盖：单批 evaluator 与独立 helper 逐字段一致；批次创建后修改原目录、quota 和 pool 配置不会污染该批次；下一批次和独立 helper 立即看到修改。成功保护指纹不含派生 hint、读取时间或其他 provider，同一旧窗口从本地过期转为重新读取不会更换其原数据指纹。

复测时使用私有编译候选，避免触发生产 link 的 HMR：

```sh
SWARM_PLUGIN_ROOT=/path/to/private-candidate node scripts/bench-quota-routing.mjs
```
