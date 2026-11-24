import { isAbsolute, relative, resolve, sep, dirname, join } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { validateAction } from './schema.js';
const within = (root, path) => { const rel = relative(root, path); return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const READ_TOOLS = new Set(['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'swarm_context_read', 'swarm_project_files', 'nb_get', 'nb_context', 'nb_list_vars', 'nb_inspect_object', 'nb_cell_history', 'nb_error_context', 'nb_kernel_list']);
const canonicalTarget = (path) => {
    let current = path;
    const tail = [];
    for (;;) {
        const stat = lstatSync(current, { throwIfNoEntry: false });
        // 断链不是尚未创建的新路径，realpath 失败必须拒绝，不能回退为词法路径。
        if (stat !== undefined)
            return join(realpathSync.native(current), ...tail);
        const parent = dirname(current);
        if (parent === current)
            throw new Error('PERMISSION_DENIED: path anchor unavailable');
        tail.unshift(relative(parent, current));
        current = parent;
    }
};
/** 所有真实执行经过现有 Host 物理边界；不能用模型自报的 path/字节数代替授权。 */
export const createRecoveryRunner = (options) => ({
    run: async (raw, signal, depth = 0) => {
        if (depth !== 0)
            throw new Error('NESTED_REPAIR: nested depth must be zero');
        signal.throwIfAborted();
        options.authority.assertCurrent();
        options.budget.check();
        if (!options.host.available())
            throw new Error('ISOLATION_UNAVAILABLE: verified Host boundary unavailable');
        const action = validateAction(raw), authority = options.authority;
        if (!authority.tools.includes(action.tool))
            throw new Error('PERMISSION_DENIED: tool not in original task');
        if (action.kind === 'read' && !READ_TOOLS.has(action.tool) || action.kind === 'write' && action.tool !== 'write')
            throw new Error('PERMISSION_DENIED: unclassified or disguised tool');
        if (action.kind === 'process' && (!['bash', 'pwsh'].includes(action.tool) || !authority.allowProcess || options.host.processBudgetEnforced !== true))
            throw new Error('ISOLATION_UNAVAILABLE: process quota not enforceable');
        const rollback = action.kind === 'rollback' ? authority.confirmRollback?.(action) : undefined;
        if (action.kind === 'rollback' && (!action.reversibleConfirmed || rollback === undefined))
            throw new Error('PERMISSION_DENIED: rollback receipt not confirmed');
        const paths = [...action.paths];
        // 与 Host guard 使用相同的 path-like 字段规则，实际读取另由 FD fence 约束。
        for (const [key, value] of Object.entries(action.arguments))
            if (/path|file|directory|root|cwd/i.test(key) && typeof value === 'string')
                paths.push(value);
        const validatePaths = () => {
            const root = realpathSync.native(authority.projectRoot);
            if (root !== authority.projectRoot)
                throw new Error('PERMISSION_DENIED: workspace root alias');
            for (const rawPath of paths) {
                const path = canonicalTarget(resolve(root, rawPath));
                if (!within(root, path) || relative(root, path).split(sep).includes('.git'))
                    throw new Error('PERMISSION_DENIED: path outside original workspace or Git metadata');
                if (['write', 'rollback'].includes(action.kind) && !authority.writeScopes.some(scope => within(canonicalTarget(scope), path)))
                    throw new Error('PERMISSION_DENIED: source task has no write scope');
            }
        };
        validatePaths();
        if (['write', 'rollback'].includes(action.kind) && (paths.length === 0 || authority.writeScopes.length === 0))
            throw new Error('PERMISSION_DENIED: no original write authority');
        const policy = await options.host.prepare(action, signal);
        if (policy.repositoryRoot !== authority.projectRoot || policy.writeScopes.some(path => !authority.writeScopes.some(root => within(root, path)))
            || action.kind === 'read' && policy.mode !== 'read-only' || action.kind === 'process' && policy.mode !== 'read-only'
            || ['write', 'rollback'].includes(action.kind) && policy.mode !== 'write')
            throw new Error('PERMISSION_DENIED: prepared boundary exceeds task authority');
        options.budget.reserveTool();
        if (action.kind === 'write') {
            if (typeof action.arguments.content !== 'string')
                throw new Error('PERMISSION_DENIED: actual write payload unknown');
            options.budget.reserveWrite(Buffer.byteLength(action.arguments.content));
        }
        if (rollback !== undefined)
            options.budget.reserveWrite(rollback.writeBytes);
        const release = action.kind === 'process' ? options.budget.acquireProcess() : () => { };
        // checkpoint 由 SQLite owner 围栏校验；先持久预扣，失败或未知结果不退款。
        try {
            options.checkpoint();
            return await options.host.run({ ...policy, assertCurrent: () => { authority.assertCurrent(); policy.assertCurrent(); signal.throwIfAborted(); options.budget.check(); } }, async () => {
                authority.assertCurrent();
                signal.throwIfAborted();
                options.budget.check();
                validatePaths();
                const result = await options.host.invoke(action, signal);
                authority.assertCurrent();
                signal.throwIfAborted();
                options.budget.check();
                return result;
            });
        }
        finally {
            release();
        }
    }
});
//# sourceMappingURL=runner.js.map