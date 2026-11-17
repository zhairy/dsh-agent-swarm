import assert from 'node:assert/strict'
import test from 'node:test'
import { createExecutionBoundary, EXECUTION_BOUNDARY_CAPS } from '../lib/adapters/dsh-host/execution-boundary.js'

test('execution capability requires all physical hooks from one verified Host generation', () => {
  const previous = globalThis[EXECUTION_BOUNDARY_CAPS]
  const boundary = createExecutionBoundary({ get: () => undefined }, () => {})
  try {
    for (const generation of ['rc1', 'rc3']) {
      globalThis[EXECUTION_BOUNDARY_CAPS] = new Set(['subprocess-local', 'fs-local', 'working-directory'].map(name => `${name}/${generation}`))
      assert.equal(boundary.available(), true, generation)
    }
    globalThis[EXECUTION_BOUNDARY_CAPS] = new Set(['subprocess-local/rc3', 'fs-local/rc3', 'working-directory/rc1'])
    assert.equal(boundary.available(), false, '混装组件不能构成已验证的执行边界')
  } finally { globalThis[EXECUTION_BOUNDARY_CAPS] = previous }
})
