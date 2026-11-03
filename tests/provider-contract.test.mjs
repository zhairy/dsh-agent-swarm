import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { BUILTIN_ROUTE_PROVIDERS, getRouteResourcePolicy } from '../lib/domain/routing/provider-policy.js'
import { createRouteMetadataCache, getRouteDisplay, PROVIDER_LABELS } from '../lib/domain/routing/routes.js'

const expectedSubscriptions = ['antigravity', 'dsh-opencode-go']

test('every built-in provider has a display label', () => {
  for (const provider of BUILTIN_ROUTE_PROVIDERS) assert.ok(PROVIDER_LABELS[provider], provider)
})

test('built-in subscription aliases retain an explicit resource type', () => {
  for (const provider of expectedSubscriptions) {
    assert.ok(BUILTIN_ROUTE_PROVIDERS.includes(provider))
    assert.equal(getRouteResourcePolicy({ provider, model: 'fixture' }).accessMode, 'subscription')
    assert.ok(PROVIDER_LABELS[provider])
  }
})

test('saved capability metadata inherits the provider type, while an explicit unknown override is respected', () => {
  assert.deepEqual(
    getRouteResourcePolicy({ provider: 'antigravity', model: 'fixture', policy: { capabilities: {} } }),
    { accessMode: 'subscription', quotaScope: 'model', capabilities: {} }
  )
  assert.deepEqual(
    getRouteResourcePolicy({ provider: 'dsh-opencode-go', model: 'fixture', policy: { accessMode: 'unknown' } }),
    { accessMode: 'unknown', quotaScope: 'unknown' }
  )
})

test('route display names the two previously unlabeled providers', () => {
  assert.match(getRouteDisplay({ provider: 'antigravity', model: 'gemini-4-argon-high' }), /Google Antigravity/)
  assert.match(getRouteDisplay({ provider: 'dsh-opencode-go', model: 'kimi-k3.1-pro' }), /DSH OpenCode Go/)
})

test('route admission resolves both providers without a resource-policy refusal', async () => {
  const calls = []
  const llm = {
    listProviders: () => [{ id: 'antigravity' }, { id: 'dsh-opencode-go' }],
    resolveModelInfo: async () => ({
      inputModalities: ['text', 'image'],
      reasoning: { efforts: [{ id: 'high' }, { id: 'max' }] }
    }),
    resolveCallConfig: async (config) => {
      calls.push(config)
      return config
    }
  }
  const cache = createRouteMetadataCache({ pendingWaitMs: 100 })
  const routes = [
    { provider: 'antigravity', model: 'gemini-4-argon-high', reasoningEffort: 'high' },
    { provider: 'dsh-opencode-go', model: 'kimi-k3.1-pro', reasoningEffort: 'max' }
  ]
  const results = await Promise.all(routes.map((route) => cache.probe(llm, route)))
  assert.deepEqual(results, [{ ok: true, vision: true }, { ok: true, vision: true }])
  assert.deepEqual(calls, routes)
})

test('generated client data includes both provider resource types', async () => {
  const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(client, /"antigravity":\s*"subscription"/)
  assert.match(client, /"dsh-opencode-go":\s*"subscription"/)
})
