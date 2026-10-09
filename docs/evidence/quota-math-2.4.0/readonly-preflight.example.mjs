// Invoke only from a trusted Host maintenance scope. This module does not
// mount endpoints, read private state/files, change config, or generate text.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const readonlyQuotaPreflight = async (ctx, candidateRoot, routes) => {
  if (routes.length < 2) throw new Error('Preflight requires configured model alternatives')
  const [{ createQuotaReader, createSubscriptionQuotaInvoker }, { getSubscriptionPoolConfiguration }, { createQuotaRoutingSource }] = await Promise.all([
    import(pathToFileURL(join(candidateRoot, 'lib/quota.js')).href),
    import(pathToFileURL(join(candidateRoot, 'lib/quota-routing.js')).href),
    import(pathToFileURL(join(candidateRoot, 'lib/quota-routing-source.js')).href)
  ])
  const connection = ctx.get('connection')
  const baseInvoke = createSubscriptionQuotaInvoker(() => connection?.createSharedFetchHandler('/api'))
  const contracts = Object.fromEntries(['status', 'usage', 'providerSettings'].map(method => [method, { attempted: 0, valid: 0, failed: 0 }]))
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const invoke = async (method, payload, signal) => {
    const kind = method.slice('subscriptions-auth.'.length), count = contracts[kind]
    count.attempted++
    try {
      const value = await baseInvoke(method, payload, signal)
      const valid = kind === 'status' ? object(value) && object(value.providers) && Object.values(value.providers).every(provider => object(provider) && Array.isArray(provider.accounts))
        : kind === 'usage' ? object(value) && typeof value.supported === 'boolean' && (value.supported === false || Array.isArray(value.windows) && value.windows.every(window => object(window) && ['session', 'weekly', 'other'].includes(window.kind) && Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100 && (window.resetsAt === undefined || Number.isSafeInteger(window.resetsAt))))
          : object(value) && value.provider === payload.provider && object(value.settings) && Array.isArray(value.accounts) && value.accounts.every(account => object(account) && typeof account.key === 'string' && Array.isArray(account.models))
      if (valid) count.valid++
      else count.failed++
      return value
    } catch { count.failed++; throw new Error('Public quota RPC unavailable') }
  }
  const pool = () => getSubscriptionPoolConfiguration(ctx.get('configEditor'))
  const source = createQuotaRoutingSource({ reader: createQuotaReader({ invoke }), invoke,
    getPoolConfiguration: pool, getRegisteredProviders: () => ctx.get('llm')?.listProviders().map(provider => provider.id) ?? [],
    available: () => connection?.createSharedFetchHandler !== undefined })
  try {
    const deadline = Date.now() + 30_000
    let diagnostics
    do {
      await source.orderQuotaRoutes(routes)
      diagnostics = source.diagnostics()
      if (['observed', 'unavailable'].includes(diagnostics.status)) break
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    // Deliberately return no account key/email, model id, percentage, reset
    // timestamp, raw RPC body, configuration body, or error body.
    return { sourceStatus: diagnostics.status, poolConfigurationAvailable: pool() !== undefined, authoritativeQuota: false,
      contracts, decisionCount: diagnostics.decisions?.length ?? 0,
      provenMappingCount: diagnostics.decisions?.filter(value => value.membership === 'proven').length ?? 0,
      modelGeneration: 'not-called' }
  } finally { source.dispose() }
}
