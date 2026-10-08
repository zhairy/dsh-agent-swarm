import { describe, expect, it } from 'vitest'
import { intContextStore, isContextRevisionKnown } from '../../src/context-store.js'

const binding = { rootSessionId: 'root', workspaceId: 'work', taskId: 'T1', cardRevision: 1, workflowRevision: 1, threadId: 'expert' }
describe('渐进披露与受控材料引用', () => {
  it('材料索引与正文使用相同授权，不泄漏跨任务、过期、线程专有或盲审禁止材料', () => {
    const store = intContextStore()
    const visible = store.Add({ binding, layer: 'L0', kind: 'contract', text: '当前合同' })
    store.Add({ binding: { ...binding, taskId: 'T2' }, layer: 'L1', kind: 'source', text: '其他任务' })
    store.Add({ binding: { ...binding, cardRevision: 2 }, layer: 'L1', kind: 'source', text: '其他版本' })
    store.Add({ binding, layer: 'L1', kind: 'source', text: '其他专家', allowThreads: ['other'] })
    const author = store.Add({ binding, layer: 'L2', kind: 'author-reasoning', text: '作者过程' })
    expect(store.List(binding).map((item) => item.ref)).toEqual([visible.ref, author.ref])
    expect(store.List({ ...binding, blindReview: true })).toEqual([expect.objectContaining({ ref: visible.ref, kind: 'contract' })])
    expect(store.List(binding)[0]).not.toHaveProperty('text')
    expect(store.List({ ...binding, rootSessionId: 'other' })).toEqual([])
  })
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

  it('512边界替换预检失败不删除旧引用、不改变旧版本，也不影响其他任务', () => {
    const store = intContextStore()
    const old = store.Add({ binding, layer: 'L0', kind: 'contract', text: 'old' })
    const other = { ...binding, taskId: 'T2' }
    for (let index = 0; index < 511; index++) store.Add({ binding: other, layer: 'L1', kind: 'source', text: String(index) })
    expect(() => store.PrepareTaskReplace({ ...binding, cardRevision: 2 }, [
      { layer: 'L0', kind: 'contract', text: 'new contract' }, { layer: 'L1', kind: 'source', text: 'new request' }
    ])).toThrow('容量')
    expect(store.Read(binding, old.ref)).toMatchObject({ text: 'old', cardRevision: 1 })
    expect(store.List(binding).map((item) => item.ref)).toEqual([old.ref])
    expect(store.List({ ...binding, cardRevision: 2 })).toEqual([])
    expect(store.List(other)).toHaveLength(511)
  })

  it('512边界多次修订仅替换本任务旧版本，保留跨任务和跨根材料', () => {
    const store = intContextStore()
    const other = { ...binding, taskId: 'T2' }
    const otherRoot = { ...binding, rootSessionId: 'other-root' }
    for (let index = 0; index < 509; index++) store.Add({ binding: other, layer: 'L1', kind: 'source', text: String(index) })
    const foreign = store.Add({ binding: otherRoot, layer: 'L1', kind: 'source', text: 'other root' })
    let current = binding
    let refs = [store.Add({ binding, layer: 'L0', kind: 'contract', text: 'initial' }), store.Add({ binding, layer: 'L1', kind: 'source', text: 'request' })]
    for (let cardRevision = 2; cardRevision <= 301; cardRevision++) {
      const next = { ...binding, cardRevision }
      const batch = store.PrepareTaskReplace(next, [{ layer: 'L0', kind: 'contract', text: 'revision ' + cardRevision }, { layer: 'L1', kind: 'source', text: 'request' }])
      expect(batch.replaced.map((item) => item.ref)).toEqual(refs.map((item) => item.ref))
      expect(store.Read(current, refs[0]!.ref).cardRevision).toBe(current.cardRevision)
      batch.commit(); batch.finalize()
      expect(() => store.Read(current, refs[0]!.ref)).toThrow('不存在')
      current = next; refs = batch.artifacts
      expect(store.List(current)).toHaveLength(2)
    }
    expect(store.List(other)).toHaveLength(509)
    expect(store.Read(otherRoot, foreign.ref).text).toBe('other root')
  })

  it('批量字节校验失败保持全部旧材料，准备阶段和返回快照不会修改live Map', () => {
    const store = intContextStore({ maxArtifactBytes: 8 })
    const old = store.Add({ binding, layer: 'L0', kind: 'contract', text: 'old' })
    expect(() => store.PrepareTaskReplace({ ...binding, requestRevision: 2 }, [{ layer: 'L0', kind: 'contract', text: 'new' }, { layer: 'L1', kind: 'source', text: '超长中文正文' }])).toThrow('容量')
    expect(store.Read(binding, old.ref).text).toBe('old')
    const next = { ...binding, requestRevision: 2 }
    const batch = store.PrepareTaskReplace(next, [{ layer: 'L0', kind: 'contract', text: 'new' }])
    batch.artifacts[0]!.text = 'tampered'
    expect(store.Read(binding, old.ref).text).toBe('old')
    batch.commit()
    expect(store.Read(next, batch.artifacts[0]!.ref).text).toBe('new')
    batch.rollback()
    expect(store.Read(binding, old.ref).text).toBe('old')
    expect(() => store.Read(next, batch.artifacts[0]!.ref)).toThrow('不存在')
  })

  it('预检后同任务并发变更或其他任务填满容量使commit拒绝且不覆盖任何材料', () => {
    const store = intContextStore({ maxArtifacts: 3 })
    const old = store.Add({ binding, layer: 'L0', kind: 'contract', text: 'old' })
    const next = { ...binding, workflowRevision: 2 }
    const first = store.PrepareTaskReplace(next, [{ layer: 'L0', kind: 'contract', text: 'new' }])
    const concurrent = store.Add({ binding, layer: 'L2', kind: 'evidence', text: 'concurrent evidence' })
    expect(() => first.commit()).toThrow('预检后改变')
    expect(store.Read(binding, concurrent.ref).text).toBe('concurrent evidence')
    const second = store.PrepareTaskReplace(next, [{ layer: 'L0', kind: 'contract', text: 'new' }, { layer: 'L1', kind: 'source', text: 'request' }, { layer: 'L2', kind: 'evidence', text: 'extra' }])
    const other = { ...binding, taskId: 'T2' }
    const foreign = store.Add({ binding: other, layer: 'L1', kind: 'source', text: 'another task' })
    expect(() => second.commit()).toThrow('容量')
    expect(store.Read(binding, old.ref).text).toBe('old')
    expect(store.Read(other, foreign.ref).text).toBe('another task')
    const full = store.PrepareTaskReplace(next, [{ layer: 'L0', kind: 'contract', text: '1' }, { layer: 'L1', kind: 'source', text: '2' }])
    full.rollback()
    expect(() => full.commit()).toThrow('回滚')
  })

  it('durable失败可回滚；释放的容量在finalize之前保留，不能被跨任务并发挤占', () => {
    const store = intContextStore({ maxArtifacts: 4 })
    const old = Array.from({ length: 3 }, (_, index) => store.Add({ binding, layer: 'L2', kind: 'evidence', text: String(index) }))
    const other = { ...binding, taskId: 'T2' }
    const foreign = store.Add({ binding: other, layer: 'L1', kind: 'source', text: 'foreign' })
    const next = { ...binding, cardRevision: 2 }
    const batch = store.PrepareTaskReplace(next, [{ layer: 'L0', kind: 'contract', text: 'new' }])
    batch.commit()
    expect(() => store.Add({ binding: other, layer: 'L1', kind: 'source', text: 'fill rollback slots' })).toThrow('容量')
    expect(() => store.Add({ binding: next, layer: 'L2', kind: 'evidence', text: 'same-task concurrent' })).toThrow('正在提交')
    batch.rollback(); batch.rollback()
    expect(store.List(binding).map((item) => item.ref)).toEqual(old.map((item) => item.ref))
    expect(store.Read(other, foreign.ref).text).toBe('foreign')
    const successful = store.PrepareTaskReplace(next, [{ layer: 'L0', kind: 'contract', text: 'committed' }])
    successful.commit(); successful.finalize(); successful.finalize()
    expect(store.Add({ binding: other, layer: 'L1', kind: 'source', text: 'now free' })).toHaveProperty('ref')
    expect(() => successful.rollback()).toThrow('不能回滚')
  })

  it('只删除失效身份版本，保留同版本的有效L2并遵守新合同总量容量', () => {
    const store = intContextStore({ maxArtifacts: 4 })
    store.Add({ binding, layer: 'L0', kind: 'contract', text: 'old' })
    const next = { ...binding, cardRevision: 2 }
    const currentEvidence = store.Add({ binding: next, layer: 'L2', kind: 'evidence', text: 'current' })
    const batch = store.PrepareTaskReplace(next, [{ layer: 'L0', kind: 'contract', text: 'new' }, { layer: 'L1', kind: 'source', text: 'request' }])
    expect(batch.replaced).toHaveLength(1)
    batch.commit(); batch.finalize()
    expect(store.Read(next, currentEvidence.ref).text).toBe('current')
    expect(store.List(next)).toHaveLength(3)
  })
})
