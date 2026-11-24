import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
/**
 * Notebook 到现有 DSH execution-boundary 的内部桥。
 *
 * 这里不定义新的公开服务：只把 Notebook 工具分类、路径断言、内层 bwrap
 * 参数和真实进程停净证书集中在一个可测试边界。main 负责把工具调用接入
 * `executionBoundary.run`，插件只消费当前活动 scope。
 */
export const EXECUTION_BOUNDARY_KEY = Symbol.for('dsh-agent-swarm.execution-boundary.v1');
export const EXECUTION_BOUNDARY_CAPS_KEY = Symbol.for('dsh-agent-swarm.execution-boundary-capabilities.v1');
export const EXECUTION_TOOLS = Object.freeze([
    'nb_run_cell',
    'nb_run_all',
    'nb_edit_and_run_cell',
    'nb_kernel_restart',
    'nb_kernel_restart_and_run_all',
    'nb_kernel_restart_and_clear',
    'nb_kernel_interrupt',
    'nb_kernel_select',
    'nb_list_vars',
    'nb_inspect_object',
]);
export const FILE_READ_TOOLS = Object.freeze(['nb_list', 'nb_open', 'nb_set_cwd']);
export const FILE_WRITE_TOOLS = Object.freeze(['nb_save']);
export const SIDECAR_FILE_TOOLS = Object.freeze(['nb_open', 'nb_save']);
const CONTROL_TOOLS = new Set([
    'nb_new',
    'nb_add_cell',
    'nb_delete_cell',
    'nb_move_cell',
    'nb_edit_cell',
    'nb_apply_suggestion',
    'nb_clear_outputs',
    'nb_kernel_list',
    'nb_get',
    'nb_context',
    'nb_cell_history',
    'nb_revert_cell',
    'nb_error_context',
]);
const EXECUTION = new Set(EXECUTION_TOOLS);
const FILE_READ = new Set(FILE_READ_TOOLS);
const FILE_WRITE = new Set(FILE_WRITE_TOOLS);
const SIDECAR_FILES = new Set(SIDECAR_FILE_TOOLS);
export const MAX_NOTEBOOK_EXECUTION_SECONDS = 180;
export const DEFAULT_NOTEBOOK_RESOURCE_LIMITS = Object.freeze({
    addressSpaceBytes: 2 * 1024 * 1024 * 1024,
    nofile: 256,
    nproc: 64,
    fileSizeBytes: 128 * 1024 * 1024,
    rootTmpfsBytes: 32 * 1024 * 1024,
    privateTmpfsBytes: 256 * 1024 * 1024,
    runtimeTmpfsBytes: 16 * 1024 * 1024,
});
const boundedResource = (name, value, maximum, minimum = 1) => {
    if (value === undefined)
        return maximum;
    if (!Number.isSafeInteger(value) || value < minimum)
        throw new Error(`Notebook resource limit ${name} 必须是正整数`);
    return Math.min(value, maximum);
};
export const resolveNotebookResourceLimits = (input = {}) => Object.freeze({
    addressSpaceBytes: boundedResource('addressSpaceBytes', input.addressSpaceBytes, DEFAULT_NOTEBOOK_RESOURCE_LIMITS.addressSpaceBytes),
    nofile: boundedResource('nofile', input.nofile, DEFAULT_NOTEBOOK_RESOURCE_LIMITS.nofile),
    nproc: boundedResource('nproc', input.nproc, DEFAULT_NOTEBOOK_RESOURCE_LIMITS.nproc),
    fileSizeBytes: boundedResource('fileSizeBytes', input.fileSizeBytes, DEFAULT_NOTEBOOK_RESOURCE_LIMITS.fileSizeBytes),
    rootTmpfsBytes: boundedResource('rootTmpfsBytes', input.rootTmpfsBytes, DEFAULT_NOTEBOOK_RESOURCE_LIMITS.rootTmpfsBytes),
    privateTmpfsBytes: boundedResource('privateTmpfsBytes', input.privateTmpfsBytes, DEFAULT_NOTEBOOK_RESOURCE_LIMITS.privateTmpfsBytes),
    runtimeTmpfsBytes: boundedResource('runtimeTmpfsBytes', input.runtimeTmpfsBytes, DEFAULT_NOTEBOOK_RESOURCE_LIMITS.runtimeTmpfsBytes),
});
export const getNotebookExecutionTimeout = (requested) => {
    if (typeof requested !== 'number' || !Number.isFinite(requested))
        return MAX_NOTEBOOK_EXECUTION_SECONDS;
    return Math.max(1, Math.min(MAX_NOTEBOOK_EXECUTION_SECONDS, Math.floor(requested)));
};
const same = (root, path) => {
    const rel = relative(root, path);
    return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const canonicalTarget = (path) => {
    const tail = [];
    let current = resolve(path);
    for (;;) {
        try {
            return join(realpathSync.native(current), ...tail);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            const parent = dirname(current);
            if (parent === current)
                throw error;
            tail.unshift(relative(parent, current));
            current = parent;
        }
    }
};
const assertAbsolute = (name, path) => {
    if (!isAbsolute(path))
        throw new Error(`${name} 必须是绝对路径`);
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink())
        throw new Error(`${name} 不能是符号链接`);
    return canonicalTarget(path);
};
const validateScope = (scope) => {
    if (typeof scope.agentId !== 'string' || typeof scope.attemptId !== 'string'
        || (scope.taskId !== undefined && (typeof scope.taskId !== 'string' || scope.taskId.trim() === ''))
        || typeof scope.cwd !== 'string' || typeof scope.repositoryRoot !== 'string'
        || !Array.isArray(scope.writeScopes) || typeof scope.assertCurrent !== 'function'
        || scope.epoch === null || typeof scope.epoch !== 'object')
        throw new Error('Notebook 执行边界 scope 不完整');
    return scope;
};
const requireScope = (carrier) => {
    const scope = carrier.storage.getStore();
    if (scope === undefined)
        throw new Error('Notebook 工具必须在 DSH 执行边界内运行');
    return validateScope(scope);
};
const hasNotebookSubprocessCapability = (target = globalThis) => {
    const caps = target[EXECUTION_BOUNDARY_CAPS_KEY];
    return caps instanceof Set && (caps.has('subprocess-local/rc1') || caps.has('subprocess-local/rc3'));
};
export const getNotebookBoundaryScope = (carrier = getNotebookBoundaryCarrier()) => {
    if (carrier === undefined)
        throw new Error('Notebook 工具缺少 DSH 执行边界桥接');
    const scope = requireScope(carrier);
    scope.assertCurrent();
    return scope;
};
export const getNotebookToolClass = (name) => {
    if (EXECUTION.has(name))
        return 'execution';
    if (FILE_READ.has(name))
        return 'file-read';
    if (FILE_WRITE.has(name))
        return 'file-write';
    if (CONTROL_TOOLS.has(name))
        return 'control';
    return undefined;
};
/** These file tools launch the bounded Python sidecar and therefore need shell containment. */
export const requiresNotebookSidecar = (name) => SIDECAR_FILES.has(name);
export const getNotebookBoundaryCarrier = (target = globalThis) => {
    return target[EXECUTION_BOUNDARY_KEY];
};
export const assertNotebookToolScope = (name, carrier = getNotebookBoundaryCarrier()) => {
    const kind = getNotebookToolClass(name);
    if (kind === undefined)
        throw new Error(`非 Notebook 工具不能使用 Notebook 执行边界: ${name}`);
    if (carrier === undefined)
        throw new Error('Notebook 工具缺少 DSH 执行边界桥接');
    const scope = requireScope(carrier);
    if (scope.mode === 'host-worktree' || scope.operation === 'host')
        throw new Error('Notebook 不允许 host-worktree 执行');
    if (kind === 'execution' && scope.operation !== 'shell')
        throw new Error('Notebook kernel 执行需要 DSH subprocess-boundary');
    if ((kind === 'file-read' || kind === 'file-write') && !['shell', 'file'].includes(scope.operation)) {
        throw new Error('Notebook 文件操作缺少 DSH 文件边界');
    }
    scope.assertCurrent();
    return scope;
};
export const assertNotebookPath = (path, access, carrier = getNotebookBoundaryCarrier()) => {
    if (carrier === undefined)
        throw new Error('Notebook 文件操作缺少 DSH 执行边界桥接');
    const scope = requireScope(carrier);
    scope.assertCurrent();
    const target = canonicalTarget(isAbsolute(path) ? path : resolve(scope.cwd, path));
    if (!same(scope.cwd, target))
        throw new Error(`Notebook 路径超出当前执行工作区: ${target}`);
    if (access === 'read')
        return target;
    if (scope.mode !== 'write')
        throw new Error('Notebook 当前角色没有写入授权');
    if (!scope.writeScopes.some(root => same(canonicalTarget(root), target)))
        throw new Error('Notebook 写入超出当前 task scope');
    carrier.assertFilePath(target);
    return target;
};
export const getNotebookComputeScopeKey = (scope) => {
    const current = validateScope(scope);
    const cwd = canonicalTarget(current.cwd);
    const stat = lstatSync(cwd, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error('Notebook compute CWD 不是稳定目录');
    return JSON.stringify([current.agentId, current.attemptId, cwd, [stat.dev, stat.ino, stat.birthtimeNs].join(':')]);
};
const dirsToCreate = (path) => {
    const parts = resolve(path).split(sep).filter(Boolean);
    const result = [];
    for (let index = 1; index <= parts.length; index++)
        result.push(`${sep}${parts.slice(0, index).join(sep)}`);
    return result;
};
export const buildNotebookSandboxPlan = (input) => {
    const scope = validateScope(input.scope);
    scope.assertCurrent();
    const resourceLimits = resolveNotebookResourceLimits(input.resourceLimits);
    const bwrap = assertAbsolute('bwrap', input.bwrap);
    const pluginRoot = assertAbsolute('Notebook plugin root', input.pluginRoot);
    const runtimePrefix = assertAbsolute('Notebook runtime prefix', input.runtimePrefix);
    const kernelRuntimePrefix = input.kernelRuntimePrefix === undefined ? undefined : assertAbsolute('Notebook kernel runtime prefix', input.kernelRuntimePrefix);
    const pythonExecutable = resolve(input.pythonExecutable);
    const driverPath = assertAbsolute('Notebook driver', input.driverPath);
    const cwd = canonicalTarget(scope.cwd);
    if (!isAbsolute(input.pythonExecutable) || !existsSync(pythonExecutable))
        throw new Error('Notebook Python 必须是私有插件内存在的绝对路径');
    if (!lstatSync(runtimePrefix).isDirectory() || (!existsSync(join(runtimePrefix, 'pyvenv.cfg')) && !existsSync(join(runtimePrefix, 'conda-meta')))) {
        throw new Error('Notebook runtime prefix 缺少 pyvenv.cfg 或 conda-meta');
    }
    if (kernelRuntimePrefix !== undefined && (!lstatSync(kernelRuntimePrefix).isDirectory()
        || (!existsSync(join(kernelRuntimePrefix, 'pyvenv.cfg')) && !existsSync(join(kernelRuntimePrefix, 'conda-meta'))))) {
        throw new Error('Notebook kernel runtime prefix 缺少 pyvenv.cfg 或 conda-meta');
    }
    if ([sep, '/home', '/root', '/data', '/usr', '/etc', '/opt', '/run', '/tmp'].includes(runtimePrefix))
        throw new Error('Notebook runtime prefix 过宽');
    if (kernelRuntimePrefix !== undefined && [sep, '/home', '/root', '/data', '/usr', '/etc', '/opt', '/run', '/tmp'].includes(kernelRuntimePrefix))
        throw new Error('Notebook kernel runtime prefix 过宽');
    if (!same(runtimePrefix, pythonExecutable) || !same(pluginRoot, driverPath)) {
        throw new Error('Notebook Python 必须来自已核验 runtime prefix，driver 必须来自私有插件根');
    }
    if (!same(cwd, scope.cwd) || [sep, '/usr', '/etc', '/bin', '/sbin', '/lib', '/lib64'].includes(cwd)) {
        throw new Error('Notebook 工作区不是可隔离的项目目录');
    }
    const writeRoots = scope.mode === 'write'
        ? scope.writeScopes.map(root => canonicalTarget(root)).map(root => {
            if (!same(cwd, root))
                throw new Error('Notebook 写 scope 超出当前工作区');
            return root;
        })
        : [];
    if (writeRoots.length > 128)
        throw new Error('Notebook 写 scope 超出容量');
    if (writeRoots.some(root => same(root, pluginRoot) || same(pluginRoot, root)
        || same(root, runtimePrefix) || same(runtimePrefix, root)
        || (kernelRuntimePrefix !== undefined && (same(root, kernelRuntimePrefix) || same(kernelRuntimePrefix, root))))) {
        throw new Error('Notebook plugin/runtime prefix 不能与可写 scope 重叠');
    }
    const etcRoots = [
        '/etc/ld.so.cache',
        '/etc/ld.so.conf',
        '/etc/ld.so.conf.d',
        '/etc/passwd',
        '/etc/group',
        '/etc/nsswitch.conf',
        '/etc/hosts',
        '/etc/localtime',
        '/etc/timezone',
        '/etc/fonts',
        '/etc/matplotlibrc',
    ];
    const readRoots = [...new Set(['/usr/bin', '/usr/sbin', '/usr/lib', '/usr/lib64', '/usr/share', ...etcRoots, pluginRoot, runtimePrefix, ...(kernelRuntimePrefix === undefined ? [] : [kernelRuntimePrefix]), cwd])]
        .filter(root => existsSync(root));
    const symlinks = [
        ['usr/bin', '/bin'],
        ['usr/sbin', '/sbin'],
        ['usr/lib', '/lib'],
        ['usr/lib64', '/lib64'],
    ];
    const env = {
        HOME: '/tmp/home',
        TMPDIR: '/tmp',
        XDG_CONFIG_HOME: '/tmp/home/.config',
        XDG_CACHE_HOME: '/tmp/home/.cache',
        XDG_DATA_HOME: '/tmp/home/.local/share',
        JUPYTER_RUNTIME_DIR: '/tmp/jupyter/runtime',
        JUPYTER_DATA_DIR: '/tmp/jupyter/data',
        JUPYTER_CONFIG_DIR: '/tmp/jupyter/config',
        IPYTHONDIR: '/tmp/ipython',
        MPLCONFIGDIR: '/tmp/matplotlib',
        PATH: `${dirname(pythonExecutable)}:/usr/bin:/bin`,
        LANG: 'C.UTF-8',
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        DSH_NOTEBOOK_RESOURCE_PROFILE: 'managed-v1',
        DSH_NOTEBOOK_RLIMIT_AS_BYTES: String(resourceLimits.addressSpaceBytes),
        DSH_NOTEBOOK_RLIMIT_NOFILE: String(resourceLimits.nofile),
        DSH_NOTEBOOK_RLIMIT_NPROC: String(resourceLimits.nproc),
        DSH_NOTEBOOK_RLIMIT_FSIZE_BYTES: String(resourceLimits.fileSizeBytes),
        DSH_NOTEBOOK_RLIMIT_CORE_BYTES: '0',
    };
    const argv = [
        bwrap,
        '--unshare-all',
        '--new-session',
        '--die-with-parent',
        '--cap-drop',
        'ALL',
        '--clearenv',
        '--size',
        String(resourceLimits.rootTmpfsBytes),
        '--tmpfs',
        '/',
        '--dir',
        '/etc',
    ];
    for (const [target, link] of symlinks)
        argv.push('--symlink', target, link);
    for (const root of readRoots)
        argv.push('--ro-bind', root, root);
    argv.push('--dev', '/dev', '--proc', '/proc', '--size', String(resourceLimits.privateTmpfsBytes), '--tmpfs', '/tmp', '--size', String(resourceLimits.runtimeTmpfsBytes), '--tmpfs', '/run');
    argv.push('--ro-bind', pluginRoot, pluginRoot);
    if (!same(runtimePrefix, pluginRoot))
        argv.push('--ro-bind', runtimePrefix, runtimePrefix);
    if (kernelRuntimePrefix !== undefined && !same(kernelRuntimePrefix, runtimePrefix) && !same(kernelRuntimePrefix, pluginRoot)) {
        argv.push('--ro-bind', kernelRuntimePrefix, kernelRuntimePrefix);
    }
    argv.push('--ro-bind', cwd, cwd);
    for (const root of writeRoots)
        argv.push('--bind', root, root);
    for (const dir of ['/tmp/home/.config', '/tmp/home/.cache', '/tmp/home/.local/share', '/tmp/jupyter/runtime', '/tmp/jupyter/data', '/tmp/jupyter/config', '/tmp/ipython', '/tmp/matplotlib']) {
        for (const parent of dirsToCreate(dir))
            argv.push('--dir', parent);
    }
    for (const [name, value] of Object.entries(env))
        argv.push('--setenv', name, value);
    argv.push('--chdir', cwd, '--', pythonExecutable, driverPath);
    return { argv, cwd, env, network: 'deny', rootMode: 'allowlist', readRoots, writeRoots, resourceLimits };
};
export const getNotebookKernelLifecycle = (scope) => {
    if (scope.mode === 'read-only')
        return 'persistent';
    if (scope.mode === 'write')
        return 'ephemeral';
    throw new Error('Notebook kernel 不接受 host-worktree scope');
};
const epochKey = (agentId, attemptId) => JSON.stringify([agentId, attemptId]);
export const spawnNotebookRuntime = (input) => {
    const scope = requireScope(input.carrier);
    if (!hasNotebookSubprocessCapability()) {
        throw new Error('Notebook kernel 缺少当前 DSH subprocess containment capability，拒绝启动');
    }
    if (typeof input.carrier.prepareSpawn !== 'function') {
        throw new Error('Notebook kernel 缺少 DSH subprocess containment 准备钩子，拒绝启动');
    }
    const expected = getNotebookKernelLifecycle(scope);
    if (input.lifecycle !== expected)
        throw new Error(`Notebook kernel 生命周期必须为 ${expected}`);
    if (input.plan.network !== 'deny')
        throw new Error('Notebook kernel 必须禁止网络');
    if (input.plan.cwd !== scope.cwd || input.plan.argv.length === 0)
        throw new Error('Notebook kernel 启动坐标不一致');
    const synthetic = input.lifecycle === 'persistent';
    // 只读核保留到 Agent dispose，不能占住 writer attempt epoch；使用独立
    // synthetic epoch 仍可让 Host 对该进程范围执行 native containment 校验。
    const attemptId = synthetic ? `notebook-read:${randomUUID()}` : scope.attemptId;
    const epoch = synthetic ? { active: 0, unknown: false, sealed: false } : scope.epoch;
    const key = synthetic ? epochKey(scope.agentId, attemptId) : undefined;
    if (key !== undefined)
        input.carrier.epochs.set(key, epoch);
    const spawnScope = { ...scope, attemptId, operation: 'shell', epoch };
    let handle;
    try {
        handle = input.carrier.storage.run(spawnScope, () => input.subprocess.spawn({
            argv: input.plan.argv,
            cwd: input.plan.cwd,
            stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
            graceMs: 3000,
            env: { PATH: input.plan.env.PATH },
            ...(input.signal === undefined ? {} : { signal: input.signal }),
        }));
    }
    catch (error) {
        if (key !== undefined)
            input.carrier.epochs.delete(key);
        throw error;
    }
    return { handle, lifecycle: input.lifecycle, epoch, epochKey: key, syntheticEpoch: synthetic, ownership: { active: 1, unknown: false } };
};
const delay = (ms) => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const waitForDone = (handle, timeoutMs) => {
    return new Promise((resolveDone, reject) => {
        const timer = setTimeout(() => reject(new Error('Notebook process exit timeout')), timeoutMs);
        handle.done.then(outcome => {
            clearTimeout(timer);
            resolveDone(outcome);
        }, error => {
            clearTimeout(timer);
            reject(error);
        });
    });
};
const waitForEpoch = async (epoch, timeoutMs) => {
    if (epoch === undefined)
        return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
        if (!epoch.unknown && epoch.active === 0)
            return true;
        await delay(10);
    }
    return !epoch.unknown && epoch.active === 0;
};
const settleCarrierBookkeeping = () => new Promise(resolveSettled => setImmediate(resolveSettled));
export const stopNotebookRuntime = async (record, options = {}) => {
    const timeoutMs = Math.max(10, Math.min(options.timeoutMs ?? 15_000, 55_000));
    let outcome;
    let quiescent = false;
    let error;
    try {
        record.handle.terminate();
        outcome = await waitForDone(record.handle, timeoutMs);
        quiescent = await record.handle.waitForExit(AbortSignal.timeout(timeoutMs));
    }
    catch (failure) {
        error = String(failure.message ?? failure);
    }
    if (quiescent && outcome !== undefined)
        record.ownership.active = 0;
    else
        record.ownership.unknown = true;
    const ownershipQuiescent = !record.ownership.unknown && record.ownership.active === 0;
    let epochQuiescent = null;
    if (record.syntheticEpoch) {
        epochQuiescent = await waitForEpoch(record.epoch, timeoutMs);
        if (!epochQuiescent && record.epoch !== undefined)
            record.epoch.unknown = true;
    }
    await settleCarrierBookkeeping();
    const sharedEpochActive = record.syntheticEpoch ? undefined : record.epoch?.active;
    const stopped = outcome !== undefined && quiescent && ownershipQuiescent && (epochQuiescent !== false);
    if (!stopped || outcome === undefined) {
        return { stopped, quiescent, ownershipQuiescent, epochQuiescent, ...(sharedEpochActive === undefined ? {} : { sharedEpochActive }), exitCode: outcome?.exitCode ?? null, signal: outcome?.signal ?? null, ...(error === undefined ? {} : { error }) };
    }
    if (record.syntheticEpoch && record.epochKey !== undefined && options.carrier !== undefined)
        options.carrier.epochs.delete(record.epochKey);
    return { stopped: true, quiescent: true, ownershipQuiescent: true, epochQuiescent, ...(sharedEpochActive === undefined ? {} : { sharedEpochActive }), exitCode: outcome.exitCode, signal: outcome.signal };
};
//# sourceMappingURL=notebook-runtime.js.map