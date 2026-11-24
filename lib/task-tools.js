import { getCollaborationToolDefinitions } from './collaboration-tools.js';
import { DEFAULT_CONTEXT_PAGE_CHARS } from './context-store.js';
import { getMathToolDefinitions } from './math-tools.js';
import { getToolDefinition } from './tool-shape.js';
import { WORKTREE_TOOL, RESTORE_WORKTREE_TOOL, PRIMARY_WORKSPACE_TOOL, WORKSPACE_GIT_SAVE_TOOL, VERIFICATION_OUTPUT_TOOL } from './worktree-binding.js';
/** 注册不代表授权：所有入口原样传递真实 exec，由 service 校验任务绑定、版本和角色权限。 */
export const getBoundTaskToolDefinitions = (service) => {
    const config = service.getConfig();
    return [
        ...(service.CreateWorktree === undefined ? [] : [getToolDefinition({ name: WORKTREE_TOOL,
                description: '仅已授权可写 Worker 按当前 linked 工作区合同创建新工作树，基线固定为 Host 核验 HEAD。不进入已有工作树，不接收任意 path/owner；已有现场调用 swarm_restore_worktree。由 Host create API 执行，返回后仍需原登记、租约和持久化门禁才能写入。主树模式禁止此操作。',
                parameters: { type: 'object', properties: { name: { type: 'string', description: '可省略，由 Host 生成；最多64字符，只用小写字母、数字、短横线，不是目录或含斜线的分支路径' }, from: { type: 'string', description: '可省略；实际创建始终固定为当前合同 HEAD' } }, additionalProperties: false },
                execute: service.CreateWorktree, render: (_args, result) => JSON.stringify(result), isConcurrencySafe: () => false })]),
        ...(service.ExecuteKernel === undefined ? [] : [getToolDefinition({ name: 'swarm_kernel_execute',
                description: '在独立执行服务的隔离容器内运行 Python/Node cell，同一有效任务 attempt 保留变量，DSH 重启不销毁活内核。仅计算用途：无项目写入、无宿主挂载、默认断网。身份由 Host 绑定，不能传 owner/path；服务或隔离不可用明确失败。Notebook 文件保存仍走 nb_save 原有授权。',
                parameters: { type: 'object', required: ['language', 'code'], properties: { language: { type: 'string', enum: ['python', 'node'] }, code: { type: 'string' } }, additionalProperties: false },
                execute: service.ExecuteKernel, render: (_args, result) => JSON.stringify(result), isConcurrencySafe: () => false, timeoutMs: 60_000 })]),
        getToolDefinition({ name: VERIFICATION_OUTPUT_TOOL, description: '仅复核 Worker 为本 attempt 准备受控测试输出：固定项目 var/tmp 与本次全新 var/reports/swarm 运行目录。任务 scope 须覆盖两域；源码和 .git 仍只读，不能覆盖旧报告。返回真实目录后，测试命令须显式把临时/cache/报告写到这些目录。重启或 attempt 结束即撤销写权。',
            parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: (args, exec) => service.PrepareVerificationOutputs(args, exec), render: (_args, result) => JSON.stringify(result), isConcurrencySafe: () => false }),
        getToolDefinition({ name: WORKSPACE_GIT_SAVE_TOOL, description: '在当前已绑定唯一主工作区内保存明确文件的 WIP/提交。只接受精确相对文件列表、提交信息和当前 expected_head；不执行任意 Git 命令，不含秘密文件，不提交范围外已暂存内容，不 reset/clean/checkout。保存后更新当前工作区观察事实；任何部分失败保持围栏，不重发。',
            parameters: { type: 'object', required: ['paths', 'message', 'expected_head'], properties: { paths: { type: 'array', items: { type: 'string' } }, message: { type: 'string' }, expected_head: { type: 'string' } }, additionalProperties: false },
            execute: (args, exec) => service.SaveWorkspaceGit(args, exec), render: (_args, result) => JSON.stringify(result), isConcurrencySafe: () => false }),
        getToolDefinition({ name: PRIMARY_WORKSPACE_TOOL, description: '按当前任务的 Host 工作区规划绑定唯一主仓库，不创建第二工作树。先从任务卡 workspacePlan 读取模式、依据与 HEAD。仅可写 Worker，路径和 owner 均由 Host 取得；项目规则、预期 HEAD、唯一工作树、当前任务/attempt/版本和排他写租约全部通过，可靠落盘后才激活。已有记录使用 swarm_restore_worktree，不自动接管。',
            parameters: { type: 'object', required: ['expected_head'], properties: { expected_head: { type: 'string' } }, additionalProperties: false },
            execute: (args, exec) => service.BindPrimaryWorkspace(args, exec), render: (_args, result) => JSON.stringify(result), isConcurrencySafe: () => false }),
        getToolDefinition({ name: RESTORE_WORKTREE_TOOL, description: '显式接管当前任务保留的原工作树。先从 swarm_context_read 获取 worktree_id。仅合法可写 Worker 可用；核验旧执行停止、任务版本、仓库、分支和目录并取得租约，保持原提交及 staged/unstaged/untracked 内容。不新建、reset、clean 或重新 checkout。失败时保持禁止写入。',
            parameters: { type: 'object', required: ['worktree_id'], properties: { worktree_id: { type: 'string' }, expected_head: { type: 'string', description: '主工作区 HEAD 有显式核对更新时提供；省略时必须与原观察 HEAD 一致' } }, additionalProperties: false },
            execute: service.RestoreWorktree, render: (_args, result) => JSON.stringify(result), isConcurrencySafe: () => false }),
        getToolDefinition({ name: 'swarm_context_read', description: '不传 ref 时列出当前任务授权材料与执行摘要；传 ref 分页读取。缺失或已替换的历史 ref 返回 ok:false 及当前授权索引，按新 ref/digest 从头读取。始终校验任务/版本，不读取其他任务或盲审禁止的作者过程。',
            parameters: { type: 'object', properties: { task_id: { type: 'string' }, ref: { type: 'string' },
                    cursor: { type: 'string', description: 'UTF-16 字符单元偏移，首次省略或传 "0"；后续原样使用返回的 nextCursor，不按字节数或行号猜测' },
                    limit: { type: 'number', description: `正安全整数，单位为 UTF-16 字符单元，默认 ${DEFAULT_CONTEXT_PAGE_CHARS}，有效页上限 ${DEFAULT_CONTEXT_PAGE_CHARS}；更大的整数自动收缩并返回 limitClamped。按 nextCursor 继续读取；为保全 emoji 代理对，实际返回最多额外 1 单元，以 returnedChars 为准` },
                    expectedDigest: { type: 'string', description: '材料索引中的 digest；版本或摘要不一致仍拒绝读取' } }, additionalProperties: false },
            execute: service.ReadContext, render: (_args, result) => JSON.stringify(result), isConcurrencySafe: () => true }),
        getToolDefinition({ name: 'swarm_project_files', description: '有界列举当前任务工作区实际存在的文件；path为工作区相对子目录，query为文件名或路径片段。默认源码索引排除 var、依赖与缓存目录，返回 excludedDirectoryNames；确需运行域材料时显式选择 path。遇到glob原始输出超限或目录无权限时缩小path，不提权、不提高20MB缓冲。complete=false时须缩小目录，空结果不能证明文件不存在。先发现再read/grep，不猜测或自动改写路径。',
            parameters: { type: 'object', properties: { task_id: { type: 'string' }, path: { type: 'string', description: '工作区相对子目录，如 src；不能传绝对目录或 ..。默认当前工作区' }, query: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false },
            execute: service.ProjectFiles, render: (_args, result) => JSON.stringify(result), isConcurrencySafe: () => true }),
        ...getMathToolDefinitions({ calculate: service.Calculate }),
        ...(config.persistence.enabled && config.messageBus.enabled
            ? getCollaborationToolDefinitions({ send: service.MessageSend, read: service.MessageRead, acknowledge: service.MessageAck }) : [])
    ];
};
//# sourceMappingURL=task-tools.js.map