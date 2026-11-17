import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const configuredPluginLibRoot = process.env.PLUGIN_LIB_ROOT
if (configuredPluginLibRoot === undefined || configuredPluginLibRoot.trim() === '') {
  throw new Error('PLUGIN_LIB_ROOT is required and must point to an offline dsh-plugin-subscriptions lib directory')
}

const pluginLibRoot = resolve(configuredPluginLibRoot)
const previousDshHome = process.env.DSH_HOME
const testDshHome = mkdtempSync(join(tmpdir(), 'subscriptions-transport-test-'))
process.env.DSH_HOME = testDshHome

const importModule = path => import(pathToFileURL(path).href)
const { CodexAdapter, CODEX_PREEMPT_MS } = await importModule(join(pluginLibRoot, 'providers/codex.js'))
const { mapFetchFailure } = await importModule(join(pluginLibRoot, 'providers/common.js'))
const { PoolAdapter } = await importModule(join(pluginLibRoot, 'providers/pool.js'))

test.after(() => {
  rmSync(testDshHome, { recursive: true, force: true })
  if (previousDshHome === undefined) {
    delete process.env.DSH_HOME
  } else {
    process.env.DSH_HOME = previousDshHome
  }
})

const causeError = () => new TypeError('terminated', {
  cause: Object.assign(new Error('other side closed'), { name: 'SocketError', code: 'UND_ERR_SOCKET' })
})

test('transport cause persists only safe error names and network codes', () => {
  const mapped = mapFetchFailure('codex API', causeError(), { timedOut: () => false }, new AbortController().signal)
  assert.equal(mapped.code, 'TRANSPORT')
  assert.match(mapped.message, /TypeError -> SocketError\[UND_ERR_SOCKET\]/)
  assert.match(mapped.failure.message, /SocketError\[UND_ERR_SOCKET\]/)
})

test('cause summary never persists arbitrary messages or credential-shaped values', () => {
  const markers = [
    'FAKE_CLIENT_SECRET',
    'FAKE_ID_TOKEN',
    'FAKE_COOKIE',
    'FAKE_URL_PASSWORD'
  ]
  const messages = [
    `client_secret=${markers[0]}`,
    `id_token=${markers[1]}`,
    `Cookie: session=${markers[2]}`,
    `request to https://fake-user:${markers[3]}@proxy.invalid failed`
  ]
  for (const message of messages) {
    const mapped = mapFetchFailure('codex API', new Error(message), { timedOut: () => false }, new AbortController().signal)
    const persistedFailure = JSON.stringify(mapped.failure)
    assert.equal(mapped.message, 'codex API request failed; cause: Error')
    assert.ok(markers.every(marker => !mapped.message.includes(marker)))
    assert.ok(markers.every(marker => !persistedFailure.includes(marker)))
  }
})

test('cancellation and idle timeout classification remain unchanged', () => {
  const controller = new AbortController()
  controller.abort(new Error('cancel'))
  assert.equal(mapFetchFailure('codex API', causeError(), { timedOut: () => false }, controller.signal).code, 'ABORTED')
  assert.equal(mapFetchFailure('codex API', causeError(), { timedOut: () => true }, new AbortController().signal).code, 'TIMEOUT')
})

test('pool errors and warnings do not expose account keys', () => {
  const warnings = []
  const fakeAccount = 'FAKE-SENSITIVE-ACCOUNT'
  const pool = new PoolAdapter({
    onWarn: message => warnings.push(message),
    health: { earliestRecoveryRecord: () => undefined }
  })
  const error = mapFetchFailure('codex API', causeError(), { timedOut: () => false }, new AbortController().signal)
  const exhausted = pool.exhausted('gpt-test', [{ provider: 'codex', account: fakeAccount, model: 'gpt-test' }], {
    member: { provider: 'codex', account: fakeAccount, model: 'gpt-test' },
    error
  }, 1, true)
  assert.match(exhausted.message, /codex\/gpt-test/)
  assert.match(exhausted.message, /SocketError\[UND_ERR_SOCKET\]/)
  assert.doesNotMatch(exhausted.message, new RegExp(fakeAccount))
  assert.ok(warnings.every(message => !message.includes(fakeAccount)))
})

test('all-cooling pool errors also omit account keys', () => {
  const warnings = []
  const fakeAccount = 'FAKE-SENSITIVE-ACCOUNT'
  const pool = new PoolAdapter({
    onWarn: message => warnings.push(message),
    health: {
      earliestRecoveryRecord: () => ({
        key: `codex/${fakeAccount}/gpt-test`,
        unavailableUntil: Date.now() + 1_000,
        reason: 'AUTH'
      })
    }
  })
  const exhausted = pool.exhausted('gpt-test', [{ provider: 'codex', account: fakeAccount, model: 'gpt-test' }])
  assert.doesNotMatch(exhausted.message, new RegExp(fakeAccount))
  assert.ok(warnings.every(message => !message.includes(fakeAccount)))
})

test('Codex stream keeps the raw socket cause visible in TRANSPORT', async () => {
  let requests = 0
  const server = createServer((_request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('event: response.created\ndata: {"type":"response.created","response":{}}\n\n')
    setTimeout(() => response.destroy(new Error('stub socket reset')), 20)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.notEqual(address, null)
  assert.equal(typeof address, 'object')
  const localUrl = `http://127.0.0.1:${address.port}/v1/responses`
  const originalFetch = globalThis.fetch
  globalThis.fetch = (_input, init) => originalFetch(localUrl, init)
  const session = {
    accessToken: 'stub-access-token',
    refreshToken: 'stub-refresh-token',
    expiresAt: Date.now() + CODEX_PREEMPT_MS + 60_000,
    accountId: 'stub-account'
  }
  const tokens = {
    async session(_account, forceRefresh = false) {
      if (forceRefresh) throw new Error('probe OAuth refresh disabled')
      return session
    }
  }
  const adapter = new CodexAdapter({
    clientVersion: '0.0.0',
    models: [{ id: 'gpt-test' }],
    streamIdleTimeoutMs: 5_000,
    tokens,
    discovery: false
  })
  try {
    await assert.rejects(async () => {
      for await (const chunk of adapter.stream({
        provider: 'codex',
        model: 'gpt-test',
        maxTokens: 4,
        system: 'Reply with OK only.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK only.' }] }],
        signal: AbortSignal.timeout(5_000)
      })) {
        void chunk
      }
    }, error => {
      assert.equal(error.code, 'TRANSPORT')
      assert.match(error.message, /SocketError\[UND_ERR_SOCKET\]/)
      return true
    })
    assert.equal(requests, 1)
  } finally {
    globalThis.fetch = originalFetch
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})
