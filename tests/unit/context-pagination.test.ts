import { describe, expect, it } from 'vitest'
import { DEFAULT_CONTEXT_PAGE_CHARS, intContextStore } from '../../src/context-store.js'

const binding = { rootSessionId: 'root', workspaceId: 'workspace', taskId: 'T-1', cardRevision: 1, workflowRevision: 1, requestRevision: 1 }

describe('上下文页请求恢复', () => {
  it('过大的正整数请求安全收缩，显式返回上限并可无损连续读取', () => {
    const store = intContextStore()
    const text = 'a'.repeat(DEFAULT_CONTEXT_PAGE_CHARS + 2000)
    const artifact = store.Add({ binding, layer: 'L1', kind: 'source', text })
    const first = store.Read(binding, artifact.ref, { limit: 10000, expectedDigest: artifact.digest })
    expect(first).toMatchObject({ requestedLimit: 10000, effectiveLimit: 8000, maxPageChars: 8000, limitClamped: true, returnedChars: 8000, charUnit: 'utf16-code-units', nextCursor: '8000' })
    const second = store.Read(binding, artifact.ref, { cursor: first.nextCursor!, limit: 10000, expectedDigest: artifact.digest })
    expect(second.nextCursor).toBeNull()
    expect(first.text + second.text).toBe(text)
    expect(second.digest).toBe(first.digest)
    expect(store.Read(binding, artifact.ref)).toMatchObject({ requestedLimit: 8000, effectiveLimit: 8000, limitClamped: false })
  })

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('非法 limit %s 仍拒绝，不通过收缩掩盖参数错误', limit => {
    const store = intContextStore()
    const artifact = store.Add({ binding, layer: 'L0', kind: 'contract', text: '合同' })
    expect(() => store.Read(binding, artifact.ref, { limit })).toThrow('正安全整数')
  })

  it('收缩不能绕过任务身份、版本、摘要或盲审权限', () => {
    const store = intContextStore()
    const artifact = store.Add({ binding, layer: 'L2', kind: 'author-reasoning', text: '作者过程' })
    for (const changed of [{ taskId: 'T-2' }, { requestRevision: 2 }, { cardRevision: 2 }, { workflowRevision: 2 }, { blindReview: true }]) {
      expect(() => store.Read({ ...binding, ...changed }, artifact.ref, { limit: 10000 })).toThrow()
    }
    expect(() => store.Read(binding, artifact.ref, { limit: 10000, expectedDigest: 'wrong' })).toThrow('摘要')
  })

  it('小页与 emoji 保持前进且如实报告实际 UTF-16 长度', () => {
    const store = intContextStore({ maxPageChars: 1 })
    const artifact = store.Add({ binding, layer: 'L1', kind: 'source', text: '🙂A' })
    const first = store.Read(binding, artifact.ref, { limit: 10000 })
    expect(first).toMatchObject({ text: '🙂', effectiveLimit: 1, returnedChars: 2, nextCursor: '2', limitClamped: true })
    expect(store.Read(binding, artifact.ref, { cursor: first.nextCursor! }).text).toBe('A')
  })
})
