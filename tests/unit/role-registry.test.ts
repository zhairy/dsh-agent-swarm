import { describe, expect, it } from 'vitest'
import {
  FindRoleByPresetId,
  ROLE_IDS,
  ROLE_INFO_LIST,
  ROLE_TAG_PATTERN,
  getChildPersona,
  getDelegableRoleIds,
  getPermissionLabel,
  getPresetPersona,
  getRoleCatalogText,
  getRoleInfo,
  getWantedTools,
  isDelegableRoleId,
  isEditRole,
  isRoleId,
  isWriteAllowed
} from '../../src/role-registry.js'

describe('角色注册表', () => {
  it('恰好 13 个角色，id 与预设 id 唯一且预设 id 合法', () => {
    expect(ROLE_INFO_LIST).toHaveLength(13)
    expect(new Set(ROLE_INFO_LIST.map((r) => r.id)).size).toBe(13)
    expect(new Set(ROLE_INFO_LIST.map((r) => r.presetId)).size).toBe(13)
    for (const role of ROLE_INFO_LIST) {
      expect(role.presetId).toMatch(/^[a-z0-9][a-z0-9-]*$/)
      expect(role.presetId).toBe(role.id.replace(/_/g, '-'))
      expect(role.deliverables.length).toBeGreaterThan(0)
      expect(role.triggers.length).toBeGreaterThan(0)
    }
    expect([...ROLE_IDS]).toEqual(ROLE_INFO_LIST.map((r) => r.id))
  })

  it('中文名与 V2 设计稿一致', () => {
    expect(ROLE_INFO_LIST.map((r) => r.name)).toEqual([
      '天枢', '谋定', '枢机', '算衡', '探微', '博闻', '观象', '铸剑', '行舟', '疾风', '御史', '复核', '妙笔'
    ])
  })

  it('权限：只读角色不含 edit/shell，编辑角色含 edit', () => {
    for (const role of ROLE_INFO_LIST) {
      if (role.permission === 'read') {
        expect(role.capabilities).not.toContain('edit')
        expect(role.capabilities).not.toContain('shell')
      }
      if (role.permission === 'workspace-edit') expect(role.capabilities).toContain('edit')
      if (role.permission === 'limited-exec' || role.permission === 'verify') {
        expect(role.capabilities).toContain('shell')
        expect(role.capabilities).not.toContain('edit')
      }
    }
    expect(isEditRole('zhu_jian')).toBe(true)
    expect(isEditRole('fu_he')).toBe(false)
    expect(isWriteAllowed('tian_shu')).toBe(true)
    expect(isWriteAllowed('yu_shi')).toBe(false)
    expect(getPermissionLabel('fu_he')).toBe('验证')
  })

  it('web 策略：博闻始终开放，枢机按需，御史永不', () => {
    expect(getWantedTools('bo_wen')).toContain('web_search')
    expect(getWantedTools('shu_ji')).not.toContain('web_search')
    expect(getWantedTools('shu_ji', { allowWeb: true })).toContain('web_fetch')
    expect(getWantedTools('yu_shi', { allowWeb: true })).not.toContain('web_search')
    expect(getWantedTools('fu_he')).toEqual(expect.arrayContaining(['read', 'glob', 'grep', 'pwsh', 'bash']))
    expect(getWantedTools('fu_he')).not.toContain('write')
  })

  it('查询函数', () => {
    expect(isRoleId('fu_he')).toBe(true)
    expect(isRoleId('nobody')).toBe(false)
    expect(isDelegableRoleId('tian_shu')).toBe(false)
    expect(isDelegableRoleId('miao_bi')).toBe(true)
    expect(getDelegableRoleIds()).toHaveLength(12)
    expect(FindRoleByPresetId('yu-shi')?.id).toBe('yu_shi')
    expect(FindRoleByPresetId(undefined)).toBeUndefined()
    expect(FindRoleByPresetId('standard')).toBeUndefined()
    expect(() => getRoleInfo('nobody' as never)).toThrow('未知角色')
  })

  it('子智能体 persona 带角色标签与交付要求，算衡区分模式', () => {
    const persona = getChildPersona('fu_he')
    expect(persona).toContain('「复核」')
    expect(persona).toContain('「交付」一节')
    expect(persona).toContain('同一会话')
    expect(ROLE_TAG_PATTERN.exec(persona)?.[1]).toBe('fu_he')
    expect(getChildPersona('suan_heng', 'verify')).toContain('当前模式：验算')
    expect(getChildPersona('suan_heng')).toContain('当前模式：研算')
    expect(persona).not.toMatch(/\{\{/)
  })

  it('预设 persona：天枢含工作协议与角色目录，其余含职责；只允许 {{model}} 变量', () => {
    const tianShu = getPresetPersona('tian_shu')
    expect(tianShu).toContain('swarm_task_card')
    expect(tianShu).toContain('swarm_accept')
    expect(tianShu).toContain('fu_he 复核')
    expect(getPresetPersona('miao_bi')).toContain('「妙笔」')
    for (const role of ROLE_INFO_LIST) {
      const vars = getPresetPersona(role.id).match(/\{\{[^}]*\}\}/g) ?? []
      expect(vars.every((v) => v === '{{model}}')).toBe(true)
    }
    expect(getRoleCatalogText().split('\n')).toHaveLength(12)
  })
})
