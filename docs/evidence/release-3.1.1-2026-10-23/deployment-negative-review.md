# 代码审查报告：3.1.1 正式部署追加反方复核

## 1. 总体评价

* **评分**：⭐⭐⭐⭐☆（4/5，候选代码和本次受控部署满足发布条件，保留长期运行与后续功能边界）。
* **结论**：**未发现本轮尚未解决的代码或部署发布阻断，可以进入 3.1.1 发布收尾。** 发布前仍须按实际结果更新 candidate manifest、发布说明和校验和；GitHub 发布后独立下载核对资产。本报告不把尚未发生的推送、标签或发布记为完成。
* **角色与权限**：独立反方只读复核源码、候选包、生产验证摘要、进程、监听和安装目录。仅新增本报告；未修改生产配置、会话、路由或状态，未读取 `raw/live-memory` 正文，未触发模型请求、业务续跑或发布。

## 2. 详细审查

| 级别 | 位置 | 问题描述 | 改进建议或结果 |
| :--- | :--- | :--- | :--- |
| 通过 | `src/memory-handoff.ts` | 3.1.0 维护交接使用精确来源、同根/同工作区、完整 schema、摘要、0700/0600 权限和单次消费。 | 已核对真实代码，不接受任意新版本或伪造旧身份；消费前后继续校验文件身份与内容。 |
| 通过 | `src/feature-session.ts:306` | 恢复不能把旧运行记录当成已确认可继续的执行。 | 原 active 绑定转 suspended，旧线程关闭；未结算委派转 `recovery_required`，运行节点阻塞，副作用需核对。 |
| 通过 | `src/service.ts:586` | 消费应晚于特性初始化和控制/线程身份验证。 | `commitRecovery()` 在恢复链路成功后调用；失败初始化保留待交接文件。 |
| 通过 | 生产恢复摘要 | 旧生产内存态不能因升级丢失任务、材料、证据或版本。 | 三份受限摘要报告：4 任务、33 委派、53 上下文保全；上下文摘要和委派证据/版本一致；旧 active 绑定为 0；没有由验收启动模型请求。 |
| 通过 | 正式宿主进程与 profile | 并行宿主或安装错位置会使测试和实际加载不一致。 | 本审查实际看到唯一 DSH Web PID 2432406；`dsh-web.service` active/running、MainPID 同一；仅 `127.0.0.1:3080` 监听，9229 无监听；入口实际落在 `/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`。 |
| 通过 | 安装目录与发布 tarball | 本机安装、公开候选和已验证代码可能不一致。 | 本审查逐文件比较 tarball 的 279 个文件与正式安装目录，差异 0；含 80 个编译 JS。安装插件为 3.1.1，系统宿主为 0.2.1-rc.2。此前已核对运行源码与公开候选一致及闭包 79 模块缺失 0。 |
| 通过 | profile 兼容摘要 | 升级本插件不应牵连其他插件依赖。 | 摘要中依赖变更仅 `dsh-agent-swarm`，bundle 列表不变，新宿主 fatal 错误行数 0。本审查额外读取新 PID journal，未匹配到 fatal/Unhandled/uncaught/Error 行。 |
| 边界 | 已结束的 3.1.0 一次性审核 | 历史审核没有本次新增的控制记录，不应为补 UI 制造新的执行身份。 | 保留只读，控制 RPC 拒绝；不伪造历史可续跑身份。新审核的登记和实际模型观察由本轮回归/隔离宿主覆盖。 |
| 边界 | `release-manifest.json` | 本次复核时 manifest 仍为 `candidate`、`releaseReady:false`。 | 这是待主线完成的发布收尾，不是代码缺陷；必须在推送前按实际生产证据更新并重算 SHA256SUMS。 |

### 独立执行的验证

本审查实际读取以下摘要，未读取对应原始会话或内存导出正文：

* `/home/zhairy/.dsh/backup-v3.1.1-handoff/restoration-verification.json`
* `/home/zhairy/.dsh/backup-v3.1.1-handoff/production-verification.json`
* `/home/zhairy/.dsh/backup-v3.1.1-handoff/profile-compatibility-verification.json`

三份摘要分别确认：pending 消费一次及恢复后三版本/ref 保全；4/33/53 数据、上下文 digest 和委派事实证据保全；profile 仅本插件依赖变化。生产摘要同时记录公网 example.com 返回 200、回环目标以 `WEB_BLOCKED_URL` 拒绝，验证发起模型请求为 0。

本审查另外实际执行进程/监听/systemd 和文件内容比较，而非仅相信摘要：

```text
host: /usr/lib/node_modules/@deepseek-ai/dsh, version 0.2.1-rc.2
systemd: active/running, MainPID 2432406
listener: 127.0.0.1:3080, PID 2432406; no 9229 listener
installed plugin: /home/zhairy/.dsh/local-bundles/dsh-agent-swarm-v3.1.1-d0cf3d7b193d
installed version: 3.1.1
tarball files compared with installed directory: 279
compiled JS included: 80
file content differences: 0
tarball SHA256: d0cf3d7b193d50dd4e220d70beaa490dfd1255df276e448b5e92b4fe75b10dc0
public package dependency closure: 79 modules, missing 0
candidate SHA256SUMS: all entries pass
```

最新交接导出由主线报告为 1,958,510 字节，替换了此前约 1.57 MiB 的过时捕获；本审查没有读取该导出正文，不将字节数写成自己重新测量的结果。

主线另外完成了真实 3080 页面验收：根长会话 95 个模型行及 3 个流程卡、历史规划审核显示 Codex/gpt-6.1-sol/xhigh、持久疾风子会话三个选择控件与选择按钮可用、没有为测试而保存业务换模、页面 alerts 为空。匿名 RPC 返回 401、真实 Jev 健康为启用且模型 1.14.0。本审查将这些作为主线实测结果，未把它们冒充自己另开浏览器或另发收费模型请求所得结果。

## 3. 实现契约与剩余边界

本轮不再修改运行代码。源码与真实恢复结果共同支持的契约是：

```text
最新的受限内存态交接
  → 同根/同工作区/schema/digest 验证
  → 恢复数据、暂停旧执行身份
  → 初始化成功后单次消费
  → 正式唯一宿主只读验收
  → 更新 manifest 与校验和
  → 发布与匿名下载复核
```

交接仍是一次性维护桥接，不等于开启持久化；部署后再次重启应重新交接。4 MiB handoff 上限继续有效，不能扩大宣传为任意 16 MiB 内存态均能交接。暂停/撤销的旧绑定不会自动复活；历史聊天不等于当前执行许可。

本次通过不表示多小时外部模型永不超时、任务永不停滞，也不表示已实现全历史语义循环证明、授权问题持久生命周期、进度抽屉或自动工具/工作流演化。上述内容仍按 3.1.2–3.1.4 规划实施。

## 4. 发布收尾建议

保留当前已验证 tarball，避免证据文档收尾时重新构建出新的未经部署资产。更新 manifest 和发布说明后重新执行 `sha256sum -c SHA256SUMS`；最终公开提交、标签、Release 和匿名下载的 tarball 摘要应全部记录。无需再次重复已通过的全量测试，除非源码或实际运行文件发生变化。
