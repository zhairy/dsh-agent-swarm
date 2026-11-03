import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROLE_INFO_LIST } from '../../src/role-registry.js'
import { DEFAULT_ROUTE_CHAINS, getRouteLabel } from '../../src/domain/routing/routes.js'

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
    for (const keyword of ['0.2.1-rc.5', 'pi-ai@1.5.0', 'QWEN_TOKEN_PLAN_CN_API_KEY', 'OPENCODE_GO_API_KEY', 'TYPESAFE_API_KEY', '@deepseek-ai/dsh-subagent-codex', '@deepseek-ai/dsh-subagent-claude-code', 'dsh-web-search-free', 'doctor', '天枢']) {
      expect(doc).toContain(keyword)
    }
  })

  it('示例配置只用真实存在的路由键', () => {
    const example = read('config/roles.example.yaml')
    const keys = [...example.matchAll(/^ {6}([a-z_:]+):$/gm)].map((m) => m[1])
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) expect(Object.keys(DEFAULT_ROUTE_CHAINS)).toContain(key)
  })

  it('3.3.0 文档说明 strangler、依赖矩阵和宿主升级边界', () => {
    const release = read('docs/3.3.0-strangler完成与宿主升级.md')
    const dependencies = read('docs/依赖与宿主兼容.md')
    for (const keyword of ['StateStore', 'EventJournal V2', 'workspaceWrites', '0.2.1-rc.5', 'pi-ai', '1.5.0']) expect(release).toContain(keyword)
    for (const keyword of ['@earendil-works/pi-ai', 'openai', '@anthropic-ai/sdk', 'zod', '不能']) expect(dependencies).toContain(keyword)
  })

  it('3.3.1 文档说明 OpenAI API 容量、provider 边界和输出预算', () => {
    const release = read('docs/3.3.1-OpenAI元数据与输出上限.md')
    for (const keyword of ['1,050,000', '272,000', '128,000', 'Codex', 'reasoning tokens', 'repair-openai-metadata.mjs']) expect(release).toContain(keyword)
  })

  it('3.3.2 文档说明 Windows durability、legacy journal 边界和原生集成完成度', () => {
    const release = read('docs/3.3.2-运行时完整性与原生集成.md')
    for (const keyword of ['windows-best-effort', '64 KiB', 'null', 'tool-todo', 'time-context', 'Outbox', '尚未完成']) expect(release).toContain(keyword)
  })

  it('3.3.3 文档说明人工选模、角色恢复、Outbox、Source/Trigger 与 journal-only recovery', () => {
    const release = read('docs/3.3.3-人工选模-角色恢复-事件溯源.md')
    for (const keyword of ['suppressedByUserSelection', 'agentPreset', '工具 scope', 'state/journal-commit', 'off', 'observe', 'auto',
      'Mandate', 'contextOnly', 'ticket-intent', 'ticket-follow-up', 'fsync', 'journal-only', 'persistence.enabled']) expect(release).toContain(keyword)
  })

  it('评测样例包含 4 个必测案例', () => {
    const tasks = JSON.parse(read('tests/fixtures/eval-tasks.example.json')) as Array<{ id: string; mandatory?: boolean }>
    expect(tasks.filter((task) => task.mandatory === true).map((task) => task.id).sort()).toEqual(['command-exec', 'fu-he-finds-failure', 'screenshot', 'ui-copy'])
  })
})
