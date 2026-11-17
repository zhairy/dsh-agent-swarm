#!/usr/bin/env node
/**
 * 从固定 v3.4.0 兼容归档模板和精确 Notebook tgz 重建 v3.4.1 兼容包。
 *
 * 该入口只生成可复验的本地兼容产物，不安装、不发布、不修改活动 profile。
 * 所有解包、补丁往返和最终归档复核都在独立临时目录完成，验证通过后才落盘。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const CURRENT_VERIFIER = join(REPOSITORY_ROOT, 'scripts/verify-release-compat.mjs')
const COMPAT_DOCUMENT = join(REPOSITORY_ROOT, 'docs/3.4.1-第三方插件与兼容包.md')
const BASE_ROOT = 'dsh-agent-swarm-3.4.0-rc3-compat'
const HOST_VERSION = '0.2.2-rc.3'
const COMPONENT_IDS = ['notebook', 'subscriptions', 'rigorquant', 'opencode-go', 'calculator', 'opencode-live']
const PRESERVED_COMPONENT_IDS = ['rigorquant', 'opencode-go', 'calculator', 'opencode-live']
const REQUIRED_OPTIONS = [
  '--version',
  '--base-archive',
  '--base-sha256',
  '--notebook-tarball',
  '--notebook-sha256',
  '--notebook-original',
  '--subscriptions-original',
  '--sdk',
  '--out',
]
const SHA256_PATTERN = /^[a-f0-9]{64}$/

const SAFE_TAR_EXTRACTOR = String.raw`
import json
import os
import posixpath
import sys
import tarfile

FORBIDDEN_SEGMENTS = {".git", "__pycache__", "node_modules"}
CREDENTIAL_NAMES = {
    ".git-credentials",
    ".netrc",
    ".npmrc",
    ".pypirc",
    "credentials.json",
    "id_ed25519",
    "id_rsa",
}

def forbidden_reason(path):
    parts = [part for part in path.split("/") if part]
    lowered = [part.lower() for part in parts]
    if any(part in FORBIDDEN_SEGMENTS for part in lowered):
        return "归档包含禁止路径: node_modules/.git/__pycache__"
    if any(part in {"log", "logs"} or part.endswith(".log") for part in lowered):
        return "归档包含禁止日志"
    for part in lowered:
        if part in CREDENTIAL_NAMES or part.startswith("cookie") or part.startswith("token"):
            return "归档包含禁止凭据"
        if part == ".env" or part.startswith(".env.") and not part.endswith((".example", ".sample", ".template")):
            return "归档包含禁止凭据"
        if part.endswith((".key", ".pem")):
            return "归档包含禁止凭据"
    return None

spec = json.loads(sys.stdin.read())
archive_path = spec["archive"]
destination = spec["destination"]
seen = set()
total_size = 0
with tarfile.open(archive_path, "r:gz") as archive:
    members = archive.getmembers()
    if len(members) > 50000:
        raise ValueError("归档成员数量超过限制")
    for member in members:
        raw = member.name
        normalized = raw[:-1] if member.isdir() and raw.endswith("/") else raw
        if not normalized or "\x00" in normalized or "\\" in normalized or normalized.startswith("/"):
            raise ValueError("归档路径非法: " + raw)
        canonical = posixpath.normpath(normalized)
        if canonical != normalized or any(part in {"", ".", ".."} for part in normalized.split("/")):
            raise ValueError("归档路径非法: " + raw)
        if member.issym():
            raise ValueError("归档不接受 symlink: " + raw)
        if member.islnk():
            raise ValueError("归档不接受 hardlink: " + raw)
        if not member.isfile() and not member.isdir():
            raise ValueError("归档只接受普通文件和目录: " + raw)
        reason = forbidden_reason(normalized)
        if reason:
            raise ValueError(reason + ": " + raw)
        identity = normalized
        if identity in seen:
            raise ValueError("归档包含重复路径: " + raw)
        seen.add(identity)
        if member.isfile():
            total_size += member.size
            if total_size > 512 * 1024 * 1024:
                raise ValueError("归档展开大小超过限制")
    os.makedirs(destination, exist_ok=False)
    archive.extractall(destination, members=members, filter="data")
`

const sortStrings = values => [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
const sortNames = (left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0

const sha256 = value => createHash('sha256').update(value).digest('hex')

const fileSha256 = path => sha256(readFileSync(path))

const writeText = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

const writeJson = (path, value) => writeText(path, `${JSON.stringify(value, null, 2)}\n`)

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

const forbiddenPathReason = path => {
  const parts = path.split('/').filter(Boolean)
  const lowered = parts.map(part => part.toLowerCase())
  if (lowered.some(part => ['.git', '__pycache__', 'node_modules'].includes(part))) return 'node_modules/.git/__pycache__'
  if (lowered.some(part => part === 'log' || part === 'logs' || part.endsWith('.log'))) return '日志'
  const credentialNames = new Set(['.git-credentials', '.netrc', '.npmrc', '.pypirc', 'credentials.json', 'id_ed25519', 'id_rsa'])
  if (lowered.some(part =>
    credentialNames.has(part)
    || part.startsWith('cookie')
    || part.startsWith('token')
    || part === '.env'
    || part.startsWith('.env.') && !/\.(?:example|sample|template)$/.test(part)
    || /\.(?:key|pem)$/.test(part))) return '凭据'
  return undefined
}

const validateRelativePath = path => {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || path.includes('\\') || isAbsolute(path)) {
    throw new Error(`归档路径非法: ${path}`)
  }
  const normalized = path.endsWith('/') ? path.slice(0, -1) : path
  if (normalized.split('/').some(part => part === '' || part === '.' || part === '..')) throw new Error(`归档路径非法: ${path}`)
  const forbidden = forbiddenPathReason(normalized)
  if (forbidden !== undefined) throw new Error(`归档包含禁止${forbidden}: ${path}`)
  return normalized
}

const assertArchiveFile = path => {
  const absolute = resolve(path)
  const stat = lstatSync(absolute)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`归档不是普通文件: ${absolute}`)
  if (stat.nlink > 1) throw new Error(`归档不接受 hardlink: ${absolute}`)
  return realpathSync(absolute)
}

const assertDirectory = path => {
  const absolute = resolve(path)
  const stat = lstatSync(absolute)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`输入不是普通目录: ${absolute}`)
  return realpathSync(absolute)
}

const assertDigest = (path, expected, label) => {
  const actual = fileSha256(path)
  if (actual !== expected) throw new Error(`${label} SHA-256 不匹配: expected=${expected} actual=${actual}`)
  return actual
}

const walkTree = (root, { includeDirectories = false } = {}) => {
  const files = []
  const directories = []
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(sortNames)) {
      const absolute = join(directory, entry.name)
      const rel = relative(root, absolute).split(sep).join('/')
      validateRelativePath(rel)
      const stat = lstatSync(absolute)
      if (stat.isSymbolicLink()) throw new Error(`输入不接受符号链接: ${rel}`)
      if (stat.isDirectory()) {
        directories.push(rel)
        visit(absolute)
      } else if (stat.isFile()) {
        if (stat.nlink > 1) throw new Error(`输入不接受 hardlink: ${rel}`)
        files.push(rel)
      } else throw new Error(`输入文件类型不支持: ${rel}`)
    }
  }
  visit(root)
  return { files: sortStrings(files), directories: sortStrings(directories), includeDirectories }
}

const fileMap = root => Object.fromEntries(
  walkTree(root).files.map(path => [path, fileSha256(join(root, path))]),
)

const copyTree = (source, destination) => {
  const info = walkTree(source, { includeDirectories: true })
  mkdirSync(destination, { recursive: true })
  for (const directory of sortStrings([...info.directories, ...info.files.map(file => dirname(file)).filter(directory => directory !== '.')])) {
    mkdirSync(join(destination, directory), { recursive: true })
  }
  for (const path of info.files) {
    const target = join(destination, path)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(source, path), target)
    const mode = statSync(join(source, path)).mode & 0o111 ? 0o755 : 0o644
    chmodSync(target, mode)
  }
}

const extractArchive = (archive, destination) => {
  try {
    execFileSync('python3', ['-c', SAFE_TAR_EXTRACTOR], {
      input: JSON.stringify({ archive, destination }),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch (error) {
    const details = error?.stderr?.trim() || error?.message || String(error)
    throw new Error(`安全解包失败: ${details}`)
  }
}

const onlyRoot = (root, expected) => {
  const names = readdirSync(root).sort()
  if (names.length !== 1 || names[0] !== expected) throw new Error(`归档根目录必须是 ${expected}，实际为 ${names.join(', ')}`)
  return join(root, expected)
}

const findLicense = root => {
  const candidates = readdirSync(root)
    .filter(name => /^(?:LICENSE|LICENCE|COPYING)(?:\..*)?$/i.test(name))
    .sort()
  if (candidates.length === 0) throw new Error(`组件缺少 license: ${root}`)
  const path = join(root, candidates[0])
  if (!lstatSync(path).isFile()) throw new Error(`license 不是普通文件: ${path}`)
  return path
}

const runJsonCommand = (command, args, options = {}) => {
  try {
    const stdout = execFileSync(command, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    })
    return JSON.parse(stdout)
  } catch (error) {
    const details = error?.stderr?.trim() || error?.stdout?.trim() || error?.message || String(error)
    throw new Error(details)
  }
}

const verifyRootWith = (verifier, root, sdk) => runJsonCommand(process.execPath, [verifier, '--root', root, '--sdk', sdk])

const validateBaseTemplate = (root, sdk) => {
  const manifest = readJson(join(root, 'compat-manifest.json'))
  if (manifest.schemaVersion !== 1 || manifest.release !== 'v3.4.0' || manifest.hostVersion !== HOST_VERSION) {
    throw new Error('base-archive 不是固定的 v3.4.0 / DSH 0.2.2-rc.3 兼容模板')
  }
  const ids = manifest.components.map(component => component.id)
  const expected = sortStrings(COMPONENT_IDS)
  if (JSON.stringify(sortStrings(ids)) !== JSON.stringify(expected)) throw new Error('base-archive 六组件身份不匹配')
  for (const path of ['README.zh-CN.md', 'KNOWN-ISSUES.zh-CN.md', 'plugin-inventory.json', 'tools/apply-plugin-compat.mjs']) {
    if (!existsSync(join(root, path))) throw new Error(`base-archive 缺少模板文件: ${path}`)
  }
  const verification = verifyRootWith(CURRENT_VERIFIER, root, sdk)
  return { manifest, verification }
}

const diffFile = ({ beforePath, afterPath, path }) => {
  const labels = beforePath === undefined ? ['/dev/null', `b/${path}`] : [`a/${path}`, `b/${path}`]
  const result = spawnSync('/usr/bin/diff', [
    '-u',
    '--label', labels[0],
    '--label', labels[1],
    beforePath ?? '/dev/null',
    afterPath,
  ], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status === 0) throw new Error(`补丁生成出现无差异文件: ${path}`)
  if (result.status !== 1) throw new Error(`diff 失败: ${result.stderr?.trim() || `exit=${result.status}`}`)
  return result.stdout
}

const generateCompositePatch = ({ id, originalRoot, finalRoot, stageRoot }) => {
  walkTree(originalRoot)
  const finalFiles = walkTree(finalRoot).files
  const originalPackage = readJson(join(originalRoot, 'package.json'))
  const finalPackage = readJson(join(finalRoot, 'package.json'))
  if (originalPackage.name !== finalPackage.name) throw new Error(`${id} baseline 包名不匹配`)
  const rows = []
  const chunks = []
  for (const path of finalFiles) {
    const originalPath = join(originalRoot, path)
    const finalPath = join(finalRoot, path)
    const originalBytes = existsSync(originalPath) ? readFileSync(originalPath) : undefined
    const finalBytes = readFileSync(finalPath)
    if (originalBytes !== undefined && originalBytes.equals(finalBytes)) continue
    if ((originalBytes?.includes(0) ?? false) || finalBytes.includes(0)) throw new Error(`${id} 的二进制变更无法生成文本 composite patch: ${path}`)
    const diff = diffFile({
      beforePath: originalBytes === undefined ? undefined : originalPath,
      afterPath: finalPath,
      path,
    })
    chunks.push(diff.endsWith('\n') ? diff : `${diff}\n`)
    rows.push({
      path,
      beforeSha256: originalBytes === undefined ? null : sha256(originalBytes),
      afterSha256: sha256(finalBytes),
    })
  }
  if (rows.length === 0) throw new Error(`${id} 的 baseline 与最终组件没有差异`)
  if (rows.length > 64) throw new Error(`${id} composite patch 超过 apply-plugin-compat 的 64 文件上限`)
  const patch = chunks.join('')
  const patchDirectory = join(stageRoot, 'patches')
  const patchName = `${id}.patch`
  const manifestName = `${id}.json`
  writeText(join(patchDirectory, patchName), patch)
  const plan = {
    schemaVersion: 1,
    packageName: finalPackage.name,
    baseVersion: originalPackage.version.split('+')[0],
    patch: patchName,
    patchSha256: sha256(patch),
    files: rows,
    baseline: `npm:${finalPackage.name}@${originalPackage.version.split('+')[0]}`,
  }
  writeJson(join(patchDirectory, manifestName), plan)
  return plan
}

const assertPublishedPaths = (workingRoot, finalRoot) => {
  const finalMap = fileMap(finalRoot)
  const workingMap = fileMap(workingRoot)
  for (const [path, expected] of Object.entries(finalMap)) {
    if (workingMap[path] !== expected) throw new Error(`应用补丁后发布组件路径不一致: ${path}`)
  }
}

const roundTripPatch = ({ id, originalRoot, finalRoot, stageRoot, temporaryRoot }) => {
  const workingRoot = join(temporaryRoot, 'patch-roundtrip', id)
  copyTree(originalRoot, workingRoot)
  const applyTool = join(stageRoot, 'tools/apply-plugin-compat.mjs')
  const plan = join(stageRoot, 'patches', `${id}.json`)
  const apply = runJsonCommand(process.execPath, [applyTool, '--plugin', workingRoot, '--plan', plan])
  assertPublishedPaths(workingRoot, finalRoot)
  const originalFiles = fileMap(originalRoot)
  const finalFiles = fileMap(finalRoot)
  const baselineOnly = Object.fromEntries(Object.entries(originalFiles).filter(([path]) => !Object.hasOwn(finalFiles, path)))
  const afterApply = fileMap(workingRoot)
  const baselineOnlyFilesPreserved = Object.entries(baselineOnly).every(([path, digest]) => afterApply[path] === digest)
  if (!baselineOnlyFilesPreserved) throw new Error(`${id} 应用补丁时删除了 baseline-only QA 文件`)
  const check = runJsonCommand(process.execPath, [applyTool, '--plugin', workingRoot, '--plan', plan, '--check'])
  const restore = runJsonCommand(process.execPath, [applyTool, '--plugin', workingRoot, '--plan', plan, '--restore'])
  if (JSON.stringify(fileMap(workingRoot)) !== JSON.stringify(originalFiles)) throw new Error(`${id} restore 后未回到完整 baseline bytes`)
  return {
    apply: apply.status,
    check: check.status,
    restore: restore.status,
    baselineOnlyFilesPreserved,
  }
}

const updateInventory = (stageRoot, notebookVersion) => {
  const path = join(stageRoot, 'plugin-inventory.json')
  const inventory = readJson(path)
  const notebook = inventory.plugins?.find(plugin => plugin.name === '@beihaizb/dsh-notebook')
  if (notebook === undefined) throw new Error('plugin-inventory.json 缺少 Notebook 条目')
  notebook.version = notebookVersion
  writeJson(path, inventory)
}

const writeKnownIssues = (stageRoot) => {
  const historical = readFileSync(join(stageRoot, 'KNOWN-ISSUES.zh-CN.md'), 'utf8')
    .replace(/^# .*\n/, '')
    .trimStart()
  writeText(join(stageRoot, 'KNOWN-ISSUES.zh-CN.md'), [
    '# v3.4.1 已知问题与迭代计划',
    '',
    '## v3.4.1 当前范围',
    '',
    '本版实现受控 primary/linked 规划与主树写入、显式 .ipynb 保存后的纯数据快照恢复、进程内脱敏路由观测。历史表中的版本安排是 v3.4.0 当时的计划；其中已在本版实现的条目以 v3.4.1 RELEASE-NOTES 和实际 verification-summary 为准，不代表仍需等待 3.4.2。',
    '',
    '恢复不包含活内核/变量或旧写权限；路由 trace 不跨重启持久化；未知写入/清理、未知组件字节及供应商登录/限流仍须按真实状态处理。主树 Git 保存只支持精确存在的普通文件；删除/目录递归及任意 Git 命令不开放。',
    '',
    '## v3.4.0 历史基线',
    '',
    '以下边界沿用 v3.4.0 记录，不因兼容包可重建或用例通过而宣称对应计划已经完成。3.4.1 的发布级精确 Host、真实插件与浏览器验收仍须单独执行。',
    '',
    historical,
    '',
  ].join('\n'))
}

const buildManifest = ({
  stageRoot,
  baseManifest,
  notebookVersion,
  notebookArchiveSha256,
  baseArchiveSha256,
  baseArchiveName,
}) => {
  const components = baseManifest.components.map(component => {
    const directory = join(stageRoot, component.directory)
    const packageInfo = readJson(join(directory, 'package.json'))
    if (component.id === 'notebook') {
      return {
        ...component,
        name: packageInfo.name,
        version: packageInfo.version,
        license: packageInfo.license ?? component.license,
        runtimeFilesUnchanged: false,
        originalArchiveSha256: notebookArchiveSha256,
        files: fileMap(directory),
      }
    }
    if (packageInfo.name !== component.name || packageInfo.version !== component.version) {
      throw new Error(`保留组件身份发生变化: ${component.id}`)
    }
    return { ...component, files: fileMap(directory) }
  })
  const supportFiles = {}
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(sortNames)) {
      const path = join(directory, entry.name)
      const rel = relative(stageRoot, path).split(sep).join('/')
      if (rel === 'compat-manifest.json' || rel === 'SHA256SUMS') continue
      if (rel === 'components' || rel.startsWith('components/')) continue
      if (entry.isDirectory()) visit(path)
      else supportFiles[rel] = fileSha256(path)
    }
  }
  visit(stageRoot)
  return {
    schemaVersion: 1,
    release: 'v3.4.1',
    hostVersion: HOST_VERSION,
    nodeMinimum: baseManifest.nodeMinimum,
    rebuild: {
      type: 'fixed-compat-template-plus-notebook-tarball',
      baseArchive: {
        file: baseArchiveName,
        sha256: baseArchiveSha256,
      },
      notebook: {
        version: notebookVersion,
        sha256: notebookArchiveSha256,
      },
      deterministicTar: { mtime: 0, uid: 0, gid: 0, sorted: true },
    },
    components,
    notBundled: baseManifest.notBundled ?? [],
    supportFiles: Object.fromEntries(Object.entries(supportFiles).sort(([left], [right]) => sortStrings([left, right])[0] === left ? -1 : 1)),
  }
}

const writeChecksums = root => {
  const lines = sortStrings(walkTree(root).files.filter(path => path !== 'SHA256SUMS'))
    .map(path => `${fileSha256(join(root, path))}  ${path}`)
  writeText(join(root, 'SHA256SUMS'), `${lines.join('\n')}\n`)
}

const splitTarPath = path => {
  const bytes = Buffer.byteLength(path)
  if (bytes <= 100) return { name: path, prefix: '' }
  for (let index = path.length - 1; index > 0; index--) {
    if (path[index] !== '/') continue
    const prefix = path.slice(0, index)
    const name = path.slice(index + 1)
    if (name === '') continue
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix }
  }
  throw new Error(`tar 路径超过 USTAR 限制: ${path}`)
}

const writeString = (buffer, value, offset, length) => {
  const bytes = Buffer.from(value)
  if (bytes.length > length) throw new Error(`tar 字段过长: ${value}`)
  bytes.copy(buffer, offset)
}

const writeOctal = (buffer, value, offset, length) => {
  writeString(buffer, `${value.toString(8).padStart(length - 1, '0')}\0`, offset, length)
}

const tarHeader = ({ name, mode, size, type, mtime = 0, uid = 0, gid = 0 }) => {
  const buffer = Buffer.alloc(512)
  const split = splitTarPath(name)
  writeString(buffer, split.name, 0, 100)
  writeOctal(buffer, mode, 100, 8)
  writeOctal(buffer, uid, 108, 8)
  writeOctal(buffer, gid, 116, 8)
  writeOctal(buffer, size, 124, 12)
  writeOctal(buffer, mtime, 136, 12)
  buffer.fill(0x20, 148, 156)
  writeString(buffer, type, 156, 1)
  writeString(buffer, 'ustar\0', 257, 6)
  writeString(buffer, '00', 263, 2)
  writeString(buffer, split.prefix, 345, 155)
  const checksum = buffer.reduce((total, byte) => total + byte, 0)
  writeString(buffer, `${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  return buffer
}

const deterministicArchive = (sourceRoot, rootName) => {
  const parts = []
  const addHeader = (record, content) => {
    parts.push(tarHeader(record))
    if (content !== undefined) {
      parts.push(content)
      const padding = (512 - content.length % 512) % 512
      if (padding > 0) parts.push(Buffer.alloc(padding))
    }
  }
  addHeader({ name: `${rootName}/`, mode: 0o755, size: 0, type: '5' })
  const { files, directories } = walkTree(sourceRoot, { includeDirectories: true })
  const records = [
    ...directories.map(path => ({
      name: `${rootName}/${path}/`,
      sortName: `${rootName}/${path}`,
      mode: 0o755,
      size: 0,
      type: '5',
      path,
    })),
    ...files.map(path => {
      const bytes = readFileSync(join(sourceRoot, path))
      const mode = statSync(join(sourceRoot, path)).mode & 0o111 ? 0o755 : 0o644
      return {
        name: `${rootName}/${path}`,
        sortName: `${rootName}/${path}`,
        mode,
        size: bytes.length,
        type: '0',
        path,
        bytes,
      }
    }),
  ].sort((left, right) => left.sortName < right.sortName ? -1 : left.sortName > right.sortName ? 1 : 0)
  for (const record of records) addHeader(record, record.bytes)
  parts.push(Buffer.alloc(1024))
  let tar = Buffer.concat(parts)
  const remainder = tar.length % 10240
  if (remainder !== 0) tar = Buffer.concat([tar, Buffer.alloc(10240 - remainder)])
  const gzip = gzipSync(tar, { level: 9 })
  gzip.writeUInt32LE(0, 4)
  return gzip
}

const assertPreservedComponents = (root, expectedMaps) => {
  for (const id of PRESERVED_COMPONENT_IDS) {
    const actual = fileMap(join(root, 'components', id))
    if (JSON.stringify(actual) !== JSON.stringify(expectedMaps[id])) throw new Error(`保留组件字节发生变化: ${id}`)
  }
}

const publishOutputs = ({ out, archiveName, archiveBytes, manifestBytes }) => {
  const archivePath = join(out, archiveName)
  const manifestPath = join(out, 'third-party-manifest.json')
  if (existsSync(archivePath) || existsSync(manifestPath)) throw new Error('输出产物已存在，拒绝覆盖')
  mkdirSync(out, { recursive: true })
  let archiveWritten = false
  try {
    writeFileSync(archivePath, archiveBytes, { flag: 'wx', mode: 0o644 })
    archiveWritten = true
    writeFileSync(manifestPath, manifestBytes, { flag: 'wx', mode: 0o644 })
  } catch (error) {
    if (archiveWritten) rmSync(archivePath, { force: true })
    if (existsSync(manifestPath)) rmSync(manifestPath, { force: true })
    throw error
  }
  return { archivePath, manifestPath }
}

export const ParseBuildCompatOptions = (args, cwd = process.cwd()) => {
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    if (!REQUIRED_OPTIONS.includes(name)) throw new Error(`未知参数: ${name}`)
    if (Object.hasOwn(options, name)) throw new Error(`参数重复: ${name}`)
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`参数缺少值: ${name}`)
    options[name] = value
  }
  for (const name of REQUIRED_OPTIONS) {
    if (!Object.hasOwn(options, name)) throw new Error(`缺少参数: ${name}`)
  }
  if (!/^\d+\.\d+\.\d+$/.test(options['--version'])) throw new Error('--version 必须是 x.y.z')
  for (const name of ['--base-sha256', '--notebook-sha256']) {
    if (!SHA256_PATTERN.test(options[name])) throw new Error(`${name} 必须是 64 位小写 SHA-256`)
  }
  return {
    version: options['--version'],
    baseArchive: resolve(cwd, options['--base-archive']),
    baseSha256: options['--base-sha256'],
    notebookTarball: resolve(cwd, options['--notebook-tarball']),
    notebookSha256: options['--notebook-sha256'],
    notebookOriginal: resolve(cwd, options['--notebook-original']),
    subscriptionsOriginal: resolve(cwd, options['--subscriptions-original']),
    sdk: resolve(cwd, options['--sdk']),
    out: resolve(cwd, options['--out']),
  }
}

export const BuildReleaseCompat = options => {
  const version = options.version
  const archiveName = `dsh-agent-swarm-${version}-dsh-${HOST_VERSION}-compat.tar.gz`
  const artifactRoot = `dsh-agent-swarm-${version}-rc3-compat`
  const archivePath = join(options.out, archiveName)
  const manifestPath = join(options.out, 'third-party-manifest.json')
  if (existsSync(archivePath) || existsSync(manifestPath)) throw new Error('输出产物已存在，拒绝覆盖')

  const baseArchive = assertArchiveFile(options.baseArchive)
  const notebookArchive = assertArchiveFile(options.notebookTarball)
  const notebookOriginal = assertDirectory(options.notebookOriginal)
  const subscriptionsOriginal = assertDirectory(options.subscriptionsOriginal)
  const sdk = assertDirectory(options.sdk)
  assertDigest(baseArchive, options.baseSha256, 'base-archive')
  assertDigest(notebookArchive, options.notebookSha256, 'notebook-tarball')

  const temporaryRoot = mkdtempSync(join(tmpdir(), 'swarm-build-compat-'))
  try {
    const baseExtraction = join(temporaryRoot, 'base')
    const notebookExtraction = join(temporaryRoot, 'notebook')
    extractArchive(baseArchive, baseExtraction)
    extractArchive(notebookArchive, notebookExtraction)
    const stageRoot = onlyRoot(baseExtraction, BASE_ROOT)
    const notebookSource = onlyRoot(notebookExtraction, 'package')
    findLicense(notebookSource)
    const notebookPackage = readJson(join(notebookSource, 'package.json'))
    if (notebookPackage.name !== '@beihaizb/dsh-notebook' || typeof notebookPackage.version !== 'string') {
      throw new Error('Notebook tgz 包名或版本无效')
    }
    const notebookVersion = notebookPackage.version

    const { manifest: baseManifest, verification: baseVerification } = validateBaseTemplate(stageRoot, sdk)
    const preservedMaps = Object.fromEntries(PRESERVED_COMPONENT_IDS.map(id => [
      id,
      fileMap(join(stageRoot, 'components', id)),
    ]))

    rmSync(join(stageRoot, 'components/notebook'), { recursive: true, force: true })
    copyTree(notebookSource, join(stageRoot, 'components/notebook'))
    const notebookLicense = findLicense(join(stageRoot, 'components/notebook'))
    copyFileSync(notebookLicense, join(stageRoot, 'licenses/notebook-LICENSE'))
    const subscriptionsLicense = findLicense(join(stageRoot, 'components/subscriptions'))
    copyFileSync(subscriptionsLicense, join(stageRoot, 'licenses/subscriptions-LICENSE'))

    copyFileSync(CURRENT_VERIFIER, join(stageRoot, 'tools/verify-compat.mjs'))
    copyFileSync(COMPAT_DOCUMENT, join(stageRoot, 'README.zh-CN.md'))
    updateInventory(stageRoot, notebookVersion)
    writeKnownIssues(stageRoot)

    const notebookPlan = generateCompositePatch({
      id: 'notebook',
      originalRoot: notebookOriginal,
      finalRoot: join(stageRoot, 'components/notebook'),
      stageRoot,
    })
    const subscriptionsPlan = generateCompositePatch({
      id: 'subscriptions',
      originalRoot: subscriptionsOriginal,
      finalRoot: join(stageRoot, 'components/subscriptions'),
      stageRoot,
    })
    const notebookRoundtrip = roundTripPatch({
      id: 'notebook',
      originalRoot: notebookOriginal,
      finalRoot: join(stageRoot, 'components/notebook'),
      stageRoot,
      temporaryRoot,
    })
    const subscriptionsRoundtrip = roundTripPatch({
      id: 'subscriptions',
      originalRoot: subscriptionsOriginal,
      finalRoot: join(stageRoot, 'components/subscriptions'),
      stageRoot,
      temporaryRoot,
    })

    const manifest = buildManifest({
      stageRoot,
      baseManifest,
      notebookVersion,
      notebookArchiveSha256: options.notebookSha256,
      baseArchiveSha256: options.baseSha256,
      baseArchiveName: basename(baseArchive),
    })
    writeJson(join(stageRoot, 'compat-manifest.json'), manifest)
    writeChecksums(stageRoot)

    const stageVerification = verifyRootWith(CURRENT_VERIFIER, stageRoot, sdk)
    assertPreservedComponents(stageRoot, preservedMaps)
    const archiveBytes = deterministicArchive(stageRoot, artifactRoot)
    const stagedArchive = join(temporaryRoot, archiveName)
    writeFileSync(stagedArchive, archiveBytes, { mode: 0o644 })

    const packageExtraction = join(temporaryRoot, 'package-verification')
    extractArchive(stagedArchive, packageExtraction)
    const packagedRoot = onlyRoot(packageExtraction, artifactRoot)
    const packagedVerification = verifyRootWith(join(packagedRoot, 'tools/verify-compat.mjs'), packagedRoot, sdk)
    execFileSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: packagedRoot, stdio: 'pipe' })
    assertPreservedComponents(packagedRoot, preservedMaps)
    const internalManifestBytes = readFileSync(join(stageRoot, 'compat-manifest.json'))
    if (!internalManifestBytes.equals(readFileSync(join(packagedRoot, 'compat-manifest.json')))) {
      throw new Error('打包后 compat-manifest.json 字节发生变化')
    }

    const published = publishOutputs({
      out: options.out,
      archiveName,
      archiveBytes,
      manifestBytes: internalManifestBytes,
    })
    return {
      releaseReady: false,
      version,
      artifactRoot,
      tarball: published.archivePath,
      tarballBytes: archiveBytes.length,
      tarballSha256: sha256(archiveBytes),
      manifest: published.manifestPath,
      manifestSha256: sha256(internalManifestBytes),
      notebookVersion,
      notebookTarballSha256: options.notebookSha256,
      baseArchiveSha256: options.baseSha256,
      components: manifest.components.length,
      supportFiles: Object.keys(manifest.supportFiles).length,
      patches: {
        notebook: notebookPlan.files.length,
        subscriptions: subscriptionsPlan.files.length,
      },
      patchRoundtrip: {
        notebook: notebookRoundtrip,
        subscriptions: subscriptionsRoundtrip,
      },
      verification: {
        base: baseVerification,
        stage: stageVerification,
        packaged: packagedVerification,
      },
      preservedComponents: PRESERVED_COMPONENT_IDS,
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = ParseBuildCompatOptions(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(BuildReleaseCompat(options), null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`build-release-compat: ${error?.message ?? String(error)}\n`)
    process.exitCode = 1
  }
}
