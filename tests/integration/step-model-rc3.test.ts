import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { REPO_ROOT, SANDBOX_ROOT } from '../../scripts/sandbox.mjs'

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const evidence = process.env.SWARM_TEST_EVIDENCE_DIR ?? '/data/nas/public/swarm/release-artifacts/v3.4.0-local-20261116'

it('真实 rc3：冻结后原生拒绝切换；桥接重组工具/提示且不重放已执行工具', () => {
  mkdirSync(evidence, { recursive: true })
  // 复制整个 SDK，所有 restore/apply 均落在副本，绝不调用 ensureDsh。
  const source = join(SANDBOX_ROOT, 'dsh-0.2.2-rc.3')
  const target = join(source, 'node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js')
  const before = hash(target)
  const base = mkdtempSync(join(SANDBOX_ROOT, 'step-rc3-'))
  const sdk = join(base, 'sdk')
  cpSync(source, sdk, { recursive: true })
  const bridge = (...args: string[]) => {
    const run = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/apply-dsh-step-bridge.mjs'), '--dsh-root', sdk, ...args], { encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
    return run.stdout
  }
  bridge('--restore')
  const runHost = (label: string) => {
    const home = join(base, label), profile = join(home, 'profiles/step'), out = join(base, `${label}.json`)
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'step-profile', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
    writeFileSync(join(profile, 'cordis.yml'), '[]')
    writeFileSync(join(profile, 'cordis.patch.yml'), '[]')
    const patch = join(base, 'patch.json')
    writeFileSync(patch, JSON.stringify([{ id: 'llm-retry', disabled: true }, { insert: [{ id: 'step-driver', name: join(REPO_ROOT, 'tests/integration/driver/step-model-rc3.js') }] }]))
    const run = spawnSync(process.execPath, [join(sdk, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'step', '--patch', patch], {
      cwd: base, env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', STEP_OUT: out, STEP_INITIAL: label === 'patched' ? 'seed' : 'primary' }, encoding: 'utf8', timeout: 25000
    })
    writeFileSync(join(evidence, `step-${label}-host.log`), `${run.stdout}\n${run.stderr}`)
    const data = JSON.parse(readFileSync(out, 'utf8'))
    writeFileSync(join(evidence, `step-${label}-behavior.json`), JSON.stringify(data, null, 2))
    expect(run.status, run.stderr).toBe(0)
    return data
  }
  try {
    const native = runHost('native')
    expect(native.requests.map((r: { model: string }) => r.model)).toEqual(['primary', 'primary'])
    expect(native.errors.join('\n')).toContain('after step preparation fixed')
    expect(native.executions).toBe(1)
    if (process.env.STEP_RED_NATIVE !== '1') bridge()
    const patched = runHost(process.env.STEP_RED_NATIVE === '1' ? 'red-native' : 'patched')
    expect(patched.errors).toEqual([])
    expect(patched.requests.map((r: { model: string }) => r.model)).toEqual(['primary', 'primary', 'backup'])
    expect(patched.executions).toBe(1)
    expect(patched.requests[0].tools).toContain('step_once')
    expect(patched.requests[0].prompt).toContain('STEP_MODEL_primary')
    expect(patched.requests[2].messages.find((m: { role: string }) => m.role === 'tool').toolCallId).toBe('step-once-id')
    expect(patched.requests[2].messages.find((m: { role: string }) => m.role === 'tool').id).toBe(patched.requests[1].messages.find((m: { role: string }) => m.role === 'tool').id)
    expect(patched.assemblies).toEqual(['primary', 'primary', 'backup'])
    expect(patched.requests[2].tools).not.toContain('step_once')
    expect(patched.requests[2].prompt).toContain('STEP_MODEL_backup')
    expect(patched.requests[2].messages.filter((m: { role: string }) => m.role === 'tool')).toHaveLength(1)
    bridge('--restore')
  } finally {
    expect(hash(target), '共享 SDK 必须保持原样').toBe(before)
  }
}, 90000)
