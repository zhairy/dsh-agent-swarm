import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { PROFILE, REPO_ROOT, ensureProfile, runDsh } from '../../scripts/sandbox.mjs'

const PRESET_IDS = ['tian-shu', 'mou-ding', 'shu-ji', 'suan-heng', 'tan-wei', 'bo-wen', 'guan-xiang', 'zhu-jian', 'xing-zhou', 'ji-feng', 'yu-shi', 'fu-he', 'miao-bi']

beforeAll(() => {
  if (!existsSync(join(REPO_ROOT, 'lib', 'index.js'))) throw new Error('请先运行 npm run build')
  ensureProfile(undefined, { reset: true })
})

describe('bundle 在真实 DSH 中组合', () => {
  it('--dump-config 可见 swarm-core、原生实例、13 个预设与默认值 tian-shu', () => {
    const result = runDsh({ args: ['--profile', PROFILE, '--dump-config'] })
    expect(result.status, result.stderr).toBe(0)
    const text = result.stdout
    expect(text).toContain('swarm-core')
    expect(text).toContain('swarm-claude-plan')
    for (const id of PRESET_IDS) expect(text).toContain(`preset-${id}`)
    expect(text).toMatch(/default:\s*tian-shu/)
  })
})
