import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * 解析必须显式提供的 CLI 参数。
 * 该夹具不提供默认 SDK/Notebook 路径，避免把活动 bundle 误当成候选包。
 */
export const parseRequiredOptions = (argv, names) => {
  const result = {}
  for (const name of names) {
    const flag = `--${name}`
    const index = argv.indexOf(flag)
    if (index < 0) throw new Error(`缺少必需参数 ${flag}`)
    const value = argv[index + 1]
    if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
      throw new Error(`${flag} 缺少路径`)
    }
    if (Object.hasOwn(result, name)) throw new Error(`${flag} 重复出现`)
    result[name] = value
  }
  return result
}

/**
 * 终态日志只保留可定位信息，移除 auth token、Cookie 与 Authorization。
 * `_sid` 是 fixture 结果绑定所需的 session 身份，不属于认证秘密。
 */
export const redactSensitiveText = value => String(value ?? '')
  .replace(/([?&](?:token|access_token|auth_token|code)=)[^&#\s]+/gi, '$1[REDACTED]')
  .replace(/(cookie\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
  .replace(/(set-cookie\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')
  .replace(/(authorization\s*:\s*(?:bearer\s+)?)[^\r\n]+/gi, '$1[REDACTED]')
  .replace(/("(?:cookie|set-cookie|authorization)"\s*:\s*")[^"]*"/gi, '$1[REDACTED]"')

export const parseValue = value => {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export const getResultValue = batch => {
  const row = batch?.results?.[0] ?? batch
  return row?.result ?? row
}

export const getResultText = result => {
  const content = result?.content
  if (Array.isArray(content)) {
    const text = content
      .filter(block => block?.type === 'text')
      .map(block => block.text)
      .join('\n')
    if (text !== '') return text
  }
  if (typeof result?.value === 'string') return result.value
  if (result?.value !== undefined) {
    try {
      return JSON.stringify(result.value)
    } catch {
      return String(result.value)
    }
  }
  return String(result?.error ?? result?.text ?? '')
}

export const isToolErrorResult = result => {
  if (result?.isError === true || result?.error !== undefined && result.error !== null) return true
  if (result?.value?.isError === true || result?.value?.error !== undefined && result.value.error !== null) return true
  return /^(?:Error:|工具|专家|天枢)/.test(getResultText(result))
}

export const getSnapshot = value => {
  const parsed = parseValue(value)
  const current = parsed?.value ?? parsed
  return current?.notebook ?? current?.current ?? current
}

export const getFirstCellId = value => {
  const snapshot = getSnapshot(value)
  return snapshot?.cells?.find?.(cell => typeof cell?.id === 'string')?.id
}

export const getAddedCellId = value => {
  const parsed = parseValue(value)
  if (typeof parsed?.cell?.id === 'string') return parsed.cell.id
  const snapshot = getSnapshot(parsed)
  return snapshot?.cells?.findLast?.(cell => typeof cell?.id === 'string')?.id
}

const outputText = output => {
  if (output === null || output === undefined) return ''
  if (typeof output === 'string') return output
  if (Array.isArray(output)) return output.map(outputText).join('')
  if (typeof output !== 'object') return String(output)
  const parts = []
  for (const key of ['text', 'data', 'content', 'stderr', 'stdout']) {
    if (Object.hasOwn(output, key)) parts.push(outputText(output[key]))
  }
  if (parts.length > 0) return parts.join('')
  try {
    return JSON.stringify(output)
  } catch {
    return ''
  }
}

export const getStdout = value => {
  const parsed = parseValue(value)
  const direct = parsed?.stdout
  if (typeof direct === 'string') return direct
  if (direct !== undefined) return outputText(direct)
  const snapshot = getSnapshot(parsed)
  return (snapshot?.cells ?? []).map(cell => (cell?.outputs ?? []).map(outputText).join('')).join('')
}

export const getExecutionStatus = value => {
  const parsed = parseValue(value)
  return typeof parsed?.status === 'string' ? parsed.status : undefined
}

/**
 * 将 Notebook HTTP/工具 envelope 压缩为稳定事实，避免把完整 token 或图像数据写入证据。
 */
export const getNotebookCellFacts = value => {
  const snapshot = getSnapshot(value) ?? {}
  const cells = Array.isArray(snapshot.cells) ? snapshot.cells : []
  const sources = cells.map(cell => String(cell?.source ?? cell?.source_preview ?? ''))
  const outputSummary = cells.map(cell => (Array.isArray(cell?.outputs) ? cell.outputs.map(outputText).join('') : '')).join('\n')
  const kernel = isRecord(snapshot.kernel) ? snapshot.kernel : {}
  return {
    cellCount: cells.length,
    cells: cells.map((cell, index) => ({
      index,
      id: typeof cell?.id === 'string' ? cell.id : null,
      cellType: typeof cell?.cell_type === 'string' ? cell.cell_type : null,
      executionCount: Number.isSafeInteger(cell?.execution_count) ? cell.execution_count : null,
      source: String(cell?.source ?? cell?.source_preview ?? '').slice(0, 1000),
      outputs: (Array.isArray(cell?.outputs) ? cell.outputs : []).slice(0, 8).map(output => outputText(output).slice(0, 1000))
    })),
    sources,
    outputText: outputSummary,
    kernelAlive: kernel.alive === true,
    readOnly: snapshot.readOnly === true || snapshot.readOnlySnapshot === true,
    path: typeof snapshot.path === 'string' ? snapshot.path : null,
    dirty: snapshot.dirty === true
  }
}

const fail = message => {
  throw new Error(message)
}

/**
 * 与真实 HTTP 响应直接绑定；任何缺少 200/403、仍存活 kernel 或含 42 的证据都视为失败。
 */
export const validateHttpProbeResult = result => {
  if (!isRecord(result)) fail('HTTP probe 结果缺失')
  const get = result.get
  if (!isRecord(get)) fail('HTTP get 结果缺失')
  if (get.status !== 200) fail(`get 应为 200，实际 ${String(get.status)}`)
  if (get.cells !== 2) fail(`get cells 应为 2，实际 ${String(get.cells)}`)
  if (get.kernelAlive !== false) fail('get kernelAlive 应为 false')
  if (String(get.outputText ?? '').includes('42') !== true) fail('get 缺少实际 IPython 输出 42')
  for (const name of ['unknownSession', 'run', 'edit', 'save']) {
    if (result[name]?.status !== 403) fail(`${name} 应为 403，实际 ${String(result[name]?.status)}`)
  }
  if (result.activeKernels?.status !== 200) fail('activeKernels 应为 200')
  if (result.activeKernels?.count !== 0) fail('activeKernels 应为 0，拒绝把旧 child session 当作活 kernel')
  return result
}

export const readJson = file => JSON.parse(readFileSync(file, 'utf8'))

export const writeDurable = (file, value, mode = 0o600) => {
  const fd = openSync(file, 'w', mode)
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export const sha256File = file => createHash('sha256').update(readFileSync(file)).digest('hex')

const listFiles = root => {
  const files = []
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules'
        || entry.name === '.git'
        || entry.name === '.agents'
        || entry.name === '.sandbox'
        || entry.name === 'var'
        || entry.name === 'release-artifacts') continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  walk(root)
  return files.sort()
}

/**
 * 对相对路径和字节一起摘要，避免仅比较文件名掩盖内容变化。
 */
export const sha256Tree = root => {
  const digest = createHash('sha256')
  for (const file of listFiles(root)) {
    digest.update(relative(root, file).split(sep).join('/'))
    digest.update('\0')
    digest.update(readFileSync(file))
    digest.update('\0')
  }
  return digest.digest('hex')
}

export const sha256Files = (root, files) => {
  const digest = createHash('sha256')
  for (const file of [...files].sort()) {
    digest.update(file)
    digest.update('\0')
    digest.update(readFileSync(join(root, file)))
    digest.update('\0')
  }
  return digest.digest('hex')
}

const packageRelative = (root, path, label) => {
  const resolved = resolve(root, path)
  const rel = relative(root, resolved)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} 路径越界: ${path}`)
  }
  return { resolved, relative: rel.split(sep).join('/') }
}

const resolveLocalRuntimeFile = (root, fromFile, specifier) => {
  const base = resolve(dirname(fromFile), specifier)
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.json`,
    join(base, 'index.js'),
    join(base, 'index.mjs'),
    join(base, 'index.cjs')
  ]
  return candidates
    .filter(candidate => {
      const rel = relative(root, candidate)
      return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
    })
    .find(candidate => existsSync(candidate) && lstatSync(candidate).isFile())
}

const localSpecifiers = source => {
  const result = []
  const pattern = /(?:from\s*|import\s*|import\s*\(\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g
  for (const match of source.matchAll(pattern)) result.push(match[1])
  return result
}

const exportTargets = value => {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(exportTargets)
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(exportTargets)
  return []
}

const expandPackagePattern = (root, pattern) => {
  const parts = pattern.replace(/^\.\//, '').split('/')
  if (parts.some(part => part === '' || part === '..')) throw new Error(`exports 路径越界: ${pattern}`)
  const walk = (current, index) => {
    if (index >= parts.length) return existsSync(current) && lstatSync(current).isFile() ? [current] : []
    const part = parts[index]
    if (!part.includes('*')) return walk(join(current, part), index + 1)
    const expression = new RegExp(`^${part.split('*').map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
    return readdirSync(current, { withFileTypes: true })
      .filter(entry => expression.test(entry.name))
      .flatMap(entry => walk(join(current, entry.name), index + 1))
  }
  return walk(root, 0)
}

/**
 * exact package 没有 src/.git 时，以 manifest 入口、bundle patches 和本地 import
 * 闭包证明实际运行所需文件；digest 对相对路径与字节共同计算。
 */
export const collectLocalRuntimeClosure = root => {
  const packageFile = join(root, 'package.json')
  const manifest = JSON.parse(readFileSync(packageFile, 'utf8'))
  const exportValue = manifest?.exports?.['.'] ?? manifest?.exports
  const entry = typeof exportValue === 'string'
    ? exportValue
    : typeof exportValue?.import === 'string'
      ? exportValue.import
      : typeof manifest?.main === 'string'
        ? manifest.main
        : undefined
  if (typeof entry !== 'string') throw new Error('exact Swarm package 缺少 ESM main/export 入口')
  const entryFile = packageRelative(root, entry, 'exact Swarm 入口')
  if (!existsSync(entryFile.resolved) || !lstatSync(entryFile.resolved).isFile()) throw new Error(`exact Swarm 入口不存在: ${entry}`)

  const patchValue = manifest?.dsh?.bundle?.patch
  const patches = (Array.isArray(patchValue) ? patchValue : [patchValue])
    .filter(value => typeof value === 'string')
    .map(value => packageRelative(root, value, 'bundle patch'))
  for (const patch of patches) {
    if (!existsSync(patch.resolved) || !lstatSync(patch.resolved).isFile()) throw new Error(`bundle patch 不存在: ${patch.relative}`)
  }
  const exportedFiles = exportTargets(manifest?.exports)
    .flatMap(target => target.includes('*') ? expandPackagePattern(root, target) : [packageRelative(root, target, 'exports').resolved])
    .map(file => relative(root, file).split(sep).join('/'))
  const files = new Set(['package.json', entryFile.relative, ...patches.map(patch => patch.relative), ...exportedFiles])
  const queue = [entryFile.resolved]
  const visited = new Set()
  while (queue.length > 0) {
    const file = queue.shift()
    if (visited.has(file)) continue
    visited.add(file)
    if (!existsSync(file) || !lstatSync(file).isFile()) throw new Error(`runtime closure 文件不存在: ${file}`)
    if (!/\.(?:m?js|cjs)$/.test(file)) continue
    const source = readFileSync(file, 'utf8')
    for (const specifier of localSpecifiers(source)) {
      const resolved = resolveLocalRuntimeFile(root, file, specifier)
      if (resolved === undefined) throw new Error(`精确包 runtime import 无法解析: file=${file} specifier=${specifier}`)
      files.add(relative(root, resolved).split(sep).join('/'))
      queue.push(resolved)
    }
  }
  const sorted = [...files].sort()
  return {
    mode: 'package',
    entry: entryFile.relative,
    files: sorted,
    digest: sha256Files(root, sorted)
  }
}

const readProc = (path, encoding = 'utf8') => {
  try {
    return readFileSync(path, encoding)
  } catch {
    return undefined
  }
}

const getStartTicks = stat => {
  if (stat === undefined) return undefined
  const close = stat.lastIndexOf(')')
  if (close < 0) return undefined
  return stat.slice(close + 2).trim().split(/\s+/)[19]
}

/**
 * 只读取当前可见进程身份；调用方仍需用启动前后差集和自身 PGID 证明所有权。
 */
export const captureProcessTable = () => {
  const entries = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    const root = `/proc/${name}`
    const cmdlineRaw = readProc(`${root}/cmdline`, 'utf8')
    if (cmdlineRaw === undefined) continue
    const command = cmdlineRaw.split('\0').filter(Boolean).slice(0, 64)
    const stat = readProc(`${root}/stat`, 'utf8')
    const fields = stat === undefined ? [] : stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    entries.push({
      pid: Number(name),
      ppid: fields.length > 1 ? Number(fields[1]) : null,
      pgrp: fields.length > 2 ? Number(fields[2]) : null,
      startTicks: getStartTicks(stat),
      cwd: (() => {
        try {
          return readlinkSync(`${root}/cwd`)
        } catch {
          return undefined
        }
      })(),
      command
    })
  }
  return entries
}

const within = (root, target) => {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(`..${sep}`)
}

/**
 * 仅保留 cwd 或 argv 明确落在本次 scratch/candidate 内的进程事实。
 */
export const captureScopedProcesses = roots => captureProcessTable()
  .filter(entry => roots.some(root => entry.cwd !== undefined && within(root, entry.cwd))
    || entry.command.some(arg => roots.some(root => arg.includes(root))))
  .sort((left, right) => left.pid - right.pid)

export const getProcessIdentity = pid => {
  const root = `/proc/${pid}`
  const stat = readProc(`${root}/stat`, 'utf8')
  if (stat === undefined) return undefined
  return {
    pid,
    stat,
    startTicks: getStartTicks(stat),
    cwd: (() => {
      try {
        return readlinkSync(`${root}/cwd`)
      } catch {
        return undefined
      }
    })(),
    command: (() => {
      const raw = readProc(`${root}/cmdline`, 'utf8')
      return raw === undefined ? [] : raw.split('\0').filter(Boolean).slice(0, 64)
    })()
  }
}

export const waitFor = async (check, timeoutMs, intervalMs = 100) => {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() <= deadline) {
    try {
      const value = await check()
      if (value !== undefined && value !== null && value !== false) return value
    } catch (error) {
      lastError = error
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, intervalMs))
  }
  if (lastError !== undefined) throw lastError
  throw new Error(`等待超时 ${timeoutMs}ms`)
}

export const getCanonicalPath = path => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

