import { canonicalStateJson, checksumText, deepFreeze, StateStoreError } from './state-core.js'

/**
 * 分片状态模型：把完整状态按顶层段拆成可独立编码、哈希与持久化的分片。
 * 一次提交只重编码/重哈希/写盘“发生变化的分片”，未变分片复用缓存对象。
 * 分片值入库前深冻结；冻结后的引用身份即“内容未变”的可靠信号，配合各存储的写入口脏追踪使用。
 */
export type SegmentKind = 'list' | 'dict' | 'whole'
export interface SegmentSpec {
  readonly kind: SegmentKind
  /** list 段的元素键；分桶段用它校验桶内元素，可省略。 */
  readonly keyOf?: (value: never) => string
  /**
   * 分桶键：同桶元素合并进一个分片（分片 key = 桶键，值 = 该桶的元素数组）。
   * 让段内分片数按桶（例如任务）计数，而不是随历史条目线性增长。
   */
  readonly bucketOf?: (value: never) => string
}
export type SegmentSpecs = Readonly<Record<string, SegmentSpec>>

const itemKey = (field: string) => (value: never): string => {
  const key = (value as unknown as Record<string, unknown>)[field]
  if (typeof key !== 'string' || key.length === 0) throw new StateStoreError('STATE_INVALID', `State chunk is missing string field ${field}`)
  return key
}

/**
 * 2.6.0 的扁平布局：list 段每个元素一个分片。
 * 恢复时会按日志行声明的布局选择规格，因此旧目录仍能完整回放。
 */
export const LEGACY_SEGMENT_SPECS: SegmentSpecs = Object.freeze({
  tasks: { kind: 'list', keyOf: itemKey('taskId') },
  delegations: { kind: 'list', keyOf: itemKey('delegationId') },
  threads: { kind: 'list', keyOf: itemKey('threadId') },
  contexts: { kind: 'list', keyOf: itemKey('ref') },
  agentControls: { kind: 'list', keyOf: itemKey('childId') },
  bindings: { kind: 'dict' },
  bindingHistory: { kind: 'dict' },
  messages: { kind: 'dict' },
  messageAcks: { kind: 'dict' },
  experiences: { kind: 'dict' },
  budgets: { kind: 'dict' },
  planningBudgets: { kind: 'dict' }
})

/** 当前布局版本：2 = delegations 按任务分桶。日志行的 `layout` 数字必须与它一致才能直接增量续写。 */
export const LAYOUT_VERSION = 2

/**
 * dsh-agent-swarm 的状态分片规格；通用 state-store 不假定任何段名，
 * 调用方（feature-session）注入本规格后才会获得分片级增量收益。
 */
export const SWARM_SEGMENT_SPECS: SegmentSpecs = Object.freeze({
  tasks: { kind: 'list', keyOf: itemKey('taskId') },
  // 委派按任务分桶：段内分片数 = 任务数，而不是历史委派总数。
  delegations: { kind: 'list', keyOf: itemKey('delegationId'), bucketOf: itemKey('taskId') },
  threads: { kind: 'list', keyOf: itemKey('threadId') },
  contexts: { kind: 'list', keyOf: itemKey('ref') },
  agentControls: { kind: 'list', keyOf: itemKey('childId') },
  bindings: { kind: 'dict' },
  bindingHistory: { kind: 'dict' },
  messages: { kind: 'dict' },
  messageAcks: { kind: 'dict' },
  experiences: { kind: 'dict' },
  budgets: { kind: 'dict' },
  planningBudgets: { kind: 'dict' }
})

/**
 * 当前布局的完整 store 选项。
 * 「当前布局 / 旧布局 / 版本号」必须一起改：只改一半会把日志行写成与磁盘不一致的布局。
 */
export const SWARM_LAYOUT_OPTIONS = Object.freeze({
  segments: SWARM_SEGMENT_SPECS,
  legacySegments: LEGACY_SEGMENT_SPECS,
  layoutVersion: LAYOUT_VERSION
})

export interface Chunk {
  /** canonical JSON 编码；与整份状态中该分片的字节完全一致 */
  readonly encoded: string
  /** sha256(encoded) */
  readonly hash: string
  /** encoded 的 UTF-8 字节数 */
  readonly bytes: number
  /** 深冻结的规范值；只读副本，绝不与调用方共享可变引用 */
  readonly value: unknown
}

export interface Segment {
  readonly kind: SegmentKind
  /** 分桶 list 段：分片值是元素数组；非分桶 list 段：分片值是单个元素。 */
  readonly bucket?: boolean
  /** list 段的键序；dict/whole 段为 undefined */
  readonly order?: readonly string[]
  readonly chunks: ReadonlyMap<string, Chunk>
  /** 段哈希缓存：段对象不可变（chunks/order 只读且不再修改），未变段在预览中按引用复用。 */
  hash?: string
}

/** 调用方提交的增量补丁（值形态；分片编码与冻结由本模块完成）。 */
export interface StatePatch {
  /** segment → key → 新值（list 段的 key 必须与元素内标识一致） */
  readonly set?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  /** segment → 要删除的 key */
  readonly remove?: Readonly<Record<string, readonly string[]>>
  /** list 段的新键序；省略时按旧序过滤删除项并在尾部追加新增项 */
  readonly order?: Readonly<Record<string, readonly string[]>>
  /** 整段替换（whole 段或整体重写的小段） */
  readonly whole?: Readonly<Record<string, unknown>>
}

export interface PreviewedChunk { readonly segment: string; readonly key: string; readonly chunk: Chunk }
export interface RemovedChunk { readonly segment: string; readonly key: string }
export interface StatePreview {
  readonly next: ChunkedState
  readonly encoded: Readonly<Record<string, Readonly<Record<string, Chunk>>>>
  readonly touched: readonly PreviewedChunk[]
  readonly removed: readonly RemovedChunk[]
  /** 补丁是否真的改变了状态；false 表示所有 set 与已提交分片逐字节一致且无实际删除/顺序变化。 */
  readonly changed: boolean
}

const chunkOf = (value: unknown): Chunk => {
  if (value === undefined) throw new StateStoreError('STATE_INVALID', 'State chunk value must not be undefined')
  try {
    return chunkFromEncoded(canonicalStateJson(value))
  } catch (error) {
    if (!(error instanceof StateStoreError)) throw error
    // 内存态记录可能带 undefined 字段或类原型：与旧的全量提交一致，回退到一次 JSON 往返。
    try {
      return chunkFromEncoded(canonicalStateJson(JSON.parse(JSON.stringify(value)) as unknown))
    } catch (nested) {
      // 回退也失败（例如循环引用）：统一成 STATE_INVALID，而不是把 TypeError 泄露给调用方。
      if (nested instanceof StateStoreError) throw nested
      throw new StateStoreError('STATE_INVALID', 'State chunk value is not serialisable: ' + (nested instanceof Error ? nested.message : String(nested)))
    }
  }
}

/** 已通过 canonicalStateJson 往返的值：可直接冻结，省掉一次多余的解析。 */
const chunkOfVerified = (value: unknown): Chunk => {
  const encoded = canonicalStateJson(value)
  return { encoded, hash: checksumText(encoded), bytes: Buffer.byteLength(encoded, 'utf8'), value: deepFreeze(value) }
}

/** 从已编码的分片重建 Chunk（恢复回放与日志校验共用；不重新编码）。 */
export const chunkFromEncoded = (encoded: string): Chunk => ({
  encoded,
  hash: checksumText(encoded),
  bytes: Buffer.byteLength(encoded, 'utf8'),
  value: deepFreeze(JSON.parse(encoded) as unknown)
})

const segmentHash = (segment: Segment): string => {
  if (segment.hash !== undefined) return segment.hash
  const entries: Array<[string, string]> = []
  if (segment.kind === 'whole') entries.push(['', segment.chunks.get('')?.hash ?? ''])
  else if (segment.kind === 'list') for (const key of segment.order ?? []) entries.push([key, segment.chunks.get(key)?.hash ?? ''])
  else for (const key of [...segment.chunks.keys()].sort()) entries.push([key, segment.chunks.get(key)!.hash])
  segment.hash = checksumText(canonicalStateJson(entries))
  return segment.hash
}

/** 分桶段的桶值编码去掉外层方括号后的长度；用于精确累计整份状态字节数。 */
const bucketInnerBytes = (chunk: Chunk | undefined): number => chunk === undefined ? 0 : Math.max(0, chunk.bytes - 2)

/** 重建 list 段时保留该段是否为分桶段；分桶标记丢失会让 materialize 不再展开桶值。 */
const listSegment = (order: readonly string[], chunks: ReadonlyMap<string, Chunk>, bucket: boolean | undefined): Segment =>
  bucket === true ? { kind: 'list', bucket: true, order, chunks } : { kind: 'list', order, chunks }

const segmentBytes = (name: string, segment: Segment): number => {
  let inner = 2
  if (segment.kind === 'whole') inner = segment.chunks.get('')?.bytes ?? 0
  else if (segment.kind === 'list') {
    const keys = segment.order ?? []
    if (segment.bucket === true) {
      let buckets = 0
      for (const key of keys) {
        const bytes = bucketInnerBytes(segment.chunks.get(key))
        if (bytes === 0) continue
        inner += bytes + (buckets === 0 ? 0 : 1)
        buckets++
      }
    } else for (const [index, key] of keys.entries()) inner += (segment.chunks.get(key)?.bytes ?? 0) + (index === 0 ? 0 : 1)
  } else {
    const keys = [...segment.chunks.keys()].sort()
    for (const [index, key] of keys.entries()) inner += Buffer.byteLength(JSON.stringify(key), 'utf8') + 1 + segment.chunks.get(key)!.bytes + (index === 0 ? 0 : 1)
  }
  return Buffer.byteLength(JSON.stringify(name), 'utf8') + 1 + inner
}

export class ChunkedState {
  private constructor (private readonly segments: ReadonlyMap<string, Segment>, private readonly specs: SegmentSpecs = {}) {}

  /** 全量分片化任意已校验的规范状态（装载、旧路径提交、快照回放后使用）。 */
  static fromState (state: unknown, specs: SegmentSpecs = {}, options: { verified?: boolean } = {}): ChunkedState {
    if (state === null || typeof state !== 'object' || Array.isArray(state)) throw new StateStoreError('STATE_INVALID', 'State must be a plain object')
    const segments = new Map<string, Segment>()
    for (const [name, value] of Object.entries(state as Record<string, unknown>)) segments.set(name, ChunkedState.segmentFromValue(name, value, specs, options.verified === true))
    return new ChunkedState(segments, specs)
  }

  static segmentFromValue (name: string, value: unknown, specs: SegmentSpecs = {}, verified = false): Segment {
    const toChunk = verified ? chunkOfVerified : chunkOf
    const spec = specs[name]
    if (spec?.kind === 'list') {
      if (!Array.isArray(value)) throw new StateStoreError('STATE_INVALID', `State segment ${name} must be an array`)
      if (spec.bucketOf !== undefined) {
        // 分桶段：同桶元素合并为一个分片，桶间顺序 = 首次出现顺序，桶内保持原顺序。
        const buckets = new Map<string, unknown[]>()
        const order: string[] = []
        for (const item of value) {
          const bucket = spec.bucketOf(item as never)
          if (spec.keyOf !== undefined) spec.keyOf(item as never)
          let items = buckets.get(bucket)
          if (items === undefined) { items = []; buckets.set(bucket, items); order.push(bucket) }
          items.push(item)
        }
        const chunks = new Map<string, Chunk>()
        for (const [bucket, items] of buckets) chunks.set(bucket, toChunk(items))
        return { kind: 'list', bucket: true, order, chunks }
      }
      const chunks = new Map<string, Chunk>()
      const order: string[] = []
      for (const item of value) {
        const key = spec.keyOf!(item as never)
        if (chunks.has(key)) throw new StateStoreError('STATE_INVALID', `State segment ${name} has duplicate key`)
        chunks.set(key, toChunk(item))
        order.push(key)
      }
      return { kind: 'list', order, chunks }
    }
    if (spec?.kind === 'dict') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new StateStoreError('STATE_INVALID', `State segment ${name} must be an object`)
      const chunks = new Map<string, Chunk>()
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) chunks.set(key, toChunk(item))
      return { kind: 'dict', chunks }
    }
    return { kind: 'whole', chunks: new Map([['', toChunk(value)]]) }
  }

  /** 组装普通状态视图：未变分片直接复用冻结值引用，不产生深拷贝。 */
  materialize (): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const [name, segment] of this.segments) {
      if (segment.kind === 'whole') result[name] = segment.chunks.get('')?.value
      else if (segment.kind === 'list') {
        if (segment.bucket === true) {
          const flat: unknown[] = []
          for (const key of segment.order ?? []) {
            const chunk = segment.chunks.get(key)
            if (chunk !== undefined) flat.push(...(chunk.value as unknown[]))
          }
          result[name] = flat
        } else result[name] = (segment.order ?? []).map((key) => segment.chunks.get(key)?.value)
      }
      else {
        const value: Record<string, unknown> = {}
        for (const key of [...segment.chunks.keys()].sort()) value[key] = segment.chunks.get(key)!.value
        result[name] = value
      }
    }
    return result
  }

  /** 完整 canonical 编码（快照/迁移用）；与 canonicalStateJson(materialize()) 逐字节一致。 */
  encode (): string {
    const parts = [...this.segments.keys()].sort().map((name) => JSON.stringify(name) + ':' + this.encodeSegment(this.segments.get(name)!))
    return '{' + parts.join(',') + '}'
  }

  private encodeSegment (segment: Segment): string {
    if (segment.kind === 'whole') return segment.chunks.get('')?.encoded ?? 'null'
    if (segment.kind === 'list') {
      if (segment.bucket === true) {
        // 分桶段的分片值是数组：去掉外层方括号后按扁平顺序拼接，与 materialize 的展开一致。
        const parts: string[] = []
        for (const key of segment.order ?? []) {
          const encoded = segment.chunks.get(key)?.encoded
          if (encoded === undefined || encoded === '[]') continue
          parts.push(encoded.slice(1, -1))
        }
        return '[' + parts.join(',') + ']'
      }
      return '[' + (segment.order ?? []).map((key) => segment.chunks.get(key)?.encoded ?? 'null').join(',') + ']'
    }
    return '{' + [...segment.chunks.keys()].sort().map((key) => JSON.stringify(key) + ':' + segment.chunks.get(key)!.encoded).join(',') + '}'
  }

  /** 精确的完整状态 UTF-8 字节数（与 encode() 等长）；O(段数 + 分片数)，不做整份拼接。 */
  getStateBytes (): number {
    let total = 2
    const names = [...this.segments.keys()].sort()
    for (const [index, name] of names.entries()) total += segmentBytes(name, this.segments.get(name)!) + (index === 0 ? 0 : 1)
    return total
  }

  /** 根校验和：段哈希的规范化组合；任何分片内容或顺序变化都会改变它。 */
  rootChecksum (): string {
    const names = [...this.segments.keys()].sort()
    return checksumText(canonicalStateJson(names.map((name) => [name, segmentHash(this.segments.get(name)!)])))
  }

  /** 列表段的键序；whole/dict 段返回 undefined。增量日志必须显式记录它。 */
  order (name: string): readonly string[] | undefined { return this.segments.get(name)?.order }

  /** 现有段名（按段快照与诊断用）；顺序为内部 Map 顺序，不代表规范顺序。 */
  segmentNames (): readonly string[] { return [...this.segments.keys()] }

  /** 单个段的规范编码；与整份状态里该段逐字节一致，按段快照直接落盘。 */
  segmentEncoded (name: string): string | undefined {
    const segment = this.segments.get(name)
    return segment === undefined ? undefined : this.encodeSegment(segment)
  }

  /**
   * 单个段的密码学指纹（分片哈希的规范组合）。
   * 与「整份编码的 sha256」不同：它只依赖分片，未变段的结果可直接复用缓存。
   */
  segmentFingerprint (name: string): string | undefined {
    const segment = this.segments.get(name)
    return segment === undefined ? undefined : segmentHash(segment)
  }

  /**
   * 预演一次增量补丁：编码新增/替换分片、合并顺序与删除，返回候选分片表与变更清单。
   * 不做校验与上限判断；失败（非法值/键不一致/顺序不完整）抛 STATE_INVALID，调用方保持原状态。
   */
  preview (patch: StatePatch): StatePreview {
    const segments = new Map(this.segments)
    const encoded: Record<string, Record<string, Chunk>> = {}
    const touched: PreviewedChunk[] = []
    const removed: RemovedChunk[] = []
    let changed = false
    const recordChunk = (segment: string, key: string, chunk: Chunk): void => {
      ;(encoded[segment] ??= {})[key] = chunk
      touched.push({ segment, key, chunk })
    }
    for (const [name, value] of Object.entries(patch.whole ?? {})) {
      const current = segments.get(name)
      // 已声明为 list/dict 的段即使当前缺席也拒绝整段写入：否则段类型会被固化成 whole，
      // 同段后续的分片补丁被拒，且相同字节会因布局不同得到不同根哈希。
      const kind = current?.kind ?? this.specs[name]?.kind ?? 'whole'
      if (kind !== 'whole') throw new StateStoreError('STATE_INVALID', `State segment ${name} is not a whole segment; use set/remove for declared segments`)
      const chunk = chunkOf(value)
      const previous = current?.chunks.get('')
      if (previous !== undefined && previous.hash === chunk.hash) {
        // 内容未变：保留已提交分片，但仍登记编码，使同批次里其它段变化时补丁仍然完整。
        ;(encoded[name] ??= {})[''] = previous
        continue
      }
      segments.set(name, { kind: 'whole', chunks: new Map([['', chunk]]) })
      recordChunk(name, '', chunk)
      changed = true
    }
    for (const [name, keys] of Object.entries(patch.remove ?? {})) {
      const current = segments.get(name)
      if (current === undefined) continue
      const chunks = new Map(current.chunks)
      let removedAny = false
      for (const key of keys) {
        if (!chunks.has(key)) continue
        chunks.delete(key)
        removed.push({ segment: name, key })
        removedAny = true
      }
      if (!removedAny) continue
      segments.set(name, current.kind === 'list'
        ? listSegment((current.order ?? []).filter((key) => !keys.includes(key)), chunks, current.bucket)
        : { kind: 'dict', chunks })
      changed = true
    }
    for (const [name, entries] of Object.entries(patch.set ?? {})) {
      const current = segments.get(name)
      const spec = this.specs[name]
      const kind = current?.kind ?? spec?.kind ?? 'dict'
      if (kind === 'whole') throw new StateStoreError('STATE_INVALID', `State segment ${name} is a whole segment; declare SegmentSpecs for it or write it via whole`)
      const chunks = new Map(current?.chunks ?? [])
      const order = kind === 'list' ? [...(current?.order ?? [])] : undefined
      let segmentChanged = false
      for (const [key, value] of Object.entries(entries)) {
        if (value === undefined) throw new StateStoreError('STATE_INVALID', `State segment ${name} set.${key} must not be undefined`)
        // 分桶段的键是桶键，值必须是该桶的元素数组：否则会在 materialize 时才暴露出类型错位。
        if (spec?.bucketOf !== undefined && !Array.isArray(value)) throw new StateStoreError('STATE_INVALID', `State segment ${name} set.${key} must be an array of bucket items`)
        // 非分桶 list 段要求 set 的键与元素身份一致；分桶段的键是桶键，不对应元素字段。
        if (spec?.keyOf !== undefined && spec.bucketOf === undefined && spec.keyOf(value as never) !== key) throw new StateStoreError('STATE_INVALID', `State segment ${name} key does not match the value identity`)
        const existing = chunks.get(key)
        const chunk = chunkOf(value)
        if (existing !== undefined && existing.hash === chunk.hash) {
          // 与已提交分片逐字节一致：不记入触碰清单，但保留编码供同一批次写入。
          ;(encoded[name] ??= {})[key] = existing
          continue
        }
        chunks.set(key, chunk)
        if (order !== undefined && !order.includes(key)) order.push(key)
        recordChunk(name, key, chunk)
        segmentChanged = true
        changed = true
      }
      if (segmentChanged) segments.set(name, kind === 'list'
        ? listSegment(order ?? [], chunks, current?.bucket ?? spec?.bucketOf !== undefined)
        : { kind: 'dict', chunks })
    }
    for (const [name, order] of Object.entries(patch.order ?? {})) {
      const current = segments.get(name)
      if (current === undefined) throw new StateStoreError('STATE_INVALID', `State order references missing segment ${name}`)
      if (current.kind !== 'list') throw new StateStoreError('STATE_INVALID', `State segment ${name} is not a list segment`)
      if (new Set(order).size !== order.length) throw new StateStoreError('STATE_INVALID', `State segment ${name} order contains duplicate keys`)
      for (const key of order) if (!current.chunks.has(key)) throw new StateStoreError('STATE_INVALID', `State segment ${name} order references missing key`)
      for (const key of current.chunks.keys()) if (!order.includes(key)) throw new StateStoreError('STATE_INVALID', `State segment ${name} has chunk missing from order`)
      const previous = current.order ?? []
      if (previous.length === order.length && order.every((key, index) => previous[index] === key)) continue
      segments.set(name, listSegment([...order], current.chunks, current.bucket))
      changed = true
    }
    return { next: new ChunkedState(segments, this.specs), encoded, touched, removed, changed }
  }

  /**
   * 恢复回放：把一条日志行里的编码分片合并进当前分片表。
   * 只做结构合并与编码字符串校验；根哈希/链校验由调用方完成。
   */
  applyEncoded (changes: Readonly<Record<string, { readonly set?: Readonly<Record<string, string>>; readonly remove?: readonly string[]; readonly order?: readonly string[]; readonly whole?: string }>>): ChunkedState {
    const segments = new Map(this.segments)
    const chunkList = (entries: Readonly<Record<string, string>> | undefined): Array<[string, Chunk]> => {
      if (entries === undefined) return []
      return Object.entries(entries).map(([key, encoded]) => {
        if (typeof encoded !== 'string') throw new StateStoreError('STATE_INVALID', 'State journal chunk must be an encoded string')
        return [key, chunkFromEncoded(encoded)]
      })
    }
    for (const [name, change] of Object.entries(changes)) {
      if (/^(?:api[_-]?key|password|authorization|credentials|private[_-]?key)$/i.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new StateStoreError('STATE_INVALID', 'State journal contains an unsafe segment name')
      if (change === null || typeof change !== 'object') throw new StateStoreError('STATE_INVALID', `State journal segment ${name} must be an object`)
      if (change.whole !== undefined) {
        segments.set(name, { kind: 'whole', chunks: new Map([['', chunkFromEncoded(change.whole)]]) })
        continue
      }
      const current = segments.get(name)
      const spec = this.specs[name]
      // 与 preview 对称：段首次出现时按其声明类型创建；既未声明又不在当前状态里的段仍然拒绝。
      if (current === undefined && spec === undefined) throw new StateStoreError('STATE_INVALID', `State journal references unknown segment ${name} without a whole chunk`)
      const kind = current?.kind ?? spec!.kind
      const chunks = new Map(current?.chunks ?? [])
      for (const key of change.remove ?? []) chunks.delete(key)
      const order = kind === 'list' ? [...(current?.order ?? [])].filter((key) => !(change.remove ?? []).includes(key)) : undefined
      for (const [key, chunk] of chunkList(change.set)) {
        chunks.set(key, chunk)
        if (order !== undefined && !order.includes(key)) order.push(key)
      }
      if (kind === 'list') {
        const finalOrder = change.order === undefined ? order ?? [] : [...change.order]
        if (new Set(finalOrder).size !== finalOrder.length) throw new StateStoreError('STATE_INVALID', `State journal segment ${name} order contains duplicate keys`)
        for (const key of finalOrder) if (!chunks.has(key)) throw new StateStoreError('STATE_INVALID', `State journal segment ${name} order references missing key`)
        for (const key of chunks.keys()) if (!finalOrder.includes(key)) throw new StateStoreError('STATE_INVALID', `State journal segment ${name} has chunk missing from order`)
        // 按该段自身（或声明）的布局决定是否分桶；回放不得依赖“上一层调用方传了什么”。
        segments.set(name, listSegment(finalOrder, chunks, current?.bucket ?? spec?.bucketOf !== undefined))
      } else {
        segments.set(name, { kind: 'dict', chunks })
      }
    }
    return new ChunkedState(segments, this.specs)
  }
}

/** 校验补丁结构（不编码值）；非法补丁在触碰任何状态前被拒绝。 */
export const normalizeStatePatch = (patch: unknown): StatePatch => {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new StateStoreError('STATE_INVALID', 'State patch must be an object')
  const raw = patch as Record<string, unknown>
  if (Object.keys(raw).some((key) => !['set', 'remove', 'order', 'whole'].includes(key))) throw new StateStoreError('STATE_INVALID', 'State patch contains unknown fields')
  const table = (value: unknown, label: string): Record<string, unknown> => {
    if (value === undefined) return {}
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new StateStoreError('STATE_INVALID', `State patch ${label} must be an object`)
    for (const name of Object.keys(value)) {
      if (/^(?:api[_-]?key|password|authorization|credentials|private[_-]?key)$/i.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new StateStoreError('STATE_INVALID', 'State patch contains an unsafe segment name')
    }
    return value as Record<string, unknown>
  }
  const strings = (value: unknown, label: string): Record<string, readonly string[]> => {
    const result: Record<string, readonly string[]> = {}
    for (const [name, list] of Object.entries(table(value, label))) {
      if (!Array.isArray(list) || list.some((key) => typeof key !== 'string' || key.length === 0)) throw new StateStoreError('STATE_INVALID', `State patch ${label}.${name} must be a string array`)
      result[name] = [...list]
    }
    return result
  }
  const sets = table(raw.set, 'set')
  for (const [name, entries] of Object.entries(sets)) {
    if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) throw new StateStoreError('STATE_INVALID', `State patch set.${name} must be an object`)
    for (const key of Object.keys(entries as Record<string, unknown>)) if (key.length === 0) throw new StateStoreError('STATE_INVALID', `State patch set.${name} contains an empty key`)
  }
  return { set: sets as StatePatch['set'], remove: strings(raw.remove, 'remove'), order: strings(raw.order, 'order'), whole: table(raw.whole, 'whole') }
}
