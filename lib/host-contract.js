/**
 * 宿主契约：dsh-agent-swarm 对 DSH 宿主的全部假设集中在此文件
 * 升级 DSH 时优先核对本文件与集成测试（tests/integration）
 */
/** 宿主行提供给预设行的服务名 */
export const SWARM_SERVICE = 'agentSwarm';
/**
 * 跨插件约定：百工模式管理的会话登记在 globalThis 的这个键上。
 * 其他会改写路由的插件（例如 dsh-llm-fallbacks 的全局回退）读到后应跳过这些会话，
 * 由百工自己的路由链负责回退。值的形状见 ManagedAgentsInfo。
 */
export const MANAGED_AGENTS_KEY = Symbol.for('dsh-agent-swarm/managed-agents');
/** dsh-base 注册的进程内子智能体后端 */
export const SPAWN_PROVIDER = 'spawn';
/** spawn 在请求 outputSchema 时注入给子智能体的结构化提交工具 */
export const STRUCTURED_OUTPUT_TOOL = 'structured_output';
/** 可选 Notebook 适配器的可信内部生命周期接口；不是模型可调用的 RPC。 */
export const NOTEBOOK_RUNTIME_KEY = Symbol.for('dsh-agent-swarm.notebook-runtime.v1');
export const getNotebookRuntimePort = () => {
    const value = globalThis[NOTEBOOK_RUNTIME_KEY];
    return value?.version === 1 && typeof value.shutdownSession === 'function' ? value : undefined;
};
export const NOTEBOOK_METADATA_TOOLS = ['nb_get', 'nb_context', 'nb_list_vars', 'nb_inspect_object', 'nb_cell_history', 'nb_error_context', 'nb_kernel_list'];
export const NOTEBOOK_MEMORY_TOOLS = ['nb_new', 'nb_add_cell', 'nb_delete_cell', 'nb_move_cell', 'nb_edit_cell', 'nb_apply_suggestion', 'nb_revert_cell', 'nb_clear_outputs'];
export const NOTEBOOK_READ_TOOLS = ['nb_open', 'nb_list', 'nb_set_cwd'];
export const NOTEBOOK_COMPUTE_TOOLS = ['nb_run_cell', 'nb_run_all', 'nb_edit_and_run_cell', 'nb_kernel_restart', 'nb_kernel_restart_and_run_all', 'nb_kernel_restart_and_clear', 'nb_kernel_interrupt', 'nb_kernel_select'];
/** 能力 → 宿主工具候选名（0.1.7-alpha.2 实测）；jev 为本插件在天枢预设内注册的 7 个 Jev 判断工具 */
export const CAPABILITY_TOOL_CANDIDATES = {
    read: ['read', 'read_image', ...NOTEBOOK_METADATA_TOOLS, ...NOTEBOOK_MEMORY_TOOLS, ...NOTEBOOK_READ_TOOLS],
    search: ['glob', 'grep', 'swarm_project_files'],
    edit: ['write', 'edit', 'nb_save'],
    shell: ['pwsh', 'bash'],
    web: ['web_search', 'web_fetch'],
    jev: ['jev_ask', 'jev_check', 'jev_classify', 'jev_health', 'jev_match', 'jev_score', 'jev_screen'],
    calculate: ['swarm_calculate', 'swarm_kernel_execute', ...NOTEBOOK_COMPUTE_TOOLS],
    context: ['swarm_context_read'],
    message: ['swarm_message_send', 'swarm_message_read', 'swarm_message_ack']
};
/** 视为写文件的工具名，守卫据此拒绝只读类角色 */
export const WRITE_TOOL_NAMES = CAPABILITY_TOOL_CANDIDATES.edit;
/**
 * 读取 agent 会话头
 * @param {AgentLike | undefined} agent - 宿主 agent
 * @returns {SessionHeaderLike} 会话头，缺失时为空对象
 */
export const getAgentHeader = (agent) => agent?.session?.header ?? {};
//# sourceMappingURL=host-contract.js.map