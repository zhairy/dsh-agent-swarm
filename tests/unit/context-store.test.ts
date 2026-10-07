import { describe, expect, it } from 'vitest'
import { intContextStore, isContextRevisionKnown } from '../../src/context-store.js'

const binding = { rootSessionId: 'root', workspaceId: 'work', taskId: 'T1', cardRevision: 1, workflowRevision: 1, threadId: 'expert' }
describe('渐进披露与受控材料引用', () => {
  it('分页保持原文与明确截断，游标不拆开 emoji', () => {
    const store = intContextStore({ maxPageChars: 4 })
    const artifact = store.Add({ binding, layer: 'L2', kind: 'evidence', text: '中文🙂abcdef' })
    const first = store.Read(binding, artifact.ref)
    expect(first.text).toBe('中文🙂')
    expect(first.truncated).toBe(true)
    expect(first.totalBytes).toBe(Buffer.byteLength('中文🙂abcdef'))
    const second = store.Read(binding, artifact.ref, { cursor: first.nextCursor! })
    expect(second.text).toBe('abcd')
    expect(second.digest).toBe(first.digest)
  })
  it('引用猜测不能越过根、工作区、任务、版本与盲审权限', () => {
    const store = intContextStore()
    const artifact = store.Add({ binding, layer: 'L2', kind: 'author-reasoning', text: '作者证明', allowThreads: ['expert'] })
    for (const changed of [{ rootSessionId: 'other' }, { workspaceId: 'other' }, { taskId: 'T2' }, { cardRevision: 2 }, { threadId: 'other' }, { blindReview: true }]) expect(() => store.Read({ ...binding, ...changed }, artifact.ref)).toThrow()
    expect(() => store.Read(binding, artifact.ref, { cursor: '-1' })).toThrow()
    expect(() => store.Read(binding, artifact.ref, { expectedDigest: 'old' })).toThrow()
  })
  it('只在两个版本均一致时省 brief，容量限制拒绝而不假装空材料', () => {
    expect(isContextRevisionKnown({ cardRevision: 1, workflowRevision: 1 }, binding)).toBe(true)
    expect(isContextRevisionKnown({ cardRevision: 1, workflowRevision: 2 }, binding)).toBe(false)
    const store = intContextStore({ maxArtifactBytes: 3 })
    expect(() => store.Add({ binding, layer: 'L0', kind: 'contract', text: '四字' })).toThrow('容量')
  })

  it('恢复保留原引用与授权摘要，冲突/损坏/串任务恢复被拒绝', () => {
    const original = intContextStore()
    const artifact = original.Add({ binding, layer: 'L1', kind: 'evidence', text: '已经验证的工件', allowThreads: ['expert'] })
    const restored = intContextStore()
    expect(restored.Restore(JSON.parse(JSON.stringify(artifact)), binding).ref).toBe(artifact.ref)
    expect(restored.Read(binding, artifact.ref).text).toBe('已经验证的工件')
    expect(restored.Restore(artifact, binding).ref).toBe(artifact.ref)
    expect(() => restored.Restore({ ...artifact, text: '篡改' }, binding)).toThrow('摘要')
    expect(() => restored.Restore({ ...artifact, allowThreads: ['other'] }, binding)).toThrow('冲突')
    expect(() => intContextStore().Restore(artifact, { ...binding, taskId: 'other' })).toThrow('身份')
    expect(() => intContextStore().Restore({ ...artifact, layer: 'unknown' })).toThrow('类型')
  })

  it('需求版本独立于卡片/流程版本，缺省按 legacy 1 处理', () => {
    const store = intContextStore()
    const artifact = store.Add({ binding, layer: 'L0', kind: 'contract', text: '原始需求' })
    expect(store.Read({ ...binding, requestRevision: 1 }, artifact.ref).requestRevision).toBe(1)
    expect(() => store.Read({ ...binding, requestRevision: 2 }, artifact.ref)).toThrow('需求版本')
    expect(() => intContextStore().Restore(artifact, { ...binding, requestRevision: 2 })).toThrow('需求版本')
    expect(isContextRevisionKnown({ ...binding, requestRevision: 1 }, { ...binding, requestRevision: 2 })).toBe(false)
    expect(() => store.Add({ binding: { ...binding, requestRevision: 0 }, layer: 'L0', kind: 'contract', text: '坏版本' })).toThrow()
  })
})
