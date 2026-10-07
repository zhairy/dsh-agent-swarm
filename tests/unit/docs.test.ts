import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROLE_INFO_LIST } from '../../src/role-registry.js'
import { DEFAULT_ROUTE_CHAINS, getRouteLabel } from '../../src/routes.js'

const ROOT = join(import.meta.dirname, '..', '..')
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8')

describe('文档与代码一致', () => {
  it('角色.md 列出全部 13 个角色、预设 ID 与默认首选路由', () => {
    const doc = read('docs/角色.md')
    for (const role of ROLE_INFO_LIST) {
      expect(doc).toContain(role.name)
      expect(doc).toContain(role.presetId)
    }
    for (const chain of Object.values(DEFAULT_ROUTE_CHAINS)) expect(doc).toContain(getRouteLabel(chain[0] as { provider: string; model: string }))
  })

  it('安装.md 覆盖升级、模型、凭据、可选后端与 doctor', () => {
    const doc = read('docs/安装.md')
    for (const keyword of ['0.1.7-alpha.2', 'QWEN_TOKEN_PLAN_CN_API_KEY', 'OPENCODE_GO_API_KEY', 'TYPESAFE_API_KEY', '@deepseek-ai/dsh-subagent-codex', '@deepseek-ai/dsh-subagent-claude-code', 'dsh-web-search-free', 'doctor', '天枢']) {
      expect(doc).toContain(keyword)
    }
  })

  it('示例配置只用真实存在的路由键', () => {
    const example = read('config/roles.example.yaml')
    const keys = [...example.matchAll(/^ {6}([a-z_:]+):$/gm)].map((m) => m[1])
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) expect(Object.keys(DEFAULT_ROUTE_CHAINS)).toContain(key)
  })

  it('评测样例包含 4 个必测案例', () => {
    const tasks = JSON.parse(read('tests/fixtures/eval-tasks.example.json')) as Array<{ id: string; mandatory?: boolean }>
    expect(tasks.filter((task) => task.mandatory === true).map((task) => task.id).sort()).toEqual(['command-exec', 'fu-he-finds-failure', 'screenshot', 'ui-copy'])
  })
})
