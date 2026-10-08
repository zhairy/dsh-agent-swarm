import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_JEV_CONFIG } from '../../src/jev.js'
import { intJevHub } from '../../src/jev-hub.js'
import { getRpcRoutes, MERMAID_ASSET_PATH } from '../../src/rpc.js'

// Exercise the published carrier rather than an unconstrained route-registry mock.
// The SDK stays outside the plugin's production dependency closure.
const candidates = [process.env.SWARM_DSH_MODULES, resolve('.sandbox/dsh-0.2.0-rc.2/node_modules'), '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules'].filter((value): value is string => Boolean(value))
const hostModules = candidates.find((root) => {
  const base = join(root, '@deepseek-ai')
  return ['cordis', 'dsh-scope', 'dsh-client-connection'].every((name) => existsSync(join(base, name, 'lib/index.js')))
    && JSON.parse(readFileSync(join(base, 'dsh-client-connection/package.json'), 'utf8')).version === '0.2.0-rc.2'
})

const makeHost = async () => {
  const load = (name: string) => import(pathToFileURL(join(hostModules!, '@deepseek-ai', name, 'lib/index.js')).href)
  const [{ Context }, { HostConnectionService }] = await Promise.all([load('cordis'), load('dsh-client-connection')])
  const ctx = new Context()
  // No physical HTTP listener, persistent credential, or model provider is needed.
  const connection = new HostConnectionService(ctx, [], { isAuthenticated: () => true })
  const carrier = connection.createSharedFetchHandler('/api')
  const network = vi.fn(async () => { throw new Error('this local route test must not send network requests') })
  const jev = intJevHub({ getConfig: () => ({ ...DEFAULT_JEV_CONFIG, enabled: false }), getCredentials: () => undefined, fetch: network })
  const taskView = vi.fn((sessionId: string, taskId: string) => ({ sessionId, taskId, state: 'pending' }))
  const routes = getRpcRoutes(() => jev, { taskView })
  const register = (legacyAsset = false) => ctx.inject(['connection'], (scoped: typeof ctx) => {
    const registry = scoped.get('connection').fetch
    for (const route of routes) {
      scoped.effect(() => registry.register(legacyAsset && route.path === MERMAID_ASSET_PATH ? { ...route, path: '/swarm-assets/mermaid.min.js' } : route))
    }
  })
  const post = (method: string, payload?: unknown) => carrier.fetch(new Request(`http://localhost/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `carrier-${method}`, method, payload })
  }))
  return { ctx, carrier, register, post, network, taskView, routes }
}

describe.skipIf(hostModules === undefined)('真实 DSH 0.2 Connection Fetch 路由注册', () => {
  it('注入子作用域保留全部三个 RPC 和 /api 下 Mermaid 资源，不发送模型请求', async () => {
    const host = await makeHost()
    try {
      expect(MERMAID_ASSET_PATH).toBe('/api/swarm-assets/mermaid.min.js')
      await host.register().await()
      const status = await host.post('swarm.jevStatus')
      expect(status.status).toBe(200)
      expect(await status.json()).toMatchObject({ type: 'server-response', result: { ok: true, value: { ref: 'TYPESAFE_API_KEY' } } })
      const health = await host.post('swarm.jevHealth')
      expect(health.status).toBe(200)
      expect(await health.json()).toMatchObject({ result: { ok: true, value: { enabled: false, result: { ok: false } } } })
      const task = await host.post('swarm.taskView', { sessionId: 'registered-root', taskId: 'T-1' })
      expect(task.status).toBe(200)
      expect(await task.json()).toMatchObject({ result: { ok: true, value: { sessionId: 'registered-root', taskId: 'T-1', state: 'pending' } } })
      expect(host.taskView).toHaveBeenCalledExactlyOnceWith('registered-root', 'T-1')
      const asset = await host.carrier.fetch(new Request(`http://localhost${MERMAID_ASSET_PATH}`))
      expect(asset.status).toBe(200)
      expect(asset.headers.get('content-type')).toContain('text/javascript')
      expect(asset.headers.get('x-content-type-options')).toBe('nosniff')
      expect((await asset.text()).length).toBeGreaterThan(100_000)
      expect(host.network).not.toHaveBeenCalled()
    } finally { await host.ctx.fiber.dispose() }
  })

  it('子作用域卸载撤销所有路由，再注入可完整恢复且不出现重复注册', async () => {
    const host = await makeHost()
    try {
      const first = host.register()
      await first.await()
      await first.dispose()
      for (const route of host.routes) {
        const response = await host.carrier.fetch(new Request(`http://localhost${route.path}`, { method: route.methods[0] }))
        expect(response.status).toBe(404)
      }
      await host.register().await()
      expect((await host.post('swarm.jevStatus')).status).toBe(200)
      expect((await host.carrier.fetch(new Request(`http://localhost${MERMAID_ASSET_PATH}`))).status).toBe(200)
      expect(host.network).not.toHaveBeenCalled()
    } finally { await host.ctx.fiber.dispose() }
  })

  it('旧 /api 外资源在真实 SDK 被拒绝，并回滚先前注册的三个 RPC', async () => {
    const host = await makeHost()
    try {
      const failed = host.register(true)
      await expect(failed.await()).rejects.toThrow('connection: invalid exact Fetch route "/swarm-assets/mermaid.min.js"')
      for (const method of ['swarm.jevStatus', 'swarm.jevHealth', 'swarm.taskView']) {
        expect((await host.post(method)).status).toBe(404)
      }
      expect((await host.carrier.fetch(new Request('http://localhost/swarm-assets/mermaid.min.js'))).status).toBe(404)
      expect(host.network).not.toHaveBeenCalled()
      expect(host.taskView).not.toHaveBeenCalled()
    } finally { await host.ctx.fiber.dispose() }
  })
})
