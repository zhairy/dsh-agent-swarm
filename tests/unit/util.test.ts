import { describe, expect, it } from 'vitest'
import { readLive, readLiveObject } from '../../src/util/live.js'
import { ValidateJsonValue } from '../../src/util/json-schema.js'
import { SwarmError, getErrorText } from '../../src/util/errors.js'
import { intMutex } from '../../src/util/mutex.js'
import { getAgentHeader } from '../../src/host-contract.js'

describe('readLive', () => {
  it('解开带 get() 的 volatile 引用，普通值原样返回', () => {
    expect(readLive({ get: () => 3 })).toBe(3)
    expect(readLive('x')).toBe('x')
    expect(readLive(null)).toBe(null)
  })

  it('readLiveObject 逐字段解开，非对象返回空对象', () => {
    expect(readLiveObject({ a: { get: () => 1 }, b: 2 })).toEqual({ a: 1, b: 2 })
    expect(readLiveObject(undefined)).toEqual({})
  })
})

describe('ValidateJsonValue', () => {
  const schema = {
    type: 'object' as const,
    properties: {
      name: { type: 'string' as const },
      count: { type: 'number' as const },
      ok: { type: 'boolean' as const },
      tags: { type: 'array' as const, items: { type: 'string' as const } },
      level: { type: 'string' as const, enum: ['a', 'b'] }
    },
    required: ['name'],
    additionalProperties: false
  }

  it('合法值无错误', () => {
    expect(ValidateJsonValue(schema, { name: 'n', count: 1, ok: true, tags: ['x'], level: 'a' })).toEqual([])
  })

  it('报告缺失、多余、类型与枚举错误', () => {
    const errors = ValidateJsonValue(schema, { count: 'x', ok: 1, tags: [1], level: 'c', extra: 1 })
    expect(errors).toContain('$.name 缺失')
    expect(errors).toContain('$.extra 不是允许的字段')
    expect(errors).toContain('$.count 必须是数字')
    expect(errors).toContain('$.ok 必须是布尔值')
    expect(errors).toContain('$.tags[0] 必须是字符串')
    expect(errors).toContain('$.level 必须是 a / b 之一')
  })

  it('非对象与非数组报错', () => {
    expect(ValidateJsonValue(schema, 'x')).toEqual(['$ 必须是对象'])
    expect(ValidateJsonValue({ type: 'array' }, {})).toEqual(['$ 必须是数组'])
    expect(ValidateJsonValue({}, 42)).toEqual([])
  })
})

describe('errors', () => {
  it('SwarmError 携带错误码', () => {
    const error = new SwarmError('UNKNOWN_TASK', '未知任务')
    expect(error.code).toBe('UNKNOWN_TASK')
    expect(getErrorText(error)).toBe('未知任务')
    expect(getErrorText('plain')).toBe('plain')
  })
})

describe('intMutex', () => {
  it('串行执行，前一个失败不阻塞后一个', async () => {
    const mutex = intMutex()
    const order: string[] = []
    const slow = mutex.run(async () => {
      await new Promise((r) => setTimeout(r, 20))
      order.push('slow')
      throw new Error('boom')
    })
    const fast = mutex.run(async () => {
      order.push('fast')
      return 1
    })
    await expect(slow).rejects.toThrow('boom')
    await expect(fast).resolves.toBe(1)
    expect(order).toEqual(['slow', 'fast'])
  })
})

describe('getAgentHeader', () => {
  it('缺失时返回空对象', () => {
    expect(getAgentHeader(undefined)).toEqual({})
    expect(getAgentHeader({ id: 'a', session: { header: { parentSession: 'p' } } })).toEqual({ parentSession: 'p' })
  })
})
