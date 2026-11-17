import { createHash } from 'node:crypto'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { getValueDigest } from './workflow.js'
import { SwarmError } from './util/errors.js'

export interface ArtifactEntryInfo {
  path: string
  state: 'file' | 'missing' | 'unknown'
  digest?: string
  bytes?: number
  mode?: number
  resolvedPath?: string
  reason?: string
}
export interface ArtifactSnapshotInfo {
  workspaceId: string
  digest: string
  entries: ArtifactEntryInfo[]
  complete: boolean
}
export type ArtifactSnapshot = ArtifactSnapshotInfo
export interface ArtifactLimitsInfo { maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number; exclude?: readonly string[] }

const isInside = (workspace: string, path: string): boolean => {
  const rel = relative(workspace, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** 仅映射已核验目标的任务路径；目录授权仍由调用方核验，物理读取继续检查真实边界。 */
export const getTaskArtifactPath = (target: { root: string; physical: string }, path: string): string => {
  if (path.replace(/\\/g, '/').split('/').includes('..')) throw new SwarmError('PERMISSION_DENIED', '产物路径含父目录跳转')
  if (!isAbsolute(path)) return path
  if (isInside(target.physical, path)) return relative(target.physical, path)
  if (isInside(target.root, path)) return relative(target.root, path)
  throw new SwarmError('PERMISSION_DENIED', '产物路径不属于任务仓库')
}

/** 工作区标识含真实路径与 profile 边界，不作为访问授权凭据。 */
export const getWorkspaceId = async (workspace: string, profile = ''): Promise<string> => getValueDigest({ workspace: await realpath(workspace), profile })

/** 对允许文件的真实内容流式摘要；缺失/未知都保留标记，未知绝不视作有效验证。 */
export const getArtifactSnapshot = async (workspace: string, paths: readonly string[], options: ArtifactLimitsInfo = {}): Promise<ArtifactSnapshotInfo> => {
  const root = await realpath(workspace)
  const limits = { maxFiles: options.maxFiles ?? 256, maxFileBytes: options.maxFileBytes ?? 16 * 1024 * 1024, maxTotalBytes: options.maxTotalBytes ?? 64 * 1024 * 1024 }
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('产物摘要限额必须为正整数')
  if (paths.length > limits.maxFiles) throw new Error('输入文件路径数量超过上限')
  const entries: ArtifactEntryInfo[] = []
  const excluded = options.exclude ?? []
  if (excluded.some(path => !path || isAbsolute(path) || path.split('/').some(part => ['', '.', '..'].includes(part)))) throw new Error('产物排除目录必须为受控相对路径')
  const seen = new Set<string>()
  let totalBytes = 0
  const addUnknown = (path: string, reason: string): void => { entries.push({ path, state: 'unknown', reason }) }
  const visit = async (input: string): Promise<void> => {
    // resolve 会先折叠 ..，而真实 FS 的 symlink/.. 必须先解析链接；范围合同直接拒绝此歧义。
    if (input.replace(/\\/g, '/').split('/').includes('..')) { addUnknown(input, '范围路径不能包含 .. 段'); return }
    const path = resolve(root, input)
    const label = relative(root, path).split(sep).join('/') || '.'
    if (seen.has(path)) return
    seen.add(path)
    if (!isInside(root, path)) { addUnknown(input, '路径不在工作区内'); return }
    // 独立验证的临时输出不属于源码产物；排除项仅由调用方固定，模型工具不能传入。
    if (excluded.some(parent => label === parent || label.startsWith(`${parent}/`))) return
    if (entries.length >= limits.maxFiles) { addUnknown(label, '文件数量超过上限'); return }
    let canonical: string
    try { canonical = await realpath(path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // 缺失文件也要核对已有父目录，防止 workspace/link/missing 指向外部。
        let parent = resolve(path, '..')
        while (isInside(root, parent)) {
          try { if (!isInside(root, await realpath(parent))) { addUnknown(label, '父目录链接指向工作区外'); return }; break }
          catch (parentError) { if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT') { addUnknown(label, String(parentError)); return }; if (parent === root) break; parent = resolve(parent, '..') }
        }
        entries.push({ path: label, state: 'missing' })
      } else addUnknown(label, String(error))
      return
    }
    if (!isInside(root, canonical)) { addUnknown(label, '符号链接指向工作区外'); return }
    const info = await lstat(canonical).catch(() => undefined)
    if (info === undefined) { addUnknown(label, '无法读取文件元数据'); return }
    if (info.isDirectory()) {
      const children = await readdir(canonical).catch(() => undefined)
      if (children === undefined) { addUnknown(label, '目录不可读取'); return }
      for (const child of children.sort()) {
        if (entries.length >= limits.maxFiles) { addUnknown(label, '目录文件数量超过上限'); break }
        await visit(resolve(canonical, child))
      }
      return
    }
    if (!info.isFile()) { addUnknown(label, '只支持普通文件'); return }
    if (info.size > limits.maxFileBytes || totalBytes + info.size > limits.maxTotalBytes) { addUnknown(label, '文件或总字节数超过上限'); return }
    try {
      const handle = await open(canonical, 'r')
      try {
        const before = await handle.stat()
        const hash = createHash('sha256')
        let bytes = 0
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          bytes += chunk.length
          if (bytes > limits.maxFileBytes || totalBytes + bytes > limits.maxTotalBytes) throw new Error('读取期间文件大小超过上限')
          hash.update(chunk)
        }
        const after = await handle.stat()
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('摘要期间文件发生变化')
        totalBytes += bytes
        entries.push({ path: label, state: 'file', digest: hash.digest('hex'), bytes, mode: after.mode & 0o777, resolvedPath: relative(root, canonical).split(sep).join('/') })
      } finally { await handle.close() }
    } catch (error) { addUnknown(label, String(error)) }
  }
  for (const path of [...new Set(paths)].sort()) await visit(path)
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const workspaceId = getValueDigest({ workspace: root, profile: '' })
  return { workspaceId, digest: getValueDigest({ workspaceId, entries }), entries, complete: entries.every((entry) => entry.state !== 'unknown') }
}
