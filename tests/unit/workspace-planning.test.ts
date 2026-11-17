import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { DEFAULT_JEV_CONFIG, getJevQuestions, getJevState, intJevClient } from '../../src/jev.js'
import { getWorkspacePlan, applyWorkspaceJudgment, ValidateWorkspacePlan } from '../../src/workspace-policy.js'
import { getCanonicalJson } from '../../src/workflow.js'
import { ValidateTaskCard } from '../../src/policy.js'

const card = ValidateTaskCard({ title: 'project work', goal: 'change scoped source', acceptance: ['verified'], scope: ['src'], flags: { changesCode: true } }).card!
const plan = (text: string) => getWorkspacePlan({ repositoryRoot: '/repo', branch: 'main', head: 'a'.repeat(40), sources: [{ path: 'agent.md', text, digest: createHash('sha256').update(text).digest('hex') }] })
describe('Host project facts reach the actual Jev triage payload', () => {
  it('sends rule evidence and receives a typed workspace judgment in the same triage request', async () => {
    let payload: Record<string, unknown> | undefined
    const client = intJevClient({ ...DEFAULT_JEV_CONFIG, maxRetries: 0 }, {
      getApiKey: async () => 'fixture-only',
      fetch: (async (_url, init) => {
        payload = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({ model: 'fixture', answers: { workspace_mode: { type: 'choice', choice: 'primary', confidence: 0.99 } } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch
    })
    const workspace = plan('唯一主工作树，禁止 git worktree add。')
    const outcome = await client.triage(card, new AbortController().signal, workspace)
    expect(outcome.ok).toBe(true)
    expect(payload?.state).toMatchObject({ workspace: { mode: 'primary', evidence: [expect.stringContaining('唯一主工作树')] } })
    expect(payload?.questions).toHaveProperty('workspace_mode')
    if (outcome.ok) expect(applyWorkspaceJudgment(workspace, outcome.answers.workspaceMode).mode).toBe('primary')
  })
  it('does not add a workspace question to legacy calls without workspace evidence', () => {
    expect(getJevQuestions()).not.toHaveProperty('workspace_mode')
    expect(getJevState(card)).not.toHaveProperty('workspace')
  })
  it('never lets a model override hard project constraints or act at low confidence', () => {
    const primary = plan('单一主工作树，禁止第二 checkout。')
    expect(applyWorkspaceJudgment(primary, { choice: 'linked', confidence: 1 }).mode).toBe('blocked')
    expect(applyWorkspaceJudgment(primary, { choice: 'primary', confidence: 0.6 }).mode).toBe('blocked')
    const conflict = plan('dsh.workspace: primary\ndsh.workspace: linked')
    expect(applyWorkspaceJudgment(conflict, { choice: 'primary', confidence: 1 }).mode).toBe('blocked')
  })
  it('uses Jev to interpret non-canonical requirements and preserves canonical persistence', () => {
    const ambiguous = plan('工作树策略需要结合当前项目约束判断。')
    expect(ambiguous.mode).toBe('blocked')
    const selected = applyWorkspaceJudgment(ambiguous, { choice: 'primary', confidence: 0.98 })
    expect(selected.mode).toBe('primary')
    expect(ValidateWorkspacePlan(JSON.parse(getCanonicalJson(selected)))).toBe(true)
  })
})

it('linked 允许新分支名，但必须派生自当前合同冻结的 HEAD；primary 提交后仍保留原基线身份', async () => {
  const { assertWorkspacePlanBinding } = await import('../../src/workspace-policy.js')
  const linked = getWorkspacePlan({ repositoryRoot: '/repo', branch: 'main', head: 'a'.repeat(40), sources: [] })
  const record = { kind: 'linked' as const, repositoryRoot: '/repo', branch: 'feature-task', baseCommit: linked.head }
  expect(() => assertWorkspacePlanBinding(linked, record)).not.toThrow()
  expect(() => assertWorkspacePlanBinding(linked, { ...record, baseCommit: 'b'.repeat(40) })).toThrow('基线')
  const primary = plan('唯一主工作树，禁止 git worktree add、第二 checkout')
  expect(() => assertWorkspacePlanBinding(primary, { ...record, kind: 'primary', branch: primary.branch, baseCommit: 'c'.repeat(40) })).not.toThrow()
})
