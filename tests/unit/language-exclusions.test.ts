import { describe, expect, it } from 'vitest'
import { getSwarmConfig } from '../../src/config.js'
import { getLanguageExclusions, LANGUAGE_PLACEHOLDER } from '../../src/language.js'
import { getRuntimeAssembly, OUTPUT_LANGUAGE_SECTION, PERSONA_PREFIX_SECTION } from '../../src/runtime.js'
import { getPresetPersona } from '../../src/role-registry.js'
import { getFailureHint } from '../../src/util/failure-hint.js'
import { getRouteResourcePolicy, normalizeRouteFailure } from '../../src/provider-policy.js'

const assembly = (provider: string) => ({ sections: [
  { name: PERSONA_PREFIX_SECTION, text: getPresetPersona('zhu_jian') },
  { name: 'user-project-rules', text: '用户原文：请保持接口兼容。' }
], contexts: [], tools: [], variables: { provider, model: 'fixture' } })
const policy = { language: 'zh-CN' as const, languageExclusions: ['claude'], promptStyle: 'auto' as const }

describe('专家语言排除', () => {
  it('旧配置不改变行为；名单去重、排序、限制大小，拒绝非法值但保留离线服务商', () => {
    expect(getSwarmConfig({}).agents.languageExclusions).toEqual([])
    const raw = ['offline-provider', 'claude', 'claude', '', ' codex', 'bad\nkey', null, 1]
    expect(getLanguageExclusions(raw)).toEqual(['claude', 'offline-provider'])
    expect(getSwarmConfig({ agents: { languageExclusions: raw } }).agents.languageExclusions).toEqual(['claude', 'offline-provider'])
    expect(getLanguageExclusions('claude')).toEqual([])
    expect(getLanguageExclusions(Array.from({ length: 200 }, (_, i) => `p-${i}`))).toHaveLength(128)
  })
  it('按实际 provider 精确匹配；取消专家语言要求并保留其他工程和用户约束', () => {
    const value = getRuntimeAssembly(assembly('claude'), { ...policy, child: { role: 'zhu_jian' } })
    const text = value.sections.map(section => section.text).join('\n')
    expect(text).not.toContain('**Language**')
    expect(text).not.toContain(LANGUAGE_PLACEHOLDER)
    expect(text).toContain('**Security First**')
    expect(text).toContain('用户原文：请保持接口兼容。')
    expect(value.sections.some(section => section.name === OUTPUT_LANGUAGE_SECTION)).toBe(false)
    expect(getRuntimeAssembly(assembly('claude-custom'), { ...policy, child: { role: 'zhu_jian' } }).sections.at(-1)?.name).toBe(OUTPUT_LANGUAGE_SECTION)
  })
  it('同一会话从已排除服务商回退到非排除服务商后恢复默认语言，反向也生效', () => {
    const relaxed = getRuntimeAssembly(assembly('claude'), { ...policy, child: { role: 'zhu_jian' } })
    const fallback = getRuntimeAssembly({ ...relaxed, variables: { provider: 'codex', model: 'fixture' } }, { ...policy, child: { role: 'zhu_jian' } })
    expect(fallback.sections.at(-1)?.text).toContain('输出语言：简体中文')
    const back = getRuntimeAssembly({ ...fallback, variables: { provider: 'claude', model: 'fixture' } }, { ...policy, child: { role: 'zhu_jian' } })
    expect(back.sections.some(section => section.name === OUTPUT_LANGUAGE_SECTION)).toBe(false)
  })
  it('显式任务语言覆盖排除；天枢最终汇总仍保持默认中文', () => {
    const explicit = getRuntimeAssembly(assembly('claude'), { ...policy, child: { role: 'zhu_jian', language: 'en', explicitLanguage: true } })
    expect(explicit.sections.at(-1)?.text).toContain('This language was set explicitly')
    expect(getRuntimeAssembly(assembly('claude'), policy).sections.at(-1)?.text).toContain('输出语言：简体中文')
    expect(getRuntimeAssembly(assembly('codex'), { ...policy, child: { role: 'zhu_jian', language: 'ja', explicitLanguage: false } }).sections.at(-1)?.text).toContain('输出语言：简体中文')
  })
  it('池内传输故障保留网络语义；冷却提示不能断言当前额度已耗尽', () => {
    const route = { provider: 'codex', model: 'fixture' }
    const message = 'pool "fixture" exhausted: last member (TRANSPORT: codex API request failed)'
    expect(normalizeRouteFailure({ code: 'TRANSPORT', message }, route).kind).toBe('network_transient')
    expect(getFailureHint(message)).toContain('并非额度耗尽')
    expect(getFailureHint('pool "fixture" exhausted: every member is cooling down')).toContain('不等于当前服务端额度')
    expect(getFailureHint('pool "fixture" exhausted: every member is cooling down; account (AUTH) recovers in 2h')).toContain('检查登录与账号权限')
    expect(normalizeRouteFailure({ code: 'QUOTA', message: 'quota exhausted' }, route).kind).toBe('quota_exhausted')
    expect(normalizeRouteFailure({ code: 'INVALID_REQUEST', message: 'Function call is missing a thought_signature in functionCall parts.' }, route).kind).toBe('protocol_incompatible')
    expect(getRouteResourcePolicy({ provider: 'dsh-opencode-go', model: 'fixture' })).toEqual({ accessMode: 'subscription', quotaScope: 'unknown' })
  })
})
