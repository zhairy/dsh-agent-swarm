import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const hasBuild = existsSync(join(process.cwd(), 'lib', 'index.js'))

describe('release packing guard', () => {
  it.skipIf(!hasBuild)('verifies the entry dependency closure is inside the tarball', async () => {
    const { stdout } = await execFileAsync(process.execPath, [join(process.cwd(), 'scripts', 'pack-release.mjs'), '--check-only', '--skip-build'], { cwd: process.cwd() })
    const report = JSON.parse(stdout) as { entry: string; closureFiles: number; packagedFiles: number; missing: number }
    // 入口闭包的每个文件都必须在 npm pack 的清单里：上一轮发布正是缺了新增模块。
    expect(report.entry).toBe('lib/index.js')
    expect(report.missing).toBe(0)
    expect(report.closureFiles).toBeGreaterThan(10)
    expect(report.packagedFiles).toBeGreaterThan(report.closureFiles)
  }, 60_000)
})
