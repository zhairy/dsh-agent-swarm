#!/usr/bin/env node
/**
 * dsh-agent-swarm 环境检查（只读；不输出任何密钥值）
 * 用法：node scripts/doctor.mjs [--profile web] [--dsh dsh]
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const getArg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback)
const profile = getArg('--profile', 'web')
const dsh = getArg('--dsh', 'dsh')
const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const MIN_VERSION = '0.1.7-alpha.2'
const rows = []
const add = (item, ok, detail, hint = '') => rows.push({ item, ok, detail, hint })

const run = (command) => {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 })
  } catch (error) {
    return undefined
  }
}

/** 比较 x.y.z-tag.n 形式的版本；预发布 alpha < beta < rc < 正式版 */
const getVersionOrder = (version) => {
  const [core, pre = ''] = version.trim().split('-')
  const nums = core.split('.').map(Number)
  const [tag = 'zz', n = '0'] = pre.split('.')
  const tagRank = { alpha: 0, beta: 1, rc: 2, zz: 3 }[tag] ?? 3
  return [...nums, tagRank, Number(n)]
}
const isAtLeast = (version, min) => {
  const a = getVersionOrder(version)
  const b = getVersionOrder(min)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}

const version = run(`${dsh} --version`)?.trim()
add('DSH 版本', version !== undefined && isAtLeast(version, MIN_VERSION), version ?? '未找到 dsh 命令', `需要 ≥ ${MIN_VERSION}：npm i -g @deepseek-ai/dsh@${MIN_VERSION}`)

const profileDir = join(dshHome, 'profiles', profile)
let bundles = []
try {
  bundles = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dsh?.profile?.bundles ?? []
} catch {
  bundles = []
}
add(`profile「${profile}」已安装本插件`, bundles.includes('dsh-agent-swarm'), bundles.length > 0 ? `${bundles.length} 个 bundle` : 'profile 不存在或为空', `dsh plugin --profile ${profile} add <本仓库绝对路径>`)
add('原生 Codex 后端（可选）', bundles.includes('@deepseek-ai/dsh-subagent-codex'), bundles.includes('@deepseek-ai/dsh-subagent-codex') ? '已安装' : '未安装', `dsh plugin --profile ${profile} add @deepseek-ai/dsh-subagent-codex`)
add('原生 Claude Code 后端（可选）', bundles.includes('@deepseek-ai/dsh-subagent-claude-code'), bundles.includes('@deepseek-ai/dsh-subagent-claude-code') ? '已安装' : '未安装', `dsh plugin --profile ${profile} add @deepseek-ai/dsh-subagent-claude-code`)
add('免费网页搜索（可选）', bundles.includes('dsh-web-search-free'), bundles.includes('dsh-web-search-free') ? '已安装' : '未安装', `dsh plugin --profile ${profile} add dsh-web-search-free`)

// dsh-llm-fallbacks 的全局回退会抢在百工之前改写路由；需要它读取百工的会话登记（MANAGED_AGENTS_KEY）后跳过百工模式
const fallbacksEntry = join(profileDir, 'node_modules', 'dsh-llm-fallbacks', 'dist', 'index.js')
if (bundles.includes('dsh-llm-fallbacks') && existsSync(fallbacksEntry)) {
  const honors = readFileSync(fallbacksEntry, 'utf8').includes('dsh-agent-swarm/managed-agents')
  add('llm-fallbacks 跳过百工模式', honors, honors ? '已排除：百工会话由百工自己的路由链回退' : '未排除：全局回退会接管百工会话的模型切换', '给 dsh-llm-fallbacks 打补丁，在 agent/request 与 agent/request-error 中遇到 globalThis[Symbol.for(\'dsh-agent-swarm/managed-agents\')].isManaged(agent) 为 true 时直接交给 next（见 docs/安装.md）')
}

// 0.1.5 及更早把 provider 写在 settings.yaml；0.1.7 首次启动时迁移到 profile 配置并改名为 settings.yaml.imported
const getLegacySettings = () => ['settings.yaml', 'settings.yaml.imported']
  .map((name) => join(dshHome, name))
  .filter((file) => existsSync(file))
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n')

const dump = version !== undefined ? run(`${dsh} --profile ${profile} --dump-config`) : undefined
if (dump !== undefined) {
  add('百工模式与 12 个角色预设已组合', ['tian-shu', 'fu-he', 'miao-bi'].every((id) => dump.includes(`preset-${id}`)), dump.includes('preset-tian-shu') ? (process.env.DSH_SWARM_ROLE_PRESETS === '1' ? '已组合（角色预设可见）' : '已组合（模式列表只显示百工模式）') : '未找到 preset-tian-shu')
  const legacy = getLegacySettings()
  for (const provider of ['qwen-token-plan-cn', 'opencode-go']) {
    const inProfile = dump.includes(provider)
    const inLegacy = new RegExp(`^\\s+${provider}:`, 'm').test(legacy)
    const detail = inProfile ? '已配置' : inLegacy ? '只在旧版 settings.yaml 中（升级到 0.1.7 后首次启动会迁移）' : '未在 profile 配置中找到'
    add(`模型 provider ${provider}`, inProfile, detail, 'Web 设置 → 模型 → 添加 provider（内置目录，只需填写 API key）')
  }
} else {
  add('读取组合配置', false, '无法运行 --dump-config', '先修复上面的 DSH 版本或 profile 问题')
}

const credentialsText = existsSync(join(dshHome, '.credentials.yaml')) ? readFileSync(join(dshHome, '.credentials.yaml'), 'utf8') : ''
for (const ref of ['QWEN_TOKEN_PLAN_CN_API_KEY', 'OPENCODE_GO_API_KEY', 'DEEPSEEK_API_KEY', 'TYPESAFE_API_KEY']) {
  const fromEnv = (process.env[ref] ?? '') !== ''
  const fromStore = new RegExp(`^\\s+${ref}:`, 'm').test(credentialsText)
  add(`凭据引用 ${ref}`, fromEnv || fromStore, fromEnv ? '来源：环境变量' : fromStore ? '来源：凭据库' : '未配置', ref === 'TYPESAFE_API_KEY' ? '在 Web「设置 → 百工 Agent」顶部填写 Jev API key（或设置环境变量后重启 dsh）；未配置时衡鉴按严格路径运行、jev_* 工具不可用。注意：只写在服务环境文件（如 systemd EnvironmentFile）里的变量 doctor 看不到，以设置页的「测试连接」为准' : '在 Web 设置 → 模型中填写')
}

const legacyDir = join(dshHome, '.agent-presets')
const legacy = existsSync(legacyDir) ? readdirSync(legacyDir).filter((name) => !name.startsWith('.')) : []
if (legacy.length > 0) add('旧式预设目录', false, `${legacy.length} 个（0.1.7 起不再读取）：${legacy.join(', ')}`, '见 docs/升级与回退.md 的迁移说明')

const width = Math.max(...rows.map((row) => row.item.length))
for (const row of rows) {
  console.log(`${row.ok ? '✓' : '✗'} ${row.item.padEnd(width)}  ${row.detail}${row.ok || row.hint === '' ? '' : `\n    → ${row.hint}`}`)
}
if (argv.includes('--strict') && rows.some((row) => !row.ok)) process.exit(1)
