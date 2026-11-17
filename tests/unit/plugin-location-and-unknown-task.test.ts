import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPluginInfo, getStatusText } from '../../src/tools.js'
import { intTaskStore } from '../../src/evidence.js'

// 从函数签名取参数类型：避免为了一个测试夹具把内部类型导出成公共 API。
type StatusResult = Parameters<typeof getStatusText>[0]

describe('plugin location disclosure', () => {
  it('reports its own root, source and build directories without guessing a dist layout', () => {
    const info = getPluginInfo()
    const pkg = JSON.parse(readFileSync(join(info.root, 'package.json'), 'utf8')) as { version: string }
    expect(info.version).toBe(pkg.version)
    expect(info.sourceDir).toBe(join(info.root, 'src'))
    expect(info.buildDir).toBe(join(info.root, 'lib'))
    // 目录真实存在：agent 拿到路径后可以直接读取，而不是继续猜宿主 packages/ 或 dist/。
    expect(existsSync(info.root)).toBe(true)
    expect(existsSync(info.sourceDir)).toBe(true)
    expect(existsSync(info.buildDir)).toBe(true)
  })

  it('puts the plugin location line into swarm_status output', () => {
    const result = {
      tasks: [], roleSuggestions: [], rootUpgrade: null, threads: [], ledgerPath: '/tmp/ledger.jsonl',
      usage: { nativeCalls: 0, jevCalls: 0, reviewCalls: 0, sessionCalls: 0 }, diagnostics: [],
      persistence: { durable: false, recovery: '已审计状态可恢复' }
    } as unknown as StatusResult
    const text = getStatusText(result)
    expect(text).toContain('本会话还没有任务卡')
    const info = getPluginInfo()
    expect(text).toContain(`插件：dsh-agent-swarm ${info.version}`)
    expect(text).toContain(info.sourceDir)
    expect(text).toContain(info.buildDir)
    // 这一句是给「搜 dist/*.js 失败」这类误猜的正面指引。
    expect(text).toContain('没有 dist 目录')
  })
})

describe('unknown task diagnostics', () => {
  it('tells the caller how to locate tasks instead of only echoing the id', () => {
    const store = intTaskStore()
    const update = () => store.UpdateTask('T-1', {})
    expect(update).toThrowError(/未知任务：T-1/)
    expect(update).toThrowError(/任务卡按根会话与工作区隔离/)
    expect(update).toThrowError(/swarm_status/)
  })
})
