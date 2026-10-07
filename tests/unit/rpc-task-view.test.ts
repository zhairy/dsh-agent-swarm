import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSwarmConfig } from '../../src/config.js'
import { getRpcRoutes, RunRpcMethod, MERMAID_ASSET_PATH } from '../../src/rpc.js'
import { intSwarmService, type SwarmService } from '../../src/service.js'

const fixtures: Array<{ home: string; service: SwarmService }> = []
afterEach(async () => { for (const fixture of fixtures.splice(0)) { await fixture.service.dispose(); await rm(fixture.home, { recursive: true, force: true }) } })
const makeFixture = async () => {
  const home = await mkdtemp(join(tmpdir(), 'swarm-task-rpc-'))
  const config = getSwarmConfig({ jev: { enabled: false }, rootFallback: false, planningReview: { enabled: false } })
  const service = intSwarmService({ getConfig: () => config, getLlm: () => undefined, getSubagents: () => undefined, getTools: () => undefined, getAttachments: () => undefined, getCredentials: () => undefined, dshHome: home, fetch: vi.fn() as unknown as typeof fetch })
  fixtures.push({ home, service })
  const agent = { id: 'registered-root', session: { header: { agentPreset: 'tian-shu', cwd: home } } }
  const result = await service.AddTaskCard({ title: '只读任务', goal: '只规划，不执行或伪造成功', acceptance: ['给出任务流程和真实状态'], scope: [], flags: {} }, { agent, signal: new AbortController().signal })
  const routes = getRpcRoutes(() => service.jev, { taskView: (sessionId, taskId) => service.getTaskViewForRpc(sessionId, taskId) })
  const taskRoute = routes.find((route) => route.path === '/api/swarm.taskView')!
  const post = (payload: unknown, method = 'swarm.taskView') => taskRoute.fetch(new Request('http://localhost/api/swarm.taskView', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method, payload }) }))
  return { service, routes, post, taskId: result.task_id, sessionId: agent.id }
}

describe('生产只读 taskView RPC 与本地静态 Mermaid', () => {
  it('实际注册三条 RPC 与固定资产，旧 Jev-only 工厂保留两条', async () => {
    const fixture = await makeFixture()
    expect(fixture.routes.map((route) => route.path)).toEqual(['/api/swarm.jevStatus', '/api/swarm.jevHealth', '/api/swarm.taskView', MERMAID_ASSET_PATH])
    expect(getRpcRoutes(() => fixture.service.jev)).toHaveLength(2)
  })

  it('返回真实已登记任务的合同、DAG、Markdown 和待审核状态', async () => {
    const { post, sessionId, taskId } = await makeFixture()
    const response = await post({ sessionId, taskId })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ type: 'server-response', rpcId: 'rpc-1', result: { ok: true, value: { task_id: taskId, card: { goal: '只规划，不执行或伪造成功' } } } })
    expect(body.result.value.flow.mermaid).toContain('flowchart TD')
    expect(body.result.value.markdown).toContain('委派预算：不限')
    expect(body.result.value.planningReview).toBeNull()
  })

  it('未知会话/任务被拒绝，不通过 RPC 创建一个空会话', async () => {
    const { post, service, sessionId, taskId } = await makeFixture()
    const unknown = await (await post({ sessionId: 'unknown-session', taskId })).json()
    expect(unknown.result.ok).toBe(false)
    expect(() => service.getTaskViewForRpc('unknown-session', taskId)).toThrow()
    expect((await (await post({ sessionId, taskId: 'unknown-task' })).json()).result.ok).toBe(false)
  })

  it('拒绝额外字段、空/非字符串/超长 ID 与错误信封方法', async () => {
    const { post, sessionId, taskId } = await makeFixture()
    for (const payload of [null, [], { sessionId, taskId, path: '/etc/passwd' }, { sessionId: '', taskId }, { sessionId, taskId: 1 }, { sessionId: 'x'.repeat(129), taskId }, { sessionId: 'a\n', taskId }]) {
      const response = await post(payload)
      expect((await response.json()).result).toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
    }
    expect((await (await post({ sessionId, taskId }, 'swarm.jevStatus')).json()).result.ok).toBe(false)
  })

  it('固定资源与请求路径参数无关，不接受 POST 或任意文件读取', async () => {
    const { routes } = await makeFixture()
    const route = routes.find((item) => item.path === MERMAID_ASSET_PATH)!
    const plain = await route.fetch(new Request(`http://localhost${MERMAID_ASSET_PATH}`))
    expect(plain.status).toBe(200)
    expect(plain.headers.get('content-type')).toContain('text/javascript')
    expect(plain.headers.get('x-content-type-options')).toBe('nosniff')
    const source = await plain.text()
    expect(source).toContain('mermaid')
    const pathAttempt = await route.fetch(new Request(`http://localhost${MERMAID_ASSET_PATH}?path=/etc/passwd`))
    expect(await pathAttempt.text()).toBe(source)
    expect((await route.fetch(new Request(`http://localhost${MERMAID_ASSET_PATH}`, { method: 'POST' }))).status).toBe(405)
  })

  it('缺少 taskView 接入时返回 unavailable，保留 RunRpcMethod 旧调用', async () => {
    const { service, sessionId, taskId } = await makeFixture()
    expect(await RunRpcMethod(service.jev, 'taskView', new AbortController().signal, { sessionId, taskId })).toMatchObject({ ok: false, error: { code: 'swarm/unavailable' } })
    expect(await RunRpcMethod(service.jev, 'jevStatus', new AbortController().signal)).toMatchObject({ ok: true })
  })
})
