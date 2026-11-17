import { describe, expect, it } from 'vitest'
import { getToolDefinition, getLosslessToolValue } from '../../src/tool-shape.js'

const spec = {
  name: 'demo_tool',
  description: '演示',
  parameters: {
    type: 'object' as const,
    properties: { role: { type: 'string' as const } },
    required: ['role'],
    additionalProperties: false
  },
  execute: async (args: { role: string }) => ({ echoed: args.role }),
  render: (_args: { role: string }, value: { echoed: string }) => `echo:${value.echoed}`,
  isConcurrencySafe: (args: { role: string }) => args.role === 'read'
}

describe('getToolDefinition', () => {
  it('生成宿主工具形状并渲染文本块', async () => {
    const tool = getToolDefinition(spec)
    expect(tool.name).toBe('demo_tool')
    const value = await tool.execute({ role: 'read' }, { signal: new AbortController().signal })
    expect(value).toEqual({ echoed: 'read' })
    expect(tool.output.render({ role: 'read' }, value)).toEqual([{ type: 'text', text: 'echo:read' }])
  })

  it('参数不合法时抛 INVALID_ARGS', async () => {
    const tool = getToolDefinition(spec)
    await expect(tool.execute({}, { signal: new AbortController().signal })).rejects.toThrow('参数不合法')
  })

  it('isConcurrencySafe 对非法参数返回 false', () => {
    const tool = getToolDefinition(spec)
    expect(tool.isConcurrencySafe?.({ role: 'read' })).toBe(true)
    expect(tool.isConcurrencySafe?.({ role: 'edit' })).toBe(false)
    expect(tool.isConcurrencySafe?.({})).toBe(false)
  })

  it('未声明 isConcurrencySafe 与 timeoutMs 时不输出这两个字段', () => {
    const tool = getToolDefinition({ ...spec, isConcurrencySafe: undefined })
    expect('isConcurrencySafe' in tool).toBe(false)
    expect('timeoutMs' in tool).toBe(false)
    expect(getToolDefinition({ ...spec, timeoutMs: 5 }).timeoutMs).toBe(5)
  })
})


describe('lossless DSH tool results', () => {
  it('omits optional fields at every object level and preserves meaningful zero/null values', () => {
    const result = getLosslessToolValue({ task: { optional: undefined, count: 0 }, rows: [{ optional: undefined, value: null }], text: '' })
    expect(result).toEqual({ task: { count: 0 }, rows: [{ value: null }], text: '' })
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })
  it('rejects invalid numbers, undefined array entries and host handles rather than silently changing data', () => {
    for (const value of [NaN, Infinity, { value: -Infinity }, [undefined], new Date(), new Map(), () => 0, 1n]) {
      expect(() => getLosslessToolValue(value)).toThrow(/不能无损编码/)
    }
  })
})
