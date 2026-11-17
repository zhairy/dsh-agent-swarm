#!/usr/bin/env node
/** 装载实际 client bundle 并渲染 dock；不注入已被 rc.3 删除的 hook，不执行 RPC。 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import vm from 'node:vm'

const root = resolve(process.argv[2] ?? (() => { throw new Error('Usage: node verify-subscriptions-client-rc3.mjs subscription-package') })())
const require = createRequire(join(resolve(process.argv[3] ?? root), 'package.json'))
const React = require('react'), { renderToString } = require('react-dom/server')
let factory, Component
const primitives = { useDismissOnOutsidePointer: () => undefined }
const moduleRequire = id => {
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  if (['react', 'react-dom', 'react/jsx-runtime'].includes(id)) return require(id)
  throw new Error(`Unexpected client dependency: ${id}`)
}
const context = vm.createContext({ window: { __ModuleLoader__: { load: definition => { factory = definition.factory } } }, console, setTimeout, clearTimeout, setInterval, clearInterval, Date })
vm.runInContext(readFileSync(join(root, 'lib/client.js'), 'utf8'), context, { timeout: 5000 })
assert.equal(typeof factory, 'function')
const plugin = factory(moduleRequire)
plugin.apply({
  effect: () => undefined,
  inject: () => undefined,
  get: name => name === 'connection' ? { rpc: async () => { throw new Error('fixture RPC forbidden') } } : undefined,
  locale: { bind: () => key => key },
  slots: { inject: (_name, callback) => callback(), register: (entry, component) => { if (entry.id === 'subscription-usage') Component = component; return () => undefined } }
})
assert.equal(typeof Component, 'function')
renderToString(React.createElement(Component, { rpc: async () => { throw new Error('fixture RPC forbidden') }, currentModel: async () => undefined }))
console.log('PASS: actual subscriptions bundle dock renders without removed rc3 hook; no RPC sent')
