import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const bundlePath = join(process.cwd(), 'lib', 'client.js')

describe('built browser bundle', () => {
  it.skipIf(!existsSync(bundlePath))('issue #1: paginated assistant/attempt never returns undefined from start()', () => {
    let definition: any
    const React = {
      Fragment: 'Fragment',
      createElement: () => ({}),
      useState: (value: unknown) => [value, vi.fn()],
      useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot()
    }
    new Function('window', readFileSync(bundlePath, 'utf8'))({
      __ModuleLoader__: { load: (value: unknown) => { definition = value } }
    })
    const exported = definition.factory((id: string) => id === 'react' ? React : {})
    const modelCallDefinition = exported.__display__.modelCallDefinition
    const event = { type: 'assistant/attempt', seq: 42, time: 42, data: { turn: 1, step: 1, stream: [] } }
    const state = modelCallDefinition.start(undefined, { event }, { previous: () => undefined })
    expect(state).toMatchObject({ seq: 42, time: 42, anchorSeq: 42, __hidden: true })
    expect(modelCallDefinition.buildViewNode({
      key: 'k',
      id: '42',
      start: { location: { kind: 'step' } },
      state
    })).toBeNull()
  })
})
