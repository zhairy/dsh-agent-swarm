#!/usr/bin/env node
// 将发布 tarball 解包为本地插件，并把 DSH profile 依赖改为 link:。
// 本地 tarball 使用 file: 时，pnpm 可能在校验整棵锁文件时再次查询同名注册表版本；
// 改用内容摘要命名的本地目录可以彻底移除此查询，同时保留版本与来源可追溯性。
//
// 用法:
//   node scripts/install-profile.mjs --tarball <file.tgz> --profile <profile-dir> [--dsh-home <dir>] [--no-install]
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
const fail = (message) => { throw new Error(`install-profile: ${message}`) }

const tarball = resolve(option('--tarball') ?? fail('缺少 --tarball <file.tgz>'))
const profile = resolve(option('--profile') ?? join(homedir(), '.dsh', 'profiles', 'web'))
const dshHome = resolve(option('--dsh-home') ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const install = !args.includes('--no-install')

if (!existsSync(tarball)) fail(`tarball 不存在：${tarball}`)
if (!existsSync(join(profile, 'package.json'))) fail(`profile 缺少 package.json：${profile}`)
if (!existsSync(join(profile, 'pnpm-workspace.yaml'))) fail(`profile 缺少 pnpm-workspace.yaml：${profile}`)

const tarballBytes = readFileSync(tarball)
const tarballDigest = createHash('sha256').update(tarballBytes).digest('hex')
const archiveEntries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
if (archiveEntries.length === 0 || archiveEntries.length > 10_000) fail('tarball 文件数量为空或超过上限')
for (const entry of archiveEntries) {
  const normalized = entry.replaceAll('\\', '/')
  if (isAbsolute(normalized) || normalized.split('/').includes('..') || (normalized !== 'package' && !normalized.startsWith('package/'))) {
    fail(`tarball 包含非法路径：${entry}`)
  }
}
const packedManifest = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
if (packedManifest.name !== 'dsh-agent-swarm') fail(`包名不是 dsh-agent-swarm：${packedManifest.name}`)
if (typeof packedManifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packedManifest.version)) fail('包版本不合法')

const bundleRoot = join(dshHome, 'local-bundles')
mkdirSync(bundleRoot, { recursive: true, mode: 0o755 })
const target = join(bundleRoot, `dsh-agent-swarm-v${packedManifest.version}-${tarballDigest.slice(0, 12)}`)
const targetManifest = () => {
  try { return JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) } catch { return undefined }
}
if (targetManifest()?.name !== packedManifest.name || targetManifest()?.version !== packedManifest.version) {
  rmSync(target, { recursive: true, force: true })
  const temporary = mkdtempSync(join(bundleRoot, '.dsh-agent-swarm-'))
  try {
    execFileSync('tar', ['--no-same-owner', '--no-same-permissions', '-xzf', tarball, '-C', temporary], { stdio: 'inherit' })
    const extracted = join(temporary, 'package')
    if (!existsSync(join(extracted, 'package.json'))) fail('tarball 缺少 package/package.json')
    const extractedManifest = JSON.parse(readFileSync(join(extracted, 'package.json'), 'utf8'))
    if (extractedManifest.name !== packedManifest.name || extractedManifest.version !== packedManifest.version) fail('解包后的包身份与 tarball 清单不一致')
    renameSync(extracted, target)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
const runtimeDependencies = Object.keys(packedManifest.dependencies ?? {})
if (runtimeDependencies.length > 0 && !existsSync(join(target, 'node_modules'))) {
  // link: installs do not install the target package's dependencies. Prepare the
  // digest-addressed bundle once so Node can resolve them beside the package.
  execFileSync('pnpm', ['install', '--prod', '--ignore-scripts', '--lockfile=false', '--config.auto-install-peers=false'], { cwd: target, stdio: 'inherit' })
}

const profilePackage = join(profile, 'package.json')
const original = readFileSync(profilePackage, 'utf8')
const packageInfo = JSON.parse(original)
const dependency = `link:${target}`
const currentBundles = packageInfo.dsh?.profile?.bundles
const bundles = Array.isArray(currentBundles) ? currentBundles : []
const nextBundles = bundles.includes(packedManifest.name) ? bundles : [...bundles, packedManifest.name]
const dependencyChanged = packageInfo.dependencies?.['dsh-agent-swarm'] !== dependency
const bundlesChanged = currentBundles !== undefined && !bundles.includes(packedManifest.name)
if (dependencyChanged || bundlesChanged) {
  const backup = `${profilePackage}.before-${tarballDigest.slice(0, 12)}`
  if (!existsSync(backup)) copyFileSync(profilePackage, backup)
  packageInfo.dependencies = { ...(packageInfo.dependencies ?? {}), 'dsh-agent-swarm': dependency }
  if (packageInfo.dsh?.profile !== undefined) packageInfo.dsh.profile.bundles = nextBundles
  const temporary = `${profilePackage}.tmp-${process.pid}`
  writeFileSync(temporary, JSON.stringify(packageInfo, null, 2) + '\n', { mode: 0o644 })
  chmodSync(temporary, 0o644)
  renameSync(temporary, profilePackage)
}

if (install) execFileSync('pnpm', ['install'], { cwd: profile, stdio: 'inherit' })

process.stdout.write(JSON.stringify({
  package: packedManifest.name,
  version: packedManifest.version,
  tarballSha256: tarballDigest,
  dependency,
  profile,
  installed: install
}, null, 2) + '\n')
