import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { getRoleRoute } from '../../config.js';
import { createDedupStore } from './dedup-store.js';
import { createFailureRecovery } from './orchestrator.js';
import { createRepairProcessor } from './processor.js';
import { getRepairRoute } from './router.js';
import { createRecoveryRunner } from './runner.js';
import { getFailureFingerprint } from './fingerprint.js';
import { validateFailureEvent } from './schema.js';
import { getCompactionCounts, getModelSwitchRecoveryDecision } from './compaction.js';
import { createRecoveryReadFence } from './read-fence.js';
import { createRecoveryMaintenance } from './maintenance.js';
const noticeKey = (e) => JSON.stringify([e.rootSessionId, e.taskId, e.nodeId, e.attemptId, e.contractRevision]);
const scopeKey = (e) => createHash('sha256').update(JSON.stringify(['failure-dedup/v1', e.projectRoot, e.rootSessionId, e.taskId, e.nodeId, e.contractRevision])).digest('hex');
const SAME_INPUT_READS = new Set(['read']);
/** 接入真实 Host seam；新库惰性创建，空模型链完全不产生后台任务或模型调用。 */
export const createHostFailureRuntime = (options) => {
    const notices = new Map(), stores = new Map(), internalCalls = new Set(), stop = new AbortController();
    const noticeUses = new Map(), scopeUses = new Map(), pendingNotices = new Set();
    const readFences = new Map();
    let closed = false;
    const directory = join(options.dshHome, 'share', 'dsh-agent-swarm', 'failure-recovery-v1');
    const noticeOf = (event) => { const notice = notices.get(noticeKey(event)); if (notice === undefined)
        throw new Error('RECOVERY_ORIGIN_UNAVAILABLE'); notice.assertCurrent(); return notice; };
    const getStore = (event) => {
        const key = scopeKey(event), notice = noticeOf(event), existing = stores.get(key);
        if (existing !== undefined) {
            existing.notice = notice;
            return existing.store;
        }
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (realpathSync.native(directory) !== directory)
            throw new Error('RECOVERY_STORE: aliased scope directory');
        const store = createDedupStore(join(directory, `${key}.sqlite`));
        stores.set(key, { store, notice });
        return store;
    };
    const route = () => getRepairRoute(getRoleRoute(options.getConfig(), 'bu_que').chain);
    const maintenance = createRecoveryMaintenance({ directory, enabled: () => !closed && route() !== undefined, log: options.log });
    const startMaintenance = () => {
        try {
            maintenance.start();
        }
        catch (error) {
            options.log(`补阙维护未就绪；保留旧 claim，不接管 writer：${error instanceof Error ? error.name : 'unknown'}`);
        }
    };
    const processor = createRepairProcessor({
        getStore, getRoute: route, assertCurrent: event => noticeOf(event).assertCurrent(), signal: event => {
            const source = noticeOf(event).signal;
            return source === undefined ? stop.signal : AbortSignal.any([stop.signal, source]);
        },
        reconcile: async (event) => {
            // 仅原始只读工具可由 Host 语义证明无写副作用；其它 unknown 不靠模型自证。
            const original = noticeOf(event).originalTool;
            return original !== undefined && SAME_INPUT_READS.has(original.name);
        },
        plan: async (event, selected, signal, observe) => {
            if (event.failureKind === 'MODEL_SWITCH_COMPACTION_FAILED') {
                const counts = getCompactionCounts(event.message), previous = noticeOf(event).previousModel;
                const reason = counts === undefined ? 'previous request model preserved; trusted summary measurements unavailable'
                    : getModelSwitchRecoveryDecision({ ...counts, previousModel: previous }).reason;
                // rc.3 没有自定义摘要的准入见证，不手改历史或重复同一失败压缩。
                throw new Error(`manual_required: MODEL_SWITCH_COMPACTION_FAILED: ${reason}`);
            }
            const llm = options.ctx.get('llm');
            if (llm?.stream === undefined || !llm.listProviders().some(p => p.id === selected.provider))
                throw new Error('manual_required: repair model unavailable');
            const callId = randomUUID(), usage = { callId, provider: selected.provider, model: selected.model };
            observe(usage);
            const original = noticeOf(event).originalTool;
            const previous = getStore(event).lastReport(getFailureFingerprint(event).fingerprint);
            const state = { failure: JSON.parse(getFailureFingerprint(event).canonicalJson), allowedTools: ['read'], allowedKinds: ['read'], originalRead: original !== undefined && SAME_INPUT_READS.has(original.name) ? original : undefined,
                previousRepair: previous === undefined ? undefined : { status: previous.status, reason: previous.reason, actions: previous.actions.slice(-4), consumed: previous.consumed } };
            const prompt = '你是内部修复 Agent 补阙。目标和权限不可改变。仅返回 JSON RepairPlan: {summary,actions,verification}。每个动作含 id,tool,kind(read/write/process/rollback),arguments,paths,writeBytes,idempotent,reversibleConfirmed。verification 必须 read。原始故障验证必须保留原工具和参数；不能以换文件或普通成功读取冒充故障已解决。不要调用自身，不要生成代码执行入口。';
            let output = '';
            try {
                for await (const chunk of llm.stream({ ...selected, system: prompt, messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(state) }] }], signal })) {
                    signal.throwIfAborted();
                    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
                        output += chunk.text;
                        if (output.length > 65536)
                            throw new Error('repair plan too large');
                    }
                    if (chunk.type === 'usage') {
                        const raw = (chunk.usage ?? chunk);
                        for (const [target, keys] of [['tokensIn', ['inputTokens', 'input_tokens']], ['tokensOut', ['outputTokens', 'output_tokens']], ['costUsd', ['costUsd', 'cost_usd']]]) {
                            const value = keys.map(k => raw[k]).find(v => typeof v === 'number' && Number.isFinite(v) && v >= 0);
                            if (typeof value === 'number')
                                Object.assign(usage, { [target]: value });
                        }
                        observe(usage);
                    }
                    if (chunk.type === 'finish' && typeof chunk.reason === 'object' && chunk.reason !== null && chunk.reason.kind === 'error')
                        throw new Error('repair model failed');
                }
                return JSON.parse(output);
            }
            finally {
                observe(usage);
            }
        },
        validateResult: (event, action, result) => {
            const original = noticeOf(event).originalTool;
            return result.ok && original !== undefined && SAME_INPUT_READS.has(original.name) && action.tool === original.name
                && JSON.stringify(action.arguments) === JSON.stringify(original.arguments);
        },
        runner: (event, budget, checkpoint, assertCurrent) => {
            const notice = noticeOf(event), tools = options.ctx.get('tools');
            const fs = options.ctx.get('fs');
            if (fs === null || typeof fs !== 'object')
                throw new Error('ISOLATION_UNAVAILABLE: local read service missing');
            let fence = readFences.get(fs);
            if (fence === undefined) {
                fence = createRecoveryReadFence(fs);
                readFences.set(fs, fence);
            }
            const readFence = fence;
            const key = getStore(event).get(getFailureFingerprint(event).fingerprint).last_repair_task_id;
            const allowed = tools?.schemas(notice.agent).map(t => t.name).filter(name => SAME_INPUT_READS.has(name)) ?? [];
            return createRecoveryRunner({ budget, checkpoint, authority: { projectRoot: event.projectRoot, tools: allowed, writeScopes: [], allowProcess: false, assertCurrent }, host: {
                    available: () => options.boundary.available() && typeof tools?.resolve === 'function' && typeof tools.execute === 'function',
                    prepare: async (action, signal) => {
                        assertCurrent();
                        signal.throwIfAborted();
                        if (action.kind !== 'read')
                            throw new Error('manual_required: new repair writer requires ordinary Host admission');
                        options.boundary.begin(notice.agent.id, key);
                        return { taskId: event.taskId, agentId: notice.agent.id, attemptId: key, mode: 'read-only', operation: 'file', cwd: event.projectRoot, repositoryRoot: event.projectRoot, writeScopes: [], assertCurrent };
                    },
                    run: (policy, next) => readFence.run(event.projectRoot, policy.assertCurrent, () => options.boundary.run(policy, next), [directory]),
                    invoke: async (action, signal) => {
                        const selected = route();
                        if (selected === undefined || tools === undefined)
                            throw new Error('repair configuration changed');
                        const toolSet = await tools.resolve({ agent: notice.agent, modelSelection: selected, signal }), callId = `swarm-repair-${randomUUID()}`;
                        internalCalls.add(callId);
                        try {
                            const batch = await tools.execute({ agent: notice.agent, calls: [{ type: 'tool-call', id: callId, name: action.tool, arguments: JSON.stringify(action.arguments) }], signal, toolSet });
                            const row = batch.results[0];
                            if (batch.results.length !== 1 || row?.callId !== callId)
                                throw new Error('manual_required: uncorrelated tool result');
                            return { ok: !row.result.isError, value: row.result.value, sideEffectState: 'none' };
                        }
                        finally {
                            internalCalls.delete(callId);
                            toolSet.dispose();
                        }
                    }
                } });
        },
        handoff: async (report, key) => {
            const owner = [...stores.values()].find(s => s.store.get(report.fingerprint)?.last_repair_task_id === key);
            if (owner === undefined)
                throw new Error('handoff scope unavailable');
            owner.notice.assertCurrent();
            const agent = owner.notice.rootAgent;
            const sessions = options.ctx.get('sessions');
            if (agent.send === undefined || agent.inbox === undefined || agent.session?.deriveMessages === undefined)
                throw new Error('Host has no idempotent public inbox inspection');
            if (sessions?.flush === undefined)
                throw new Error('RECOVERY_HANDOFF_DURABILITY_UNAVAILABLE');
            const present = () => [...agent.inbox.nextTurn, ...agent.inbox.nextStep, ...agent.session.deriveMessages()].some(m => m.id === key);
            if (!present())
                agent.send({ id: key, role: 'user', source: { kind: 'swarm-repair', form: 'notice', summary: '补阙已验证本次故障恢复，原任务验收规则不变' }, content: [{ type: 'text', text: JSON.stringify(report) }] }, 'next-step', false);
            await sessions.flush(agent.session);
            owner.notice.assertCurrent();
            if (!present())
                throw new Error('RECOVERY_HANDOFF_RECEIPT_MISSING');
            return { key, persisted: true };
        },
        onReport: report => options.log(JSON.stringify({ event: 'swarm-repair-review', report }))
    });
    const lifecycle = createFailureRecovery({
        subscribe: listener => options.subscribe(async (notice) => {
            if (closed)
                throw new Error('RECOVERY_CLOSED');
            if (route() === undefined)
                return;
            startMaintenance();
            const event = validateFailureEvent(notice.event);
            if (event.repairDepth !== 0)
                throw new Error('NESTED_REPAIR');
            const work = (async () => {
                const key = noticeKey(event), scope = scopeKey(event);
                if (!notices.has(key))
                    notices.set(key, notice);
                noticeUses.set(key, (noticeUses.get(key) ?? 0) + 1);
                scopeUses.set(scope, (scopeUses.get(scope) ?? 0) + 1);
                try {
                    await processor.drainHandoffs(event);
                    const outcome = await listener(event);
                    if (outcome.delivery === 'pending')
                        options.log(JSON.stringify({ event: 'swarm-repair-handoff-pending', taskId: event.taskId, repairTaskId: outcome.repairTaskId }));
                    // 重复通知没有 owner；且只封存本次取得的 UUID，不能读取后来 owner 的 key。
                    if (outcome.status !== 'deduped' && outcome.repairTaskId !== undefined)
                        options.boundary.seal?.(notice.agent.id, outcome.repairTaskId);
                }
                catch (error) {
                    options.log(`补阙回调失败 task=${event.taskId} kind=${event.failureKind} error=${error instanceof Error ? error.name : 'unknown'}`);
                }
                finally {
                    const keyUses = noticeUses.get(key) - 1, active = scopeUses.get(scope) - 1;
                    if (keyUses === 0) {
                        noticeUses.delete(key);
                        notices.delete(key);
                    }
                    else
                        noticeUses.set(key, keyUses);
                    if (active === 0) {
                        scopeUses.delete(scope);
                        stores.get(scope)?.store.close();
                        stores.delete(scope);
                    }
                    else
                        scopeUses.set(scope, active);
                }
            })();
            pendingNotices.add(work);
            try {
                await work;
            }
            finally {
                pendingNotices.delete(work);
            }
        }),
        assertCurrent: event => noticeOf(event).assertCurrent(), process: processor.process
    });
    startMaintenance();
    return { isInternalCall: (id) => id !== undefined && internalCalls.has(id), dispose: async () => { closed = true; maintenance.dispose(); stop.abort(new Error('recovery runtime disposed')); await lifecycle.dispose(); await Promise.allSettled(pendingNotices); for (const entry of stores.values())
            entry.store.close(); for (const fence of readFences.values())
            fence.dispose(); stores.clear(); notices.clear(); } };
};
//# sourceMappingURL=host-runtime.js.map