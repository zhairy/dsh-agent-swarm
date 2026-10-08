import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_JEV_CONFIG, type JevConfigInfo } from '../../src/jev.js'
import { intJevHub, isCredentialRefName } from '../../src/jev-hub.js'
import { RPC_METHODS, RunRpcMethod, getRpcRoutes } from '../../src/rpc.js'
import { EMBEDDED_SKILLS, ParseSkillFile, getEmbeddedSkills } from '../../src/skills.js'

const modelsResponse = () => new Response(JSON.stringify({ models: [{ name: 'jev-1.13.0', description: 'System One', release_date: '2026-09-01' }] }), { status: 200, headers: { 'content-type': 'application/json' } })

describe('intJevHub', () => {
  it('同一配置共用取消与重试客户端（不主动限流）；配置变化时重建', () => {
    let config: JevConfigInfo = { ...DEFAULT_JEV_CONFIG }
    const hub = intJevHub({ getConfig: () => config, getCredentials: () => undefined, fetch: vi.fn() as unknown as typeof fetch })
    const first = hub.getClient()
    expect(hub.getClient()).toBe(first)
    config = { ...config, model: 'jev-other' }
    expect(hub.getClient()).not.toBe(first)
  })

  it('密钥：凭据服务优先，其次进程环境变量；状态只说明来源，不含密钥值', async () => {
    const ref = 'SWARM_TEST_JEV_KEY'
    delete process.env[ref]
    const credentials = {
      resolve: vi.fn(async () => ({ value: 'tsk_from_store', source: 'file' })),
      describe: vi.fn(async () => ({ configured: true, source: 'file', writable: true }))
    }
    const auth: string[] = []
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      auth.push(String((init?.headers as Record<string, string> | undefined)?.Authorization))
      return modelsResponse()
    })
    const hub = intJevHub({ getConfig: () => ({ ...DEFAULT_JEV_CONFIG, apiKeyEnv: ref }), getCredentials: () => credentials, fetch: fetch as unknown as typeof globalThis.fetch })
    expect('getKey' in hub).toBe(false)
    await hub.getClient().listModels()
    expect(auth).toEqual(['Bearer tsk_from_store'])
    const status = await hub.describeKey()
    expect(status).toEqual({ ref, configured: true, source: 'file', writable: true })
    expect(JSON.stringify(status)).not.toContain('tsk_')
    process.env[ref] = 'tsk_env'
    const envOnly = intJevHub({ getConfig: () => ({ ...DEFAULT_JEV_CONFIG, apiKeyEnv: ref }), getCredentials: () => undefined, fetch: fetch as unknown as typeof globalThis.fetch })
    await envOnly.getClient().listModels()
    expect(auth.at(-1)).toBe('Bearer tsk_env')
    expect(await envOnly.describeKey()).toEqual({ ref, configured: true, source: 'process-env', writable: false })
    delete process.env[ref]
    expect(await envOnly.describeKey()).toEqual({ ref, configured: false })
  })

  it('引用名不合法（例如误把密钥填进 apiKeyEnv）时既不读取也不回显', async () => {
    const credentials = { resolve: vi.fn(async () => ({ value: 'x' })), describe: vi.fn(async () => ({ configured: true, writable: true })) }
    const hub = intJevHub({ getConfig: () => ({ ...DEFAULT_JEV_CONFIG, apiKeyEnv: 'tsk_live_secret value' }), getCredentials: () => credentials, fetch: vi.fn() as unknown as typeof fetch })
    const status = await hub.describeKey()
    expect(status).toEqual({ ref: '（引用名不合法）', configured: false })
    expect(await hub.getClient().listModels()).toEqual({ ok: false, reason: 'missing-api-key', status: 401 })
    expect(credentials.resolve).not.toHaveBeenCalled()
    expect(isCredentialRefName('TYPESAFE_API_KEY')).toBe(true)
    expect(isCredentialRefName('1BAD')).toBe(false)
  })

  it('健康检查：返回密钥状态与 jev_health 结果', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => modelsResponse())
    const hub = intJevHub({
      getConfig: () => ({ ...DEFAULT_JEV_CONFIG, apiKeyEnv: 'SWARM_TEST_JEV_KEY2' }),
      getCredentials: () => ({ resolve: async () => ({ value: 'tsk_x' }) }),
      fetch: fetch as unknown as typeof globalThis.fetch
    })
    const health = await hub.getHealth()
    expect(health).toMatchObject({ enabled: true, model: 'jev-latest', key: { configured: true }, result: { ok: true, answers: { models: [{ name: 'jev-1.13.0' }] } } })
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.typesafe.ai/v1/models')
  })

  it('凭据服务拒绝时保留权限诊断，不退回环境变量、不发HTTP、不回显异常秘密', async () => {
    const ref = 'SWARM_TEST_JEV_DENIED'
    process.env[ref] = 'tsk_alternate_secret'
    try {
      const denied = Object.assign(new Error('MCP tool call requires approval, but approval policy is never; tsk_sensitive'), { code: 'APPROVAL_REQUIRED' })
      const fetchMock = vi.fn()
      const warnings: string[] = []
      const hub = intJevHub({ getConfig: () => ({ ...DEFAULT_JEV_CONFIG, apiKeyEnv: ref }), getCredentials: () => ({ resolve: async () => { throw denied }, describe: async () => { throw denied } }), fetch: fetchMock as typeof fetch, logger: { warn: (message) => warnings.push(message) } })
      expect(await hub.getClient().ask({}, {})).toEqual({ ok: false, reason: 'credential-permission-denied', status: 403, attempts: 0 })
      expect(await hub.getClient().listModels()).toEqual({ ok: false, reason: 'credential-permission-denied', status: 403 })
      expect(await RunRpcMethod(hub, 'jevStatus', new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'swarm/permission-denied', message: 'credential-permission-denied' } })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(warnings.join(' ')).not.toContain('tsk_')
    } finally { delete process.env[ref] }
  })

  it('凭据描述被拒绝时不提前启动并行HTTP健康检查', async () => {
    const fetchMock = vi.fn(async () => modelsResponse())
    const resolve = vi.fn(async () => ({ value: 'not-used' }))
    const hub = intJevHub({ getConfig: () => DEFAULT_JEV_CONFIG, getCredentials: () => ({ resolve, describe: async () => { throw Object.assign(new Error('permission denied'), { code: 'FORBIDDEN' }) } }), fetch: fetchMock as typeof fetch })
    expect(await RunRpcMethod(hub, 'jevHealth', new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'swarm/permission-denied' } })
    expect(resolve).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('设置页 RPC', () => {
  const hub = intJevHub({
    getConfig: () => ({ ...DEFAULT_JEV_CONFIG, apiKeyEnv: 'SWARM_TEST_JEV_KEY3' }),
    getCredentials: () => ({ resolve: async () => undefined, describe: async () => ({ configured: false, writable: true }) }),
    fetch: vi.fn() as unknown as typeof fetch
  })
  const routes = getRpcRoutes(() => hub)
  const post = (path: string, body: unknown, type = 'application/json') =>
    routes.find((route) => route.path === path)!.fetch(new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) }))

  it('每个方法一条 POST 路由，沿用 client-request / server-response 信封', async () => {
    expect(routes.map((route) => route.path)).toEqual(RPC_METHODS.map((method) => `/api/swarm.${method}`))
    const response = await post('/api/swarm.jevStatus', { type: 'client-request', rpcId: 'r1', method: 'swarm.jevStatus', payload: {} })
    expect(await response.json()).toEqual({ type: 'server-response', rpcId: 'r1', result: { ok: true, value: { ref: 'SWARM_TEST_JEV_KEY3', configured: false, writable: true } } })
  })

  it('拒绝错误的内容类型、非 JSON、无效信封与不匹配的方法', async () => {
    expect((await post('/api/swarm.jevStatus', '{}', 'text/plain')).status).toBe(415)
    expect((await post('/api/swarm.jevStatus', 'not json')).status).toBe(400)
    expect(await (await post('/api/swarm.jevStatus', { rpcId: 'r2' })).json()).toMatchObject({ rpcId: 'r2', result: { ok: false, error: { code: 'gateway/bad-request' } } })
    expect(await (await post('/api/swarm.jevStatus', { type: 'client-request', rpcId: 'r3', method: 'swarm.jevHealth' })).json()).toMatchObject({ rpcId: 'r3', result: { ok: false } })
  })
})

describe('内嵌技能', () => {
  it('解析 frontmatter（含折叠块）并读取随插件发布的技能', () => {
    expect(ParseSkillFile('---\nname: demo\ndescription: >\n  第一行\n  第二行\n---\n正文')).toEqual({ name: 'demo', description: '第一行 第二行', content: '正文' })
    expect(ParseSkillFile('没有 frontmatter')).toEqual({ content: '没有 frontmatter' })
    const skills = getEmbeddedSkills()
    expect(skills.map((skill) => skill.name)).toEqual([...EMBEDDED_SKILLS])
    for (const skill of skills) {
      expect(skill.description.length).toBeGreaterThan(20)
      expect(skill.content.length).toBeGreaterThan(200)
      expect(skill.source).toBe('bundled')
    }
    expect(skills[0]?.content).toContain('jev_check')
  })

  it('缺少文件或描述的技能跳过', () => {
    const root = mkdtempSync(join(tmpdir(), 'swarm-skills-'))
    mkdirSync(join(root, 'jev-judgments'))
    writeFileSync(join(root, 'jev-judgments', 'SKILL.md'), '---\nname: jev-judgments\n---\n正文')
    expect(getEmbeddedSkills(root)).toEqual([])
  })
})
