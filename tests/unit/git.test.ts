import { describe, expect, it } from 'vitest'
import { ParseGitStatus, getChangedFiles, getGitStatus, runCommand } from '../../src/util/git.js'

describe('ParseGitStatus', () => {
  it('解析 -z 输出，含重命名', () => {
    const map = ParseGitStatus(' M src/a.ts\0?? new.txt\0R  moved.ts\0old.ts\0')
    expect([...map.entries()]).toEqual([['src/a.ts', ' M'], ['new.txt', '??'], ['moved.ts', 'R ']])
    expect(ParseGitStatus('').size).toBe(0)
  })
})

describe('getChangedFiles', () => {
  it('返回状态新增或改变的路径（排序）', () => {
    const before = new Map([['a.ts', ' M'], ['b.ts', '??']])
    const after = new Map([['a.ts', ' M'], ['b.ts', 'A '], ['c.ts', '??']])
    expect(getChangedFiles(before, after)).toEqual(['b.ts', 'c.ts'])
  })
})

describe('getGitStatus', () => {
  it('非零退出码返回 undefined，成功时解析输出', async () => {
    expect(await getGitStatus('/x', async () => ({ code: 128, stdout: '' }))).toBeUndefined()
    const map = await getGitStatus('/x', async (_cmd, args) => {
      expect(args).toEqual(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
      return { code: 0, stdout: '?? z.txt\0' }
    })
    expect(map?.get('z.txt')).toBe('??')
  })

  it('runCommand 对不存在的命令返回非零码', async () => {
    const result = await runCommand('definitely-not-a-command-xyz', [], process.cwd())
    expect(result.code).not.toBe(0)
    const ok = await runCommand(process.execPath, ['-e', 'process.stdout.write("hi")'], process.cwd())
    expect(ok).toEqual({ code: 0, stdout: 'hi' })
  })
})
