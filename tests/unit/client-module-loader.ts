import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 加载真实内部模块；不以空对象跳过Store取消/身份行为。 */
export const loadTaskViewStoreModule = (): any => {
  const module = { exports: {} }
  new Function('module', 'exports', readFileSync(join(__dirname, '../../client/task-view-store.js'), 'utf8'))(module, module.exports)
  return module.exports
}

/** 加载真实路由观测模块及其 React 元素投影。 */
export const loadRouteObservabilityModule = (): any => {
  const module = { exports: {} }
  const React = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({ type, props: props ?? {}, children })
  }
  new Function('require', 'module', 'exports', readFileSync(join(__dirname, '../../client/route-observability.js'), 'utf8'))((id: string) => {
    if (id === 'react') return React
    throw new Error(`unexpected route observability require ${id}`)
  }, module, module.exports)
  return module.exports
}
