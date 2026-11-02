import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { PROFILE, SANDBOX_ROOT, ensureProfile, runDshAsync } from '../../scripts/sandbox.mjs'

/** 1×1 透明 PNG */
export const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

const ROUTE_KEYS = ['tian_shu', 'mou_ding', 'shu_ji', 'suan_heng:research', 'suan_heng:verify', 'tan_wei', 'bo_wen', 'guan_xiang', 'zhu_jian', 'xing_zhou', 'ji_feng', 'yu_shi', 'fu_he', 'miao_bi']

const getDefaultModel = (key: string): string =>
  key === 'tian_shu' ? 'root' : key === 'suan_heng:verify' ? 'role-suan_heng-verify' : `role-${key.replace(':research', '')}`

/**
 * 生成 swarm-core 的路由覆盖：全部指向 swarm-mock，可按角色替换模型链
 * @param {Record<string, string[]>} overrides - 路由键 → 模型名列表
 * @returns {Record<string, { chain: Array<{ provider: string; model: string }> }>} routes 配置
 */
export const getRoutesOverlay = (overrides: Record<string, string[]> = {}) =>
  Object.fromEntries(ROUTE_KEYS.map((key) => [key, { chain: (overrides[key] ?? [getDefaultModel(key)]).map((model) => ({ provider: 'swarm-mock', model })) }]))

export interface ScenarioRunInfo {
  status: string
  error?: string
  results: Array<{ step: number; isError: boolean; text: string }>
  children: Array<{ role: string; model: string; tools: string[]; images: boolean }>
  rootTools: string[]
  taskId?: string
  sessionId?: string
  failQuotaHits: number
  childMessages: Array<{ role: string; sessionId: string; turn: number; text: string }>
  rootNotices: number
  subagentProviders?: string[]
  ledgerEvents: Array<{ type: string; data: Record<string, unknown> }>
  workspace: string
  stdout: string
  stderr: string
}

const git = (cwd: string, args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=swarm-test', '-c', 'user.email=swarm@test.local', ...args], { cwd, stdio: 'ignore' })
}

/**
 * 在沙箱中运行一个场景：准备 git 工作区与覆盖补丁，启动 DSH，读取驱动输出与账本
 * @param {string} scenario - 场景名（tests/integration/driver/scenarios.js）
 * @param {Record<string, unknown>} coreConfig - swarm-core 行的 config
 * @param {{ env?: Record<string, string>; files?: Record<string, string | Buffer> }} [options] - 环境变量与工作区文件
 * @returns {Promise<ScenarioRunInfo>} 运行结果
 */
export const runScenario = async (
  scenario: string,
  coreConfig: Record<string, unknown>,
  options: { env?: Record<string, string>; files?: Record<string, string | Buffer> } = {}
): Promise<ScenarioRunInfo> => {
  const { home } = ensureProfile()
  mkdirSync(SANDBOX_ROOT, { recursive: true })
  const workspace = mkdtempSync(join(SANDBOX_ROOT, `ws-${scenario}-`))
  writeFileSync(join(workspace, 'README.md'), '# sandbox workspace\n')
  for (const [file, content] of Object.entries(options.files ?? {})) writeFileSync(join(workspace, file), content)
  git(workspace, ['init', '-q'])
  git(workspace, ['add', '-A'])
  git(workspace, ['commit', '-q', '-m', 'init'])
  const overlay = `${workspace}.overlay.yml`
  writeFileSync(overlay, YAML.stringify([{ id: 'swarm-core', config: { planningReview: { enabled: false }, ...coreConfig } }]))
  const out = `${workspace}.out.json`
  const result = await runDshAsync({
    args: ['--profile', PROFILE, '--patch', overlay],
    cwd: workspace,
    env: { SWARM_SCENARIO: scenario, SWARM_DRIVER_OUT: out, ...options.env },
    timeout: 170000
  })
  if (!existsSync(out)) throw new Error(`场景 ${scenario} 没有输出。\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  const data = JSON.parse(readFileSync(out, 'utf8')) as Omit<ScenarioRunInfo, 'ledgerEvents' | 'workspace' | 'stdout' | 'stderr'>
  const ledgerFile = join(home, 'share', 'dsh-agent-swarm', 'ledger', `${data.sessionId ?? 'none'}.jsonl`)
  const ledgerEvents = existsSync(ledgerFile)
    ? readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> })
    : []
  return { ...data, ledgerEvents, workspace, stdout: result.stdout, stderr: result.stderr }
}
