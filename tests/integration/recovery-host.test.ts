import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { getRoutesOverlay, type ScenarioRunInfo } from './helpers.js'
import { REPO_ROOT, DRIVER_DIR, SANDBOX_ROOT, PROFILE, ensureProfile, runDshAsync } from '../../scripts/sandbox.mjs'

interface RecoveryRun extends ScenarioRunInfo {
  recoveryRequests: Array<{ provider?: string; model: string; sessionId: string; at: number }>
  recoveryEvents: Array<{ type: string; data?: unknown }>
  recoveryTerminal?: string
  agentErrors?: Array<{ message?: string; code?: string }>
  planningReviewers?: Array<{ sessionId: string; model: string; tools: string[]; outputSchemaProperties: string[]; snapshotDigest: string; requestText: string; mermaid: string; workflow: unknown; seesAgentResult: boolean; seesJevResult: boolean; readResult?: string; mutationResult?: string; mutationIsError?: boolean }>
  planningStatus?: { tasks: Array<{ planningReview?: unknown }> }
  analysisReadResult?: string
}
const RECOVERY_BASE = {
  jev: { enabled: false }, planningReview: { enabled: false }, workflow: { mode: 'advisory' },
  agents: { maxRetries: 3, retryBackoffMs: 1, networkWaitMs: 0 }
}
const runRecovery = async (scenario: string, routes: Record<string, unknown>, mode: string, rootModel?: string, options: { config?: Record<string, unknown>; env?: Record<string, string> } = {}): Promise<RecoveryRun> => {
  const { home } = ensureProfile()
  mkdirSync(SANDBOX_ROOT, { recursive: true })
  const workspace = mkdtempSync(join(SANDBOX_ROOT, `recovery-ws-${scenario}-`))
  writeFileSync(join(workspace, 'README.md'), '# recovery fixture\n')
  const git = (args: string[]) => execFileSync('git', ['-c', 'user.name=recovery-test', '-c', 'user.email=recovery@test.local', ...args], { cwd: workspace, stdio: 'ignore' })
  git(['init', '-q']); git(['add', '-A']); git(['commit', '-q', '-m', 'fixture'])
  const overlay = `${workspace}.overlay.yml`
  writeFileSync(overlay, YAML.stringify([
    { id: 'swarm-core', config: { ...RECOVERY_BASE, routes, ...options.config } },
    { insert: [{ id: 'swarm-recovery-test-driver', name: join(DRIVER_DIR, 'recovery-scenarios.js') }] }
  ]))
  const out = `${workspace}.out.json`
  const result = await runDshAsync({ args: ['--profile', PROFILE, '--patch', overlay], cwd: workspace, timeout: 35000,
    env: { SWARM_SCENARIO: '', SWARM_RECOVERY_SCENARIO: scenario, SWARM_DRIVER_OUT: out, SWARM_RECOVERY_RETRY_MODE: mode, SWARM_ROOT_MODEL: rootModel ?? 'root', ...options.env }
  })
  if (!existsSync(out)) throw new Error(`恢复场景 ${scenario} 没有输出。\n${result.stdout}\n${result.stderr}`)
  const data = JSON.parse(readFileSync(out, 'utf8'))
  const ledgerFile = join(home, 'share', 'dsh-agent-swarm', 'ledger', `${data.sessionId ?? 'none'}.jsonl`)
  const ledgerEvents = existsSync(ledgerFile) ? readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
  return { ...data, ledgerEvents, workspace, stdout: result.stdout, stderr: result.stderr } as RecoveryRun
}
const retryEvents = (run: RecoveryRun) => run.recoveryEvents.filter((event) => event.type === 'llm/retry' || event.type === 'llm/retry-started')
const failureRequests = (run: RecoveryRun) => run.recoveryRequests.filter((request) => /^fail-(?:pool|quota-[ab])$/.test(request.model))

beforeAll(() => {
  if (!existsSync(join(REPO_ROOT, 'lib', 'index.js'))) throw new Error('请先运行 npm run build')
  ensureProfile()
})

describe('真实 AgentLoop：pool exhausted 9060669ms 与终态恢复', () => {
  for (const mode of ['normal', 'always']) {
    it(`${mode}：根模型池不可用立即选择备用，不生成长退避事件`, async () => {
      const run = await runRecovery('recovery-pool-backup', getRoutesOverlay({ tian_shu: ['fail-pool', 'root'] }), mode, 'fail-pool')
      expect(run.status, run.error ?? run.stderr).toBe('done')
      expect(run.recoveryRequests.map((request) => request.model)).toEqual(['fail-pool', 'root'])
      expect(retryEvents(run)).toEqual([])
      expect(run.recoveryRequests[1]!.at - run.recoveryRequests[0]!.at).toBeLessThan(5000)
      expect(run.ledgerEvents.some((event) => event.type === 'route/fallback' && event.data.scope === 'root')).toBe(true)
    })

    it(`${mode}：所有备用额度耗尽，终止原请求而不继续调用或退避`, async () => {
      const run = await runRecovery('recovery-all-quota', getRoutesOverlay({ tian_shu: ['fail-pool', 'fail-quota-a', 'fail-quota-b'] }), mode, 'fail-pool')
      expect(run.status, run.error ?? run.stderr).not.toBe('timeout')
      expect(failureRequests(run).map((request) => request.model)).toEqual(['fail-pool', 'fail-quota-a', 'fail-quota-b'])
      expect(run.recoveryTerminal).toBe('route_chain_exhausted')
      expect(retryEvents(run)).toEqual([])
      expect(run.results).toEqual([])
    })

    for (const session of ['oneshot', 'continuable']) {
      it(`${mode}/${session}：专家链耗尽不触发外层3次乘算重启`, async () => {
        const run = await runRecovery(`recovery-child-${session}`, getRoutesOverlay({ tan_wei: ['fail-pool', 'fail-quota-a', 'fail-quota-b'] }), mode)
        expect(run.status, run.error ?? run.stderr).toBe('done')
        const failures = failureRequests(run)
        expect(failures.map((request) => request.model)).toEqual(['fail-pool', 'fail-quota-a', 'fail-quota-b'])
        expect(new Set(failures.map((request) => request.sessionId)).size).toBe(1)
        expect(retryEvents(run)).toEqual([])
        expect(run.results[1]?.text).toContain('failed')
        expect(run.ledgerEvents.filter((event) => event.type === 'delegation/retry')).toEqual([])
      })
    }
  }

  it('成功备用写入一次，模型恢复不从头重做工具副作用', async () => {
    const run = await runRecovery('recovery-write-once', getRoutesOverlay({ ji_feng: ['fail-pool', 'writer-ji_feng'] }), 'always')
    expect(run.status, run.error ?? run.stderr).toBe('done')
    expect(failureRequests(run).map((request) => request.model)).toEqual(['fail-pool'])
    const requests = run.recoveryRequests.filter((request) => request.model === 'writer-ji_feng')
    expect(requests).toHaveLength(2) // 第一次真实 write，第二次 structured_output。
    expect(new Set(requests.map((request) => request.sessionId)).size).toBe(1)
    expect(readFileSync(join(run.workspace, 'hello.txt'), 'utf8')).toBe('hello swarm\n')
    expect(run.ledgerEvents.filter((event) => event.type === 'delegation/completed')).toHaveLength(1)
    expect(run.ledgerEvents.filter((event) => event.type === 'delegation/retry')).toEqual([])
    expect(retryEvents(run)).toEqual([])
  })
})

describe('真实 AgentLoop：默认规划三维审核与 enforced 执行', () => {
  it('官方parser、独立spawn custom schema及Jev mock双审通过后，依赖仍生效并完成验收', async () => {
    const requests: Array<{ model: string; state: Record<string, unknown>; questions: Record<string, { type: string; criteria?: unknown[] | Record<string, unknown> }> }> = []
    const server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        requests.push(body)
        const answers = Object.fromEntries(Object.entries(body.questions).map(([id, value]) => {
          const question = value as { type: string; criteria?: unknown[] | Record<string, unknown> }
          return [id, question.type === 'score' ? { type: 'score', score: Math.max(0, (question.criteria as unknown[])?.length - 1), confidence: 0.99 }
            : question.type === 'choice' ? { type: 'choice', choice: Object.keys(question.criteria ?? {})[0], confidence: 0.99 }
              : { type: 'noul', noul: 0.99 }]
        }))
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ model: 'jev-host-planning-mock', answers, usage: { input_tokens: 20, output_tokens: 8 } }))
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: String(error) }))
      }
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as AddressInfo).port
    try {
      const run = await runRecovery('planning-enforced', getRoutesOverlay(), 'normal', undefined, {
        config: { workflow: { mode: 'enforced' }, planningReview: { requireJev: true },
          jev: { enabled: true, apiKeyEnv: 'SWARM_PLANNING_JEV_KEY', baseUrl: `http://127.0.0.1:${port}`, maxRetries: 0 } },
        env: { SWARM_PLANNING_JEV_KEY: 'planning-fixture-key' }
      })
      expect(run.status, run.error ?? run.stderr).toBe('done')
      expect(run.planningReviewers).toHaveLength(1)
      const reviewer = run.planningReviewers![0]!
      expect(reviewer.model).toBe('role-yu_shi')
      expect(reviewer.outputSchemaProperties).toEqual(expect.arrayContaining(['snapshotDigest', 'goalReview', 'designReview', 'mermaidReview', 'requirementCoverage']))
      expect(reviewer.tools).toContain('structured_output')
      expect(reviewer.tools).not.toEqual(expect.arrayContaining(['write']))
      expect(reviewer.tools.some((name) => ['write', 'edit', 'bash', 'pwsh', 'swarm_delegate'].includes(name) || name.startsWith('jev_') || name.startsWith('swarm_message_'))).toBe(false)
      expect(reviewer.seesAgentResult || reviewer.seesJevResult).toBe(false)
      expect(reviewer.readResult).toContain('recovery fixture')
      expect(reviewer.mutationIsError, reviewer.mutationResult).toBe(true)
      expect(existsSync(join(run.workspace, 'planner-should-not-write.txt'))).toBe(false)
      expect(reviewer.requestText).toBe('分析 README.md 并提交有证据的结论')
      expect(reviewer.mermaid).toContain('flowchart TD')
      expect(run.results[0]?.text).toContain('pass')
      expect(run.results[1]?.isError).toBe(true) // 没有将规划通过当成依赖通过。
      expect(run.results[2]?.text).toContain('blocked')
      expect(run.results[3]?.text).toContain('completed')
      expect(run.analysisReadResult).toContain('recovery fixture')
      expect(run.results[3]?.text).toContain('README.md')
      expect(run.results[4]?.text).toContain('accepted')
      expect(run.ledgerEvents.find((event) => event.type === 'workflow/review')?.data).toMatchObject({ status: 'pass' })
      expect(run.planningStatus?.tasks[0]?.planningReview).toMatchObject({ status: 'pass', goalReview: { verdict: 'pass' }, designReview: { verdict: 'pass' },
        mermaidReview: { parseVerdict: 'pass', projectionVerdict: 'pass', parserVersion: '11.12.0' } })
      const planning = requests.filter((request) => Object.hasOwn(request.questions, 'goal_alignment'))
      expect(planning).toHaveLength(1)
      expect(Object.keys(planning[0]!.questions)).toEqual(expect.arrayContaining(['goal_alignment', 'design_sufficiency', 'mermaid_expression']))
      expect(planning[0]!.state.snapshotDigest).toBe(reviewer.snapshotDigest)
      expect(Object.hasOwn(planning[0]!.state, 'agent')).toBe(false)
      expect(retryEvents(run)).toEqual([])
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})
