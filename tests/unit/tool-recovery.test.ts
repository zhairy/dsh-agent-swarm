import { describe, expect, it } from 'vitest'
import { getToolRecoveryResult } from '../../src/tool-recovery.js'

const failure = (code: string, message: string) => ({ isError: true, error: { message, info: { code } }, content: [{ type: 'text', text: `Error: ${message}` }], meta: { retained: true } })

describe('host tool recovery feedback', () => {
  it('keeps overflow errors authoritative and adds bounded search recovery without replay', () => {
    const result = failure('SEARCH_RAW_OUTPUT_OVERFLOW', 'glob produced more raw output than the subprocess seam retained within the 20000000-byte cap')
    const output = getToolRecoveryResult('glob', result) as typeof result
    expect(output.isError).toBe(true)
    expect(output.error).toBe(result.error)
    expect(output.meta).toBe(result.meta)
    expect(result.content).toHaveLength(1)
    expect(output.content).toHaveLength(2)
    expect(output.content[1]?.text).toContain('swarm_project_files')
    expect(getToolRecoveryResult('glob', output)).toBe(output)
  })

  it('distinguishes Fetch endpoint failures from missing public pages and model failures', () => {
    const result = failure('WEB_PROVIDER_ERROR', 'DeepSeek API error (HTTP 404): failed to fetch URL')
    const output = getToolRecoveryResult('web_fetch', result) as typeof result
    expect(output.error).toBe(result.error)
    expect(output.content[1]?.text).toContain('不能据此认定目标网页不存在')
    expect(output.content[1]?.text).toContain('不自动改地址')
    expect(getToolRecoveryResult('web_search', result)).toBe(result)
  })

  it('does not reinterpret successful/unrelated/abort results or remote text as policy', () => {
    const ok = { ...failure('SEARCH_RAW_OUTPUT_OVERFLOW', 'overflow'), isError: false }
    expect(getToolRecoveryResult('glob', ok)).toBe(ok)
    for (const code of ['SEARCH_ABORTED', 'SEARCH_INVALID_PATTERN', 'WEB_ABORTED']) {
      const result = failure(code, 'operation cancelled')
      expect(getToolRecoveryResult('glob', result)).toBe(result)
    }
    expect(getToolRecoveryResult('glob', undefined)).toBeUndefined()
  })
})
