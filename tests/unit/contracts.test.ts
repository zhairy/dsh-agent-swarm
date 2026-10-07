import { describe, expect, it } from 'vitest'
import { getDelegableRoleIds } from '../../src/role-registry.js'
import { ValidateStructuredOutput, getEvidenceFromOutput, getOutputSchema } from '../../src/contracts.js'
import { VALID_OUTPUTS } from '../fixtures/valid-outputs.js'

describe('交付契约', () => {
  it('每个可委派角色都有对象型 schema，且要求 summary 与 unresolved', () => {
    for (const role of getDelegableRoleIds()) {
      const schema = getOutputSchema(role)
      expect(schema.type).toBe('object')
      expect(schema.required).toEqual(expect.arrayContaining(['summary', 'unresolved']))
      expect(schema.additionalProperties).toBe(false)
    }
  })

  it('每个角色的样例结果都通过校验', () => {
    for (const role of getDelegableRoleIds()) {
      const mode = role === 'suan_heng' ? 'research' : undefined
      expect(ValidateStructuredOutput(role, VALID_OUTPUTS[role], mode), role).toEqual([])
    }
  })

  it('复核：pass 必须有命令且全部退出码为 0', () => {
    const base = VALID_OUTPUTS.fu_he as Record<string, unknown>
    expect(ValidateStructuredOutput('fu_he', { ...base, commands: [] })).toContain('复核判定通过时必须至少记录 1 条实际运行的命令')
    const failing = { ...base, commands: [{ command: 'npm test', exitCode: 1, kind: 'unit', summary: '1 失败' }] }
    expect(ValidateStructuredOutput('fu_he', failing)).toContain('复核判定通过，但存在非零退出码的命令')
    expect(ValidateStructuredOutput('fu_he', { ...failing, verdict: 'fail' })).toEqual([])
  })

  it('妙笔候选数、算衡模式、博闻 URL 的语义检查', () => {
    const miaoBi = VALID_OUTPUTS.miao_bi as { candidates: unknown[] }
    expect(ValidateStructuredOutput('miao_bi', { ...miaoBi, candidates: miaoBi.candidates.slice(0, 1) })).toContain('妙笔必须给出 2–3 个候选')
    expect(ValidateStructuredOutput('suan_heng', VALID_OUTPUTS.suan_heng, 'verify')).toContain('算衡模式应为 verify')
    const verify = { ...(VALID_OUTPUTS.suan_heng as object), mode: 'verify', claims: [] }
    expect(ValidateStructuredOutput('suan_heng', verify, 'verify')).toContain('验算必须至少检验 1 条结论')
    const boWen = VALID_OUTPUTS.bo_wen as { sources: Array<Record<string, unknown>> }
    const badSource = { ...boWen, sources: [{ ...boWen.sources[0], url: 'ftp://x' }] }
    expect(ValidateStructuredOutput('bo_wen', badSource)).toContain('博闻的来源必须是 http(s) URL')
  })

  it('结构不合法时只返回 schema 错误', () => {
    expect(ValidateStructuredOutput('yu_shi', { summary: 's' })[0]).toContain('缺失')
    expect(ValidateStructuredOutput('yu_shi', null)).toEqual(['$ 必须是对象'])
  })

  it('从结构化结果抽取证据', () => {
    expect(getEvidenceFromOutput('fu_he', VALID_OUTPUTS.fu_he)[0]).toMatchObject({ kind: 'command', ref: 'npm test', exitCode: 0, commandKind: 'unit' })
    expect(getEvidenceFromOutput('yu_shi', VALID_OUTPUTS.yu_shi)[0]).toMatchObject({ kind: 'finding', severity: 'medium' })
    expect(getEvidenceFromOutput('bo_wen', VALID_OUTPUTS.bo_wen)[0]).toMatchObject({ kind: 'source', ref: 'https://example.com/rfc' })
    expect(getEvidenceFromOutput('xing_zhou', VALID_OUTPUTS.xing_zhou)[0]).toMatchObject({ kind: 'step', exitCode: 0 })
    expect(getEvidenceFromOutput('ji_feng', VALID_OUTPUTS.ji_feng)[0]).toMatchObject({ kind: 'command' })
    expect(getEvidenceFromOutput('guan_xiang', VALID_OUTPUTS.guan_xiang)[0]).toMatchObject({ kind: 'observation' })
    expect(getEvidenceFromOutput('suan_heng', VALID_OUTPUTS.suan_heng)[0]).toMatchObject({ kind: 'claim' })
    expect(getEvidenceFromOutput('tan_wei', VALID_OUTPUTS.tan_wei)[0]).toMatchObject({ kind: 'finding' })
    expect(getEvidenceFromOutput('zhu_jian', VALID_OUTPUTS.zhu_jian)[0]).toMatchObject({ kind: 'file-change' })
    expect(getEvidenceFromOutput('miao_bi', VALID_OUTPUTS.miao_bi)).toEqual([])
    expect(getEvidenceFromOutput('fu_he', undefined)).toEqual([])
  })
})
