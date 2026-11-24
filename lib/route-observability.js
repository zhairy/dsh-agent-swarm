import { createHmac, randomBytes } from 'node:crypto';
const DEFAULT_LIMITS = Object.freeze({
    maxRequests: 32,
    maxSelections: 16,
    maxAttempts: 16,
    maxFailures: 16,
    maxIgnoredFailures: 16,
    maxWaits: 32
});
const getLimit = (value, fallback) => typeof value === 'number' && Number.isSafeInteger(value) ? Math.min(128, Math.max(1, value)) : fallback;
const getFiniteNumber = (value, minimum = 0) => typeof value === 'number' && Number.isFinite(value) ? Math.max(minimum, value) : null;
const getStatus = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : null;
const cleanLabel = (value, fallback) => {
    const cleaned = value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 128);
    return cleaned === '' ? fallback : cleaned;
};
const cleanRoute = (route) => ({
    provider: cleanLabel(route.provider, 'unknown-provider'),
    model: cleanLabel(route.model, 'unknown-model'),
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: cleanLabel(route.reasoningEffort, 'unknown-effort') })
});
const getEmptyBudget = () => ({
    maxLogicalAttempts: null,
    logicalAttemptsUsed: 0,
    maxTransientRetries: null,
    transientRetriesUsed: 0,
    maxTransientWaitMs: null,
    transientWaitUsedMs: 0,
    maxHoldWaits: null,
    holdWaitsUsed: 0,
    maxHoldWaitMs: null,
    holdWaitUsedMs: 0
});
const trimOldest = (values, limit) => {
    if (values.length <= limit)
        return 0;
    const count = values.length - limit;
    values.splice(0, count);
    return count;
};
/**
 * 创建进程内有界路由观测器。
 *
 * 原始 agent/request/attempt 标识只在内部用于关联；投影使用进程随机密钥的
 * HMAC，重启后不可跨实例关联。调用方不得传入错误正文、账号标识或凭据。
 */
export const intRouteObservability = (options = {}) => {
    const now = options.now ?? Date.now;
    const limits = {
        maxRequests: getLimit(options.maxRequests, DEFAULT_LIMITS.maxRequests),
        maxSelections: getLimit(options.maxSelections, DEFAULT_LIMITS.maxSelections),
        maxAttempts: getLimit(options.maxAttempts, DEFAULT_LIMITS.maxAttempts),
        maxFailures: getLimit(options.maxFailures, DEFAULT_LIMITS.maxFailures),
        maxIgnoredFailures: getLimit(options.maxIgnoredFailures, DEFAULT_LIMITS.maxIgnoredFailures),
        maxWaits: getLimit(options.maxWaits, DEFAULT_LIMITS.maxWaits)
    };
    const redactionKey = randomBytes(32);
    const requests = [];
    const byKey = new Map();
    const activeByAgent = new Map();
    const waitLocations = new Map();
    let omittedRequests = 0;
    let sequence = 0;
    let waitSequence = 0;
    const getPublicId = (prefix, raw) => `${prefix}_${createHmac('sha256', redactionKey).update(raw).digest('base64url').slice(0, 18)}`;
    const getKey = (agentId, requestId) => `${agentId}\u0000${requestId}`;
    const getRequest = (agentId, requestId) => byKey.get(getKey(agentId, requestId));
    const touch = (request, at = now()) => { request.changedAt = Math.max(request.changedAt, getFiniteNumber(at) ?? request.changedAt); };
    const dropRequest = (request) => {
        if (byKey.get(request.key) === request)
            byKey.delete(request.key);
        if (activeByAgent.get(request.rawAgentId) === request.key)
            activeByAgent.delete(request.rawAgentId);
        for (const [waitId, location] of waitLocations)
            if (location.request === request)
                waitLocations.delete(waitId);
    };
    const trimRequests = () => {
        if (requests.length <= limits.maxRequests)
            return;
        const count = requests.length - limits.maxRequests;
        for (const request of requests.splice(0, count))
            dropRequest(request);
        omittedRequests += count;
    };
    const closeOpenAttempts = (request, at, outcome) => {
        for (const attempt of request.attempts) {
            if (attempt.outcome !== 'started')
                continue;
            attempt.outcome = outcome;
            attempt.endedAt = at;
        }
    };
    const findAttemptForFailure = (request, route) => {
        for (let index = request.attempts.length - 1; index >= 0; index--) {
            const attempt = request.attempts[index];
            if (attempt.outcome === 'started' && attempt.route?.provider === route.provider && attempt.route.model === route.model)
                return attempt;
        }
        return undefined;
    };
    const addFailure = (request, input, ignored) => {
        touch(request, input.at);
        const route = cleanRoute(input.route);
        const attempt = ignored ? undefined : findAttemptForFailure(request, route);
        if (attempt !== undefined) {
            attempt.outcome = 'failed';
            attempt.endedAt = input.at;
        }
        const failure = {
            at: input.at,
            kind: input.kind,
            route,
            status: getStatus(input.status),
            retryAfterMs: getFiniteNumber(input.retryAfterMs),
            ...(ignored ? {} : { attemptId: attempt?.attemptId ?? null, terminal: 'terminal' in input ? input.terminal ?? null : null })
        };
        if (ignored) {
            request.ignoredFailures.push({ ...failure, reason: input.reason });
            request.omittedIgnoredFailures += trimOldest(request.ignoredFailures, limits.maxIgnoredFailures);
        }
        else {
            request.failures.push(failure);
            request.omittedFailures += trimOldest(request.failures, limits.maxFailures);
        }
    };
    const finishRequest = (input) => {
        const request = getRequest(input.agentId, input.requestId);
        if (request === undefined || request.final !== 'pending')
            return;
        touch(request, input.at);
        request.final = input.final;
        request.endReason = input.endReason;
        request.endedAt = input.at;
        request.terminal = input.terminal ?? null;
        closeOpenAttempts(request, input.at, input.final === 'succeeded' ? 'succeeded' : input.final === 'cancelled' ? 'cancelled' : 'unsettled');
        if (activeByAgent.get(input.agentId) === request.key)
            activeByAgent.delete(input.agentId);
    };
    const BeginRequest = (input) => {
        const key = getKey(input.agentId, input.requestId);
        const activeKey = activeByAgent.get(input.agentId);
        if (activeKey !== undefined && activeKey !== key) {
            const previous = byKey.get(activeKey);
            if (previous !== undefined && previous.final === 'pending') {
                previous.final = 'superseded';
                previous.endReason = 'new_request';
                previous.endedAt = input.at;
                closeOpenAttempts(previous, input.at, 'unsettled');
            }
        }
        let request = byKey.get(key);
        if (request === undefined) {
            const publicRequestId = getPublicId('req', key);
            request = {
                requestId: publicRequestId,
                scope: input.scope,
                position: input.position === undefined ? null : { ...input.position },
                startedAt: input.at,
                endedAt: null,
                final: 'pending',
                endReason: null,
                terminal: null,
                selections: [],
                attempts: [],
                failures: [],
                ignoredFailures: [],
                waits: [],
                budget: getEmptyBudget(),
                omittedSelections: 0,
                omittedAttempts: 0,
                omittedFailures: 0,
                omittedIgnoredFailures: 0,
                omittedWaits: 0,
                rawAgentId: input.agentId,
                key,
                sequence: ++sequence,
                changedAt: input.at
            };
            requests.push(request);
            byKey.set(key, request);
            trimRequests();
        }
        else {
            request.scope = input.scope;
            if (input.position !== undefined)
                request.position = { ...input.position };
        }
        touch(request, input.at);
        activeByAgent.set(input.agentId, key);
    };
    return {
        BeginRequest,
        AddSelection: (input) => {
            const request = getRequest(input.agentId, input.requestId);
            if (request === undefined)
                return;
            touch(request, input.at);
            request.selections.push({ ordinal: input.ordinal, at: input.at, route: cleanRoute(input.route), attemptId: null });
            request.omittedSelections += trimOldest(request.selections, limits.maxSelections);
        },
        AddAttemptStart: (input) => {
            const request = getRequest(input.agentId, input.requestId);
            if (request === undefined)
                return;
            touch(request, input.at);
            const actual = input.route === undefined ? undefined : cleanRoute(input.route);
            let selection;
            for (let index = request.selections.length - 1; index >= 0; index--) {
                const candidate = request.selections[index];
                if (candidate.attemptId !== null)
                    continue;
                if (actual !== undefined && (candidate.route.provider !== actual.provider || candidate.route.model !== actual.model))
                    continue;
                selection = candidate;
                break;
            }
            const attemptId = getPublicId('att', `${request.key}\u0000${input.attemptId}`);
            const route = actual ?? selection?.route ?? null;
            const routeSource = actual !== undefined ? 'host-request-header' : route === null ? 'unavailable' : 'selected-admission';
            if (selection !== undefined)
                selection.attemptId = attemptId;
            request.attempts.push({ attemptId, startedAt: input.at, endedAt: null, route, routeSource, outcome: 'started' });
            request.omittedAttempts += trimOldest(request.attempts, limits.maxAttempts);
        },
        AddFailure: (input) => {
            const request = getRequest(input.agentId, input.requestId);
            if (request !== undefined)
                addFailure(request, input, false);
        },
        AddIgnoredFailure: (input) => {
            const request = getRequest(input.agentId, input.requestId);
            if (request !== undefined)
                addFailure(request, input, true);
        },
        BeginWait: (input) => {
            const request = getRequest(input.agentId, input.requestId);
            if (request === undefined)
                return null;
            touch(request, input.at);
            const waitId = getPublicId('wait', `${request.key}\u0000${++waitSequence}`);
            request.waits.push({
                waitId,
                reason: input.reason,
                startedAt: input.at,
                plannedMs: getFiniteNumber(input.plannedMs),
                endedAt: null,
                waitedMs: null,
                outcome: 'waiting',
                reportedRecovered: null,
                route: input.route === undefined ? null : cleanRoute(input.route),
                failureKind: input.failureKind ?? null
            });
            request.omittedWaits += trimOldest(request.waits, limits.maxWaits);
            waitLocations.set(waitId, { request, index: request.waits.length - 1 });
            return waitId;
        },
        EndWait: (waitId, result) => {
            if (waitId === null)
                return;
            const location = waitLocations.get(waitId);
            if (location === undefined)
                return;
            waitLocations.delete(waitId);
            const wait = location.request.waits[location.index];
            if (wait === undefined || wait.waitId !== waitId)
                return;
            touch(location.request, result.at);
            wait.endedAt = result.at;
            wait.waitedMs = getFiniteNumber(result.waitedMs) ?? Math.max(0, result.at - wait.startedAt);
            wait.outcome = result.outcome;
            wait.reportedRecovered = result.reportedRecovered ?? null;
        },
        UpdateBudget: (input) => {
            const request = getRequest(input.agentId, input.requestId);
            if (request !== undefined) {
                touch(request);
                request.budget = { ...input.budget };
            }
        },
        FinishRequest: finishRequest,
        getSnapshot: (agentIds) => {
            const allowed = agentIds === undefined ? undefined : new Set(agentIds);
            const projected = requests
                .filter((request) => allowed === undefined || allowed.has(request.rawAgentId))
                .sort((left, right) => left.startedAt - right.startedAt || left.sequence - right.sequence)
                .map((request) => ({
                requestId: request.requestId,
                scope: request.scope,
                position: request.position === null ? null : { ...request.position },
                startedAt: request.startedAt,
                endedAt: request.endedAt,
                final: request.final,
                endReason: request.endReason,
                terminal: request.terminal,
                selections: request.selections.map((selection) => ({ ...selection, route: { ...selection.route } })),
                attempts: request.attempts.map((attempt) => ({ ...attempt, route: attempt.route === null ? null : { ...attempt.route } })),
                failures: request.failures.map((failure) => ({ ...failure, route: { ...failure.route } })),
                ignoredFailures: request.ignoredFailures.map((failure) => ({ ...failure, route: { ...failure.route } })),
                waits: request.waits.map((wait) => ({ ...wait, route: wait.route === null ? null : { ...wait.route } })),
                budget: { ...request.budget },
                omittedSelections: request.omittedSelections,
                omittedAttempts: request.omittedAttempts,
                omittedFailures: request.omittedFailures,
                omittedIgnoredFailures: request.omittedIgnoredFailures,
                omittedWaits: request.omittedWaits
            }));
            return {
                schemaVersion: 1,
                // 读投影不能推进时钟或让空任务因轮询改变；只反映可见请求的最近事实。
                generatedAt: requests.filter(request => allowed === undefined || allowed.has(request.rawAgentId)).reduce((at, request) => Math.max(at, request.changedAt), 0),
                retainedRequests: projected.length,
                omittedRequests,
                requests: projected
            };
        }
    };
};
//# sourceMappingURL=route-observability.js.map