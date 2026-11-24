#!/usr/bin/env node

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { lstat, readFile } from 'node:fs/promises'

const DEFAULT_IMAGE = 'dsh-swarm-runtime:3.4.2'
const DEFAULT_TOTAL_CAPACITY = 4
const DEFAULT_PER_SCOPE_CAPACITY = 2

const usage = `用法: node scripts/swarm-execution-daemon.mjs [选项]

  --runtime-dir <path>         daemon 私有目录，默认 ~/.dsh/swarm-execution/v3.4.2-alpha2
  --state-file <path>          kernel 注册表，默认 <runtime-dir>/state.json
  --image <name>               容器镜像，默认 ${DEFAULT_IMAGE}
  --total-capacity <n>         全局 kernel 容量，默认 ${DEFAULT_TOTAL_CAPACITY}
  --per-scope-capacity <n>     project+owner 容量，默认 ${DEFAULT_PER_SCOPE_CAPACITY}
  --lease-ms <n>               默认租约，默认 120000
  --wall-clock-ms <n>          cell 墙钟上限，默认 30000
  --credentials-file <path>    可选，0600 JSON；格式为 {"grants": [...]}
  --capabilities-only          只探测 Docker/image/microVM 能力后退出
  --remove-kernels-on-exit     daemon 正常退出时删除自己标签的容器，默认保留
  --warm-project <id>          可选预热 scope 的 projectId
  --warm-owner <id>            可选预热 scope 的 ownerId
  --warm-languages <list>      预热语言，逗号分隔，默认 python,node
  --warm-count <n>             每个语言预热数量，默认 1
  --help                       显示帮助`

const parseInteger = (value, name, minimum, maximum = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} 必须是 ${minimum}-${maximum} 的整数`)
  }
  return parsed
}

const parseArgs = argv => {
  const result = {
    runtimeDirectory: join(homedir(), '.dsh', 'swarm-execution', 'v3.4.2-alpha2'),
    stateFile: undefined,
    image: DEFAULT_IMAGE,
    totalCapacity: DEFAULT_TOTAL_CAPACITY,
    perScopeCapacity: DEFAULT_PER_SCOPE_CAPACITY,
    leaseMs: 120_000,
    wallClockMs: 30_000,
    credentialsFile: undefined,
    capabilitiesOnly: false,
    removeKernelsOnExit: false,
    warmProject: undefined,
    warmOwner: undefined,
    warmLanguages: ['python', 'node'],
    warmCount: 1
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const equalsIndex = argument.startsWith('--') ? argument.indexOf('=') : -1
    const option = equalsIndex > 0 ? argument.slice(0, equalsIndex) : argument
    const inlineValue = equalsIndex > 0 ? argument.slice(equalsIndex + 1) : undefined
    const next = () => {
      if (inlineValue !== undefined) {
        if (inlineValue === '') throw new Error(`${option} 缺少参数`)
        return inlineValue
      }
      index += 1
      if (index >= argv.length) throw new Error(`${option} 缺少参数`)
      return argv[index]
    }
    const rejectInlineValue = () => {
      if (inlineValue !== undefined) throw new Error(`${option} 不接受参数`)
    }
    switch (option) {
      case '--runtime-dir': result.runtimeDirectory = resolve(next()); break
      case '--state-file': result.stateFile = resolve(next()); break
      case '--image': result.image = next(); break
      case '--total-capacity': result.totalCapacity = parseInteger(next(), '--total-capacity', 1, 32); break
      case '--per-scope-capacity': result.perScopeCapacity = parseInteger(next(), '--per-scope-capacity', 1, 8); break
      case '--lease-ms': result.leaseMs = parseInteger(next(), '--lease-ms', 1_000, 15 * 60_000); break
      case '--wall-clock-ms': result.wallClockMs = parseInteger(next(), '--wall-clock-ms', 100, 5 * 60_000); break
      case '--credentials-file': result.credentialsFile = resolve(next()); break
      case '--capabilities-only': rejectInlineValue(); result.capabilitiesOnly = true; break
      case '--remove-kernels-on-exit': rejectInlineValue(); result.removeKernelsOnExit = true; break
      case '--warm-project': result.warmProject = next(); break
      case '--warm-owner': result.warmOwner = next(); break
      case '--warm-languages': result.warmLanguages = next().split(',').filter(Boolean); break
      case '--warm-count': result.warmCount = parseInteger(next(), '--warm-count', 1, 8); break
      case '--help': rejectInlineValue(); process.stdout.write(`${usage}\n`); process.exit(0); break
      default: throw new Error(`未知参数: ${option}`)
    }
  }
  if (result.perScopeCapacity > result.totalCapacity) throw new Error('--per-scope-capacity 不能大于 --total-capacity')
  if (result.warmLanguages.some(language => language !== 'python' && language !== 'node')) {
    throw new Error('--warm-languages 只支持 python,node')
  }
  if ((result.warmProject === undefined) !== (result.warmOwner === undefined)) {
    throw new Error('--warm-project 与 --warm-owner 必须同时提供')
  }
  result.stateFile ??= join(result.runtimeDirectory, 'state.json')
  return result
}

const log = (level, message, context = {}) => {
  const stream = level === 'error' ? process.stderr : process.stdout
  stream.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...context })}\n`)
}

const loadCompiledModule = async name => {
  const url = new URL(`../lib/execution/${name}.js`, import.meta.url)
  try {
    return await import(url)
  } catch (error) {
    throw new Error(`无法加载 ${url.pathname}，请先在仓库执行 npm run build`, { cause: error })
  }
}

const loadCredentials = async path => {
  if (path === undefined) return []
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('--credentials-file 必须是普通文件，不能是 symlink')
  if ((info.mode & 0o077) !== 0) throw new Error('--credentials-file 必须仅 owner 可读写，建议 chmod 600')
  const decoded = JSON.parse(await readFile(path, 'utf8'))
  if (Array.isArray(decoded)) return decoded
  if (decoded && typeof decoded === 'object' && Array.isArray(decoded.grants)) return decoded.grants
  throw new Error('--credentials-file 格式必须是 grants 数组或 {"grants": [...]}')
}

const probeCapabilities = async (runner, image) => {
  const [dockerVersion, imageInfo, { detectMicroVmCapability }] = await Promise.all([
    runner.run({ command: 'docker', args: ['version', '--format', '{{.Server.Version}}'], timeoutMs: 10_000 }),
    runner.run({ command: 'docker', args: ['image', 'inspect', image, '--format', '{{.Id}}'], timeoutMs: 10_000 }),
    loadCompiledModule('microvm-runtime')
  ])
  const microvm = await detectMicroVmCapability()
  const available = dockerVersion.exitCode === 0 && imageInfo.exitCode === 0
  return {
    container: {
      available,
      engine: 'docker',
      ...(dockerVersion.exitCode === 0 ? { version: dockerVersion.stdout.trim() } : { reason: dockerVersion.stderr.trim() }),
      image,
      ...(imageInfo.exitCode === 0 ? { imageId: imageInfo.stdout.trim() } : { imageReason: imageInfo.stderr.trim() }),
      isolation: {
        network: 'none',
        rootFilesystem: 'read-only',
        capabilities: 'drop-ALL',
        credentialsFromHostEnvironment: false
      }
    },
    microvm
  }
}

const options = parseArgs(process.argv.slice(2))
const [{ createExecutionPool }, { DockerExecutionRuntime, DockerSpawnCommandRunner }, { CredentialBroker }, { createExecutionDaemon }] = await Promise.all([
  loadCompiledModule('pool'),
  loadCompiledModule('docker-runtime'),
  loadCompiledModule('credential-broker'),
  loadCompiledModule('daemon')
])
const runner = new DockerSpawnCommandRunner('docker')
const capabilities = await probeCapabilities(runner, options.image)
log('info', 'execution capabilities', capabilities)
if (options.capabilitiesOnly) {
  if (!capabilities.container.available) process.exitCode = 1
  process.exit()
}
if (!capabilities.container.available) throw new Error('Docker 或指定镜像不可用，拒绝启动 execution daemon')

const credentials = await loadCredentials(options.credentialsFile)
const proxyDirectory = join(options.runtimeDirectory, 'proxy')
const runtime = new DockerExecutionRuntime({
  image: options.image,
  runner,
  proxySocketDirectory: proxyDirectory
})
const pool = await createExecutionPool({
  runtime,
  statePath: options.stateFile,
  totalCapacity: options.totalCapacity,
  perScopeCapacity: options.perScopeCapacity,
  defaultLeaseMs: options.leaseMs,
  maxLeaseMs: Math.max(options.leaseMs, 15 * 60_000),
  defaultWallClockMs: Math.min(options.wallClockMs, 30_000),
  maxWallClockMs: options.wallClockMs,
  clock: () => Date.now()
})
const credentialBroker = new CredentialBroker({ clock: () => Date.now(), fetchImpl: fetch, grants: credentials })
const daemon = createExecutionDaemon({
  runtimeDirectory: options.runtimeDirectory,
  pool,
  credentialBroker,
  capabilities: async () => capabilities,
  logger: {
    info: (message, context) => log('info', message, context),
    error: (message, context) => log('error', message, context)
  }
})
const paths = await daemon.start()
log('info', 'execution daemon ready', paths)

if (options.warmProject !== undefined && options.warmOwner !== undefined) {
  for (const language of options.warmLanguages) {
    const warmed = await pool.warm({
      scope: { projectId: options.warmProject, ownerId: options.warmOwner },
      language,
      count: options.warmCount
    })
    log('info', 'execution warm pool ready', {
      projectId: options.warmProject,
      ownerId: options.warmOwner,
      language,
      kernelIds: warmed.map(kernel => kernel.kernelId)
    })
  }
}

let isClosing = false
const close = async signal => {
  if (isClosing) return
  isClosing = true
  log('info', 'execution daemon stopping', { signal, removeKernels: options.removeKernelsOnExit })
  try {
    await daemon.close({ removeKernels: options.removeKernelsOnExit })
  } catch (error) {
    log('error', 'execution daemon close failed', { message: error instanceof Error ? error.message : String(error) })
    process.exitCode = 1
  }
}
process.once('SIGTERM', () => { void close('SIGTERM').then(() => process.exit()) })
process.once('SIGINT', () => { void close('SIGINT').then(() => process.exit()) })
