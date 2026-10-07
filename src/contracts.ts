import type { DelegableRoleId, SuanHengMode } from './role-registry.js'
import { ValidateJsonValue, type JsonSchemaObject } from './util/json-schema.js'

/** 复核命令类别 */
export const COMMAND_KINDS = ['unit', 'integration', 'typecheck', 'lint', 'build', 'benchmark', 'differential', 'property', 'e2e', 'other'] as const
/** 御史发现的严重度 */
export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const

const str = (description?: string): JsonSchemaObject => ({ type: 'string', ...(description === undefined ? {} : { description }) })
const num = (): JsonSchemaObject => ({ type: 'number' })
const oneOf = (values: readonly string[]): JsonSchemaObject => ({ type: 'string', enum: values })
const strList = (description?: string): JsonSchemaObject => ({ type: 'array', items: { type: 'string' }, ...(description === undefined ? {} : { description }) })
const listOf = (items: JsonSchemaObject): JsonSchemaObject => ({ type: 'array', items })
const obj = (properties: Record<string, JsonSchemaObject>, required: string[]): JsonSchemaObject =>
  ({ type: 'object', properties, required, additionalProperties: false })

/** 所有角色共享 summary 与 unresolved 字段 */
const withCommon = (properties: Record<string, JsonSchemaObject>, required: string[]): JsonSchemaObject =>
  obj({ summary: str('中文结论摘要'), unresolved: strList('未解决或未核实的事项'), ...properties }, ['summary', 'unresolved', ...required])

const SCHEMAS: Readonly<Record<DelegableRoleId, JsonSchemaObject>> = {
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
      evidenceType: oneOf(['proof', 'counterexample', 'numerical_checked'])
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
}

/**
 * 角色的 outputSchema（传给 spawn，并用于宿主侧校验）
 * @param {DelegableRoleId} role - 角色 ID
 * @returns {JsonSchemaObject} schema
 */
export const getOutputSchema = (role: DelegableRoleId): JsonSchemaObject => SCHEMAS[role]

interface CommandRow { command: string; exitCode: number; kind: string; summary: string }
interface StepRow { command: string; exitCode?: number; artifacts?: string[]; notRunReason?: string }
interface FindingRow { severity: string; location: string; issue: string }
interface SourceRow { url: string; date?: string; version?: string }
interface ObservationRow { region: string; element: string; evidence: string }
interface ClaimRow { statement: string; status: string; proofOrCounterexample?: string; evidenceType?: string }
interface LocationRow { path: string; evidence: string }

const getList = <T>(value: unknown, key: string): T[] => {
  const field = (value as Record<string, unknown> | null | undefined)?.[key]
  return Array.isArray(field) ? (field as T[]) : []
}

/**
 * 在 schema 校验之上做角色级语义检查
 * @param {DelegableRoleId} role - 角色 ID
 * @param {unknown} value - 子智能体提交的结构化结果
 * @param {SuanHengMode} [mode] - 算衡本次委派的模式
 * @returns {string[]} 违规描述
 */
export const ValidateStructuredOutput = (role: DelegableRoleId, value: unknown, mode?: SuanHengMode): string[] => {
  const schemaErrors = ValidateJsonValue(SCHEMAS[role], value)
  if (schemaErrors.length > 0) return schemaErrors
  const record = value as Record<string, unknown>
  const errors: string[] = []
  if (role === 'fu_he' && record.verdict === 'pass') {
    const commands = getList<CommandRow>(value, 'commands')
    if (commands.length === 0) errors.push('复核判定通过时必须至少记录 1 条实际运行的命令')
    if (commands.some((row) => row.exitCode !== 0)) errors.push('复核判定通过，但存在非零退出码的命令')
  }
  if (role === 'miao_bi') {
    const count = getList(value, 'candidates').length
    if (count < 2 || count > 3) errors.push('妙笔必须给出 2–3 个候选')
  }
  if (role === 'suan_heng' && mode !== undefined && record.mode !== mode) errors.push(`算衡模式应为 ${mode}`)
  if (role === 'suan_heng' && record.mode === 'verify' && getList(value, 'claims').length === 0) errors.push('验算必须至少检验 1 条结论')
  if (role === 'suan_heng') for (const claim of getList<ClaimRow>(value, 'claims')) {
    if (['proved', 'refuted'].includes(claim.status) && !claim.proofOrCounterexample?.trim()) errors.push('证实或反驳结论必须提供非空推导或反例')
    if (claim.status === 'proved' && claim.evidenceType === 'numerical_checked') errors.push('有限计算证据不能自动升级为 proved')
  }
  if (role === 'bo_wen' && getList<SourceRow>(value, 'sources').some((row) => !/^https?:\/\//.test(row.url))) {
    errors.push('博闻的来源必须是 http(s) URL')
  }
  return errors
}

/** 可核对的证据条目 */
export interface EvidenceItem {
  kind: 'command' | 'step' | 'finding' | 'source' | 'observation' | 'claim' | 'file-change'
  ref: string
  detail?: string
  exitCode?: number
  commandKind?: string
  severity?: string
}

/**
 * 从结构化结果中抽取证据条目
 * @param {DelegableRoleId} role - 角色 ID
 * @param {unknown} value - 结构化结果
 * @returns {EvidenceItem[]} 证据
 */
export const getEvidenceFromOutput = (role: DelegableRoleId, value: unknown): EvidenceItem[] => {
  switch (role) {
    case 'fu_he':
      return getList<CommandRow>(value, 'commands').map((row) => ({ kind: 'command', ref: row.command, exitCode: row.exitCode, commandKind: row.kind, detail: row.summary }))
    case 'xing_zhou':
      return getList<StepRow>(value, 'steps').map((row) => ({
        kind: 'step',
        ref: row.command,
        ...(typeof row.exitCode === 'number' ? { exitCode: row.exitCode } : {}),
        detail: row.notRunReason ?? (row.artifacts ?? []).join(', ')
      }))
    case 'ji_feng':
      return getList<CommandRow>(value, 'localChecks').map((row) => ({ kind: 'command', ref: row.command, exitCode: row.exitCode }))
    case 'yu_shi':
      return getList<FindingRow>(value, 'findings').map((row) => ({ kind: 'finding', ref: row.location, severity: row.severity, detail: row.issue }))
    case 'bo_wen':
      return getList<SourceRow>(value, 'sources').map((row) => ({ kind: 'source', ref: row.url, detail: [row.date, row.version].filter(Boolean).join(' ') }))
    case 'guan_xiang':
      return getList<ObservationRow>(value, 'observations').map((row) => ({ kind: 'observation', ref: row.region, detail: `${row.element}：${row.evidence}` }))
    case 'suan_heng':
      return getList<ClaimRow>(value, 'claims').map((row) => ({ kind: 'claim', ref: row.statement, detail: row.status }))
    case 'tan_wei':
      return getList<LocationRow>(value, 'findings').map((row) => ({ kind: 'finding', ref: row.path, detail: row.evidence }))
    case 'zhu_jian':
      return getList<string>(value, 'changedFiles').map((path) => ({ kind: 'file-change', ref: path }))
    default:
      return []
  }
}
