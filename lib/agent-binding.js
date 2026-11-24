export class BindingError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'BindingError';
    }
}
export const bindingKey = (binding) => binding.agentId + ':' + binding.generation + ':' + binding.leaseEpoch;
export const validateBinding = (raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return false;
    const value = raw;
    const identifiers = ['agentId', 'rootSessionId', 'workspaceId', 'taskId', 'nodeId', 'attemptId', 'threadId', 'role'];
    return identifiers.every((key) => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 512 && !['__proto__', 'constructor', 'prototype'].includes(value[key])) &&
        ['cardRevision', 'workflowRevision', 'generation', 'leaseEpoch'].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 1) &&
        (value.requestRevision === undefined || (Number.isSafeInteger(value.requestRevision) && value.requestRevision >= 1)) &&
        ['active', 'suspended', 'revoked'].includes(value.state) && Array.isArray(value.permissions) && value.permissions.every((permission) => typeof permission === 'string' && permission.length <= 64) &&
        (value.blindReview === undefined || typeof value.blindReview === 'boolean');
};
/** 主状态里每个 agentId 保留的历史绑定条数；更老的条目先写归档再移出状态，分片数因此有界。 */
export const MAX_BINDING_HISTORY_PER_AGENT = 4;
/** Only host/service lifecycle code calls bind; tool parameters never create identities. */
export const createAgentBindingRegistry = (store, options = {}) => {
    const maxHistoryPerAgent = options.maxHistoryPerAgent ?? MAX_BINDING_HISTORY_PER_AGENT;
    if (!Number.isSafeInteger(maxHistoryPerAgent) || maxHistoryPerAgent < 1)
        throw new BindingError('BINDING_INVALID', 'Invalid binding history bound');
    /**
     * 归档旧条目并返回要删除的键：按「提交后的历史」排序，保留该 agentId 最近 N 条。
     * 归档先于状态删除：崩溃只会留下「已归档但仍在状态里」的重复，不会丢审计记录。
     */
    const pruneHistory = async (history, agentId, pending) => {
        const merged = new Map(Object.entries(history).filter(([, value]) => value.agentId === agentId));
        for (const [key, value] of Object.entries(pending))
            merged.set(key, value);
        const ranked = [...merged.entries()].sort((left, right) => right[1].generation - left[1].generation || right[1].leaseEpoch - left[1].leaseEpoch);
        // 保留最近 N 条：slice(0, N) 是保留，slice(N) 是跳过，写错会把全部历史都判成可归档。
        const keep = new Set(ranked.slice(0, maxHistoryPerAgent).map(([key]) => key));
        const prunable = Object.keys(history).filter((key) => history[key].agentId === agentId && !keep.has(key));
        if (prunable.length === 0)
            return [];
        if (options.archive !== undefined && (await options.archive(prunable.map((key) => history[key]))) === false)
            return [];
        return prunable;
    };
    const get = (agentId) => store.readPath === undefined ? store.read().bindings[agentId] : store.readPath(['bindings', agentId]);
    const requireActive = (agentId, permission) => {
        const binding = get(agentId);
        if (binding === undefined || binding.state !== 'active') {
            throw new BindingError('BINDING_INACTIVE', 'No active host-bound attempt for this agent');
        }
        if (permission !== undefined && !binding.permissions.includes(permission))
            throw new BindingError('PERMISSION_DENIED', 'Agent lacks capability: ' + permission);
        return binding;
    };
    return {
        get, requireActive,
        bind: async (input) => {
            let binding;
            // 补丁在 store 的互斥区内按冻结基线求值：读取、校验与写入之间没有其它写入者。
            await store.update('binding/bind', { build: async (state) => {
                    const old = state.bindings[input.agentId];
                    const history = {};
                    if (old !== undefined) {
                        const revoked = { ...old, state: 'revoked', revocationReason: 'superseded' };
                        history[bindingKey(old)] = revoked;
                    }
                    binding = { ...input, requestRevision: input.requestRevision ?? 1, permissions: [...new Set(input.permissions)], generation: (old?.generation ?? 0) + 1, leaseEpoch: (old?.leaseEpoch ?? 0) + 1, state: 'active' };
                    if (!validateBinding(binding))
                        throw new BindingError('BINDING_INVALID', 'Invalid host binding');
                    history[bindingKey(binding)] = binding;
                    const prunable = await pruneHistory(state.bindingHistory, input.agentId, history);
                    return {
                        set: { bindings: { [input.agentId]: binding }, bindingHistory: history },
                        ...(prunable.length === 0 ? {} : { remove: { bindingHistory: prunable } })
                    };
                } });
            return structuredClone(binding);
        },
        getHistorical: (binding) => store.readPath === undefined ? store.read().bindingHistory[bindingKey(binding)] : store.readPath(['bindingHistory', bindingKey(binding)]),
        revoke: async (agentId, reason = 'untrusted', expectedAttemptId) => {
            await store.update('binding/revoke', { build: async (state) => {
                    const old = state.bindings[agentId];
                    // A previous round may finish persistence after the same child has
                    // already received a new authorized attempt. Never revoke that attempt.
                    if (old === undefined || (expectedAttemptId !== undefined && old.attemptId !== expectedAttemptId))
                        return {};
                    const next = { ...old, state: 'revoked', revocationReason: reason };
                    const history = { [bindingKey(old)]: next };
                    const prunable = await pruneHistory(state.bindingHistory, agentId, { [bindingKey(old)]: next });
                    return {
                        set: { bindings: { [agentId]: next }, bindingHistory: history },
                        ...(prunable.length === 0 ? {} : { remove: { bindingHistory: prunable } })
                    };
                } });
        },
        suspend: async (agentId) => {
            await store.update('binding/suspend', { build: (state) => {
                    const old = state.bindings[agentId];
                    if (old === undefined)
                        return {};
                    const next = { ...old, state: 'suspended' };
                    return { set: { bindings: { [agentId]: next }, bindingHistory: { [bindingKey(old)]: next } } };
                } });
        },
        completeBlindReview: async (agentId) => {
            await store.update('binding/blind-review-complete', { build: (state) => {
                    const old = state.bindings[agentId];
                    if (old === undefined || old.state !== 'active')
                        throw new BindingError('BINDING_INACTIVE', 'No active review attempt');
                    const next = { ...old, blindReview: false };
                    return { set: { bindings: { [agentId]: next }, bindingHistory: { [bindingKey(old)]: next } } };
                } });
        }
    };
};
//# sourceMappingURL=agent-binding.js.map