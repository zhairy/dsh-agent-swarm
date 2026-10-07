import { execFile } from 'node:child_process'

/** 命令执行器（便于测试替换） */
export type CommandRunner = (command: string, args: string[], cwd: string) => Promise<{ code: number; stdout: string }>

/**
 * 执行命令并收集标准输出；失败时返回非零码而不抛出
 * @param {string} command - 命令
 * @param {string[]} args - 参数
 * @param {string} cwd - 工作目录
 * @returns {Promise<{ code: number; stdout: string }>} 退出码与输出
 */
export const runCommand: CommandRunner = (command, args, cwd) =>
  new Promise((resolve) => {
    execFile(command, args, { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1
      resolve({ code, stdout: String(stdout ?? '') })
    })
  })

/** 路径 → git 状态码（XY） */
export type GitStatusInfo = Map<string, string>

/**
 * 解析 `git status --porcelain=v1 -z` 输出；重命名/复制条目后紧跟的原路径被跳过
 * @param {string} stdout - 命令输出
 * @returns {GitStatusInfo} 状态表
 */
export const ParseGitStatus = (stdout: string): GitStatusInfo => {
  const entries = stdout.split('\0').filter((entry) => entry !== '')
  const map: GitStatusInfo = new Map()
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index] as string
    const status = entry.slice(0, 2)
    map.set(entry.slice(3), status)
    if (status.includes('R') || status.includes('C')) index++
  }
  return map
}

/**
 * 读取工作区 git 状态；不是 git 仓库或 git 不可用时返回 undefined
 * @param {string} cwd - 工作区
 * @param {CommandRunner} [run] - 命令执行器
 * @returns {Promise<GitStatusInfo | undefined>} 状态表
 */
export const getGitStatus = async (cwd: string, run: CommandRunner = runCommand): Promise<GitStatusInfo | undefined> => {
  const result = await run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd)
  return result.code === 0 ? ParseGitStatus(result.stdout) : undefined
}

/**
 * 委派前后状态的差集：新出现或状态改变的路径。委派前已脏且内容再次变化的文件无法识别（已知限制）
 * @param {GitStatusInfo} before - 委派前
 * @param {GitStatusInfo} after - 委派后
 * @returns {string[]} 改动路径（排序）
 */
export const getChangedFiles = (before: GitStatusInfo, after: GitStatusInfo): string[] =>
  [...after.entries()].filter(([path, status]) => before.get(path) !== status).map(([path]) => path).sort()
