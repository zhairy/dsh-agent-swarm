# 代码审查报告

## 1. 总体评价

- **评分**：⭐⭐⭐⭐☆（4/5，针对设计与最终隔离浏览器检查，不替代生产发布验收）。
- **摘要**：Ruflo采纳保持百工唯一控制面。隔离DSH0.2.1-rc.3已展示真实任务卡、六图、任务选择与窄屏More入口，未发现跨根串数据或页面脚本错误。历史缓存/版本P1与随后发现的鼠标覆盖问题已分别修复并复测；最终浏览器结论见第7节。各阶段证据保留，不能混用旧摘要与最终资产。

**历史P1（现已按第7节解除，当时暂不建议发布）**：`lib/client.js`摘要`dd1fbbc9940dfea58ef601aed0d520536e228fc640d98bffb977fab22bd7b823`已重启隔离宿主复测。桌面1280×800的任务节点详情按钮被宿主`[data-width-handle="left"]`覆盖，鼠标点击实际命中拖拽层。节点中心约(414.5,448.9)，命中div.wSkVaW_widthHandle；agent-browser拒绝虚假点击。见[几何与命中证据](qa-pointer-overlay.json)。这不是页面脚本错误，不能因errors为空就忽略；键盘可用于继续独立路径，但不替代鼠标验收。应通过公开布局能力或插件自身安全布局解决，不修改宿主私有DOM/打包代码。

## 2. 检查对象与证据

宿主是`.sandbox/dsh-0.2.1-rc.3`，独立`DSH_HOME=.omc/release-312/web-home`，只监听127.0.0.1:4186；3080正式服务没有被本检查重启。仅本机fixture适配器生成确定性文本/真实工具调用，Jev关闭，没有调用外部模型或业务/交易服务。首次Web夹具直接创建任务，第二轮又加入真实AgentLoop的`swarm_task_card`回执，避免用手工DOM代替聊天投影验证。

第一轮证据保存在忽略目录`.omc/release-312/`：`qa-browser-diagrams.json`、`qa-cross-root.json`、`qa-ordinary-isolation.json`、`qa-reviewer-isolation.json`、`qa-narrow.json`、`qa-tab-hidden.json`、`qa-browser-performance.json`、`qa-first-round-bindings.json`。最终需要以另行固定的客户端摘要追加复测结果。

| 检查 | 第一轮实际结果 | 解释边界 |
| --- | --- | --- |
| 六视角 | 六个视角逐一生成SVG，每个时刻只有1张图 | 使用小型只读DAG/零真实委派；不是所有大型图压力测试 |
| 任务切换 | T-1→T-2→T-1，原图表视角恢复 | 同根两任务；没有执行业务步骤 |
| 跨根同名T-1 | 第二根显示自己的任务标题与root身份 | 读取隔离，不证明多用户细粒度ACL |
| 普通/御史入口 | 安全空态，观察窗内新增百工RPC为0 | 首轮御史为独立预设会话；第二轮改为真实parentAgent子会话，待最终复测 |
| 窄屏390×844 | 原生More菜单包含任务进度并可打开；document宽390无水平溢出 | 图表可缩放；不声称所有设备完成无障碍认证 |
| 退出Tab | 6.3秒内新增taskIndex/taskView为0 | 单个隔离客户端观测，不代替永久挂起/断连单测 |
| 聊天工具卡 | 真实工具回执展开后为紧凑摘要，无图表面板 | `qa-chat-compact.json`；最终还需验证被动订阅零RPC |
| 页错误 | 捕获的window/error、unhandledrejection及agent-browser errors均空 | 仅当前路径 |

`ctx.slots.entries(key)`属于当前rc.3的公开检查面，见`dsh-client-ui-renderer/lib/types/client/registry.d.ts:164`；不是猜私有API。实际真实工具卡也出现“请打开任务进度选项卡”的紧凑提示，页面图表面板数为0。

## 3. 性能实测

5次预热、30个样本，测量从select的change事件到替换SVG，再等待两次requestAnimationFrame；六视角循环，小型任务图，headless Chromium，390×844。p50=50.0ms、p95=66.6ms、p99=66.8ms。原始每样本在`qa-browser-performance.json`；这些是第一轮夹具DOM响应，不是INP、真实模型延迟或系统极限，不移植Ruflo基准倍率。

## 4. 当时待最终构建复测的项目（现状见第7节）

| 级别 | 位置 | 问题与处理 |
| --- | --- | --- |
| 🟡 待验证 | 历史聊天被动读取/缓存 | 反方P1修正后，真实展开卡必须0新增RPC，不能占据全部活动缓存槽位 |
| 🟡 待验证 | 目录新版本与旧accepted正文 | 不能用旧终态锁住当前投影；需单测与最终客户端确认stale及重取 |
| 🔵 边界 | 发布/宿主 | 本报告不替代正式3080状态保全、rc.3兼容升级、最终资产闭包与匿名下载校验 |

部署命令经验：DSH的`web --help`会挂载profile，不是纯参数解析。一次读取帮助未显式设置DSH_HOME，触发原profile兼容检查和预设部署，但没有重启3080；此后所有宿主命令均显式使用隔离DSH_HOME。后续维护脚本应在调用CLI前断言目标home，不将help当无副作用的探测。

该命令使用的是沙箱rc.3入口`/data/nas/public/swarm/.work-v3/.sandbox/dsh-0.2.1-rc.3/node_modules/@deepseek-ai/dsh/lib/bin.js web --help`，cwd为`.work-v3`，因未设置DSH_HOME而读取`/home/zhairy/.dsh/profiles/web`。已确认expert-mode部署日志；现有预设文件mtime集中在2026-10-25 03:05:08（+08:00），含`preset.yml`、`agent.cordis.yml`、`cordis.patch.yml`、`index.js`及专家方法/路由等。命令前没有文件摘要，不能区分相同字节覆盖与内容变化，也不能由mtime穷举其它副作用；完整元数据只保存在0600的`.omc/release-312/qa-help-profile-side-effect.json`。不将其与根线程另行调查的03:01宿主重启混为一事，未再运行非隔离CLI。

## 5. 验证建议

最终构建后重载隔离宿主/浏览器，重新绑定`lib/client.js`摘要并复跑六图、聊天紧凑零RPC、隐/显、普通/真实御史子会话与跨根检查。并行开展的全量单测/集成、反方代码复核及Jev判断由各自证据记录；不得因本报告打分跳过。

## 6. 修复覆盖问题前的候选复测（历史阶段）

已在候选客户端摘要`dd1fbbc9940dfea58ef601aed0d520536e228fc640d98bffb977fab22bd7b823`之后重新启动4186宿主并重载浏览器，证据见[当时绑定](qa-browser-before-pointer-fix-bindings.json)、[当时浏览器结果](qa-browser-before-pointer-fix.json)。六图一SVG、任务与视角恢复、跨根同名T-1、真实工具卡compact、聊天6.3秒零RPC、退出Tab零RPC、普通/御史预设根零父任务RPC、窄屏More及无横溢出均通过；图表位于合同前、合同默认收起。目录/正文绑定由真实任务数据验证；旧accepted/更新目录的故障负向仍需对应Store单测，不能声称本浏览器做过该注入。

最终5预热+30样本：p95=100.0ms、p99=116.2ms；同样仅为390×844本地夹具的SVG替换加两帧稳定，不是INP或系统上限。页面错误为空。

桌面节点详情鼠标覆盖P1仍未解除；本轮通过键盘激活仅为了继续其它独立检查，结果明确保存`pointerBlocker`，不代表鼠标通过。另已准备真实parentAgent御史子会话，但该夹具没有原生委派导航登记，浏览器直接验证的是可见御史预设根的受限空态；不能把它扩称完整盲审子会话端到端验收。修复覆盖后需复测相同桌面几何点，再由根线程汇总是否可发布。

## 7. 最终覆盖修复与复测结论

根线程仅在插件页面自身增加`position: relative; z-index: 1`，宿主宽度手柄仍保留`z-index: 0`，没有移除手柄或修改宿主DOM。重新构建后再次重启4186隔离宿主，最终`lib/client.js` SHA256为`c579841b6fac0731b8b480f1e670581eab3c3662762e89b5de162711170dd811`；[最终绑定](qa-browser-bindings.json)与当前四个客户端文件逐一复算相同。

真实鼠标再次点击原按钮中心约(414.5,448.9)，命中`BUTTON`，`hitIsButton=true`，节点详情`explore`显示。手柄几何位置仍为x406–416，说明修复来自插件层级，而非把测试点移走或删除手柄。见[修复后几何](qa-pointer-fixed.json)与[最终浏览器记录](qa-browser-verification.json)。最终记录没有`pointerBlocker`，先前P1解除。

同步复测六图各一SVG、任务/视角恢复、跨根同名T-1、真实工具卡紧凑且聊天6.3秒零RPC、普通/御史预设根零父任务RPC、退出Tab零RPC均通过。390×844原生More菜单仍可鼠标打开并选择任务进度，无页面横溢出；[新布局](qa-final-layout.json)确认图表在合同前、合同默认收起；页面脚本错误为空。

最终5预热+30样本：p95=67.1ms、p99=67.4ms；口径仍为小型夹具的SVG替换加两帧稳定。各轮存在负载/帧相位差，不用p95从100降到67.1推断CSS带来因果加速，不称INP或系统极限。

已查看脱敏[桌面截图](qa-task-progress-desktop.png)与[窄屏截图](qa-task-progress-narrow.png)。当前隔离浏览器检查范围内无剩余UI阻断；正式3080部署、真实多小时任务、完整原生盲审子会话导航、Store旧accepted故障注入及GitHub资产校验仍由各自验证覆盖，不能由本报告代替。
