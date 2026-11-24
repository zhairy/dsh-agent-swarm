import { randomUUID } from 'node:crypto';
import { queryReviewedExperiences } from './memory.js';
import { getValueDigest } from './workflow.js';
import { ValidateToolCandidate } from './tool-candidate.js';
import { EVOLUTION_MAX_REQUEST_HISTORY, getInitialEvolutionGovernance, transitionEvolutionGovernance, ValidateEvolutionEvaluationResult, ValidateEvolutionGovernance, recoverEvolutionGovernance } from './evolution-governance.js';
export class ExperienceError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'ExperienceError';
    }
}
export const createExperienceRepository = (store, options = {}) => {
    const now = options.now ?? Date.now;
    const digest = /^[a-f0-9]{64}$/i;
    const readEntries = () => store.readFields?.(['experiences']).experiences ?? store.read().experiences;
    const identity = (entry) => getValueDigest({
        problemClass: entry.problemClass, appliesWhen: entry.appliesWhen, doesNotApplyWhen: entry.doesNotApplyWhen,
        conclusion: entry.conclusion, source: entry.source, verification: entry.verification,
        counterexamples: entry.counterexamples, operatorVersions: entry.operatorVersions, ...(entry.toolCandidate === undefined ? {} : { toolCandidate: entry.toolCandidate })
    });
    const contentDigest = (entry) => getValueDigest({
        problemClass: entry.problemClass, appliesWhen: entry.appliesWhen, doesNotApplyWhen: entry.doesNotApplyWhen,
        conclusion: entry.conclusion, source: entry.source, verification: entry.verification,
        counterexamples: entry.counterexamples, operatorVersions: entry.operatorVersions,
        ...(entry.toolCandidate === undefined ? {} : { toolCandidate: entry.toolCandidate })
    });
    const validTransitionRequest = (input) => Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 1 && typeof input.requestId === 'string'
        && input.requestId.trim().length > 0 && input.requestId.length <= 512;
    const validReview = (entry, review) => review.evidenceComplete && review.unresolvedSevere === 0 && review.applicabilityConfirmed
        && typeof review.author === 'string' && review.author.length > 0
        && typeof review.reviewer === 'string' && review.reviewer.length > 0 && review.reviewer !== review.author
        && (entry.source.authorId === undefined || entry.source.authorId === review.author)
        && digest.test(review.reviewArtifactDigest) && review.sourceArtifactDigest === entry.source.artifactDigest;
    const transition = async (id, event, input, review) => {
        if (!validTransitionRequest(input))
            throw new ExperienceError('EXPERIENCE_INVALID', 'Governance transition needs an expected revision and request id');
        let result;
        await store.update(`experience/governance/${event.type}`, { build: async (state) => {
                const entry = state.experiences[id];
                if (entry === undefined || entry.toolCandidate !== undefined)
                    throw new ExperienceError('EXPERIENCE_INVALID', 'Unknown or quarantined experience');
                const governance = entry.governance ?? (event.type === 'begin-evaluation' ? getInitialEvolutionGovernance(now()) : undefined);
                if (governance === undefined)
                    throw new ExperienceError('EXPERIENCE_CONFLICT', 'Evaluation must be started before governance actions');
                if (!ValidateEvolutionGovernance(governance))
                    throw new ExperienceError('EXPERIENCE_INVALID', 'Persisted governance state is invalid');
                if (event.type === 'begin-evaluation' && (entry.status !== 'candidate' || entry.expiresAt <= now() || event.candidateDigest !== contentDigest(entry))) {
                    throw new ExperienceError('EXPERIENCE_REVIEW_REQUIRED', 'Evaluation candidate digest does not match the frozen experience');
                }
                if (event.type === 'record-evaluation') {
                    if (!ValidateEvolutionEvaluationResult(event.result) || event.result.candidateDigest !== contentDigest(entry) || entry.verification.length === 0
                        || review === undefined || !validReview(entry, review)
                        || options.verifyReview === undefined || !await options.verifyReview(entry, review)
                        || options.verifyEvaluation === undefined || !await options.verifyEvaluation(entry, event.result)) {
                        throw new ExperienceError('EXPERIENCE_REVIEW_REQUIRED', 'Evaluation needs independently verified review and trusted frozen-trace evidence');
                    }
                }
                if (event.type === 'register-release' && (options.verifyRelease === undefined || !await options.verifyRelease(entry, event.release))) {
                    throw new ExperienceError('EXPERIENCE_REVIEW_REQUIRED', 'Release registration needs trusted manifest and artifact verification');
                }
                if (event.type === 'authorize-canary' && (options.verifyCanary === undefined
                    || !await options.verifyCanary(entry, event.scope, event.authorizationRef, event.stopPolicyDigest))) {
                    throw new ExperienceError('EXPERIENCE_REVIEW_REQUIRED', 'Canary authorization must come from the live host authorization record');
                }
                if ((event.type === 'request-canary' || event.type === 'authorize-canary') && event.scope.taskId !== entry.source.taskId) {
                    throw new ExperienceError('EXPERIENCE_INVALID', 'Canary scope must stay on the candidate source task');
                }
                let next;
                try {
                    next = transitionEvolutionGovernance(governance, event, { expectedRevision: input.expectedRevision, requestId: input.requestId, at: now() });
                }
                catch (error) {
                    throw new ExperienceError('EXPERIENCE_CONFLICT', error instanceof Error ? error.message : 'Governance transition failed');
                }
                if (next.requestIndex !== undefined && Object.keys(next.requestIndex).length > EVOLUTION_MAX_REQUEST_HISTORY) {
                    throw new ExperienceError('EXPERIENCE_INVALID', 'Governance request history capacity reached');
                }
                const status = next.phase === 'revoked' ? 'deprecated'
                    : ['validated', 'released', 'shadow', 'canary', 'active', 'stopped'].includes(next.phase) ? 'validated' : 'candidate';
                result = { ...entry, status, governance: next,
                    ...(event.type === 'record-evaluation' && event.result.outcome === 'passed' && review !== undefined
                        ? { reviewer: review.reviewer, reviewArtifactDigest: review.reviewArtifactDigest }
                        : {}),
                    ...(event.type === 'revoke' ? { deprecationReason: event.reason } : {}) };
                return { set: { experiences: { [id]: result } } };
            } });
        return structuredClone(result);
    };
    return {
        getExperienceDigest: (id) => {
            const entry = readEntries()[id];
            return entry === undefined ? undefined : contentDigest(entry);
        },
        get: (id) => {
            const entry = readEntries()[id];
            return entry === undefined ? undefined : structuredClone(entry);
        },
        addCandidate: async (input) => {
            if (typeof input.conclusion !== 'string' || input.conclusion.length < 1 || input.conclusion.length > 4000 || typeof input.problemClass !== 'string' || input.problemClass.length < 1 || input.problemClass.length > 128 || !digest.test(input.source?.artifactDigest ?? '') || !Number.isSafeInteger(input.source.cardRevision) || input.source.cardRevision < 1 || !Number.isSafeInteger(input.source.workflowRevision) || input.source.workflowRevision < 1 || !Number.isFinite(input.expiresAt) || input.expiresAt <= now())
                throw new ExperienceError('EXPERIENCE_INVALID', 'Candidate needs a bounded conclusion, source revisions/digest and future expiry');
            for (const key of ['appliesWhen', 'doesNotApplyWhen', 'verification', 'counterexamples', 'operatorVersions'])
                if (!Array.isArray(input[key]) || input[key].length > 32 || input[key].some((s) => typeof s !== 'string' || s.length > 2000))
                    throw new ExperienceError('EXPERIENCE_INVALID', 'Invalid bounded experience fields');
            if (input.toolCandidate !== undefined && !ValidateToolCandidate(input.toolCandidate))
                throw new ExperienceError('EXPERIENCE_INVALID', 'Tool candidates require bounded references and disabled execution');
            const createdAt = now(), inputIdentity = identity(input);
            let entry = { ...structuredClone(input), id: randomUUID(), status: 'candidate', createdAt };
            // 补丁在 store 的互斥区内按冻结基线求值：去重与容量检查对最新的已提交候选成立。
            await store.update('experience/candidate', { build: (state) => {
                    // Only exact, still-live candidates reuse storage; reviewed/deprecated/expired records remain distinct audit facts.
                    const existing = Object.values(state.experiences).find((candidate) => candidate.status === 'candidate'
                        && candidate.expiresAt > createdAt && identity(candidate) === inputIdentity);
                    if (existing !== undefined) {
                        entry = structuredClone(existing);
                        return {};
                    }
                    if (Object.keys(state.experiences).length >= (options.maxEntries ?? 1024))
                        throw new ExperienceError('EXPERIENCE_INVALID', 'Experience capacity reached; archive first');
                    return { set: { experiences: { [entry.id]: entry } } };
                } });
            return entry;
        },
        promote: async (id, review) => {
            let result;
            await store.update('experience/promote', { build: async (state) => {
                    const entry = state.experiences[id];
                    // 经验复评不等于代码沙箱评测；不能沿用文本经验晋升路径装载工具。
                    if (entry?.toolCandidate !== undefined)
                        throw new ExperienceError('EXPERIENCE_REVIEW_REQUIRED', 'Tool evaluation unavailable; candidate remains quarantined and cannot be activated');
                    if (entry === undefined || entry.governance !== undefined || entry.status !== 'candidate' || entry.expiresAt <= now() || entry.verification.length === 0 || !validReview(entry, review)
                        || options.verifyReview === undefined || !await options.verifyReview(entry, review))
                        throw new ExperienceError('EXPERIENCE_REVIEW_REQUIRED', 'Promotion needs independently verified current source evidence, an independent reviewer and no unresolved severe findings');
                    result = { ...entry, status: 'validated', reviewer: review.reviewer, reviewArtifactDigest: review.reviewArtifactDigest };
                    return { set: { experiences: { [id]: result } } };
                } });
            return result;
        },
        deprecate: async (id, reason) => {
            if (typeof reason !== 'string' || reason.trim() === '' || reason.length > 2000)
                throw new ExperienceError('EXPERIENCE_INVALID', 'Deprecation reason is required');
            await store.update('experience/deprecate', { build: (state) => {
                    const entry = state.experiences[id];
                    if (entry === undefined || entry.governance !== undefined)
                        throw new ExperienceError('EXPERIENCE_INVALID', 'Unknown experience or governance-managed entry; use revoke for the latter');
                    return { set: { experiences: { [id]: { ...entry, status: 'deprecated', deprecationReason: reason } } } };
                } });
        },
        beginEvaluation: (id, input) => transition(id, { type: 'begin-evaluation', traceDigest: input.traceDigest, baselineDigest: input.baselineDigest, candidateDigest: input.candidateDigest }, input),
        recordEvaluation: (id, result, review, input) => transition(id, { type: 'record-evaluation', result }, input, review),
        registerRelease: (id, release, input) => transition(id, { type: 'register-release', release }, input),
        startShadow: (id, input) => transition(id, { type: 'start-shadow', at: now() }, input),
        recordShadow: (id, recommendation, input) => transition(id, { type: 'record-shadow', at: now(), recommendation }, input),
        requestCanary: (id, scope, stopPolicyDigest, input) => transition(id, { type: 'request-canary', scope, stopPolicyDigest, at: now() }, input),
        authorizeCanary: (id, scope, authorizationRef, stopPolicyDigest, input) => transition(id, { type: 'authorize-canary', scope, authorizationRef, stopPolicyDigest, at: now() }, input),
        activateCanary: (id, input) => transition(id, { type: 'activate-canary', at: now() }, input),
        stopCanary: (id, reason, safetyViolation, input) => transition(id, { type: 'stop-canary', at: now(), reason, safetyViolation }, input),
        promoteCanary: (id, reason, input) => transition(id, { type: 'promote', at: now(), ...(reason === undefined ? {} : { reason }) }, input),
        revoke: (id, reason, unresolvedHandles, input) => transition(id, { type: 'revoke', at: now(), reason, unresolvedHandles }, input),
        reconcile: (id, reason, input) => transition(id, { type: 'reconcile', at: now(), reason }, input),
        /** Restart recovery is deliberately separate from an operator transition. */
        recover: async (id) => {
            const current = readEntries()[id];
            if (current?.governance === undefined)
                return current === undefined ? undefined : structuredClone(current);
            const next = recoverEvolutionGovernance(current.governance, now());
            if (getValueDigest(next) === getValueDigest(current.governance))
                return structuredClone(current);
            let result;
            await store.update('experience/governance/recover', { build: state => {
                    const entry = state.experiences[id];
                    if (entry?.governance === undefined)
                        throw new ExperienceError('EXPERIENCE_INVALID', 'Unknown experience governance');
                    result = { ...entry, governance: next, status: next.phase === 'revoked' ? 'deprecated' : entry.status };
                    return { set: { experiences: { [id]: result } } };
                } });
            return structuredClone(result);
        },
        listForTask: (taskId) => Object.values(readEntries())
            .filter(entry => entry.source.taskId === taskId && entry.governance !== undefined)
            .sort((left, right) => right.governance.revision - left.governance.revision || right.createdAt - left.createdAt)
            .map(entry => structuredClone(entry)),
        query: (query) => queryReviewedExperiences(Object.values(readEntries()).filter(entry => entry.governance === undefined || entry.governance.phase === 'active'), query, now()),
        list: (problemClass, includeCandidates = false) => Object.values(readEntries()).filter((entry) => entry.expiresAt > now() && entry.status !== 'deprecated' && (includeCandidates || entry.status === 'validated') && (problemClass === undefined || entry.problemClass === problemClass))
    };
};
//# sourceMappingURL=experience.js.map