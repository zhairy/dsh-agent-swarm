# 正式 3080 Web 独立验收

2026-10-26，独立浏览器会话 `swarm313-formal-qa`。DSH 为 `0.2.1-rc.3`，正式 PID `1300135`；安装插件版本 `3.1.3`，安装包客户端 SHA256 与最终候选一致，见 [安装绑定](installed-binding.json)。认证 URL 仅在脚本内部从当前 PID 的 journal 读取并 fetch，未输出或保存令牌。

## 设置页

[10 项检查全部通过](settings-results.json)：

- 桌面五个分类 Tab 分别显示唯一面板。
- 常规主模型固定，没有拖动手柄。
- 真实鼠标开始拖拽后 Escape 取消，观察到可信 dragstart/dragend，模型链不变，也没有可保存草稿。
- Alt+方向键只改变备用模型草稿顺序，推理档位随原模型移动；随后点击放弃修改，恢复原模型、顺序和推理档位。
- 390×844 下五类均可点击，插件正文无横向溢出。
- 保存按钮点击次数为 0；未保存配置，未调用 Jev 测试按钮。
- 页面 error/unhandledrejection 与浏览器 page errors 均为空。

[桌面截图](settings-desktop.png) · [390px 截图](settings-narrow.png)

## 已有会话的只读任务进度

通过真实侧栏打开 quant 工作区内一个已有百工会话，再点击“任务进度”。该会话历史宿主目标显示“任务 3 已完成”，不能将它描述为本轮恢复或重新完成的任务。本轮没有点击继续、发送、创建任务或执行模型请求。

页面真实显示：“本会话还没有可读取的任务卡。请在天枢会话中创建任务；此页面不会自动创建任务。”任务选择项为 0，没有 RuntimeGuardStatus 节点。该结果说明当前目录安全展示空态，不证明此前用户重启前的内存任务已经恢复，也没有假造 active/stalled/exhausted 状态。

[任务进度事实](task-progress-empty-results.json) · [空态截图](task-progress-empty-desktop.png)

最终 [page errors 为空](page-errors.json)；[console](console.json) 只有一条 genui 启动 info，无 error。只读目录可能惰性创建宿主内存中的空 feature 容器，这不等于新建业务任务或恢复历史状态。

## 操作边界

本次只执行导航、只读展示与可撤销草稿操作；未保存配置、未修改 profile/Git/服务，未创建任务、未继续目标、未发送消息、未调用生成模型。证据文件只写入本目录。验收完成后关闭独立浏览器会话；正式服务保持运行。
