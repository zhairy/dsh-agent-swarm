#!/usr/bin/env node
/**
 * 生成并校验 v3.4.1 精确兼容矩阵。
 *
 * 只有精确 Host、组件入口闭包、补丁状态和必需的真实检查在同一次调用内全部成立，
 * 才允许输出 verified。仅检查 package.json 或复用历史证据只能得到 unverified。
 */
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const EXIT_CODES = Object.freeze({ verified: 0, rejected: 1, unverified: 2 })
const CHECK_KINDS = new Set(['metadata', 'offline', 'host-runtime'])
const HOST_ROLES = new Set(['local-target', 'retained'])
const SHA256_PATTERN = /^[a-f0-9]{64}$/

const getSha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const getJson = path => JSON.parse(readFileSync(path, 'utf8'))
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isInside = (parent, child) => {
  const rel = relative(parent, child)
  return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

const ValidateRelativePath = (value, label) => {
  if (typeof value !== 'string' || value === '' || isAbsolute(value) || value.includes('\\')
    || value.split('/').some(part => ['', '.', '..'].includes(part))) {
    throw new Error(`${label} 包含非法相对路径`)
  }
  return value
}

const getSafePath = (root, value, label) => {
  const path = resolve(root, ValidateRelativePath(value, label))
  if (!isInside(root, path)) throw new Error(`${label} 越界`)
  return path
}

const getPhysicalFile = (root, path, label) => {
  if (!existsSync(path)) throw new Error(`${label} 缺失`)
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} 不是可信普通文件`)
  const physical = realpathSync(path)
  if (!isInside(root, physical)) throw new Error(`${label} 实际位置越界`)
  return physical
}

const GetOwningPackageManifest = (root, path, label) => {
  let directory = dirname(path)
  while (isInside(root, directory)) {
    const candidate = join(directory, 'package.json')
    if (existsSync(candidate)) {
      const manifest = getPhysicalFile(root, candidate, `${label} 所属 package.json`)
      return { manifest, packageInfo: getJson(manifest) }
    }
    if (directory === root) break
    directory = dirname(directory)
  }
  throw new Error(`${label} 缺少所属 package.json`)
}

const GetExactArtifact = (path, label) => {
  const target = resolve(path)
  if (!existsSync(target)) throw new Error(`${label} 缺失`)
  const stat = lstatSync(target)
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(target) !== target) {
    throw new Error(`${label} 不是可信普通文件`)
  }
  const bytes = readFileSync(target)
  return {
    path: target,
    bytes: bytes.length,
    sha256: getSha256(bytes)
  }
}

// 只读取 tar member，不解包、不调用包脚本；严格目录清单也覆盖未进入 import/patch 闭包的资源。
const ARTIFACT_DIRECTORY_CHECK = String.raw`
import hashlib, io, json, os, stat, sys, tarfile

root = sys.argv[1]
files, seen = {}, set()
total = 0
with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()), mode='r:gz') as archive:
    for member in archive:
        name = member.name.rstrip('/') if member.isdir() else member.name
        parts = name.split('/')
        if not name or '\\' in name or '\x00' in name or any(p in ('', '.', '..') for p in parts):
            raise ValueError('归档路径非法: ' + name)
        if parts[0] != 'package' or any(p in ('.git', 'node_modules') for p in parts):
            raise ValueError('归档路径不属于纯 package: ' + name)
        if name in seen: raise ValueError('归档重复 member: ' + name)
        seen.add(name)
        if len(seen) > 50000: raise ValueError('归档成员数量超过限制')
        if not member.isdir() and (not member.isfile() or member.sparse is not None):
            raise ValueError('归档只接受普通文件和目录: ' + name)
        if len(parts) == 1:
            if not member.isdir(): raise ValueError('归档 package 必须是目录')
            continue
        relative = '/'.join(parts[1:])
        path = os.path.join(root, *parts[1:])
        if not os.path.exists(path): raise ValueError('归档对应目录文件缺失: ' + relative)
        if member.isdir():
            if not stat.S_ISDIR(os.lstat(path).st_mode): raise ValueError('归档目录类型不一致: ' + relative)
            continue
        total += member.size
        if member.size < 0 or total > 512 * 1024 * 1024: raise ValueError('归档展开大小超过限制')
        with archive.extractfile(member) as source:
            digest = hashlib.sha256()
            size = 0
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk: break
                digest.update(chunk)
                size += len(chunk)
        if size != member.size: raise ValueError('归档文件 size 不一致: ' + relative)
        files[relative] = {'type': 'file', 'size': size, 'sha256': digest.hexdigest()}
if 'package.json' not in files: raise ValueError('归档缺少 package.json')

# 只有根目录安装元数据允许不在 tgz 中；任何额外文件（包括动态加载资源）均拒绝。
install_metadata = {'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'}
actual = set()
for directory, dirs, names in os.walk(root, followlinks=False):
    if directory == root:
        dirs[:] = [d for d in dirs if d not in ('node_modules', '.git')]
        names = [n for n in names if n != '.git']
    for name in dirs:
        path = os.path.join(directory, name)
        if not stat.S_ISDIR(os.lstat(path).st_mode): raise ValueError('精确包目录含链接或特殊类型: ' + path)
    for name in names:
        path = os.path.join(directory, name)
        relative = os.path.relpath(path, root).replace(os.sep, '/')
        if directory == root and name in install_metadata and relative not in files: continue
        if not stat.S_ISREG(os.lstat(path).st_mode): raise ValueError('精确包文件类型不一致: ' + relative)
        if relative not in files: raise ValueError('精确包目录存在归档外文件: ' + relative)
        with open(path, 'rb') as source:
            digest = hashlib.sha256()
            size = 0
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk: break
                digest.update(chunk)
                size += len(chunk)
        if size != files[relative]['size'] or digest.hexdigest() != files[relative]['sha256']:
            raise ValueError('归档与目录 size/SHA 不一致: ' + relative)
        actual.add(relative)
if actual != set(files): raise ValueError('归档与目录文件集不一致')
print(json.dumps(dict(sorted(files.items()))))
`

const InspectArtifactDirectory = (distribution, root) => {
  const bytes = readFileSync(distribution.path)
  if (getSha256(bytes) !== distribution.sha256) throw new Error('精确包读取期间摘要变化')
  const run = spawnSync('python3', ['-I', '-c', ARTIFACT_DIRECTORY_CHECK, root], {
    input: bytes,
    encoding: 'utf8',
    shell: false,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024
  })
  if (run.error || run.status !== 0) {
    throw new Error(`精确包归档与目录校验失败: ${run.error?.message ?? run.stderr.trim()}`)
  }
  return JSON.parse(run.stdout)
}

const addRejected = (issues, reason) => issues.rejected.add(reason)
const addUnverified = (issues, reason) => issues.unverified.add(reason)

const GetDefinition = input => {
  if (typeof input === 'string') return getJson(resolve(input))
  if (!isObject(input)) throw new Error('兼容矩阵定义必须是 JSON 对象或路径')
  return structuredClone(input)
}

const ValidateDefinition = (definition, issues) => {
  if (definition.schemaVersion !== 1) addRejected(issues, '兼容矩阵定义 schemaVersion 必须为 1')
  if (typeof definition.releaseVersion !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(definition.releaseVersion)) {
    addRejected(issues, '兼容矩阵 releaseVersion 非法')
  }
  if (!isObject(definition.hosts) || Object.keys(definition.hosts).length === 0) {
    addRejected(issues, '兼容矩阵未定义 Host')
  }
  if (!Array.isArray(definition.components) || definition.components.length === 0) {
    addRejected(issues, '兼容矩阵未定义组件')
  }
  if (!isObject(definition.checks)) addRejected(issues, '兼容矩阵未定义检查命令')
}

const ExpandDefinitionValue = (value, variables) => {
  if (typeof value !== 'string') return value
  return value.replace(/\$\{([^}]*)\}/g, (_match, key) => {
    let resolved
    if (/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      resolved = process.env[key.slice('env:'.length)]
    } else if (key.startsWith('component:')) {
      const id = key.slice('component:'.length)
      if (!Object.hasOwn(variables.componentPaths ?? {}, id)) {
        throw new Error(`组件占位符未知或路径未核验: ${key}`)
      }
      resolved = variables.componentPaths[id]
    } else {
      if (key === 'componentPaths' || !Object.hasOwn(variables, key)) {
        throw new Error(`未知占位符: ${key}`)
      }
      resolved = variables[key]
    }
    if (typeof resolved !== 'string' || resolved === '') {
      throw new Error(`占位符未设置: ${key}`)
    }
    return resolved
  })
}

const CollectDeclaredEntries = pkg => {
  const entries = new Set()
  const add = (value, allowWildcard = false) => {
    if (typeof value !== 'string') throw new Error('组件声明入口格式无效')
    if (value.includes('*')) {
      if (allowWildcard) return
      throw new Error('组件声明入口不接受通配符')
    }
    const normalized = value.startsWith('./') ? value.slice(2) : value
    entries.add(ValidateRelativePath(normalized, '组件声明入口'))
  }
  const visitExports = value => {
    if (typeof value === 'string') add(value, true)
    else if (Array.isArray(value)) value.forEach(visitExports)
    else if (isObject(value)) Object.values(value).forEach(visitExports)
  }

  if (pkg.main !== undefined) add(pkg.main)
  if (pkg.types !== undefined) add(pkg.types)
  visitExports(pkg.exports)
  const overlays = pkg.dsh?.bundle?.patch
  if (overlays !== undefined) {
    for (const overlay of Array.isArray(overlays) ? overlays : [overlays]) add(overlay)
  }
  return entries
}

const CollectRelativeImports = (root, entryFiles, issues, componentId) => {
  const files = new Set(entryFiles)
  const queue = [...entryFiles]
  while (queue.length > 0) {
    const path = queue.pop()
    if (!/\.(?:mjs|cjs|js)$/.test(path)) continue
    const source = readFileSync(join(root, path), 'utf8')
    for (const match of source.matchAll(
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"](\.[^'"\n]+)['"]/g
    )) {
      const target = resolve(dirname(join(root, path)), match[1])
      if (!isInside(root, target) || !existsSync(target) || !lstatSync(target).isFile()
        || lstatSync(target).isSymbolicLink()) {
        addRejected(issues, `组件相对导入缺失或越界: ${componentId} -> ${match[1]}`)
        continue
      }
      const rel = relative(root, realpathSync(target)).split(sep).join('/')
      if (!files.has(rel)) {
        files.add(rel)
        queue.push(rel)
      }
    }
  }
  return files
}

const InspectStateRows = (rows, root, descriptorId, issues) => {
  const states = []
  for (const row of rows) {
    const target = getSafePath(root, row.path, `${descriptorId} 目标`)
    const file = getPhysicalFile(root, target, `${descriptorId} 目标 ${row.path}`)
    const actualSha256 = getSha256(readFileSync(file))
    const state = actualSha256 === row.afterSha256
      ? 'patched'
      : actualSha256 === row.beforeSha256 ? 'original' : 'unknown'
    if (state === 'unknown') {
      addRejected(issues, `补丁摘要未知: ${descriptorId} -> ${row.path}`)
    }
    states.push({ path: row.path, state, actualSha256 })
  }
  return states
}

const ValidateRequiredState = (descriptor, states, issues) => {
  if (states.some(row => row.state === 'unknown')) return
  const uniqueStates = new Set(states.map(row => row.state))
  if (uniqueStates.size > 1) {
    addRejected(issues, `补丁处于混合状态: ${descriptor.id}`)
    return
  }
  const current = [...uniqueStates][0]
  const allowedStates = Array.isArray(descriptor.allowedStates)
    ? descriptor.allowedStates
    : [descriptor.requiredState ?? 'patched']
  if (!allowedStates.every(state => state === 'original' || state === 'patched')) {
    addRejected(issues, `补丁 allowedStates 非法: ${descriptor.id}`)
    return
  }
  if (!allowedStates.includes(current)) {
    addUnverified(issues, `补丁未应用或未达到要求状态: ${descriptor.id} -> ${current}`)
  }
}

const GetAggregatePatchState = states => {
  if (states.length === 0) return 'missing'
  if (states.every(row => row.state === 'patched')) return 'patched'
  if (states.every(row => row.state === 'original')) return 'original'
  return 'mixed-or-unknown'
}

const InspectShaStatePatch = (
  descriptor,
  repositoryRoot,
  sdkPath,
  issues,
  expectedTargetPackageVersion
) => {
  if (typeof descriptor.target !== 'string') throw new Error(`${descriptor.id} 缺少 target`)
  if (!SHA256_PATTERN.test(descriptor.originalSha256)
    || !SHA256_PATTERN.test(descriptor.patchedSha256)
    || descriptor.originalSha256 === descriptor.patchedSha256) {
    throw new Error(`${descriptor.id} 的补丁前后摘要非法`)
  }
  const artifact = getSafePath(repositoryRoot, descriptor.artifact, `${descriptor.id} 补丁`)
  const artifactSha256 = getSha256(readFileSync(getPhysicalFile(repositoryRoot, artifact, `${descriptor.id} 补丁`)))
  if (!SHA256_PATTERN.test(descriptor.artifactSha256) || artifactSha256 !== descriptor.artifactSha256) {
    addRejected(issues, `补丁文件摘要不匹配: ${descriptor.id}`)
  }
  const states = InspectStateRows([{
    path: descriptor.target,
    beforeSha256: descriptor.originalSha256,
    afterSha256: descriptor.patchedSha256
  }], sdkPath, descriptor.id, issues)
  ValidateRequiredState(descriptor, states, issues)
  let targetPackage
  if (expectedTargetPackageVersion !== undefined) {
    const owner = GetOwningPackageManifest(
      sdkPath,
      join(sdkPath, ValidateRelativePath(descriptor.target, `${descriptor.id} 目标`)),
      descriptor.id
    )
    targetPackage = {
      name: owner.packageInfo.name,
      version: owner.packageInfo.version,
      sha256: getSha256(readFileSync(owner.manifest))
    }
    if (owner.packageInfo.version !== expectedTargetPackageVersion) {
      addRejected(
        issues,
        `Host 补丁目标包版本不匹配: ${descriptor.id} -> ${String(owner.packageInfo.name)}@${String(owner.packageInfo.version)}`
      )
    }
  }
  return {
    id: descriptor.id,
    type: descriptor.type,
    artifact: relative(repositoryRoot, artifact).split(sep).join('/'),
    artifactSha256,
    state: GetAggregatePatchState(states),
    ...(targetPackage === undefined ? {} : { targetPackage }),
    states
  }
}

const InspectExecutionBoundaryPatch = (descriptor, repositoryRoot, sdkPath, hostVersion, issues) => {
  const planPath = getSafePath(repositoryRoot, descriptor.plan, `${descriptor.id} 清单`)
  const planSha256 = getSha256(readFileSync(getPhysicalFile(repositoryRoot, planPath, `${descriptor.id} 清单`)))
  if (!SHA256_PATTERN.test(descriptor.planSha256) || planSha256 !== descriptor.planSha256) {
    addRejected(issues, `补丁清单摘要不匹配: ${descriptor.id}`)
  }
  const artifactPath = getSafePath(repositoryRoot, descriptor.artifact, `${descriptor.id} 补丁`)
  const artifactSha256 = getSha256(readFileSync(getPhysicalFile(repositoryRoot, artifactPath, `${descriptor.id} 补丁`)))
  if (!SHA256_PATTERN.test(descriptor.artifactSha256) || artifactSha256 !== descriptor.artifactSha256) {
    addRejected(issues, `补丁文件摘要不匹配: ${descriptor.id}`)
  }
  const plan = getJson(planPath)
  if (plan.hostVersion !== hostVersion || !Array.isArray(plan.files) || plan.files.length === 0) {
    addRejected(issues, `补丁清单与 Host 不匹配: ${descriptor.id}`)
    return { id: descriptor.id, type: descriptor.type, planSha256, artifactSha256, states: [] }
  }
  for (const row of plan.files) {
    if (!SHA256_PATTERN.test(row.beforeSha256) || !SHA256_PATTERN.test(row.afterSha256)
      || row.beforeSha256 === row.afterSha256) {
      addRejected(issues, `补丁清单前后摘要非法: ${descriptor.id} -> ${String(row.path)}`)
    }
  }
  const targetPackages = []
  for (const row of plan.files) {
    const owner = GetOwningPackageManifest(
      sdkPath,
      join(sdkPath, ValidateRelativePath(row.path, `${descriptor.id} 目标`)),
      descriptor.id
    )
    const targetPackage = {
      name: owner.packageInfo.name,
      version: owner.packageInfo.version,
      sha256: getSha256(readFileSync(owner.manifest))
    }
    if (owner.packageInfo.version !== hostVersion) {
      addRejected(
        issues,
        `Host 补丁目标包版本不匹配: ${descriptor.id} -> ${String(owner.packageInfo.name)}@${String(owner.packageInfo.version)}`
      )
    }
    targetPackages.push(targetPackage)
  }
  const states = InspectStateRows(plan.files, sdkPath, descriptor.id, issues)
  ValidateRequiredState(descriptor, states, issues)
  return {
    id: descriptor.id,
    type: descriptor.type,
    plan: relative(repositoryRoot, planPath).split(sep).join('/'),
    planSha256,
    artifact: relative(repositoryRoot, artifactPath).split(sep).join('/'),
    artifactSha256,
    state: GetAggregatePatchState(states),
    targetPackages,
    states
  }
}

const InspectPluginPatch = (descriptor, root, repositoryRoot, pkg, issues) => {
  const planPath = getSafePath(repositoryRoot, descriptor.plan, `${descriptor.id} 清单`)
  const planSha256 = getSha256(readFileSync(getPhysicalFile(repositoryRoot, planPath, `${descriptor.id} 清单`)))
  if (!SHA256_PATTERN.test(descriptor.planSha256) || planSha256 !== descriptor.planSha256) {
    addRejected(issues, `组件补丁清单摘要不匹配: ${descriptor.id}`)
  }
  const plan = getJson(planPath)
  if (plan.schemaVersion !== 1 || plan.packageName !== pkg.name
    || pkg.version.split('+')[0] !== descriptor.baseVersion
    || !Array.isArray(plan.files) || plan.files.length === 0) {
    addRejected(issues, `组件补丁身份不匹配: ${descriptor.id}`)
  }
  if (plan.targetVersion !== undefined && plan.targetVersion !== pkg.version) {
    addRejected(
      issues,
      `组件补丁 targetVersion 与当前版本不匹配: ${descriptor.id} -> ${String(plan.targetVersion)} != ${String(pkg.version)}`
    )
  }
  const patchPath = getSafePath(dirname(planPath), plan.patch, `${descriptor.id} 补丁`)
  const patchSha256 = getSha256(readFileSync(getPhysicalFile(dirname(planPath), patchPath, `${descriptor.id} 补丁`)))
  if (patchSha256 !== plan.patchSha256) addRejected(issues, `组件补丁文件摘要不匹配: ${descriptor.id}`)
  const states = InspectStateRows(plan.files, root, descriptor.id, issues)
  ValidateRequiredState(descriptor, states, issues)
  return {
    id: descriptor.id,
    type: 'plugin-plan',
    plan: relative(repositoryRoot, planPath).split(sep).join('/'),
    planSha256,
    patchSha256,
    state: GetAggregatePatchState(states),
    states
  }
}

const InspectComponent = (
  definition,
  component,
  componentPath,
  artifactPath,
  repositoryRoot,
  hostVersion,
  issues
) => {
  const required = component.required === true
    || (Array.isArray(component.requiredForHosts) && component.requiredForHosts.includes(hostVersion))
  if (componentPath === undefined) {
    if (required) addUnverified(issues, `必需组件未提供路径: ${component.id}`)
    return undefined
  }
  const root = realpathSync(resolve(componentPath))
  if (!lstatSync(root).isDirectory()) throw new Error(`组件目录不可信: ${component.id}`)
  const packagePath = getPhysicalFile(root, join(root, 'package.json'), `${component.id} package.json`)
  const pkg = getJson(packagePath)
  const expectedVersion = ExpandDefinitionValue(component.version, { releaseVersion: definition.releaseVersion })
  if (pkg.name !== component.packageName) addRejected(issues, `组件名称不匹配: ${component.id}`)
  if (pkg.version !== expectedVersion) {
    addRejected(issues, `组件版本不匹配: ${component.id} -> ${String(pkg.version)} != ${expectedVersion}`)
  }

  const requiredEntries = new Set()
  for (const entry of component.requiredEntries ?? []) {
    requiredEntries.add(ValidateRelativePath(entry, `${component.id} 必需入口`))
  }
  const declaredEntries = CollectDeclaredEntries(pkg)
  const entryFiles = new Set([...requiredEntries, ...declaredEntries])
  for (const entry of entryFiles) {
    try {
      getPhysicalFile(root, join(root, entry), `组件入口 ${component.id} -> ${entry}`)
    } catch (error) {
      addRejected(issues, error.message)
    }
  }
  const files = CollectRelativeImports(root, [...entryFiles].filter(entry => existsSync(join(root, entry))), issues, component.id)
  files.add('package.json')
  const fileSha256 = {}
  for (const path of [...files].sort()) {
    fileSha256[path] = getSha256(readFileSync(join(root, path)))
  }
  const patches = []
  for (const descriptor of component.patches ?? []) {
    if (!descriptor.id || !['plugin-plan', 'sha-state'].includes(descriptor.type)) {
      addRejected(issues, `组件补丁定义无效: ${component.id}`)
      continue
    }
    patches.push(descriptor.type === 'plugin-plan'
      ? InspectPluginPatch(descriptor, root, repositoryRoot, pkg, issues)
      : InspectShaStatePatch(descriptor, repositoryRoot, root, issues))
  }
  let distribution
  const artifactRequired = component.requiredArtifact === true
    || component.requiredArtifactForHosts?.includes(hostVersion)
    || component.distributionSha256 !== undefined
  if (component.distributionSha256 !== undefined && !SHA256_PATTERN.test(component.distributionSha256)) {
    addRejected(issues, `组件精确包 SHA 格式非法: ${component.id}`)
  }
  if (artifactPath === undefined) {
    if (artifactRequired) addUnverified(issues, `必需组件精确包未提供: ${component.id}`)
  } else {
    try {
      distribution = GetExactArtifact(artifactPath, `${component.id} 精确包`)
      if (component.distributionSha256 !== undefined && distribution.sha256 !== component.distributionSha256) {
        addRejected(issues, `组件精确包摘要不匹配: ${component.id}`)
      } else {
        distribution.files = InspectArtifactDirectory(distribution, root)
      }
    } catch (error) {
      addRejected(issues, `${component.id}: ${error.message}`)
    }
  }
  return {
    id: component.id,
    packageName: pkg.name,
    version: pkg.version,
    root,
    entryFiles: [...entryFiles].sort(),
    files: fileSha256,
    patches,
    ...(distribution === undefined ? {} : { distribution })
  }
}

const ResolvePackageManifest = (requireFromHost, dependency) => {
  try {
    return realpathSync(requireFromHost.resolve(`${dependency}/package.json`))
  } catch {
    const entry = realpathSync(requireFromHost.resolve(dependency))
    let directory = dirname(entry)
    while (directory !== dirname(directory)) {
      const candidate = join(directory, 'package.json')
      if (existsSync(candidate)) {
        const pkg = getJson(candidate)
        if (pkg.name === dependency) return candidate
      }
      directory = dirname(directory)
    }
  }
  throw new Error(`无法解析 Host 依赖清单: ${dependency}`)
}

const InspectHost = (definition, hostVersion, sdkPath, repositoryRoot, issues) => {
  if (!existsSync(sdkPath) || !lstatSync(sdkPath).isDirectory()) {
    addRejected(issues, `SDK 路径不存在或不是目录: ${sdkPath}`)
    return undefined
  }
  const hostManifest = join(sdkPath, '@deepseek-ai/dsh/package.json')
  if (!existsSync(hostManifest)) {
    addRejected(issues, 'SDK 缺少 @deepseek-ai/dsh/package.json')
    return undefined
  }
  const hostPackagePath = getPhysicalFile(sdkPath, hostManifest, 'Host package.json')
  const hostPkg = getJson(hostPackagePath)
  if (hostPkg.name !== '@deepseek-ai/dsh' || hostPkg.version !== hostVersion) {
    addRejected(issues, `Host 版本不匹配: ${String(hostPkg.version)} != ${hostVersion}`)
  }
  const binValue = typeof hostPkg.bin === 'string' ? hostPkg.bin : hostPkg.bin?.dsh
  const binPath = typeof binValue === 'string'
    ? getSafePath(dirname(hostPackagePath), binValue, 'Host CLI 入口')
    : undefined
  if (binPath === undefined) addRejected(issues, 'Host 缺少 CLI 入口声明')
  else {
    try {
      getPhysicalFile(dirname(hostPackagePath), binPath, 'Host CLI 入口')
    } catch (error) {
      addRejected(issues, error.message)
    }
  }

  const internalPackages = {}
  const requireFromHost = createRequire(hostPackagePath)
  for (const [name, declaredVersion] of Object.entries(hostPkg.dependencies ?? {})) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    if (declaredVersion !== hostVersion) {
      addRejected(issues, `Host 内部依赖范围不是精确版本: ${name} -> ${String(declaredVersion)}`)
    }
    try {
      const path = ResolvePackageManifest(requireFromHost, name)
      if (!isInside(sdkPath, path)) addRejected(issues, `Host 内部依赖位置越界: ${name}`)
      const pkg = getJson(path)
      if (pkg.version !== hostVersion) {
        addRejected(issues, `Host 内部依赖版本不匹配: ${name} -> ${String(pkg.version)} != ${hostVersion}`)
      }
      internalPackages[name] = {
        version: pkg.version,
        sha256: getSha256(readFileSync(path))
      }
    } catch (error) {
      addRejected(issues, `${error.message}`)
    }
  }

  const hostDefinition = definition.hosts[hostVersion]
  const patches = []
  for (const descriptor of hostDefinition.patches ?? []) {
    if (!descriptor.id) {
      addRejected(issues, `Host 补丁定义缺少 id: ${hostVersion}`)
      continue
    }
    if (descriptor.type === 'sha-state') {
      patches.push(InspectShaStatePatch(descriptor, repositoryRoot, sdkPath, issues, hostVersion))
    } else if (descriptor.type === 'execution-boundary') {
      patches.push(InspectExecutionBoundaryPatch(descriptor, repositoryRoot, sdkPath, hostVersion, issues))
    } else {
      addRejected(issues, `未知 Host 补丁类型: ${descriptor.type}`)
    }
  }
  return {
    packageName: hostPkg.name,
    packageVersion: hostPkg.version,
    packageSha256: getSha256(readFileSync(hostPackagePath)),
    bin: typeof binValue === 'string' ? binValue.replace(/^\.\//, '') : null,
    internalPackages,
    patches
  }
}

const GetComponentPaths = (definition, repositoryRoot, componentPaths) => {
  const result = {}
  for (const component of definition.components) {
    const explicit = componentPaths[component.id]
    if (explicit !== undefined) result[component.id] = resolve(repositoryRoot, explicit)
    else if (component.defaultPath === '.') {
      result[component.id] = repositoryRoot
    } else if (typeof component.defaultPath === 'string') {
      result[component.id] = getSafePath(repositoryRoot, component.defaultPath, `${component.id} 默认路径`)
    }
  }
  for (const id of Object.keys(componentPaths)) {
    if (!definition.components.some(component => component.id === id)) {
      throw new Error(`未知组件路径参数: ${id}`)
    }
  }
  return result
}

const GetComponentArtifactPaths = (definition, repositoryRoot, artifactPaths) => {
  const result = {}
  for (const [id, path] of Object.entries(artifactPaths)) {
    if (!definition.components.some(component => component.id === id)) {
      throw new Error(`未知组件精确包参数: ${id}`)
    }
    result[id] = resolve(repositoryRoot, path)
  }
  return result
}

const CreateEvidence = evidenceDirectory => {
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const runId = `${timestamp}-${randomUUID().slice(0, 8)}`
  if (evidenceDirectory === undefined) {
    return {
      root: undefined,
      run: mkdtempSync(join(tmpdir(), 'swarm-compat-matrix-')),
      runId,
      persistent: false
    }
  }
  const root = resolve(evidenceDirectory)
  mkdirSync(root, { recursive: true })
  const run = join(root, runId)
  mkdirSync(run, { recursive: false })
  return { root, run, runId, persistent: true }
}

const GetCheckEnvironment = (variables, extra) => {
  const env = {
    ...process.env,
    DSH_TELEMETRY_DISABLED: '1',
    NO_COLOR: '1',
    SWARM_MATRIX_RELEASE: variables.releaseVersion,
    SWARM_MATRIX_HOST_VERSION: variables.hostVersion,
    SWARM_MATRIX_SDK: variables.sdkPath,
    SWARM_DSH_VERSION: variables.hostVersion,
    SWARM_DSH_MODULES: variables.sdkPath,
    SWARM_HOST_VERSION: variables.hostVersion
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    env[key] = String(ExpandDefinitionValue(value, variables))
  }
  return env
}

const RunChecks = (
  definition,
  hostVersion,
  hostDefinition,
  sdkPath,
  repositoryRoot,
  componentPaths,
  evidence,
  runChecks,
  issues
) => {
  const checks = []
  const requiredIds = hostDefinition.requiredChecks ?? []
  if (!Array.isArray(requiredIds) || requiredIds.length === 0) {
    addUnverified(issues, `Host 未声明必需检查: ${hostVersion}`)
    return checks
  }
  if (new Set(requiredIds).size !== requiredIds.length) addRejected(issues, '必需检查 id 重复')
  const definitions = requiredIds.map(id => {
    const check = definition.checks[id]
    if (!isObject(check)) {
      addRejected(issues, `必需检查未定义: ${id}`)
      return undefined
    }
    const kindValid = CHECK_KINDS.has(check.kind)
    if (!kindValid) {
      addRejected(issues, `检查类型未知: ${id} -> ${String(check.kind)}`)
    }
    const idValid = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)
    if (!idValid) {
      addRejected(issues, `检查 id 非法: ${id}`)
    }
    const hostValid = check.hostVersion === undefined || check.hostVersion === hostVersion
    if (!hostValid) {
      addRejected(issues, `检查绑定到其它 Host: ${id}`)
    }
    const commandValid = Array.isArray(check.command) && check.command.length > 0
      && check.command.every(value => typeof value === 'string' && value !== '')
    if (!commandValid) {
      addRejected(issues, `检查命令非法: ${id}`)
    }
    let envValid = true
    if (check.requiredEnv !== undefined) {
      if (!Array.isArray(check.requiredEnv)
        || check.requiredEnv.some(name => typeof name !== 'string'
          || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
        envValid = false
        addRejected(issues, `检查 requiredEnv 定义非法: ${id}`)
      } else {
        for (const name of check.requiredEnv) {
          if (typeof process.env[name] !== 'string' || process.env[name] === '') {
            envValid = false
            if (runChecks === false) addUnverified(issues, `检查必需环境变量未提供: ${id} -> ${name}`)
            else addRejected(issues, `检查必需环境变量缺失: ${id} -> ${name}`)
          }
        }
      }
    }
    let sdkBindingValid = true
    if (check.requiredSdkPath !== undefined) {
      try {
        const requiredSdkPath = realpathSync(getSafePath(
          repositoryRoot,
          check.requiredSdkPath,
          `${id} 必需 SDK 路径`
        ))
        sdkBindingValid = requiredSdkPath === sdkPath
        if (!sdkBindingValid) addRejected(issues, `检查 SDK 路径与运行夹具不一致: ${id}`)
      } catch (error) {
        sdkBindingValid = false
        addRejected(issues, `${id} 必需 SDK 路径不可用: ${error.message}`)
      }
    }
    let valid = kindValid && idValid && hostValid && commandValid && sdkBindingValid && envValid
    let prepared = {}
    if (valid) {
      // 三个展开入口共享核验后的 realpath；全部预检结束前不启动任何子进程。
      const variables = {
        releaseVersion: definition.releaseVersion,
        hostVersion,
        sdk: sdkPath,
        sdkPath,
        repositoryRoot,
        componentPaths,
        checkId: id,
        evidenceRoot: evidence.root ?? evidence.run,
        evidenceRun: evidence.run
      }
      try {
        const cwd = typeof check.cwd === 'string'
          ? resolve(repositoryRoot, ExpandDefinitionValue(check.cwd, variables))
          : repositoryRoot
        if (!isInside(repositoryRoot, cwd)) throw new Error('检查工作目录越界')
        prepared = {
          cwd,
          env: GetCheckEnvironment(variables, check.env),
          command: check.command.map(value => ExpandDefinitionValue(value, variables))
        }
      } catch (error) {
        valid = false
        addRejected(issues, `检查参数展开失败: ${id} -> ${error.message}`)
      }
    }
    return {
      id,
      ...check,
      ...prepared,
      valid
    }
  }).filter(Boolean)

  if (issues.rejected.size > 0) return checks
  if (!definitions.some(check => check.valid && check.kind === 'host-runtime')) {
    addUnverified(issues, `Host ${hostVersion} 缺少真实 runtime 检查；metadata/offline 不能证明运行兼容`)
  }
  if (runChecks === false) {
    addUnverified(issues, '要求检查未执行：当前为 metadata-only 模式')
    return checks
  }

  for (const check of definitions) {
    if (!check.valid) continue
    const startedAt = new Date().toISOString()
    const start = process.hrtime.bigint()
    const { cwd, env, command } = check
    const run = spawnSync(command[0], command.slice(1), {
      cwd,
      env,
      encoding: null,
      shell: false,
      timeout: Number.isInteger(check.timeoutMs) && check.timeoutMs > 0 ? check.timeoutMs : 300_000,
      maxBuffer: 16 * 1024 * 1024
    })
    const finishedAt = new Date().toISOString()
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000
    const stdout = Buffer.isBuffer(run.stdout) ? run.stdout : Buffer.from(run.stdout ?? '')
    const stderr = Buffer.isBuffer(run.stderr) ? run.stderr : Buffer.from(run.stderr ?? '')
    const stdoutPath = join(evidence.run, `${check.id}.stdout.log`)
    const stderrPath = join(evidence.run, `${check.id}.stderr.log`)
    writeFileSync(stdoutPath, stdout)
    writeFileSync(stderrPath, stderr)
    const record = {
      id: check.id,
      kind: check.kind,
      hostVersion,
      command,
      cwd,
      startedAt,
      finishedAt,
      durationMs,
      exitCode: run.status,
      signal: run.signal,
      error: run.error?.message,
      stdoutBytes: stdout.length,
      stderrBytes: stderr.length,
      stdoutSha256: getSha256(stdout),
      stderrSha256: getSha256(stderr),
      evidence: {
        stdout: stdoutPath,
        stderr: stderrPath,
        stdoutSha256: getSha256(stdout),
        stderrSha256: getSha256(stderr)
      }
    }
    checks.push(record)
    if (run.error || run.status !== 0) {
      addRejected(issues, `真实检查失败: ${check.id} exit=${String(run.status)}${run.error ? ` error=${run.error.message}` : ''}`)
    }
  }
  return checks
}

const GetSnapshot = (hostVersion, host, components) => ({
  hostVersion,
  host,
  components
})

const GetFingerprint = snapshot => getSha256(Buffer.from(JSON.stringify(snapshot)))

const GetStatus = issues => {
  if (issues.rejected.size > 0) return 'rejected'
  if (issues.unverified.size > 0) return 'unverified'
  return 'verified'
}

const GetResult = (definition, hostVersion, hostDefinition, host, components, checks, issues, evidence, runId) => {
  const status = GetStatus(issues)
  const result = {
    schemaVersion: 1,
    releaseVersion: definition?.releaseVersion ?? null,
    status,
    exitCode: EXIT_CODES[status],
    runId,
    checkedAt: new Date().toISOString(),
    target: {
      hostVersion,
      role: hostDefinition?.role ?? null,
      claim: hostDefinition?.claim ?? null
    },
    host,
    components,
    checks,
    reasons: [...issues.rejected, ...issues.unverified],
    evidence: {
      root: evidence.root,
      run: evidence.run,
      summary: join(evidence.run, 'compat-matrix.json'),
      persistent: evidence.persistent
    }
  }
  writeFileSync(result.evidence.summary, `${JSON.stringify(result, null, 2)}\n`)
  return result
}

/**
 * 校验兼容矩阵并执行定义中的必需命令。
 *
 * @param {object|string} definitionInput 兼容矩阵定义对象或路径。
 * @param {object} [options] 校验选项。
 * @param {string} [options.repositoryRoot] 共享工作树根目录。
 * @param {string} [options.hostVersion] 本次目标 Host。
 * @param {string} [options.sdkPath] 包含 @deepseek-ai 包的 node_modules。
 * @param {Record<string,string>} [options.componentPaths] 组件 id 到目录的映射。
 * @param {Record<string,string>} [options.artifactPaths] 组件 id 到精确 tgz 的映射。
 * @param {string} [options.evidenceDirectory] 持久证据根目录。
 * @param {boolean} [options.runChecks=true] false 时只做 metadata 检查。
 * @returns {object} 矩阵摘要、状态、原因和证据位置。
 */
export const ValidateCompatMatrix = (definitionInput, options = {}) => {
  const issues = { rejected: new Set(), unverified: new Set() }
  const evidence = CreateEvidence(options.evidenceDirectory)
  let definition
  let hostVersion = options.hostVersion
  try {
    definition = GetDefinition(definitionInput)
    ValidateDefinition(definition, issues)
    hostVersion ??= definition.defaultHostVersion
    if (!isObject(definition.hosts) || !Object.hasOwn(definition.hosts, hostVersion)) {
      addRejected(issues, `未知 Host 版本: ${String(hostVersion)}`)
      return GetResult(definition, hostVersion, undefined, undefined, {}, [], issues, evidence, evidence.runId)
    }
    const hostDefinition = definition.hosts[hostVersion]
    if (!HOST_ROLES.has(hostDefinition.role) || typeof hostDefinition.claim !== 'string') {
      addRejected(issues, `Host 角色或声明范围无效: ${hostVersion}`)
    }
    const repositoryRoot = realpathSync(resolve(options.repositoryRoot ?? process.cwd()))
    const sdkPath = realpathSync(resolve(
      options.sdkPath ?? join(repositoryRoot, '.sandbox', `dsh-${hostVersion}`, 'node_modules')
    ))
    const componentPaths = GetComponentPaths(definition, repositoryRoot, options.componentPaths ?? {})
    const artifactPaths = GetComponentArtifactPaths(
      definition,
      repositoryRoot,
      options.artifactPaths ?? {}
    )
    const components = {}
    for (const component of definition.components) {
      const inspected = InspectComponent(
        definition,
        component,
        componentPaths[component.id],
        artifactPaths[component.id],
        repositoryRoot,
        hostVersion,
        issues
      )
      if (inspected !== undefined) components[component.id] = inspected
    }
    const host = InspectHost(definition, hostVersion, sdkPath, repositoryRoot, issues)
    if (issues.rejected.size > 0) {
      return GetResult(definition, hostVersion, hostDefinition, host, components, [], issues, evidence, evidence.runId)
    }

    const before = GetSnapshot(hostVersion, host, components)
    const beforeFingerprint = GetFingerprint(before)
    // 只导出 InspectComponent 已检查的实际目录，禁止用环境变量或未检查的参数替代。
    const verifiedComponentPaths = Object.fromEntries(
      Object.entries(components).map(([id, component]) => [id, component.root])
    )
    const checks = RunChecks(
      definition,
      hostVersion,
      hostDefinition,
      sdkPath,
      repositoryRoot,
      verifiedComponentPaths,
      evidence,
      options.runChecks !== false,
      issues
    )
    if (checks.length > 0) {
      const hostAfter = InspectHost(definition, hostVersion, sdkPath, repositoryRoot, { rejected: new Set(), unverified: new Set() })
      const componentsAfter = {}
      for (const component of definition.components) {
        const inspected = InspectComponent(
          definition,
          component,
          componentPaths[component.id],
          artifactPaths[component.id],
          repositoryRoot,
          hostVersion,
          { rejected: new Set(), unverified: new Set() }
        )
        if (inspected !== undefined) componentsAfter[component.id] = inspected
      }
      const afterFingerprint = GetFingerprint(GetSnapshot(hostVersion, hostAfter, componentsAfter))
      if (beforeFingerprint !== afterFingerprint) {
        addRejected(issues, '检查期间 Host 或组件字节发生变化，本轮证据失效')
      }
    }
    return GetResult(definition, hostVersion, hostDefinition, host, components, checks, issues, evidence, evidence.runId)
  } catch (error) {
    addRejected(issues, error instanceof Error ? error.message : String(error))
    return GetResult(
      definition,
      hostVersion,
      definition?.hosts?.[hostVersion],
      undefined,
      {},
      [],
      issues,
      evidence,
      evidence.runId
    )
  }
}

const GetCliOptions = argv => {
  const options = { componentPaths: {}, artifactPaths: {}, runChecks: true }
  const valueOptions = new Set([
    '--definition',
    '--host',
    '--sdk',
    '--component',
    '--artifact',
    '--evidence',
    '--repository-root'
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--metadata-only') {
      options.runChecks = false
      continue
    }
    if (!valueOptions.has(arg)) throw new Error(`未知参数: ${arg}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`参数缺少值: ${arg}`)
    index += 1
    if (arg === '--component') {
      const at = value.indexOf('=')
      if (at <= 0 || at === value.length - 1) throw new Error('--component 必须使用 id=path')
      options.componentPaths[value.slice(0, at)] = value.slice(at + 1)
    } else if (arg === '--artifact') {
      const at = value.indexOf('=')
      if (at <= 0 || at === value.length - 1) throw new Error('--artifact 必须使用 id=path')
      options.artifactPaths[value.slice(0, at)] = value.slice(at + 1)
    } else {
      options[{
        '--definition': 'definition',
        '--host': 'hostVersion',
        '--sdk': 'sdkPath',
        '--evidence': 'evidenceDirectory',
        '--repository-root': 'repositoryRoot'
      }[arg]] = value
    }
  }
  return options
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  try {
    const options = GetCliOptions(process.argv.slice(2))
    const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd())
    const definitionPath = resolve(
      repositoryRoot,
      options.definition ?? 'compat/v3.4.1-matrix.json'
    )
    const definition = getJson(definitionPath)
    const hostVersion = options.hostVersion ?? definition.defaultHostVersion
    const result = ValidateCompatMatrix(definition, {
      ...options,
      repositoryRoot,
      hostVersion,
      sdkPath: options.sdkPath ?? join(repositoryRoot, '.sandbox', `dsh-${hostVersion}`, 'node_modules'),
      componentPaths: options.componentPaths,
      artifactPaths: options.artifactPaths
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.exitCode
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: 'rejected',
      exitCode: EXIT_CODES.rejected,
      reasons: [error instanceof Error ? error.message : String(error)]
    }, null, 2)}\n`)
    process.exitCode = EXIT_CODES.rejected
  }
}
