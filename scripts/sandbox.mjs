#!/usr/bin/env node
/**
 * 沙箱：在 .sandbox/ 下安装指定版本的 DSH，使用独立 DSH_HOME，不触碰本机 ~/.dsh
 * 用法：node scripts/sandbox.mjs [--version <x>] [--reset]
 */
import { execSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SANDBOX_ROOT = join(REPO_ROOT, '.sandbox')
export const DRIVER_DIR = join(REPO_ROOT, 'tests', 'integration', 'driver')
export const PROFILE = 'swarmtest'
// Verify a private compiled candidate without touching a live link-installed lib/.
export const getPluginRoot = () => process.env.SWARM_PLUGIN_ROOT ? resolve(process.env.SWARM_PLUGIN_ROOT) : REPO_ROOT

export const getTestedVersion = () =>
  process.env.SWARM_DSH_VERSION ?? JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).dsh.testedVersions[0]

const getDshDir = (version) => join(SANDBOX_ROOT, `dsh-${version}`)

export const getSandboxDshModules = (version = getTestedVersion()) => join(getDshDir(version), 'node_modules')

export const getHome = (version = getTestedVersion()) => join(SANDBOX_ROOT, `home-${version}`)

/**
 * 确保沙箱中安装了指定版本的 DSH，返回其 CLI 入口
 * @param {string} [version] - DSH 版本
 * @returns {string} bin.js 路径
 */
export const ensureDsh = (version = getTestedVersion()) => {
  const dir = getDshDir(version)
  const pkgFile = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const installed = existsSync(pkgFile) && JSON.parse(readFileSync(pkgFile, 'utf8')).version === version
  if (!installed) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-sandbox', private: true }))
    execSync(`npm install --no-audit --no-fund --ignore-scripts @deepseek-ai/dsh@${version}`, { cwd: dir, stdio: 'inherit' })
  }
  return join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

// 集成场景会直接以单角色预设（如御史）作主会话，沙箱里打开这些默认停用的预设
const getEnv = (version, env) => ({ ...process.env, DSH_HOME: getHome(version), DSH_TELEMETRY_DISABLED: '1', DSH_SWARM_ROLE_PRESETS: '1', ...env })

/**
 * 同步运行沙箱 DSH
 * @param {{ version?: string, args: string[], env?: object, cwd?: string, timeout?: number }} options - 参数
 * @returns {import('node:child_process').SpawnSyncReturns<string>} 结果
 */
export const runDsh = ({ version = getTestedVersion(), args, env = {}, cwd = REPO_ROOT, timeout = 180000 }) =>
  spawnSync(process.execPath, [ensureDsh(version), ...args], { cwd, env: getEnv(version, env), encoding: 'utf8', timeout })

/**
 * 异步运行沙箱 DSH（测试进程需要同时服务 HTTP mock 时使用）
 * @param {{ version?: string, args: string[], env?: object, cwd?: string, timeout?: number }} options - 参数
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string }>} 结果
 */
export const runDshAsync = ({ version = getTestedVersion(), args, env = {}, cwd = REPO_ROOT, timeout = 180000 }) =>
  new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [ensureDsh(version), ...args], { cwd, env: getEnv(version, env) })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill(), timeout)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolvePromise({ status, stdout, stderr })
    })
  })

const getBundles = (profileDir) => {
  try {
    return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dsh?.profile?.bundles ?? []
  } catch {
    return []
  }
}

/**
 * 确保测试 profile 已安装驱动 bundle 与本插件（顺序：先驱动后本插件，保证本插件的补丁覆盖驱动插入的注册表行）
 * @param {string} [version] - DSH 版本
 * @param {{ reset?: boolean }} [options] - reset 为 true 时重建 profile
 * @returns {{ home: string, profileDir: string, bin: string }} 路径
 */
export const ensureProfile = (version = getTestedVersion(), { reset = false } = {}) => {
  const home = getHome(version)
  const profileDir = join(home, 'profiles', PROFILE)
  if (reset) rmSync(profileDir, { recursive: true, force: true })
  const bundles = getBundles(profileDir)
  const pluginRoot = getPluginRoot()
  let installedRoot
  try { installedRoot = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dependencies?.['dsh-agent-swarm'] } catch {}
  if (!bundles.includes('swarm-test-driver') || !bundles.includes('dsh-agent-swarm') || installedRoot !== 'link:' + pluginRoot) {
    for (const target of [DRIVER_DIR, pluginRoot]) {
      const result = runDsh({ version, args: ['plugin', '--profile', PROFILE, 'add', target], timeout: 600000 })
      if (result.status !== 0) throw new Error(`安装 ${target} 失败：\n${result.stdout}\n${result.stderr}`)
    }
  }
  return { home, profileDir, bin: ensureDsh(version) }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const argv = process.argv.slice(2)
  const versionIndex = argv.indexOf('--version')
  const version = versionIndex >= 0 ? argv[versionIndex + 1] : getTestedVersion()
  const paths = ensureProfile(version, { reset: argv.includes('--reset') })
  console.log(JSON.stringify({ version, ...paths }, null, 2))
}
