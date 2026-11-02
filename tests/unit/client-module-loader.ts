import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 加载真实内部模块；不以空对象跳过Store取消/身份行为。 */
export const loadTaskViewStoreModule = (): any => {
  const module = { exports: {} }
  new Function('module', 'exports', readFileSync(join(__dirname, '../../client/task-view-store.js'), 'utf8'))(module, module.exports)
  return module.exports
}
