import { createHash } from 'node:crypto'

export class StateStoreError extends Error {
  constructor (readonly code: 'RECOVERY_REQUIRED' | 'STATE_INVALID' | 'STATE_TOO_LARGE' | 'STORE_CLOSED' | 'OWNER_ACTIVE', message: string) { super(message); this.name = 'StateStoreError' }
}

/**
 * Reject non-JSON, accessors and credential fields before persistence; never silently redact recovery state.
 * 每次提交/分片编码都走这里：分片级增量提交与全量提交共享同一套安全与规范性检查。
 */
export const canonicalStateJson = (value: unknown): string => {
  const stack = new Set<object>()
  const encode = (item: unknown, depth: number): string => {
    if (depth > 64) throw new StateStoreError('STATE_INVALID', 'State nesting exceeds limit')
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item)
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(Object.is(item, -0) ? 0 : item)
    if (typeof item !== 'object' || item === null || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) throw new StateStoreError('STATE_INVALID', 'State must contain finite plain JSON values')
    if (stack.has(item)) throw new StateStoreError('STATE_INVALID', 'State is cyclic')
    stack.add(item)
    const entries: string[] = []
    const keys = Array.isArray(item) ? Array.from({ length: item.length }, (_, index) => String(index)) : Object.keys(item).sort()
    for (const key of keys) {
      if (/^(?:api[_-]?key|password|authorization|credentials|private[_-]?key)$/i.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new StateStoreError('STATE_INVALID', 'Credential or unsafe state field is forbidden')
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (descriptor === undefined || !('value' in descriptor)) throw new StateStoreError('STATE_INVALID', 'State accessors and sparse arrays are forbidden')
      entries.push((Array.isArray(item) ? '' : JSON.stringify(key) + ':') + encode(descriptor.value, depth + 1))
    }
    stack.delete(item)
    return Array.isArray(item) ? '[' + entries.join(',') + ']' : '{' + entries.join(',') + '}'
  }
  return encode(value, 0)
}

export const checksumText = (text: string): string => createHash('sha256').update(text).digest('hex')
export const checksum = (value: unknown): string => checksumText(canonicalStateJson(value))

/**
 * Deep-freeze one already-validated plain JSON value; frozen snapshots make reference identity a safe change signal.
 * 已冻结的值直接返回：分片值在编码时已递归冻结，容器级冻结因此只需遍历顶层段。
 */
export const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const item of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) deepFreeze(item)
  return value
}
