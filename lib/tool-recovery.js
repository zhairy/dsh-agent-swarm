/**
 * 已知宿主工具错误的只读恢复提示。只补充失败呈现，不能改变 isError、
 * 原始错误码或工具的事实结果，也不发网络请求或重放调用。
 */
export const getToolRecoveryResult = (name, result) => {
    if (result === null || typeof result !== 'object')
        return result;
    const record = result;
    if (record.isError !== true || !Array.isArray(record.content))
        return result;
    const error = record.error;
    const message = typeof error?.message === 'string' ? error.message.slice(0, 8192)
        : record.content.slice(0, 4).map((block) => typeof block?.text === 'string' ? block.text.slice(0, 2048) : '').join('\n');
    let hint;
    if (['glob', 'grep'].includes(name) && (error?.info?.code === 'SEARCH_RAW_OUTPUT_OVERFLOW' || /(?:produced more raw output|bytes of raw output, over the)/i.test(message))) {
        hint = '百工恢复：这是宿主搜索的原始输出容量限制，不是模型上下文耗尽。不要原样重试或提高缓冲；改用 swarm_project_files({path:"src",query:"目标文件片段",limit:80})，path 必须换成当前工作区真实子目录，再对已确认的文件做窄范围 glob/grep。complete=false 时继续缩小 path；未扫描范围不能作为不存在证据。';
    }
    else if (['glob', 'grep'].includes(name) && /permission denied|EACCES|os error 13/i.test(message)) {
        hint = '百工恢复：搜索触及当前用户无权访问的目录，本次结果不完整。不要修改目录权限、提权或原样遍历整个项目。改用 swarm_project_files({path:"src",limit:80}) 发现真实源码，或按任务实际范围选择 tests 等子目录后再 glob/grep；默认索引排除 var 与缓存，若任务必须审计备份则明确报告访问缺口，不能认定其不存在。';
    }
    else if (name === 'web_fetch' && /DeepSeek API error \(HTTP 404\)/i.test(message)) {
        hint = '百工恢复：DeepSeek Fetch 请求返回 404，不能据此认定目标网页不存在，也不能据此切换聊天模型。不要重试同一端点；请由用户在「插件 → 内置插件设置 → 网页搜索」选择可用的抓取后端或可信 Fetch API 地址。Search/Fetch 与聊天地址独立；不自动改地址、发送密钥或把失败抓取当作证据。若网页是必需材料则记录该缺口；其他无依赖节点可以继续，必需证据仍不能跳过。';
    }
    if (hint === undefined || record.content.some((block) => typeof block?.text === 'string' && block.text.includes(hint)))
        return result;
    return { ...record, content: [...record.content, { type: 'text', text: hint }] };
};
//# sourceMappingURL=tool-recovery.js.map