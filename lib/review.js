import { getRedactedText, isJevProbability, isJevScore } from './jev.js';
const getReviewMismatches = (task, record, currentArtifactDigest) => {
    const mismatches = [];
    if (record.status !== 'completed')
        mismatches.push('status');
    if (record.finalization !== 'ready')
        mismatches.push('finalization');
    if (record.staleReason !== undefined)
        mismatches.push('stale');
    if ((record.cardRevision ?? 1) !== (task.cardRevision ?? 1))
        mismatches.push('card');
    if ((record.workflowRevision ?? 1) !== (task.workflowRevision ?? 1))
        mismatches.push('workflow');
    if ((record.requestRevision ?? 1) !== (task.requestRevision ?? 1))
        mismatches.push('request');
    if (currentArtifactDigest === undefined)
        mismatches.push('artifact-unavailable');
    else if (record.artifactAfter === undefined || record.artifactBefore === undefined)
        mismatches.push('artifact-missing');
    else if (record.artifactBefore !== record.artifactAfter)
        mismatches.push('artifact-changed');
    else if (record.artifactAfter !== currentArtifactDigest)
        mismatches.push('artifact');
    return mismatches;
};
const getCurrentPeerReviewBinding = (task, artifactDigest) => ({
    taskId: task.taskId,
    cardRevision: task.cardRevision ?? 1,
    workflowRevision: task.workflowRevision ?? 1,
    requestRevision: task.requestRevision ?? 1,
    ...(artifactDigest === undefined ? {} : { artifactDigest })
});
/**
 * 从持久委派记录恢复独立初审状态，只认可绑定当前 task/card/workflow/request/artifact 的
 * 已完成 blind 记录。summary、对话历史和其他模型叙述不参与判断。
 *
 * @param task 当前任务
 * @param records 当前任务的全部持久委派记录
 * @param role 独立审查角色
 * @param mode 算衡模式；御史传 undefined
 * @param currentArtifactDigest 恢复时重新核验的当前产物摘要；缺省时读取任务快照
 * @returns 当前可用的评审阶段与精确冻结绑定
 */
export const getPeerReviewRecovery = (task, records, role, mode, currentArtifactDigest = task.artifactSnapshot?.digest) => {
    const current = getCurrentPeerReviewBinding(task, currentArtifactDigest);
    const candidates = records.filter((record) => record.taskId === task.taskId && record.role === role
        && (role !== 'suan_heng' || record.mode === mode));
    const blindCandidates = candidates.filter((record) => record.reviewPhase === 'blind');
    const diagnoses = blindCandidates.map((record) => ({ record, mismatches: getReviewMismatches(task, record, currentArtifactDigest) }));
    const frozen = diagnoses.filter((item) => item.mismatches.length === 0)
        .sort((left, right) => (right.record.finishedAt ?? right.record.startedAt) - (left.record.finishedAt ?? left.record.startedAt))[0];
    if (frozen !== undefined) {
        const record = frozen.record;
        return {
            current,
            availablePhases: ['blind', 'response'],
            frozenBlind: {
                ...current,
                delegationId: record.delegationId,
                artifactDigest: record.artifactAfter,
                hardIsolation: record.hardIsolation
            },
            hasResponseOnly: false,
            hasUnclassifiedReview: false,
            staleEvidence: false
        };
    }
    const closest = [...diagnoses].sort((left, right) => left.mismatches.length - right.mismatches.length
        || (right.record.finishedAt ?? right.record.startedAt) - (left.record.finishedAt ?? left.record.startedAt))[0];
    return {
        current,
        availablePhases: ['blind'],
        ...(closest === undefined ? {} : {
            priorBlind: {
                delegationId: closest.record.delegationId,
                cardRevision: closest.record.cardRevision ?? 1,
                workflowRevision: closest.record.workflowRevision ?? 1,
                requestRevision: closest.record.requestRevision ?? 1,
                ...(closest.record.artifactAfter === undefined ? {} : { artifactDigest: closest.record.artifactAfter }),
                mismatches: closest.mismatches
            }
        }),
        hasResponseOnly: candidates.some((record) => record.reviewPhase === 'response'),
        hasUnclassifiedReview: candidates.some((record) => record.reviewPhase === undefined),
        staleEvidence: closest?.mismatches.some((item) => item === 'artifact' || item === 'artifact-changed') === true
    };
};
const PEER_REVIEW_MISMATCH_LABELS = {
    status: '状态未完成',
    finalization: '收尾未确认',
    stale: '记录已失效',
    card: 'card 版本不一致',
    workflow: 'workflow 版本不一致',
    request: 'request 版本不一致',
    'artifact-missing': 'artifact 未冻结',
    'artifact-changed': 'artifact 审查期间变化',
    'artifact-unavailable': '当前 artifact 无法确认',
    artifact: 'artifact 不一致'
};
const getPeerReviewBindingText = (binding) => `task ${binding.taskId} / card ${binding.cardRevision} / workflow ${binding.workflowRevision} / request ${binding.requestRevision} / artifact ${binding.artifactDigest ?? '无法确认'}`;
/**
 * 生成给 Agent 的准确评审阶段说明；不把用户提示、摘要或历史叙述当作冻结证据。
 *
 * @param info 持久记录恢复出的评审状态
 * @returns 可直接进入委派提示的说明
 */
export const getPeerReviewRecoveryText = (info) => {
    if (info.frozenBlind !== undefined) {
        return `评审阶段证据：当前可用 blind/response。冻结初审 ${info.frozenBlind.delegationId}：${getPeerReviewBindingText(info.frozenBlind)}。`
            + '该记录只与上述版本和产物绑定；模型摘要或历史叙述不算冻结证据。';
    }
    const prior = info.priorBlind === undefined ? '没有可恢复的 blind 记录'
        : `历史初审 ${info.priorBlind.delegationId} 绑定 card ${info.priorBlind.cardRevision} / workflow ${info.priorBlind.workflowRevision} / request ${info.priorBlind.requestRevision} / artifact ${info.priorBlind.artifactDigest ?? '未冻结'}，但${info.priorBlind.mismatches.map((item) => PEER_REVIEW_MISMATCH_LABELS[item]).join('、')}`;
    const responseOnly = info.hasResponseOnly ? '；仅有 response 记录，不能替代独立初审' : '';
    const unclassified = info.hasUnclassifiedReview ? '；存在未显式声明 blind 的阶段记录，不能恢复为冻结初审' : '';
    return `评审阶段证据：当前只开放 blind，response 不可用。${prior}${responseOnly}${unclassified}。当前 ${getPeerReviewBindingText(info.current)}。`
        + '请使用 review_phase=blind 重新独立审查当前版本；不要再次提交 response。模型摘要或历史叙述不算冻结证据。';
};
const getPhaseReviewState = (task) => task.card.planningScope === undefined ? {} : {
    completion_scope: 'phase', whole_goal_completed: false,
    planning_scope: {
        rationale: getRedactedText(task.card.planningScope.rationale),
        deliverables: task.card.planningScope.deliverables.map((item) => getRedactedText(item, 300)),
        deferred: task.card.planningScope.deferred.map((item) => getRedactedText(item, 300))
    }
};
export const DEFAULT_REVIEW_THRESHOLDS = { trustedAbove: 0.67, doubtfulBelow: 0.4 };
const SUPPORTED_TRUSTED = 0.6;
const SUPPORTED_DOUBTFUL = 0.35;
/** 四档可信度（低 → 高） */
export const RELIABILITY_LEVELS = [
    '不可靠：结论与证据矛盾，或基本没有依据',
    '存疑：关键结论缺少证据，或推导有明显跳跃',
    '基本可信：结论有依据，存在次要缺口',
    '可信：结论与证据一致，覆盖完整'
];
const COMMON_QUESTIONS = {
    supported: {
        type: 'noul',
        instructions: '交付中的主要结论有证据、推导或可复现的命令结果支撑',
        criteria: { true: '结论与给出的证据或推导一致，且依据具体', false: '结论缺少依据、依据笼统，或与证据矛盾' }
    },
    complete: {
        type: 'noul',
        instructions: '交付完整回应了任务目标与验收标准，没有遗漏关键部分',
        criteria: { true: '目标与每条验收标准都有对应的结论或产出', false: '有目标或验收标准没有被回应，或只回应了一部分' }
    },
    reliability: { type: 'score', instructions: '这份交付整体可以信赖的程度', criteria: [...RELIABILITY_LEVELS] }
};
/** 角色专项检查：审核结论是否成立、方案是否站得住 */
const ROLE_CHECKS = {
    mou_ding: '候选方案都满足约束表，推荐方案与决策点的理由和约束一致，没有遗漏明显更优的方案',
    shu_ji: '边界、接口与故障场景具体到模块，迁移与回退方案可以执行',
    suan_heng: '结论都有证明或反例，前提、不变量与复杂度分析前后自洽',
    'suan_heng:research': '候选算法的不变量、复杂度与数值误差分析自洽，结论都有证明或明确标为未证实',
    'suan_heng:verify': '验算独立完成：证明或反例具体可复核，没有默认任何已有结论正确',
    tan_wei: '每条发现都给出具体路径与证据片段，调用链可以核对',
    bo_wen: '来源权威且与结论直接相关，版本与日期明确',
    guan_xiang: '观察只陈述图中可见的事实，推断与观察区分清楚，不确定处已标出',
    zhu_jian: '改动与任务范围一致，列出了需要验证的假设与待验证事项',
    xing_zhou: '每条命令都记录了退出码，未执行的步骤给出了原因',
    ji_feng: '改动小而局部，并有通过的本地检查',
    yu_shi: '每条发现都有具体位置、可复现依据与严重度理由',
    fu_he: '判定与实际命令的退出码一致，失败都有解释，覆盖缺口已说明',
    miao_bi: '候选贴合使用场景与约束，推荐理由具体'
};
/**
 * 专家交付的复评题目：三道通用题 + 一道角色专项题
 * @param {DelegableRoleId} role - 角色
 * @param {SuanHengMode} [mode] - 算衡模式
 * @returns {Record<string, unknown>} Jev 题目
 */
export const getReviewQuestions = (role, mode) => {
    const key = role === 'suan_heng' && mode !== undefined ? `suan_heng:${mode}` : role;
    return {
        ...COMMON_QUESTIONS,
        role_check: { type: 'noul', instructions: ROLE_CHECKS[key] ?? ROLE_CHECKS[role] }
    };
};
const MAX_STRUCTURED = 3000;
const MAX_EVIDENCE = 20;
const getEvidenceView = (evidence) => evidence.slice(0, MAX_EVIDENCE).map((item) => ({
    kind: item.kind,
    ref: getRedactedText(item.ref, 200),
    ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
    ...(item.severity === undefined ? {} : { severity: item.severity }),
    ...(item.detail === undefined ? {} : { detail: getRedactedText(item.detail, 200) })
}));
/**
 * 专家交付的复评状态：任务目标与验收标准、委派要求、交付摘要、结构化结果与证据（全部脱敏截断）
 * @param {TaskRecord} task - 任务
 * @param {DelegationRecord} record - 委派记录
 * @param {string} [request] - 天枢给专家的任务说明
 * @returns {object} state
 */
export const getReviewState = (task, record, request) => ({
    ...getPhaseReviewState(task),
    role: record.roleName,
    ...(record.mode === undefined ? {} : { mode: record.mode === 'research' ? '研算' : '验算' }),
    task_goal: getRedactedText(task.card.goal),
    acceptance: task.card.acceptance.slice(0, 8).map((item) => getRedactedText(item, 200)),
    ...(request === undefined ? {} : { request: getRedactedText(request, 1200) }),
    result_summary: getRedactedText(record.summary, 1200),
    unresolved: record.unresolved.slice(0, 10).map((item) => getRedactedText(item, 200)),
    structured: getRedactedText(JSON.stringify(record.structured ?? {}), MAX_STRUCTURED),
    evidence: getEvidenceView(record.evidence),
    changed_files: (record.changedFiles ?? []).slice(0, 30)
});
/** 天枢验收时的复评题目：验收结论是否与专家证据、门禁结果一致 */
export const ACCEPTANCE_QUESTIONS = {
    supported: {
        type: 'noul',
        instructions: '天枢的验收结论与各专家交付的证据、门禁结果一致',
        criteria: { true: '验收结论有专家交付或门禁结果支撑', false: '验收结论与证据矛盾，或缺少证据' }
    },
    complete: {
        type: 'noul',
        instructions: '验收覆盖了当前任务的每一条验收标准，未解决的问题如实列出。completion_scope=phase 时只验收本阶段，延期事项不是已完成，不得据此宣称整个长期目标完成。'
    },
    reliability: { type: 'score', instructions: '这次验收结论整体可以信赖的程度', criteria: [...RELIABILITY_LEVELS] }
};
/**
 * 天枢验收的复评状态
 * @param {TaskRecord} task - 任务
 * @param {DelegationRecord[]} delegations - 本任务委派
 * @param {{ summary: string; unresolved: string[]; gates: Array<{ gate: string; satisfied: boolean }> }} acceptance - 验收说明与门禁
 * @returns {object} state
 */
export const getAcceptanceState = (task, delegations, acceptance) => ({
    ...getPhaseReviewState(task),
    task_goal: getRedactedText(task.card.goal),
    acceptance_criteria: task.card.acceptance.slice(0, 8).map((item) => getRedactedText(item, 200)),
    gates: acceptance.gates.map((gate) => ({ gate: gate.gate, satisfied: gate.satisfied })),
    // 复评必须看到最后一次验证与审查；只取最早 20 条会漏掉后期返工结论。
    delegations: delegations.slice(-20).map((d) => ({
        role: d.roleName,
        status: d.status,
        summary: getRedactedText(d.summary, 300),
        ...(d.assessment?.verdict === undefined ? {} : { review: d.assessment.verdict })
    })),
    conclusion: getRedactedText(acceptance.summary, 1200),
    unresolved: acceptance.unresolved.slice(0, 10).map((item) => getRedactedText(item, 200))
});
const asRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
/**
 * 解析复评答案并给出判定
 * @param {Record<string, unknown>} answers - Jev 原始答案
 * @param {ReviewThresholdsInfo} thresholds - 阈值
 * @param {string} [model] - Jev 模型版本
 * @returns {AssessmentInfo} 复评结果；答案缺少可信度评分时为 unavailable
 */
export const ParseAssessment = (answers, thresholds, model) => {
    const reliability = asRecord(answers.reliability);
    if (!isJevScore(reliability.score, RELIABILITY_LEVELS.length) || (reliability.confidence !== undefined && !isJevProbability(reliability.confidence))
        || !isJevProbability(asRecord(answers.supported).noul) || !isJevProbability(asRecord(answers.complete).noul))
        return { status: 'unavailable', reason: 'malformed-response' };
    const levels = RELIABILITY_LEVELS.length - 1;
    const normalized = reliability.score / levels;
    const checks = {};
    for (const [id, value] of Object.entries(answers)) {
        const noul = asRecord(value).noul;
        if (noul !== undefined) {
            if (!isJevProbability(noul))
                return { status: 'unavailable', reason: 'malformed-response' };
            checks[id] = noul;
        }
    }
    const supported = asRecord(answers.supported).noul;
    const verdict = normalized < thresholds.doubtfulBelow || supported < SUPPORTED_DOUBTFUL
        ? 'doubtful'
        : normalized >= thresholds.trustedAbove && supported >= SUPPORTED_TRUSTED ? 'trusted' : 'review';
    return {
        status: 'ok',
        verdict,
        reliability: normalized,
        ...(isJevProbability(reliability.confidence) ? { confidence: reliability.confidence } : {}),
        checks,
        ...(model === undefined ? {} : { model })
    };
};
/** 复评结论的中文标签 */
export const VERDICT_LABELS = {
    trusted: '可信',
    review: '需核实',
    doubtful: '存疑'
};
const CHECK_LABELS = {
    supported: '证据支撑',
    complete: '完整性',
    role_check: '角色专项'
};
/**
 * 复评结果的一行说明
 * @param {AssessmentInfo | undefined} assessment - 复评
 * @returns {string | undefined} 文本；没有复评时为 undefined
 */
export const getAssessmentText = (assessment) => {
    if (assessment === undefined)
        return undefined;
    if (assessment.status !== 'ok' || assessment.verdict === undefined)
        return `衡鉴复评：无有效结论（${assessment.reason ?? '未知原因'}）`;
    const checks = Object.entries(assessment.checks ?? {}).map(([id, value]) => `${CHECK_LABELS[id] ?? id} ${value.toFixed(2)}`);
    return `衡鉴复评：${VERDICT_LABELS[assessment.verdict]}（可信度 ${(assessment.reliability ?? 0).toFixed(2)}${checks.length > 0 ? `；${checks.join('；')}` : ''}）`;
};
//# sourceMappingURL=review.js.map