import { opendir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { getValueDigest } from './workflow.js'
import { SwarmError } from './util/errors.js'

const ignored = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.sandbox', '.omc', '.enola'])
const within = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/** Enumerates actual files, never guesses a replacement path or follows workspace-external links. */
export const discoverProjectFiles = async (cwd: string, input: { query?: string; cursor?: string; limit?: number } = {}, options: { maxEntries?: number; privateRoots?: string[] } = {}) => {
  if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 256)) throw new SwarmError('INVALID_ARGS', '文件查询必须为不超过256字符的文本')
  const limit = input.limit ?? 80
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new SwarmError('INVALID_ARGS', '文件页大小必须为1–200')
  const root = await realpath(cwd)
  const privateRoots = await Promise.all((options.privateRoots ?? []).map(async (path) => { try { return await realpath(path) } catch { return path } }))
  const paths: string[] = [], unreadable: string[] = [], skippedLinks: string[] = []
  const queue = [root]
  const maxEntries = options.maxEntries ?? 8192
  let scanned = 0
  for (let index = 0; index < queue.length && scanned < maxEntries; index++) {
    const directory = queue[index]!
    try {
      for await (const entry of await opendir(directory)) {
        if (++scanned > maxEntries) break
        const absolute = join(directory, entry.name)
        if (privateRoots.some((privateRoot) => within(privateRoot, absolute))) continue
        const path = relative(root, absolute).split(sep).join('/')
        if (entry.isSymbolicLink()) { if (skippedLinks.length < 20) skippedLinks.push(path); continue }
        if (entry.isDirectory()) { if (!ignored.has(entry.name)) queue.push(absolute) }
        else if (entry.isFile()) paths.push(path)
      }
    } catch { unreadable.push(relative(root, directory).split(sep).join('/') || '.') }
  }
  paths.sort()
  const query = input.query?.trim().replaceAll('\\', '/').toLowerCase() ?? ''
  const matches = paths.filter((path) => path.toLowerCase().includes(query))
  const digest = getValueDigest({ paths, query, scanned, unreadable })
  const parsed = input.cursor === undefined ? undefined : /^([a-f0-9]{64}):(\d+)$/.exec(input.cursor)
  if (input.cursor !== undefined && (!parsed || !Number.isSafeInteger(Number(parsed[2])))) throw new SwarmError('INVALID_ARGS', '文件索引游标不合法')
  if (parsed && parsed[1] !== digest) return { status: 'stale' as const, digest, files: [], nextCursor: null,
    nextAction: '工作区文件索引已改变，请不传 cursor 重新查询；不要沿用旧文件假设。' }
  const offset = Number(parsed?.[2] ?? 0)
  if (offset > matches.length) throw new SwarmError('INVALID_ARGS', '文件索引游标超出范围')
  const files = matches.slice(offset, offset + limit)
  const stem = basename(query).replace(/\.[^.]+$/, '')
  const suggestions = matches.length === 0 && stem ? paths.filter((path) => basename(path).toLowerCase().includes(stem)).slice(0, 10) : []
  return { status: 'ok' as const, digest, files, suggestions, totalMatches: matches.length,
    nextCursor: offset + files.length < matches.length ? `${digest}:${offset + files.length}` : null,
    complete: scanned < maxEntries && unreadable.length === 0, scannedEntries: Math.min(scanned, maxEntries), unreadable, skippedLinks,
    nextAction: matches.length === 0 ? '未发现匹配文件；建议项仅为真实候选，不是自动重定向。先核对文件再使用 read/grep；缺少匹配不等于搜索失败。' : '只对返回的实际文件使用 read/grep；路径相对当前任务工作区。' }
}
