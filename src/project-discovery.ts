import { opendir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { getValueDigest } from './workflow.js'
import { SwarmError } from './util/errors.js'

const ignored = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.sandbox', '.omc', '.enola'])
const MAX_INDEX_PATH_BYTES = 1024 * 1024
const MAX_PAGE_PATH_BYTES = 32 * 1024
const within = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/** Enumerates actual files, never guesses a replacement path or follows workspace-external links. */
export const discoverProjectFiles = async (cwd: string, input: { path?: string; query?: string; cursor?: string; limit?: number } = {}, options: { maxEntries?: number; privateRoots?: string[]; signal?: AbortSignal } = {}) => {
  options.signal?.throwIfAborted()
  if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 256)) throw new SwarmError('INVALID_ARGS', '文件查询必须为不超过256字符的文本')
  if (input.path !== undefined && (typeof input.path !== 'string' || input.path.length > 4096 || isAbsolute(input.path) || input.path.replaceAll('\\', '/').split('/').includes('..'))) throw new SwarmError('INVALID_ARGS', '文件目录 path 必须为当前工作区内的相对目录，不允许 .. 或绝对路径')
  const limit = input.limit ?? 80
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new SwarmError('INVALID_ARGS', '文件页大小必须为1–200')
  const root = await realpath(cwd)
  const privateRoots = await Promise.all((options.privateRoots ?? []).map(async (path) => { try { return await realpath(path) } catch { return path } }))
  let directoryRoot: string
  try { directoryRoot = await realpath(join(root, input.path ?? '.')) }
  catch { throw new SwarmError('INVALID_ARGS', '文件目录不存在或不可读取；先核对当前工作区和 path，不猜测替代路径') }
  if (!within(root, directoryRoot) || privateRoots.some((path) => within(path, directoryRoot))) throw new SwarmError('PATH_OUTSIDE_WORKSPACE', '文件目录超出授权工作区或指向私有状态')
  const paths: string[] = [], unreadable: string[] = [], skippedLinks: string[] = []
  const queue = [directoryRoot]
  const maxEntries = options.maxEntries ?? 8192
  let scanned = 0, pathBytes = 0, indexCapped = false
  for (let index = 0; index < queue.length && scanned < maxEntries && !indexCapped; index++) {
    options.signal?.throwIfAborted()
    const directory = queue[index]!
    try {
      for await (const entry of await opendir(directory)) {
        options.signal?.throwIfAborted()
        if (++scanned > maxEntries) break
        const absolute = join(directory, entry.name)
        if (privateRoots.some((privateRoot) => within(privateRoot, absolute))) continue
        const path = relative(root, absolute).split(sep).join('/')
        // Bound retained paths as well as entry count: long filenames can fill
        // a raw search buffer even when the number of entries looks small.
        pathBytes += Buffer.byteLength(path, 'utf8')
        if (pathBytes > MAX_INDEX_PATH_BYTES) { indexCapped = true; break }
        if (entry.isSymbolicLink()) { if (skippedLinks.length < 20) skippedLinks.push(path.slice(0, 256)); continue }
        if (entry.isDirectory()) { if (!ignored.has(entry.name)) queue.push(absolute) }
        else if (entry.isFile()) paths.push(path)
      }
    } catch {
      options.signal?.throwIfAborted()
      if (unreadable.length < 20) unreadable.push((relative(root, directory).split(sep).join('/') || '.').slice(0, 256))
    }
  }
  paths.sort()
  const query = input.query?.trim().replaceAll('\\', '/').toLowerCase() ?? ''
  const matches = paths.filter((path) => path.toLowerCase().includes(query))
  const scope = relative(root, directoryRoot).split(sep).join('/') || '.'
  const digest = getValueDigest({ paths, scope, query, scanned, unreadable, indexCapped })
  const parsed = input.cursor === undefined ? undefined : /^([a-f0-9]{64}):(\d+)$/.exec(input.cursor)
  if (input.cursor !== undefined && (!parsed || !Number.isSafeInteger(Number(parsed[2])))) throw new SwarmError('INVALID_ARGS', '文件索引游标不合法')
  if (parsed && parsed[1] !== digest) return { status: 'stale' as const, digest, files: [], nextCursor: null,
    nextAction: '工作区文件索引已改变，请不传 cursor 重新查询；不要沿用旧文件假设。' }
  const offset = Number(parsed?.[2] ?? 0)
  if (offset > matches.length) throw new SwarmError('INVALID_ARGS', '文件索引游标超出范围')
  const files: string[] = []
  let pageBytes = 0
  for (const path of matches.slice(offset, offset + limit)) {
    pageBytes += Buffer.byteLength(JSON.stringify(path), 'utf8') + 1
    if (pageBytes > MAX_PAGE_PATH_BYTES) break
    files.push(path)
  }
  const stem = basename(query).replace(/\.[^.]+$/, '')
  const suggestions = matches.length === 0 && stem ? paths.filter((path) => basename(path).toLowerCase().includes(stem)).slice(0, 10) : []
  const complete = scanned < maxEntries && !indexCapped && unreadable.length === 0
  return { status: 'ok' as const, digest, path: scope, files, suggestions, totalMatches: matches.length,
    nextCursor: offset + files.length < matches.length ? `${digest}:${offset + files.length}` : null,
    complete, indexCapped, scannedEntries: Math.min(scanned, maxEntries), unreadable, skippedLinks,
    nextAction: !complete ? '文件索引未覆盖整个目录；使用 path 指定更小的实际子目录重新查询。cursor 只分页当前有界索引，不代表尚未扫描的文件；空结果不能证明文件不存在。'
      : matches.length === 0 ? '未发现匹配文件；建议项仅为真实候选，不是自动重定向。先核对文件再使用 read/grep；缺少匹配不等于搜索失败。' : '只对返回的实际文件使用 read/grep；路径相对当前任务工作区。' }
}
