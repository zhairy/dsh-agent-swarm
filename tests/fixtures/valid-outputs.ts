import { readFileSync } from 'node:fs'
import type { DelegableRoleId } from '../../src/role-registry.js'

/** 每个可委派角色一份符合契约的结构化结果；JSON 源同时被集成测试的 mock 驱动读取 */
export const VALID_OUTPUTS: Record<DelegableRoleId, unknown> = JSON.parse(
  readFileSync(new URL('./valid-outputs.json', import.meta.url), 'utf8')
)
