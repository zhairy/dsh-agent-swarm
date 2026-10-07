import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PNG_1X1, getRoutesOverlay, runScenario } from './helpers.js'
import { REPO_ROOT, ensureProfile } from '../../scripts/sandbox.mjs'

const JEV_OFF = { jev: { enabled: false } }

beforeAll(() => {
  if (!existsSync(join(REPO_ROOT, 'lib', 'index.js'))) throw new Error('请先运行 npm run build')
  ensureProfile()
})

describe('连续会话与重试', () => {
  it('thread-flow：复核开连续会话，第二次委派追加到同一会话（漏交 json 时在会话内修正）；一次性调用照常；天枢不收到重复的结束通知', async () => {
    const run = await runScenario('thread-flow', { ...JEV_OFF, routes: getRoutesOverlay({ fu_he: ['badjson-fu_he'] }) })
    expect(run.status, run.error ?? run.stderr).toBe('done')
    const [, first, second, oneshot, status] = run.results
    expect(first?.text).toContain('【复核】completed')
    expect(first?.text).toContain('新建连续会话')
    expect(first?.text).toContain('自动重试 1 次')
    expect(second?.text).toContain('【复核】completed')
    expect(second?.text).toContain('追加到连续会话')
    expect(second?.text).toContain('第 2 轮')
    expect(oneshot?.text).toContain('【探微】completed')
    expect(oneshot?.text).toContain('会话：一次性调用（天枢指定')
    expect(status?.text).toContain('连续会话：')
    const fuHe = run.childMessages.filter((m) => m.role === 'fu_he')
    expect(new Set(fuHe.map((m) => m.sessionId)).size).toBe(1)
    expect(fuHe.map((m) => m.turn)).toEqual([1, 2, 3])
    expect(fuHe[1]?.text).toContain('没有可解析的 json')
    expect(fuHe[2]?.text).toContain('【追加】任务 T-1')
    expect(run.rootNotices).toBe(0)
    const types = run.ledgerEvents.map((e) => e.type)
    expect(types.filter((t) => t === 'session/plan')).toHaveLength(3)
    expect(types).toContain('delegation/retry')
  })
})

describe('委派、门禁与回退', () => {
  it('gate-flow：疾风改文件 → 验收被拦 → 复核（首路由 QUOTA 回退）→ 验收通过', async () => {
    const run = await runScenario('gate-flow', { ...JEV_OFF, routes: getRoutesOverlay({ ji_feng: ['writer-ji_feng'], fu_he: ['fail-quota', 'role-fu_he'] }) })
    expect(run.status, run.error ?? run.stderr).toBe('done')
    const [card, edit, blocked, verify, accepted, status] = run.results
    expect(card?.text).toContain('task_id: T-1')
    expect(card?.text).toContain('G_VERIFY')
    expect(edit?.text).toContain('【疾风】completed')
    expect(edit?.text).toContain('hello.txt')
    expect(blocked?.text).toContain('验收结果：blocked')
    expect(verify?.text).toContain('【复核】completed')
    expect(verify?.text).toContain('回退 swarm-mock/fail-quota')
    expect(verify?.text).toContain('模型 role-fu_he · swarm-mock')
    expect(accepted?.text).toContain('验收结果：accepted')
    expect(status?.text).toContain('✓ G_VERIFY')
    expect(run.failQuotaHits).toBeGreaterThanOrEqual(1)
    expect(readFileSync(join(run.workspace, 'hello.txt'), 'utf8')).toBe('hello swarm\n')
    expect(run.rootTools).toEqual(expect.arrayContaining(['swarm_task_card', 'swarm_delegate', 'swarm_status', 'swarm_accept']))
    expect(run.rootTools).not.toContain('subagent')
    expect(run.rootTools).not.toContain('workflow')
    const jiFeng = run.children.find((c) => c.role === 'ji_feng')
    const fuHe = run.children.find((c) => c.role === 'fu_he')
    expect(jiFeng?.tools).toContain('write')
    expect(jiFeng?.tools).not.toContain('swarm_delegate')
    expect(fuHe?.tools).toContain('read')
    expect(fuHe?.tools).not.toContain('write')
    expect(fuHe?.tools).not.toContain('edit')
    const types = run.ledgerEvents.map((e) => e.type)
    expect(types.filter((t) => t === 'delegation/completed')).toHaveLength(2)
    expect(types).toContain('route/fallback')
    expect(types.filter((t) => t === 'accept/decision')).toHaveLength(2)
  })

  it('native-fallback：未安装原生 Codex 时退回 spawn 并记录原因', async () => {
    const run = await runScenario('native-fallback', { ...JEV_OFF, routes: getRoutesOverlay() })
    expect(run.status, run.error ?? run.stderr).toBe('done')
    expect(run.results[1]?.text).toContain('native-unavailable')
    expect(run.results[1]?.text).toContain('【探微】completed')
    expect(run.subagentProviders).not.toContain('swarm-codex')
  })

  it('root-fallback：主会话模型 QUOTA 后按天枢链回退', async () => {
    const run = await runScenario('root-fallback', { ...JEV_OFF, routes: getRoutesOverlay() }, { env: { SWARM_ROOT_MODEL: 'fail-quota' } })
    expect(run.status, run.error ?? run.stderr).toBe('done')
    expect(run.failQuotaHits).toBeGreaterThanOrEqual(1)
    expect(run.results[0]?.text).toContain('task_id: T-1')
    expect(run.ledgerEvents.some((e) => e.type === 'route/fallback' && e.data.scope === 'root')).toBe(true)
  })
})

describe('视觉与权限', () => {
  it('vision-blocked：链上只有纯文本模型时拒绝，不降级', async () => {
    const run = await runScenario('vision-blocked', { ...JEV_OFF, routes: getRoutesOverlay({ guan_xiang: ['textonly-guan_xiang'] }) }, { files: { 'shot.png': PNG_1X1 } })
    expect(run.status, run.error ?? run.stderr).toBe('done')
    expect(run.results[1]?.text).toContain('【观象】blocked')
    expect(run.results[1]?.text).toContain('vision-unsupported')
    expect(run.children.some((c) => c.role === 'guan_xiang')).toBe(false)
  })

  it('vision-ok：截图入库后交给观象；越界路径被拒绝', async () => {
    const run = await runScenario('vision-ok', { ...JEV_OFF, routes: getRoutesOverlay() }, { files: { 'shot.png': PNG_1X1 } })
    expect(run.status, run.error ?? run.stderr).toBe('done')
    expect(run.results[1]?.text).toContain('【观象】completed')
    expect(run.children.find((c) => c.role === 'guan_xiang')?.images).toBe(true)
    expect(run.results[2]?.text).toContain('不在工作区内')
  })

  it('readonly-guard：御史预设中调用 write 被守卫拒绝，且没有 shell 与 swarm 工具', async () => {
    const run = await runScenario('readonly-guard', { ...JEV_OFF, routes: getRoutesOverlay() })
    expect(run.status, run.error ?? run.stderr).toBe('done')
    expect(run.results[0]?.text).toContain('守卫')
    expect(existsSync(join(run.workspace, 'guard.txt'))).toBe(false)
    expect(run.rootTools).not.toContain('pwsh')
    expect(run.rootTools).not.toContain('bash')
    expect(run.rootTools).not.toContain('swarm_delegate')
  })
})

describe('衡鉴 Jev', () => {
  let server: Server
  let port = 0
  let mode: 'ok' | 'overloaded' = 'ok'
  const requests: Array<{ auth?: string; body: Record<string, unknown> }> = []
  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve) => { let data = ''; req.on('data', (c) => { data += c }); req.on('end', () => resolve(data)) })

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>
      requests.push({ auth: req.headers.authorization, body })
      if (mode === 'overloaded') {
        res.writeHead(529).end('{}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        model: 'jev-1.13.0',
        answers: { math_task: { choice: 'research', confidence: 0.9 }, need_benchmark: { noul: 0.2 }, novelty: { score: 0.5, confidence: 0.9 } }
      }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })
  afterAll(() => { server.close() })

  const jevConfig = () => ({ routes: getRoutesOverlay(), jev: { enabled: true, baseUrl: `http://127.0.0.1:${port}`, apiKeyEnv: 'SWARM_TEST_JEV_KEY' } })

  it('jev-triage：按答案追加门禁，请求带 Bearer 且只含脱敏摘要', async () => {
    mode = 'ok'
    const run = await runScenario('jev-triage', jevConfig(), { env: { SWARM_TEST_JEV_KEY: 'test-key' } })
    expect(run.status, run.error ?? run.stderr).toBe('done')
    expect(run.results[0]?.text).toContain('衡鉴：rules+jev')
    expect(run.results[0]?.text).toContain('G_MATH_RESEARCH')
    const request = requests.at(-1)
    expect(request?.auth).toBe('Bearer test-key')
    expect(request?.body.model).toBe('jev-latest')
    expect(Object.keys((request?.body.state ?? {}) as object).sort()).toEqual(['acceptance_count', 'flags', 'goal', 'profile', 'scope_count', 'task'])
  })

  it('jev-fallback：Jev 过载时按严格路径追加验算与审查', async () => {
    mode = 'overloaded'
    const run = await runScenario('jev-fallback', jevConfig(), { env: { SWARM_TEST_JEV_KEY: 'test-key' } })
    expect(run.status, run.error ?? run.stderr).toBe('done')
    expect(run.results[0]?.text).toContain('rules+jev-fallback')
    expect(run.results[0]?.text).toContain('http-529')
    expect(run.results[0]?.text).toContain('G_MATH_VERIFY')
  })
})
