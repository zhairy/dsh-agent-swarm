import { ValidateJsonValue } from './util/json-schema.js';
/** 复核命令类别 */
export const COMMAND_KINDS = ['unit', 'integration', 'typecheck', 'lint', 'build', 'benchmark', 'differential', 'property', 'e2e', 'other'];
/** 御史发现的严重度 */
export const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const str = (description) => ({ type: 'string', ...(description === undefined ? {} : { description }) });
const num = () => ({ type: 'number' });
const oneOf = (values, description) => ({ type: 'string', enum: values, ...(description === undefined ? {} : { description }) });
const strList = (description) => ({ type: 'array', items: { type: 'string' }, ...(description === undefined ? {} : { description }) });
const listOf = (items) => ({ type: 'array', items });
const obj = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
/** 所有角色共享 summary 与 unresolved 字段 */
const withCommon = (properties, required) => obj({ summary: str('结论摘要（按本轮输出语言书写）'), unresolved: strList('未解决或未核实的事项'), ...properties }, ['summary', 'unresolved', ...required]);
const SCHEMAS = {
    mou_ding: withCommon({
        constraints: strList('约束表'),
        options: listOf(obj({ name: str(), summary: str(), pros: strList(), cons: strList() }, ['name', 'summary'])),
        decisions: listOf(obj({ point: str(), recommendation: str(), reason: str() }, ['point', 'recommendation'])),
        dependencies: strList('任务依赖')
    }, ['constraints', 'options', 'decisions']),
    shu_ji: withCommon({
        boundaries: strList(),
        interfaces: listOf(obj({ name: str(), contract: str() }, ['name', 'contract'])),
        failureScenarios: listOf(obj({ scenario: str(), impact: str(), mitigation: str() }, ['scenario', 'mitigation'])),
        migration: str(),
        rollback: str()
    }, ['boundaries', 'interfaces', 'failureScenarios', 'rollback']),
    suan_heng: withCommon({
        mode: oneOf(['research', 'verify']),
        premises: strList(),
        definitions: strList(),
        invariants: strList(),
        claims: listOf(obj({ statement: str(), status: oneOf(['proved', 'refuted', 'unverified']), proofOrCounterexample: str(),
            evidenceType: oneOf(['proof', 'counterexample', 'numerical_checked'], 'proved 结论标 proof（演绎证明）；有限或数值检查标 numerical_checked 且不得标 proved；反驳标 counterexample。验算门禁只认 proof')
        }, ['statement', 'status'])),
        complexity: str(),
        numericError: str(),
        reproducible: listOf(obj({ description: str(), program: str() }, ['description', 'program']))
    }, ['mode', 'premises', 'invariants', 'claims']),
    tan_wei: withCommon({
        findings: listOf(obj({ path: str(), symbol: str(), callChain: strList(), evidence: str() }, ['path', 'evidence']))
    }, ['findings']),
    bo_wen: withCommon({
        sources: listOf(obj({ url: str(), title: str(), date: str(), version: str(), points: strList() }, ['url', 'points']))
    }, ['sources']),
    guan_xiang: withCommon({
        observations: listOf(obj({ region: str(), element: str(), evidence: str() }, ['region', 'element', 'evidence'])),
        inferences: strList(),
        uncertainties: strList()
    }, ['observations', 'uncertainties']),
    zhu_jian: withCommon({ changedFiles: strList(), assumptions: strList(), toVerify: strList() }, ['changedFiles', 'toVerify']),
    xing_zhou: withCommon({
        steps: listOf(obj({ command: str(), cwd: str(), exitCode: num(), artifacts: strList(), notRunReason: str() }, ['command']))
    }, ['steps']),
    ji_feng: withCommon({
        changedFiles: strList(),
        localChecks: listOf(obj({ command: str(), exitCode: num() }, ['command', 'exitCode']))
    }, ['changedFiles', 'localChecks']),
    yu_shi: withCommon({
        findings: listOf(obj({ severity: oneOf(SEVERITIES), location: str(), issue: str(), repro: str(), suggestion: str() }, ['severity', 'location', 'issue', 'suggestion']))
    }, ['findings']),
    fu_he: withCommon({
        plan: strList('验证计划'),
        commands: listOf(obj({ command: str(), exitCode: num(), kind: oneOf(COMMAND_KINDS), summary: str() }, ['command', 'exitCode', 'kind', 'summary'])),
        coverage: str('覆盖范围与缺口'),
        failures: listOf(obj({ command: str(), explanation: str() }, ['command', 'explanation'])),
        verdict: oneOf(['pass', 'fail', 'partial']),
        measurements: listOf(obj({
            metric: oneOf(['p95', 'p99', 'throughput', 'peakMemory', 'numericError']),
            value: num(), unit: oneOf(['ms', 'ops/s', 'bytes', 'absolute']), sampleCount: num(),
            dataScale: str(), inputDigest: str(), environment: str(), commandRef: str(), rawArtifactRef: str()
        }, ['metric', 'value', 'unit', 'sampleCount', 'dataScale', 'inputDigest', 'environment', 'commandRef', 'rawArtifactRef']))
    }, ['plan', 'commands', 'coverage', 'failures', 'verdict']),
    miao_bi: withCommon({
        candidates: listOf(obj({ text: str(), scenario: str() }, ['text', 'scenario'])),
        recommendation: str(),
        rationale: str()
    }, ['candidates', 'recommendation', 'rationale'])
};
/**
 * 角色的 outputSchema（传给 spawn，并用于宿主侧校验）
 * @param {DelegableRoleId} role - 角色 ID
 * @returns {JsonSchemaObject} schema
 */
export const getOutputSchema = (role) => SCHEMAS[role];
const getList = (value, key) => {
    const field = value?.[key];
    return Array.isArray(field) ? field : [];
};
/**
 * 在 schema 校验之上做角色级语义检查
 * @param {DelegableRoleId} role - 角色 ID
 * @param {unknown} value - 子智能体提交的结构化结果
 * @param {SuanHengMode} [mode] - 算衡本次委派的模式
 * @returns {string[]} 违规描述
 */
export const ValidateStructuredOutput = (role, value, mode) => {
    const schemaErrors = ValidateJsonValue(SCHEMAS[role], value);
    if (schemaErrors.length > 0)
        return schemaErrors;
    const record = value;
    const errors = [];
    if (role === 'fu_he' && record.verdict === 'pass') {
        const commands = getList(value, 'commands');
        if (commands.length === 0)
            errors.push('复核判定通过时必须至少记录 1 条实际运行的命令');
        if (commands.some((row) => row.exitCode !== 0))
            errors.push('复核判定通过，但存在非零退出码的命令');
    }
    if (role === 'miao_bi') {
        const count = getList(value, 'candidates').length;
        if (count < 2 || count > 3)
            errors.push('妙笔必须给出 2–3 个候选');
    }
    if (role === 'suan_heng' && mode !== undefined && record.mode !== mode)
        errors.push(`算衡模式应为 ${mode}`);
    if (role === 'suan_heng' && record.mode === 'verify' && getList(value, 'claims').length === 0)
        errors.push('验算必须至少检验 1 条结论');
    if (role === 'suan_heng')
        for (const claim of getList(value, 'claims')) {
            if (['proved', 'refuted'].includes(claim.status) && !claim.proofOrCounterexample?.trim())
                errors.push('证实或反驳结论必须提供非空推导或反例');
            if (claim.status === 'proved' && claim.evidenceType === 'numerical_checked')
                errors.push('有限计算证据不能自动升级为 proved');
        }
    if (role === 'bo_wen' && getList(value, 'sources').some((row) => !/^https?:\/\//.test(row.url))) {
        errors.push('博闻的来源必须是 http(s) URL');
    }
    return errors;
};
/**
 * 从结构化结果中抽取证据条目
 * @param {DelegableRoleId} role - 角色 ID
 * @param {unknown} value - 结构化结果
 * @returns {EvidenceItem[]} 证据
 */
export const getEvidenceFromOutput = (role, value) => {
    switch (role) {
        case 'fu_he':
            return getList(value, 'commands').map((row) => ({ kind: 'command', ref: row.command, exitCode: row.exitCode, commandKind: row.kind, detail: row.summary }));
        case 'xing_zhou':
            return getList(value, 'steps').map((row) => ({
                kind: 'step',
                ref: row.command,
                ...(typeof row.exitCode === 'number' ? { exitCode: row.exitCode } : {}),
                detail: row.notRunReason ?? (row.artifacts ?? []).join(', ')
            }));
        case 'ji_feng':
            return getList(value, 'localChecks').map((row) => ({ kind: 'command', ref: row.command, exitCode: row.exitCode }));
        case 'yu_shi':
            return getList(value, 'findings').map((row) => ({ kind: 'finding', ref: row.location, severity: row.severity, detail: row.issue }));
        case 'bo_wen':
            return getList(value, 'sources').map((row) => ({ kind: 'source', ref: row.url, detail: [row.date, row.version].filter(Boolean).join(' ') }));
        case 'guan_xiang':
            return getList(value, 'observations').map((row) => ({ kind: 'observation', ref: row.region, detail: `${row.element}：${row.evidence}` }));
        case 'suan_heng':
            return getList(value, 'claims').map((row) => ({ kind: 'claim', ref: row.statement, detail: row.status }));
        case 'tan_wei':
            return getList(value, 'findings').map((row) => ({ kind: 'finding', ref: row.path, detail: row.evidence }));
        case 'zhu_jian':
            return getList(value, 'changedFiles').map((path) => ({ kind: 'file-change', ref: path }));
        default:
            return [];
    }
};
//# sourceMappingURL=contracts.js.map