import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件内嵌的技能：随插件发布在 skills/<name>/SKILL.md，通过 ctx.skills.register 注册到百工模式 */
export const EMBEDDED_SKILLS = ['jev-judgments', 'typesafe-ai'] as const

/** ctx.skills.register 接受的最小形状 */
export interface SkillRegistrationLike {
  name: string
  description: string
  content: string
  source: string
  path?: string
}

/** ctx.skills 的最小形状 */
export interface SkillsLike {
  register: (skill: SkillRegistrationLike) => () => void
}

const SKILLS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')

/**
 * 解析 SKILL.md：读取 frontmatter 里的 name 与 description（支持 `>` 折叠块），其余作为正文
 * @param {string} text - 文件内容
 * @returns {{ name?: string; description?: string; content: string }} 解析结果
 */
export const ParseSkillFile = (text: string): { name?: string; description?: string; content: string } => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (match === null) return { content: text.trim() }
  const meta: Record<string, string> = {}
  const lines = (match[1] as string).split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string
    const field = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (field === null) continue
    const [, key, raw] = field as unknown as [string, string, string]
    if (raw === '>' || raw === '|') {
      const block: string[] = []
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1] as string)) block.push((lines[++index] as string).trim())
      meta[key] = raw === '>' ? block.join(' ') : block.join('\n')
    } else meta[key] = raw.replace(/^["']|["']$/g, '')
  }
  return {
    ...(meta.name === undefined ? {} : { name: meta.name }),
    ...(meta.description === undefined ? {} : { description: meta.description }),
    content: text.slice(match[0].length).trim()
  }
}

/**
 * 读取内嵌技能
 * @param {string} [root] - 技能目录（测试时可替换）
 * @returns {SkillRegistrationLike[]} 可注册的技能；读不到的文件跳过
 */
export const getEmbeddedSkills = (root = SKILLS_ROOT): SkillRegistrationLike[] =>
  EMBEDDED_SKILLS.flatMap((name) => {
    const path = join(root, name, 'SKILL.md')
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return []
    }
    const parsed = ParseSkillFile(text)
    if (parsed.description === undefined || parsed.content === '') return []
    return [{ name: parsed.name ?? name, description: parsed.description, content: parsed.content, source: 'bundled', path }]
  })
