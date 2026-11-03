import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getContextAdmission } from '../../src/context-admission.js'
import { getAuthoritativeModelMetadata, OPENAI_API_MODEL_METADATA } from '../../src/model-metadata.js'
import { getFailureHint } from '../../src/util/failure-hint.js'
import { inspectOpenAIProfileText, repairOpenAIProfileText } from '../../scripts/repair-openai-metadata.mjs'

describe('OpenAI direct API model metadata compatibility', () => {
  it('uses the official 1.05M context for every documented GPT-6 API model', () => {
    expect(Object.keys(OPENAI_API_MODEL_METADATA).sort()).toEqual([
      'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.1-terra'
    ])
    for (const metadata of Object.values(OPENAI_API_MODEL_METADATA)) {
      expect(metadata).toMatchObject({ contextWindow: 1_050_000, maxTokens: 128_000, verifiedAt: '2026-11-03' })
    }
    expect(getAuthoritativeModelMetadata('codex', 'gpt-6-astra')).toBeUndefined()
    expect(getAuthoritativeModelMetadata('custom-openai', 'gpt-6-astra')).toBeUndefined()
    expect(getAuthoritativeModelMetadata('openai', 'toString')).toBeUndefined()
  })

  it('admits the observed 368K direct OpenAI context while retaining a 128K output reservation', () => {
    expect(getContextAdmission({
      route: { provider: 'openai', model: 'gpt-6-astra' },
      call: { maxTokens: 128000 },
      measurement: { totalTokens: 368003 },
      modelInfo: { context: { contextWindow: 272000 }, defaultMaxTokens: 128000 }
    })).toEqual({
      ok: true,
      measuredTokens: 368003,
      contextWindow: 1050000,
      reservedOutputTokens: 128000,
      safetyMarginTokens: 4096,
      safeInputTokens: 917904,
      metadataSource: 'openai-api-compat'
    })
  })

  it('does not apply public API limits to subscription or third-party providers', () => {
    expect(getContextAdmission({
      route: { provider: 'codex', model: 'gpt-6-astra' },
      call: { maxTokens: 128000 },
      measurement: { totalTokens: 368003 },
      modelInfo: { context: { contextWindow: 272000 }, defaultMaxTokens: 128000 }
    })).toMatchObject({ ok: false, contextWindow: 272000, safeInputTokens: 139904 })
  })

  it('explains that context and output limits are independent', () => {
    const hint = getFailureHint('max-tokens: 已达到输出 token 上限；回答被截断')
    expect(hint).toContain('1M context')
    expect(hint).toContain('128K 输出预算')
    expect(hint).toContain('reasoning tokens')
  })
})

describe('profile OpenAI metadata repair', () => {
  const patch = `- id: llm-pi-ai\n  config:\n    providers:\n      openai:\n        models:\n          - id: gpt-6-astra\n            contextWindow: 272000\n          - id: gpt-6.1-sol\n            contextWindow: 1050000\n      codex:\n        models:\n          - id: gpt-6-astra\n            contextWindow: 272000\n`

  it('detects only the direct OpenAI provider mismatch', () => {
    const inspected = inspectOpenAIProfileText(patch)
    expect(inspected.models).toEqual([
      { id: 'gpt-6-astra', contextWindow: 272000 },
      { id: 'gpt-6.1-sol', contextWindow: 1050000 }
    ])
    expect(inspected.mismatches).toMatchObject([
      { id: 'gpt-6-astra', actual: 272000, expected: 1050000 }
    ])
  })

  it('repairs the direct model and leaves provider-specific codex metadata untouched', () => {
    const repaired = repairOpenAIProfileText(patch)
    expect(repaired.changes).toMatchObject([
      { id: 'gpt-6-astra', previous: 272000, contextWindow: 1050000 }
    ])
    expect(repaired.text).toContain('openai:\n        models:\n          - id: gpt-6-astra\n            contextWindow: 1050000')
    expect(repaired.text).toContain('codex:\n        models:\n          - id: gpt-6-astra\n            contextWindow: 272000')
    expect(inspectOpenAIProfileText(repaired.text).mismatches).toEqual([])
  })

  it('backs up and atomically applies the repaired profile through the CLI', () => {
    const directory = mkdtempSync(join(tmpdir(), 'swarm-openai-metadata-'))
    try {
      const target = join(directory, 'cordis.patch.yml')
      writeFileSync(target, patch)
      chmodSync(target, 0o600)
      const result = spawnSync(process.execPath, [resolve('scripts/repair-openai-metadata.mjs'), '--profile-dir', directory, '--apply'], { encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
      const output = JSON.parse(result.stdout)
      expect(output.changes).toMatchObject([{ id: 'gpt-6-astra', previous: 272000, contextWindow: 1050000 }])
      expect(output.models).toContainEqual({ id: 'gpt-6-astra', contextWindow: 1050000 })
      expect(existsSync(output.backup)).toBe(true)
      expect(statSync(output.backup).mode & 0o777).toBe(0o600)
      expect(statSync(target).mode & 0o777).toBe(0o600)
      expect(readFileSync(target, 'utf8')).toContain('contextWindow: 1050000')
      const repeated = spawnSync(process.execPath, [resolve('scripts/repair-openai-metadata.mjs'), '--profile-dir', directory, '--apply'], { encoding: 'utf8' })
      expect(repeated.status, repeated.stderr).toBe(0)
      expect(JSON.parse(repeated.stdout)).toMatchObject({ applied: false, mismatches: [] })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('refuses to replace a symlinked profile patch', () => {
    const directory = mkdtempSync(join(tmpdir(), 'swarm-openai-metadata-link-'))
    try {
      const real = join(directory, 'real.yml')
      const target = join(directory, 'cordis.patch.yml')
      writeFileSync(real, patch)
      symlinkSync(real, target)
      const result = spawnSync(process.execPath, [resolve('scripts/repair-openai-metadata.mjs'), '--profile-dir', directory, '--apply'], { encoding: 'utf8' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('符号链接')
      expect(readFileSync(real, 'utf8')).toBe(patch)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
