import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { JS_TAG, getJsRevived } from '../../scripts/yaml-js-tag.mjs'
import {
  getBundlePatchList,
  getPresetDeclaration,
  getPresetFileName,
  getPresetPatch,
  getPresetPlugins,
  getStandardPlugins,
  type PluginRow
} from '../../src/preset-builder.js'
import { ROLE_INFO_LIST, getPresetPersona } from '../../src/role-registry.js'

const ROOT = join(import.meta.dirname, '..', '..')
const standard = getJsRevived(JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'standard-plugins.json'), 'utf8'))) as PluginRow[]
const ids = (rows: PluginRow[]) => rows.map((row) => row.id)

describe('预设构建器', () => {
  it('从 standard 补丁中取出 plugins，找不到时报错', () => {
    expect(getStandardPlugins([{ insert: [{ id: 'preset-standard', config: { plugins: standard } }] }])).toBe(standard)
    expect(() => getStandardPlugins([{ insert: [] }])).toThrow('preset-standard')
    expect(() => getStandardPlugins(null)).toThrow('preset-standard')
  })

  it('天枢：替换 persona，去掉通用委派组，追加 swarm 工具行与运行时行', () => {
    const rows = getPresetPlugins('tian_shu', standard)
    const persona = rows.find((row) => row.id === 'persona') as PluginRow
    expect((persona.config as { prefix: string }).prefix).toBe(getPresetPersona('tian_shu'))
    expect((persona.config as { suffix?: string }).suffix).toContain('{{cwd}}')
    expect(ids(rows)).not.toContain('delegation')
    expect(ids(rows)).toEqual(expect.arrayContaining(['tool-pwsh', 'tool-web', 'tool-plugin-manager', 'swarm-tools', 'swarm-runtime']))
    expect(rows.at(-1)).toEqual({ id: 'swarm-runtime', name: 'dsh-agent-swarm/runtime', config: { role: 'tian_shu' } })
  })

  it('御史：无 shell、无 web、无 swarm 工具', () => {
    const rows = ids(getPresetPlugins('yu_shi', standard))
    for (const id of ['tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-web', 'swarm-tools', 'tool-plugin-manager', 'delegation']) expect(rows).not.toContain(id)
    expect(rows).toEqual(expect.arrayContaining(['persona', 'tool-fs', 'tool-fs-search', 'swarm-runtime']))
  })

  it('博闻有 web；复核有 shell 无 web；未知的新行原样保留', () => {
    expect(ids(getPresetPlugins('bo_wen', standard))).toContain('tool-web')
    const fuHe = ids(getPresetPlugins('fu_he', standard))
    expect(fuHe).toContain('tool-pwsh')
    expect(fuHe).not.toContain('tool-web')
    expect(ids(getPresetPlugins('yu_shi', [...standard, { id: 'future-row', name: 'future' }]))).toContain('future-row')
  })

  it('声明与文件名', () => {
    const declaration = getPresetDeclaration('guan_xiang', standard)
    expect(declaration).toMatchObject({ id: 'guan-xiang', name: '观象' })
    expect(declaration.description).toContain('图片')
    expect(getPresetDeclaration('tian_shu', standard).order).toBe(0)
    const patch = getPresetPatch('fu_he', standard) as Array<{ insert: Array<{ id: string; name: string }> }>
    expect(patch[0]?.insert[0]).toMatchObject({ id: 'preset-fu-he', name: '@deepseek-ai/dsh-agent-preset' })
    expect(getPresetFileName('fu_he')).toBe('presets/fu-he.patch.yml')
    expect(getBundlePatchList()).toHaveLength(14)
    expect(getBundlePatchList()[0]).toBe('./cordis.patch.yml')
  })
})

describe('已提交的 bundle 文件与生成器一致', () => {
  for (const role of ROLE_INFO_LIST) {
    it(`presets/${role.presetId}.patch.yml`, () => {
      const committed = YAML.parse(readFileSync(join(ROOT, getPresetFileName(role.id)), 'utf8'), { customTags: [JS_TAG] })
      expect(JSON.parse(JSON.stringify(committed))).toEqual(JSON.parse(JSON.stringify(getPresetPatch(role.id, standard))))
    })
  }

  it('package.json 的 dsh.bundle.patch 列出宿主补丁与 13 个预设', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(pkg.dsh.bundle.patch).toEqual(getBundlePatchList())
  })

  it('宿主补丁插入 swarm-core、4 个可选原生实例，并把默认预设设为天枢', () => {
    const host = YAML.parse(readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8'), { customTags: [JS_TAG] }) as Array<Record<string, unknown>>
    const inserted = (host[0]?.insert ?? []) as Array<{ id: string; name: string; config?: { providerName?: string; permissionMode?: string } }>
    expect(inserted.map((row) => row.id)).toEqual(['swarm-core', 'swarm-codex', 'swarm-codex-edit', 'swarm-claude-plan', 'swarm-claude-edit'])
    expect(inserted.slice(1).map((row) => row.config?.permissionMode)).toEqual(['never', 'approve-for-me', 'plan', 'acceptEdits'])
    expect(host[1]).toEqual({ id: 'agent-preset-registry', config: { default: 'tian-shu' } })
  })
})
