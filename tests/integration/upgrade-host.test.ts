import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { ensureProfile, runDshAsync, SANDBOX_ROOT, PROFILE, DRIVER_DIR } from '../../scripts/sandbox.mjs'
import { UPGRADE_PROVIDER, upgradeRoute } from './driver/upgrade-scenarios.js'

const runUpgrade = async (scenario: string) => {
  const { home } = ensureProfile()
  const workspace = mkdtempSync(join(SANDBOX_ROOT, 'upgrade-ws-'))
  const out = `${workspace}.json`
  const overlay = `${workspace}.patch.yml`
  writeFileSync(overlay, YAML.stringify([
    { id: 'swarm-core', config: { jev: { enabled: false }, review: { enabled: false }, planningReview: { enabled: false }, workflow: { mode: 'advisory' },
      agents: { maxRetries: 0, networkWaitMs: 0 },
      routes: { tian_shu: scenario === 'root-base-go-ready'
        ? { chain: [upgradeRoute('go'), upgradeRoute('official-api', 'metered_api')], upgrade: { enabled: true,
          chain: [upgradeRoute('upgrade-codex'), upgradeRoute('upgrade-claude'), upgradeRoute('official-api', 'metered_api')], triggers: [] } }
        : { chain: [{ provider: UPGRADE_PROVIDER, model: 'root' }], upgrade: { enabled: false } },
        'suan_heng:verify': { chain: [upgradeRoute('go'), upgradeRoute('official-api', 'metered_api')],
          upgrade: { enabled: true, chain: [upgradeRoute('upgrade-codex'), upgradeRoute('upgrade-claude'), upgradeRoute('official-api', 'metered_api')], triggers: [] } } } } },
    { insert: [{ id: 'swarm-upgrade-test-driver', name: join(DRIVER_DIR, 'upgrade-scenarios.js') }] }
  ]))
  const result = await runDshAsync({ args: ['--profile', PROFILE, '--patch', overlay], cwd: workspace, timeout: 35000,
    env: { SWARM_SCENARIO: '', SWARM_RECOVERY_SCENARIO: '', SWARM_UPGRADE_SCENARIO: scenario, SWARM_UPGRADE_OUT: out } })
  if (!existsSync(out)) throw new Error(`Upgrade fixture missing output\n${result.stdout}\n${result.stderr}`)
  const data = JSON.parse(readFileSync(out, 'utf8'))
  const file = join(home, 'share/dsh-agent-swarm/ledger', `${data.sessionId}.jsonl`)
  const ledger = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  return { ...data, ledger, stderr: result.stderr }
}
describe('真实Host：升级链的按量兜底保留在基础订阅之后', () => {
  it('Codex/Claude已经隔离时真正启动Go，官方API不被提前调用', async () => {
    const run = await runUpgrade('base-go-ready')
    expect(run.status, run.error ?? run.stderr).toBe('done')
    expect(run.results.every((result: { isError: boolean }) => !result.isError)).toBe(true)
    expect(run.requests.filter((request: { model: string }) => request.model !== 'root').map((request: { model: string }) => request.model)).toEqual(['go'])
    expect(run.ledger.find((event: { type: string }) => event.type === 'delegation/completed')?.data.route).toBe(`${UPGRADE_PROVIDER}/go`)
    expect(run.retryEvents).toEqual([])
  })
  it('Go真实模型请求失败后，才切换到官方API继续同一个child', async () => {
    const run = await runUpgrade('base-go-fails')
    expect(run.status, run.error ?? run.stderr).toBe('done')
    const requests = run.requests.filter((request: { model: string }) => request.model !== 'root')
    expect(requests.map((request: { model: string }) => request.model)).toEqual(['go', 'official-api'])
    expect(new Set(requests.map((request: { sessionId: string }) => request.sessionId)).size).toBe(1)
    expect(run.ledger.find((event: { type: string }) => event.type === 'delegation/completed')?.data.route).toBe(`${UPGRADE_PROVIDER}/official-api`)
    expect(run.retryEvents).toEqual([])
  })
  it('可用的升级订阅仍优先，基础订阅与API均不会无故调用', async () => {
    const run = await runUpgrade('upgrade-subscription-ready')
    expect(run.status, run.error ?? run.stderr).toBe('done')
    expect(run.requests.filter((request: { model: string }) => request.model !== 'root').map((request: { model: string }) => request.model)).toEqual(['upgrade-codex'])
  })
  it('天枢初始升级ready链也保留Go在按量末级之前', async () => {
    const run = await runUpgrade('root-base-go-ready')
    expect(run.status, run.error ?? run.stderr).toBe('done')
    expect(run.requests.map((request: { model: string }) => request.model)).toEqual(['root', 'go'])
    expect(run.retryEvents).toEqual([])
  })
})
