import Schema from '@deepseek-ai/schemastery';
import { SWARM_SERVICE, getAgentHeader } from './host-contract.js';
import { LANGUAGE_NAMES, LANGUAGE_PLACEHOLDER, RELAXED_LANGUAGE_INSTRUCTION, getLanguageInstruction } from './language.js';
import { getPromptStyle } from './model-family.js';
import { ROLE_IDS, GOAL_CHILD_BOUNDARY, GOAL_NON_HUMAN_BOUNDARY, getChildPersona, isDelegableRoleId, isRoleId } from './role-registry.js';
import { getRouterToolVisibility } from './router-worker.js';
import { readLive } from './util/live.js';
import { SwarmError } from './util/errors.js';
export const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix';
export const OUTPUT_LANGUAGE_SECTION = 'dsh-agent-swarm:output-language';
export const GOAL_TOOL_SECTION = 'tool:goal';
export const GOAL_BOUNDARY_SECTION = 'dsh-agent-swarm:goal-boundary';
/** Set only by the locally patched 0.2.2 Host that supports safe step re-preparation. */
export const STEP_MODEL_BRIDGE = Symbol.for('dsh-agent-swarm/step-model-bridge-v1');
/**
 * 按 Host 当前 open turn 的真实来源判定 goal 权限。
 * 信息缺失或读取失败时保守判为非 human，绝不把未知来源提升为人类授权。
 */
export const getGoalAuthority = (agent, agents) => {
    if (agent === undefined || getAgentHeader(agent).parentSession !== undefined)
        return 'child';
    const session = agent.session;
    if (session?.header?.origin === 'subagent')
        return 'child';
    try {
        const events = session?.snapshotEvents?.();
        const boundary = agents?.turnBoundaryOf?.(session);
        if (events === undefined || boundary === undefined || boundary.openTurnStartSeq === null)
            return 'non-human';
        for (let seq = boundary.openTurnStartSeq + 1; seq < events.length; seq += 1) {
            const event = events[seq];
            if (event?.type === 'user/message' && event.data?.source?.kind === 'user')
                return 'direct-human';
        }
    }
    catch {
        return 'non-human';
    }
    return 'non-human';
};
/**
 * 每次组装系统提示时：把各段里的 {$language} 换成设置页选择的语言，并在末尾追加用该语言书写的输出语言要求；
 * 委派出的子会话（0.2.1 起其 persona 来自静态角色预设）换成按实际路由模型家族生成的委派专用 persona。
 * @param {PromptAssemblyLike} assembled - 宿主组装结果
 * @param {{ language: OutputLanguage; promptStyle: PromptStylePolicy; child?: ChildPromptInfo; goalAuthority?: GoalAuthority }} options - 语言、提示风格、子会话身份与目标权限
 * @returns {PromptAssemblyLike} 新的组装结果
 */
export const getRuntimeAssembly = (assembled, options) => {
    const child = options.child;
    const goalAuthority = options.goalAuthority ?? (child === undefined ? 'direct-human' : 'child');
    const language = child?.explicitLanguage === true ? child.language ?? options.language : options.language;
    const variables = assembled.variables ?? {};
    const excluded = child !== undefined && child.explicitLanguage !== true && typeof variables.provider === 'string' && options.languageExclusions?.includes(variables.provider) === true;
    const dynamic = child !== undefined && options.dynamicLanguage === true;
    const style = getPromptStyle({ ...(variables.provider === undefined ? {} : { provider: variables.provider }), ...(variables.model === undefined ? {} : { model: variables.model }) }, options.promptStyle);
    const originalSections = (Array.isArray(assembled.sections) ? assembled.sections : []).filter((section) => section.name !== OUTPUT_LANGUAGE_SECTION);
    const hadGoalGuidance = originalSections.some((section) => section.name === GOAL_TOOL_SECTION);
    const sections = originalSections.filter((section) => goalAuthority === 'direct-human' || section.name !== GOAL_TOOL_SECTION).map((section) => {
        if (child !== undefined && section.name === PERSONA_PREFIX_SECTION)
            return { ...section, text: child.persona ?? getChildPersona(child.role, child.mode, style, excluded || dynamic ? null : language), interpolate: false };
        return section.text.includes(LANGUAGE_PLACEHOLDER) ? { ...section, text: section.text.replaceAll(LANGUAGE_PLACEHOLDER, LANGUAGE_NAMES[language]) } : section;
    });
    const boundary = hadGoalGuidance && goalAuthority !== 'direct-human'
        ? [{ name: GOAL_BOUNDARY_SECTION, order: 129, text: goalAuthority === 'child' ? GOAL_CHILD_BOUNDARY : GOAL_NON_HUMAN_BOUNDARY, interpolate: false }]
        : [];
    const promptSections = [...sections, ...boundary];
    // alpha2 将每段 order 持久化到 system/message，新增段不能带 undefined。
    return { ...assembled, sections: excluded || dynamic ? promptSections : [...promptSections, { name: OUTPUT_LANGUAGE_SECTION, order: 130, text: getLanguageInstruction(language, child?.explicitLanguage === true), interpolate: false }] };
};
/** 预设行：挂在全部 13 个预设上，在预设作用域内改写路由并处理回退 */
export const name = 'dsh-agent-swarm-runtime';
export const inject = [SWARM_SERVICE];
export const Config = Schema.object({
    role: Schema.union([...ROLE_IDS]).required().description('本预设对应的角色 ID')
});
/**
 * 运行时插件入口
 * @param {PluginContextLike} ctx - 预设作用域上下文
 * @param {unknown} config - `{ role }`
 */
export const apply = (ctx, config) => {
    const service = ctx.get(SWARM_SERVICE);
    if (service === undefined)
        return;
    const agents = ctx.get('agents');
    const role = readLive(config?.role);
    const presetRole = isRoleId(role) ? role : undefined;
    const systemPrompt = ctx.get('systemPrompt');
    const dynamicLanguage = typeof systemPrompt?.context === 'function' && typeof systemPrompt.refreshContext === 'function';
    const admittedProviders = new Map();
    const rootToolScopes = new Map();
    const claimedHumanTurns = new WeakMap();
    const currentGoalAuthority = (agent) => {
        const committed = getGoalAuthority(agent, agents);
        if (committed !== 'non-human' || agent === undefined)
            return committed;
        const start = agents?.turnBoundaryOf?.(agent.session)?.openTurnStartSeq;
        return typeof start === 'number' && claimedHumanTurns.get(agent) === start && agents?.get?.(agent.id) === agent ? 'direct-human' : 'non-human';
    };
    // 首次 assemble 早于 user/message 落盘；只采用 Host 已领取的真实输入，不采信模型转述。
    ctx.on('agent/inbox/claimed', (payload) => {
        const agent = payload.agent;
        if (payload.message.source?.kind !== 'user' || agents?.get?.(agent.id) !== agent || getGoalAuthority(agent, agents) === 'child')
            return;
        const start = agents?.turnBoundaryOf?.(agent.session)?.openTurnStartSeq;
        const events = agent.session?.snapshotEvents?.();
        const event = typeof start === 'number' ? events?.[start] : undefined;
        if (typeof start === 'number' && event?.type === 'turn/start' && event.data?.turn === payload.turn)
            claimedHumanTurns.set(agent, start);
    });
    const currentRole = (agent) => {
        const projected = service.getRoleForAgent?.(agent);
        if (projected !== undefined)
            return projected;
        if (agent === undefined || getAgentHeader(agent).agentPreset !== undefined)
            return undefined;
        const managed = service.isManagedAgent?.(agent);
        return managed === false ? undefined : presetRole;
    };
    const childOf = (agent) => {
        if (agent === undefined || getAgentHeader(agent).parentSession === undefined)
            return undefined;
        const role = currentRole(agent);
        if (!isDelegableRoleId(role))
            return undefined;
        const remembered = service.getChildPrompt(agent.id);
        return remembered?.role === role ? remembered : { role };
    };
    if (dynamicLanguage)
        systemPrompt.context({
            name: OUTPUT_LANGUAGE_SECTION, order: 130, required: true, interpolate: false,
            text: ({ agent }) => {
                const child = childOf(agent);
                if (child === undefined || agent === undefined)
                    return '';
                const policy = service.getConfig().agents;
                const provider = admittedProviders.get(agent.id);
                if (child.explicitLanguage !== true && provider !== undefined && policy.languageExclusions.includes(provider))
                    return RELAXED_LANGUAGE_INSTRUCTION;
                return getLanguageInstruction(child.explicitLanguage === true ? child.language ?? policy.language : policy.language, child.explicitLanguage === true);
            }
        });
    const isTracked = (agent) => isRoleId(currentRole(agent))
        || getAgentHeader(agent).agentPreset === undefined && service.routeState.getChildRole(agent.id) !== undefined;
    const hasStepModelBridge = (agent) => agent[STEP_MODEL_BRIDGE] === true;
    const ApplyRootToolScope = (agent) => {
        if (currentRole(agent) !== 'tian_shu' || getAgentHeader(agent).parentSession !== undefined)
            return;
        const scoped = agent;
        const tools = scoped.ctx?.get?.('tools');
        if (tools?.schemas === undefined || tools.restrict === undefined)
            return;
        rootToolScopes.get(agent.id)?.dispose();
        rootToolScopes.delete(agent.id);
        const visible = tools.schemas(agent).map((schema) => schema.name);
        const goalAuthority = currentGoalAuthority(agent);
        const boundary = getRouterToolVisibility(visible, goalAuthority === 'direct-human', service.getConfig().router?.workspaceWrites === 'allow');
        if (boundary.reservedTransport.length > 0) {
            const message = `天枢默认不允许保留传输工具 ${boundary.reservedTransport.join(', ')}；请使用 native 呈现或委派 Worker`;
            ctx.logger?.('dsh-agent-swarm-runtime').warn(message);
            throw new SwarmError('SERVICE_UNAVAILABLE', message);
        }
        if (boundary.deny.length === 0)
            return;
        try {
            rootToolScopes.set(agent.id, { dispose: tools.restrict({ deny: [...boundary.deny] }) });
        }
        catch (error) {
            ctx.logger?.('dsh-agent-swarm-runtime').warn(`天枢工具作用域收窄失败：${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`);
            throw new SwarmError('SERVICE_UNAVAILABLE', '天枢工具作用域收窄失败，未发起模型请求');
        }
    };
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const assembled = await next();
        const agent = context?.agent;
        const config = service.getConfig();
        // 宿主冷恢复的持久子会话可能早于本插件登记：按所在角色预设兜底
        const child = childOf(agent);
        const goalAuthority = currentGoalAuthority(agent);
        return getRuntimeAssembly(assembled, { language: config.agents.language, languageExclusions: config.agents.languageExclusions, dynamicLanguage, promptStyle: config.agents.promptStyle, ...(child === undefined ? {} : { child }), goalAuthority });
    });
    // Only the Host's explicit selection event means the user changed the picker.
    // Automatic request/header updates are observations, not selection intent.
    ctx.on('session/event', (session, event) => {
        const managedRole = currentRole({ id: session.id, session });
        // Never create Source journal/session state for unrelated DSH sessions.
        if (!isRoleId(managedRole))
            return;
        try {
            service.ObserveSessionEvent?.(session.id, event);
        }
        catch (error) {
            ctx.logger?.('dsh-agent-swarm-runtime').warn(`Source event observation failed without blocking the Host turn: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`);
        }
        if (event.type !== 'model/selection' || !isRoleId(managedRole))
            return;
        const data = event.data;
        if (typeof data?.provider !== 'string' || typeof data.model !== 'string')
            return;
        const selected = { provider: data.provider, model: data.model, ...(typeof data.reasoningEffort === 'string' ? { reasoningEffort: data.reasoningEffort } : {}) };
        service.routeState.RecordUserSelection(session.id, selected, event.seq);
        service.agentControl?.ObserveSelection(session.id, selected);
    });
    const prepareRoute = async (payload, next, beforeStep) => {
        await service.WaitAgentReady(payload.agent, payload.signal);
        if (!beforeStep)
            await service.BeforeManagedRequest(payload.agent);
        ApplyRootToolScope(payload.agent);
        // 0.2.1-alpha 起宿主不再接受启动期 toolFilter：子智能体的第一次请求在这里按角色限制继承工具面，
        // 发生在工具清单装配之前；旧宿主该方法为空实现，启动期 toolFilter 仍然生效。
        const role = currentRole(payload.agent);
        if (isDelegableRoleId(role) && getAgentHeader(payload.agent).parentSession !== undefined) {
            service.ApplyChildToolScope(payload.agent, role, service.ChildAllowWebFor(payload.agent.id));
        }
        if (isTracked(payload.agent))
            await service.routeState.WaitHealthReady(payload.agent.id, payload.signal);
        if (isTracked(payload.agent) && payload.turn !== undefined && payload.step !== undefined)
            service.routeState.BeginRequestStep(payload.agent.id, payload.turn, payload.step);
        const resolved = await next();
        const projection = ctx.get('sessionProjections')?.stateOf(payload.agent.session, 'modelSelection');
        const explicitSelectionAvailable = projection !== null && typeof projection === 'object' && 'pending' in projection;
        await service.routeState.PreparePreferredRecovery(payload.agent, resolved, presetRole, service.getConfig());
        await service.routeState.PrepareQuotaRouting(payload.agent, resolved, presetRole, service.getConfig(), payload.signal);
        if (isTracked(payload.agent))
            await service.routeState.WaitHealthReady(payload.agent.id, payload.signal);
        const result = await service.routeState.AdmitRequest(payload.agent, resolved, presetRole, service.getConfig(), explicitSelectionAvailable, payload.signal);
        admittedProviders.set(payload.agent.id, result.provider);
        return result;
    };
    // The bridge runs before the Host freezes the step's model, tools and prompt.
    // It is deliberately inert on stock Hosts and all existing 0.2.1 runtimes.
    ctx.on('agent/swarm-model-select', async (payload, next) => {
        if (!hasStepModelBridge(payload.agent) || service.isManagedAgent?.(payload.agent) === false)
            return next();
        const selected = await prepareRoute(payload, next, true);
        return { provider: selected.provider, model: selected.model, ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) };
    });
    ctx.on('agent/request', async (payload, next) => {
        if (service.isManagedAgent?.(payload.agent) === false)
            return next();
        const hostModel = payload.agent.model;
        if (!hasStepModelBridge(payload.agent) && typeof hostModel?.current === 'function' && typeof hostModel.select === 'function') {
            throw new SwarmError('SERVICE_UNAVAILABLE', '当前 DSH 在步骤准备后冻结模型，百工需要匹配此版本的模型切换桥接；未发起模型请求');
        }
        // On the patched Host routing has already happened before assembly; never
        // change the selection inside this deprecated waterfall.
        let result;
        if (hasStepModelBridge(payload.agent)) {
            try {
                await service.WaitAgentReady(payload.agent, payload.signal);
                await service.BeforeManagedRequest(payload.agent);
                result = await next();
            }
            catch (error) {
                service.routeState.ReleaseProbe(payload.agent.id);
                throw error;
            }
        }
        else
            result = await prepareRoute(payload, next, false);
        service.agentControl?.ObserveRequest(payload.agent.id, result);
        const selected = service.routeState.getChildOverride(payload.agent.id);
        if (selected !== undefined)
            service.agentControl?.ObserveSelection(payload.agent.id, selected);
        return result;
    });
    // prepend 在真实 Cordis waterfall 中先运行；没有调用 next 就截断宿主 retry 的 sleep。
    ctx.on('agent/request-error', async (payload, next) => {
        if (service.isManagedAgent?.(payload.agent) === false)
            return next();
        const result = await service.routeState.recover(payload, next, presetRole, service.getConfig(), ctx.get('compaction'));
        if (result === undefined)
            service.ObserveFailure?.(payload.agent, payload.failure, { signal: payload.signal });
        if (service.routeState.getTerminal(payload.agent.id) === 'context_recovery_required')
            service.agentControl?.MarkBlocked(payload.agent.id, 'context-recovery-required');
        return result;
    }, { prepend: true });
    ctx.on('agent/assistant-stream', (payload) => {
        if (!isTracked(payload.agent))
            return;
        if (payload.frame?.type === 'start' && typeof payload.frame.attemptId === 'string') {
            const actual = payload.agent.session?.requestHeader?.()?.config;
            service.routeState.MarkRequestStarted(payload.agent.id, payload.frame.attemptId, actual);
            service.agentControl?.MarkAttemptStarted(payload.agent.id, payload.frame.attemptId, service.routeState.getLastRoute(payload.agent.id));
        }
        // 真实宿主发布 end/committed（原始 finish 在 chunk 内）；失败只提交 assistant/attempt。
        if (payload.frame?.type === 'end' && payload.frame.outcome?.kind === 'committed' && payload.frame.outcome.eventType === 'assistant/message')
            service.routeState.MarkRequestSucceeded(payload.agent.id);
        if (payload.frame?.type === 'end' && typeof payload.frame.attemptId === 'string')
            service.agentControl?.MarkAttemptSettled(payload.agent.id, payload.frame.attemptId);
    });
    ctx.on('agent/disposed', (event) => {
        const id = event?.agent?.id;
        if (id !== undefined)
            rootToolScopes.get(id)?.dispose();
        if (id !== undefined)
            rootToolScopes.delete(id);
        if (id !== undefined)
            admittedProviders.delete(id);
        if (id !== undefined)
            service.routeState.ReleaseAgent(id);
    });
};
//# sourceMappingURL=runtime.js.map